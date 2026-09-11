import { publishFileMetadataSchema } from "@/src/modules/knowledge/application/file-schemas";

/** 文件上传的大小上限（与 `DEFAULT_FILE_LIMITS.maxBytes` 对齐；路由层先挡一次，避免把超大 body 读进内存）。 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type ParsedFileUpload = {
  metadata: ReturnType<typeof publishFileMetadataSchema.parse>;
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
};

/**
 * 解析 `multipart/form-data` 上传（E-161）。
 *
 * 三件事必须在这里做对：
 * 1. **先看 content-length 再读内存**：超限直接拒绝，不把大 body 拿出来；
 * 2. 文件字段名固定 `file`，缺失报 `DOCUMENT_FILE_REQUIRED`；
 * 3. 元数据用同一份 zod schema 校验（和文本发布共用密级/适用范围/生效期口径）。
 */
export async function parseFileUpload(request: Request): Promise<ParsedFileUpload> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + 64 * 1024) throw new Error("DOCUMENT_FILE_TOO_LARGE");
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new Error("DOCUMENT_FILE_REQUIRED");
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("DOCUMENT_FILE_TOO_LARGE");
  const metadata = publishFileMetadataSchema.parse({
    documentId: form.get("documentId")?.toString() || undefined,
    title: form.get("title")?.toString() ?? "",
    category: form.get("category")?.toString(),
    classification: form.get("classification")?.toString(),
    summary: form.get("summary")?.toString() || undefined,
    agentIndexingAllowed: form.get("agentIndexingAllowed") === null ? undefined : form.get("agentIndexingAllowed")?.toString() === "true",
    sourceRef: form.get("sourceRef")?.toString() || undefined,
    effectiveAt: form.get("effectiveAt")?.toString() || undefined,
    expiresAt: form.get("expiresAt")?.toString() || undefined,
    allowedUserIds: form.get("allowedUserIds")?.toString() || undefined,
    allowedRoleCodes: form.get("allowedRoleCodes")?.toString() || undefined,
    projectIds: form.get("projectIds")?.toString() || undefined,
    allowedOrgUnitIds: form.get("allowedOrgUnitIds")?.toString() || undefined,
    allowedPositionNames: form.get("allowedPositionNames")?.toString() || undefined,
  });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.byteLength) throw new Error("FILE_EMPTY");
  return {
    metadata,
    // 只取 basename，避免浏览器把相对路径带进来。
    fileName: (file.name || "upload").split(/[\\/]/).pop()!.slice(0, 255),
    mediaType: (file.type || "application/octet-stream").toLocaleLowerCase(),
    bytes,
  };
}
