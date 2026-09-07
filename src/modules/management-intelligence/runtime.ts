import { createRuntimeModelGateway } from "@/src/modules/agent/runtime";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { PostgresEventStore } from "@/src/modules/events/infrastructure/postgres-event-store";
import { ManagementIntelligenceService } from "@/src/modules/management-intelligence/application/service";
import { getDevelopmentManagementIntelligenceRepository, getDevelopmentManagementWecomGateway } from "@/src/modules/management-intelligence/infrastructure/in-memory-repository";
import { PostgresManagementIntelligenceRepository } from "@/src/modules/management-intelligence/infrastructure/postgres-repository";
import { createRuntimeManagementWecomGateway } from "@/src/modules/management-intelligence/infrastructure/wecom-gateway";
import type { TransactionalDatabase } from "@/src/platform/database/executor";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { moduleRuntime } from "@/src/platform/runtime/module-runtime";

function appBaseUrl() {
  return process.env.NEXUS_PUBLIC_APP_URL || process.env.PUBLIC_APP_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

export function createManagementIntelligenceService(database?: TransactionalDatabase): ManagementIntelligenceService {
  const productionDatabase = database ?? (process.env.DATABASE_URL ? createPostgresDatabase(process.env.DATABASE_URL) : undefined);
  if (productionDatabase) {
    return new ManagementIntelligenceService(
      new PostgresManagementIntelligenceRepository(productionDatabase),
      new PostgresEventStore(productionDatabase),
      createRuntimeModelGateway(),
      createRuntimeManagementWecomGateway(productionDatabase),
      { dataMode: "production", appBaseUrl: appBaseUrl() },
    );
  }
  return new ManagementIntelligenceService(
    getDevelopmentManagementIntelligenceRepository(),
    new InMemoryEventStore(),
    createRuntimeModelGateway(),
    getDevelopmentManagementWecomGateway(),
    { dataMode: "development_fixture", appBaseUrl: appBaseUrl() },
  );
}

export function getManagementIntelligenceService(): ManagementIntelligenceService {
  return moduleRuntime("management-intelligence", Symbol("management-intelligence"), () => createManagementIntelligenceService());
}
