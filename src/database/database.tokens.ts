/** Tenant-scoped connection (softlife_app). Private to DatabaseModule; use TenantDatabase. */
export const APP_DB = Symbol('APP_DB');

/**
 * Cross-tenant connection (softlife_system). Allowed ONLY in:
 *   - auth (login and refresh happen before the tenant is known)
 *   - the outbox relay
 *   - health checks
 * Anything else reaching for this is a code-review red flag.
 */
export const SYSTEM_DB = Symbol('SYSTEM_DB');
