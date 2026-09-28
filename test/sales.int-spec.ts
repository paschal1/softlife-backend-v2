/**
 * A sale is a financial record. The database refuses sales whose numbers don't add up,
 * refuses any change except voiding, and lets debts change only by being paid down.
 */
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { Pool } from 'pg';
import '../src/database/pg-types';
import { uuidv7 } from '../src/common/ids/uuidv7';
import type { DB } from '../src/database/database.types';
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
const asOrg = <T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> => tenantDb.forOrganization(org, fn);

const org = uuidv7();
const loc = uuidv7();
const cashier = uuidv7();
const register = uuidv7();
const session = uuidv7();
const customer = uuidv7();
let nextNumber = 1;

function sale(overrides: Partial<{ total: number; paid: number; credit: number; customer: string | null; orderType: 'walk_in' | 'credit' | 'delivery' }> = {}) {
  const id = uuidv7();
  const total = overrides.total ?? 100_000;
  return asOrg((trx) =>
    trx
      .insertInto('sales')
      .values({
        id,
        organization_id: org,
        number: nextNumber++,
        location_id: loc,
        register_id: register,
        register_session_id: session,
        cashier_id: cashier,
        customer_id: overrides.customer === undefined ? null : overrides.customer,
        order_type: overrides.orderType ?? 'walk_in',
        subtotal_kobo: total,
        total_kobo: total,
        paid_kobo: overrides.paid ?? total,
        credit_kobo: overrides.credit ?? 0,
        delivery_address: null,
        delivery_date: null,
        delivery_driver_id: null,
        note: null,
        approved_by: null,
        approval_reasons: null,
        occurred_at: new Date(),
      })
      .execute(),
  ).then(() => id);
}

beforeAll(async () => {
  const { error } = await createMigrator(owner as unknown as Kysely<unknown>).migrateToLatest();
  if (error) throw error;
  await asOrg(async (trx) => {
    await trx.insertInto('organizations').values({ id: org, name: `Sales Test ${org.slice(-6)}` }).execute();
    await trx.insertInto('locations').values({ id: loc, organization_id: org, name: 'Shop', address: null, phone: null }).execute();
    await trx
      .insertInto('users')
      .values({ id: cashier, organization_id: org, full_name: 'Tolu', email: null, phone: null, role: 'cashier', password_hash: null, pin_hash: null, default_location_id: loc })
      .execute();
    await trx.insertInto('registers').values({ id: register, organization_id: org, location_id: loc, name: 'Till 1' }).execute();
    await trx
      .insertInto('register_sessions')
      .values({ id: session, organization_id: org, register_id: register, location_id: loc, user_id: cashier, opening_float_kobo: 0 })
      .execute();
    await trx
      .insertInto('customers')
      .values({ id: customer, organization_id: org, name: 'Alhaji Musa', phone: null, email: null, address: null, credit_limit_kobo: null, notes: null, created_by: null })
      .execute();
  });
});

afterAll(async () => {
  await Promise.all([owner.destroy(), app.destroy()]);
});

describe('totals must add up', () => {
  it('accepts a consistent sale', async () => {
    await expect(sale()).resolves.toBeDefined();
  });

  it('rejects payments that do not equal the total', async () => {
    await expect(sale({ total: 100_000, paid: 90_000 })).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects credit without a customer, and a credit order without a customer', async () => {
    await expect(sale({ total: 100_000, paid: 0, credit: 100_000 })).rejects.toMatchObject({ code: '23514' });
    await expect(sale({ orderType: 'credit' })).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a delivery order without address and date', async () => {
    await expect(sale({ orderType: 'delivery' })).rejects.toMatchObject({ code: '23514' });
  });
});

describe('a sale can only be voided', () => {
  let id: string;
  beforeAll(async () => {
    id = await sale();
  });

  it('refuses to change the total', async () => {
    await expect(asOrg((trx) => trx.updateTable('sales').set({ total_kobo: 1, subtotal_kobo: 1, paid_kobo: 1 }).where('id', '=', id).execute())).rejects.toBeDefined();
  });

  it('allows completed -> voided with who, when and why', async () => {
    await expect(
      asOrg((trx) =>
        trx.updateTable('sales').set({ status: 'voided', voided_at: sql`now()`, voided_by: cashier, void_reason: 'Wrong item' }).where('id', '=', id).execute(),
      ),
    ).resolves.toBeDefined();
  });

  it('refuses any change after voiding', async () => {
    await expect(asOrg((trx) => trx.updateTable('sales').set({ void_reason: 'edited' }).where('id', '=', id).execute())).rejects.toBeDefined();
  });

  it('cannot be deleted', async () => {
    await expect(asOrg((trx) => trx.deleteFrom('sales').where('id', '=', id).execute())).rejects.toMatchObject({ code: '42501' });
  });
});

describe('debts change only by being paid down', () => {
  let debtId: string;
  beforeAll(async () => {
    const saleId = await sale({ total: 200_000, paid: 50_000, credit: 150_000, customer, orderType: 'credit' });
    debtId = uuidv7();
    await asOrg((trx) =>
      trx.insertInto('debt_records').values({ id: debtId, organization_id: org, customer_id: customer, sale_id: saleId, amount_kobo: 150_000 }).execute(),
    );
  });

  it('starts open and settles automatically when fully paid', async () => {
    const status = () => asOrg((trx) => trx.selectFrom('debt_records').select('status').where('id', '=', debtId).executeTakeFirstOrThrow());
    expect((await status()).status).toBe('open');
    await asOrg((trx) => trx.updateTable('debt_records').set({ paid_kobo: 150_000 }).where('id', '=', debtId).execute());
    expect((await status()).status).toBe('settled');
  });

  it('refuses changing the amount owed or overpaying', async () => {
    await expect(asOrg((trx) => trx.updateTable('debt_records').set({ amount_kobo: 1 }).where('id', '=', debtId).execute())).rejects.toBeDefined();
    await expect(asOrg((trx) => trx.updateTable('debt_records').set({ paid_kobo: 150_001 }).where('id', '=', debtId).execute())).rejects.toMatchObject({ code: '23514' });
  });
});
