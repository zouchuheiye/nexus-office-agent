BEGIN;

ALTER TABLE worker_heartbeats DROP CONSTRAINT IF EXISTS worker_heartbeats_role_check;
DELETE FROM worker_heartbeats WHERE role = 'notification-dispatch';
ALTER TABLE worker_heartbeats ADD CONSTRAINT worker_heartbeats_role_check
  CHECK (role IN ('inbox','agent','outbox','pi-runner','pi-change-delivery','task-reminder'));

COMMIT;
