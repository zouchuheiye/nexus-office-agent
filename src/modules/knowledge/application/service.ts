import { createHash, randomUUID } from "node:crypto";
import { evaluateAccess } from "@/src/modules/authorization/domain/policy";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { FileObjectStore } from "@/src/platform/storage/file-store";
import type { KnowledgeRepository } from "@/src/modules/knowledge/application/contracts";
import type { Document, DocumentAccess, DocumentCategory, DocumentKind, DocumentVersion, KnowledgeCitation, KnowledgeItem } from "@/src/modules/knowledge/domain/document";

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function chunks(content: string): string[] {
  const paragraphs = content.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const output: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= 900) output.push(paragraph);
    else for (let offset = 0; offset < paragraph.length; offset += 850) output.push(paragraph.slice(offset, offset + 900));
  }
  return output.length ? output : [content.trim()];
}

/**
 * 文件型条目的可见范围（E-161）：由**调用方**解析当前主体的部门/岗位后传入。
 *
 * 为什么放在调用方：knowledge 模块不该知道组织架构怎么查（那是 organization 模块的事），
 * 也不该因为拿不到组织数据就放宽权限——拿不到时这两个维度按"不匹配"处理（失败关闭）。
 */
export type ActorApplicability = { orgUnitIds: string[]; positionNames: string[] };

/** 文件上传限制：单文件 25MB、常见企业文档/图片类型；两者都可由调用方覆盖（测试/企业策略）。 */
export const DEFAULT_FILE_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  allowedMediaTypes: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "text/markdown",
    "text/csv",
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/zip",
  ] as const,
};

function matchesApplicability(access: DocumentAccess, actor: ActorApplicability | undefined): { orgUnit: boolean; position: boolean } {
  return {
    orgUnit: Boolean(actor?.orgUnitIds.some((id) => access.allowedOrgUnitIds.includes(id))),
    position: Boolean(actor?.positionNames.some((name) => access.allowedPositionNames.includes(name))),
  };
}

function explicitlyAllowed(context: RequestContext, access: DocumentAccess, actor?: ActorApplicability): boolean {
  if (access.ownerId === context.actorId || access.allowedUserIds.includes(context.actorId)) return true;
  if (access.classification === "restricted") return false;
  if (access.allowedRoleCodes.some((role) => context.roles.includes(role))) return true;
  if (access.projectIds.some((projectId) => context.dataScopes.some((scope) => scope.type === "project" && scope.projectIds.includes(projectId)))) return true;
  const applicable = matchesApplicability(access, actor);
  return applicable.orgUnit || applicable.position;
}

function canRead(context: RequestContext, document: Document, forAgent: boolean, actor?: ActorApplicability): boolean {
  if (forAgent && !document.access.agentIndexingAllowed) return false;
  const policy = evaluateAccess({
    context,
    action: "read",
    resource: {
      tenantId: document.tenantId,
      type: "document",
      id: document.id,
      ownerId: document.ownerId,
      projectId: document.access.projectIds[0],
      classification: document.classification,
      state: document.status,
    },
  });
  if (!policy.allowed || document.status !== "published") return false;
  if (document.classification === "public" || document.classification === "internal") return true;
  return explicitlyAllowed(context, document.access, actor);
}

function accessBasis(context: RequestContext, document: Document, forAgent: boolean, actor?: ActorApplicability): KnowledgeCitation["accessBasis"] | null {
  if (!canRead(context, document, forAgent, actor)) return null;
  if (document.access.ownerId === context.actorId) return "owner";
  if (document.access.allowedUserIds.includes(context.actorId)) return "explicit_user";
  if (document.access.allowedRoleCodes.some((role) => context.roles.includes(role))) return "role";
  if (document.access.projectIds.some((projectId) => context.dataScopes.some((scope) => scope.type === "project" && scope.projectIds.includes(projectId)))) return "project";
  const applicable = matchesApplicability(document.access, actor);
  if (applicable.orgUnit) return "org_unit";
  if (applicable.position) return "position";
  return "classification";
}

