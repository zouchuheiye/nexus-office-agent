import { EnterpriseGovernanceService } from "@/src/modules/enterprise-governance/application/service";
import { getDevelopmentEnterpriseGovernanceRepository } from "@/src/modules/enterprise-governance/infrastructure/in-memory-repository";
import { PostgresEnterpriseGovernanceRepository } from "@/src/modules/enterprise-governance/infrastructure/postgres-repository";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { PostgresEventStore } from "@/src/modules/events/infrastructure/postgres-event-store";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { moduleRuntime } from "@/src/platform/runtime/module-runtime";

const runtimeGeneration = Symbol("enterprise-governance");

export function getEnterpriseGovernanceService() {
  return moduleRuntime("enterprise-governance", runtimeGeneration, () => {
    if (process.env.DATABASE_URL) {
      const database = createPostgresDatabase(process.env.DATABASE_URL);
      return new EnterpriseGovernanceService(new PostgresEnterpriseGovernanceRepository(database), new PostgresEventStore(database));
    }
    return new EnterpriseGovernanceService(getDevelopmentEnterpriseGovernanceRepository(), new InMemoryEventStore());
  });
}
