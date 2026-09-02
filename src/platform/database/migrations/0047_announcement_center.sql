BEGIN;
ALTER TABLE work_pool_messages ADD COLUMN kind text NOT NULL DEFAULT 'notice' CHECK (kind IN ('announcement','notice'));
CREATE INDEX idx_work_pool_messages_kind ON work_pool_messages(tenant_id, kind, created_at DESC);
COMMIT;
