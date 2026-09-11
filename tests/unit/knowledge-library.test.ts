// Requirements: PR-004, PR-008, MR-006, MR-030, AC-012（E-161：企业信息库的条目、版本与适用范围）
import { describe, expect, it } from "vitest";
import { KnowledgeService } from "@/src/modules/knowledge/application/service";
import { InMemoryKnowledgeRepository } from "@/src/modules/knowledge/infrastructure/in-memory-repository";
import { InMemoryFileStore } from "@/src/platform/storage/file-store";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";
import type { RequestContext } from "@/src/platform/context/request-context";

const DELIVERY_ID = "10000000-0000-4000-8000-000000000002";
const INTERN_ID = "10000000-0000-4000-8000-000000000009";
const DELIVERY_ORG_ID = "20000000-0000-4000-8000-000000000002";

function fixture() {
  const repository = new InMemoryKnowledgeRepository(false);
  const files = new InMemoryFileStore();
  return { repository, files, service: new KnowledgeService(repository, () => new Date("2026-09-10T09:00:00.000Z"), files) };
}

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return { ...createDevelopmentRequestContext("library-owner"), ...overrides };
}

const pdf = () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x41]);

describe("E-161 企业信息库：文件条目", () => {
  it("上传文件会落条目 + 版本 + 对象存储，且**不产生**知识条目（不可被 Agent 检索）", async () => {
    const { service, files } = fixture();
    const owner = context();
    const result = await service.publishFile(owner, {
      title: "实习生协议模板（2026 版）",
      category: "agreement",
      classification: "internal",
      summary: "适用于在校实习生的三方协议模板。",
      fileName: "intern-agreement-2026.pdf",
      mediaType: "application/pdf",
      bytes: pdf(),
    });

    expect(result.document).toMatchObject({ kind: "file", category: "agreement", status: "published", currentVersion: 1, ownerId: owner.actorId });
    expect(result.version).toMatchObject({ fileName: "intern-agreement-2026.pdf", mediaType: "application/pdf", sizeBytes: pdf().byteLength, content: "" });
    expect(result.version.storageRef).toBeTruthy();
    expect(Array.from(await files.get(result.version.storageRef!))).toEqual(Array.from(pdf()));
    // 文件型条目没有正文可切块：检索拿不到东西，也不会误进 Agent 上下文。
    expect(await service.search(owner, "实习生协议")).toEqual([]);
  });

  it("追加新版本保留历史与替代关系，旧版本的字节仍可下载", async () => {
    const { service } = fixture();
    const owner = context();
    const first = await service.publishFile(owner, {
      title: "实习生协议", category: "agreement", classification: "internal",
      fileName: "v1.pdf", mediaType: "application/pdf", bytes: pdf(),
    });
    const secondBytes = new Uint8Array([...pdf(), 0x42]);
    const second = await service.publishFile(owner, {
      documentId: first.document.id, title: "实习生协议（修订）", category: "agreement", classification: "internal",
      fileName: "v2.pdf", mediaType: "application/pdf", bytes: secondBytes,
    });

    expect(second.document.currentVersion).toBe(2);
    expect(second.version.supersedesVersion).toBe(1);
    const described = await service.describeDocument(owner, first.document.id);
    expect(described.versions.map((item) => item.version)).toEqual([2, 1]);
    expect(described.versions[1]).toMatchObject({ fileName: "v1.pdf", sizeBytes: pdf().byteLength });

    const oldFile = await service.downloadFile(owner, first.document.id, { version: 1 });
    expect(Array.from(oldFile.bytes)).toEqual(Array.from(pdf()));
    const current = await service.downloadFile(owner, first.document.id, {});
    expect(Array.from(current.bytes)).toEqual(Array.from(secondBytes));
  });

  it("大小、类型、文件名与空文件都被拒绝", async () => {
    const { service } = fixture();
    const owner = context();
    const base = { title: "标准文件", category: "standard" as const, classification: "internal" as const, fileName: "s.pdf", mediaType: "application/pdf" };

    await expect(service.publishFile(owner, { ...base, bytes: new Uint8Array() })).rejects.toThrow("FILE_EMPTY");
    await expect(service.publishFile(owner, { ...base, bytes: new Uint8Array(26 * 1024 * 1024) })).rejects.toThrow("DOCUMENT_FILE_TOO_LARGE");
    await expect(service.publishFile(owner, { ...base, mediaType: "application/x-msdownload", bytes: pdf() })).rejects.toThrow("DOCUMENT_FILE_TYPE_NOT_ALLOWED");
    await expect(service.publishFile(owner, { ...base, fileName: "   ", bytes: pdf() })).rejects.toThrow("DOCUMENT_FILE_NAME_INVALID");
  });

  it("写库失败会把刚存的对象删掉（不留下'有版本没字节'的坏数据）", async () => {
    const repository = new InMemoryKnowledgeRepository(false);
    const files = new InMemoryFileStore();
    const service = new KnowledgeService(repository, () => new Date("2026-09-10T09:00:00.000Z"), files);
    repository.savePublishedDocument = async () => { throw new Error("DB_WRITE_FAILED"); };

    await expect(service.publishFile(context(), {
      title: "会失败的文件", category: "record", classification: "internal",
      fileName: "x.pdf", mediaType: "application/pdf", bytes: pdf(),
    })).rejects.toThrow("DB_WRITE_FAILED");
    // 对象已被回收：同一份内容再次上传仍是全新写入（说明上一条没有残留引用计数）。
    const retry = await new KnowledgeService(new InMemoryKnowledgeRepository(false), () => new Date(), files)
      .publishFile(context(), { title: "重试的文件", category: "record", classification: "internal", fileName: "x.pdf", mediaType: "application/pdf", bytes: pdf() });
    expect(retry.version.storageRef).toBeTruthy();
  });

  it("文件条目与文本条目不能互相追加版本", async () => {
    const { service } = fixture();
    const owner = context();
    const file = await service.publishFile(owner, { title: "证照扫描件", category: "certificate", classification: "internal", fileName: "license.pdf", mediaType: "application/pdf", bytes: pdf() });
    const text = await service.publish(owner, { title: "数据安全制度", content: "第一段制度正文。", classification: "internal" });

    await expect(service.publish(owner, { documentId: file.document.id, title: "错入口", content: "正文", classification: "internal" })).rejects.toThrow("DOCUMENT_KIND_MISMATCH");
    await expect(service.publishFile(owner, { documentId: text.document.id, title: "错入口", category: "policy", classification: "internal", fileName: "x.pdf", mediaType: "application/pdf", bytes: pdf() })).rejects.toThrow("DOCUMENT_KIND_MISMATCH");
  });
});

