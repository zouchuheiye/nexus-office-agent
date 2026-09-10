BEGIN;

-- P4: per-recipient in-app task notifications (work_task_notifications)
-- One row per (triggering task event, recipient). Rows are written in the same
-- tenant transaction as the business change and its work_task_events audit row,
-- so a CAS conflict leaves neither an event nor a notification behind.
-- Reading is strictly self-scoped: tenant isolation comes from RLS, while the
-- per-recipient filter is enforced by the repository query and the service.
CREATE TABLE work_task_notifications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  recipient_id uuid NOT NULL REFERENCES users(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('task_assigned','task_claimed','handoff_requested','handoff_responded','review_requested','review_decided')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 600),
  ref_type text NOT NULL CHECK (ref_type IN ('work_package','work_handoff')),
  ref_id uuid NOT NULL,
  package_id uuid NOT NULL REFERENCES work_packages(id),
  source_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CHECK (read_at IS NULL OR read_at >= created_at),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, recipient_id, source_event_id)
);

CREATE INDEX idx_work_task_notifications_recipient ON work_task_notifications(tenant_id, recipient_id, created_at DESC, id);
CREATE INDEX idx_work_task_notifications_unread ON work_task_notifications(tenant_id, recipient_id) WHERE read_at IS NULL;

DO $$
DECLARE table_name text := 'work_task_notifications';
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name || '_tenant_select_policy', table_name);
  EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name || '_tenant_insert_policy', table_name);
  EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name || '_tenant_update_policy', table_name);
  EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name || '_tenant_delete_policy', table_name);
END;
$$;

-- Notifications are tenant-bearing business rows, so they carry the same atomic
-- summary audit as the rest of the work-command tables (marking read included).
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON work_task_notifications FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
