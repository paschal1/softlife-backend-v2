import { Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';
import { RequestContext } from '../common/context/request-context';
import { uuidv7 } from '../common/ids/uuidv7';
import type { DB } from '../database/database.types';
import type { EventPayload } from './domain-event';
import type { EventType } from './event-types';

export interface RecordEventInput {
  type: EventType;
  aggregateType: string;
  aggregateId: string;
  payload: EventPayload;
  /** Defaults to the current request's values. Pass explicitly outside a request (e.g. signup). */
  organizationId?: string;
  actorId?: string | null;
  locationId?: string | null;
  /** For events synced from an offline till: when it actually happened, not when it arrived. */
  occurredAt?: Date;
}

/**
 * Records a domain event into the outbox, inside the caller's transaction.
 *
 * It does NOT dispatch anything. If the transaction commits, the event exists and
 * the relay will deliver it; if it rolls back, the event never existed. That is the
 * whole guarantee: state and event are atomic.
 */
@Injectable()
export class EventPublisher {
  async record(trx: Transaction<DB>, input: RecordEventInput): Promise<string> {
    const ctx = RequestContext.get();
    const organizationId = input.organizationId ?? ctx?.organizationId;
    if (!organizationId) throw new Error(`Cannot record ${input.type}: no organization`);

    const id = uuidv7();
    await trx
      .insertInto('outbox_events')
      .values({
        id,
        organization_id: organizationId,
        location_id: input.locationId !== undefined ? input.locationId : (ctx?.locationId ?? null),
        actor_id: input.actorId !== undefined ? input.actorId : (ctx?.userId ?? null),
        event_type: input.type,
        aggregate_type: input.aggregateType,
        aggregate_id: input.aggregateId,
        payload: JSON.stringify(input.payload),
        occurred_at: input.occurredAt ?? new Date(),
      })
      .execute();
    return id;
  }
}
