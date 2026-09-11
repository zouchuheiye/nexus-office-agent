BEGIN;

-- 回滚：删掉文件型文档的列与约束；纯文本行（content 非空）不受影响。
ALTER TABLE document_versions DROP CONSTRAINT IF EXISTS document_versions_payload_check;
DELETE FROM document_versions WHERE content IS NULL;
ALTER TABLE document_versions ALTER COLUMN content SET NOT NULL;
ALTER TABLE document_versions DROP COLUMN IF EXISTS storage_ref;
ALTER TABLE document_versions DROP COLUMN IF EXISTS size_bytes;
ALTER TABLE document_versions DROP COLUMN IF EXISTS media_type;
ALTER TABLE document_versions DROP COLUMN IF EXISTS file_name;

DROP INDEX IF EXISTS idx_documents_library;
DELETE FROM documents WHERE kind = 'file';
ALTER TABLE documents DROP COLUMN IF EXISTS summary;
ALTER TABLE documents DROP COLUMN IF EXISTS category;
ALTER TABLE documents DROP COLUMN IF EXISTS kind;

COMMIT;
