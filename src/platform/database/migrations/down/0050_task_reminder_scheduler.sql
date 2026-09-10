BEGIN;

DELETE FROM work_message_events WHERE actor_type = 'system';
ALTER TABLE work_message_events DROP CONSTRAINT IF EXISTS work_message_events_actor_attribution_check;
ALTER TABLE work_message_events ALTER COLUMN actor_id SET NOT NULL;
ALTER TABLE work_message_events DROP COLUMN IF EXISTS actor_type;

ALTER TABLE work_task_notifications DROP CONSTRAINT IF EXISTS work_task_notifications_kind_check;
ALTER TABLE work_task_notifications ADD CONSTRAINT work_task_notifications_kind_check CHECK (kind IN (
  'task_assigned','task_claimed','handoff_requested','handoff_responded','review_requested','review_decided'
));
ALTER TABLE work_task_notifications DROP CONSTRAINT IF EXISTS work_task_notifications_actor_attribution_check;
DELETE FROM work_task_notifications WHERE actor_type = 'system';
ALTER TABLE work_task_notifications ALTER COLUMN actor_id SET NOT NULL;
ALTER TABLE work_task_notifications DROP COLUMN IF EXISTS actor_type;

ALTER TABLE work_pool_messages DROP CONSTRAINT IF EXISTS work_pool_messages_author_attribution_check;
ALTER TABLE work_pool_messages DROP CONSTRAINT IF EXISTS work_pool_messages_source_check;
UPDATE work_pool_messages SET author_id = (SELECT id FROM users WHERE users.tenant_id = work_pool_messages.tenant_id ORDER BY created_at LIMIT 1) WHERE author_id IS NULL;
ALTER TABLE work_pool_messages ALTER COLUMN author_id SET NOT NULL;
ALTER TABLE work_pool_messages DROP COLUMN IF EXISTS author_type;
ALTER TABLE work_pool_messages ADD CONSTRAINT work_pool_messages_source_check CHECK (source IN ('human','agent'));

ALTER TABLE worker_heartbeats DROP CONSTRAINT IF EXISTS worker_heartbeats_role_check;
DELETE FROM worker_heartbeats WHERE role = 'task-reminder';
ALTER TABLE worker_heartbeats ADD CONSTRAINT worker_heartbeats_role_check
  CHECK (role IN ('inbox','agent','outbox','pi-runner','pi-change-delivery'));

COMMIT;
