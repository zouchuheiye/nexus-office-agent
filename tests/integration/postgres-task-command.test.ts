// Requirements: PR-009, PR-010, PR-011, PR-012, MR-046, MR-047, MR-048, MR-049, MR-050, AR-002, AR-011, SR-007, AC-012, AC-013
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskCommandService } from "@/src/modules/task-command/application/service";
import { PostgresTaskCommandRepository } from "@/src/modules/task-command/infrastructure/postgres-repository";
import type { DatabaseExecutor, SqlPrimitive, TransactionalDatabase } from "@/src/platform/database/executor";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

const MEMBER_ID = "10000000-0000-4000-8000-000000000003";

describe("Postgres task command repository", () => {
  let database: PGlite;
  let service: TaskCommandService;

  beforeEach(async () => {
    database = new PGlite();
    const migrations = ["0001_foundation.sql","0002_management_loop.sql","0003_agent_platform.sql","0004_connector_platform.sql","0005_workflow_knowledge.sql","0006_strategy_organization_talent.sql","0007_client_platform.sql","0008_security_hardening.sql","0009_atomic_audit.sql","0010_immutable_audit.sql","0011_enterprise_governance.sql","0012_enterprise_acceptance.sql","0013_connector_test_notifications.sql","0014_durable_runtime.sql","0015_agent_job_control.sql","0016_management_intelligence.sql","0017_work_command_center.sql","0018_work_message_pools.sql","0019_work_task_handoffs.sql","0023_work_artifact_evidence_chain.sql","0043_work_task_templates.sql","0045_work_task_progress_tracking.sql","0046_work_task_handoff_card.sql","0047_announcement_center.sql","0048_work_package_subtasks.sql","0049_work_task_notifications.sql"];
    for (const file of migrations) await database.exec(await readFile(path.resolve("src/platform/database/migrations", file), "utf8"));
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
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Manager','manager@example.test','active'),($3,$2,'Product','product@example.test','active')", [DEMO_MANAGER_ID,DEMO_TENANT_ID,MEMBER_ID]);
  });

  afterEach(async () => { await database.close(); });

  it("persists one primary conversation, CAS claims and atomic audit receipts", async () => {
    const publisher = createDevelopmentRequestContext("postgres-task-command");
    const firstConversation = (await service.workspace(publisher)).conversation;
    const sameConversation = (await service.workspace(publisher)).conversation;
    expect(sameConversation.id).toBe(firstConversation.id);
    const bundle = await service.publishMission(publisher, {
      conversationId: firstConversation.id,
      title: "发布验收任务",
      objective: "用持久化任务包完成客户验收。",
      priority: "high",
      dueAt: "2030-09-01T10:00:00.000Z",
      packages: [{
        title: "准备验收证据",
        description: "整理测试与交付证据。",
        acceptanceCriteria: "证据完整且可追溯。",
        requiredSkills: ["测试"],
        assignmentMode: "open_claim",
startedAt: "2030-08-01T00:00:00.000Z", estimatedDays: 7,         priority: "high",
        dueAt: "2030-08-30T10:00:00.000Z",
        capacityPoints: 3,
      }],
    });
    const member = { ...createDevelopmentRequestContext("postgres-task-member"), actorId: MEMBER_ID };
    const task = bundle.packages[0];
    expect(await service.claimPackage(member, task.id, 1)).toMatchObject({ status: "claimed", assigneeId: MEMBER_ID, version: 2 });
    await expect(service.claimPackage(publisher, task.id, 1)).rejects.toThrow("WORK_PACKAGE_VERSION_CONFLICT");
    expect((await service.events(member, 0)).map(({ eventType }) => eventType)).toEqual(expect.arrayContaining(["mission_published","package_claimed"]));
    const audits = await database.query<{ resource_type: string }>("SELECT resource_type FROM audit_events WHERE resource_type IN ('work_conversations','work_missions','work_packages','work_task_events')");
    expect(new Set(audits.rows.map(({ resource_type }) => resource_type))).toEqual(new Set(["work_conversations","work_missions","work_packages","work_task_events"]));
  });

  it("persists non-task company communication and feedback in separately audited message tables", async () => {
    const publisher = createDevelopmentRequestContext("postgres-message-pool");
    const posted = await service.publishPoolMessage(publisher, { poolKey: "company", subject: "版本同步", content: "测试环境将在周三更新，请在本条下反馈影响。" });
    const feedback = await service.appendPoolFeedback(publisher, { messageId: posted.message.id, content: "已确认产品侧无影响。" });
    const workspace = await service.workspace(publisher);
    expect(workspace.messagePools.find(({ key }) => key === "company")?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: posted.message.id, feedback: [expect.objectContaining({ id: feedback.id })] }),
    ]));
    expect(await service.messageEvents(publisher, 0)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "message_published", messageId: posted.message.id }),
      expect.objectContaining({ eventType: "feedback_published", messageId: posted.message.id }),
    ]));
    const audits = await database.query<{ resource_type: string }>("SELECT resource_type FROM audit_events WHERE resource_type IN ('work_pool_messages','work_pool_feedback','work_message_events')");
    expect(new Set(audits.rows.map(({ resource_type }) => resource_type))).toEqual(new Set(["work_pool_messages","work_pool_feedback","work_message_events"]));
  });

  it("persists a signed task handoff chain, artifact snapshot and atomic responsibility switch", async () => {
    const publisher = createDevelopmentRequestContext("postgres-task-handoff");
    const conversation = (await service.workspace(publisher)).conversation;
    const task = (await service.publishMission(publisher, {
      conversationId: conversation.id, title: "持久化交接", objective: "验证任务交接在同一事务中保存责任与资料快照。", priority: "high", dueAt: "2030-09-01T10:00:00.000Z",
      packages: [{ title: "交接验收资料", description: "由接收人继续完成资料复核。", acceptanceCriteria: "资料、责任和交接链完整可查。", requiredSkills: ["交付"], startedAt: "2030-08-01T00:00:00.000Z", estimatedDays: 7, assignmentMode: "direct", assigneeId: DEMO_MANAGER_ID, priority: "high", dueAt: "2030-08-30T10:00:00.000Z", capacityPoints: 2 }],
    })).packages[0];
    const registered = await service.registerTaskArtifact(publisher, {
      title: "验收资料包", fileName: "acceptance-v1.zip", mediaType: "application/zip",
      contentDigest: "a".repeat(64), storageRef: "object://controlled/acceptance-v1.zip", classification: "internal",
    });
    const requested = await service.initiateTaskHandoff(publisher, {
      taskId: task.id, expectedVersion: 1, toAssigneeId: MEMBER_ID, note: "资料已归档，请接续进行产品验收复核。", currentProgress: "资料已归档，进入产品验收复核。", completedWork: "资料归档完成。", pendingWork: "产品验收复核与签字。", artifactIds: [registered.artifact.id],
    });
    const recipient = { ...createDevelopmentRequestContext("postgres-task-handoff-recipient"), actorId: MEMBER_ID };
    const accepted = await service.respondToTaskHandoff(recipient, requested.handoff.id, { expectedVersion: 1, decision: "accept" });
    expect(accepted).toMatchObject({ handoff: { status: "accepted", snapshot: { packageVersion: 1 }, artifactSnapshots: [{ artifactId: registered.artifact.id, version: 1, contentDigest: "a".repeat(64) }] }, task: { assigneeId: MEMBER_ID, version: 2 } });
    await service.appendTaskArtifactVersion(publisher, registered.artifact.id, {
      expectedVersion: 1, fileName: "acceptance-v2.zip", mediaType: "application/zip", contentDigest: "b".repeat(64), storageRef: "object://controlled/acceptance-v2.zip",
    });
    expect((await service.taskHandoffTrail(publisher, task.id)).handoffs[0].artifactSnapshots).toMatchObject([{ artifactId: registered.artifact.id, version: 1, contentDigest: "a".repeat(64) }]);
    expect((await service.taskHandoffTrail(publisher, task.id)).handoffs).toEqual([expect.objectContaining({ id: requested.handoff.id, status: "accepted" })]);
    const audits = await database.query<{ resource_type: string }>("SELECT resource_type FROM audit_events WHERE resource_type IN ('work_task_handoffs','work_packages','work_task_events')");
    expect(audits.rows.map(({ resource_type }) => resource_type)).toEqual(expect.arrayContaining(["work_task_handoffs", "work_packages", "work_task_events"]));
  });

  it("F-084: postgres listPeople exposes workload counts and capacity points", async () => {
    const publisher = createDevelopmentRequestContext("postgres-workload");
    const conversation = (await service.workspace(publisher)).conversation;
    await service.publishMission(publisher, {
      conversationId: conversation.id,
      title: "负载验证",
      objective: "验证负载统计。",
      priority: "medium",
      dueAt: "2030-08-30T10:00:00.000Z",
      packages: [{ title: "负载包", description: "负载。", acceptanceCriteria: "完成。", requiredSkills: ["交付"], assignmentMode: "direct", assigneeId: DEMO_MANAGER_ID, priority: "medium", dueAt: "2030-08-30T10:00:00.000Z", startedAt: "2030-08-01T00:00:00.000Z", estimatedDays: 7, capacityPoints: 4 }],
    });
    const people = await service.memberWorkload(publisher);
    const me = people.find((person) => person.id === DEMO_MANAGER_ID);
    expect(me?.activeTaskCount).toBe(1);
    expect(me?.inProgressTaskCount).toBe(1);
    expect(me?.capacityPoints).toBe(4);
    expect(me?.dueSoonTaskCount).toBe(0);
  });

  it("P3: persists package subtasks with version CAS, progress aggregation and the review lock", async () => {
    const publisher = createDevelopmentRequestContext("postgres-subtasks");
    const conversation = (await service.workspace(publisher)).conversation;
    const task = (await service.publishMission(publisher, {
      conversationId: conversation.id,
      title: "子任务持久化",
      objective: "验证子任务在 PostgreSQL 中落库与加锁。",
      priority: "high",
      dueAt: "2030-09-01T10:00:00.000Z",
      packages: [{ title: "拆分子任务包", description: "把验收拆成可勾选步骤。", acceptanceCriteria: "子步骤齐全。", requiredSkills: ["交付"], assignmentMode: "open_claim", priority: "high", dueAt: "2030-08-30T10:00:00.000Z", startedAt: "2030-08-01T00:00:00.000Z", estimatedDays: 7, capacityPoints: 3 }],
    })).packages[0];
    const member = { ...createDevelopmentRequestContext("postgres-subtask-member"), actorId: MEMBER_ID };
    await service.claimPackage(member, task.id, task.version);
    // 进入进行中后可拆；承接人拆两条
    const running = await service.transitionPackage(member, task.id, { expectedVersion: 2, nextStatus: "in_progress" });
    const first = await service.addPackageSubtask(member, { packageId: task.id, title: "整理客户清单" });
    const second = await service.addPackageSubtask(member, { packageId: task.id, title: "汇编签字页" });
    expect((await service.listPackageSubtasks(member, { packageId: task.id })).progress).toEqual({ done: 0, total: 2 });
    // 未全部完成时，承接人不能把任务推进到验收
    await expect(service.transitionPackage(member, task.id, { expectedVersion: running.version, nextStatus: "in_review", evidenceRefs: ["document:evidence"] })).rejects.toThrow("WORK_PACKAGE_SUBTASKS_PENDING");
    // 勾选第一项：CAS 生效、重复旧版本失败
    const done = await service.updatePackageSubtask(member, { packageId: task.id, subtaskId: first.subtask.id, expectedVersion: first.subtask.version, done: true, note: "清单已核", evidenceRefs: ["https://example.test/evidence.pdf"] });
    await expect(service.updatePackageSubtask(member, { packageId: task.id, subtaskId: first.subtask.id, expectedVersion: first.subtask.version, done: true })).rejects.toThrow("WORK_PACKAGE_SUBTASK_CONFLICT");
    // 勾选第二项后进入验收；验收后不可再改子任务
    await service.updatePackageSubtask(member, { packageId: task.id, subtaskId: second.subtask.id, expectedVersion: second.subtask.version, done: true });
    const submitted = await service.transitionPackage(member, task.id, { expectedVersion: running.version, nextStatus: "in_review", evidenceRefs: ["document:evidence"] });
    await expect(service.updatePackageSubtask(member, { packageId: task.id, subtaskId: first.subtask.id, expectedVersion: done.subtask.version, done: false })).rejects.toThrow("WORK_PACKAGE_SUBTASKS_LOCKED");
    expect(submitted.status).toBe("in_review");
    // 重新查询：进度与完成字段在重启式查询中保持
    const reloaded = await service.listPackageSubtasks(member, { packageId: task.id });
    expect(reloaded.progress).toEqual({ done: 2, total: 2 });
    expect(reloaded.subtasks.find((item) => item.id === first.subtask.id)).toMatchObject({ status: "done", doneBy: MEMBER_ID, doneNote: "清单已核", evidenceRefs: ["https://example.test/evidence.pdf"] });
    const rows = await database.query<{ event_type: string; payload: Record<string, unknown> }>("SELECT event_type,payload FROM work_task_events WHERE package_id=$1 AND event_type='package_progress_updated' ORDER BY sequence", [task.id]);
    expect(rows.rows.map(({ payload }) => payload.action)).toEqual(["subtask_created", "subtask_created", "subtask_completed", "subtask_completed"]);
  });

  it("P4: persists per-recipient notifications in the same transaction and enforces FORCE RLS plus atomic audit", async () => {
    const publisher = createDevelopmentRequestContext("postgres-notification");
    const conversation = (await service.workspace(publisher)).conversation;
    const task = (await service.publishMission(publisher, {
      conversationId: conversation.id,
      title: "通知持久化",
      objective: "验证站内通知与业务变更同事务落库。",
      priority: "high",
      dueAt: "2030-09-01T10:00:00.000Z",
      packages: [{
        title: "整理通知证据", description: "把证据整理成可核验材料。", acceptanceCriteria: "证据可核验。", requiredSkills: ["交付"],
        assignmentMode: "direct", assigneeId: MEMBER_ID, priority: "high", dueAt: "2030-08-30T10:00:00.000Z",
        startedAt: "2030-08-01T00:00:00.000Z", estimatedDays: 7, capacityPoints: 3,
      }],
    })).packages[0];
    const member = { ...createDevelopmentRequestContext("postgres-notification-member"), actorId: MEMBER_ID };

    // 定向分派写入一条通知，且与 package_published 事件同事务
    const assigned = await service.notifications(member, {});
    expect(assigned.unreadCount).toBe(1);
    expect(assigned.notifications[0]).toMatchObject({ kind: "task_assigned", refType: "work_package", packageId: task.id, recipientId: MEMBER_ID });
    const durable = await database.query<{ recipient_id: string; kind: string; source_event_id: string; read_at: string | null }>("SELECT recipient_id,kind,source_event_id,read_at FROM work_task_notifications WHERE package_id=$1", [task.id]);
    expect(durable.rows).toHaveLength(1);
    expect(durable.rows[0].read_at).toBeNull();
    const sourceEvent = await database.query<{ id: string }>("SELECT id FROM work_task_events WHERE package_id=$1 AND event_type='package_published'", [task.id]);
    expect(durable.rows[0].source_event_id).toBe(sourceEvent.rows[0].id);

    // CAS 冲突不产生通知、也不产生事件
    const eventsBefore = (await database.query<{ count: string }>("SELECT count(*)::text AS count FROM work_task_events WHERE package_id=$1", [task.id])).rows[0].count;
    await expect(service.transitionPackage(member, task.id, { expectedVersion: 99, nextStatus: "in_progress" })).rejects.toThrow("WORK_PACKAGE_VERSION_CONFLICT");
    expect((await database.query<{ count: string }>("SELECT count(*)::text AS count FROM work_task_events WHERE package_id=$1", [task.id])).rows[0].count).toBe(eventsBefore);
    expect((await database.query<{ count: string }>("SELECT count(*)::text AS count FROM work_task_notifications WHERE package_id=$1", [task.id])).rows[0].count).toBe("1");

    // 提交验收通知发布人；《自己操作自己》不产生通知
    const running = await service.transitionPackage(member, task.id, { expectedVersion: task.version, nextStatus: "in_progress" });
    const submitted = await service.transitionPackage(member, task.id, { expectedVersion: running.version, nextStatus: "in_review", evidenceRefs: ["https://example.test/evidence.pdf"] });
    const reviewer = await service.notifications(publisher, {});
    expect(reviewer.notifications.map((item) => item.kind)).toEqual(["review_requested"]);
    await service.transitionPackage(publisher, task.id, { expectedVersion: submitted.version, nextStatus: "completed" });
    const decision = (await service.notifications(member, { unreadOnly: true })).notifications.find((item) => item.kind === "review_decided")!;
    expect(decision.title).toContain("验收通过");
    // 发布人自己验收自己发布的任务不会再收到"验收结果"
    expect((await service.notifications(publisher, {})).notifications.map((item) => item.kind)).toEqual(["review_requested"]);

    // 已读幂等且只影响本人：别人读不到我的通知
    const firstRead = await service.markNotificationRead(member, assigned.notifications[0].id);
    expect(firstRead.unreadCount).toBe(1);
    const secondRead = await service.markNotificationRead(member, assigned.notifications[0].id);
    expect(secondRead.notification.readAt).toBe(firstRead.notification.readAt);
    expect(secondRead.unreadCount).toBe(1);
    await expect(service.markNotificationRead(publisher, assigned.notifications[0].id)).rejects.toThrow("WORK_NOTIFICATION_NOT_FOUND");

    // 只读列表按收件人过滤：第三个成员看不到这些通知
    const observerId = "10000000-0000-4000-8000-000000000004";
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status) VALUES($1,$2,'Observer','observer@example.test','active')", [observerId, DEMO_TENANT_ID]);
    const other = { ...createDevelopmentRequestContext("postgres-notification-other"), actorId: observerId };
    expect((await service.notifications(other, {})).notifications).toEqual([]);
    expect((await service.notifications(other, {})).unreadCount).toBe(0);

    // 强制 RLS + 原子审计触发器
    const controls = await database.query<{ forced: boolean; policy_count: number; audited: boolean }>(
      `SELECT c.relforcerowsecurity AS forced,
        (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname) AS policy_count,
        EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='nexus_atomic_audit' AND NOT t.tgisinternal) AS audited
       FROM pg_class c WHERE c.relname='work_task_notifications'`,
    );
    expect(controls.rows[0]).toMatchObject({ forced: true, audited: true });
    expect(controls.rows[0].policy_count).toBeGreaterThanOrEqual(4);
    const audits = await database.query<{ resource_type: string }>("SELECT resource_type FROM audit_events WHERE resource_type='work_task_notifications'");
    expect(audits.rows.length).toBeGreaterThan(0);
  });
});
