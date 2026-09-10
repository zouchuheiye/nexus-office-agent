// Requirements: PR-009, PR-010, MR-046, MR-047, MR-048, AC-012, AC-013（P4：提醒常驻调度的持久化与系统署名）
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskCommandService } from "@/src/modules/task-command/application/service";
import { PostgresTaskCommandRepository } from "@/src/modules/task-command/infrastructure/postgres-repository";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

const MEMBER_ID = "10000000-0000-4000-8000-000000000003";
const MIGRATIONS = [
  "0001_foundation.sql", "0002_management_loop.sql", "0003_agent_platform.sql", "0004_connector_platform.sql",
  "0005_workflow_knowledge.sql", "0006_strategy_organization_talent.sql", "0007_client_platform.sql",
  "0008_security_hardening.sql", "0009_atomic_audit.sql", "0010_immutable_audit.sql", "0011_enterprise_governance.sql",
  "0012_enterprise_acceptance.sql", "0013_connector_test_notifications.sql", "0014_durable_runtime.sql",
  "0015_agent_job_control.sql", "0016_management_intelligence.sql", "0017_work_command_center.sql",
  "0018_work_message_pools.sql", "0019_work_task_handoffs.sql", "0023_work_artifact_evidence_chain.sql",
  "0043_work_task_templates.sql", "0045_work_task_progress_tracking.sql", "0046_work_task_handoff_card.sql",
  "0047_announcement_center.sql", "0048_work_package_subtasks.sql", "0049_work_task_notifications.sql",
  "0050_task_reminder_scheduler.sql",
];

