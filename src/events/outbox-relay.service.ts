import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Kysely, Selectable, sql } from 'kysely';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Env } from '../config/env';
import { SYSTEM_DB } from '../database/database.tokens';
import type { DB, OutboxEventsTable } from '../database/database.types';
import type { DomainEvent, EventPayload } from './domain-event';
import type { EventType } from './event-types';

type OutboxRow = Selectable<OutboxEventsTable>;

/** How long a claimed batch is reserved before another relay may retry it. */
const CLAIM_LEASE = sql`interval '5 minutes'`;

/**
 * Polls the outbox and dispatches events to in-process subscribers.
 *
 * Delivery is AT-LEAST-ONCE: if the process dies after a handler succeeds but before
 * the row is marked published, that event is delivered again. Every subscriber must
 * therefore be idempotent (the audit log uses event_id UNIQUE + ON CONFLICT DO NOTHING).
 *
 * Run ONE relay instance for now: a single relay preserves event order. When a real
 * broker is introduced (see the Event-Driven Architecture tab), this class is the only
 * thing that changes — it publishes to the broker instead of the in-process emitter.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private running = false;
  private loop?: Promise<void>;

  constructor(
    @Inject(SYSTEM_DB) private readonly db: Kysely<DB>,
    private readonly emitter: EventEmitter2,
    config: ConfigService<Env, true>,
  ) {
    this.pollIntervalMs = config.get('OUTBOX_POLL_INTERVAL_MS', { infer: true });
    this.batchSize = config.get('OUTBOX_BATCH_SIZE', { infer: true });
    this.maxAttempts = config.get('OUTBOX_MAX_ATTEMPTS', { infer: true });
  }

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.run();
    this.logger.log('Outbox relay started');
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop;
    this.logger.log('Outbox relay stopped');
  }

  private async run(): Promise<void> {
    while (this.running) {
      let processed = 0;
      try {
        processed = await this.processBatch();
      } catch (err) {
        this.logger.error('Outbox batch failed', err instanceof Error ? err.stack : String(err));
      }
      // A full batch means there is probably more waiting: go again immediately.
      if (processed < this.batchSize) await sleep(this.pollIntervalMs);
    }
  }

  /** Claims a batch, dispatches each event, and records the outcome. Returns the batch size. */
  async processBatch(): Promise<number> {
    const claimed = await this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('outbox_events')
        .selectAll()
        .where('published_at', 'is', null)
        .where('dead_lettered_at', 'is', null)
        .where('next_attempt_at', '<=', sql<Date>`now()`)
        .orderBy('created_at')
        .orderBy('id')
        .limit(this.batchSize)
        .forUpdate()
        .skipLocked()
        .execute();

      if (rows.length > 0) {
        await trx
          .updateTable('outbox_events')
          .set({ attempts: sql`attempts + 1`, next_attempt_at: sql`now() + ${CLAIM_LEASE}` })
          .where('id', 'in', rows.map((r) => r.id))
          .execute();
      }
      return rows;
    });

    for (const row of claimed) {
      await this.dispatch(row);
    }
    return claimed.length;
  }

  private async dispatch(row: OutboxRow): Promise<void> {
    const event = toDomainEvent(row);
    try {
      await this.emitter.emitAsync(event.type, event);
      await this.db
        .updateTable('outbox_events')
        .set({ published_at: sql`now()`, last_error: null })
        .where('id', '=', row.id)
        .execute();
    } catch (err) {
      const attempts = row.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);

      if (attempts >= this.maxAttempts) {
        await this.db
          .updateTable('outbox_events')
          .set({ dead_lettered_at: sql`now()`, last_error: message })
          .where('id', '=', row.id)
          .execute();
        this.logger.error(`Event ${row.id} (${row.event_type}) dead-lettered after ${attempts} attempts: ${message}`);
        return;
      }

      const backoffSeconds = Math.min(2 ** attempts, 300);
      await this.db
        .updateTable('outbox_events')
        .set({
          next_attempt_at: sql`now() + make_interval(secs => ${backoffSeconds})`,
          last_error: message,
        })
        .where('id', '=', row.id)
        .execute();
      this.logger.warn(`Event ${row.id} (${row.event_type}) failed, retry in ${backoffSeconds}s: ${message}`);
    }
  }
}

function toDomainEvent(row: OutboxRow): DomainEvent {
  return {
    id: row.id,
    type: row.event_type as EventType,
    organizationId: row.organization_id,
    locationId: row.location_id,
    actorId: row.actor_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    occurredAt: row.occurred_at,
    payload: (row.payload ?? {}) as EventPayload,
  };
}
