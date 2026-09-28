import type { Role } from '../database/database.types';

/** Roles that manage the business: see costs, change stock, review everyone's records. */
export const SUPERVISOR_ROLES: ReadonlySet<Role> = new Set<Role>(['owner', 'manager']);

export const isSupervisor = (role: Role): boolean => SUPERVISOR_ROLES.has(role);
