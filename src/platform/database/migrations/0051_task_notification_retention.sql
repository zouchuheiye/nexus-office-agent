BEGIN;

-- P4（留存）：为「通知留存清理」补一条租户级时间索引。
-- 0049 已有的两条索引都带 recipient_id（服务「按人读通知」），而清理是按
-- (tenant_id, created_at) 全租户扫描的，没有可用索引就只能顺序扫全表。
CREATE INDEX idx_work_task_notifications_tenant_created ON work_task_notifications(tenant_id, created_at);

COMMIT;
