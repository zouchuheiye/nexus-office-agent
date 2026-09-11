// Requirements: PR-009, PR-010, MR-046, MR-047, MR-048, AC-012, AC-013（P4：定时提醒常驻调度 + 系统署名）
import { describe, expect, it } from "vitest";
import { DEFAULT_TASK_REMINDER_OPTIONS, TaskReminderWorker } from "@/src/modules/task-command/application/reminder-worker";
import { DEFAULT_NOTIFICATION_RETENTION_OPTIONS } from "@/src/modules/task-command/application/notification-retention";
import { TaskCommandService } from "@/src/modules/task-command/application/service";
import { DEMO_PRODUCT_OWNER_ID, InMemoryTaskCommandRepository } from "@/src/modules/task-command/infrastructure/in-memory-repository";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

const options = { ...DEFAULT_TASK_REMINDER_OPTIONS, intervalMs: 60_000, dueSoonHours: 72, blockedEscalationHours: 24, timeoutMs: 5_000 };

async function fixture() {
  const repository = new InMemoryTaskCommandRepository();
  const service = new TaskCommandService(repository);
  const publisher = createDevelopmentRequestContext("reminder-worker-publisher");
  const assignee = { ...createDevelopmentRequestContext("reminder-worker-assignee"), actorId: DEMO_PRODUCT_OWNER_ID };
  const conversation = (await service.workspace(publisher)).conversation;
  return { repository, service, publisher, assignee, conversation };
}

/** 发布一个已开始、将于 `dueAt` 到期的定向任务（开始时间必须早于截止）。 */
async function publishDueTask(service: TaskCommandService, publisher: ReturnType<typeof createDevelopmentRequestContext>, conversationId: string, dueAt: string) {
  const result = await service.publishMission(publisher, {
    conversationId,
    title: "值班巡检",
    objective: "完成本周值班巡检并留痕。",
    priority: "high",
    dueAt: "2026-12-31T10:00:00.000Z",
    packages: [{
      title: "巡检机房",
      description: "按清单巡检并留痕。",
      acceptanceCriteria: "巡检记录完整。",
      requiredSkills: ["运营"],
      assignmentMode: "direct",
      assigneeId: DEMO_PRODUCT_OWNER_ID,
      priority: "high",
      dueAt,
      startedAt: "2026-08-01T00:00:00.000Z",
      estimatedDays: 7,
      capacityPoints: 2,
    }],
  });
  return result.packages[0];
}

