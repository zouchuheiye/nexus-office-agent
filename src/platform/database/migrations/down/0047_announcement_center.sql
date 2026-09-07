BEGIN;
DROP INDEX IF EXISTS idx_work_pool_messages_kind;
ALTER TABLE work_pool_messages DROP COLUMN IF EXISTS kind;
COMMIT;
