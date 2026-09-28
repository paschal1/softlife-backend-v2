import { Kysely, sql } from 'kysely';
import { APP_ROLE, SYSTEM_ROLE } from '../roles';
import { appendOnly, tenantRls } from './helpers';

/**
 * Sales, their lines and payments, credit debts, and per-business document numbering.
 *
 * A completed sale is a financial record: its lines and payments are append-only, and the
 * sale row itself can only ever change in one way, completed -> voided (Part 2). Totals are
 * cross-checked by CHECK constraints so a sale whose payments don't add up cannot exist.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    -- POS-02: each business chooses which order types its tills offer.
    ALTER TABLE organizations
      ADD COLUMN enabled_order_types text[] NOT NULL DEFAULT ARRAY['walk_in','credit','wholesale','delivery'];

    -- ─── Human-readable numbers (receipt #1024) ─────────────────────────────────
    CREATE TABLE document_counters (
      organization_id uuid NOT NULL REFERENCES organizations(id),
      name            text NOT NULL,
      last_value      bigint NOT NULL,
      PRIMARY KEY (organization_id, name)
    );

    -- ─── Sales ───────────────────────────────────────────────────────────────────
    CREATE TABLE sales (
      id                     uuid PRIMARY KEY,
      organization_id        uuid NOT NULL REFERENCES organizations(id),
      number                 bigint NOT NULL,
      location_id            uuid NOT NULL,
      register_id            uuid NOT NULL,
      register_session_id    uuid NOT NULL,
      cashier_id             uuid NOT NULL,
      customer_id            uuid,
      order_type             text NOT NULL CHECK (order_type IN ('walk_in','delivery','credit','pre_order','wholesale')),
      status                 text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
      subtotal_kobo          bigint NOT NULL CHECK (subtotal_kobo >= 0),
      discount_kobo          bigint NOT NULL DEFAULT 0 CHECK (discount_kobo >= 0),
      total_kobo             bigint NOT NULL CHECK (total_kobo >= 0),
      paid_kobo              bigint NOT NULL CHECK (paid_kobo >= 0),   -- everything except credit
      credit_kobo            bigint NOT NULL DEFAULT 0 CHECK (credit_kobo >= 0),
      change_kobo            bigint NOT NULL DEFAULT 0 CHECK (change_kobo >= 0),
      delivery_address       text,
      delivery_date          date,
      delivery_driver_id     uuid,
      note                   text,
      approved_by            uuid,
      approval_reasons       text[],
      occurred_at            timestamptz NOT NULL,
      created_at             timestamptz NOT NULL DEFAULT now(),
      voided_at              timestamptz,
      voided_by              uuid,
      void_reason            text,
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, number),
      FOREIGN KEY (organization_id, location_id)         REFERENCES locations (organization_id, id),
      FOREIGN KEY (organization_id, register_id)         REFERENCES registers (organization_id, id),
      FOREIGN KEY (organization_id, register_session_id) REFERENCES register_sessions (organization_id, id),
      FOREIGN KEY (organization_id, cashier_id)          REFERENCES users (organization_id, id),
      FOREIGN KEY (organization_id, customer_id)         REFERENCES customers (organization_id, id),
      FOREIGN KEY (organization_id, delivery_driver_id)  REFERENCES users (organization_id, id),
      FOREIGN KEY (organization_id, approved_by)         REFERENCES users (organization_id, id),
      FOREIGN KEY (organization_id, voided_by)           REFERENCES users (organization_id, id),
      CHECK (total_kobo = subtotal_kobo - discount_kobo),
      CHECK (total_kobo = paid_kobo + credit_kobo),
      CHECK (credit_kobo = 0 OR customer_id IS NOT NULL),                                    -- DEBT-01
      CHECK (order_type <> 'credit' OR customer_id IS NOT NULL),                             -- POS-02
      CHECK (order_type <> 'delivery' OR (delivery_address IS NOT NULL AND delivery_date IS NOT NULL)),
      CHECK ((status = 'voided') = (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL))
    );
    CREATE INDEX sales_org_occurred_idx ON sales (organization_id, occurred_at DESC);
    CREATE INDEX sales_session_idx      ON sales (organization_id, register_session_id);
    CREATE INDEX sales_customer_idx     ON sales (organization_id, customer_id, occurred_at DESC) WHERE customer_id IS NOT NULL;
    CREATE INDEX sales_cashier_idx      ON sales (organization_id, cashier_id, occurred_at DESC);

    -- The only permitted change to a sale: completed -> voided, touching nothing else.
    CREATE FUNCTION sales_guard_update() RETURNS trigger
      LANGUAGE plpgsql
      AS $$ BEGIN
        IF OLD.status <> 'completed' OR NEW.status <> 'voided'
           OR (to_jsonb(NEW) - 'status' - 'voided_at' - 'voided_by' - 'void_reason')
              <> (to_jsonb(OLD) - 'status' - 'voided_at' - 'voided_by' - 'void_reason') THEN
          RAISE EXCEPTION 'a sale can only be voided; nothing else about it can change';
        END IF;
        RETURN NEW;
      END $$;
    CREATE TRIGGER sales_guard_update BEFORE UPDATE ON sales
      FOR EACH ROW EXECUTE FUNCTION sales_guard_update();
    REVOKE DELETE ON sales FROM ${APP_ROLE}, ${SYSTEM_ROLE};

    -- ─── Sale lines ──────────────────────────────────────────────────────────────
    -- Name, unit and price are snapshots: later product edits never rewrite past receipts.
    CREATE TABLE sale_items (
      id               uuid PRIMARY KEY,
      organization_id  uuid NOT NULL REFERENCES organizations(id),
      sale_id          uuid NOT NULL,
      line_no          integer NOT NULL CHECK (line_no > 0),
      product_id       uuid NOT NULL,
      product_name     text NOT NULL,
      unit             text NOT NULL,
      quantity         integer NOT NULL CHECK (quantity > 0),
      unit_price_kobo  bigint NOT NULL CHECK (unit_price_kobo >= 0),
      discount_kobo    bigint NOT NULL DEFAULT 0 CHECK (discount_kobo >= 0),
      line_total_kobo  bigint NOT NULL,
      UNIQUE (organization_id, sale_id, line_no),
      FOREIGN KEY (organization_id, sale_id)    REFERENCES sales (organization_id, id),
      FOREIGN KEY (organization_id, product_id) REFERENCES products (organization_id, id),
      CHECK (discount_kobo <= quantity * unit_price_kobo),
      CHECK (line_total_kobo = quantity * unit_price_kobo - discount_kobo)
    );
    CREATE INDEX sale_items_product_idx ON sale_items (organization_id, product_id);

    -- ─── Credit debts (DEBT-01) ──────────────────────────────────────────────────
    -- paid_kobo is advanced by repayments (Part 2); status follows from it automatically.
    CREATE TABLE debt_records (
      id              uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      customer_id     uuid NOT NULL,
      sale_id         uuid NOT NULL,
      amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),
      paid_kobo       bigint NOT NULL DEFAULT 0 CHECK (paid_kobo >= 0),
      status          text GENERATED ALWAYS AS (CASE WHEN paid_kobo >= amount_kobo THEN 'settled' ELSE 'open' END) STORED,
      created_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, sale_id),
      FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id),
      FOREIGN KEY (organization_id, sale_id)     REFERENCES sales (organization_id, id),
      CHECK (paid_kobo <= amount_kobo)
    );
    CREATE INDEX debt_records_customer_open_idx ON debt_records (organization_id, customer_id) WHERE status = 'open';
    CREATE INDEX debt_records_org_created_idx   ON debt_records (organization_id, created_at);

    CREATE FUNCTION debt_records_guard_update() RETURNS trigger
      LANGUAGE plpgsql
      AS $$ BEGIN
        IF (to_jsonb(NEW) - 'paid_kobo' - 'status') <> (to_jsonb(OLD) - 'paid_kobo' - 'status') THEN
          RAISE EXCEPTION 'only the paid amount of a debt can change';
        END IF;
        RETURN NEW;
      END $$;
    CREATE TRIGGER debt_records_guard_update BEFORE UPDATE ON debt_records
      FOR EACH ROW EXECUTE FUNCTION debt_records_guard_update();
    REVOKE DELETE ON debt_records FROM ${APP_ROLE}, ${SYSTEM_ROLE};

    -- ─── Sale payments (POS-03) ──────────────────────────────────────────────────
    CREATE TABLE sale_payments (
      id                    uuid PRIMARY KEY,
      organization_id       uuid NOT NULL REFERENCES organizations(id),
      sale_id               uuid NOT NULL,
      method                text NOT NULL CHECK (method IN ('cash','transfer','card','wallet','credit')),
      amount_kobo           bigint NOT NULL CHECK (amount_kobo > 0),
      reference             text,
      tendered_kobo         bigint CHECK (tendered_kobo >= amount_kobo),
      wallet_transaction_id uuid REFERENCES wallet_transactions(id),
      debt_record_id        uuid,
      FOREIGN KEY (organization_id, sale_id)        REFERENCES sales (organization_id, id),
      FOREIGN KEY (organization_id, debt_record_id) REFERENCES debt_records (organization_id, id),
      CHECK (method <> 'transfer' OR length(trim(coalesce(reference, ''))) > 0),
      CHECK (tendered_kobo IS NULL OR method = 'cash'),
      CHECK ((method = 'wallet') = (wallet_transaction_id IS NOT NULL)),
      CHECK ((method = 'credit') = (debt_record_id IS NOT NULL))
    );
    CREATE INDEX sale_payments_sale_idx ON sale_payments (organization_id, sale_id);

    ${tenantRls('document_counters')}
    ${tenantRls('sales')}
    ${tenantRls('sale_items')}
    ${tenantRls('sale_payments')}
    ${tenantRls('debt_records')}
    ${appendOnly('sale_items')}
    ${appendOnly('sale_payments')}
    REVOKE DELETE ON document_counters FROM ${APP_ROLE};
  `,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    DROP TABLE IF EXISTS sale_payments;
    DROP TABLE IF EXISTS debt_records;
    DROP FUNCTION IF EXISTS debt_records_guard_update();
    DROP TABLE IF EXISTS sale_items;
    DROP TABLE IF EXISTS sales;
    DROP FUNCTION IF EXISTS sales_guard_update();
    DROP TABLE IF EXISTS document_counters;
    ALTER TABLE organizations DROP COLUMN IF EXISTS enabled_order_types;
  `,
    )
    .execute(db);
}
