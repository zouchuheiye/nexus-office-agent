import type { TaskCommandRepository } from "@/src/modules/task-command/application/contracts";

/**
 * P4（留存）：站内通知的留存清理策略。
 *
 * 为什么需要：`work_task_notifications` 是"提醒到人"的运行态数据，随任务分派/承接/交接/验收
 * 与每轮临期扫描持续增长，而通知本身对当事人只在短期内有用——长期不清理会拖慢
 * 「通知」页签的按人查询，也让工作区载荷越滚越大。
 *
 * 两条口径：
 * - `readDays`：**已读**通知超过这个天数就清理（读者已经消化过它）。
 * - `maxAgeDays`：**无论已读与否**都清理的硬上限，避免"永远没人点开"的未读通知无限累积。
 *
 * 为什么可以删：通知是投递态而不是业务事实——任务事实与事件链在 `work_packages` /
 * `work_task_events` 里（append-only），被删的通知在原子审计表里仍留有创建与删除记录。
 */
export type NotificationRetentionOptions = {
  enabled: boolean;
  readDays: number;
  maxAgeDays: number;
  /** 单批删除条数：避免一条 DELETE 锁住太多行。 */
  batchSize: number;
  /** 单租户单次清理的批数上限（防御性上限，剩下的留给下一次运行）。 */
  maxBatches: number;
};

export const DEFAULT_NOTIFICATION_RETENTION_OPTIONS: NotificationRetentionOptions = {
  enabled: true,
  readDays: 90,
  maxAgeDays: 365,
  batchSize: 500,
  maxBatches: 20,
};

export type NotificationRetentionResult = {
  enabled: boolean;
  readPruned: number;
  expiredPruned: number;
  batches: number;
  readBefore: string;
  expiredBefore: string;
  ranAt: string;
};

const DAY_MS = 86_400_000;

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("NOTIFICATION_RETENTION_CONFIG_INVALID");
  return parsed;
}

/** 唯一的"环境变量 → 留存策略"映射点：常驻 Worker 与手工脚本共用，避免两处各写一套默认值。 */
export function notificationRetentionOptionsFromEnv(env: Record<string, string | undefined> = process.env): NotificationRetentionOptions {
  return {
    enabled: env.TASK_NOTIFICATION_RETENTION_ENABLED !== "false",
    readDays: positiveInteger(env.TASK_NOTIFICATION_RETENTION_DAYS, DEFAULT_NOTIFICATION_RETENTION_OPTIONS.readDays),
    maxAgeDays: positiveInteger(env.TASK_NOTIFICATION_MAX_AGE_DAYS, DEFAULT_NOTIFICATION_RETENTION_OPTIONS.maxAgeDays),
    batchSize: positiveInteger(env.TASK_NOTIFICATION_RETENTION_BATCH, DEFAULT_NOTIFICATION_RETENTION_OPTIONS.batchSize),
    maxBatches: DEFAULT_NOTIFICATION_RETENTION_OPTIONS.maxBatches,
  };
}

/** 计算两条清理线；配置非法（读窗口小于 1 天、硬上限早于读窗口）时显式报错而不是静默照跑。 */
export function notificationRetentionCutoffs(now: Date, options: Pick<NotificationRetentionOptions, "readDays" | "maxAgeDays">) {
  if (!Number.isInteger(options.readDays) || options.readDays < 1) throw new Error("NOTIFICATION_RETENTION_CONFIG_INVALID");
  if (!Number.isInteger(options.maxAgeDays) || options.maxAgeDays < options.readDays) throw new Error("NOTIFICATION_RETENTION_CONFIG_INVALID");
  return {
    readBefore: new Date(now.getTime() - options.readDays * DAY_MS).toISOString(),
    expiredBefore: new Date(now.getTime() - options.maxAgeDays * DAY_MS).toISOString(),
  };
}

export class NotificationRetentionService {
  constructor(
    private readonly repository: Pick<TaskCommandRepository, "deleteNotifications">,
    private readonly options: NotificationRetentionOptions = DEFAULT_NOTIFICATION_RETENTION_OPTIONS,
  ) {}

  /**
   * 清理一个租户的通知。分两趟：先按"已读 + 超期"，再按"硬上限"（含未读）。
   * 幂等：重复运行只是继续删下一批候选；没有候选时两趟各查一次库就结束。
   */
  async pruneTenant(input: { tenantId: string; now?: Date }): Promise<NotificationRetentionResult> {
    const now = input.now ?? new Date();
    const { readBefore, expiredBefore } = notificationRetentionCutoffs(now, this.options);
    const result: NotificationRetentionResult = { enabled: this.options.enabled, readPruned: 0, expiredPruned: 0, batches: 0, readBefore, expiredBefore, ranAt: now.toISOString() };
    if (!this.options.enabled) return result;

    for (let batch = 0; batch < this.options.maxBatches; batch += 1) {
      const deleted = await this.repository.deleteNotifications(input.tenantId, { createdBefore: readBefore, onlyRead: true, limit: this.options.batchSize });
      result.batches += 1;
      result.readPruned += deleted;
      if (deleted < this.options.batchSize) break;
    }
    for (let batch = 0; batch < this.options.maxBatches; batch += 1) {
      const deleted = await this.repository.deleteNotifications(input.tenantId, { createdBefore: expiredBefore, onlyRead: false, limit: this.options.batchSize });
      result.batches += 1;
      result.expiredPruned += deleted;
      if (deleted < this.options.batchSize) break;
    }
    return result;
  }
}
