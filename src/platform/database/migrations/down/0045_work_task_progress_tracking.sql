BEGIN;

DROP INDEX IF EXISTS idx_work_packages_due_tracking;
ALTER TABLE work_packages
  DROP COLUMN IF EXISTS estimated_days,
  DROP COLUMN IF EXISTS started_at;

COMMIT;
