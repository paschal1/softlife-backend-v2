import { Kysely, Migrator } from 'kysely';
import { migrations } from './migrations';

export function createMigrator(db: Kysely<unknown>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  });
}
