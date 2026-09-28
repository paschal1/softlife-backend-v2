/**
 * Register rules enforced by the database itself, independent of application code:
 * no shared sessions (REG-02), permanent EOD records (EOD-02), and a trustworthy cash ledger.
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

const org = uuidv7();
const location = uuidv7();
const alice = uuidv7();
const bola = uuidv7();
const till1 = uuidv7();
const till2 = uuidv7();

const asOrg = <T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> => tenantDb.forOrganization(org, fn);

function openSession(id: string, registerId: string, userId: string) {
  return asOrg((trx) =>
    trx
      .insertInto('register_sessions')
      .values({
        id,
        organization_id: org,
        register_id: registerId,
        location_id: location,
        user_id: userId,
        opening_float_kobo: 500_000,
      })
      .execute(),
  );
}

function movement(sessionId: string, kind: DB['register_cash_movements']['kind'], amount: number, reason: string | null) {
  return asOrg((trx) =>
    trx
      .insertInto('register_cash_movements')
      .values({
        id: uuidv7(),
        organization_id: org,
        register_session_id: sessionId,
        kind,
        amount_kobo: amount,
        reason,
        reference_type: null,
        reference_id: null,
        created_by: alice,
      })
      .execute(),
  );
}

beforeAll(async () => {
  const { error } = await createMigrator(owner as unknown as Kysely<unknown>).migrateToLatest();
  if (error) throw error;

  await tenantDb.forOrganization(org, async (trx) => {
    await trx.insertInto('organizations').values({ id: org, name: `Register Test ${org.slice(-6)}` }).execute();
    await trx.insertInto('locations').values({ id: location, organization_id: org, name: 'HQ', address: null, phone: null }).execute();
    for (const [id, name] of [[alice, 'Alice'], [bola, 'Bola']] as const) {
      await trx
        .insertInto('users')
        .values({ id, organization_id: org, full_name: name, email: null, phone: null, role: 'cashier', password_hash: null, pin_hash: null, default_location_id: location })
        .execute();
    }
    for (const [id, name] of [[till1, 'Till 1'], [till2, 'Till 2']] as const) {
      await trx.insertInto('registers').values({ id, organization_id: org, location_id: location, name }).execute();
    }
  });
});

afterAll(async () => {
  await Promise.all([owner.destroy(), app.destroy()]);
});

describe('no shared sessions (REG-02)', () => {
  const s1 = uuidv7();

  it('allows one open session on a register', async () => {
    await expect(openSession(s1, till1, alice)).resolves.toBeDefined();
  });

  it('rejects a second open session on the same register', async () => {
    await expect(openSession(uuidv7(), till1, bola)).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects the same person being open on two registers', async () => {
    await expect(openSession(uuidv7(), till2, alice)).rejects.toMatchObject({ code: '23505' });
  });
});

describe('cash ledger', () => {
  const s = uuidv7();
  beforeAll(() => openSession(s, till2, bola));

  it('accepts a pay-in with a reason and a negative pay-out', async () => {
    await expect(movement(s, 'pay_in', 10_000, 'Change from owner')).resolves.toBeDefined();
    await expect(movement(s, 'pay_out', -5_000, 'Diesel')).resolves.toBeDefined();
  });

  it('rejects a positive pay-out (wrong sign)', async () => {
    await expect(movement(s, 'pay_out', 5_000, 'Diesel')).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a pay-in without a reason', async () => {
    await expect(movement(s, 'pay_in', 5_000, '  ')).rejects.toMatchObject({ code: '23514' });
  });

  it('is append-only', async () => {
    await expect(
      asOrg((trx) => trx.updateTable('register_cash_movements').set({ amount_kobo: 1 }).where('register_session_id', '=', s).execute()),
    ).rejects.toBeDefined();
    await expect(
      asOrg((trx) => trx.deleteFrom('register_cash_movements').where('register_session_id', '=', s).execute()),
    ).rejects.toBeDefined();
  });
});

describe('End of Day records (EOD-02)', () => {
  const s = uuidv7();
  const close = (variance: number) =>
    asOrg((trx) =>
      trx
        .updateTable('register_sessions')
        .set({
          status: 'closed',
          closed_at: sql`now()`,
          closed_by: alice,
          expected_cash_kobo: 500_000,
          counted_cash_kobo: 480_000,
          variance_kobo: variance,
          variance_flagged: true,
        })
        .where('id', '=', s)
        .execute(),
    );

  beforeAll(async () => {
    // Free Alice's till from the first describe block by closing it properly.
    await asOrg((trx) =>
      trx
        .updateTable('register_sessions')
        .set({ status: 'closed', closed_at: sql`now()`, closed_by: alice, expected_cash_kobo: 500_000, counted_cash_kobo: 500_000, variance_kobo: 0 })
        .where('user_id', '=', alice)
        .where('status', '=', 'open')
        .execute(),
    );
    await openSession(s, till1, alice);
  });

  it('rejects a variance that is not counted − expected', async () => {
    await expect(close(-5)).rejects.toMatchObject({ code: '23514' });
  });

  it('closes with a correct variance', async () => {
    await expect(close(-20_000)).resolves.toBeDefined();
  });

  it('cannot be modified once closed', async () => {
    await expect(
      asOrg((trx) => trx.updateTable('register_sessions').set({ variance_flagged: false }).where('id', '=', s).execute()),
    ).rejects.toBeDefined();
  });

  it('cannot be deleted by the app', async () => {
    await expect(asOrg((trx) => trx.deleteFrom('register_sessions').where('id', '=', s).execute())).rejects.toMatchObject({
      code: '42501',
    });
  });
});
