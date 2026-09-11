// Requirements: PR-004, MR-046, MR-048, AC-012（P4：通知留存清理的持久化路径）
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskCommandService } from "@/src/modules/task-command/application/service";
import { DEFAULT_NOTIFICATION_RETENTION_OPTIONS } from "@/src/modules/task-command/application/notification-retention";
import { PostgresTaskCommandRepository } from "@/src/modules/task-command/infrastructure/postgres-repository";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

const MEMBER_ID = "10000000-0000-4000-8000-000000000003";
const OTHER_TENANT_ID = "00000000-0000-4000-8000-0000000000ff";
const OTHER_USER_ID = "10000000-0000-4000-8000-0000000000ff";
const NOW = new Date("2026-09-10T00:00:00.000Z");
const MIGRATIONS = [
  "0001_foundation.sql", "0002_management_loop.sql", "0003_agent_platform.sql", "0004_connector_platform.sql",
  "0005_workflow_knowledge.sql", "0006_strategy_organization_talent.sql", "0007_client_platform.sql",
  "0008_security_hardening.sql", "0009_atomic_audit.sql", "0010_immutable_audit.sql", "0011_enterprise_governance.sql",
  "0012_enterprise_acceptance.sql", "0013_connector_test_notifications.sql", "0014_durable_runtime.sql",
  "0015_agent_job_control.sql", "0016_management_intelligence.sql", "0017_work_command_center.sql",
  "0018_work_message_pools.sql", "0019_work_task_handoffs.sql", "0023_work_artifact_evidence_chain.sql",
  "0043_work_task_templates.sql", "0045_work_task_progress_tracking.sql", "0046_work_task_handoff_card.sql",
  "0047_announcement_center.sql", "0048_work_package_subtasks.sql", "0049_work_task_notifications.sql",
  "0050_task_reminder_scheduler.sql", "0051_task_notification_retention.sql",
];

const options = { ...DEFAULT_NOTIFICATION_RETENTION_OPTIONS, readDays: 30, maxAgeDays: 365, batchSize: 2, maxBatches: 10 };

