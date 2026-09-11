// Requirements: PR-004（站内通知默认只保留必要历史）, MR-046, MR-048, AC-012（P4：通知留存清理）
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_RETENTION_OPTIONS,
  NotificationRetentionService,
  notificationRetentionCutoffs,
  notificationRetentionOptionsFromEnv,
} from "@/src/modules/task-command/application/notification-retention";
import { TaskCommandService } from "@/src/modules/task-command/application/service";
import { DEMO_PRODUCT_OWNER_ID, InMemoryTaskCommandRepository } from "@/src/modules/task-command/infrastructure/in-memory-repository";
import { createDevelopmentRequestContext, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

const NOW = new Date("2026-09-10T00:00:00.000Z");
const options = { ...DEFAULT_NOTIFICATION_RETENTION_OPTIONS, readDays: 30, maxAgeDays: 365, batchSize: 2, maxBatches: 10 };

function daysAgo(days: number, hour = 0): string {
  return new Date(NOW.getTime() - days * 86_400_000 + hour * 3_600_000).toISOString();
}

/** 直接往内存仓储里塞通知：留存清理只看 created_at/read_at，不需要走任务链路。 */
function seed(repository: InMemoryTaskCommandRepository, rows: Array<{ id: string; createdAt: string; readAt?: string }>) {
  for (const row of rows) {
    repository.saveNotifications([{
      id: row.id,
      tenantId: DEMO_TENANT_ID,
      recipientId: DEMO_PRODUCT_OWNER_ID,
      actorType: "system",
      kind: "task_due_soon",
      title: "任务临期：机房巡检",
      body: "约 1.0 天后到期，请及时推进。",
      refType: "work_package",
      refId: "30000000-0000-4000-8000-000000000001",
      packageId: "30000000-0000-4000-8000-000000000001",
      sourceEventId: `seed:${row.id}`,
      createdAt: row.createdAt,
      readAt: row.readAt,
    }]);
  }
}

async function remainingIds(repository: InMemoryTaskCommandRepository): Promise<string[]> {
  const listed = await repository.listNotifications(DEMO_TENANT_ID, DEMO_PRODUCT_OWNER_ID, { limit: 100 });
  return listed.map((item) => item.id).sort();
}

describe("P4 通知留存清理", () => {
  it("已读且超过读窗口的通知被清理，同一批里的未读保留", async () => {
    const repository = new InMemoryTaskCommandRepository();
    seed(repository, [
      { id: "read-old", createdAt: daysAgo(40), readAt: daysAgo(39) },
      { id: "read-fresh", createdAt: daysAgo(3), readAt: daysAgo(2) },
      { id: "unread-old", createdAt: daysAgo(40) },
    ]);
    const result = await new NotificationRetentionService(repository, options).pruneTenant({ tenantId: DEMO_TENANT_ID, now: NOW });

    expect(result).toMatchObject({ enabled: true, readPruned: 1, expiredPruned: 0 });
    expect(await remainingIds(repository)).toEqual(["read-fresh", "unread-old"]);
  });

  it("未读但超过硬上限的通知同样被清理（避免未读无限累积）", async () => {
    const repository = new InMemoryTaskCommandRepository();
    seed(repository, [
      { id: "unread-ancient", createdAt: daysAgo(400) },
      { id: "read-ancient", createdAt: daysAgo(400), readAt: daysAgo(399) },
      { id: "unread-recent", createdAt: daysAgo(10) },
    ]);
    const result = await new NotificationRetentionService(repository, options).pruneTenant({ tenantId: DEMO_TENANT_ID, now: NOW });

    expect(result).toMatchObject({ readPruned: 1, expiredPruned: 1 });
    expect(await remainingIds(repository)).toEqual(["unread-recent"]);
  });

  it("按批删除：超过单批条数时候选会被分多批清完", async () => {
    const repository = new InMemoryTaskCommandRepository();
    seed(repository, Array.from({ length: 5 }, (_, index) => ({ id: `read-${index}`, createdAt: daysAgo(40 - index), readAt: daysAgo(39 - index) })));
    const result = await new NotificationRetentionService(repository, options).pruneTenant({ tenantId: DEMO_TENANT_ID, now: NOW });

    // 5 条候选、每批 2 条：3 批删完（第 3 批只删到 1 条即收尾），另有硬上限那一趟的空查。
    expect(result.readPruned).toBe(5);
    expect(result.batches).toBe(4);
    expect(await remainingIds(repository)).toEqual([]);
  });

  it("批数上限生效：一次清理不会无限制地删下去", async () => {
    const repository = new InMemoryTaskCommandRepository();
    seed(repository, Array.from({ length: 7 }, (_, index) => ({ id: `read-${index}`, createdAt: daysAgo(40 - index), readAt: daysAgo(39 - index) })));
    const result = await new NotificationRetentionService(repository, { ...options, maxBatches: 2, maxAgeDays: 400 }).pruneTenant({ tenantId: DEMO_TENANT_ID, now: NOW });

    expect(result.readPruned).toBe(4);
    expect(await remainingIds(repository)).toHaveLength(3);
  });

  it("没有候选时两趟各查一次库就结束", async () => {
    const repository = new InMemoryTaskCommandRepository();
    seed(repository, [{ id: "fresh", createdAt: daysAgo(1) }]);
    const result = await new NotificationRetentionService(repository, options).pruneTenant({ tenantId: DEMO_TENANT_ID, now: NOW });

    expect(result).toMatchObject({ readPruned: 0, expiredPruned: 0, batches: 2 });
    expect(await remainingIds(repository)).toEqual(["fresh"]);
  });

  it("关闭开关时连库都不查", async () => {
    const calls: string[] = [];
    const service = new NotificationRetentionService(
      { async deleteNotifications(_tenantId, input) { calls.push(input.onlyRead ? "read" : "expired"); return 0; } },
      { ...options, enabled: false },
    );
    const result = await service.pruneTenant({ tenantId: DEMO_TENANT_ID, now: NOW });

    expect(result).toMatchObject({ enabled: false, readPruned: 0, expiredPruned: 0, batches: 0 });
    expect(calls).toEqual([]);
  });

  it("配置非法时显式报错：硬上限不能早于读窗口，读窗口至少 1 天", () => {
    expect(() => notificationRetentionCutoffs(NOW, { readDays: 30, maxAgeDays: 7 })).toThrow("NOTIFICATION_RETENTION_CONFIG_INVALID");
    expect(() => notificationRetentionCutoffs(NOW, { readDays: 0, maxAgeDays: 365 })).toThrow("NOTIFICATION_RETENTION_CONFIG_INVALID");
    const cutoffs = notificationRetentionCutoffs(NOW, { readDays: 30, maxAgeDays: 365 });
    expect(cutoffs.readBefore).toBe("2026-08-11T00:00:00.000Z");
    expect(cutoffs.expiredBefore).toBe("2025-09-10T00:00:00.000Z");
  });

  it("环境变量映射：默认值、关闭开关与非法值", () => {
    expect(notificationRetentionOptionsFromEnv({})).toEqual(DEFAULT_NOTIFICATION_RETENTION_OPTIONS);
    expect(notificationRetentionOptionsFromEnv({ TASK_NOTIFICATION_RETENTION_ENABLED: "false", TASK_NOTIFICATION_RETENTION_DAYS: "14", TASK_NOTIFICATION_MAX_AGE_DAYS: "180", TASK_NOTIFICATION_RETENTION_BATCH: "100" }))
      .toMatchObject({ enabled: false, readDays: 14, maxAgeDays: 180, batchSize: 100 });
    expect(() => notificationRetentionOptionsFromEnv({ TASK_NOTIFICATION_RETENTION_DAYS: "0" })).toThrow("NOTIFICATION_RETENTION_CONFIG_INVALID");
    expect(() => notificationRetentionOptionsFromEnv({ TASK_NOTIFICATION_MAX_AGE_DAYS: "30 天" })).toThrow("NOTIFICATION_RETENTION_CONFIG_INVALID");
  });

  it("服务入口 pruneNotifications 走同一套策略，且不产生任何新通知或池消息", async () => {
    const repository = new InMemoryTaskCommandRepository();
    const service = new TaskCommandService(repository, options);
    const publisher = createDevelopmentRequestContext("retention-publisher");
    const conversation = (await service.workspace(publisher)).conversation;
    await service.publishMission(publisher, {
      conversationId: conversation.id,
      title: "留存清理验证",
      objective: "验证通知留存清理不制造新事实。",
      priority: "medium",
      dueAt: "2026-12-31T10:00:00.000Z",
      packages: [{
        title: "整理台账", description: "整理本周台账。", acceptanceCriteria: "台账齐全。", requiredSkills: ["运营"],
        assignmentMode: "direct", assigneeId: DEMO_PRODUCT_OWNER_ID, priority: "medium", dueAt: "2026-09-20T10:00:00.000Z",
        startedAt: "2026-08-01T00:00:00.000Z", estimatedDays: 3, capacityPoints: 1,
      }],
    });
    const before = await service.workspace(publisher);
    seed(repository, [{ id: "old-read", createdAt: daysAgo(90), readAt: daysAgo(89) }]);

    const result = await service.pruneNotifications({ tenantId: DEMO_TENANT_ID, now: NOW });
    const after = await service.workspace(publisher);

    expect(result.readPruned).toBe(1);
    // 清理只删通知：任务事实、池消息与事件数都不变。
    expect(after.publishedByMe).toHaveLength(before.publishedByMe.length);
    expect(after.messagePools.flatMap((pool) => pool.messages)).toHaveLength(before.messagePools.flatMap((pool) => pool.messages).length);
  });
});
