import { Kysely, sql } from 'kysely';
import { APP_ROLE, SYSTEM_ROLE } from '../roles';
import { tenantRls } from './helpers';

/**
 * Offline sync log: one row per operation a till recorded while offline and later pushed.
 *
 * op_id is generated on the device, so a batch re-sent after a dropped connection returns the
 * stored outcome instead of applying anything twice. Rejected operations and applied-but-flagged
 * ones stay listed until a manager resolves them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
    CREATE TABLE sync_operations (
      op_id           uuid NOT NULL,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      device_id       text NOT NULL,
      actor_id        uuid NOT NULL,
      type            text NOT NULL,
      occurred_at     timestamptz NOT NULL,
      status          text NOT NULL CHECK (status IN ('applied','rejected')),
      entity_id       uuid,
      flags           text[] NOT NULL DEFAULT '{}',
      error_code      text,
      error_message   text,
      payload         jsonb NOT NULL,
      received_at     timestamptz NOT NULL DEFAULT now(),
      resolved_at     timestamptz,
      resolved_by     uuid,
      resolution_note text,
      PRIMARY KEY (organization_id, op_id),
      FOREIGN KEY (organization_id, actor_id)    REFERENCES users (organization_id, id),
      FOREIGN KEY (organization_id, resolved_by) REFERENCES users (organization_id, id),
      CHECK ((status = 'rejected') = (error_code IS NOT NULL)),
      CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
    );
    -- The review queue: rejected, or applied with flags, and not yet resolved.
    CREATE INDEX sync_operations_review_idx ON sync_operations (organization_id, received_at DESC)
      WHERE resolved_at IS NULL AND (status = 'rejected' OR cardinality(flags) > 0);
    CREATE INDEX sync_operations_device_idx ON sync_operations (organization_id, device_id, received_at DESC);

    -- Only the resolution can change, once.
    CREATE FUNCTION sync_operations_guard_update() RETURNS trigger
      LANGUAGE plpgsql
      AS $$ BEGIN
        IF OLD.resolved_at IS NOT NULL
           OR (to_jsonb(NEW) - 'resolved_at' - 'resolved_by' - 'resolution_note')
              <> (to_jsonb(OLD) - 'resolved_at' - 'resolved_by' - 'resolution_note') THEN
          RAISE EXCEPTION 'a sync operation can only be resolved, once';
        END IF;
        RETURN NEW;
      END $$;
    CREATE TRIGGER sync_operations_guard_update BEFORE UPDATE ON sync_operations
      FOR EACH ROW EXECUTE FUNCTION sync_operations_guard_update();
    REVOKE DELETE ON sync_operations FROM ${APP_ROLE}, ${SYSTEM_ROLE};

    ${tenantRls('sync_operations')}
  `,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DROP TABLE IF EXISTS sync_operations; DROP FUNCTION IF EXISTS sync_operations_guard_update();`).execute(db);
}
