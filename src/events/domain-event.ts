import type { EventType } from './event-types';

/**
 * Payload convention: include `before` and/or `after` snapshots for anything that
 * changes an entity's state. The audit subscriber stores them as before_state /
 * after_state. Never put secrets (password or PIN hashes, tokens) in a payload.
 *
 * Values must be JSON-serializable (strings, numbers, booleans, null, arrays, plain
 * objects). The type is kept loose on purpose: a strict recursive JSON type makes
 * TypeScript reject valid payloads such as arrays of mapped objects.
 */
export type EventPayload = Record<string, unknown>;

export interface DomainEvent<TPayload extends EventPayload = EventPayload> {
  id: string;
  type: EventType;
  organizationId: string;
  locationId: string | null;
  actorId: string | null;
  aggregateType: string;
  aggregateId: string;
  occurredAt: Date;
  payload: TPayload;
}
