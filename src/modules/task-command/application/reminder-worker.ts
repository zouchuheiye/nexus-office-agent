import type { TaskCommandService } from "@/src/modules/task-command/application/service";
import { summaryPeriodKey } from "@/src/modules/task-command/application/service";
import type { WorkerRole } from "@/src/platform/workers/contracts";
import type { WorkCycleResult } from "@/src/platform/workers/durable-workers";
import { incrementCounter, logOperationalEvent } from "@/src/platform/observability/telemetry";

export type TaskReminderWorkerOptions = {
  /** 每个租户两次扫描之间的最小间隔；同一租户在间隔内重复轮询直接返回 idle。 */
  intervalMs: number;
  dueSoonHours: number;
  blockedEscalationHours: number;
  /** 单次扫描的超时，避免一个慢租户拖住整个 supervisor 周期。 */
  timeoutMs: number;
  /** 周期进度摘要：默认开启，按周期键（日报=UTC 日期/周报=当周周一）每个周期只发一条。 */
  summary: { enabled: boolean; scope: "daily" | "weekly" };
};

export const DEFAULT_TASK_REMINDER_OPTIONS: TaskReminderWorkerOptions = {
  intervalMs: 3_600_000,
  dueSoonHours: 72,
  blockedEscalationHours: 24,
  timeoutMs: 60_000,
  summary: { enabled: true, scope: "daily" },
};

/**
 * P4（第二半）：提醒与周期摘要的常驻调度。
 *
 * 复用 Durable Worker 的 supervisor：它负责枚举活跃租户、写心跳、在 SIGTERM 时排空。
 * 这个 worker 只做四件事：按租户做间隔节流、调用系统扫描入口、按周期发进度摘要、把结果记成可观测证据。
 *
 * 幂等边界：提醒按"日期 + 任务 + 类型（+ 收件人）"、摘要按"作用域 + 周期"生成确定性 ID，
 * 池消息与通知都不会因重复扫描或两个实例同时运行而重复；这里只额外做同实例内的重叠保护，
 * 摘要再用内存里的"本期已发"标记避免每个轮询周期都打一次数据库。
 */
export class TaskReminderWorker {
  readonly role: WorkerRole = "task-reminder";
  private readonly lastScanAt = new Map<string, number>();
  private readonly lastSummaryPeriod = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<WorkCycleResult>>();
  private draining = false;

  constructor(
    private readonly service: TaskCommandService,
    private readonly options: TaskReminderWorkerOptions = DEFAULT_TASK_REMINDER_OPTIONS,
  ) {}

  beginDrain(): void {
    this.draining = true;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()]);
  }

  async processTenant(tenantId: string, workerId: string, now = new Date()): Promise<WorkCycleResult> {
    if (this.draining) return { role: this.role, status: "idle" };
    const existing = this.inFlight.get(tenantId);
    if (existing) return existing;
    const run = this.cycle(tenantId, workerId, now).finally(() => { this.inFlight.delete(tenantId); });
    this.inFlight.set(tenantId, run);
    return run;
  }

  /** 一个租户周期：摘要按周期键判断，提醒按间隔节流；两者都幂等，重复调用不会产生重复消息。 */
  private async cycle(tenantId: string, workerId: string, now: Date): Promise<WorkCycleResult> {
    let worked = false;
    let failed = false;

    if (this.options.summary.enabled) {
      const periodKey = summaryPeriodKey(this.options.summary.scope, now);
      if (this.lastSummaryPeriod.get(tenantId) !== periodKey) {
        worked = true;
        failed = !(await this.publishSummary(tenantId, workerId, now, periodKey)) || failed;
      }
    }

    const previous = this.lastScanAt.get(tenantId);
    if (previous === undefined || now.getTime() - previous >= this.options.intervalMs) {
      worked = true;
      failed = !(await this.scanReminders(tenantId, workerId, now)) || failed;
    }

    if (failed) return { role: this.role, status: "failed" };
    return { role: this.role, status: worked ? "succeeded" : "idle" };
  }

  private async publishSummary(tenantId: string, workerId: string, now: Date, periodKey: string): Promise<boolean> {
    try {
      const result = await this.withTimeout(this.service.generateScheduledSummary({ tenantId, scope: this.options.summary.scope, now }));
      // 确定性 ID 是真正的幂等保证；这里只避免同一进程反复查库。
      this.lastSummaryPeriod.set(tenantId, periodKey);
      incrementCounter("task_summary.publish.total", { outcome: result.created ? "created" : "deduplicated" });
      logOperationalEvent("info", "task_reminder.summary_published", {
        workerId, scope: result.scope, periodKey: result.periodKey, created: result.created,
        effective: result.effective, attribution: result.attribution,
      });
      return true;
    } catch (error) {
      const errorCode = error instanceof Error ? error.message.split(":")[0] || "TASK_SUMMARY_FAILED" : "TASK_SUMMARY_FAILED";
      incrementCounter("task_summary.publish.total", { outcome: "failed" });
      logOperationalEvent("error", "task_reminder.summary_failed", { workerId, periodKey, errorCode });
      return false;
    }
  }

  private async scanReminders(tenantId: string, workerId: string, now: Date): Promise<boolean> {
    try {
      const result = await this.withTimeout(this.service.runScheduledReminderScan({
        tenantId,
        now,
        dueSoonHours: this.options.dueSoonHours,
        blockedEscalationHours: this.options.blockedEscalationHours,
      }));
      // 只在扫描成功后推进节流时间：失败的下个周期要能立刻重试。
      this.lastScanAt.set(tenantId, now.getTime());
      incrementCounter("task_reminder.scan.total", { outcome: "succeeded" });
      logOperationalEvent("info", "task_reminder.scan_succeeded", {
        workerId,
        scanned: result.scanned,
        candidates: result.candidates,
        created: result.created,
        deduplicated: result.deduplicated,
        notificationsCreated: result.notificationsCreated,
        notificationsDeduplicated: result.notificationsDeduplicated,
        attribution: result.attribution,
      });
      return true;
    } catch (error) {
      const errorCode = error instanceof Error ? error.message.split(":")[0] || "TASK_REMINDER_FAILED" : "TASK_REMINDER_FAILED";
      incrementCounter("task_reminder.scan.total", { outcome: "failed" });
      logOperationalEvent("error", "task_reminder.scan_failed", { workerId, errorCode });
      return false;
    }
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("TASK_REMINDER_TIMEOUT")), this.options.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
