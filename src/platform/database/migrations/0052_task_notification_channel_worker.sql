BEGIN;

-- P4（外部通道）：新增独立 Worker 角色 notification-dispatch。
-- 它与 task-reminder 是不同关注点（外部投递要碰企业凭据与第三方限流），因此单独部署、单独节流。
ALTER TABLE worker_heartbeats DROP CONSTRAINT IF EXISTS worker_heartbeats_role_check;
ALTER TABLE worker_heartbeats ADD CONSTRAINT worker_heartbeats_role_check
  CHECK (role IN ('inbox','agent','outbox','pi-runner','pi-change-delivery','task-reminder','notification-dispatch'));

COMMIT;
