BEGIN;

ALTER TABLE work_task_handoffs
  DROP COLUMN IF EXISTS attention_points,
  DROP COLUMN IF EXISTS pending_work,
  DROP COLUMN IF EXISTS completed_work,
  DROP COLUMN IF EXISTS current_progress;

COMMIT;