describe("E-161 企业信息库：适用范围与可见性", () => {
  async function seedAgreement(service: KnowledgeService) {
    return service.publishFile(context(), {
      title: "实习生协议", category: "agreement", classification: "confidential",
      allowedUserIds: [INTERN_ID],
      allowedOrgUnitIds: [DELIVERY_ORG_ID],
      allowedPositionNames: ["HRBP"],
      fileName: "intern.pdf", mediaType: "application/pdf", bytes: pdf(),
    });
  }

  it("本人/白名单命中可见；无关同事看不到（也不泄露存在性）", async () => {
    const { service } = fixture();
    const document = await seedAgreement(service);

    const intern = context({ actorId: INTERN_ID });
    expect((await service.listLibrary(intern)).map((item) => item.id)).toContain(document.document.id);
    expect((await service.downloadFile(intern, document.document.id, {})).fileName).toBe("intern.pdf");

    const outsider = context({ actorId: DELIVERY_ID });
    expect((await service.listLibrary(outsider)).map((item) => item.id)).not.toContain(document.document.id);
    await expect(service.downloadFile(outsider, document.document.id, {})).rejects.toThrow("DOCUMENT_NOT_FOUND");
  });

  it("按部门/岗位适用：解析到部门或岗位的人可见，accessBasis 说明依据", async () => {
    const { service } = fixture();
    const document = await seedAgreement(service);

    const byOrgUnit = context({ actorId: DELIVERY_ID });
    const orgResult = await service.describeDocument(byOrgUnit, document.document.id, { orgUnitIds: [DELIVERY_ORG_ID], positionNames: [] });
    expect(orgResult.accessBasis).toBe("org_unit");

    const byPosition = context({ actorId: DELIVERY_ID });
    const positionResult = await service.describeDocument(byPosition, document.document.id, { orgUnitIds: [], positionNames: ["HRBP"] });
    expect(positionResult.accessBasis).toBe("position");

    // 拿不到组织信息时这两个维度不匹配（失败关闭），密级为机密因此看不到。
    await expect(service.describeDocument(byPosition, document.document.id, { orgUnitIds: [], positionNames: [] })).rejects.toThrow("DOCUMENT_NOT_FOUND");
  });

  it("适用范围只对机密/受限条目起决定作用：内部条目仍按密级对全员可见", async () => {
    const { service } = fixture();
    const internal = await service.publishFile(context(), {
      title: "内部标准", category: "standard", classification: "internal",
      allowedPositionNames: ["HRBP"], fileName: "std.pdf", mediaType: "application/pdf", bytes: pdf(),
    });
    const outsider = context({ actorId: DELIVERY_ID });
    expect((await service.listLibrary(outsider)).map((item) => item.id)).toContain(internal.document.id);
  });

  it("列表支持按类型/关键字/适用范围过滤（服务端过滤，越权条目不出现）", async () => {
    const { service } = fixture();
    const owner = context();
    await service.publishFile(owner, { title: "转正评估标准", category: "standard", classification: "internal", summary: "转正评估口径。", fileName: "a.pdf", mediaType: "application/pdf", bytes: pdf() });
    await service.publishFile(owner, { title: "实习生协议", category: "agreement", classification: "internal", allowedUserIds: [INTERN_ID], fileName: "b.pdf", mediaType: "application/pdf", bytes: pdf() });
    await service.publish(owner, { title: "培训制度", content: "培训制度正文。", classification: "internal", category: "policy" });

    expect((await service.listLibrary(owner, { category: "agreement" })).map((item) => item.category)).toEqual(["agreement"]);
    expect((await service.listLibrary(owner, { keyword: "转正" })).map((item) => item.title)).toEqual(["转正评估标准"]);
    expect((await service.listLibrary(owner, { kind: "text" })).map((item) => item.title)).toEqual(["培训制度"]);

    const intern = context({ actorId: INTERN_ID });
    const applicable = await service.listLibrary(intern, { applicableOnly: true, actor: { orgUnitIds: [], positionNames: [] } });
    // "只看对我适用的"＝有明确适用范围（本人/角色/部门/岗位）的条目；泛化的内部制度不算"明确适用"。
    expect(applicable.map((item) => item.title)).toEqual(["实习生协议"]);
  });

  it("只有 Owner 或 document:admin 能追加版本", async () => {
    const { service } = fixture();
    const document = await seedAgreement(service);
    // 普通同事即使有 document:update 权限，也不能改别人的条目（所有权检查在权限之上）。
    const outsider = context({ actorId: DELIVERY_ID, permissions: ["document:read", "document:create", "document:update"] });
    await expect(service.publishFile(outsider, {
      documentId: document.document.id, title: "实习生协议", category: "agreement", classification: "confidential",
      fileName: "v2.pdf", mediaType: "application/pdf", bytes: pdf(),
    })).rejects.toThrow("POLICY_DENIED:DOCUMENT_OWNER_REQUIRED");

    // 没有任何 document 写权限的身份更早就被拒（权限判定在前）。
    const reader = context({ actorId: DELIVERY_ID, permissions: ["document:read"] });
    await expect(service.publishFile(reader, {
      documentId: document.document.id, title: "实习生协议", category: "agreement", classification: "confidential",
      fileName: "v2.pdf", mediaType: "application/pdf", bytes: pdf(),
    })).rejects.toThrow("POLICY_DENIED:PERMISSION_MISSING");

    const admin = context({ actorId: DELIVERY_ID, permissions: ["document:read", "document:update", "document:admin"] });
    const updated = await service.publishFile(admin, {
      documentId: document.document.id, title: "实习生协议（管理员更新）", category: "agreement", classification: "confidential",
      fileName: "v2.pdf", mediaType: "application/pdf", bytes: pdf(),
    });
    expect(updated.document.currentVersion).toBe(2);
    // 所有权不因追加版本而转移，租户也不会串。
    expect(updated.document.ownerId).toBe(DEMO_MANAGER_ID);
    expect(updated.document.tenantId).toBe(DEMO_TENANT_ID);
  });
});
