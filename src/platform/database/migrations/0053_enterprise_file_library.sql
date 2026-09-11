BEGIN;

-- 企业信息库（E-161）：让 documents 同时承载「文本知识」与「文件条目」。
--
-- 背景：005 迁移建的 documents/document_versions/knowledge_items 只存纯文本（content text），
-- 而企业真正要存放的东西大量是**文件**（实习生协议、转正材料、标准、表单、证照）。
-- 这里不新建一套并行表，而是给同一份"企业信息"底座加一个 kind 维度：
--   kind='text' → 正文落在 document_versions.content（现有语义不变，仍切块进 knowledge_items）
--   kind='file' → 正文为空，字节放在对象存储里，元数据（文件名/MIME/大小/storage_ref）落在版本行
-- 这样"知识检索"和"文件库"共用密级、适用范围、生效期、版本与替代关系，不产生第二套权限语义。

ALTER TABLE documents ADD COLUMN kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','file'));
ALTER TABLE documents ADD COLUMN category text NOT NULL DEFAULT 'policy' CHECK (category IN (
  'policy','standard','agreement','contract','template','form','certificate','record','other'
));
ALTER TABLE documents ADD COLUMN summary text CHECK (summary IS NULL OR length(btrim(summary)) BETWEEN 1 AND 1000);

CREATE INDEX idx_documents_library ON documents(tenant_id, category, status, updated_at DESC);

-- 文件型版本的字节不在库里，因此正文允许为空；但仍要求"要么有正文、要么有完整的文件元数据"。
ALTER TABLE document_versions ALTER COLUMN content DROP NOT NULL;
ALTER TABLE document_versions ADD COLUMN file_name text CHECK (file_name IS NULL OR length(btrim(file_name)) BETWEEN 1 AND 255);
ALTER TABLE document_versions ADD COLUMN media_type text CHECK (media_type IS NULL OR media_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$');
ALTER TABLE document_versions ADD COLUMN size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes > 0);
ALTER TABLE document_versions ADD COLUMN storage_ref text CHECK (storage_ref IS NULL OR (length(storage_ref) BETWEEN 8 AND 2000 AND storage_ref ~ '^local://'));
ALTER TABLE document_versions ADD CONSTRAINT document_versions_payload_check CHECK (
  content IS NOT NULL
  OR (storage_ref IS NOT NULL AND file_name IS NOT NULL AND media_type IS NOT NULL AND size_bytes IS NOT NULL)
);

COMMIT;
