/**
 * Stock can only change through the ledger, and the per-branch level always equals
 * the ledger's sum. Enforced by the database, not by application code.
 */
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { Pool } from 'pg';
import '../src/database/pg-types';
import { uuidv7 } from '../src/common/ids/uuidv7';
import type { DB, StockMovementType } from '../src/database/database.types';
import { createMigrator } from '../src/database/migrator';
import { TenantDatabase } from '../src/database/tenant-database.service';

function connect(envVar: string): Kysely<DB> {
  const url = process.env[envVar];
  if (!url) throw new Error(`${envVar} is not set (copy .env.test.example to .env.test)`);
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 3 }) }) });
}

const owner = connect('TEST_DATABASE_MIGRATION_URL');
const app = connect('TEST_DATABASE_APP_URL');
const tenantDb = new TenantDatabase(app);

const org = uuidv7();
const hq = uuidv7();
const outlet = uuidv7();
const water = uuidv7();

const asOrg = <T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> => tenantDb.forOrganization(org, fn);

function move(type: StockMovementType, delta: number, opts: { location?: string; batch?: string; reason?: string } = {}) {
  return asOrg((trx) =>
    trx
      .insertInto('stock_movements')
      .values({
        id: uuidv7(),
        organization_id: org,
        batch_id: opts.batch ?? uuidv7(),
        product_id: water,
        location_id: opts.location ?? hq,
        type,
        quantity_delta: delta,
        unit_cost_kobo: null,
        reason: opts.reason ?? null,
        reference_type: null,
        reference_id: null,
        created_by: null,
      })
      .execute(),
  );
}

const levelAt = (location: string) =>
  asOrg((trx) =>
    trx.selectFrom('stock_levels').select('quantity').where('location_id', '=', location).where('product_id', '=', water).executeTakeFirst(),
  ).then((r) => r?.quantity ?? 0);

const ledgerSumAt = (location: string) =>
  asOrg((trx) =>
    trx
      .selectFrom('stock_movements')
      .select(sql<number>`coalesce(sum(quantity_delta), 0)::bigint`.as('total'))
      .where('location_id', '=', location)
      .where('product_id', '=', water)
      .executeTakeFirstOrThrow(),
  ).then((r) => Number(r.total));

beforeAll(async () => {
  const { error } = await createMigrator(owner as unknown as Kysely<unknown>).migrateToLatest();
  if (error) throw error;
  await asOrg(async (trx) => {
    await trx.insertInto('organizations').values({ id: org, name: `Inventory Test ${org.slice(-6)}` }).execute();
    await trx.insertInto('locations').values({ id: hq, organization_id: org, name: 'Factory', address: null, phone: null }).execute();
    await trx.insertInto('locations').values({ id: outlet, organization_id: org, name: 'Outlet', address: null, phone: null }).execute();
    await trx
      .insertInto('products')
      .values({ id: water, organization_id: org, name: 'Pure Water (Bag)', sku: null, barcode: null, category: 'Water', unit: 'bag', selling_price_kobo: 30_000, wholesale_price_kobo: null, reorder_level: 20 })
      .execute();
  });
});

afterAll(async () => {
  await Promise.all([owner.destroy(), app.destroy()]);
});

describe('stock levels follow the ledger', () => {
  it('the trigger creates and updates the level from movements', async () => {
    await move('purchase', 100);
    await move('sale', -30);
    await move('wastage', -5, { reason: 'Burst bags' });
    expect(await levelAt(hq)).toBe(65);
    expect(await levelAt(hq)).toBe(await ledgerSumAt(hq));
  });

  it('keeps branches separate', async () => {
    await move('transfer_in', 40, { location: outlet });
    expect(await levelAt(outlet)).toBe(40);
    expect(await levelAt(hq)).toBe(65);
  });

  it('a rolled-back movement leaves the level untouched', async () => {
    const before = await levelAt(hq);
    await expect(
      asOrg(async (trx) => {
        await trx
          .insertInto('stock_movements')
          .values({ id: uuidv7(), organization_id: org, batch_id: uuidv7(), product_id: water, location_id: hq, type: 'purchase', quantity_delta: 999, unit_cost_kobo: null, reason: null, reference_type: null, reference_id: null, created_by: null })
          .execute();
        throw new Error('simulated crash after the movement');
      }),
    ).rejects.toThrow('simulated crash');
    expect(await levelAt(hq)).toBe(before);
  });
});

describe('the API role cannot bypass the ledger', () => {
  it('cannot insert, update or delete stock levels directly', async () => {
    await expect(
      asOrg((trx) => trx.updateTable('stock_levels').set({ quantity: 1_000_000 }).where('product_id', '=', water).execute()),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asOrg((trx) => trx.insertInto('stock_levels').values({ organization_id: org, location_id: outlet, product_id: water, quantity: 5 }).execute()),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(asOrg((trx) => trx.deleteFrom('stock_levels').execute())).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot edit or delete ledger rows', async () => {
    await expect(
      asOrg((trx) => trx.updateTable('stock_movements').set({ quantity_delta: 1 }).where('product_id', '=', water).execute()),
    ).rejects.toBeDefined();
    await expect(asOrg((trx) => trx.deleteFrom('stock_movements').where('product_id', '=', water).execute())).rejects.toBeDefined();
  });
});

describe('ledger rules', () => {
  it('rejects a movement in the wrong direction', async () => {
    await expect(move('purchase', -10)).rejects.toMatchObject({ code: '23514' });
    await expect(move('sale', 10)).rejects.toMatchObject({ code: '23514' });
  });

  it('requires a reason for manual adjustments', async () => {
    await expect(move('wastage', -1)).rejects.toMatchObject({ code: '23514' });
  });

  it('records the same operation only once (batch idempotency)', async () => {
    const batch = uuidv7();
    await move('purchase', 10, { batch });
    await expect(move('purchase', 10, { batch })).rejects.toMatchObject({ code: '23505' });
  });
});
