import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { createMigrator } from './migrator';

async function main(): Promise<void> {
  const direction = process.argv[2] ?? 'latest';
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL is not set');

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 1 }) }),
  });
  const migrator = createMigrator(db);

  const { error, results } =
    direction === 'down' ? await migrator.migrateDown() : await migrator.migrateToLatest();

  for (const r of results ?? []) {
    const mark = r.status === 'Success' ? '✓' : r.status === 'Error' ? '✗' : '–';
    console.log(`${mark} ${r.direction.toLowerCase()} ${r.migrationName}`);
  }
  if (!results?.length && !error) console.log('Nothing to migrate.');

  await db.destroy();
  if (error) {
    console.error(error);
    process.exit(1);
  }
}

void main();
