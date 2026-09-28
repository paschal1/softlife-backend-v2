import { Kysely, sql } from 'kysely';
import { APP_ROLE, SYSTEM_ROLE } from '../roles';

/**
 * Foundation schema: tenancy, identity, sessions, outbox and audit log.
 *
 * Conventions every later migration must follow:
 *  1. Every tenant-owned table has organization_id NOT NULL, plus UNIQUE (organization_id, id).
 *  2. Child tables reference parents with a COMPOSITE foreign key (organization_id, parent_id),
 *     so a row can never point at another organization's data, even through an app bug.
 *  3. Every tenant table gets tenantRls() in the same migration that creates it.
 *  4. Index (organization_id, created_at) on anything that will be listed by date.
 *  5. Money columns (from the Sales migration onward) are bigint in kobo, never floats.
 */

const TENANT_TABLES = ['locations', 'users', 'auth_sessions', 'audit_log'] as const;

function tenantRls(table: string): string {
  return `
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON ${table} TO ${APP_ROLE}
      USING (organization_id = app_current_org_id())
      WITH CHECK (organization_id = app_current_org_id());
    CREATE POLICY system_access ON ${table} TO ${SYSTEM_ROLE}
      USING (true) WITH CHECK (true);
  `;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    -- Tenant context. Unset or empty => NULL => every RLS comparison is false => zero rows.
    -- Fail closed: a forgotten tenant context returns nothing instead of everything.
    CREATE FUNCTION app_current_org_id() RETURNS uuid
      LANGUAGE sql STABLE
      AS $$ SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid $$;

    CREATE FUNCTION set_updated_at() RETURNS trigger
      LANGUAGE plpgsql
      AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

    -- ─── Organizations ──────────────────────────────────────────────────────────
    CREATE TABLE organizations (
      id              uuid PRIMARY KEY,
      name            text NOT NULL CHECK (length(trim(name)) > 0),
      country_code    char(2) NOT NULL DEFAULT 'NG',
      currency        char(3) NOT NULL DEFAULT 'NGN',
      timezone        text NOT NULL DEFAULT 'Africa/Lagos',
      enabled_modules text[] NOT NULL
                      DEFAULT ARRAY['sales','inventory','customers','debt','delivery','purchasing','audit'],
      status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON organizations TO ${APP_ROLE}
      USING (id = app_current_org_id())
      WITH CHECK (id = app_current_org_id());
    CREATE POLICY system_access ON organizations TO ${SYSTEM_ROLE}
      USING (true) WITH CHECK (true);
    REVOKE DELETE ON organizations FROM ${APP_ROLE};

    -- ─── Locations (branches) ───────────────────────────────────────────────────
    CREATE TABLE locations (
      id              uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      name            text NOT NULL CHECK (length(trim(name)) > 0),
      address         text,
      phone           text,
      is_active       boolean NOT NULL DEFAULT true,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, name)
    );
    CREATE INDEX locations_org_created_idx ON locations (organization_id, created_at);
    CREATE TRIGGER locations_updated_at BEFORE UPDATE ON locations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ─── Users ──────────────────────────────────────────────────────────────────
    -- password_hash: back-office login (email or phone + password). Optional for till-only staff.
    -- pin_hash:      4–6 digit register PIN, tied to the same account (Decision Q1).
    CREATE TABLE users (
      id                  uuid PRIMARY KEY,
      organization_id     uuid NOT NULL REFERENCES organizations(id),
      full_name           text NOT NULL CHECK (length(trim(full_name)) > 0),
      email               text,
      phone               text,
      role                text NOT NULL CHECK (role IN ('owner','manager','cashier','driver')),
      password_hash       text,
      pin_hash            text,
      default_location_id uuid,
      is_active           boolean NOT NULL DEFAULT true,
      pin_failed_attempts integer NOT NULL DEFAULT 0,
      pin_locked_until    timestamptz,
      last_login_at       timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      FOREIGN KEY (organization_id, default_location_id) REFERENCES locations (organization_id, id),
      CHECK (password_hash IS NULL OR email IS NOT NULL OR phone IS NOT NULL)
    );
    -- Login identities are global (login happens before we know the tenant).
    -- Contact details on PIN-only staff are not login identities, so they stay free to repeat.
    CREATE UNIQUE INDEX users_login_email_uidx ON users (lower(email))
      WHERE password_hash IS NOT NULL AND email IS NOT NULL;
    CREATE UNIQUE INDEX users_login_phone_uidx ON users (phone)
      WHERE password_hash IS NOT NULL AND phone IS NOT NULL;
    CREATE INDEX users_org_created_idx ON users (organization_id, created_at);
    CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ─── Auth sessions (rotating refresh tokens) ────────────────────────────────
    -- family_id groups every rotation of one login. If an already-rotated token is
    -- presented again, the whole family is revoked (stolen-token detection).
    CREATE TABLE auth_sessions (
      id              uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      user_id         uuid NOT NULL,
      family_id       uuid NOT NULL,
      kind            text NOT NULL CHECK (kind IN ('password','pin')),
      token_hash      text NOT NULL,
      expires_at      timestamptz NOT NULL,
      revoked_at      timestamptz,
      replaced_by     uuid,
      created_at      timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, user_id) REFERENCES users (organization_id, id)
    );
    CREATE INDEX auth_sessions_family_idx ON auth_sessions (family_id);
    CREATE INDEX auth_sessions_org_user_idx ON auth_sessions (organization_id, user_id);

    -- ─── Transactional outbox ───────────────────────────────────────────────────
    -- Written in the SAME transaction as the state change it describes, so an event
    -- can never be lost to a crash. The relay worker dispatches it afterwards.
    CREATE TABLE outbox_events (
      id               uuid PRIMARY KEY,
      organization_id  uuid NOT NULL REFERENCES organizations(id),
      location_id      uuid,
      actor_id         uuid,
      event_type       text NOT NULL,
      aggregate_type   text NOT NULL,
      aggregate_id     uuid NOT NULL,
      payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at      timestamptz NOT NULL,
      created_at       timestamptz NOT NULL DEFAULT now(),
      published_at     timestamptz,
      attempts         integer NOT NULL DEFAULT 0,
      next_attempt_at  timestamptz NOT NULL DEFAULT now(),
      last_error       text,
      dead_lettered_at timestamptz
    );
    CREATE INDEX outbox_pending_idx ON outbox_events (next_attempt_at, created_at)
      WHERE published_at IS NULL AND dead_lettered_at IS NULL;
    CREATE INDEX outbox_org_created_idx ON outbox_events (organization_id, created_at);

    -- The API may only append to the outbox for its own tenant. Only the relay reads it.
    ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_insert ON outbox_events FOR INSERT TO ${APP_ROLE}
      WITH CHECK (organization_id = app_current_org_id());
    CREATE POLICY system_access ON outbox_events TO ${SYSTEM_ROLE}
      USING (true) WITH CHECK (true);
    REVOKE UPDATE, DELETE ON outbox_events FROM ${APP_ROLE};

    -- ─── Audit log (append-only) ────────────────────────────────────────────────
    -- The durable record of every domain event (BRD 3.5). event_id makes writes
    -- idempotent: the relay delivers at-least-once, the log records exactly once.
    CREATE TABLE audit_log (
      id              uuid PRIMARY KEY,
      event_id        uuid NOT NULL UNIQUE,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      location_id     uuid,
      actor_id        uuid,
      action_type     text NOT NULL,
      entity_type     text NOT NULL,
      entity_id       uuid NOT NULL,
      before_state    jsonb,
      after_state     jsonb,
      occurred_at     timestamptz NOT NULL,
      recorded_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX audit_log_org_occurred_idx ON audit_log (organization_id, occurred_at DESC);
    CREATE INDEX audit_log_org_entity_idx ON audit_log (organization_id, entity_type, entity_id);

    CREATE FUNCTION audit_log_immutable() RETURNS trigger
      LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
    CREATE TRIGGER audit_log_no_update_or_delete BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
    REVOKE UPDATE, DELETE ON audit_log FROM ${APP_ROLE}, ${SYSTEM_ROLE};

    ${TENANT_TABLES.map(tenantRls).join('\n')}

    -- Migration bookkeeping is not application data.
    REVOKE ALL ON kysely_migration, kysely_migration_lock FROM ${APP_ROLE}, ${SYSTEM_ROLE};
  `,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    DROP TABLE IF EXISTS audit_log;
    DROP FUNCTION IF EXISTS audit_log_immutable();
    DROP TABLE IF EXISTS outbox_events;
    DROP TABLE IF EXISTS auth_sessions;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS locations;
    DROP TABLE IF EXISTS organizations;
    DROP FUNCTION IF EXISTS set_updated_at();
    DROP FUNCTION IF EXISTS app_current_org_id();
  `,
    )
    .execute(db);
}
