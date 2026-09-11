// Requirements: PR-009, PR-010, MR-046, MR-049, AC-012（P4：站内通知的外部通道投递）
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_NOTIFICATION_CHANNEL_OPTIONS,
  TaskNotificationChannelDispatcher,
  eligibleTargets,
  inQuietHours,
  renderTaskNotificationMessage,
  taskNotificationChannelOptionsFromEnv,
  taskNotificationDeliveryKey,
  type ChannelSendOutcome,
  type ChannelTarget,
  type TaskNotificationCandidate,
  type TaskNotificationChannelSender,
} from "@/src/modules/integration/application/task-notification-channel";
import type { ChannelPreference } from "@/src/modules/integration/application/channel-preferences";

const TENANT = "00000000-0000-4000-8000-000000000001";
const RECIPIENT = "10000000-0000-4000-8000-000000000003";
const CONNECTION = "90000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-10T09:00:00.000Z");

const options = { ...DEFAULT_TASK_NOTIFICATION_CHANNEL_OPTIONS, enabled: true, lookbackMinutes: 60, batchSize: 10, webBaseUrl: "http://localhost:3000/" };

function candidate(overrides: Partial<TaskNotificationCandidate> = {}): TaskNotificationCandidate {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    recipientId: RECIPIENT,
    kind: "task_assigned",
    title: "新任务：机房巡检",
    body: "你被指定为负责人，截止 2026-09-20。",
    packageId: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-09-10T08:59:00.000Z",
    ...overrides,
  };
}

type Sent = { deliveryKey: string; recipientId: string; targets: ChannelTarget[]; message: { type: string; title?: string; text: string; deepLink?: string } };

function harness(input: {
  candidates?: TaskNotificationCandidate[];
  targets?: Map<string, ChannelTarget[]>;
  preferences?: Map<string, ChannelPreference>;
  existing?: ChannelSendOutcome | null;
  outcome?: ChannelSendOutcome;
  enabled?: boolean;
} = {}) {
  const sent: Sent[] = [];
  const sourceCalls: Array<{ tenantId: string; sinceIso: string; limit: number }> = [];
  const source = {
    async listRecent(request: { tenantId: string; sinceIso: string; limit: number }) {
      sourceCalls.push(request);
      return input.candidates ?? [candidate()];
    },
  };
  const directory = { async resolve() { return input.targets ?? new Map([[RECIPIENT, [{ provider: "wecom" as const, connectionId: CONNECTION, externalUserId: "zhouran" }]]]); } };
  const preferences = { async list() { return input.preferences ?? new Map([[RECIPIENT, { tenantId: TENANT, userId: RECIPIENT, orderedProviders: ["wecom" as const], quietHours: {}, digestEnabled: true, updatedAt: NOW.toISOString() }]]); } };
  const sender: TaskNotificationChannelSender = {
    async existing() { return input.existing ?? null; },
    async send(request) {
      sent.push({ deliveryKey: request.deliveryKey, recipientId: request.recipientId, targets: request.targets, message: request.message });
      return input.outcome ?? { status: "delivered", provider: "wecom", attempts: 1, externalMessageId: "msg-1" };
    },
  };
  const dispatcher = new TaskNotificationChannelDispatcher(source, directory, preferences, sender, { ...options, enabled: input.enabled ?? options.enabled });
  return { dispatcher, sent, sourceCalls };
}

