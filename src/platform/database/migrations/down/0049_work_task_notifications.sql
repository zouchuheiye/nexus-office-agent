BEGIN;

DROP TRIGGER IF EXISTS nexus_atomic_audit ON work_task_notifications;
DROP TABLE IF EXISTS work_task_notifications;

COMMIT;
