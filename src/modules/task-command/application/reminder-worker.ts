import type { TaskCommandService } from "@/src/modules/task-command/application/service";
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
};

export const DEFAULT_TASK_REMINDER_OPTIONS: TaskReminderWorkerOptions = {
  intervalMs: 3_600_000,
  dueSoonHours: 72,
  blockedEscalationHours: 24,
  timeoutMs: 60_000,
};

/**
 * P4（第二半）：提醒扫描的常驻调度。
 *
 * 复用 Durable Worker 的 supervisor：它负责枚举活跃租户、写心跳、在 SIGTERM 时排空。
 * 这个 worker 只做三件事：按租户做间隔节流、调用系统扫描入口、把结果记成可观测证据。
 *
 * 幂等边界：扫描本身按"日期 + 任务 + 类型（+ 收件人）"生成确定性 ID，
 * 池消息与通知都不会因重复扫描或两个实例同时运行而重复；这里只额外做同实例内的重叠保护。
 */
export class TaskReminderWorker {
  readonly role: WorkerRole = "task-reminder";
  private readonly lastScanAt = new Map<string, number>();
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
    const previous = this.lastScanAt.get(tenantId);
    if (previous !== undefined && now.getTime() - previous < this.options.intervalMs) return { role: this.role, status: "idle" };
    const existing = this.inFlight.get(tenantId);
    if (existing) return existing;
    const run = this.scan(tenantId, workerId, now).finally(() => { this.inFlight.delete(tenantId); });
    this.inFlight.set(tenantId, run);
    return run;
  }

  private async scan(tenantId: string, workerId: string, now: Date): Promise<WorkCycleResult> {
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
      return { role: this.role, status: "succeeded" };
    } catch (error) {
      const errorCode = error instanceof Error ? error.message.split(":")[0] || "TASK_REMINDER_FAILED" : "TASK_REMINDER_FAILED";
      incrementCounter("task_reminder.scan.total", { outcome: "failed" });
      logOperationalEvent("error", "task_reminder.scan_failed", { workerId, errorCode });
      return { role: this.role, status: "failed" };
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
