BEGIN;

-- P3: task package subtasks (work_package_tasks)
-- Each row is a checklist item under a task package. Mutations must carry the
-- current package version (CAS enforced in the service layer) so concurrent
-- edits cannot overwrite each other; every change is also appended to
-- work_task_events for audit.
CREATE TABLE work_package_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  mission_id uuid NOT NULL REFERENCES work_missions(id),
  package_id uuid NOT NULL REFERENCES work_packages(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 160),
  status text NOT NULL CHECK (status IN ('pending','done')),
  sort_order integer NOT NULL CHECK (sort_order > 0),
  done_by uuid REFERENCES users(id),
  done_at timestamptz,
  done_note text,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs)='array'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (status <> 'done' OR done_by IS NOT NULL),
  CHECK (status <> 'done' OR done_at IS NOT NULL),
  CHECK (status <> 'pending' OR (done_by IS NULL AND done_at IS NULL AND done_note IS NULL))
);

CREATE INDEX idx_work_package_tasks_package ON work_package_tasks(tenant_id, package_id, sort_order, id);

DO $$
DECLARE table_name text := 'work_package_tasks';
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name || '_tenant_select_policy', table_name);
  EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name || '_tenant_insert_policy', table_name);
  EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name || '_tenant_update_policy', table_name);
  EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name || '_tenant_delete_policy', table_name);
END;
$$;

-- Extend the task event vocabulary with progress updates.
ALTER TABLE work_task_events DROP CONSTRAINT work_task_events_event_type_check;
ALTER TABLE work_task_events ADD CONSTRAINT work_task_events_event_type_check CHECK (event_type IN (
  'mission_published','package_published','package_claimed','package_status_changed',
  'package_handoff_initiated','package_handoff_accepted','package_handoff_rejected',
  'package_progress_updated'
));

COMMIT;
