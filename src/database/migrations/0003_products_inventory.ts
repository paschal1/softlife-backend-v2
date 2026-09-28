import { Kysely, sql } from 'kysely';
import { APP_ROLE, SYSTEM_ROLE } from '../roles';
import { appendOnly, tenantRls } from './helpers';

/**
 * Products, the stock ledger, and per-branch stock levels.
 *
 * stock_movements is the source of truth: every change to stock is one append-only row.
 * stock_levels is a projection of it, maintained ONLY by a database trigger on insert into
 * stock_movements. The API cannot write stock_levels at all, so the displayed quantity can
 * never drift from the ledger, whatever bug or crash happens in application code.
 *
 * Quantities are whole units of the product's `unit` (bag, pack, bottle, piece...).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    -- ─── Products ────────────────────────────────────────────────────────────────
    CREATE TABLE products (
      id                   uuid PRIMARY KEY,
      organization_id      uuid NOT NULL REFERENCES organizations(id),
      name                 text NOT NULL CHECK (length(trim(name)) > 0),
      sku                  text,
      barcode              text,
      category             text,
      unit                 text NOT NULL DEFAULT 'piece' CHECK (length(trim(unit)) > 0),
      selling_price_kobo   bigint NOT NULL CHECK (selling_price_kobo >= 0),
      wholesale_price_kobo bigint CHECK (wholesale_price_kobo >= 0),
      cost_price_kobo      bigint NOT NULL DEFAULT 0 CHECK (cost_price_kobo >= 0),
      tracks_stock         boolean NOT NULL DEFAULT true,
      reorder_level        integer CHECK (reorder_level >= 0),
      is_active            boolean NOT NULL DEFAULT true,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id)
    );
    CREATE UNIQUE INDEX products_org_name_uidx    ON products (organization_id, lower(name));
    CREATE UNIQUE INDEX products_org_sku_uidx     ON products (organization_id, lower(sku)) WHERE sku IS NOT NULL;
    CREATE UNIQUE INDEX products_org_barcode_uidx ON products (organization_id, barcode) WHERE barcode IS NOT NULL;
    CREATE INDEX products_org_category_idx        ON products (organization_id, category);
    CREATE TRIGGER products_updated_at BEFORE UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    REVOKE DELETE ON products FROM ${APP_ROLE}; -- deactivate instead: sales history references products

    -- ─── Stock levels (projection, trigger-maintained) ───────────────────────────
    CREATE TABLE stock_levels (
      organization_id uuid NOT NULL REFERENCES organizations(id),
      location_id     uuid NOT NULL,
      product_id      uuid NOT NULL,
      quantity        integer NOT NULL,
      updated_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, location_id, product_id),
      FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id),
      FOREIGN KEY (organization_id, product_id)  REFERENCES products (organization_id, id)
    );
    CREATE INDEX stock_levels_org_product_idx ON stock_levels (organization_id, product_id);

    -- ─── Stock ledger ────────────────────────────────────────────────────────────
    -- batch_id groups the rows of one operation (a receipt, a transfer, one sale) and,
    -- with the unique index below, makes every operation safe to retry or redeliver.
    CREATE TABLE stock_movements (
      id              uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      batch_id        uuid NOT NULL,
      product_id      uuid NOT NULL,
      location_id     uuid NOT NULL,
      type            text NOT NULL CHECK (type IN (
                        'opening','purchase','sale','sale_reversal','wastage',
                        'correction','stock_count','transfer_out','transfer_in','delivery_return')),
      quantity_delta  integer NOT NULL CHECK (quantity_delta <> 0),
      unit_cost_kobo  bigint CHECK (unit_cost_kobo >= 0),
      reason          text,
      reference_type  text,
      reference_id    uuid,
      created_by      uuid,
      created_at      timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, product_id)  REFERENCES products (organization_id, id),
      FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id),
      FOREIGN KEY (organization_id, created_by)  REFERENCES users (organization_id, id),
      -- Direction is part of the type: stock in is positive, stock out is negative.
      CHECK (CASE
        WHEN type IN ('opening','purchase','sale_reversal','transfer_in','delivery_return') THEN quantity_delta > 0
        WHEN type IN ('sale','wastage','transfer_out') THEN quantity_delta < 0
        ELSE true
      END),
      -- Manual changes must say why.
      CHECK (type NOT IN ('wastage','correction','stock_count') OR length(trim(coalesce(reason, ''))) > 0)
    );
    CREATE UNIQUE INDEX stock_movements_batch_uidx
      ON stock_movements (organization_id, batch_id, product_id, location_id, type);
    CREATE INDEX stock_movements_org_created_idx ON stock_movements (organization_id, created_at DESC);
    CREATE INDEX stock_movements_org_product_idx ON stock_movements (organization_id, product_id, created_at DESC);

    -- Applies each ledger row to the projection. SECURITY DEFINER: runs as the table owner,
    -- which is why the API role can be denied any direct write to stock_levels.
    CREATE FUNCTION apply_stock_movement() RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $$ BEGIN
        INSERT INTO stock_levels (organization_id, location_id, product_id, quantity, updated_at)
        VALUES (NEW.organization_id, NEW.location_id, NEW.product_id, NEW.quantity_delta, now())
        ON CONFLICT (organization_id, location_id, product_id)
        DO UPDATE SET quantity = stock_levels.quantity + EXCLUDED.quantity, updated_at = now();
        RETURN NEW;
      END $$;
    CREATE TRIGGER stock_movements_apply AFTER INSERT ON stock_movements
      FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

    ${tenantRls('products')}
    ${tenantRls('stock_levels')}
    ${tenantRls('stock_movements')}
    ${appendOnly('stock_movements')}
    REVOKE INSERT, UPDATE, DELETE ON stock_levels FROM ${APP_ROLE}, ${SYSTEM_ROLE};
  `,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    DROP TABLE IF EXISTS stock_movements;
    DROP FUNCTION IF EXISTS apply_stock_movement();
    DROP TABLE IF EXISTS stock_levels;
    DROP TABLE IF EXISTS products;
  `,
    )
    .execute(db);
}
