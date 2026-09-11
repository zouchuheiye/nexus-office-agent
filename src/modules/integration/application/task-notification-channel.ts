import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import type { ChannelPreference } from "@/src/modules/integration/application/channel-preferences";

/**
 * P4（外部通道）：把站内任务通知投递到飞书/钉钉/企微。
 *
 * 设计取舍（重要，写下来避免后人误解）：
 * - **默认关闭**：只有 `TASK_NOTIFICATION_CHANNELS=enabled` 时才真的发外部消息。平台当前的连接器
 *   出站链路需要企业自备凭据（`AuthenticatedConnectorTransport` + 环境凭据），没有配置时会以
 *   `CONFIG_REQUIRED:*` / `UNCONFIGURED` 失败——本模块把这类失败记成台账里的 `failed`，而不是崩掉 worker。
 * - **显式 opt-in**：`channel_preferences.ordered_providers` 默认是 `["web"]`（只有站内）。用户没有把
 *   某个 IM 通道写进偏好时，一律不往外部发（`CHANNEL_NOT_OPTED_IN`）——外部通道不该由"绑定了身份"默认开启。
 * - **免打扰**：`quiet_hours` 命中的通知本轮不投递（`QUIET_HOURS`），留在扫描窗口内等下一轮。
 * - **幂等**：投递键 `task-notification:<通知 ID>` 落到 `connector_deliveries(tenant_id, notification_id)`
 *   唯一约束上；已投递成功的通知不会重复发送，`retry_scheduled` 要等 `next_attempt_at` 之后才重试。
 * - **只投递窗口内的通知**：候选是"最近 N 分钟产生的站内通知"，因此不新增 `dispatched_at` 列——
 *   跨周期的重复由投递台账兜住，窗口本身限制了每轮的工作量。
 */
export type TaskNotificationKind = "task_assigned" | "task_claimed" | "handoff_requested" | "handoff_responded" | "review_requested" | "review_decided" | "task_due_soon" | "task_overdue" | "task_blocked";

export type TaskNotificationCandidate = {
  id: string;
  recipientId: string;
  kind: TaskNotificationKind;
  title: string;
  body: string;
  packageId: string;
  createdAt: string;
};

export type ChannelTarget = { provider: ExternalProvider; connectionId: string; externalUserId: string };

export type TaskNotificationChannelOptions = {
  /** 总开关：默认关闭，企业配好凭据与偏好后再打开。 */
  enabled: boolean;
  /** 只投递最近 N 分钟内产生的站内通知（幂等由投递台账兜底）。 */
  lookbackMinutes: number;
  /** 单租户单轮最多处理多少条候选。 */
  batchSize: number;
  /** 深链前缀，用于"在网页中查看"。 */
  webBaseUrl: string;
};

export const DEFAULT_TASK_NOTIFICATION_CHANNEL_OPTIONS: TaskNotificationChannelOptions = {
  enabled: false,
  lookbackMinutes: 60,
  batchSize: 50,
  webBaseUrl: "http://localhost:3000",
};

export type TaskNotificationChannelOptionsEnv = Record<string, string | undefined>;

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("TASK_NOTIFICATION_CHANNEL_CONFIG_INVALID");
  return parsed;
}

/** 唯一的"环境变量 → 外部通道配置"映射点（常驻 Worker 与运维脚本共用）。 */
export function taskNotificationChannelOptionsFromEnv(env: TaskNotificationChannelOptionsEnv = process.env): TaskNotificationChannelOptions {
  return {
    enabled: env.TASK_NOTIFICATION_CHANNELS === "enabled",
    lookbackMinutes: positiveInteger(env.TASK_NOTIFICATION_CHANNEL_LOOKBACK_MINUTES, DEFAULT_TASK_NOTIFICATION_CHANNEL_OPTIONS.lookbackMinutes),
    batchSize: positiveInteger(env.TASK_NOTIFICATION_CHANNEL_BATCH, DEFAULT_TASK_NOTIFICATION_CHANNEL_OPTIONS.batchSize),
    webBaseUrl: env.NEXUS_WEB_BASE_URL?.trim() || DEFAULT_TASK_NOTIFICATION_CHANNEL_OPTIONS.webBaseUrl,
  };
}

