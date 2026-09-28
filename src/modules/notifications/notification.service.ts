import { Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';
import { isUuid, uuidv7 } from '../../common/ids/uuidv7';
import type { DB } from '../../database/database.types';
import { FcmChannel } from './channels/fcm.channel';
import { TermiiChannel } from './channels/termii.channel';
import type { NotificationDraft } from './rules';

/**
 * Creates in-app notifications and queues push/SMS for them, inside the caller's transaction.
 * Idempotent per (recipient, sourceKey): the same event or job day never notifies anyone twice.
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly push: FcmChannel,
    private readonly sms: TermiiChannel,
  ) {}

  /** Owners and managers who should hear about things (INS-02). */
  async supervisors(trx: Transaction<DB>): Promise<string[]> {
    const rows = await trx.selectFrom('users').select('id').where('role', 'in', ['owner', 'manager']).where('is_active', '=', true).execute();
    return rows.map((r) => r.id);
  }

  async create(
    trx: Transaction<DB>,
    input: { organizationId: string; userIds: string[]; draft: NotificationDraft; sourceKey: string },
  ): Promise<number> {
    const { draft } = input;
    if (input.userIds.length === 0) return 0;

    const settings = new Map(
      (await trx.selectFrom('notification_settings').selectAll().where('user_id', 'in', input.userIds).execute()).map((s) => [s.user_id, s]),
    );
    const recipients = input.userIds.filter((id) => {
      const s = settings.get(id);
      if (s?.muted_kinds.includes(draft.kind)) return false;
      if (draft.kind === 'daily_digest' && s && !s.daily_digest) return false;
      return true;
    });
    if (recipients.length === 0) return 0;

    const created = await trx
      .insertInto('notifications')
      .values(
        recipients.map((userId) => ({
          id: uuidv7(),
          organization_id: input.organizationId,
          user_id: userId,
          kind: draft.kind,
          severity: draft.severity,
          title: draft.title,
          body: draft.body,
          data: JSON.stringify(draft.data),
          source_key: input.sourceKey,
        })),
      )
      .onConflict((oc) => oc.columns(['organization_id', 'user_id', 'source_key']).doNothing())
      .returning(['id', 'user_id'])
      .execute();
    if (created.length === 0) return 0;

    const deliveries: { id: string; organization_id: string; notification_id: string; channel: 'push' | 'sms'; target: string }[] = [];
    const userIds = created.map((c) => c.user_id);

    if (this.push.enabled) {
      const devices = await trx.selectFrom('push_devices').select(['user_id', 'token']).where('user_id', 'in', userIds).where('is_active', '=', true).execute();
      for (const n of created) {
        if (settings.get(n.user_id)?.push_enabled === false) continue;
        for (const d of devices.filter((d) => d.user_id === n.user_id)) {
          deliveries.push({ id: uuidv7(), organization_id: input.organizationId, notification_id: n.id, channel: 'push', target: d.token });
        }
      }
    }

    // SMS costs money: only for critical alerts and the digest, and only when the user opted in.
    if (this.sms.enabled && (draft.severity === 'critical' || draft.kind === 'daily_digest')) {
      const phones = new Map(
        (await trx.selectFrom('users').select(['id', 'phone']).where('id', 'in', userIds).where('phone', 'is not', null).execute()).map((u) => [u.id, u.phone!]),
      );
      for (const n of created) {
        const phone = phones.get(n.user_id);
        if (phone && settings.get(n.user_id)?.sms_enabled) {
          deliveries.push({ id: uuidv7(), organization_id: input.organizationId, notification_id: n.id, channel: 'sms', target: phone });
        }
      }
    }

    if (deliveries.length > 0) await trx.insertInto('notification_deliveries').values(deliveries).execute();
    return created.length;
  }

  /** Display names for ids mentioned in a message: staff, tills, customers, branches. */
  async names(trx: Transaction<DB>, candidates: string[]): Promise<(id: unknown) => string> {
    const map = new Map<string, string>();
    const ids = candidates.filter(isUuid);
    if (ids.length > 0) {
      const [users, registers, customers, locations] = await Promise.all([
        trx.selectFrom('users').select(['id', 'full_name as name']).where('id', 'in', ids).execute(),
        trx.selectFrom('registers').select(['id', 'name']).where('id', 'in', ids).execute(),
        trx.selectFrom('customers').select(['id', 'name']).where('id', 'in', ids).execute(),
        trx.selectFrom('locations').select(['id', 'name']).where('id', 'in', ids).execute(),
      ]);
      for (const row of [...users, ...registers, ...customers, ...locations]) map.set(row.id, row.name);
    }
    return (id: unknown) => (typeof id === 'string' && map.get(id)) || 'someone';
  }
}