describe("Postgres 定时提醒调度", () => {
  let database: PGlite;
  let service: TaskCommandService;

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
    service = new TaskCommandService(new PostgresTaskCommandRepository(adapter));
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'demo','Demo','active')", [DEMO_TENANT_ID]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [DEMO_TENANT_ID]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Manager','manager@example.test','active'),($3,$2,'Product','product@example.test','active')", [DEMO_MANAGER_ID, DEMO_TENANT_ID, MEMBER_ID]);
  });

  afterEach(async () => { await database.close(); });

  it("以系统署名落库：池消息与通知的 actor/author 为空、类型为 system，且重复扫描幂等", async () => {
    const publisher = createDevelopmentRequestContext("postgres-reminder");
    const conversation = (await service.workspace(publisher)).conversation;
    const task = (await service.publishMission(publisher, {
      conversationId: conversation.id,
      title: "调度提醒验证",
      objective: "验证常驻调度器以系统身份写入提醒。",
      priority: "high",
      dueAt: "2026-12-31T10:00:00.000Z",
      packages: [{
        title: "机房巡检", description: "按清单巡检。", acceptanceCriteria: "记录完整。", requiredSkills: ["运营"],
        assignmentMode: "direct", assigneeId: MEMBER_ID, priority: "high", dueAt: "2026-09-11T10:00:00.000Z",
        startedAt: "2026-08-01T00:00:00.000Z", estimatedDays: 7, capacityPoints: 2,
      }],
    })).packages[0];

    const now = new Date("2026-09-10T09:00:00.000Z");
    const first = await service.runScheduledReminderScan({ tenantId: DEMO_TENANT_ID, now });
    expect(first).toMatchObject({ attribution: "system", created: 1, notificationsCreated: 1 });

    const poolRow = (await database.query<{ author_type: string; author_id: string | null; source: string; subject: string }>(
      "SELECT author_type,author_id,source,subject FROM work_pool_messages WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1", [DEMO_TENANT_ID],
    )).rows[0];
    expect(poolRow.author_type).toBe("system");
    expect(poolRow.author_id).toBeNull();
    expect(poolRow.source).toBe("system");
    expect(poolRow.subject).toContain("机房巡检");

    const notificationRow = (await database.query<{ actor_type: string; actor_id: string | null; kind: string; recipient_id: string; read_at: string | null }>(
      "SELECT actor_type,actor_id,kind,recipient_id,read_at FROM work_task_notifications WHERE package_id=$1 AND kind='task_due_soon'", [task.id],
    )).rows[0];
    expect(notificationRow).toMatchObject({ actor_type: "system", actor_id: null, kind: "task_due_soon", recipient_id: MEMBER_ID, read_at: null });
    // 消息事件同样以系统身份落库，不再硬挂一个真人
    const eventRow = (await database.query<{ actor_type: string; actor_id: string | null }>(
      "SELECT actor_type,actor_id FROM work_message_events WHERE message_id=$1", [poolRow ? (await database.query<{ id: string }>("SELECT id FROM work_pool_messages WHERE subject=$1", [poolRow.subject])).rows[0].id : ""],
    )).rows[0];
    expect(eventRow).toMatchObject({ actor_type: "system", actor_id: null });

    // 同一时间再次扫描：池消息与通知都不重复
    const second = await service.runScheduledReminderScan({ tenantId: DEMO_TENANT_ID, now });
    expect(second).toMatchObject({ created: 0, deduplicated: 1, notificationsCreated: 0, notificationsDeduplicated: 1 });
    expect((await database.query<{ count: string }>("SELECT count(*)::text AS count FROM work_task_notifications WHERE package_id=$1 AND kind='task_due_soon'", [task.id])).rows[0].count).toBe("1");
    expect((await database.query<{ count: string }>("SELECT count(*)::text AS count FROM work_pool_messages WHERE tenant_id=$1", [DEMO_TENANT_ID])).rows[0].count).toBe("1");

    // 收件人仍可正常读取并按人过滤（1 条分派 + 1 条临期提醒）
    const member = { ...createDevelopmentRequestContext("postgres-reminder-member"), actorId: MEMBER_ID };
    const list = await service.notifications(member, { unreadOnly: true });
    expect(list.unreadCount).toBe(2);
    // 两条通知可能落在同一毫秒，排序不做假设：按类型取用
    expect([...list.notifications.map((item) => item.kind)].sort()).toEqual(["task_assigned", "task_due_soon"]);
    const reminder = list.notifications.find((item) => item.kind === "task_due_soon")!;
    expect(reminder).toMatchObject({ actorType: "system" });
    expect(reminder.actorId).toBeUndefined();
    expect(list.notifications.find((item) => item.kind === "task_assigned")).toMatchObject({ actorType: "user", actorId: DEMO_MANAGER_ID });
  });

  it("周期摘要以系统署名落库、面向整个租户并按周期幂等", async () => {
    const publisher = createDevelopmentRequestContext("postgres-summary");
    const conversation = (await service.workspace(publisher)).conversation;
    await service.publishMission(publisher, {
      conversationId: conversation.id,
      title: "摘要验证",
      objective: "验证常驻调度的租户级摘要。",
      priority: "high",
      dueAt: "2026-12-31T10:00:00.000Z",
      packages: [{
        title: "摘要包", description: "摘要用。", acceptanceCriteria: "摘要包含在办与风险。", requiredSkills: ["交付"],
        assignmentMode: "direct", assigneeId: MEMBER_ID, priority: "high", dueAt: "2026-09-11T10:00:00.000Z",
        startedAt: "2026-08-01T00:00:00.000Z", estimatedDays: 7, capacityPoints: 2,
      }],
    });
    const now = new Date("2026-09-10T09:00:00.000Z");
    const first = await service.generateScheduledSummary({ tenantId: DEMO_TENANT_ID, now });
    expect(first).toMatchObject({ scope: "daily", periodKey: "2026-09-10", created: true, attribution: "system" });
    expect(first.summary).toContain("在办任务");

    const row = (await database.query<{ author_type: string; author_id: string | null; source: string; subject: string; content: string }>(
      "SELECT author_type,author_id,source,subject,content FROM work_pool_messages WHERE tenant_id=$1 AND subject LIKE '工作进度摘要%'", [DEMO_TENANT_ID],
    )).rows[0];
    expect(row.author_type).toBe("system");
    expect(row.author_id).toBeNull();
    expect(row.source).toBe("system");
    expect(row.content).toContain("风险：逾期");

    const second = await service.generateScheduledSummary({ tenantId: DEMO_TENANT_ID, now });
    expect(second.created).toBe(false);
    expect(second.messageId).toBe(first.messageId);
    expect((await database.query<{ count: string }>("SELECT count(*)::text AS count FROM work_pool_messages WHERE tenant_id=$1 AND subject LIKE '工作进度摘要%'", [DEMO_TENANT_ID])).rows[0].count).toBe("1");

    // 下一个周期（次日）会再发一条
    const nextDay = await service.generateScheduledSummary({ tenantId: DEMO_TENANT_ID, now: new Date("2026-09-11T09:00:00.000Z") });
    expect(nextDay.created).toBe(true);
    expect(nextDay.periodKey).toBe("2026-09-11");
  });

  it("heartbeat 接受 task-reminder 角色，且系统署名的约束互斥生效", async () => {
    await database.query(
      "INSERT INTO worker_heartbeats(role,instance_id,release_version,capabilities,started_at,last_seen_at) VALUES('task-reminder','worker-1:task-reminder','test', '{}'::jsonb, now(), now())",
    );
    const heartbeats = await database.query<{ role: string }>("SELECT role FROM worker_heartbeats WHERE role='task-reminder'");
    expect(heartbeats.rows).toHaveLength(1);

    // 署名与 actor_id 必须匹配：系统署名不允许挂真人 ID
    await expect(database.query(
      `INSERT INTO work_task_notifications(id,tenant_id,recipient_id,actor_type,actor_id,kind,title,body,ref_type,ref_id,package_id,source_event_id,created_at)
       VALUES('10000000-0000-4000-8000-0000000000aa',$1,$2,'system',$3,'task_overdue','t','b','work_package',$4,$4,$5,now())`,
      [DEMO_TENANT_ID, MEMBER_ID, DEMO_MANAGER_ID, "10000000-0000-4000-8000-0000000000bb", "10000000-0000-4000-8000-0000000000cc"],
    )).rejects.toThrow(/actor_attribution/);
  });
});
