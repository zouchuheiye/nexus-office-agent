// Requirements: PR-009, PR-010, MR-049（P4：外部通道投递的常驻调度）
import { describe, expect, it } from "vitest";
import { DEFAULT_TASK_NOTIFICATION_DISPATCH_OPTIONS, TaskNotificationDispatchWorker, summarizeDispatchReasons } from "@/src/modules/integration/application/task-notification-dispatch-worker";
import type { TaskNotificationChannelDispatcher, TaskNotificationDispatchSummary } from "@/src/modules/integration/application/task-notification-channel";
import { DEMO_TENANT_ID } from "@/src/platform/context/development-context";

const NOW = new Date("2026-09-10T09:00:00.000Z");
const options = { ...DEFAULT_TASK_NOTIFICATION_DISPATCH_OPTIONS, enabled: true, intervalMs: 300_000, timeoutMs: 5_000 };

function summary(scanned: number): TaskNotificationDispatchSummary {
  return { enabled: true, scanned, delivered: scanned, alreadyDelivered: 0, retryScheduled: 0, failed: 0, unknown: 0, skipped: 0, deferred: 0, items: [], ranAt: NOW.toISOString() };
}

function harness(behaviour: (tenantId: string) => Promise<TaskNotificationDispatchSummary>) {
  const calls: string[] = [];
  const dispatcher = { async dispatchTenant({ tenantId }: { tenantId: string }) { calls.push(tenantId); return behaviour(tenantId); } } as unknown as TaskNotificationChannelDispatcher;
  return { calls, worker: new TaskNotificationDispatchWorker(dispatcher, options) };
}

describe("P4 外部通道投递常驻调度", () => {
  it("总开关关闭时直接 idle，连派发器都不调用", async () => {
    const { calls, worker } = harness(async () => summary(1));
    const disabled = new TaskNotificationDispatchWorker({ async dispatchTenant() { calls.push("called"); return summary(1); } } as unknown as TaskNotificationChannelDispatcher, { ...options, enabled: false });

    expect(await disabled.processTenant(DEMO_TENANT_ID, "worker-1", NOW)).toEqual({ role: "notification-dispatch", status: "idle" });
    expect(calls).toEqual([]);
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", NOW)).toEqual({ role: "notification-dispatch", status: "succeeded" });
    expect(calls).toEqual([DEMO_TENANT_ID]);
  });

  it("按租户间隔节流：间隔内返回 idle，超过间隔后重新投递", async () => {
    const { calls, worker } = harness(async () => summary(1));
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", NOW)).toMatchObject({ status: "succeeded" });
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", new Date(NOW.getTime() + 1_000))).toEqual({ role: "notification-dispatch", status: "idle" });
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", new Date(NOW.getTime() + options.intervalMs + 1))).toMatchObject({ status: "succeeded" });
    expect(calls).toHaveLength(2);
  });

  it("没有候选时返回 idle 但已经推进节流（避免空租户反复扫窗口）", async () => {
    const { worker } = harness(async () => summary(0));
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", NOW)).toEqual({ role: "notification-dispatch", status: "idle" });
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", new Date(NOW.getTime() + 1_000))).toEqual({ role: "notification-dispatch", status: "idle" });
  });

  it("投递失败返回 failed 且不推进节流时间（下个周期立即重试）", async () => {
    let failing = true;
    const { worker } = harness(async () => {
      if (failing) throw new Error("TASK_NOTIFICATION_DISPATCH_TIMEOUT");
      return summary(1);
    });
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", NOW)).toEqual({ role: "notification-dispatch", status: "failed" });
    failing = false;
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", new Date(NOW.getTime() + 1_000))).toMatchObject({ status: "succeeded" });
  });

  it("排空后不再投递", async () => {
    const { worker } = harness(async () => summary(1));
    worker.beginDrain();
    await worker.drain();
    expect(await worker.processTenant(DEMO_TENANT_ID, "worker-1", NOW)).toEqual({ role: "notification-dispatch", status: "idle" });
  });

  it("跳过与延后的原因被聚合成运维可读的计数", () => {
    expect(summarizeDispatchReasons([
      { notificationId: "a", recipientId: "u", kind: "task_assigned", outcome: "skipped", reason: "NO_BOUND_CHANNEL" },
      { notificationId: "b", recipientId: "u", kind: "task_assigned", outcome: "skipped", reason: "NO_BOUND_CHANNEL" },
      { notificationId: "c", recipientId: "u", kind: "task_overdue", outcome: "deferred", reason: "QUIET_HOURS" },
      { notificationId: "d", recipientId: "u", kind: "task_overdue", outcome: "delivered" },
    ])).toEqual({ NO_BOUND_CHANNEL: 2, QUIET_HOURS: 1 });
  });
});
