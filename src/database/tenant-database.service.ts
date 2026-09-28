import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql, Transaction } from 'kysely';
import { RequestContext } from '../common/context/request-context';
import type { DB } from './database.types';
import { APP_DB } from './database.tokens';

/**
 * The ONLY way application code touches tenant data.
 *
 * Every call opens a transaction and sets app.current_org_id transaction-locally
 * (set_config(..., true)), which Row-Level Security then enforces on every table.
 * Because the setting is transaction-scoped, this is safe behind PgBouncer in
 * transaction pooling mode: it can never leak to the next borrower of the connection.
 *
 * The raw app connection is deliberately not exported from DatabaseModule, so
 * "a query without a tenant" is not something a developer can write by accident.
 */
@Injectable()
export class TenantDatabase {
  constructor(@Inject(APP_DB) private readonly db: Kysely<DB>) {}

  /** Runs in the current request's organization. */
  transaction<T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.forOrganization(RequestContext.require().organizationId, fn);
  }

  /** Runs in an explicit organization: signup, background handlers, sync jobs. */
  forOrganization<T>(organizationId: string, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.current_org_id', ${organizationId}, true)`.execute(trx);
      return fn(trx);
    });
  }
}
