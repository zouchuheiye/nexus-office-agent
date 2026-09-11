import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import { ConnectorRegistry } from "@/src/modules/integration/application/connector-registry";
import type { ChannelSendOutcome, ChannelTarget, TaskNotificationChannelSender } from "@/src/modules/integration/application/task-notification-channel";
import { NotificationRouter, type NotificationDeliveryStore } from "@/src/modules/integration/application/notification-router";
import { AuthenticatedConnectorTransport } from "@/src/modules/integration/infrastructure/authenticated-transport";
import { DingtalkConnector, FeishuConnector, InMemoryConnectorControlPlane, WecomConnector } from "@/src/modules/integration/infrastructure/platform-connector";
import { AccessTokenBroker, EnvironmentOutgoingCredentialSource, FetchRawHttpClient } from "@/src/modules/integration/infrastructure/token-broker";
import { requireWecomAgentId } from "@/src/platform/config/wecom-environment";

/**
 * 出站通道的真实实现。
 *
 * 为什么按连接构造连接器：出站凭据与传输（`AuthenticatedConnectorTransport` + `AccessTokenBroker`）
 * 都是"按连接"配置的，而 `ConnectorRegistry` 只能按 provider 索引；因此每个目标连接单独构造
 * 一个 registry + router，再复用 `NotificationRouter` 的幂等台账（`connector_deliveries`）。
 *
 * 换通道策略：**只有已知不可重试的失败才试下一个通道**（例如连接未配置、凭据缺失、目标不存在）。
 * 限流（`RATE_LIMITED`）与"结果未知"一律不换通道——否则第一条消息其实已经发出去了，
 * 换通道再发一条就会造成重复打扰。这与 `NotificationRouter` 自身的处理保持一致。
 */
export class RuntimeTaskNotificationChannelSender implements TaskNotificationChannelSender {
  private readonly http = new FetchRawHttpClient();
  private readonly tokens = new AccessTokenBroker(new EnvironmentOutgoingCredentialSource(), this.http);
  private readonly controlPlane = new InMemoryConnectorControlPlane();

  constructor(
    private readonly store: NotificationDeliveryStore,
    private readonly createRegistry: (target: ChannelTarget) => ConnectorRegistry = (target) => this.connectionRegistry(target),
  ) {}

  async existing(tenantId: string, deliveryKey: string): Promise<ChannelSendOutcome | null> {
    const delivery = await this.store.get(tenantId, deliveryKey);
    if (!delivery) return null;
    return {
      status: delivery.status === "delivered" ? "delivered" : delivery.status === "retry_scheduled" ? "retry_scheduled" : delivery.status === "failed" ? "failed" : "unknown",
      provider: delivery.provider,
      attempts: delivery.attempts,
      errorCategory: delivery.errorCategory,
      nextAttemptAt: delivery.nextAttemptAt,
      externalMessageId: delivery.receipt?.externalMessageId,
    };
  }

  async send(input: { tenantId: string; deliveryKey: string; recipientId: string; message: { type: "info"; title: string; text: string; deepLink?: string }; targets: ChannelTarget[] }): Promise<ChannelSendOutcome> {
    let last: ChannelSendOutcome | null = null;
    for (const target of input.targets) {
      const router = new NotificationRouter(this.createRegistry(target), this.store);
      const delivery = await router.deliver({
        id: input.deliveryKey,
        tenantId: input.tenantId,
        userId: input.recipientId,
        message: input.message,
        providers: [target],
      });
      const outcome: ChannelSendOutcome = {
        status: delivery.status === "delivered" ? "delivered" : delivery.status === "retry_scheduled" ? "retry_scheduled" : delivery.status === "failed" ? "failed" : "unknown",
        provider: delivery.provider,
        attempts: delivery.attempts,
        errorCategory: delivery.errorCategory,
        nextAttemptAt: delivery.nextAttemptAt,
        externalMessageId: delivery.receipt?.externalMessageId,
      };
      if (outcome.status === "delivered") return outcome;
      // 结果未知或已排定重试：不再试下一个通道，避免重复投递。
      if (outcome.status !== "failed") return outcome;
      last = outcome;
    }
    if (!last) throw new Error("TASK_NOTIFICATION_CHANNEL_NO_TARGET");
    return last;
  }

  private connectionRegistry(target: ChannelTarget): ConnectorRegistry {
    const registry = new ConnectorRegistry();
    const transport = new AuthenticatedConnectorTransport(target.provider, target.connectionId, this.tokens, this.http);
    registry.register(createConnector(target.provider, transport, this.controlPlane));
    return registry;
  }
}

export function createConnector(provider: ExternalProvider, transport: ConstructorParameters<typeof FeishuConnector>[0], controlPlane: ConstructorParameters<typeof FeishuConnector>[1]) {
  if (provider === "feishu") return new FeishuConnector(transport, controlPlane);
  if (provider === "dingtalk") return new DingtalkConnector(transport, controlPlane);
  return new WecomConnector(transport, controlPlane, requireWecomAgentId());
}
