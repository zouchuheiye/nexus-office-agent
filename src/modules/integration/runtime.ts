import { IntegrationAcceptanceService } from "@/src/modules/integration/application/acceptance";
import { ChannelPreferenceService, InMemoryChannelPreferenceRepository } from "@/src/modules/integration/application/channel-preferences";
import { TestNotificationService } from "@/src/modules/integration/application/test-notification";
import { WecomAccessControlService } from "@/src/modules/integration/application/wecom-access-control";
import { WecomApplicationMessageService } from "@/src/modules/integration/application/wecom-application-message";
import { createRuntimeConnectorAcceptanceProbe, createRuntimeIdentityAcceptanceProbe } from "@/src/modules/integration/infrastructure/acceptance-probes";
import { getDevelopmentAcceptanceRepository, PostgresAcceptanceRepository } from "@/src/modules/integration/infrastructure/acceptance-repository";
import { PostgresChannelPreferenceRepository } from "@/src/modules/integration/infrastructure/postgres-task-notification-channel";
import { createRuntimeTestNotificationGateway } from "@/src/modules/integration/infrastructure/test-notification-gateway";
import { getDevelopmentTestNotificationProposalRepository, PostgresTestNotificationProposalRepository } from "@/src/modules/integration/infrastructure/test-notification-repository";
import { RuntimeWecomAppControlGateway } from "@/src/modules/integration/infrastructure/wecom-app-control-gateway";
import { RuntimeWecomApplicationMessageGateway } from "@/src/modules/integration/infrastructure/wecom-application-message-gateway";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { moduleRuntime } from "@/src/platform/runtime/module-runtime";

const runtimeGeneration = Symbol("integration");

/**
 * 通知通道偏好（自服务）：有库走 `channel_preferences`，没有库（开发内存模式）走内存仓储。
 * 与外部通道投递共用同一张表，保证"用户看到的偏好"与"worker 实际遵循的偏好"是同一份。
 */
export function getChannelPreferenceService(): ChannelPreferenceService {
  return moduleRuntime("integration.channel-preferences", runtimeGeneration, () => {
    const repository = process.env.DATABASE_URL
      ? new PostgresChannelPreferenceRepository(createPostgresDatabase(process.env.DATABASE_URL))
      : getDevelopmentChannelPreferenceRepository();
    return new ChannelPreferenceService(repository);
  });
}

function getDevelopmentChannelPreferenceRepository(): InMemoryChannelPreferenceRepository {
  const runtime = globalThis as typeof globalThis & { __nexusChannelPreferenceRepository?: InMemoryChannelPreferenceRepository };
  runtime.__nexusChannelPreferenceRepository ??= new InMemoryChannelPreferenceRepository();
  return runtime.__nexusChannelPreferenceRepository;
}

export function getIntegrationAcceptanceService(): IntegrationAcceptanceService {
  return moduleRuntime("integration.acceptance", runtimeGeneration, () => {
    const repository = process.env.DATABASE_URL
      ? new PostgresAcceptanceRepository(createPostgresDatabase(process.env.DATABASE_URL))
      : getDevelopmentAcceptanceRepository();
    return new IntegrationAcceptanceService(
      repository,
      createRuntimeIdentityAcceptanceProbe(),
      createRuntimeConnectorAcceptanceProbe(),
    );
  });
}

export function getWecomApplicationMessageService(): WecomApplicationMessageService {
  return moduleRuntime("integration.wecom-message", runtimeGeneration, () => {
    const repository = process.env.DATABASE_URL
      ? new PostgresAcceptanceRepository(createPostgresDatabase(process.env.DATABASE_URL))
      : getDevelopmentAcceptanceRepository();
    return new WecomApplicationMessageService(
      repository,
      new RuntimeWecomApplicationMessageGateway(),
    );
  });
}

export function getTestNotificationService(): TestNotificationService {
  return moduleRuntime("integration.test-notification", runtimeGeneration, () => {
    if (process.env.DATABASE_URL) {
      const database = createPostgresDatabase(process.env.DATABASE_URL);
      return new TestNotificationService(
        new PostgresAcceptanceRepository(database),
        new PostgresTestNotificationProposalRepository(database),
        createRuntimeTestNotificationGateway(database),
      );
    }
    return new TestNotificationService(
      getDevelopmentAcceptanceRepository(),
      getDevelopmentTestNotificationProposalRepository(),
      createRuntimeTestNotificationGateway(),
    );
  });
}

export function getWecomAccessControlService(): WecomAccessControlService {
  return moduleRuntime("integration.wecom-access", runtimeGeneration, () => {
    const repository = process.env.DATABASE_URL
      ? new PostgresAcceptanceRepository(createPostgresDatabase(process.env.DATABASE_URL))
      : getDevelopmentAcceptanceRepository();
    return new WecomAccessControlService(
      repository,
      new RuntimeWecomAppControlGateway(),
    );
  });
}
