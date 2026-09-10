BEGIN;

-- P4（第二半）：让提醒扫描可以常驻调度，并以“系统”身份署名。
-- 1) 常驻 Worker 需要一个自己的角色，才算得上有心跳与可观测证据。
-- 2) 定时提醒不是任何同事发出的：把“系统”署名做成显式列，
--    而不是借用开发/管理员账号冒名（actor_id/author_id 在系统署名时为 NULL）。
-- 3) 提醒要投递到人，因此通知类型扩展出临期/逾期/阻塞三类。

ALTER TABLE worker_heartbeats DROP CONSTRAINT IF EXISTS worker_heartbeats_role_check;
ALTER TABLE worker_heartbeats ADD CONSTRAINT worker_heartbeats_role_check
  CHECK (role IN ('inbox','agent','outbox','pi-runner','pi-change-delivery','task-reminder'));

ALTER TABLE work_pool_messages ADD COLUMN author_type text NOT NULL DEFAULT 'user' CHECK (author_type IN ('user','system'));
ALTER TABLE work_pool_messages ALTER COLUMN author_id DROP NOT NULL;
ALTER TABLE work_pool_messages ADD CONSTRAINT work_pool_messages_author_attribution_check
  CHECK ((author_type = 'user') = (author_id IS NOT NULL));
ALTER TABLE work_pool_messages DROP CONSTRAINT IF EXISTS work_pool_messages_source_check;
ALTER TABLE work_pool_messages ADD CONSTRAINT work_pool_messages_source_check
  CHECK (source IN ('human','agent','system'));

ALTER TABLE work_task_notifications ADD COLUMN actor_type text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','system'));
ALTER TABLE work_task_notifications ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE work_task_notifications ADD CONSTRAINT work_task_notifications_actor_attribution_check
  CHECK ((actor_type = 'user') = (actor_id IS NOT NULL));
ALTER TABLE work_task_notifications DROP CONSTRAINT IF EXISTS work_task_notifications_kind_check;
ALTER TABLE work_task_notifications ADD CONSTRAINT work_task_notifications_kind_check CHECK (kind IN (
  'task_assigned','task_claimed','handoff_requested','handoff_responded','review_requested','review_decided',
  'task_due_soon','task_overdue','task_blocked'
));

-- 消息事件同样要能记录"系统发布"，否则池消息署名系统而事件行仍必须挂一个真人。
ALTER TABLE work_message_events ADD COLUMN actor_type text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','system'));
ALTER TABLE work_message_events ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE work_message_events ADD CONSTRAINT work_message_events_actor_attribution_check
  CHECK ((actor_type = 'user') = (actor_id IS NOT NULL));

COMMIT;
