import { Kysely, sql } from 'kysely';
import { APP_ROLE } from '../roles';
import { appendOnly, tenantRls } from './helpers';

/**
 * Registers, register sessions (clock-in → EOD) and the register cash ledger.
 *
 * The cash ledger is how "expected cash in till" is computed: every movement of physical
 * cash through a session is one append-only row (opening float, pay-ins, pay-outs, and —
 * as later modules land — cash sales, cash refunds, cash wallet top-ups, cash debt
 * repayments). Expected cash is simply their sum. Nothing is ever edited; corrections are
 * new rows. That is what makes an EOD variance defensible in a dispute.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    -- Generic guard for append-only tables (the audit log keeps its own, older trigger).
    CREATE FUNCTION forbid_update_delete() RETURNS trigger
      LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;

    -- Variance above this (either direction) raises an alert at EOD. Default ₦1,000.
    ALTER TABLE organizations
      ADD COLUMN eod_variance_alert_kobo bigint NOT NULL DEFAULT 100000
      CHECK (eod_variance_alert_kobo >= 0);

    -- ─── Registers (tills) ───────────────────────────────────────────────────────
    CREATE TABLE registers (
      id              uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      location_id     uuid NOT NULL,
      name            text NOT NULL CHECK (length(trim(name)) > 0),
      is_active       boolean NOT NULL DEFAULT true,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, location_id, name),
      FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id)
    );
    CREATE INDEX registers_org_created_idx ON registers (organization_id, created_at);
    CREATE TRIGGER registers_updated_at BEFORE UPDATE ON registers
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ─── Register sessions (one clock-in to one EOD) ─────────────────────────────
    CREATE TABLE register_sessions (
      id                 uuid PRIMARY KEY,
      organization_id    uuid NOT NULL REFERENCES organizations(id),
      register_id        uuid NOT NULL,
      location_id        uuid NOT NULL,
      user_id            uuid NOT NULL,
      status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      opening_float_kobo bigint NOT NULL CHECK (opening_float_kobo >= 0),
      opened_at          timestamptz NOT NULL DEFAULT now(),
      closed_at          timestamptz,
      closed_by          uuid,
      expected_cash_kobo bigint,
      counted_cash_kobo  bigint CHECK (counted_cash_kobo >= 0),
      variance_kobo      bigint,
      variance_flagged   boolean NOT NULL DEFAULT false,
      closing_note       text,
      UNIQUE (organization_id, id),
      FOREIGN KEY (organization_id, register_id) REFERENCES registers (organization_id, id),
      FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id),
      FOREIGN KEY (organization_id, user_id)     REFERENCES users (organization_id, id),
      FOREIGN KEY (organization_id, closed_by)   REFERENCES users (organization_id, id),
      -- An open session has no EOD figures; a closed one has all of them, and the
      -- variance is always exactly counted minus expected.
      CHECK (
        (status = 'open' AND closed_at IS NULL AND closed_by IS NULL
          AND expected_cash_kobo IS NULL AND counted_cash_kobo IS NULL AND variance_kobo IS NULL)
        OR
        (status = 'closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL
          AND expected_cash_kobo IS NOT NULL AND counted_cash_kobo IS NOT NULL
          AND variance_kobo = counted_cash_kobo - expected_cash_kobo)
      )
    );
    -- REG-02: no shared sessions. One open session per till, one open till per person.
    CREATE UNIQUE INDEX register_sessions_one_open_per_register
      ON register_sessions (register_id) WHERE status = 'open';
    CREATE UNIQUE INDEX register_sessions_one_open_per_user
      ON register_sessions (organization_id, user_id) WHERE status = 'open';
    CREATE INDEX register_sessions_org_opened_idx   ON register_sessions (organization_id, opened_at DESC);
    CREATE INDEX register_sessions_org_register_idx ON register_sessions (organization_id, register_id, opened_at DESC);
    CREATE INDEX register_sessions_org_user_idx     ON register_sessions (organization_id, user_id, opened_at DESC);

    -- EOD-02: once closed, the session and its variance are permanent.
    CREATE FUNCTION register_sessions_closed_immutable() RETURNS trigger
      LANGUAGE plpgsql
      AS $$ BEGIN
        IF OLD.status = 'closed' THEN
          RAISE EXCEPTION 'closed register sessions cannot be modified';
        END IF;
        RETURN NEW;
      END $$;
    CREATE TRIGGER register_sessions_closed_immutable BEFORE UPDATE ON register_sessions
      FOR EACH ROW EXECUTE FUNCTION register_sessions_closed_immutable();
    REVOKE DELETE ON register_sessions FROM ${APP_ROLE};

    -- ─── Register cash ledger ────────────────────────────────────────────────────
    CREATE TABLE register_cash_movements (
      id                  uuid PRIMARY KEY,
      organization_id     uuid NOT NULL REFERENCES organizations(id),
      register_session_id uuid NOT NULL,
      kind                text NOT NULL CHECK (kind IN (
                            'opening_float','pay_in','pay_out',
                            'cash_sale','cash_refund','wallet_top_up','debt_repayment')),
      amount_kobo         bigint NOT NULL,
      reason              text,
      reference_type      text,
      reference_id        uuid,
      created_by          uuid NOT NULL,
      created_at          timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, register_session_id) REFERENCES register_sessions (organization_id, id),
      FOREIGN KEY (organization_id, created_by)          REFERENCES users (organization_id, id),
      -- Signed amounts: money out of the till is negative, money in is positive.
      CHECK (CASE
        WHEN kind IN ('pay_out','cash_refund') THEN amount_kobo < 0
        WHEN kind = 'opening_float'            THEN amount_kobo >= 0
        ELSE amount_kobo > 0
      END),
      -- A pay-in or pay-out without a reason is exactly what an owner can't audit later.
      CHECK (kind NOT IN ('pay_in','pay_out') OR length(trim(coalesce(reason, ''))) > 0)
    );
    CREATE INDEX register_cash_movements_session_idx
      ON register_cash_movements (organization_id, register_session_id, created_at);

    ${tenantRls('registers')}
    ${tenantRls('register_sessions')}
    ${tenantRls('register_cash_movements')}
    ${appendOnly('register_cash_movements')}
  `,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    DROP TABLE IF EXISTS register_cash_movements;
    DROP TABLE IF EXISTS register_sessions;
    DROP FUNCTION IF EXISTS register_sessions_closed_immutable();
    DROP TABLE IF EXISTS registers;
    ALTER TABLE organizations DROP COLUMN IF EXISTS eod_variance_alert_kobo;
    DROP FUNCTION IF EXISTS forbid_update_delete();
  `,
    )
    .execute(db);
}