describe("P4 定时提醒常驻调度", () => {
  it("以系统身份扫描：池消息与通知都不冒名任何同事", async () => {
    const { service, publisher, assignee, conversation } = await fixture();
    await publishDueTask(service, publisher, conversation.id, "2026-09-11T10:00:00.000Z");
    const result = await service.runScheduledReminderScan({ tenantId: DEMO_TENANT_ID, now: new Date("2026-09-10T09:00:00.000Z") });

    expect(result.attribution).toBe("system");
    expect(result.candidates).toBe(1);
    expect(result.created).toBe(1);
    const pool = (await service.workspace(publisher)).messagePools.flatMap((item) => item.messages);
    const reminder = pool.find((item) => item.subject.includes("巡检机房"))!;
    expect(reminder).toMatchObject({ authorType: "system", source: "system" });
    expect(reminder.authorId).toBeUndefined();

    const notifications = (await service.notifications(assignee, {})).notifications.filter((item) => item.kind === "task_due_soon");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ actorType: "system", recipientId: DEMO_PRODUCT_OWNER_ID });
    expect(notifications[0].actorId).toBeUndefined();
    expect(notifications[0].title).toContain("任务临期");
  });

  it("重复扫描不会重复提醒（确定性幂等键）", async () => {
    const { service, publisher, assignee, conversation } = await fixture();
    await publishDueTask(service, publisher, conversation.id, "2026-09-11T10:00:00.000Z");
    const now = new Date("2026-09-10T09:00:00.000Z");
    const first = await service.runScheduledReminderScan({ tenantId: DEMO_TENANT_ID, now });
    const second = await service.runScheduledReminderScan({ tenantId: DEMO_TENANT_ID, now });

    expect(first.created).toBe(1);
    expect(first.notificationsCreated).toBe(1);
    expect(second.created).toBe(0);
    expect(second.deduplicated).toBe(1);
    expect(second.notificationsCreated).toBe(0);
    expect(second.notificationsDeduplicated).toBe(1);
    const notifications = (await service.notifications(assignee, {})).notifications.filter((item) => item.kind === "task_due_soon");
    expect(notifications).toHaveLength(1);
  });

  it("逾期与阻塞升级分别提醒负责人，阻塞同时提醒发布人", async () => {
    const { service, publisher, assignee, conversation } = await fixture();
    const task = await publishDueTask(service, publisher, conversation.id, "2026-09-11T10:00:00.000Z");
    // 先逾期：截止已过
    const overdue = await service.runScheduledReminderScan({ tenantId: DEMO_TENANT_ID, now: new Date("2026-09-15T09:00:00.000Z") });
    expect(overdue.created).toBe(1);
    const overdueNotification = (await service.notifications(assignee, {})).notifications.find((item) => item.kind === "task_overdue")!;
    expect(overdueNotification.body).toContain("已逾期");
    // 再阻塞：负责人推进到 blocked 并说明原因，超过阈值后升级
    const started = await service.transitionPackage(assignee, task.id, { expectedVersion: task.version, nextStatus: "in_progress" });
    const blocked = await service.transitionPackage(assignee, task.id, { expectedVersion: started.version, nextStatus: "blocked", blockedReason: "等待客户提供机房门禁权限" });
    expect(blocked.status).toBe("blocked");
    const escalation = await service.runScheduledReminderScan({ tenantId: DEMO_TENANT_ID, now: new Date("2026-09-17T09:00:00.000Z") });
    expect(escalation.created).toBe(1);
    const assigneeBlocked = (await service.notifications(assignee, {})).notifications.filter((item) => item.kind === "task_blocked");
    const publisherBlocked = (await service.notifications(publisher, {})).notifications.filter((item) => item.kind === "task_blocked");
    expect(assigneeBlocked).toHaveLength(1);
    expect(publisherBlocked).toHaveLength(1);
    expect(publisherBlocked[0].body).toContain("等待客户提供机房门禁权限");
  });

  it("无负责人的公开任务只发池消息，不产生收件人为空的提醒", async () => {
    const { service, publisher, conversation } = await fixture();
    await service.publishMission(publisher, {
      conversationId: conversation.id,
      title: "公开承接巡检",
      objective: "等待任一成员承接。",
      priority: "medium",
      dueAt: "2026-12-31T10:00:00.000Z",
      packages: [{
        title: "公开巡检包", description: "无人承接前的公开任务。", acceptanceCriteria: "有人承接后执行。", requiredSkills: ["运营"],
        assignmentMode: "open_claim", priority: "medium", dueAt: "2026-09-11T10:00:00.000Z",
        startedAt: "2026-08-01T00:00:00.000Z", estimatedDays: 7, capacityPoints: 1,
      }],
    });
    const result = await service.runScheduledReminderScan({ tenantId: DEMO_TENANT_ID, now: new Date("2026-09-10T09:00:00.000Z") });
    expect(result.created).toBe(1);
    expect(result.notificationsCreated).toBe(0);
    expect((await service.notifications(publisher, {})).notifications).toEqual([]);
  });

  it("人工触发的扫描仍按调用人署名，且以 Agent 语义写池消息", async () => {
    const { service, publisher, assignee, conversation } = await fixture();
    await publishDueTask(service, publisher, conversation.id, "2026-09-11T10:00:00.000Z");
    const result = await service.runReminderScan(publisher, { now: "2026-09-10T09:00:00.000Z" });
    expect(result.attribution).toBe("user");
    const reminder = (await service.workspace(publisher)).messagePools.flatMap((item) => item.messages).find((item) => item.subject.includes("巡检机房"))!;
    expect(reminder).toMatchObject({ authorType: "user", authorId: DEMO_MANAGER_ID, source: "agent" });
    const notification = (await service.notifications(assignee, {})).notifications.find((item) => item.kind === "task_due_soon")!;
    expect(notification).toMatchObject({ actorType: "user", actorId: DEMO_MANAGER_ID });
  });

  it("worker 按租户间隔节流，扫过的租户在间隔内返回 idle，排空后不再扫描", async () => {
    const { service, publisher, conversation } = await fixture();
    await publishDueTask(service, publisher, conversation.id, "2026-09-11T10:00:00.000Z");
    const worker = new TaskReminderWorker(service, options);
    const now = new Date("2026-09-10T09:00:00.000Z");

    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", now)).toEqual({ role: "task-reminder", status: "succeeded" });
    // 同一租户在间隔内不再扫描
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", new Date(now.getTime() + 1_000))).toEqual({ role: "task-reminder", status: "idle" });
    // 超过间隔后重新扫描（幂等，因此不会产生新消息）
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", new Date(now.getTime() + options.intervalMs + 1))).toEqual({ role: "task-reminder", status: "succeeded" });

    worker.beginDrain();
    await worker.drain();
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", new Date(now.getTime() + 2 * options.intervalMs))).toEqual({ role: "task-reminder", status: "idle" });
  });

  it("周期摘要按周期键每个周期只发一条，跨周期后重新发布", async () => {
    const { service, publisher, conversation } = await fixture();
    await publishDueTask(service, publisher, conversation.id, "2026-09-11T10:00:00.000Z");
    const worker = new TaskReminderWorker(service, { ...options, summary: { enabled: true, scope: "daily" } });

    const day1 = new Date("2026-09-10T09:00:00.000Z");
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", day1)).toEqual({ role: "task-reminder", status: "succeeded" });
    const summaries = async () => (await service.workspace(publisher)).messagePools.flatMap((item) => item.messages).filter((item) => item.subject.includes("工作进度摘要"));
    const first = await summaries();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ authorType: "system", source: "system" });
    expect(first[0].content).toContain("在办任务");

    // 同一周期（含超过提醒间隔后）不会重复发摘要
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", new Date(day1.getTime() + options.intervalMs + 1))).toEqual({ role: "task-reminder", status: "succeeded" });
    expect(await summaries()).toHaveLength(1);

    // 进入下一个周期后重新发布一条
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", new Date("2026-09-11T09:00:00.000Z"))).toEqual({ role: "task-reminder", status: "succeeded" });
    expect(await summaries()).toHaveLength(2);
  });

  it("可以用 TASK_SUMMARY_ENABLED 关闭周期摘要（只跑提醒）", async () => {
    const { service, publisher, conversation } = await fixture();
    await publishDueTask(service, publisher, conversation.id, "2026-09-11T10:00:00.000Z");
    const worker = new TaskReminderWorker(service, { ...options, summary: { enabled: false, scope: "daily" } });
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", new Date("2026-09-10T09:00:00.000Z"))).toEqual({ role: "task-reminder", status: "succeeded" });
    const messages = (await service.workspace(publisher)).messagePools.flatMap((item) => item.messages);
    expect(messages.some((item) => item.subject.includes("工作进度摘要"))).toBe(false);
    expect(messages.some((item) => item.subject.includes("任务临期提醒"))).toBe(true);
  });

  it("扫描失败返回 failed 且不推进节流时间（下个周期可立即重试）", async () => {
    const failing = {
      runScheduledReminderScan: async () => { throw new Error("REMINDER_SCAN_FAILED"); },
      generateScheduledSummary: async () => { throw new Error("SUMMARY_FAILED"); },
      pruneNotifications: async () => { throw new Error("RETENTION_FAILED"); },
    } as unknown as TaskCommandService;
    const worker = new TaskReminderWorker(failing, options);
    const now = new Date("2026-09-10T09:00:00.000Z");
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", now)).toEqual({ role: "task-reminder", status: "failed" });
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", new Date(now.getTime() + 1_000))).toEqual({ role: "task-reminder", status: "failed" });
  });

  it("通知留存清理每租户每天只做一次，删的是真正超期的通知", async () => {
    const repository = new InMemoryTaskCommandRepository();
    const service = new TaskCommandService(repository, { ...DEFAULT_NOTIFICATION_RETENTION_OPTIONS, readDays: 30, maxAgeDays: 365, batchSize: 10 });
    const publisher = createDevelopmentRequestContext("retention-worker");
    const conversation = (await service.workspace(publisher)).conversation;
    const task = await publishDueTask(service, publisher, conversation.id, "2026-09-11T10:00:00.000Z");
    const seedNotification = (id: string, createdAt: string, readAt?: string) => repository.saveNotifications([{
      id, tenantId: DEMO_TENANT_ID, recipientId: DEMO_PRODUCT_OWNER_ID, actorType: "system",
      kind: "task_due_soon", title: "任务临期：巡检机房", body: "约 1.0 天后到期，请及时推进。",
      refType: "work_package", refId: task.id, packageId: task.id, sourceEventId: `retention-seed:${id}`,
      createdAt, readAt,
    }]);
    const now = new Date("2026-09-10T09:00:00.000Z");
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    await seedNotification("old-read", daysAgo(40), daysAgo(39));
    await seedNotification("fresh-unread", daysAgo(1));
    const remaining = async () => (await service.notifications({ ...publisher, actorId: DEMO_PRODUCT_OWNER_ID }, { limit: 100 })).notifications.map((item) => item.id);

    // 第一次周期：清理跑一次，老已读通知被删、新的未读留下。
    expect(await service.pruneNotifications({ tenantId: DEMO_TENANT_ID, now })).toMatchObject({ readPruned: 1, expiredPruned: 0 });

    const worker = new TaskReminderWorker(service, { ...options, intervalMs: 86_400_000, summary: { enabled: false, scope: "daily" } });
    // 同一天第二次周期：留存清理不再重复执行（提醒间隔也还没到），整体 idle。
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", now)).toEqual({ role: "task-reminder", status: "succeeded" });
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", new Date(now.getTime() + 60_000))).toEqual({ role: "task-reminder", status: "idle" });
    // 跨天后重新执行一次，没有候选也不报错。
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", new Date("2026-09-11T09:00:00.000Z"))).toEqual({ role: "task-reminder", status: "succeeded" });
    expect(await remaining()).toContain("fresh-unread");
    expect(await remaining()).not.toContain("old-read");
  });

  it("留存清理失败不推进当天标记（下个周期立即重试）", async () => {
    class FlakyRetentionRepository extends InMemoryTaskCommandRepository {
      failing = true;
      async deleteNotifications(tenantId: string, input: { createdBefore: string; onlyRead: boolean; limit: number }) {
        if (this.failing) throw new Error("NOTIFICATION_RETENTION_TIMEOUT");
        return super.deleteNotifications(tenantId, input);
      }
    }
    const repository = new FlakyRetentionRepository();
    const service = new TaskCommandService(repository, { ...DEFAULT_NOTIFICATION_RETENTION_OPTIONS, readDays: 30, maxAgeDays: 365, batchSize: 10 });
    const publisher = createDevelopmentRequestContext("retention-retry");
    const conversation = (await service.workspace(publisher)).conversation;
    const task = await publishDueTask(service, publisher, conversation.id, "2026-09-11T10:00:00.000Z");
    const now = new Date("2026-09-10T09:00:00.000Z");
    await repository.saveNotifications([{
      id: "old-read", tenantId: DEMO_TENANT_ID, recipientId: DEMO_PRODUCT_OWNER_ID, actorType: "system",
      kind: "task_due_soon", title: "任务临期：巡检机房", body: "约 1.0 天后到期，请及时推进。",
      refType: "work_package", refId: task.id, packageId: task.id, sourceEventId: "retention-retry-seed",
      createdAt: new Date(now.getTime() - 40 * 86_400_000).toISOString(), readAt: new Date(now.getTime() - 39 * 86_400_000).toISOString(),
    }]);
    const worker = new TaskReminderWorker(service, { ...options, intervalMs: 86_400_000, summary: { enabled: false, scope: "daily" } });

    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", now)).toEqual({ role: "task-reminder", status: "failed" });
    // 失败没有推进"今天已做"标记，所以下个周期立刻重试并成功。
    repository.failing = false;
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", new Date(now.getTime() + 1_000))).toEqual({ role: "task-reminder", status: "succeeded" });
    const remaining = (await service.notifications({ ...publisher, actorId: DEMO_PRODUCT_OWNER_ID }, { limit: 100 })).notifications;
    expect(remaining.map((item) => item.id)).not.toContain("old-read");
  });
});
