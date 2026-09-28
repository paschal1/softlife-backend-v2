import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { uuidv7 } from '../../common/ids/uuidv7';
import { TenantDatabase } from '../../database/tenant-database.service';
import type { DomainEvent } from '../../events/domain-event';

/**
 * Subscribes to EVERY domain event and appends it to the audit log.
 *
 * suppressErrors: false is essential — @nestjs/event-emitter swallows handler errors
 * by default, which would mark a failed event as published and lose it.
 */
@Injectable()
export class AuditLogSubscriber {
  constructor(private readonly tenantDb: TenantDatabase) {}

  @OnEvent('**', { suppressErrors: false })
  async handle(event: DomainEvent): Promise<void> {
    // after_state keeps the snapshot AND the event's context (sale number, reason, amounts...),
    // so every entry can be understood on its own.
    const { before, after, ...rest } = event.payload;
    const afterState =
      after !== undefined && after !== null && typeof after === 'object'
        ? { ...rest, ...(after as Record<string, unknown>) }
        : after !== undefined
          ? after
          : Object.keys(rest).length > 0
            ? rest
            : null;

    await this.tenantDb.forOrganization(event.organizationId, (trx) =>
      trx
        .insertInto('audit_log')
        .values({
          id: uuidv7(),
          event_id: event.id,
          organization_id: event.organizationId,
          location_id: event.locationId,
          actor_id: event.actorId,
          action_type: event.type,
          entity_type: event.aggregateType,
          entity_id: event.aggregateId,
          before_state: before !== undefined ? JSON.stringify(before) : null,
          after_state: afterState !== null ? JSON.stringify(afterState) : null,
          occurred_at: event.occurredAt,
        })
        .onConflict((oc) => oc.column('event_id').doNothing())
        .execute(),
    );
  }
}
