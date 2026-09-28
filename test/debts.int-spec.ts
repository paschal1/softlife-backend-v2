/**
 * A debt's paid amount always equals the repayments recorded against it: the database
 * refuses every other way of changing it. Voiding is allowed only before anything is paid.
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
let saleNumber = 1;

async function creditSale(amount: number): Promise<string> {
  const saleId = uuidv7();
  const debtId = uuidv7();
  await asOrg(async (trx) => {
    await trx
      .insertInto('sales')
      .values({
        id: saleId, organization_id: org, number: saleNumber++, location_id: loc, register_id: register, register_session_id: session,
        cashier_id: cashier, customer_id: customer, order_type: 'credit', subtotal_kobo: amount, total_kobo: amount, paid_kobo: 0,
        credit_kobo: amount, delivery_address: null, delivery_date: null, delivery_driver_id: null, note: null, approved_by: null,
        approval_reasons: null, occurred_at: new Date(),
      })
      .execute();
    await trx.insertInto('debt_records').values({ id: debtId, organization_id: org, customer_id: customer, sale_id: saleId, amount_kobo: amount }).execute();
  });
  return debtId;
}

async function repay(debtId: string, amount: number): Promise<void> {
  const repaymentId = uuidv7();
  await asOrg(async (trx) => {
    await trx
      .insertInto('debt_repayments')
      .values({ id: repaymentId, organization_id: org, customer_id: customer, amount_kobo: amount, method: 'transfer', reference: 'TRF', note: null, wallet_transaction_id: null, register_session_id: null, created_by: cashier })
      .execute();
    await trx
      .insertInto('debt_repayment_allocations')
      .values({ id: uuidv7(), organization_id: org, repayment_id: repaymentId, debt_record_id: debtId, amount_kobo: amount })
      .execute();
  });
}

const debt = (id: string) => asOrg((trx) => trx.selectFrom('debt_records').select(['paid_kobo', 'status']).where('id', '=', id).executeTakeFirstOrThrow());

beforeAll(async () => {
  const { error } = await createMigrator(owner as unknown as Kysely<unknown>).migrateToLatest();
  if (error) throw error;
  await asOrg(async (trx) => {
    await trx.insertInto('organizations').values({ id: org, name: `Debt Test ${org.slice(-6)}` }).execute();
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

describe('paid amount follows repayments', () => {
  let id: string;
  beforeAll(async () => {
    id = await creditSale(100_000);
  });

  it('refuses a direct change to the paid amount', async () => {
    await expect(asOrg((trx) => trx.updateTable('debt_records').set({ paid_kobo: 100_000 }).where('id', '=', id).execute())).rejects.toBeDefined();
    expect((await debt(id)).paid_kobo).toBe(0);
  });

  it('a recorded repayment advances it, and settles the debt when complete', async () => {
    await repay(id, 40_000);
    expect(await debt(id)).toEqual({ paid_kobo: 40_000, status: 'open' });
    await repay(id, 60_000);
    expect(await debt(id)).toEqual({ paid_kobo: 100_000, status: 'settled' });
  });

  it('refuses overpayment, and the whole repayment rolls back', async () => {
    await expect(repay(id, 1)).rejects.toMatchObject({ code: '23514' });
    expect((await debt(id)).paid_kobo).toBe(100_000);
  });

  it('repayments are append-only', async () => {
    await expect(asOrg((trx) => trx.updateTable('debt_repayments').set({ amount_kobo: 1 }).where('customer_id', '=', customer).execute())).rejects.toBeDefined();
  });
});

describe('voiding a debt', () => {
  it('works while nothing is paid, and blocks later repayments', async () => {
    const id = await creditSale(50_000);
    await asOrg((trx) => trx.updateTable('debt_records').set({ voided_at: sql`now()` }).where('id', '=', id).execute());
    expect((await debt(id)).status).toBe('voided');
    await expect(repay(id, 1_000)).rejects.toBeDefined();
  });

  it('is refused once something has been paid', async () => {
    const id = await creditSale(50_000);
    await repay(id, 10_000);
    await expect(asOrg((trx) => trx.updateTable('debt_records').set({ voided_at: sql`now()` }).where('id', '=', id).execute())).rejects.toBeDefined();
  });
});
