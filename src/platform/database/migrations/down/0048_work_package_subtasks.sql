BEGIN;

DROP TABLE IF EXISTS work_package_tasks;

ALTER TABLE work_task_events DROP CONSTRAINT work_task_events_event_type_check;
ALTER TABLE work_task_events ADD CONSTRAINT work_task_events_event_type_check CHECK (event_type IN (
  'mission_published','package_published','package_claimed','package_status_changed',
  'package_handoff_initiated','package_handoff_accepted','package_handoff_rejected'
));

COMMIT;
