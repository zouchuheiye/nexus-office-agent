// Requirements: PR-004, MR-006, AC-012（E-161：企业信息库的持久化路径 + 0053 迁移）
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeService } from "@/src/modules/knowledge/application/service";
import { PostgresKnowledgeRepository } from "@/src/modules/knowledge/infrastructure/postgres-repository";
import { InMemoryFileStore } from "@/src/platform/storage/file-store";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

const DELIVERY_ORG_ID = "20000000-0000-4000-8000-000000000002";
const MIGRATIONS = [
  "0001_foundation.sql", "0002_management_loop.sql", "0003_agent_platform.sql", "0004_connector_platform.sql",
  "0005_workflow_knowledge.sql", "0006_strategy_organization_talent.sql", "0007_client_platform.sql",
  "0008_security_hardening.sql", "0009_atomic_audit.sql", "0010_immutable_audit.sql", "0011_enterprise_governance.sql",
  "0012_enterprise_acceptance.sql", "0013_connector_test_notifications.sql", "0014_durable_runtime.sql",
  "0015_agent_job_control.sql", "0016_management_intelligence.sql", "0017_work_command_center.sql",
  "0018_work_message_pools.sql", "0019_work_task_handoffs.sql", "0023_work_artifact_evidence_chain.sql",
  "0043_work_task_templates.sql", "0045_work_task_progress_tracking.sql", "0046_work_task_handoff_card.sql",
  "0047_announcement_center.sql", "0048_work_package_subtasks.sql", "0049_work_task_notifications.sql",
  "0050_task_reminder_scheduler.sql", "0051_task_notification_retention.sql", "0052_task_notification_channel_worker.sql",
  "0053_enterprise_file_library.sql",
];

const pdf = () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x42]);

