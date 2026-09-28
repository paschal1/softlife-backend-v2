import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, sql } from 'kysely';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Env } from '../../config/env';
import { SYSTEM_DB } from '../../database/database.tokens';
import type { DB } from '../../database/database.types';
import { NotificationChannel, PermanentDeliveryError } from './channels/channel';
import { FcmChannel } from './channels/fcm.channel';
import { TermiiChannel } from './channels/termii.channel';

const MAX_ATTEMPTS = 5;
const BATCH = 50;

/** Sends queued push and SMS messages, retrying temporary failures with backoff. Runs in the worker. */
@Injectable()
export class NotificationDispatcher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(NotificationDispatcher.name);
  private readonly pollMs: number;
  private readonly channels: Record<'push' | 'sms', NotificationChannel>;
  private running = false;
  private loop?: Promise<void>;

  constructor(
    @Inject(SYSTEM_DB) private readonly db: Kysely<DB>,
    push: FcmChannel,
    sms: TermiiChannel,
    config: ConfigService<Env, true>,
  ) {
    this.pollMs = config.get('NOTIFICATION_POLL_INTERVAL_MS', { infer: true });
    this.channels = { push, sms };
  }

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.run();
    const enabled = Object.values(this.channels).filter((c) => c.enabled).map((c) => c.name);
    this.logger.log(`Notification dispatcher started (channels: in-app${enabled.length ? `, ${enabled.join(', ')}` : ''})`);
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let sent = 0;
      try {
        sent = await this.processBatch();
      } catch (err) {
        this.logger.error('Notification batch failed', err instanceof Error ? err.stack : String(err));
      }
      if (sent < BATCH) await sleep(this.pollMs);
    }
  }

  async processBatch(): Promise<number> {
    const claimed = await this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('notification_deliveries as d')
        .innerJoin('notifications as n', 'n.id', 'd.notification_id')
        .select(['d.id', 'd.channel', 'd.target', 'd.attempts', 'n.title', 'n.body', 'n.kind', 'n.data', 'n.id as notification_id'])
        .where('d.status', '=', 'pending')
        .where('d.next_attempt_at', '<=', sql<Date>`now()`)
        .orderBy('d.next_attempt_at')
        .limit(BATCH)
        .forUpdate()
        .skipLocked()
        .execute();
      if (rows.length > 0) {
        await trx
          .updateTable('notification_deliveries')
          .set({ attempts: sql`attempts + 1`, next_attempt_at: sql`now() + interval '5 minutes'` })
          .where('id', 'in', rows.map((r) => r.id))
          .execute();
      }
      return rows;
    });

    for (const d of claimed) {
      const channel = this.channels[d.channel];
      try {
        await channel.send(d.target, { title: d.title, body: d.body, data: { ...(d.data as Record<string, unknown>), kind: d.kind, notificationId: d.notification_id } });
        await this.db.updateTable('notification_deliveries').set({ status: 'sent', sent_at: sql`now()`, last_error: null }).where('id', '=', d.id).execute();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const permanent = err instanceof PermanentDeliveryError || d.attempts + 1 >= MAX_ATTEMPTS;
        if (err instanceof PermanentDeliveryError && err.invalidTarget && d.channel === 'push') {
          await this.db.updateTable('push_devices').set({ is_active: false }).where('token', '=', d.target).execute();
        }
        await this.db
          .updateTable('notification_deliveries')
          .set(
            permanent
              ? { status: 'failed', last_error: message }
              : { last_error: message, next_attempt_at: sql`now() + make_interval(secs => ${Math.min(30 * 2 ** d.attempts, 1800)})` },
          )
          .where('id', '=', d.id)
          .execute();
        if (permanent) this.logger.warn(`${d.channel} delivery ${d.id} failed: ${message}`);
      }
    }
    return claimed.length;
  }
}
