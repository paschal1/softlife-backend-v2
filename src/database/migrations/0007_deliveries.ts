import { Kysely, sql } from 'kysely';
import { APP_ROLE, SYSTEM_ROLE } from '../roles';
import { appendOnly, tenantRls } from './helpers';

/**
 * Deliveries (and pre-order pickups), pay-on-delivery, delivery returns, and driver cash.
 *
 * Money collected at the door is tracked from the moment the driver takes it
 * (delivery_collections) until it is handed in at a till (delivery_remittances), so cash
 * "with the driver" is always visible and a short hand-in is flagged like an EOD variance.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    -- ─── Sales: pay on delivery, pre-orders ──────────────────────────────────────
    ALTER TABLE sales ADD COLUMN cod_kobo bigint NOT NULL DEFAULT 0 CHECK (cod_kobo >= 0);
    ALTER TABLE sales ADD COLUMN fulfilment text CHECK (fulfilment IN ('delivery','pickup'));

    -- Replace "total = paid + credit" with "total = paid + credit + pay-on-delivery".
    DO $$
    DECLARE c record;
    BEGIN
      FOR c IN
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'sales'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%total_kobo = (paid_kobo + credit_kobo)%'
      LOOP
        EXECUTE format('ALTER TABLE sales DROP CONSTRAINT %I', c.conname);
      END LOOP;
    END $$;
    -- Backfill delivery sales recorded before this migration (sales are otherwise immutable).
    ALTER TABLE sales DISABLE TRIGGER sales_guard_update;
    UPDATE sales SET fulfilment = 'delivery' WHERE order_type = 'delivery';
    ALTER TABLE sales ENABLE TRIGGER sales_guard_update;

    ALTER TABLE sales ADD CONSTRAINT sales_total_matches_payments CHECK (total_kobo = paid_kobo + credit_kobo + cod_kobo);
    ALTER TABLE sales ADD CONSTRAINT sales_cod_needs_fulfilment CHECK (cod_kobo = 0 OR order_type IN ('delivery','pre_order'));
    ALTER TABLE sales ADD CONSTRAINT sales_pre_order_scheduled CHECK (order_type <> 'pre_order' OR delivery_date IS NOT NULL);
    ALTER TABLE sales ADD CONSTRAINT sales_fulfilment_set CHECK ((order_type IN ('delivery','pre_order')) = (fulfilment IS NOT NULL));
    ALTER TABLE sales ADD CONSTRAINT sales_delivery_has_address CHECK (fulfilment IS DISTINCT FROM 'delivery' OR delivery_address IS NOT NULL);

    ALTER TABLE sale_payments DROP CONSTRAINT sale_payments_method_check;
    ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_method_check
      CHECK (method IN ('cash','transfer','card','wallet','credit','pay_on_delivery'));

    -- ─── Tills: cash handed in by drivers ────────────────────────────────────────
    ALTER TABLE register_cash_movements DROP CONSTRAINT register_cash_movements_kind_check;
    ALTER TABLE register_cash_movements ADD CONSTRAINT register_cash_movements_kind_check CHECK (kind IN (
      'opening_float','pay_in','pay_out','cash_sale','cash_refund','wallet_top_up','debt_repayment','delivery_cash'));

    -- ─── Deliveries (DEL-01..03) ─────────────────────────────────────────────────
    CREATE TABLE deliveries (
      id                uuid PRIMARY KEY,
      organization_id   uuid NOT NULL REFERENCES organizations(id),
      sale_id           uuid NOT NULL,
      location_id       uuid NOT NULL,
      customer_id       uuid,
      fulfilment        text NOT NULL CHECK (fulfilment IN ('delivery','pickup')),
      address           text,
      scheduled_date    date NOT NULL,
      driver_id         uuid,
      expected_at       timestamptz,
      status            text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','assigned','out_for_delivery','delivered','failed','cancelled')),
      confirmation_code text NOT NULL CHECK (confirmation_code ~ '^[0-9]{4}$'),
      code_attempts     integer NOT NULL DEFAULT 0,
      cod_kobo          bigint NOT NULL DEFAULT 0 CHECK (cod_kobo >= 0),
      collected_kobo    bigint NOT NULL DEFAULT 0 CHECK (collected_kobo >= 0),
      attempts          integer NOT NULL DEFAULT 0,
      proof_method      text CHECK (proof_method IN ('code','recipient_name')),
      received_by_name  text,
      delivered_at      timestamptz,
      delivered_by      uuid,
      failure_reason    text,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, sale_id),
      FOREIGN KEY (organization_id, sale_id)      REFERENCES sales (organization_id, id),
      FOREIGN KEY (organization_id, location_id)  REFERENCES locations (organization_id, id),
      FOREIGN KEY (organization_id, customer_id)  REFERENCES customers (organization_id, id),
      FOREIGN KEY (organization_id, driver_id)    REFERENCES users (organization_id, id),
      FOREIGN KEY (organization_id, delivered_by) REFERENCES users (organization_id, id),
      CHECK (fulfilment = 'pickup' OR address IS NOT NULL),
      CHECK (fulfilment = 'delivery' OR driver_id IS NULL),
      CHECK (status NOT IN ('assigned','out_for_delivery') OR driver_id IS NOT NULL),
      CHECK ((status = 'delivered') = (delivered_at IS NOT NULL AND delivered_by IS NOT NULL AND proof_method IS NOT NULL)),
      CHECK (status <> 'delivered' OR collected_kobo = cod_kobo),
      CHECK (collected_kobo <= cod_kobo)
    );
    CREATE INDEX deliveries_queue_idx  ON deliveries (organization_id, status, scheduled_date, created_at);
    CREATE INDEX deliveries_driver_idx ON deliveries (organization_id, driver_id, status) WHERE driver_id IS NOT NULL;
    CREATE TRIGGER deliveries_updated_at BEFORE UPDATE ON deliveries
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Delivered and cancelled are final.
    CREATE FUNCTION deliveries_guard_update() RETURNS trigger
      LANGUAGE plpgsql
      AS $$ BEGIN
        IF OLD.status IN ('delivered','cancelled') THEN
          RAISE EXCEPTION 'a % delivery cannot be changed', OLD.status;
        END IF;
        IF NEW.confirmation_code <> OLD.confirmation_code OR NEW.sale_id <> OLD.sale_id OR NEW.cod_kobo <> OLD.cod_kobo THEN
          RAISE EXCEPTION 'delivery code, sale and amount to collect are fixed';
        END IF;
        RETURN NEW;
      END $$;
    CREATE TRIGGER deliveries_guard_update BEFORE UPDATE ON deliveries
      FOR EACH ROW EXECUTE FUNCTION deliveries_guard_update();
    REVOKE DELETE ON deliveries FROM ${APP_ROLE}, ${SYSTEM_ROLE};

    -- ─── Money collected at the door ─────────────────────────────────────────────
    CREATE TABLE delivery_remittances (
      id                  uuid PRIMARY KEY,
      organization_id     uuid NOT NULL REFERENCES organizations(id),
      driver_id           uuid NOT NULL,
      expected_kobo       bigint NOT NULL CHECK (expected_kobo > 0),
      counted_kobo        bigint NOT NULL CHECK (counted_kobo >= 0),
      variance_kobo       bigint NOT NULL,
      register_session_id uuid NOT NULL,
      received_by         uuid NOT NULL,
      note                text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      FOREIGN KEY (organization_id, driver_id)           REFERENCES users (organization_id, id),
      FOREIGN KEY (organization_id, received_by)         REFERENCES users (organization_id, id),
      FOREIGN KEY (organization_id, register_session_id) REFERENCES register_sessions (organization_id, id),
      CHECK (variance_kobo = counted_kobo - expected_kobo)
    );
    CREATE INDEX delivery_remittances_driver_idx ON delivery_remittances (organization_id, driver_id, created_at DESC);

    CREATE TABLE delivery_collections (
      id              uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      delivery_id     uuid NOT NULL,
      method          text NOT NULL CHECK (method IN ('cash','transfer','card')),
      amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),
      reference       text,
      collected_by    uuid NOT NULL,
      collected_at    timestamptz NOT NULL DEFAULT now(),
      remittance_id   uuid,
      FOREIGN KEY (organization_id, delivery_id)   REFERENCES deliveries (organization_id, id),
      FOREIGN KEY (organization_id, collected_by)  REFERENCES users (organization_id, id),
      FOREIGN KEY (organization_id, remittance_id) REFERENCES delivery_remittances (organization_id, id),
      CHECK (method <> 'transfer' OR length(trim(coalesce(reference, ''))) > 0),
      CHECK (method = 'cash' OR remittance_id IS NULL) -- only cash is handed in
    );
    CREATE INDEX delivery_collections_unremitted_idx
      ON delivery_collections (organization_id, collected_by) WHERE method = 'cash' AND remittance_id IS NULL;

    -- A collection is permanent; the only change allowed is being marked as handed in, once.
    CREATE FUNCTION delivery_collections_guard_update() RETURNS trigger
      LANGUAGE plpgsql
      AS $$ BEGIN
        IF OLD.remittance_id IS NOT NULL OR NEW.remittance_id IS NULL
           OR (to_jsonb(NEW) - 'remittance_id') <> (to_jsonb(OLD) - 'remittance_id') THEN
          RAISE EXCEPTION 'a collection can only be marked as remitted, once';
        END IF;
        RETURN NEW;
      END $$;
    CREATE TRIGGER delivery_collections_guard_update BEFORE UPDATE ON delivery_collections
      FOR EACH ROW EXECUTE FUNCTION delivery_collections_guard_update();
    REVOKE DELETE ON delivery_collections FROM ${APP_ROLE}, ${SYSTEM_ROLE};

    -- ─── Returns at the door: empties, rejected goods (DEL-03) ───────────────────
    CREATE TABLE delivery_returns (
      id              uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      delivery_id     uuid NOT NULL,
      product_id      uuid NOT NULL,
      quantity        integer NOT NULL CHECK (quantity > 0),
      note            text,
      created_at      timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, delivery_id) REFERENCES deliveries (organization_id, id),
      FOREIGN KEY (organization_id, product_id)  REFERENCES products (organization_id, id)
    );
    CREATE INDEX delivery_returns_delivery_idx ON delivery_returns (organization_id, delivery_id);

    -- Earlier delivery sales join the queue (cancelled if the sale was voided).
    INSERT INTO deliveries (id, organization_id, sale_id, location_id, customer_id, fulfilment, address,
                            scheduled_date, driver_id, status, confirmation_code)
    SELECT gen_random_uuid(), s.organization_id, s.id, s.location_id, s.customer_id, 'delivery', s.delivery_address,
           s.delivery_date, s.delivery_driver_id,
           CASE WHEN s.status = 'voided' THEN 'cancelled' WHEN s.delivery_driver_id IS NOT NULL THEN 'assigned' ELSE 'queued' END,
           lpad(floor(random() * 10000)::int::text, 4, '0')
      FROM sales s
     WHERE s.order_type = 'delivery';

    ${tenantRls('deliveries')}
    ${tenantRls('delivery_collections')}
    ${tenantRls('delivery_remittances')}
    ${tenantRls('delivery_returns')}
    ${appendOnly('delivery_remittances')}
    ${appendOnly('delivery_returns')}
  `,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    DROP TABLE IF EXISTS delivery_returns;
    DROP TABLE IF EXISTS delivery_collections;
    DROP FUNCTION IF EXISTS delivery_collections_guard_update();
    DROP TABLE IF EXISTS delivery_remittances;
    DROP TABLE IF EXISTS deliveries;
    DROP FUNCTION IF EXISTS deliveries_guard_update();
    ALTER TABLE register_cash_movements DROP CONSTRAINT register_cash_movements_kind_check;
    ALTER TABLE register_cash_movements ADD CONSTRAINT register_cash_movements_kind_check CHECK (kind IN (
      'opening_float','pay_in','pay_out','cash_sale','cash_refund','wallet_top_up','debt_repayment'));
    ALTER TABLE sale_payments DROP CONSTRAINT sale_payments_method_check;
    ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_method_check CHECK (method IN ('cash','transfer','card','wallet','credit'));
    ALTER TABLE sales DROP CONSTRAINT sales_delivery_has_address;
    ALTER TABLE sales DROP CONSTRAINT sales_fulfilment_set;
    ALTER TABLE sales DROP CONSTRAINT sales_pre_order_scheduled;
    ALTER TABLE sales DROP CONSTRAINT sales_cod_needs_fulfilment;
    ALTER TABLE sales DROP CONSTRAINT sales_total_matches_payments;
    ALTER TABLE sales ADD CHECK (total_kobo = paid_kobo + credit_kobo);
    ALTER TABLE sales DROP COLUMN fulfilment;
    ALTER TABLE sales DROP COLUMN cod_kobo;
  `,
    )
    .execute(db);
}