/** 通知类型的中文标签（外部消息里的抬头，不暴露内部枚举）。 */
export const TASK_NOTIFICATION_KIND_LABELS: Record<TaskNotificationKind, string> = {
  task_assigned: "新任务",
  task_claimed: "任务已被承接",
  handoff_requested: "待你签收交接",
  handoff_responded: "交接结果",
  review_requested: "待你验收",
  review_decided: "验收结果",
  task_due_soon: "任务临期",
  task_overdue: "任务已逾期",
  task_blocked: "任务阻塞待处置",
};

export type TaskNotificationChannelSource = {
  listRecent(input: { tenantId: string; sinceIso: string; limit: number }): Promise<TaskNotificationCandidate[]>;
};

export type ChannelRecipientDirectory = {
  resolve(tenantId: string, recipientIds: string[], providers?: readonly ExternalProvider[]): Promise<Map<string, ChannelTarget[]>>;
};

export type ChannelPreferenceDirectory = {
  list(tenantId: string, userIds: string[]): Promise<Map<string, ChannelPreference>>;
};

/** 一次投递的最终结果（与应用层解耦：基础设施侧按连接构造连接器，应用层只关心结果与分类）。 */
export type ChannelSendOutcome = {
  status: "delivered" | "retry_scheduled" | "failed" | "unknown";
  provider: ExternalProvider;
  attempts: number;
  errorCategory?: string;
  nextAttemptAt?: string;
  externalMessageId?: string;
};

/**
 * 投递通道（端口）。基础设施实现负责"按目标连接的 provider 构造连接器"，
 * 因为出站凭据与传输都是按连接（connection）而不是按 provider 配置的。
 * 它还负责换通道策略：只有**已知不可重试**的失败才试下一个通道；限流/结果未知一律不换，
 * 避免"第一条其实发出去了、又换通道发第二条"这种重复打扰。
 */
export interface TaskNotificationChannelSender {
  /** 已经投递成功的键直接返回，避免每轮重复发送。 */
  existing(tenantId: string, deliveryKey: string): Promise<ChannelSendOutcome | null>;
  send(input: { tenantId: string; deliveryKey: string; recipientId: string; message: { type: "info"; title: string; text: string; deepLink?: string }; targets: ChannelTarget[] }): Promise<ChannelSendOutcome>;
}

export type TaskNotificationDispatchItem = {
  notificationId: string;
  recipientId: string;
  kind: TaskNotificationKind;
  outcome: "delivered" | "retry_scheduled" | "failed" | "unknown" | "already_delivered" | "skipped" | "deferred";
  reason?: string;
  provider?: ExternalProvider;
  errorCategory?: string;
};

export type TaskNotificationDispatchSummary = {
  enabled: boolean;
  scanned: number;
  delivered: number;
  alreadyDelivered: number;
  retryScheduled: number;
  failed: number;
  unknown: number;
  skipped: number;
  deferred: number;
  items: TaskNotificationDispatchItem[];
  ranAt: string;
};

