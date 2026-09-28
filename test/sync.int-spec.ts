/**
 * The offline sync log: an operation is recorded once, and its review can be resolved once.
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
const user = uuidv7();
const asOrg = <T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> => tenantDb.forOrganization(org, fn);

const logOp = (opId: string, status: 'applied' | 'rejected') =>
  asOrg((trx) =>
    trx
      .insertInto('sync_operations')
      .values({
        op_id: opId,
        organization_id: org,
        device_id: 'till-1',
        actor_id: user,
        type: 'sale.create',
        occurred_at: new Date(),
        status,
        entity_id: null,
        flags: status === 'applied' ? ['price_differs_from_catalogue'] : [],
        error_code: status === 'rejected' ? 'SESSION_MISMATCH' : null,
        error_message: status === 'rejected' ? 'x' : null,
        payload: JSON.stringify({ any: 'thing' }),
      })
      .execute(),
  );

beforeAll(async () => {
  const { error } = await createMigrator(owner as unknown as Kysely<unknown>).migrateToLatest();
  if (error) throw error;
  await asOrg(async (trx) => {
    await trx.insertInto('organizations').values({ id: org, name: `Sync Test ${org.slice(-6)}` }).execute();
    await trx
      .insertInto('users')
      .values({ id: user, organization_id: org, full_name: 'Tolu', email: null, phone: null, role: 'owner', password_hash: null, pin_hash: null, default_location_id: null })
      .execute();
  });
});

afterAll(async () => {
  await Promise.all([owner.destroy(), app.destroy()]);
});

it('records an operation only once', async () => {
  const opId = uuidv7();
  await logOp(opId, 'applied');
  await expect(logOp(opId, 'applied')).rejects.toMatchObject({ code: '23505' });
});

it('a rejection must carry its error code', async () => {
  await expect(
    asOrg((trx) =>
      trx
        .insertInto('sync_operations')
        .values({ op_id: uuidv7(), organization_id: org, device_id: 't', actor_id: user, type: 'sale.create', occurred_at: new Date(), status: 'rejected', entity_id: null, error_code: null, error_message: null, payload: '{}' })
        .execute(),
    ),
  ).rejects.toMatchObject({ code: '23514' });
});

it('can be resolved once, and nothing else about it changes', async () => {
  const opId = uuidv7();
  await logOp(opId, 'rejected');
  await expect(asOrg((trx) => trx.updateTable('sync_operations').set({ status: 'applied', error_code: null }).where('op_id', '=', opId).execute())).rejects.toBeDefined();
  await asOrg((trx) =>
    trx.updateTable('sync_operations').set({ resolved_at: sql`now()`, resolved_by: user, resolution_note: 'Re-entered' }).where('op_id', '=', opId).execute(),
  );
  await expect(
    asOrg((trx) => trx.updateTable('sync_operations').set({ resolution_note: 'changed my mind' }).where('op_id', '=', opId).execute()),
  ).rejects.toBeDefined();
});
