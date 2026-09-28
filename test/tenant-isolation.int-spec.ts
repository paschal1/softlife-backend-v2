/**
 * The most important test in the codebase: one business can never see or touch
 * another business's data, even if application code forgets to filter by tenant.
 *
 * Requires Postgres with the roles from docker/postgres/init (see README → Tests).
 */
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import '../src/database/pg-types';
import { PG_INSUFFICIENT_PRIVILEGE } from '../src/common/db/pg-errors';
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
const system = connect('TEST_DATABASE_SYSTEM_URL');
const tenantDb = new TenantDatabase(app);

const orgA = uuidv7();
const orgB = uuidv7();
const locA = uuidv7();
const locB = uuidv7();

async function seedOrg(orgId: string, locationId: string, name: string): Promise<void> {
  await tenantDb.forOrganization(orgId, async (trx) => {
    await trx.insertInto('organizations').values({ id: orgId, name }).execute();
    await trx
      .insertInto('locations')
      .values({ id: locationId, organization_id: orgId, name: `${name} HQ`, address: null, phone: null })
      .execute();
  });
}

beforeAll(async () => {
  const { error } = await createMigrator(owner as unknown as Kysely<unknown>).migrateToLatest();
  if (error) throw error;
  await seedOrg(orgA, locA, `Aqua Water ${orgA.slice(-6)}`);
  await seedOrg(orgB, locB, `Bola Stores ${orgB.slice(-6)}`);
});

afterAll(async () => {
  await Promise.all([owner.destroy(), app.destroy(), system.destroy()]);
});

describe('tenant isolation (Row-Level Security)', () => {
  it('each organization sees only its own rows', async () => {
    const seenByA = await tenantDb.forOrganization(orgA, (trx) => trx.selectFrom('locations').select('id').execute());
    const seenByB = await tenantDb.forOrganization(orgB, (trx) => trx.selectFrom('locations').select('id').execute());

    expect(seenByA.map((r) => r.id)).toEqual([locA]);
    expect(seenByB.map((r) => r.id)).toEqual([locB]);
  });

  it('a query with NO tenant context returns nothing (fails closed)', async () => {
    const rows = await app.selectFrom('locations').select('id').execute();
    expect(rows).toHaveLength(0);
  });

  it("cannot insert a row into another organization", async () => {
    const attempt = tenantDb.forOrganization(orgA, (trx) =>
      trx
        .insertInto('locations')
        .values({ id: uuidv7(), organization_id: orgB, name: 'Sneaky branch', address: null, phone: null })
        .execute(),
    );
    await expect(attempt).rejects.toMatchObject({ code: PG_INSUFFICIENT_PRIVILEGE });
  });

  it("cannot update or delete another organization's rows", async () => {
    const [updated, deleted] = await tenantDb.forOrganization(orgA, async (trx) => [
      await trx.updateTable('locations').set({ name: 'Hijacked' }).where('id', '=', locB).executeTakeFirst(),
      await trx.deleteFrom('locations').where('id', '=', locB).executeTakeFirst(),
    ]);
    expect(Number(updated.numUpdatedRows)).toBe(0);
    expect(Number(deleted.numDeletedRows)).toBe(0);

    const stillThere = await tenantDb.forOrganization(orgB, (trx) =>
      trx.selectFrom('locations').select('name').where('id', '=', locB).executeTakeFirstOrThrow(),
    );
    expect(stillThere.name).not.toBe('Hijacked');
  });

  it('tenant context does not leak into the next transaction on the same pool', async () => {
    await tenantDb.forOrganization(orgA, (trx) => trx.selectFrom('locations').select('id').execute());
    const after = await app.selectFrom('locations').select('id').execute();
    expect(after).toHaveLength(0);
  });

  it('a child row cannot reference a parent in another organization (composite FK)', async () => {
    // Even the system role, which bypasses tenant policies, is stopped by the schema itself.
    const attempt = system
      .insertInto('users')
      .values({
        id: uuidv7(),
        organization_id: orgA,
        full_name: 'Cross-tenant user',
        email: null,
        phone: null,
        role: 'cashier',
        password_hash: null,
        pin_hash: null,
        default_location_id: locB,
      })
      .execute();
    await expect(attempt).rejects.toMatchObject({ code: '23503' });
  });
});

describe('outbox and audit log guarantees', () => {
  it('the API role can append to the outbox but cannot read it back', async () => {
    const readBack = await tenantDb.forOrganization(orgA, async (trx) => {
      await trx
        .insertInto('outbox_events')
        .values({
          id: uuidv7(),
          organization_id: orgA,
          location_id: null,
          actor_id: null,
          event_type: 'test.happened',
          aggregate_type: 'test',
          aggregate_id: uuidv7(),
          payload: JSON.stringify({ ok: true }),
          occurred_at: new Date(),
        })
        .execute();
      return trx.selectFrom('outbox_events').select('id').execute();
    });
    expect(readBack).toHaveLength(0);
  });

  it('the audit log is append-only, even for the system role', async () => {
    const id = uuidv7();
    await tenantDb.forOrganization(orgA, (trx) =>
      trx
        .insertInto('audit_log')
        .values({
          id,
          event_id: uuidv7(),
          organization_id: orgA,
          location_id: null,
          actor_id: null,
          action_type: 'test.happened',
          entity_type: 'test',
          entity_id: uuidv7(),
          before_state: null,
          after_state: JSON.stringify({ ok: true }),
          occurred_at: new Date(),
        })
        .execute(),
    );

    await expect(
      system.updateTable('audit_log').set({ action_type: 'tampered' }).where('id', '=', id).execute(),
    ).rejects.toBeDefined();
    await expect(system.deleteFrom('audit_log').where('id', '=', id).execute()).rejects.toBeDefined();
  });

  it('never exposes the migration bookkeeping tables to the app role', async () => {
    const attempt = sql`select * from kysely_migration`.execute(app);
    await expect(attempt).rejects.toMatchObject({ code: PG_INSUFFICIENT_PRIVILEGE });
  });
});