describe("Postgres 企业信息库（E-161）", () => {
  let database: PGlite;
  let service: KnowledgeService;
  let files: InMemoryFileStore;

  beforeEach(async () => {
    database = new PGlite();
    for (const file of MIGRATIONS) await database.exec(await readFile(path.resolve("src/platform/database/migrations", file), "utf8"));
    const executor: DatabaseExecutor = { async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) { return (await database.query<T>(sql, params as never[])).rows; } };
    const adapter: TransactionalDatabase = {
      ...executor,
      async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) {
        await database.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]);
        return work(executor);
      },
      async close() { await database.close(); },
    };
    files = new InMemoryFileStore();
    service = new KnowledgeService(new PostgresKnowledgeRepository(adapter), () => new Date("2026-09-10T09:00:00.000Z"), files);
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'demo','Demo','active')", [DEMO_TENANT_ID]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [DEMO_TENANT_ID]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Manager','manager@example.test','active')", [DEMO_MANAGER_ID, DEMO_TENANT_ID]);
  });

  afterEach(async () => { await database.close(); });

  it("迁移 0053 生效：kind/category/summary 落库，文件型版本的正文为空、文件元数据完整", async () => {
    const owner = createDevelopmentRequestContext("library-postgres");
    const published = await service.publishFile(owner, {
      title: "实习生协议（2026）",
      category: "agreement",
      classification: "confidential",
      summary: "三方实习协议，适用于在校实习生。",
      allowedOrgUnitIds: [DELIVERY_ORG_ID],
      allowedPositionNames: ["HRBP"],
      fileName: "intern-2026.pdf",
      mediaType: "application/pdf",
      bytes: pdf(),
    });

    const documentRow = (await database.query<{ kind: string; category: string; summary: string | null; access_policy: Record<string, unknown>; current_version: number }>(
      "SELECT kind,category,summary,access_policy,current_version FROM documents WHERE id=$1", [published.document.id],
    )).rows[0];
    expect(documentRow).toMatchObject({ kind: "file", category: "agreement", summary: "三方实习协议，适用于在校实习生。", current_version: 1 });
    expect(documentRow.access_policy).toMatchObject({ allowedOrgUnitIds: [DELIVERY_ORG_ID], allowedPositionNames: ["HRBP"] });

    const versionRow = (await database.query<{ content: string | null; file_name: string; media_type: string; size_bytes: string; storage_ref: string; content_digest: string }>(
      "SELECT content,file_name,media_type,size_bytes,storage_ref,content_digest FROM document_versions WHERE document_id=$1 AND version=1", [published.document.id],
    )).rows[0];
    expect(versionRow.content).toBeNull();
    expect(versionRow.file_name).toBe("intern-2026.pdf");
    expect(versionRow.media_type).toBe("application/pdf");
    expect(Number(versionRow.size_bytes)).toBe(pdf().byteLength);
    expect(versionRow.storage_ref).toMatch(/^local:\/\//);
    expect(versionRow.content_digest).toBe(published.version.contentDigest);

    // 文件型条目没有可切块的正文：不产生知识条目（也就不会被 Agent 检索到）。
    const items = (await database.query<{ count: number }>("SELECT count(*)::int AS count FROM knowledge_items WHERE document_id=$1", [published.document.id])).rows[0];
    expect(Number(items.count)).toBe(0);

    // 读回：可见性、适用范围与版本元数据都要完整（老的行内 jsonb 结构由 mapAccess 兜底）。
    const described = await service.describeDocument(owner, published.document.id, { orgUnitIds: [DELIVERY_ORG_ID], positionNames: [] });
    expect(described.accessBasis).toBe("owner");
    expect(described.versions[0]).toMatchObject({ version: 1, fileName: "intern-2026.pdf", sizeBytes: pdf().byteLength });
    const downloaded = await service.downloadFile(owner, published.document.id, {});
    expect(Array.from(downloaded.bytes)).toEqual(Array.from(pdf()));
  });

  it("文本型条目仍然切块进 knowledge_items（文件与文本共用一份底座）", async () => {
    const owner = createDevelopmentRequestContext("library-postgres-text");
    const published = await service.publish(owner, {
      title: "数据安全分级制度", content: "第一段制度。\n\n第二段制度。", classification: "internal", category: "policy", summary: "分级与导出要求。",
    });
    const head = (await database.query<{ kind: string; category: string }>("SELECT kind,category FROM documents WHERE id=$1", [published.document.id])).rows[0];
    expect(head).toMatchObject({ kind: "text", category: "policy" });
    const items = (await database.query<{ count: number }>("SELECT count(*)::int AS count FROM knowledge_items WHERE document_id=$1 AND status='active'", [published.document.id])).rows[0];
    expect(Number(items.count)).toBe(2);
    expect((await service.search(owner, "制度")).length).toBeGreaterThan(0);
  });

  it("数据库约束兜底：既没有正文也没有文件元数据的版本行写不进去", async () => {
    const owner = createDevelopmentRequestContext("library-postgres-check");
    const published = await service.publishFile(owner, {
      title: "标准规范", category: "standard", classification: "internal",
      fileName: "std.pdf", mediaType: "application/pdf", bytes: pdf(),
    });
    await expect(database.query(
      `INSERT INTO document_versions(id,tenant_id,document_id,version,content,content_digest,effective_at,published_by,published_at)
       VALUES($1,$2,$3,2,NULL,$4,now(),$5,now())`,
      ["99999999-9999-4999-8999-999999999999", DEMO_TENANT_ID, published.document.id, "a".repeat(64), DEMO_MANAGER_ID],
    )).rejects.toThrow(/document_versions_payload_check/);

    // 允许的两种形态：有正文，或有完整的文件元数据。
    await database.query(
      `INSERT INTO document_versions(id,tenant_id,document_id,version,content,content_digest,effective_at,published_by,published_at)
       VALUES($1,$2,$3,3,'补一份正文',$4,now(),$5,now())`,
      ["99999999-9999-4999-8999-999999999998", DEMO_TENANT_ID, published.document.id, "b".repeat(64), DEMO_MANAGER_ID],
    );
    const rows = (await database.query<{ count: number }>("SELECT count(*)::int AS count FROM document_versions WHERE document_id=$1", [published.document.id])).rows[0];
    expect(Number(rows.count)).toBe(2);
  });
});
