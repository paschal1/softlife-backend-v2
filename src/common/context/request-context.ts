import { AsyncLocalStorage } from 'node:async_hooks';
import type { Role } from '../../database/database.types';

export interface RequestContextData {
  organizationId: string;
  userId: string;
  role: Role;
  locationId: string | null;
  sessionId: string;
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContextData>();

/**
 * Per-request tenant context, available anywhere down the call chain without
 * threading it through every function signature. Populated by
 * RequestContextInterceptor from the verified access token.
 */
export const RequestContext = {
  run<T>(data: RequestContextData, fn: () => T): T {
    return storage.run(data, fn);
  },

  get(): RequestContextData | undefined {
    return storage.getStore();
  },

  /** Throws rather than silently running a query with no tenant. */
  require(): RequestContextData {
    const ctx = storage.getStore();
    if (!ctx) {
      throw new Error(
        'No request context. Tenant-scoped work outside an authenticated request must use ' +
          'TenantDatabase.forOrganization(orgId, ...) explicitly.',
      );
    }
    return ctx;
  },
};
