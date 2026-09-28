import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TenantDatabase } from '../../database/tenant-database.service';
import type { DomainEvent } from '../../events/domain-event';
import { NotificationService } from './notification.service';
import { draftForEvent, idsToName } from './rules';

/**
 * Turns domain events into alerts for owners and managers (INS-02). Runs in the worker.
 * Idempotent: the event id is the notification's source key.
 */
@Injectable()
export class AlertsSubscriber {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly notifications: NotificationService,
  ) {}

  @OnEvent('**', { suppressErrors: false })
  async handle(event: DomainEvent): Promise<void> {
    // Cheap pre-check with no database access: most events are not alerts.
    if (draftForEvent(event, () => '') === null) return;

    await this.tenantDb.forOrganization(event.organizationId, async (trx) => {
      const name = await this.notifications.names(trx, idsToName(event));
      const draft = draftForEvent(event, name)!;
      // Whoever did it already knows; tell the other supervisors.
      const recipients = (await this.notifications.supervisors(trx)).filter((id) => id !== event.actorId);
      await this.notifications.create(trx, { organizationId: event.organizationId, userIds: recipients, draft, sourceKey: `event:${event.id}` });
    });
  }
}