/** 免打扰：支持跨午夜的窗口；时区用固定偏移表达（当前不引入时区库）。 */
export function inQuietHours(preference: ChannelPreference | undefined, now: Date): boolean {
  const quiet = preference?.quietHours;
  if (!quiet || !quiet.start || !quiet.end) return false;
  const offsetMinutes = quiet.timezoneOffsetMinutes ?? 0;
  const minutes = ((now.getUTCHours() * 60 + now.getUTCMinutes() + offsetMinutes) % 1_440 + 1_440) % 1_440;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === null || end === null || start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function toMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * 用户偏好的通道顺序 ∩ 该用户真正绑定且连接可用的通道，结果**按偏好顺序排列**（排在前面的先试）。
 * 默认偏好是 `["web"]`（只有站内），因此"没表过态"的用户不会被外部打扰。
 */
export function eligibleTargets(preference: ChannelPreference | undefined, targets: ChannelTarget[], enabledProviders: readonly ExternalProvider[]): ChannelTarget[] {
  const ordered = preference?.orderedProviders ?? ["web"];
  const rank = new Map<ExternalProvider, number>();
  for (const value of ordered) {
    if (enabledProviders.includes(value as ExternalProvider) && !rank.has(value as ExternalProvider)) rank.set(value as ExternalProvider, rank.size);
  }
  return targets
    .filter((target) => rank.has(target.provider))
    .sort((left, right) => rank.get(left.provider)! - rank.get(right.provider)!);
}

export class TaskNotificationChannelDispatcher {
  constructor(
    private readonly source: TaskNotificationChannelSource,
    private readonly directory: ChannelRecipientDirectory,
    private readonly preferences: ChannelPreferenceDirectory,
    private readonly sender: TaskNotificationChannelSender,
    private readonly options: TaskNotificationChannelOptions = DEFAULT_TASK_NOTIFICATION_CHANNEL_OPTIONS,
  ) {}

  async dispatchTenant(input: { tenantId: string; now?: Date }): Promise<TaskNotificationDispatchSummary> {
    const now = input.now ?? new Date();
    const summary: TaskNotificationDispatchSummary = { enabled: this.options.enabled, scanned: 0, delivered: 0, alreadyDelivered: 0, retryScheduled: 0, failed: 0, unknown: 0, skipped: 0, deferred: 0, items: [], ranAt: now.toISOString() };
    if (!this.options.enabled) return summary;

    const sinceIso = new Date(now.getTime() - this.options.lookbackMinutes * 60_000).toISOString();
    const candidates = await this.source.listRecent({ tenantId: input.tenantId, sinceIso, limit: this.options.batchSize });
    summary.scanned = candidates.length;
    if (!candidates.length) return summary;

    const recipientIds = [...new Set(candidates.map((item) => item.recipientId))];
    const [targets, preferences] = await Promise.all([
      this.directory.resolve(input.tenantId, recipientIds, this.providers),
      this.preferences.list(input.tenantId, recipientIds),
    ]);

    for (const candidate of candidates) {
      const bound = targets.get(candidate.recipientId) ?? [];
      if (!bound.length) {
        summary.skipped += 1;
        summary.items.push({ notificationId: candidate.id, recipientId: candidate.recipientId, kind: candidate.kind, outcome: "skipped", reason: "NO_BOUND_CHANNEL" });
        continue;
      }
      const eligible = eligibleTargets(preferences.get(candidate.recipientId), bound, this.providers);
      if (!eligible.length) {
        summary.skipped += 1;
        summary.items.push({ notificationId: candidate.id, recipientId: candidate.recipientId, kind: candidate.kind, outcome: "skipped", reason: "CHANNEL_NOT_OPTED_IN" });
        continue;
      }
      if (inQuietHours(preferences.get(candidate.recipientId), now)) {
        summary.deferred += 1;
        summary.items.push({ notificationId: candidate.id, recipientId: candidate.recipientId, kind: candidate.kind, outcome: "deferred", reason: "QUIET_HOURS" });
        continue;
      }

      const deliveryKey = taskNotificationDeliveryKey(candidate.id);
      const existing = await this.sender.existing(input.tenantId, deliveryKey);
      if (existing?.status === "delivered") {
        summary.alreadyDelivered += 1;
        summary.items.push({ notificationId: candidate.id, recipientId: candidate.recipientId, kind: candidate.kind, outcome: "already_delivered", provider: existing.provider });
        continue;
      }

      const outcome = await this.sender.send({
        tenantId: input.tenantId,
        deliveryKey,
        recipientId: candidate.recipientId,
        message: renderTaskNotificationMessage(candidate, this.options.webBaseUrl),
        targets: eligible,
      });
      const item: TaskNotificationDispatchItem = {
        notificationId: candidate.id,
        recipientId: candidate.recipientId,
        kind: candidate.kind,
        outcome: outcome.status,
        provider: outcome.provider,
        errorCategory: outcome.errorCategory,
      };
      summary.items.push(item);
      if (item.outcome === "delivered") summary.delivered += 1;
      else if (item.outcome === "retry_scheduled") summary.retryScheduled += 1;
      else if (item.outcome === "failed") summary.failed += 1;
      else summary.unknown += 1;
    }
    return summary;
  }

  private readonly providers: readonly ExternalProvider[] = ["feishu", "dingtalk", "wecom"];
}

/** 投递键：与站内通知 ID 一一对应，落到 `connector_deliveries` 的 `(tenant_id, notification_id)` 唯一约束。 */
export function taskNotificationDeliveryKey(notificationId: string): string {
  return `task-notification:${notificationId}`;
}

export function renderTaskNotificationMessage(candidate: TaskNotificationCandidate, webBaseUrl: string) {
  return {
    type: "info" as const,
    title: `【枢纽任务】${TASK_NOTIFICATION_KIND_LABELS[candidate.kind] ?? "任务提醒"}`,
    text: `${candidate.title}\n${candidate.body}`,
    deepLink: `${webBaseUrl.replace(/\/+$/, "")}/?view=command`,
  };
}
