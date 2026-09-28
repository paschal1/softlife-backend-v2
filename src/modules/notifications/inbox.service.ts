import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, Transaction } from 'kysely';
import type { AuthContext } from '../../auth/auth.types';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../common/db/pg-errors';
import { uuidv7 } from '../../common/ids/uuidv7';
import { decodeCursor, encodeCursor } from '../../common/pagination';
import type { DB } from '../../database/database.types';
import { TenantDatabase } from '../../database/tenant-database.service';
import { FcmChannel } from './channels/fcm.channel';
import { TermiiChannel } from './channels/termii.channel';
import type {
  ListNotificationsQueryDto,
  NotificationDto,
  NotificationPageDto,
  NotificationSettingsDto,
  RegisterDeviceDto,
  UpdateNotificationSettingsDto,
} from './dto/notifications.dto';
import type { NotificationKind } from './rules';

/** The signed-in user's own notifications, preferences and push devices. */
@Injectable()
export class InboxService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly push: FcmChannel,
    private readonly sms: TermiiChannel,
  ) {}

  async list(auth: AuthContext, query: ListNotificationsQueryDto): Promise<NotificationPageDto> {
    const limit = query.limit ?? 50;
    const cursor = query.cursor ? decodeCursor(query.cursor, 2) : null;

    return this.tenantDb.transaction(async (trx) => {
      const rows = await trx
        .selectFrom('notifications')
        .selectAll()
        .where('user_id', '=', auth.userId)
        .$if(query.unreadOnly === 'true', (qb) => qb.where('read_at', 'is', null))
        .$if(cursor !== null, (qb) => qb.where(sql<boolean>`(created_at, id) < (${new Date(cursor![0]!)}, ${cursor![1]!})`))
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((n) => ({
          id: n.id,
          kind: n.kind as NotificationKind,
          severity: n.severity,
          title: n.title,
          body: n.body,
          data: n.data,
          readAt: n.read_at,
          createdAt: n.created_at,
        })),
        unreadCount: await this.unread(trx, auth.userId),
        nextCursor: rows.length > limit && last ? encodeCursor([last.created_at.toISOString(), last.id]) : null,
      };
    });
  }

  async unreadCount(auth: AuthContext): Promise<{ unreadCount: number }> {
    return this.tenantDb.transaction(async (trx) => ({ unreadCount: await this.unread(trx, auth.userId) }));
  }

  async markRead(auth: AuthContext, id: string): Promise<NotificationDto> {
    return this.tenantDb.transaction(async (trx) => {
      const n = await trx
        .updateTable('notifications')
        .set({ read_at: sql`coalesce(read_at, now())` })
        .where('id', '=', id)
        .where('user_id', '=', auth.userId)
        .returningAll()
        .executeTakeFirst();
      if (!n) throw new NotFoundException('Notification not found');
      return { id: n.id, kind: n.kind as NotificationKind, severity: n.severity, title: n.title, body: n.body, data: n.data, readAt: n.read_at, createdAt: n.created_at };
    });
  }

  async markAllRead(auth: AuthContext): Promise<{ unreadCount: number }> {
    return this.tenantDb.transaction(async (trx) => {
      await trx.updateTable('notifications').set({ read_at: sql`now()` }).where('user_id', '=', auth.userId).where('read_at', 'is', null).execute();
      return { unreadCount: 0 };
    });
  }

  async settings(auth: AuthContext): Promise<NotificationSettingsDto> {
    return this.tenantDb.transaction((trx) => this.loadSettings(trx, auth.userId));
  }

  async updateSettings(auth: AuthContext, dto: UpdateNotificationSettingsDto): Promise<NotificationSettingsDto> {
    return this.tenantDb.transaction(async (trx) => {
      if (dto.smsEnabled) {
        const user = await trx.selectFrom('users').select('phone').where('id', '=', auth.userId).executeTakeFirstOrThrow();
        if (!user.phone) throw new BadRequestException('Add a phone number to your account before turning on SMS');
      }
      const values = {
        ...(dto.pushEnabled !== undefined ? { push_enabled: dto.pushEnabled } : {}),
        ...(dto.smsEnabled !== undefined ? { sms_enabled: dto.smsEnabled } : {}),
        ...(dto.dailyDigest !== undefined ? { daily_digest: dto.dailyDigest } : {}),
        ...(dto.mutedKinds !== undefined ? { muted_kinds: dto.mutedKinds } : {}),
      };
      await trx
        .insertInto('notification_settings')
        .values({ organization_id: auth.organizationId, user_id: auth.userId, ...values })
        .onConflict((oc) => oc.columns(['organization_id', 'user_id']).doUpdateSet(Object.keys(values).length ? values : { push_enabled: sql`notification_settings.push_enabled` }))
        .execute();
      return this.loadSettings(trx, auth.userId);
    });
  }

  /** Called by the app after login and whenever Firebase gives it a new token. */
  async registerDevice(auth: AuthContext, dto: RegisterDeviceDto): Promise<void> {
    try {
      await this.tenantDb.transaction(async (trx) => {
        const existing = await trx.selectFrom('push_devices').select('id').where('token', '=', dto.token).executeTakeFirst();
        if (existing) {
          await trx
            .updateTable('push_devices')
            .set({ user_id: auth.userId, platform: dto.platform, is_active: true, last_seen_at: sql`now()` })
            .where('id', '=', existing.id)
            .execute();
          return;
        }
        await trx
          .insertInto('push_devices')
          .values({ id: uuidv7(), organization_id: auth.organizationId, user_id: auth.userId, token: dto.token, platform: dto.platform })
          .execute();
      });
    } catch (err) {
      // Same phone already registered under another business (tokens are global).
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) throw new ConflictException('This device is registered to another business. Sign out there first.');
      throw err;
    }
  }

  /** Called on sign-out, so a shared till stops receiving the previous user's alerts. */
  async unregisterDevice(auth: AuthContext, token: string): Promise<void> {
    await this.tenantDb.transaction((trx) =>
      trx.updateTable('push_devices').set({ is_active: false }).where('token', '=', token).where('user_id', '=', auth.userId).execute(),
    );
  }

  private async unread(trx: Transaction<DB>, userId: string): Promise<number> {
    const row = await trx
      .selectFrom('notifications')
      .select(sql<number>`count(*)`.as('n'))
      .where('user_id', '=', userId)
      .where('read_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  private async loadSettings(trx: Transaction<DB>, userId: string): Promise<NotificationSettingsDto> {
    const s = await trx.selectFrom('notification_settings').selectAll().where('user_id', '=', userId).executeTakeFirst();
    return {
      pushEnabled: s?.push_enabled ?? true,
      smsEnabled: s?.sms_enabled ?? false,
      dailyDigest: s?.daily_digest ?? true,
      mutedKinds: (s?.muted_kinds ?? []) as NotificationKind[],
      availableChannels: ['in_app', ...(this.push.enabled ? ['push'] : []), ...(this.sms.enabled ? ['sms'] : [])],
    };
  }
}
