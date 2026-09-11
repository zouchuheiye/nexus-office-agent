// Requirements: PR-010, MR-049（P4：出站换通道策略与投递台账）
import { describe, expect, it } from "vitest";
import { ConnectorRegistry } from "@/src/modules/integration/application/connector-registry";
import { InMemoryNotificationDeliveryStore } from "@/src/modules/integration/application/notification-router";
import { RuntimeTaskNotificationChannelSender } from "@/src/modules/integration/infrastructure/task-notification-channel-sender";
import { ConnectorDeliveryError } from "@/src/modules/integration/infrastructure/platform-connector";
import type { CollaborationConnector, ExternalReceipt, SendMessageCommand } from "@/src/modules/integration/domain/connector";
import type { ChannelTarget } from "@/src/modules/integration/application/task-notification-channel";
import type { ExternalProvider } from "@/src/modules/identity/domain/entities";

const TENANT = "00000000-0000-4000-8000-000000000001";
const RECIPIENT = "10000000-0000-4000-8000-000000000003";
const CONNECTION = "90000000-0000-4000-8000-000000000001";
const MESSAGE = { type: "info" as const, title: "【枢纽任务】新任务", text: "新任务：机房巡检", deepLink: "http://localhost:3000/?view=command" };

function target(provider: ExternalProvider): ChannelTarget {
  return { provider, connectionId: CONNECTION, externalUserId: `${provider}-user` };
}

/** 用假连接器替换真实传输：只验证换通道策略与台账幂等，不碰网络。 */
function senderWith(behaviour: Map<ExternalProvider, { receipt?: boolean; error?: Error }>) {
  const store = new InMemoryNotificationDeliveryStore();
  const sent: ExternalProvider[] = [];
  const sender = new RuntimeTaskNotificationChannelSender(store, (item) => {
    const registry = new ConnectorRegistry();
    const plan = behaviour.get(item.provider);
    registry.register({
      provider: item.provider,
      capabilities: new Set(["message.send"]),
      async sendMessage(command: SendMessageCommand): Promise<ExternalReceipt> {
        sent.push(item.provider);
        void command;
        if (plan?.error) throw plan.error;
        return { externalMessageId: `msg-${item.provider}`, acceptedAt: new Date().toISOString(), status: "accepted" };
      },
    } as unknown as CollaborationConnector);
    return registry;
  });
  return { sender, store, sent };
}

describe("P4 外部通道换通道策略", () => {
  it("首个通道成功即止，不重复打扰", async () => {
    const { sender, store, sent } = senderWith(new Map([["feishu", { receipt: true }], ["wecom", { receipt: true }]]));
    const outcome = await sender.send({ tenantId: TENANT, deliveryKey: "task-notification:n1", recipientId: RECIPIENT, message: MESSAGE, targets: [target("feishu"), target("wecom")] });

    expect(outcome).toMatchObject({ status: "delivered", provider: "feishu", attempts: 1, externalMessageId: "msg-feishu" });
    expect(sent).toEqual(["feishu"]);
    expect((await store.get(TENANT, "task-notification:n1"))?.status).toBe("delivered");
  });

  it("已知不可重试的失败会试下一个通道", async () => {
    const { sender, sent } = senderWith(new Map([
      ["feishu", { error: new ConnectorDeliveryError("CONFIG_REQUIRED:FEISHU_APP_SECRET") }],
      ["wecom", { receipt: true }],
    ]));
    const outcome = await sender.send({ tenantId: TENANT, deliveryKey: "task-notification:n2", recipientId: RECIPIENT, message: MESSAGE, targets: [target("feishu"), target("wecom")] });

    expect(outcome).toMatchObject({ status: "delivered", provider: "wecom" });
    expect(sent).toEqual(["feishu", "wecom"]);
  });

  it("限流不换通道：排定重试而不是换一条链路再发一次", async () => {
    const { sender, sent, store } = senderWith(new Map([
      ["feishu", { error: new ConnectorDeliveryError("RATE_LIMITED", 30) }],
      ["wecom", { receipt: true }],
    ]));
    const outcome = await sender.send({ tenantId: TENANT, deliveryKey: "task-notification:n3", recipientId: RECIPIENT, message: MESSAGE, targets: [target("feishu"), target("wecom")] });

    expect(outcome).toMatchObject({ status: "retry_scheduled", provider: "feishu", errorCategory: "RATE_LIMITED" });
    expect(outcome.nextAttemptAt).toBeDefined();
    expect(sent).toEqual(["feishu"]);
    // 台账记下排定重试：重复调用不会立刻再发。
    expect((await store.get(TENANT, "task-notification:n3"))?.status).toBe("retry_scheduled");
    const second = await sender.send({ tenantId: TENANT, deliveryKey: "task-notification:n3", recipientId: RECIPIENT, message: MESSAGE, targets: [target("feishu")] });
    expect(second).toMatchObject({ status: "retry_scheduled" });
    expect(sent).toEqual(["feishu"]);
  });

  it("全部通道都失败时返回最后一个失败分类", async () => {
    const { sender } = senderWith(new Map([
      ["feishu", { error: new ConnectorDeliveryError("CONFIG_REQUIRED:FEISHU_APP_SECRET") }],
      ["wecom", { error: new ConnectorDeliveryError("CONFIG_REQUIRED:WECOM_CORP_SECRET") }],
    ]));
    const outcome = await sender.send({ tenantId: TENANT, deliveryKey: "task-notification:n4", recipientId: RECIPIENT, message: MESSAGE, targets: [target("feishu"), target("wecom")] });

    expect(outcome).toMatchObject({ status: "failed", provider: "wecom", errorCategory: "CONFIG_REQUIRED:WECOM_CORP_SECRET" });
  });

  it("existing 读取台账：已投递成功时对外报告成功态", async () => {
    const { sender, store } = senderWith(new Map());
    await store.save({ tenantId: TENANT, notificationId: "task-notification:n5", provider: "dingtalk", connectionId: CONNECTION, status: "delivered", attempts: 1, receipt: { externalMessageId: "msg-dingtalk", acceptedAt: new Date().toISOString(), status: "accepted" } });

    expect(await sender.existing(TENANT, "task-notification:n5")).toMatchObject({ status: "delivered", provider: "dingtalk", externalMessageId: "msg-dingtalk" });
    expect(await sender.existing(TENANT, "task-notification:missing")).toBeNull();
  });

  it("没有可用通道时显式报错，而不是静默成功", async () => {
    const { sender } = senderWith(new Map());
    await expect(sender.send({ tenantId: TENANT, deliveryKey: "task-notification:n6", recipientId: RECIPIENT, message: MESSAGE, targets: [] })).rejects.toThrow("TASK_NOTIFICATION_CHANNEL_NO_TARGET");
  });
});