function versionIsEffective(version: DocumentVersion, now: Date): boolean {
  const effectiveAt = Date.parse(version.effectiveAt);
  const expiresAt = version.expiresAt ? Date.parse(version.expiresAt) : undefined;
  return Number.isFinite(effectiveAt) && effectiveAt <= now.getTime()
    && (expiresAt === undefined || (Number.isFinite(expiresAt) && expiresAt > now.getTime()));
}

export class KnowledgeService {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly files?: FileObjectStore,
    private readonly fileLimits: { maxBytes: number; allowedMediaTypes: readonly string[] } = DEFAULT_FILE_LIMITS,
  ) {}

  async listDocuments(context: RequestContext, forAgent = false) {
    const documents = await this.repository.listPublishedDocuments(context.tenantId);
    return documents.filter((document) => canRead(context, document, forAgent));
  }

  /**
   * 企业信息库列表（E-161）：在"我能读的已发布条目"之上按类型/关键字/适用范围过滤。
   * 过滤放在服务端而不是前端，保证"看不到的条目根本不会出现在响应里"。
   */
  async listLibrary(context: RequestContext, options: { category?: DocumentCategory; keyword?: string; kind?: DocumentKind; applicableOnly?: boolean; actor?: ActorApplicability } = {}) {
    const readable = await this.listDocuments(context, false);
    const keyword = options.keyword?.trim().toLocaleLowerCase("zh-CN");
    return readable.filter((document) => {
      if (options.category && document.category !== options.category) return false;
      if (options.kind && document.kind !== options.kind) return false;
      if (options.applicableOnly) {
        const applicable = matchesApplicability(document.access, options.actor);
        const personal = document.access.allowedUserIds.includes(context.actorId) || document.ownerId === context.actorId;
        const byScope = applicable.orgUnit || applicable.position
          || document.access.allowedRoleCodes.some((role) => context.roles.includes(role));
        if (!personal && !byScope) return false;
      }
      if (!keyword) return true;
      const haystack = `${document.title} ${document.summary ?? ""} ${document.access.allowedPositionNames.join(" ")}`.toLocaleLowerCase("zh-CN");
      return haystack.includes(keyword);
    });
  }

  /** 条目详情：只要读得到，就能看到版本历史与适用范围（用于信息库详情页）。 */
  async describeDocument(context: RequestContext, documentId: string, actor?: ActorApplicability) {
    const document = await this.repository.getDocument(context.tenantId, documentId);
    if (!document) throw new Error("DOCUMENT_NOT_FOUND");
    const basis = accessBasis(context, document, false, actor);
    if (!basis) throw new Error("DOCUMENT_NOT_FOUND");
    const versions = await this.repository.listDocumentVersions(context.tenantId, documentId);
    return {
      document,
      accessBasis: basis,
      versions: versions.map((version) => ({
        version: version.version, effectiveAt: version.effectiveAt, expiresAt: version.expiresAt,
        publishedBy: version.publishedBy, publishedAt: version.publishedAt, sourceRef: version.sourceRef,
        fileName: version.fileName, mediaType: version.mediaType, sizeBytes: version.sizeBytes,
        contentDigest: version.contentDigest, supersedesVersion: version.supersedesVersion,
      })),
    };
  }

  /**
   * 文件型条目的下载（E-161）：先过同一套可见性判定，再从对象存储读字节，并**再次校验摘要**。
   * 越权与不存在都返回 `DOCUMENT_NOT_FOUND`，不泄露"存在但你没权限"。
   */
  async downloadFile(context: RequestContext, documentId: string, options: { version?: number; actor?: ActorApplicability } = {}) {
    const document = await this.repository.getDocument(context.tenantId, documentId);
    if (!document || !accessBasis(context, document, false, options.actor)) throw new Error("DOCUMENT_NOT_FOUND");
    if (!this.files) throw new Error("FILE_STORAGE_NOT_CONFIGURED");
    const versionNumber = options.version ?? document.currentVersion;
    const version = await this.repository.getDocumentVersion(context.tenantId, documentId, versionNumber);
    if (!version) throw new Error("DOCUMENT_NOT_FOUND");
    if (!version.storageRef || !version.fileName || !version.mediaType) throw new Error("DOCUMENT_FILE_UNAVAILABLE");
    const bytes = await this.files.get(version.storageRef);
    return { document, version, fileName: version.fileName, mediaType: version.mediaType, sizeBytes: bytes.byteLength, bytes, contentDigest: version.contentDigest };
  }

  /**
   * 文件型条目的发布/追加版本（E-161）。
   *
   * 顺序很重要：**先写对象存储拿引用，再写库；写库失败则尽力删除刚存的对象**——
   * 宁可留下"孤儿对象"（可由运维按摘要回收）也不能留下"库里有版本、字节却不存在"的坏数据。
   * 文件型条目**不产生知识条目**：它没有正文可切块，也就不会被 Agent 检索到（将来做文本抽取再补）。
   */
  async publishFile(context: RequestContext, input: {
    documentId?: string;
    title: string;
    category: DocumentCategory;
    classification: Document["classification"];
    summary?: string;
    allowedUserIds?: string[];
    allowedRoleCodes?: string[];
    projectIds?: string[];
    allowedOrgUnitIds?: string[];
    allowedPositionNames?: string[];
    agentIndexingAllowed?: boolean;
    sourceRef?: string;
    effectiveAt?: string;
    expiresAt?: string;
    fileName: string;
    mediaType: string;
    bytes: Uint8Array;
  }): Promise<{ document: Document; version: DocumentVersion }> {
    if (!this.files) throw new Error("FILE_STORAGE_NOT_CONFIGURED");
    this.assertFileAllowed(input);
    const current = input.documentId ? await this.repository.getDocument(context.tenantId, input.documentId) : null;
    if (input.documentId && !current) throw new Error("DOCUMENT_NOT_FOUND");
    if (current && current.kind !== "file") throw new Error("DOCUMENT_KIND_MISMATCH");
    this.assertCanWrite(context, current);
    const { effectiveAt, expiresAt } = this.resolveEffectivity(input);
    const publishedAt = this.now();
    const nextVersion = (current?.currentVersion ?? 0) + 1;
    const stored = await this.files.put({ tenantId: context.tenantId, bytes: input.bytes });
    const access: DocumentAccess = {
      ownerId: current?.ownerId ?? context.actorId,
      classification: input.classification,
      allowedUserIds: [...new Set(input.allowedUserIds ?? [])],
      allowedRoleCodes: [...new Set(input.allowedRoleCodes ?? [])],
      projectIds: [...new Set(input.projectIds ?? [])],
      allowedOrgUnitIds: [...new Set(input.allowedOrgUnitIds ?? [])],
      allowedPositionNames: [...new Set(input.allowedPositionNames ?? [])],
      agentIndexingAllowed: input.agentIndexingAllowed ?? false,
    };
    const document: Document = current ? {
      ...current, title: input.title, classification: input.classification, category: input.category,
      summary: input.summary?.trim() || current.summary, status: "published",
      currentVersion: nextVersion, access, version: current.version + 1,
    } : {
      id: randomUUID(), tenantId: context.tenantId, title: input.title, ownerId: context.actorId,
      classification: input.classification, status: "published", currentVersion: nextVersion,
      kind: "file", category: input.category, summary: input.summary?.trim() || undefined, access, version: 1,
    };
    const version: DocumentVersion = {
      id: randomUUID(), tenantId: context.tenantId, documentId: document.id, version: nextVersion,
      content: "", contentDigest: stored.contentDigest, sourceRef: input.sourceRef,
      effectiveAt: effectiveAt.toISOString(), expiresAt: expiresAt?.toISOString(),
      supersedesVersion: current?.currentVersion, publishedBy: context.actorId, publishedAt: publishedAt.toISOString(),
      fileName: input.fileName, mediaType: input.mediaType, sizeBytes: stored.sizeBytes, storageRef: stored.storageRef,
    };
    try {
      await this.repository.savePublishedDocument(document, version, []);
    } catch (error) {
      await this.files.delete(stored.storageRef).catch(() => undefined);
      throw error;
    }
    return { document, version };
  }

  private assertFileAllowed(input: { fileName: string; mediaType: string; bytes: Uint8Array }) {
    if (!input.fileName.trim() || input.fileName.length > 255) throw new Error("DOCUMENT_FILE_NAME_INVALID");
    if (!input.bytes.byteLength) throw new Error("FILE_EMPTY");
    if (input.bytes.byteLength > this.fileLimits.maxBytes) throw new Error("DOCUMENT_FILE_TOO_LARGE");
    const mediaType = input.mediaType.trim().toLocaleLowerCase();
    if (!this.fileLimits.allowedMediaTypes.includes(mediaType)) throw new Error("DOCUMENT_FILE_TYPE_NOT_ALLOWED");
  }

  private assertCanWrite(context: RequestContext, current: Document | null) {
    const policy = evaluateAccess({
      context, action: current ? "update" : "create",
      resource: { tenantId: context.tenantId, type: "document", id: current?.id ?? "new", ownerId: current?.ownerId ?? context.actorId },
    });
    if (!policy.allowed) throw new Error(`POLICY_DENIED:${policy.reason}`);
    if (current && current.ownerId !== context.actorId && !context.permissions.includes("document:admin") && !context.permissions.includes("*")) {
      throw new Error("POLICY_DENIED:DOCUMENT_OWNER_REQUIRED");
    }
  }

  private resolveEffectivity(input: { effectiveAt?: string; expiresAt?: string }) {
    const publishedAt = this.now();
    const effectiveAt = input.effectiveAt ? new Date(input.effectiveAt) : publishedAt;
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : undefined;
    if (Number.isNaN(effectiveAt.getTime())) throw new Error("DOCUMENT_EFFECTIVE_TIME_INVALID");
    if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt <= effectiveAt)) throw new Error("DOCUMENT_EXPIRY_INVALID");
    return { effectiveAt, expiresAt };
  }

  async publish(context: RequestContext, input: {
    documentId?: string;
    title: string;
    content: string;
    classification: Document["classification"];
    category?: DocumentCategory;
    summary?: string;
    allowedUserIds?: string[];
    allowedRoleCodes?: string[];
    projectIds?: string[];
    allowedOrgUnitIds?: string[];
    allowedPositionNames?: string[];
    agentIndexingAllowed?: boolean;
    sourceRef?: string;
    effectiveAt?: string;
    expiresAt?: string;
  }): Promise<{ document: Document; version: DocumentVersion; itemCount: number }> {
    if (!input.content.trim()) throw new Error("DOCUMENT_CONTENT_REQUIRED");
    const current = input.documentId ? await this.repository.getDocument(context.tenantId, input.documentId) : null;
    if (input.documentId && !current) throw new Error("DOCUMENT_NOT_FOUND");
    if (current && current.kind !== "text") throw new Error("DOCUMENT_KIND_MISMATCH");
    this.assertCanWrite(context, current);
    const publishedAt = this.now();
    const { effectiveAt, expiresAt } = this.resolveEffectivity(input);
    const nextVersion = (current?.currentVersion ?? 0) + 1;
    const access: DocumentAccess = {
      ownerId: current?.ownerId ?? context.actorId,
      classification: input.classification,
      allowedUserIds: [...new Set(input.allowedUserIds ?? [])],
      allowedRoleCodes: [...new Set(input.allowedRoleCodes ?? [])],
      projectIds: [...new Set(input.projectIds ?? [])],
      allowedOrgUnitIds: [...new Set(input.allowedOrgUnitIds ?? current?.access.allowedOrgUnitIds ?? [])],
      allowedPositionNames: [...new Set(input.allowedPositionNames ?? current?.access.allowedPositionNames ?? [])],
      agentIndexingAllowed: input.agentIndexingAllowed ?? input.classification !== "restricted",
    };
    const document: Document = current ? {
      ...current, title: input.title, classification: input.classification,
      category: input.category ?? current.category, summary: input.summary?.trim() || current.summary, status: "published",
      currentVersion: nextVersion, access, version: current.version + 1,
    } : {
      id: randomUUID(), tenantId: context.tenantId, title: input.title, ownerId: context.actorId,
      classification: input.classification, status: "published", currentVersion: nextVersion,
      kind: "text", category: input.category ?? "policy", summary: input.summary?.trim() || undefined, access, version: 1,
    };
    const content = input.content.trim();
    const version: DocumentVersion = {
      id: randomUUID(), tenantId: context.tenantId, documentId: document.id, version: nextVersion,
      content, contentDigest: digest(content), sourceRef: input.sourceRef,
      effectiveAt: effectiveAt.toISOString(), expiresAt: expiresAt?.toISOString(),
      supersedesVersion: current?.currentVersion, publishedBy: context.actorId, publishedAt: publishedAt.toISOString(),
    };
    const items: KnowledgeItem[] = chunks(content).map((chunk, index) => ({
      id: randomUUID(), tenantId: context.tenantId, documentId: document.id, documentVersion: nextVersion,
      chunkIndex: index, content: chunk, locator: `paragraph:${index + 1}`, permissionSnapshot: structuredClone(access),
      status: "active", contentDigest: digest(chunk),
    }));
    await this.repository.savePublishedDocument(document, version, items);
    return { document, version, itemCount: items.length };
  }

  async search(context: RequestContext, query: string, options: { forAgent?: boolean; limit?: number; actor?: ActorApplicability } = {}): Promise<KnowledgeCitation[]> {
    const normalized = query.trim();
    if (!normalized) throw new Error("KNOWLEDGE_QUERY_REQUIRED");
    const forAgent = options.forAgent ?? true;
    const now = this.now();
    const heads = await this.repository.listPublishedDocuments(context.tenantId);
    const preflightVersions = new Map<string, DocumentVersion>();
    const allowedIds: string[] = [];
    for (const document of heads) {
      if (!accessBasis(context, document, forAgent, options.actor)) continue;
      const version = await this.repository.getDocumentVersion(context.tenantId, document.id, document.currentVersion);
      if (!version || !versionIsEffective(version, now)) continue;
      preflightVersions.set(document.id, version);
      allowedIds.push(document.id);
    }
    if (allowedIds.length === 0) return [];
    const candidates = await this.repository.searchCandidates(context.tenantId, normalized, allowedIds, Math.min(options.limit ?? 8, 20));
    const documents = new Map(heads.map((document) => [document.id, document]));
    const retrievedAt = now.toISOString();
    const citations: KnowledgeCitation[] = [];
    for (const item of candidates) {
      const latest = await this.repository.getDocument(context.tenantId, item.documentId);
      const prefiltered = documents.get(item.documentId);
      const preflightVersion = preflightVersions.get(item.documentId);
      if (!latest || !prefiltered || !preflightVersion || latest.version !== prefiltered.version) continue;
      const latestVersion = await this.repository.getDocumentVersion(context.tenantId, latest.id, latest.currentVersion);
      const basis = accessBasis(context, latest, forAgent, options.actor);
      if (!basis || !latestVersion || !versionIsEffective(latestVersion, now)) continue;
      if (latestVersion.id !== preflightVersion.id || latest.currentVersion !== item.documentVersion || item.status !== "active") continue;
      citations.push({
        id: item.id, documentId: item.documentId, documentVersion: item.documentVersion,
        title: latest.title, excerpt: item.content.slice(0, 320), locator: item.locator,
        sourceRef: latestVersion.sourceRef, effectiveAt: latestVersion.effectiveAt, expiresAt: latestVersion.expiresAt,
        classification: latest.classification, accessBasis: basis, retrievedAt, untrustedContent: true,
      });
    }
    return citations;
  }

  /** 只读版本历史（供任务/会议引用场景）；信息库详情页请用 `describeDocument`。 */
  async versions(context: RequestContext, documentId: string, actor?: ActorApplicability) {
    const document = await this.repository.getDocument(context.tenantId, documentId);
    if (!document || !accessBasis(context, document, false, actor)) throw new Error("DOCUMENT_NOT_FOUND");
    return this.repository.listDocumentVersions(context.tenantId, documentId);
  }
}
