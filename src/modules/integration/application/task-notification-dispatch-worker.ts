import type { TaskNotificationChannelDispatcher, TaskNotificationDispatchItem } from "@/src/modules/integration/application/task-notification-channel";
import type { WorkCycleResult } from "@/src/platform/workers/durable-workers";
import type { TenantWorker } from "@/src/platform/workers/supervisor";
import { incrementCounter, logOperationalEvent } from "@/src/platform/observability/telemetry";

/** 跳过/延后的原因计数：运维一眼能看出"没人开外部通道"还是"都在免打扰"。 */
export function summarizeDispatchReasons(items: TaskNotificationDispatchItem[]): Record<string, number> {
  const reasons: Record<string, number> = {};
  for (const item of items) {
    if (!item.reason) continue;
    reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
  }
  return reasons;
}

export type TaskNotificationDispatchWorkerOptions = {
  /** 同一租户两次投递之间的最小间隔；间隔内重复轮询直接返回 idle。 */
  intervalMs: number;
  /** 单租户单轮的超时，避免一个慢租户拖住整个 supervisor 周期。 */
  timeoutMs: number;
  /** 总开关（默认关闭）：关闭时不做任何扫描，也不连接任何外部通道。 */
  enabled: boolean;
};

export const DEFAULT_TASK_NOTIFICATION_DISPATCH_OPTIONS: TaskNotificationDispatchWorkerOptions = {
  intervalMs: 300_000,
  timeoutMs: 30_000,
  enabled: false,
};

/**
 * P4（外部通道）：站内任务通知 → 飞书/钉钉/企微的常驻投递。
 *
 * 独立的 Worker 角色（`WORKER_ROLES=notification-dispatch`），因为它与"提醒扫描"是两种不同的运行
 * 关注点：提醒是平台内部的时间/状态推导，外部投递要碰企业凭据与第三方限流。分开部署、分开限流、
 * 分开排障，出问题也不会把提醒扫描一起拖住。
 *
 * 幂等/节流边界：投递幂等由 `connector_deliveries(tenant_id, notification_id)` 唯一约束保证（见
 * `TaskNotificationChannelDispatcher`），这里只做同实例内的间隔节流与重叠保护；失败不推进节流时间，
 * 下个周期立即重试。总开关关闭时连租户扫描都不做（返回 enabled=false 的汇总）。
 */
export class TaskNotificationDispatchWorker implements TenantWorker {
  readonly role = "notification-dispatch" as const;
  private readonly lastDispatchAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<WorkCycleResult>>();
  private draining = false;

  constructor(
    private readonly dispatcher: TaskNotificationChannelDispatcher,
    private readonly options: TaskNotificationDispatchWorkerOptions = DEFAULT_TASK_NOTIFICATION_DISPATCH_OPTIONS,
  ) {}

  beginDrain(): void {
    this.draining = true;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()]);
  }

  async processTenant(tenantId: string, workerId: string, now = new Date()): Promise<WorkCycleResult> {
    if (this.draining) return { role: this.role, status: "idle" };
    if (!this.options.enabled) return { role: this.role, status: "idle" };
    const existing = this.inFlight.get(tenantId);
    if (existing) return existing;
    const previous = this.lastDispatchAt.get(tenantId);
    if (previous !== undefined && now.getTime() - previous < this.options.intervalMs) return { role: this.role, status: "idle" };
    const run = this.cycle(tenantId, workerId, now).finally(() => { this.inFlight.delete(tenantId); });
    this.inFlight.set(tenantId, run);
    return run;
  }

  private async cycle(tenantId: string, workerId: string, now: Date): Promise<WorkCycleResult> {
    try {
      const summary = await this.withTimeout(this.dispatcher.dispatchTenant({ tenantId, now }));
      this.lastDispatchAt.set(tenantId, now.getTime());
      incrementCounter("task_notification.channel_dispatch.total", { outcome: summary.delivered ? "delivered" : "noop" });
      logOperationalEvent("info", "task_notification.channel_dispatched", {
        workerId, scanned: summary.scanned, delivered: summary.delivered, alreadyDelivered: summary.alreadyDelivered,
        retryScheduled: summary.retryScheduled, failed: summary.failed, unknown: summary.unknown,
        skipped: summary.skipped, deferred: summary.deferred, reasons: summarizeDispatchReasons(summary.items),
      });
      return { role: this.role, status: summary.scanned ? "succeeded" : "idle" };
    } catch (error) {
      const errorCode = error instanceof Error ? error.message.split(":")[0] || "TASK_NOTIFICATION_DISPATCH_FAILED" : "TASK_NOTIFICATION_DISPATCH_FAILED";
      incrementCounter("task_notification.channel_dispatch.total", { outcome: "failed" });
      logOperationalEvent("error", "task_notification.channel_dispatch_failed", { workerId, errorCode });
      return { role: this.role, status: "failed" };
    }
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("TASK_NOTIFICATION_DISPATCH_TIMEOUT")), this.options.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