describe("P4 站内通知的外部通道投递", () => {
  it("总开关关闭时不扫描、不投递（失败关闭）", async () => {
    const { dispatcher, sent, sourceCalls } = harness({ enabled: false });
    const summary = await dispatcher.dispatchTenant({ tenantId: TENANT, now: NOW });

    expect(summary).toMatchObject({ enabled: false, scanned: 0, delivered: 0 });
    expect(sourceCalls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("收件人没有绑定外部通道时跳过并给出原因", async () => {
    const { dispatcher, sent } = harness({ targets: new Map() });
    const summary = await dispatcher.dispatchTenant({ tenantId: TENANT, now: NOW });

    expect(summary).toMatchObject({ scanned: 1, skipped: 1, delivered: 0 });
    expect(summary.items[0]).toMatchObject({ outcome: "skipped", reason: "NO_BOUND_CHANNEL" });
    expect(sent).toEqual([]);
  });

  it("默认偏好只走站内：没有显式 opt-in 就不发外部消息", async () => {
    const { dispatcher, sent } = harness({
      preferences: new Map([[RECIPIENT, { tenantId: TENANT, userId: RECIPIENT, orderedProviders: ["web"], quietHours: {}, digestEnabled: true, updatedAt: NOW.toISOString() }]]),
    });
    const summary = await dispatcher.dispatchTenant({ tenantId: TENANT, now: NOW });

    expect(summary.items[0]).toMatchObject({ outcome: "skipped", reason: "CHANNEL_NOT_OPTED_IN" });
    expect(sent).toEqual([]);
  });

  it("opt-in 且身份已验证时投递出去：消息带抬头/正文/深链，投递键与站内通知一一对应", async () => {
    const { dispatcher, sent, sourceCalls } = harness();
    const summary = await dispatcher.dispatchTenant({ tenantId: TENANT, now: NOW });

    expect(summary).toMatchObject({ scanned: 1, delivered: 1, failed: 0, skipped: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0].deliveryKey).toBe(taskNotificationDeliveryKey(candidate().id));
    expect(sent[0].recipientId).toBe(RECIPIENT);
    expect(sent[0].targets).toEqual([{ provider: "wecom", connectionId: CONNECTION, externalUserId: "zhouran" }]);
    expect(sent[0].message).toMatchObject({ type: "info", title: "【枢纽任务】新任务", text: "新任务：机房巡检\n你被指定为负责人，截止 2026-09-20。", deepLink: "http://localhost:3000/?view=command" });
    // 扫描窗口与批量上限来自配置（只投最近 N 分钟内的通知）。
    expect(sourceCalls[0]).toEqual({ tenantId: TENANT, sinceIso: "2026-09-10T08:00:00.000Z", limit: 10 });
  });

  it("免打扰命中时本轮不投递，窗口外恢复投递", async () => {
    const quiet = new Map([[RECIPIENT, { tenantId: TENANT, userId: RECIPIENT, orderedProviders: ["wecom" as const], quietHours: { start: "20:00", end: "08:00", timezoneOffsetMinutes: 480 }, digestEnabled: true, updatedAt: NOW.toISOString() }]]);
    // NOW = 2026-09-10T09:00Z → 东八区 17:00，不在 20:00-08:00 窗口内。
    const daytime = harness({ preferences: quiet });
    expect(await daytime.dispatcher.dispatchTenant({ tenantId: TENANT, now: NOW })).toMatchObject({ delivered: 1, deferred: 0 });

    const nighttime = harness({ preferences: quiet });
    const summary = await nighttime.dispatcher.dispatchTenant({ tenantId: TENANT, now: new Date("2026-09-10T14:00:00.000Z") });
    expect(summary).toMatchObject({ delivered: 0, deferred: 1 });
    expect(summary.items[0]).toMatchObject({ outcome: "deferred", reason: "QUIET_HOURS" });
    expect(nighttime.sent).toEqual([]);
  });

  it("已经投递成功的通知不再重复发送", async () => {
    const { dispatcher, sent } = harness({ existing: { status: "delivered", provider: "wecom", attempts: 1, externalMessageId: "msg-1" } });
    const summary = await dispatcher.dispatchTenant({ tenantId: TENANT, now: NOW });

    expect(summary).toMatchObject({ alreadyDelivered: 1, delivered: 0 });
    expect(summary.items[0]).toMatchObject({ outcome: "already_delivered", provider: "wecom" });
    expect(sent).toEqual([]);
  });

  it("投递失败与限流分别记成 failed / retry_scheduled，并保留错误分类", async () => {
    const failed = harness({ outcome: { status: "failed", provider: "wecom", attempts: 1, errorCategory: "CONFIG_REQUIRED:WECOM_CORP_SECRET" } });
    expect((await failed.dispatcher.dispatchTenant({ tenantId: TENANT, now: NOW })).items[0]).toMatchObject({ outcome: "failed", errorCategory: "CONFIG_REQUIRED:WECOM_CORP_SECRET" });

    const limited = harness({ outcome: { status: "retry_scheduled", provider: "wecom", attempts: 2, errorCategory: "RATE_LIMITED", nextAttemptAt: "2026-09-10T09:05:00.000Z" } });
    const summary = await limited.dispatcher.dispatchTenant({ tenantId: TENANT, now: NOW });
    expect(summary).toMatchObject({ retryScheduled: 1, delivered: 0, failed: 0 });
  });

  it("没有候选时不做任何投递", async () => {
    const { dispatcher, sent } = harness({ candidates: [] });
    expect(await dispatcher.dispatchTenant({ tenantId: TENANT, now: NOW })).toMatchObject({ scanned: 0, delivered: 0 });
    expect(sent).toEqual([]);
  });

  it("偏好顺序决定优先级，未绑定的通道被忽略", () => {
    const targets: ChannelTarget[] = [
      { provider: "wecom", connectionId: CONNECTION, externalUserId: "u-wecom" },
      { provider: "feishu", connectionId: CONNECTION, externalUserId: "u-feishu" },
    ];
    const preference: ChannelPreference = { tenantId: TENANT, userId: RECIPIENT, orderedProviders: ["feishu", "wecom"], quietHours: {}, digestEnabled: true, updatedAt: NOW.toISOString() };
    expect(eligibleTargets(preference, targets, ["feishu", "dingtalk", "wecom"]).map((item) => item.provider)).toEqual(["feishu", "wecom"]);
    // 偏好里只有 web（默认）时，外部通道全部不可用。
    expect(eligibleTargets({ ...preference, orderedProviders: ["web"] }, targets, ["feishu", "dingtalk", "wecom"])).toEqual([]);
    expect(eligibleTargets(undefined, targets, ["feishu", "dingtalk", "wecom"])).toEqual([]);
  });

  it("免打扰窗口跨午夜也能判定，未设置窗口时永远不进入免打扰", () => {
    const preference: ChannelPreference = { tenantId: TENANT, userId: RECIPIENT, orderedProviders: ["web"], quietHours: { start: "22:00", end: "07:00" }, digestEnabled: true, updatedAt: NOW.toISOString() };
    expect(inQuietHours(preference, new Date("2026-09-10T23:30:00.000Z"))).toBe(true);
    expect(inQuietHours(preference, new Date("2026-09-10T06:59:00.000Z"))).toBe(true);
    expect(inQuietHours(preference, new Date("2026-09-10T07:00:00.000Z"))).toBe(false);
    expect(inQuietHours(preference, new Date("2026-09-10T12:00:00.000Z"))).toBe(false);
    expect(inQuietHours({ ...preference, quietHours: {} }, new Date("2026-09-10T23:30:00.000Z"))).toBe(false);
  });

  it("环境变量映射：默认关闭，只有显式 enabled 才打开", () => {
    expect(taskNotificationChannelOptionsFromEnv({})).toMatchObject({ enabled: false, lookbackMinutes: 60, batchSize: 50 });
    expect(taskNotificationChannelOptionsFromEnv({ TASK_NOTIFICATION_CHANNELS: "enabled", TASK_NOTIFICATION_CHANNEL_LOOKBACK_MINUTES: "15", TASK_NOTIFICATION_CHANNEL_BATCH: "5", NEXUS_WEB_BASE_URL: "https://office.example.com/" }))
      .toEqual({ enabled: true, lookbackMinutes: 15, batchSize: 5, webBaseUrl: "https://office.example.com/" });
    expect(taskNotificationChannelOptionsFromEnv({ TASK_NOTIFICATION_CHANNELS: "true" }).enabled).toBe(false);
    expect(() => taskNotificationChannelOptionsFromEnv({ TASK_NOTIFICATION_CHANNEL_BATCH: "0" })).toThrow("TASK_NOTIFICATION_CHANNEL_CONFIG_INVALID");
  });

  it("消息渲染：类型标签用中文，深链去掉重复斜杠", () => {
    const message = renderTaskNotificationMessage(candidate({ kind: "task_overdue" }), "https://office.example.com///");
    expect(message.title).toBe("【枢纽任务】任务已逾期");
    expect(message.deepLink).toBe("https://office.example.com/?view=command");
  });
});
