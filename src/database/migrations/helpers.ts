import { APP_ROLE, SYSTEM_ROLE } from '../roles';

/** Standard tenant isolation policies. Apply to every tenant-owned table, in the migration that creates it. */
export function tenantRls(table: string): string {
  return `
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON ${table} TO ${APP_ROLE}
      USING (organization_id = app_current_org_id())
      WITH CHECK (organization_id = app_current_org_id());
    CREATE POLICY system_access ON ${table} TO ${SYSTEM_ROLE}
      USING (true) WITH CHECK (true);
  `;
}

/** Makes a table append-only: no UPDATE or DELETE, for any role, enforced by trigger and privileges. */
export function appendOnly(table: string): string {
  return `
    CREATE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
    REVOKE UPDATE, DELETE ON ${table} FROM ${APP_ROLE}, ${SYSTEM_ROLE};
  `;
}