describe("Postgres 通知留存清理", () => {
  let database: PGlite;
  let adapter: TransactionalDatabase;
  let service: TaskCommandService;

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
    service = new TaskCommandService(new PostgresTaskCommandRepository(adapter), options);
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'demo','Demo','active'),($2,'other','Other','active')", [DEMO_TENANT_ID, OTHER_TENANT_ID]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [DEMO_TENANT_ID]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Manager','manager@example.test','active'),($3,$2,'Product','product@example.test','active')", [DEMO_MANAGER_ID, DEMO_TENANT_ID, MEMBER_ID]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [OTHER_TENANT_ID]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Outsider','outsider@example.test','active')", [OTHER_USER_ID, OTHER_TENANT_ID]);
  });

  afterEach(async () => { await database.close(); });

  /** 造一条真实任务包，再直接写通知行——留存清理只看 created_at/read_at，不需要走完整链路。 */
  async function seedNotifications() {
    const publisher = createDevelopmentRequestContext("postgres-retention");
    const conversation = (await service.workspace(publisher)).conversation;
    const task = (await service.publishMission(publisher, {
      conversationId: conversation.id,
      title: "留存清理验证",
      objective: "验证通知留存清理的持久化路径。",
      priority: "medium",
      dueAt: "2026-12-31T10:00:00.000Z",
      packages: [{
        title: "整理台账", description: "整理本周台账。", acceptanceCriteria: "台账齐全。", requiredSkills: ["运营"],
        assignmentMode: "direct", assigneeId: MEMBER_ID, priority: "medium", dueAt: "2026-09-20T10:00:00.000Z",
        startedAt: "2026-08-01T00:00:00.000Z", estimatedDays: 3, capacityPoints: 1,
      }],
    })).packages[0];

    const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
    const insert = (id: string, tenantId: string, recipientId: string, createdAt: string, readAt: string | null, packageId: string) =>
      database.query(
        `INSERT INTO work_task_notifications(id,tenant_id,recipient_id,actor_type,actor_id,kind,title,body,ref_type,ref_id,package_id,source_event_id,created_at,read_at)
         VALUES($1,$2,$3,'system',NULL,'task_due_soon','任务临期：整理台账','约 1.0 天后到期，请及时推进。','work_package',$4,$4,$5,$6,$7)`,
        [id, tenantId, recipientId, packageId, randomUUID(), createdAt, readAt],
      );
    await insert("11111111-1111-4111-8111-111111111111", DEMO_TENANT_ID, MEMBER_ID, daysAgo(40), daysAgo(39), task.id);
    await insert("22222222-2222-4222-8222-222222222222", DEMO_TENANT_ID, MEMBER_ID, daysAgo(40), null, task.id);
    await insert("33333333-3333-4333-8333-333333333333", DEMO_TENANT_ID, MEMBER_ID, daysAgo(400), null, task.id);
    await insert("44444444-4444-4444-8444-444444444444", DEMO_TENANT_ID, MEMBER_ID, daysAgo(2), null, task.id);
    // 另一个租户的同龄行：清理必须严格限定在调用租户内。
    const otherPackage = "55555555-5555-4555-8555-555555555555";
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [OTHER_TENANT_ID]);
    await database.query(
      `INSERT INTO work_conversations(id,tenant_id,owner_id,title,status,version,created_at,updated_at)
       VALUES('88888888-8888-4888-8888-888888888888',$1,$2,'隔离验证','active',1,$3,$3)`,
      [OTHER_TENANT_ID, OTHER_USER_ID, daysAgo(10)],
    );
    await database.query(
      `INSERT INTO work_missions(id,tenant_id,conversation_id,title,objective,priority,due_at,published_by,source,status,created_at,updated_at)
       VALUES('66666666-6666-4666-8666-666666666666',$1,'88888888-8888-4888-8888-888888888888','隔离验证','验证租户隔离。','medium',$2,$3,'human','active',$4,$4)`,
      [OTHER_TENANT_ID, daysAgo(-20), OTHER_USER_ID, daysAgo(10)],
    );
    await database.query(
      `INSERT INTO work_packages(id,tenant_id,mission_id,ordinal,title,description,acceptance_criteria,required_skills,assignment_mode,assignee_id,priority,due_at,capacity_points,published_by,status,is_template,evidence_refs,missing_fields,version,created_at,updated_at)
       VALUES($1,$2,'66666666-6666-4666-8666-666666666666',1,'隔离任务','验证租户隔离。','有记录。','[]','direct',$3,'medium',$4,1,$3,'in_progress',false,'[]','[]',1,$5,$5)`,
      [otherPackage, OTHER_TENANT_ID, OTHER_USER_ID, daysAgo(-20), daysAgo(10)],
    );
    await insert("77777777-7777-4777-8777-777777777777", OTHER_TENANT_ID, OTHER_USER_ID, daysAgo(40), daysAgo(39), otherPackage);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [DEMO_TENANT_ID]);
    return task;
  }

  it("按批真删超期通知：已读超窗口与未读超硬上限都被清掉，新通知与其它租户不受影响", async () => {
    const task = await seedNotifications();
    const result = await service.pruneNotifications({ tenantId: DEMO_TENANT_ID, now: NOW });

    expect(result).toMatchObject({ enabled: true, readPruned: 1, expiredPruned: 1 });
    const rows = (await database.query<{ id: string }>(
      "SELECT id::text FROM work_task_notifications WHERE tenant_id=$1 ORDER BY id::text", [DEMO_TENANT_ID],
    )).rows.map((row) => row.id);
    // 40 天前的已读（1 号）与 400 天前的未读（3 号）被删；40 天前的未读、2 天前的新通知留下。
    expect(rows).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(rows).not.toContain("33333333-3333-4333-8333-333333333333");
    expect(rows).toContain("22222222-2222-4222-8222-222222222222");
    expect(rows).toContain("44444444-4444-4444-8444-444444444444");

    // 另一个租户的同龄已读通知必须原样保留。
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [OTHER_TENANT_ID]);
    const otherRows = (await database.query<{ id: string }>("SELECT id::text FROM work_task_notifications WHERE tenant_id=$1", [OTHER_TENANT_ID])).rows;
    expect(otherRows.map((row) => row.id)).toEqual(["77777777-7777-4777-8777-777777777777"]);

    // 删除是留痕的：原子审计触发器为每条被删通知写了 database.delete 记录。
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [DEMO_TENANT_ID]);
    const audit = (await database.query<{ action: string; resource_id: string }>(
      "SELECT action,resource_id FROM audit_events WHERE resource_type='work_task_notifications' AND action='database.delete' AND tenant_id=$1", [DEMO_TENANT_ID],
    )).rows;
    expect(audit.map((row) => row.resource_id).sort()).toEqual(["11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333"]);

    // 任务事实不受清理影响：通知没了，任务与事件链还在。
    const packages = (await database.query<{ count: number }>("SELECT count(*)::int AS count FROM work_packages WHERE id=$1", [task.id])).rows[0];
    expect(Number(packages.count)).toBe(1);
  });

  it("重复清理是幂等的：第二次没有候选，任务事件与包数量都不变", async () => {
    await seedNotifications();
    const first = await service.pruneNotifications({ tenantId: DEMO_TENANT_ID, now: NOW });
    const eventsBefore = (await database.query<{ count: number }>("SELECT count(*)::int AS count FROM work_task_events WHERE tenant_id=$1", [DEMO_TENANT_ID])).rows[0];
    const second = await service.pruneNotifications({ tenantId: DEMO_TENANT_ID, now: NOW });

    expect(first.readPruned + first.expiredPruned).toBe(2);
    expect(second).toMatchObject({ readPruned: 0, expiredPruned: 0, batches: 2 });
    const eventsAfter = (await database.query<{ count: number }>("SELECT count(*)::int AS count FROM work_task_events WHERE tenant_id=$1", [DEMO_TENANT_ID])).rows[0];
    expect(Number(eventsAfter.count)).toBe(Number(eventsBefore.count));
  });

  it("关闭开关时不删任何行", async () => {
    await seedNotifications();
    const countNotifications = async () => Number((await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM work_task_notifications WHERE tenant_id=$1", [DEMO_TENANT_ID],
    )).rows[0].count);
    const before = await countNotifications();
    const disabled = new TaskCommandService(new PostgresTaskCommandRepository(adapter), { ...options, enabled: false });
    const result = await disabled.pruneNotifications({ tenantId: DEMO_TENANT_ID, now: NOW });

    expect(result).toMatchObject({ enabled: false, readPruned: 0, expiredPruned: 0 });
    expect(await countNotifications()).toBe(before);
  });
});
