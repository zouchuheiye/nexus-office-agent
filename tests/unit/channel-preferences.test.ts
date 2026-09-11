// Requirements: PR-009, MR-049（P4：通知通道偏好）
import { describe, expect, it } from "vitest";
import {
  CHANNEL_PROVIDERS,
  ChannelPreferenceService,
  InMemoryChannelPreferenceRepository,
  channelPreferenceInputSchema,
} from "@/src/modules/integration/application/channel-preferences";
import { createDevelopmentRequestContext } from "@/src/platform/context/development-context";

const NOW = new Date("2026-09-10T09:00:00.000Z");

function service() {
  const repository = new InMemoryChannelPreferenceRepository();
  return { repository, service: new ChannelPreferenceService(repository, () => NOW) };
}

describe("P4 通知通道偏好", () => {
  it("没设置过时返回默认值：只走站内，configured=false", async () => {
    const { service: preferences } = service();
    const context = createDevelopmentRequestContext("channel-preference-default");
    const view = await preferences.get(context);

    expect(view).toMatchObject({ orderedProviders: ["web"], quietHours: {}, digestEnabled: true, updatedAt: null, configured: false });
    expect(view.availableProviders).toEqual([...CHANNEL_PROVIDERS]);
  });

  it("写入后按顺序与去重生效，并且只写本人", async () => {
    const { repository, service: preferences } = service();
    const context = createDevelopmentRequestContext("channel-preference-write");
    const view = await preferences.update(context, { orderedProviders: ["wecom", "wecom", "web"], quietHours: { start: "22:00", end: "07:00", timezoneOffsetMinutes: 480 }, digestEnabled: false });

    expect(view).toMatchObject({ orderedProviders: ["wecom", "web"], digestEnabled: false, configured: true, updatedAt: NOW.toISOString() });
    expect(view.quietHours).toEqual({ start: "22:00", end: "07:00", timezoneOffsetMinutes: 480 });
    const stored = await repository.get(context.tenantId, context.actorId);
    expect(stored).toMatchObject({ userId: context.actorId, orderedProviders: ["wecom", "web"] });
  });

  it("不传 quietHours 时保留原窗口，传 null 表示清空", async () => {
    const { service: preferences } = service();
    const context = createDevelopmentRequestContext("channel-preference-quiet");
    await preferences.update(context, { orderedProviders: ["wecom"], quietHours: { start: "22:00", end: "07:00" } });

    const kept = await preferences.update(context, { orderedProviders: ["wecom", "web"] });
    expect(kept.quietHours).toEqual({ start: "22:00", end: "07:00" });
    const cleared = await preferences.update(context, { orderedProviders: ["web"], quietHours: null });
    expect(cleared.quietHours).toEqual({});
  });

  it("只填了开始或结束时间时显式报错（不静默当成没有免打扰）", async () => {
    const { service: preferences } = service();
    const context = createDevelopmentRequestContext("channel-preference-partial");
    await expect(preferences.update(context, { orderedProviders: ["web"], quietHours: { start: "22:00" } })).rejects.toThrow("CHANNEL_PREFERENCE_QUIET_HOURS_INCOMPLETE");
    await expect(preferences.update(context, { orderedProviders: ["web"], quietHours: { end: "07:00" } })).rejects.toThrow("CHANNEL_PREFERENCE_QUIET_HOURS_INCOMPLETE");
  });

  it("schema 拦住未知通道、空名单、非法时间与多余字段", () => {
    expect(channelPreferenceInputSchema.safeParse({ orderedProviders: ["web", "feishu"] }).success).toBe(true);
    expect(channelPreferenceInputSchema.safeParse({ orderedProviders: ["slack"] }).success).toBe(false);
    expect(channelPreferenceInputSchema.safeParse({ orderedProviders: [] }).success).toBe(false);
    expect(channelPreferenceInputSchema.safeParse({ orderedProviders: ["web"], quietHours: { start: "25:00", end: "07:00" } }).success).toBe(false);
    expect(channelPreferenceInputSchema.safeParse({ orderedProviders: ["web"], quietHours: { start: "22:00", end: "7:00" } }).success).toBe(false);
    expect(channelPreferenceInputSchema.safeParse({ orderedProviders: ["web"], timezoneOffsetMinutes: 480 }).success).toBe(false);
    expect(channelPreferenceInputSchema.safeParse({ orderedProviders: ["web"], userId: "someone-else" }).success).toBe(false);
    expect(channelPreferenceInputSchema.safeParse({ orderedProviders: ["web"], quietHours: { start: "22:00", end: "07:00", timezoneOffsetMinutes: 99999 } }).success).toBe(false);
  });

  it("两个身份各写各的，互不影响", async () => {
    const { service: preferences } = service();
    const manager = createDevelopmentRequestContext("channel-preference-manager");
    const delivery = { ...createDevelopmentRequestContext("channel-preference-delivery"), actorId: "10000000-0000-4000-8000-000000000002" };
    await preferences.update(manager, { orderedProviders: ["web"] });
    await preferences.update(delivery, { orderedProviders: ["dingtalk"] });

    expect((await preferences.get(manager)).orderedProviders).toEqual(["web"]);
    expect((await preferences.get(delivery)).orderedProviders).toEqual(["dingtalk"]);
  });
});
