import { Kysely, sql } from 'kysely';
import { APP_ROLE, SYSTEM_ROLE } from '../roles';
import { tenantRls } from './helpers';

/**
 * Notifications (in-app inbox + push + SMS), scheduled job bookkeeping, and debt-overdue
 * alert tracking.
 *
 * Every notification has a source_key (the event id, or job + day): delivering the same
 * event twice can never notify anyone twice. Outgoing push/SMS messages are queued in
 * notification_deliveries and retried with backoff, like the outbox.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    ALTER TABLE organizations
      ADD COLUMN daily_digest_hour integer NOT NULL DEFAULT 20 CHECK (daily_digest_hour BETWEEN 0 AND 23);

    -- ─── Inbox ───────────────────────────────────────────────────────────────────
    CREATE TABLE notifications (
      id              uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      user_id         uuid NOT NULL,
      kind            text NOT NULL,
      severity        text NOT NULL CHECK (severity IN ('info','warning','critical')),
      title           text NOT NULL,
      body            text NOT NULL,
      data            jsonb NOT NULL DEFAULT '{}'::jsonb,
      source_key      text NOT NULL,
      read_at         timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, user_id, source_key),
      FOREIGN KEY (organization_id, user_id) REFERENCES users (organization_id, id)
    );
    CREATE INDEX notifications_inbox_idx  ON notifications (organization_id, user_id, created_at DESC);
    CREATE INDEX notifications_unread_idx ON notifications (organization_id, user_id) WHERE read_at IS NULL;

    -- ─── Per-user preferences (no row = defaults) ────────────────────────────────
    CREATE TABLE notification_settings (
      organization_id uuid NOT NULL REFERENCES organizations(id),
      user_id         uuid NOT NULL,
      push_enabled    boolean NOT NULL DEFAULT true,
      sms_enabled     boolean NOT NULL DEFAULT false,
      daily_digest    boolean NOT NULL DEFAULT true,
      muted_kinds     text[] NOT NULL DEFAULT '{}',
      updated_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, user_id),
      FOREIGN KEY (organization_id, user_id) REFERENCES users (organization_id, id)
    );
    CREATE TRIGGER notification_settings_updated_at BEFORE UPDATE ON notification_settings
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ─── Phones and browsers registered for push ─────────────────────────────────
    CREATE TABLE push_devices (
      id              uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      user_id         uuid NOT NULL,
      token           text NOT NULL,
      platform        text NOT NULL CHECK (platform IN ('android','ios','web')),
      is_active       boolean NOT NULL DEFAULT true,
      created_at      timestamptz NOT NULL DEFAULT now(),
      last_seen_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (token),
      FOREIGN KEY (organization_id, user_id) REFERENCES users (organization_id, id)
    );
    CREATE INDEX push_devices_user_idx ON push_devices (organization_id, user_id) WHERE is_active;

    -- ─── Outgoing push/SMS queue ─────────────────────────────────────────────────
    CREATE TABLE notification_deliveries (
      id              uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      notification_id uuid NOT NULL,
      channel         text NOT NULL CHECK (channel IN ('push','sms')),
      target          text NOT NULL,
      status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
      attempts        integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_error      text,
      sent_at         timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, notification_id) REFERENCES notifications (organization_id, id)
    );
    CREATE INDEX notification_deliveries_pending_idx ON notification_deliveries (next_attempt_at) WHERE status = 'pending';

    -- ─── Scheduled jobs: one run per business, job and period ────────────────────
    -- Inserting the row IS the lock: a second worker gets a conflict and skips.
    CREATE TABLE job_runs (
      organization_id uuid NOT NULL REFERENCES organizations(id),
      job             text NOT NULL,
      period_key      text NOT NULL,
      started_at      timestamptz NOT NULL DEFAULT now(),
      finished_at     timestamptz,
      error           text,
      PRIMARY KEY (organization_id, job, period_key)
    );

    -- ─── Which overdue buckets each debt has already been alerted for ────────────
    CREATE TABLE debt_overdue_alerts (
      organization_id uuid NOT NULL REFERENCES organizations(id),
      debt_record_id  uuid NOT NULL,
      bucket          text NOT NULL CHECK (bucket IN ('days31to60','days61to90','days90plus')),
      created_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, debt_record_id, bucket),
      FOREIGN KEY (organization_id, debt_record_id) REFERENCES debt_records (organization_id, id)
    );

    ${tenantRls('notifications')}
    ${tenantRls('notification_settings')}
    ${tenantRls('push_devices')}
    ${tenantRls('notification_deliveries')}
    ${tenantRls('job_runs')}
    ${tenantRls('debt_overdue_alerts')}
    REVOKE DELETE ON notifications, notification_deliveries, job_runs, debt_overdue_alerts FROM ${APP_ROLE}, ${SYSTEM_ROLE};
  `,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    DROP TABLE IF EXISTS debt_overdue_alerts;
    DROP TABLE IF EXISTS job_runs;
    DROP TABLE IF EXISTS notification_deliveries;
    DROP TABLE IF EXISTS push_devices;
    DROP TABLE IF EXISTS notification_settings;
    DROP TABLE IF EXISTS notifications;
    ALTER TABLE organizations DROP COLUMN IF EXISTS daily_digest_hour;
  `,
    )
    .execute(db);
}
