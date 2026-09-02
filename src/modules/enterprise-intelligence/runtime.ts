import { EnterpriseIntelligenceService } from "@/src/modules/enterprise-intelligence/application/service";
import { getDevelopmentEnterpriseRepository } from "@/src/modules/enterprise-intelligence/infrastructure/in-memory-repository";
import { PostgresEnterpriseIntelligenceRepository } from "@/src/modules/enterprise-intelligence/infrastructure/postgres-repository";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { PostgresEventStore } from "@/src/modules/events/infrastructure/postgres-event-store";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { moduleRuntime } from "@/src/platform/runtime/module-runtime";

const runtimeGeneration = Symbol("enterprise-intelligence");

export function getEnterpriseIntelligenceService() {
  return moduleRuntime("enterprise-intelligence", runtimeGeneration, () => {
    if (process.env.DATABASE_URL) {
      const database = createPostgresDatabase(process.env.DATABASE_URL);
      return new EnterpriseIntelligenceService(new PostgresEnterpriseIntelligenceRepository(database), new PostgresEventStore(database));
    }
    return new EnterpriseIntelligenceService(getDevelopmentEnterpriseRepository(), new InMemoryEventStore());
  });
}
