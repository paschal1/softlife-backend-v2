/**
 * Wallet balances are computed from the ledger by the database and can never go negative,
 * even when two payments race each other (WAL-02, WAL-03).
 */
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { Pool } from 'pg';
import '../src/database/pg-types';
import { uuidv7 } from '../src/common/ids/uuidv7';
import type { DB, WalletTransactionType } from '../src/database/database.types';
import { createMigrator } from '../src/database/migrator';
import { TenantDatabase } from '../src/database/tenant-database.service';

function connect(envVar: string): Kysely<DB> {
  const url = process.env[envVar];
  if (!url) throw new Error(`${envVar} is not set (copy .env.test.example to .env.test)`);
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 5 }) }) });
}

const owner = connect('TEST_DATABASE_MIGRATION_URL');
const app = connect('TEST_DATABASE_APP_URL');
const tenantDb = new TenantDatabase(app);

const org = uuidv7();
const customer = uuidv7();
const asOrg = <T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> => tenantDb.forOrganization(org, fn);

function txn(type: WalletTransactionType, amount: number, extra: { method?: 'cash' | 'transfer'; reference?: string; reason?: string } = {}) {
  return asOrg((trx) =>
    trx
      .insertInto('wallet_transactions')
      .values({
        id: uuidv7(),
        organization_id: org,
        customer_id: customer,
        type,
        amount_kobo: amount,
        method: extra.method ?? null,
        reference: extra.reference ?? null,
        reason: extra.reason ?? null,
        reference_type: null,
        reference_id: null,
        register_session_id: null,
        created_by: null,
      })
      .execute(),
  );
}

const balance = () =>
  asOrg((trx) => trx.selectFrom('customer_wallets').select('balance_kobo').where('customer_id', '=', customer).executeTakeFirst()).then(
    (r) => r?.balance_kobo ?? 0,
  );

beforeAll(async () => {
  const { error } = await createMigrator(owner as unknown as Kysely<unknown>).migrateToLatest();
  if (error) throw error;
  await asOrg(async (trx) => {
    await trx.insertInto('organizations').values({ id: org, name: `Wallet Test ${org.slice(-6)}` }).execute();
    await trx
      .insertInto('customers')
      .values({ id: customer, organization_id: org, name: 'Mama Nkechi', phone: null, email: null, address: null, credit_limit_kobo: null, notes: null, created_by: null })
      .execute();
  });
});

afterAll(async () => {
  await Promise.all([owner.destroy(), app.destroy()]);
});

describe('wallet balance follows the ledger', () => {
  it('applies top-ups and payments', async () => {
    await txn('top_up', 500_000, { method: 'transfer', reference: 'TRF-001' });
    await txn('payment', -120_000);
    expect(await balance()).toBe(380_000);
  });

  it('equals the sum of its history (WAL-03)', async () => {
    const sum = await asOrg((trx) =>
      trx
        .selectFrom('wallet_transactions')
        .select(sql<number>`coalesce(sum(amount_kobo), 0)::bigint`.as('total'))
        .where('customer_id', '=', customer)
        .executeTakeFirstOrThrow(),
    );
    expect(Number(sum.total)).toBe(await balance());
  });
});

describe('wallet can never go negative (WAL-02)', () => {
  it('rejects a payment larger than the balance', async () => {
    const before = await balance();
    await expect(txn('payment', -(before + 1))).rejects.toMatchObject({ code: '23514' });
    expect(await balance()).toBe(before);
  });

  it('two tills racing for the same money: exactly one wins', async () => {
    const available = await balance();
    const results = await Promise.allSettled([txn('payment', -available), txn('payment', -available)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balance()).toBe(0);
  });
});

describe('ledger rules', () => {
  it('a transfer top-up needs a bank reference', async () => {
    await expect(txn('top_up', 1_000, { method: 'transfer' })).rejects.toMatchObject({ code: '23514' });
  });

  it('a cash top-up must land in a till (register session)', async () => {
    await expect(txn('top_up', 1_000, { method: 'cash' })).rejects.toMatchObject({ code: '23514' });
  });

  it('an adjustment needs a reason', async () => {
    await expect(txn('adjustment', 1_000)).rejects.toMatchObject({ code: '23514' });
  });

  it('the API role cannot write balances directly or edit history', async () => {
    await expect(
      asOrg((trx) => trx.updateTable('customer_wallets').set({ balance_kobo: 99_999_999 }).where('customer_id', '=', customer).execute()),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asOrg((trx) => trx.updateTable('wallet_transactions').set({ amount_kobo: 1 }).where('customer_id', '=', customer).execute()),
    ).rejects.toBeDefined();
  });
});
