// Requirements: PR-010, MR-046, MR-049, AC-012（P4：外部通道的持久化适配）
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelPreferenceService, InMemoryChannelPreferenceRepository } from "@/src/modules/integration/application/channel-preferences";
import { PostgresChannelPreferenceDirectory, PostgresChannelPreferenceRepository, PostgresChannelRecipientDirectory, PostgresTaskNotificationChannelSource } from "@/src/modules/integration/infrastructure/postgres-task-notification-channel";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

const MEMBER_ID = "10000000-0000-4000-8000-000000000003";
const OTHER_TENANT_ID = "00000000-0000-4000-8000-0000000000ff";
const ACTIVE_CONNECTION = "90000000-0000-4000-8000-000000000001";
const PAUSED_CONNECTION = "90000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-09-10T09:00:00.000Z");
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
];

describe("Postgres 外部通道适配", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;
  let conversationId: string;

  beforeEach(async () => {
    database = new PGlite();
    for (const file of MIGRATIONS) await database.exec(await readFile(path.resolve("src/platform/database/migrations", file), "utf8"));
    const executor: DatabaseExecutor = { async query<T extends Record<string, unknown>>(sql: string, params: SqlPrimitive[] = []) { return (await database.query<T>(sql, params as never[])).rows; } };
    adapter = {
      ...executor,
      async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) {
        await database.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]);
        return work(executor);
      },
      async close() { await database.close(); },
    };
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'demo','Demo','active'),($2,'other','Other','active')", [DEMO_TENANT_ID, OTHER_TENANT_ID]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [DEMO_TENANT_ID]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Manager','manager@example.test','active'),($3,$2,'Product','product@example.test','active')", [DEMO_MANAGER_ID, DEMO_TENANT_ID, MEMBER_ID]);
    // 一条 active 连接（可投递）+ 一条 suspended 连接（不可投递）。
    await database.query(
      `INSERT INTO connections(id,tenant_id,provider,name,status,secret_ref) VALUES
        ($1,$3,'wecom','企业微信（在用）','active','secret://wecom'),
        ($2,$3,'wecom','企业微信（停用）','suspended','secret://wecom-paused')`,
      [ACTIVE_CONNECTION, PAUSED_CONNECTION, DEMO_TENANT_ID],
    );
    // 会话在 (tenant, owner, active) 上唯一，因此整个用例共用一条。
    conversationId = randomUUID();
    await database.query(
      "INSERT INTO work_conversations(id,tenant_id,owner_id,title,status,version,created_at,updated_at) VALUES($1,$2,$3,'通道验证','active',1,$4,$4)",
      [conversationId, DEMO_TENANT_ID, DEMO_MANAGER_ID, "2026-09-10T00:00:00.000Z"],
    );
  });

  afterEach(async () => { await database.close(); });

  async function seedIdentity(connectionId: string, status: "verified" | "candidate") {
    await database.query(
      `INSERT INTO external_identities(id,tenant_id,connection_id,provider,subject_type,external_subject_id,internal_subject_type,internal_subject_id,status,verified_at)
       VALUES($1,$2,$3,'wecom','user',$4,'user',$5,$6,now())`,
      [randomUUID(), DEMO_TENANT_ID, connectionId, `external-${randomUUID().slice(0, 8)}`, MEMBER_ID, status],
    );
  }

  async function seedNotification(createdAt: string) {
    const missionId = randomUUID();
    await database.query(
      `INSERT INTO work_missions(id,tenant_id,conversation_id,title,objective,priority,due_at,published_by,source,status,created_at,updated_at)
       VALUES($1,$2,$3,'通道验证','验证外部通道适配。','medium',$4,$5,'human','active',$6,$6)`,
      [missionId, DEMO_TENANT_ID, conversationId, new Date(NOW.getTime() + 20 * 86_400_000).toISOString(), DEMO_MANAGER_ID, createdAt],
    );
    const packageId = randomUUID();
    await database.query(
      `INSERT INTO work_packages(id,tenant_id,mission_id,ordinal,title,description,acceptance_criteria,required_skills,assignment_mode,assignee_id,priority,due_at,capacity_points,published_by,status,is_template,evidence_refs,missing_fields,version,created_at,updated_at)
       VALUES($1,$2,$3,1,'通道验证包','验证外部通道。','有记录。','[]','direct',$4,'medium',$5,1,$6,'in_progress',false,'[]','[]',1,$7,$7)`,
      [packageId, DEMO_TENANT_ID, missionId, MEMBER_ID, new Date(NOW.getTime() + 20 * 86_400_000).toISOString(), DEMO_MANAGER_ID, createdAt],
    );
    const notificationId = randomUUID();
    await database.query(
      `INSERT INTO work_task_notifications(id,tenant_id,recipient_id,actor_type,actor_id,kind,title,body,ref_type,ref_id,package_id,source_event_id,created_at,read_at)
       VALUES($1,$2,$3,'system',NULL,'task_due_soon','任务临期：通道验证包','约 1.0 天后到期。','work_package',$4,$4,$5,$6,NULL)`,
      [notificationId, DEMO_TENANT_ID, MEMBER_ID, packageId, randomUUID(), createdAt],
    );
    return notificationId;
  }

  it("候选来源只取窗口内的通知，并按创建时间升序、受批量上限约束", async () => {
    const fresh = await seedNotification("2026-09-10T08:30:00.000Z");
    const older = await seedNotification("2026-09-10T05:00:00.000Z");
    const source = new PostgresTaskNotificationChannelSource(adapter);

    const inWindow = await source.listRecent({ tenantId: DEMO_TENANT_ID, sinceIso: "2026-09-10T08:00:00.000Z", limit: 10 });
    expect(inWindow.map((item) => item.id)).toEqual([fresh]);
    expect(inWindow[0]).toMatchObject({ recipientId: MEMBER_ID, kind: "task_due_soon", title: "任务临期：通道验证包" });

    const wide = await source.listRecent({ tenantId: DEMO_TENANT_ID, sinceIso: "2026-09-10T00:00:00.000Z", limit: 10 });
    expect(wide.map((item) => item.id)).toEqual([older, fresh]);
    expect(await source.listRecent({ tenantId: DEMO_TENANT_ID, sinceIso: "2026-09-10T00:00:00.000Z", limit: 1 })).toHaveLength(1);
  });

  it("收件人通道只认「身份已验证 + 连接 active」的绑定", async () => {
    await seedIdentity(ACTIVE_CONNECTION, "verified");
    await seedIdentity(ACTIVE_CONNECTION, "candidate");
    await seedIdentity(PAUSED_CONNECTION, "verified");
    const directory = new PostgresChannelRecipientDirectory(adapter);

    const resolved = await directory.resolve(DEMO_TENANT_ID, [MEMBER_ID, DEMO_MANAGER_ID]);
    expect(resolved.get(MEMBER_ID)).toHaveLength(1);
    expect(resolved.get(MEMBER_ID)![0]).toMatchObject({ provider: "wecom", connectionId: ACTIVE_CONNECTION });
    expect(resolved.get(DEMO_MANAGER_ID)).toBeUndefined();
  });

  it("偏好往返一致，且外部通道投递读到的就是用户写进去的那份", async () => {
    const repository = new PostgresChannelPreferenceRepository(adapter);
    const service = new ChannelPreferenceService(repository);
    const context = { ...createDevelopmentRequestContext("channel-preference-postgres"), actorId: MEMBER_ID };

    expect((await service.get(context)).configured).toBe(false);
    await service.update(context, { orderedProviders: ["wecom", "web"], quietHours: { start: "22:00", end: "07:00", timezoneOffsetMinutes: 480 } });

    const view = await service.get(context);
    expect(view).toMatchObject({ configured: true, orderedProviders: ["wecom", "web"] });
    expect(view.quietHours).toEqual({ start: "22:00", end: "07:00", timezoneOffsetMinutes: 480 });

    const directory = new PostgresChannelPreferenceDirectory(adapter);
    const listed = await directory.list(DEMO_TENANT_ID, [MEMBER_ID]);
    expect(listed.get(MEMBER_ID)).toMatchObject({ userId: MEMBER_ID, orderedProviders: ["wecom", "web"], digestEnabled: true });
    // 覆盖写：第二次 PUT 更新同一行而不是插新行。
    await service.update(context, { orderedProviders: ["web"], quietHours: null, digestEnabled: false });
    const overwritten = await database.query<{ count: number; digest_enabled: boolean }>(
      "SELECT count(*)::int AS count, max(digest_enabled::int)::boolean AS digest_enabled FROM channel_preferences WHERE tenant_id=$1 AND user_id=$2",
      [DEMO_TENANT_ID, MEMBER_ID],
    );
    expect(Number(overwritten.rows[0].count)).toBe(1);
    expect(overwritten.rows[0].digest_enabled).toBe(false);
  });

  it("内存偏好仓储与 Postgres 同语义（开发模式无需数据库）", async () => {
    const service = new ChannelPreferenceService(new InMemoryChannelPreferenceRepository());
    const context = { ...createDevelopmentRequestContext("channel-preference-memory"), actorId: MEMBER_ID };
    await service.update(context, { orderedProviders: ["dingtalk"] });
    expect((await service.get(context)).orderedProviders).toEqual(["dingtalk"]);
  });
});
