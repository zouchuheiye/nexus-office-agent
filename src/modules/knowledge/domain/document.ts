export type DataClassification = "public" | "internal" | "confidential" | "restricted";

/** 企业信息库（E-161）：条目要么是纯文本知识，要么是一个文件。 */
export type DocumentKind = "text" | "file";

/** 文件/资料的业务分类：企业信息库的第一层目录。 */
export type DocumentCategory = "policy" | "standard" | "agreement" | "contract" | "template" | "form" | "certificate" | "record" | "other";

export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  policy: "制度办法",
  standard: "标准规范",
  agreement: "协议",
  contract: "合同",
  template: "模板",
  form: "表单",
  certificate: "证照",
  record: "记录归档",
  other: "其他",
};

export const DOCUMENT_CATEGORIES = Object.keys(DOCUMENT_CATEGORY_LABELS) as DocumentCategory[];

export type DocumentAccess = {
  ownerId: string;
  classification: DataClassification;
  allowedUserIds: string[];
  allowedRoleCodes: string[];
  projectIds: string[];
  /** 适用范围（E-161）：按部门/岗位表达"这份协议/标准对谁生效"，与白名单并列而不是替代它。 */
  allowedOrgUnitIds: string[];
  allowedPositionNames: string[];
  agentIndexingAllowed: boolean;
};

export type Document = {
  id: string;
  tenantId: string;
  title: string;
  ownerId: string;
  classification: DataClassification;
  status: "draft" | "published" | "archived";
  currentVersion: number;
  kind: DocumentKind;
  category: DocumentCategory;
  /** 一句话摘要：列表页看的东西，正文/文件内容不在这里。 */
  summary?: string;
  access: DocumentAccess;
  version: number;
};

export type DocumentVersion = {
  id: string;
  tenantId: string;
  documentId: string;
  version: number;
  /** 文本型条目的正文；文件型条目为空字符串（字节在对象存储里，见下）。 */
  content: string;
  contentDigest: string;
  sourceRef?: string;
  effectiveAt: string;
  expiresAt?: string;
  supersedesVersion?: number;
  publishedBy: string;
  publishedAt: string;
  /** 文件型版本的元数据；文本型为空。 */
  fileName?: string;
  mediaType?: string;
  sizeBytes?: number;
  storageRef?: string;
};

export type KnowledgeItem = {
  id: string;
  tenantId: string;
  documentId: string;
  documentVersion: number;
  chunkIndex: number;
  content: string;
  locator: string;
  permissionSnapshot: DocumentAccess;
  status: "active" | "invalidated";
  contentDigest: string;
};

export type KnowledgeCitation = {
  id: string;
  documentId: string;
  documentVersion: number;
  title: string;
  excerpt: string;
  locator: string;
  sourceRef?: string;
  effectiveAt: string;
  expiresAt?: string;
  classification: DataClassification;
  accessBasis: "owner" | "explicit_user" | "role" | "project" | "org_unit" | "position" | "classification";
  retrievedAt: string;
  untrustedContent: true;
};
