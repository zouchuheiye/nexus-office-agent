import { z } from "zod";
import { DOCUMENT_CATEGORIES, type DocumentCategory } from "@/src/modules/knowledge/domain/document";

/** 适用范围（E-161）：人 / 角色 / 项目 + 部门 / 岗位；后两者按"谁适用这份协议或标准"表达。 */
const applicability = {
  allowedUserIds: z.array(z.uuid()).max(500).optional(),
  allowedRoleCodes: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  projectIds: z.array(z.uuid()).max(100).optional(),
  allowedOrgUnitIds: z.array(z.uuid()).max(200).optional(),
  allowedPositionNames: z.array(z.string().trim().min(1).max(80)).max(200).optional(),
};

const effectivity = {
  effectiveAt: z.iso.datetime({ offset: true }).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
};

export const documentCategorySchema = z.enum(DOCUMENT_CATEGORIES as [DocumentCategory, ...DocumentCategory[]]);

export const publishDocumentSchema = z.object({
  documentId: z.uuid().optional(),
  title: z.string().trim().min(2).max(180),
  content: z.string().trim().min(1).max(200_000),
  classification: z.enum(["public","internal","confidential","restricted"]),
  category: documentCategorySchema.optional(),
  summary: z.string().trim().min(1).max(1000).optional(),
  ...applicability,
  agentIndexingAllowed: z.boolean().optional(),
  sourceRef: z.string().trim().max(500).optional(),
  ...effectivity,
}).superRefine((value, context) => {
  if (value.effectiveAt && value.expiresAt && Date.parse(value.expiresAt) <= Date.parse(value.effectiveAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "失效时间必须晚于生效时间" });
  }
});

/**
 * 文件型条目的元数据。字节走 multipart 表单，这里只校验伴随字段；
 * `file` 字段本身在路由里读出（`File`），并交给服务端做大小/类型/摘要校验。
 */
export const publishFileMetadataSchema = z.object({
  documentId: z.uuid().optional(),
  title: z.string().trim().min(2).max(180),
  category: documentCategorySchema,
  classification: z.enum(["public","internal","confidential","restricted"]),
  summary: z.string().trim().min(1).max(1000).optional(),
  agentIndexingAllowed: z.boolean().optional(),
  sourceRef: z.string().trim().max(500).optional(),
  ...effectivity,
  allowedUserIds: z.string().optional(),
  allowedRoleCodes: z.string().optional(),
  projectIds: z.string().optional(),
  allowedOrgUnitIds: z.string().optional(),
  allowedPositionNames: z.string().optional(),
}).superRefine((value, context) => {
  if (value.effectiveAt && value.expiresAt && Date.parse(value.expiresAt) <= Date.parse(value.effectiveAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "失效时间必须晚于生效时间" });
  }
});

/** multipart 表单里的数组用逗号/换行分隔（页面与 curl 都好写），服务端再去重。 */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(/[\s,，]+/).map((item) => item.trim()).filter(Boolean))];
}

export const listLibraryQuerySchema = z.object({
  category: documentCategorySchema.optional(),
  kind: z.enum(["text","file"]).optional(),
  keyword: z.string().trim().max(120).optional(),
  applicableOnly: z.enum(["true","false"]).optional(),
});
