import { Kysely, sql } from 'kysely';
import { appendOnly, tenantRls } from './helpers';

/**
 * Sale voids and debt repayments.
 *
 * A debt's paid amount can now change ONLY through repayment allocations: a trigger adds each
 * allocation to debt_records.paid_kobo, and the guard rejects any other attempt to change it
 * (pg_trigger_depth() tells the two apart). So "paid" always equals the sum of recorded
 * repayments. A debt can be voided (with its sale) only while nothing has been paid on it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    -- ─── Voids ──────────────────────────────────────────────────────────────────
    ALTER TABLE sales ADD COLUMN void_approved_by uuid;
    ALTER TABLE sales ADD FOREIGN KEY (organization_id, void_approved_by) REFERENCES users (organization_id, id);

    CREATE OR REPLACE FUNCTION sales_guard_update() RETURNS trigger
      LANGUAGE plpgsql
      AS $$ BEGIN
        IF OLD.status <> 'completed' OR NEW.status <> 'voided'
           OR (to_jsonb(NEW) - 'status' - 'voided_at' - 'voided_by' - 'void_reason' - 'void_approved_by')
              <> (to_jsonb(OLD) - 'status' - 'voided_at' - 'voided_by' - 'void_reason' - 'void_approved_by') THEN
          RAISE EXCEPTION 'a sale can only be voided; nothing else about it can change';
        END IF;
        RETURN NEW;
      END $$;

    -- ─── Debts: voidable, and paid only through repayments ──────────────────────
    ALTER TABLE debt_records ADD COLUMN voided_at timestamptz;
    ALTER TABLE debt_records DROP COLUMN status; -- also drops the partial index that used it
    ALTER TABLE debt_records ADD COLUMN status text GENERATED ALWAYS AS (
      CASE WHEN voided_at IS NOT NULL THEN 'voided'
           WHEN paid_kobo >= amount_kobo THEN 'settled'
           ELSE 'open' END
    ) STORED;
    CREATE INDEX debt_records_customer_open_idx ON debt_records (organization_id, customer_id, created_at) WHERE status = 'open';

    CREATE OR REPLACE FUNCTION debt_records_guard_update() RETURNS trigger
      LANGUAGE plpgsql
      AS $$ BEGIN
        IF (to_jsonb(NEW) - 'paid_kobo' - 'status' - 'voided_at') <> (to_jsonb(OLD) - 'paid_kobo' - 'status' - 'voided_at') THEN
          RAISE EXCEPTION 'only the paid amount or void status of a debt can change';
        END IF;
        IF NEW.paid_kobo <> OLD.paid_kobo AND pg_trigger_depth() < 2 THEN
          RAISE EXCEPTION 'a debt''s paid amount changes only by recording a repayment';
        END IF;
        IF NEW.paid_kobo <> OLD.paid_kobo AND OLD.voided_at IS NOT NULL THEN
          RAISE EXCEPTION 'cannot repay a voided debt';
        END IF;
        IF NEW.voided_at IS DISTINCT FROM OLD.voided_at AND (OLD.voided_at IS NOT NULL OR OLD.paid_kobo > 0) THEN
          RAISE EXCEPTION 'a debt can be voided once, and only before anything is paid on it';
        END IF;
        RETURN NEW;
      END $$;

    -- ─── Repayments (DEBT-04) ────────────────────────────────────────────────────
    CREATE TABLE debt_repayments (
      id                    uuid PRIMARY KEY,
      organization_id       uuid NOT NULL REFERENCES organizations(id),
      customer_id           uuid NOT NULL,
      amount_kobo           bigint NOT NULL CHECK (amount_kobo > 0),
      method                text NOT NULL CHECK (method IN ('cash','transfer','card','wallet')),
      reference             text,
      note                  text,
      wallet_transaction_id uuid REFERENCES wallet_transactions(id),
      register_session_id   uuid,
      created_by            uuid NOT NULL,
      created_at            timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      FOREIGN KEY (organization_id, customer_id)         REFERENCES customers (organization_id, id),
      FOREIGN KEY (organization_id, register_session_id) REFERENCES register_sessions (organization_id, id),
      FOREIGN KEY (organization_id, created_by)          REFERENCES users (organization_id, id),
      CHECK (method <> 'transfer' OR length(trim(coalesce(reference, ''))) > 0),
      CHECK (method <> 'cash' OR register_session_id IS NOT NULL),
      CHECK ((method = 'wallet') = (wallet_transaction_id IS NOT NULL))
    );
    CREATE INDEX debt_repayments_customer_idx ON debt_repayments (organization_id, customer_id, created_at DESC);

    -- Which debts a repayment paid down (oldest first, unless a specific debt was chosen).
    CREATE TABLE debt_repayment_allocations (
      id              uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      repayment_id    uuid NOT NULL,
      debt_record_id  uuid NOT NULL,
      amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),
      UNIQUE (organization_id, repayment_id, debt_record_id),
      FOREIGN KEY (organization_id, repayment_id)   REFERENCES debt_repayments (organization_id, id),
      FOREIGN KEY (organization_id, debt_record_id) REFERENCES debt_records (organization_id, id)
    );
    CREATE INDEX debt_allocations_debt_idx ON debt_repayment_allocations (organization_id, debt_record_id);

    CREATE FUNCTION apply_debt_allocation() RETURNS trigger
      LANGUAGE plpgsql
      AS $$ BEGIN
        UPDATE debt_records SET paid_kobo = paid_kobo + NEW.amount_kobo
         WHERE organization_id = NEW.organization_id AND id = NEW.debt_record_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'debt % not found', NEW.debt_record_id; END IF;
        RETURN NEW;
      END $$;
    CREATE TRIGGER debt_allocations_apply AFTER INSERT ON debt_repayment_allocations
      FOR EACH ROW EXECUTE FUNCTION apply_debt_allocation();

    ${tenantRls('debt_repayments')}
    ${tenantRls('debt_repayment_allocations')}
    ${appendOnly('debt_repayments')}
    ${appendOnly('debt_repayment_allocations')}
  `,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    DROP TABLE IF EXISTS debt_repayment_allocations;
    DROP FUNCTION IF EXISTS apply_debt_allocation();
    DROP TABLE IF EXISTS debt_repayments;
    ALTER TABLE debt_records DROP COLUMN status;
    ALTER TABLE debt_records DROP COLUMN voided_at;
    ALTER TABLE debt_records ADD COLUMN status text GENERATED ALWAYS AS
      (CASE WHEN paid_kobo >= amount_kobo THEN 'settled' ELSE 'open' END) STORED;
    CREATE INDEX debt_records_customer_open_idx ON debt_records (organization_id, customer_id) WHERE status = 'open';
    CREATE OR REPLACE FUNCTION debt_records_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF (to_jsonb(NEW) - 'paid_kobo' - 'status') <> (to_jsonb(OLD) - 'paid_kobo' - 'status') THEN
        RAISE EXCEPTION 'only the paid amount of a debt can change'; END IF; RETURN NEW; END $$;
    ALTER TABLE sales DROP COLUMN void_approved_by;
    CREATE OR REPLACE FUNCTION sales_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.status <> 'completed' OR NEW.status <> 'voided'
         OR (to_jsonb(NEW) - 'status' - 'voided_at' - 'voided_by' - 'void_reason')
            <> (to_jsonb(OLD) - 'status' - 'voided_at' - 'voided_by' - 'void_reason') THEN
        RAISE EXCEPTION 'a sale can only be voided; nothing else about it can change'; END IF; RETURN NEW; END $$;
  `,
    )
    .execute(db);
}
