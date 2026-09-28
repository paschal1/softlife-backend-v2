import { Kysely, sql } from 'kysely';
import { APP_ROLE, SYSTEM_ROLE } from '../roles';
import { appendOnly, tenantRls } from './helpers';

/**
 * Customers and prepaid wallets.
 *
 * Same design as stock: wallet_transactions is the append-only ledger, and
 * customer_wallets.balance_kobo is a projection maintained ONLY by a trigger. The balance
 * has CHECK (balance_kobo >= 0), so a payment that would overdraw a wallet fails inside the
 * database, even when two tills charge the same wallet at the same instant (WAL-02).
 * The history always reconciles exactly to the balance (WAL-03) because the balance is
 * literally computed from the history.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    -- Decision Q4: soft warning with manager override by default; owners can switch to hard block.
    ALTER TABLE organizations
      ADD COLUMN credit_limit_mode text NOT NULL DEFAULT 'soft' CHECK (credit_limit_mode IN ('soft','hard')),
      ADD COLUMN default_credit_limit_kobo bigint CHECK (default_credit_limit_kobo >= 0);

    -- ─── Customers ───────────────────────────────────────────────────────────────
    CREATE TABLE customers (
      id                uuid PRIMARY KEY,
      organization_id   uuid NOT NULL REFERENCES organizations(id),
      name              text NOT NULL CHECK (length(trim(name)) > 0),
      phone             text,
      email             text,
      type              text NOT NULL DEFAULT 'retail' CHECK (type IN ('retail','wholesale','vip','staff')),
      address           text,
      credit_limit_kobo bigint CHECK (credit_limit_kobo >= 0), -- null = org default (or unlimited)
      notes             text,
      is_active         boolean NOT NULL DEFAULT true,
      created_by        uuid,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      FOREIGN KEY (organization_id, created_by) REFERENCES users (organization_id, id)
    );
    CREATE UNIQUE INDEX customers_org_phone_uidx ON customers (organization_id, phone) WHERE phone IS NOT NULL;
    CREATE INDEX customers_org_name_idx    ON customers (organization_id, lower(name));
    CREATE INDEX customers_org_created_idx ON customers (organization_id, created_at);
    CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    REVOKE DELETE ON customers FROM ${APP_ROLE}; -- deactivate instead: sales and debts reference customers

    -- ─── Wallet balances (projection, trigger-maintained) ────────────────────────
    CREATE TABLE customer_wallets (
      organization_id uuid NOT NULL REFERENCES organizations(id),
      customer_id     uuid NOT NULL,
      balance_kobo    bigint NOT NULL CHECK (balance_kobo >= 0),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, customer_id),
      FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id)
    );

    -- ─── Wallet ledger ───────────────────────────────────────────────────────────
    CREATE TABLE wallet_transactions (
      id                  uuid PRIMARY KEY,
      organization_id     uuid NOT NULL REFERENCES organizations(id),
      customer_id         uuid NOT NULL,
      type                text NOT NULL CHECK (type IN ('top_up','payment','refund','adjustment')),
      amount_kobo         bigint NOT NULL,
      method              text CHECK (method IN ('cash','transfer')),
      reference           text,
      reason              text,
      reference_type      text,
      reference_id        uuid,
      register_session_id uuid,
      created_by          uuid,
      created_at          timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, customer_id)         REFERENCES customers (organization_id, id),
      FOREIGN KEY (organization_id, register_session_id) REFERENCES register_sessions (organization_id, id),
      FOREIGN KEY (organization_id, created_by)          REFERENCES users (organization_id, id),
      CHECK (CASE type
        WHEN 'top_up'     THEN amount_kobo > 0
        WHEN 'refund'     THEN amount_kobo > 0
        WHEN 'payment'    THEN amount_kobo < 0
        WHEN 'adjustment' THEN amount_kobo <> 0
      END),
      -- WAL-01: a top-up says how the money came in; a transfer carries its bank reference.
      CHECK (type <> 'top_up' OR method IS NOT NULL),
      CHECK (method IS DISTINCT FROM 'transfer' OR length(trim(coalesce(reference, ''))) > 0),
      -- Cash top-ups land in a till, so they belong to a register session.
      CHECK (NOT (type = 'top_up' AND method = 'cash') OR register_session_id IS NOT NULL),
      CHECK (type <> 'adjustment' OR length(trim(coalesce(reason, ''))) > 0)
    );
    CREATE INDEX wallet_transactions_customer_idx
      ON wallet_transactions (organization_id, customer_id, created_at DESC);
    CREATE INDEX wallet_transactions_org_created_idx
      ON wallet_transactions (organization_id, created_at DESC);

    CREATE FUNCTION apply_wallet_transaction() RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $$ BEGIN
        INSERT INTO customer_wallets (organization_id, customer_id, balance_kobo, updated_at)
        VALUES (NEW.organization_id, NEW.customer_id, NEW.amount_kobo, now())
        ON CONFLICT (organization_id, customer_id)
        DO UPDATE SET balance_kobo = customer_wallets.balance_kobo + EXCLUDED.balance_kobo, updated_at = now();
        RETURN NEW;
      END $$;
    CREATE TRIGGER wallet_transactions_apply AFTER INSERT ON wallet_transactions
      FOR EACH ROW EXECUTE FUNCTION apply_wallet_transaction();

    ${tenantRls('customers')}
    ${tenantRls('customer_wallets')}
    ${tenantRls('wallet_transactions')}
    ${appendOnly('wallet_transactions')}
    REVOKE INSERT, UPDATE, DELETE ON customer_wallets FROM ${APP_ROLE}, ${SYSTEM_ROLE};
  `,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    DROP TABLE IF EXISTS wallet_transactions;
    DROP FUNCTION IF EXISTS apply_wallet_transaction();
    DROP TABLE IF EXISTS customer_wallets;
    DROP TABLE IF EXISTS customers;
    ALTER TABLE organizations DROP COLUMN IF EXISTS credit_limit_mode, DROP COLUMN IF EXISTS default_credit_limit_kobo;
  `,
    )
    .execute(db);
}
