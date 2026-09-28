import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import './pg-types';
import type { Env } from '../config/env';
import type { DB } from './database.types';
import { APP_DB, SYSTEM_DB } from './database.tokens';
import { TenantDatabase } from './tenant-database.service';

function createDb(connectionString: string, max: number): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString, max }) }),
  });
}

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(APP_DB) private readonly appDb: Kysely<DB>,
    @Inject(SYSTEM_DB) private readonly systemDb: Kysely<DB>,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.appDb.destroy(), this.systemDb.destroy()]);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: APP_DB,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createDb(config.get('DATABASE_APP_URL', { infer: true }), config.get('DATABASE_POOL_MAX', { infer: true })),
    },
    {
      provide: SYSTEM_DB,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createDb(config.get('DATABASE_SYSTEM_URL', { infer: true }), 5),
    },
    TenantDatabase,
    DatabaseLifecycle,
  ],
  exports: [TenantDatabase, SYSTEM_DB],
})
export class DatabaseModule {}
