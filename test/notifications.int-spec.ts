/**
 * Nobody is told the same thing twice, and a daily job runs once per business per day,
 * however many workers are running.
 */
import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import { Pool } from 'pg';
import '../src/database/pg-types';
import { uuidv7 } from '../src/common/ids/uuidv7';
import type { DB } from '../src/database/database.types';
import { createMigrator } from '../src/database/migrator';
import { TenantDatabase } from '../src/database/tenant-database.service';

function connect(envVar: string): Kysely<DB> {
  const url = process.env[envVar];
  if (!url) throw new Error(`${envVar} is not set (copy .env.test.example to .env.test)`);
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 5 }) }) });
}

const owner = connect('TEST_DATABASE_MIGRATION_URL');
const app = connect('TEST_DATABASE_APP_URL');
const system = connect('TEST_DATABASE_SYSTEM_URL');
const tenantDb = new TenantDatabase(app);
const org = uuidv7();
const user = uuidv7();
const asOrg = <T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> => tenantDb.forOrganization(org, fn);

const notify = (sourceKey: string) =>
  asOrg((trx) =>
    trx
      .insertInto('notifications')
      .values({ id: uuidv7(), organization_id: org, user_id: user, kind: 'low_stock', severity: 'warning', title: 't', body: 'b', data: '{}', source_key: sourceKey })
      .onConflict((oc) => oc.columns(['organization_id', 'user_id', 'source_key']).doNothing())
      .returning('id')
      .execute(),
  );

beforeAll(async () => {
  const { error } = await createMigrator(owner as unknown as Kysely<unknown>).migrateToLatest();
  if (error) throw error;
  await asOrg(async (trx) => {
    await trx.insertInto('organizations').values({ id: org, name: `Notify Test ${org.slice(-6)}` }).execute();
    await trx
      .insertInto('users')
      .values({ id: user, organization_id: org, full_name: 'Owner', email: null, phone: null, role: 'owner', password_hash: null, pin_hash: null, default_location_id: null })
      .execute();
  });
});

afterAll(async () => {
  await Promise.all([owner.destroy(), app.destroy(), system.destroy()]);
});

it('the same event notifies a person only once, even when delivered twice', async () => {
  const key = `event:${uuidv7()}`;
  expect(await notify(key)).toHaveLength(1);
  expect(await notify(key)).toHaveLength(0);
});

it('five workers racing to run the same daily job: exactly one gets it', async () => {
  const claim = () =>
    system
      .insertInto('job_runs')
      .values({ organization_id: org, job: 'daily_digest', period_key: '2026-09-30' })
      .onConflict((oc) => oc.doNothing())
      .returning('job')
      .executeTakeFirst();
  const results = await Promise.all([claim(), claim(), claim(), claim(), claim()]);
  expect(results.filter(Boolean)).toHaveLength(1);
});
