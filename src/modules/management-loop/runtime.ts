import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { PostgresEventStore } from "@/src/modules/events/infrastructure/postgres-event-store";
import { ManagementLoopService } from "@/src/modules/management-loop/application/service";
import { getDevelopmentManagementRepository } from "@/src/modules/management-loop/infrastructure/in-memory-repository";
import { PostgresManagementLoopRepository } from "@/src/modules/management-loop/infrastructure/postgres-repository";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { moduleRuntime } from "@/src/platform/runtime/module-runtime";

const runtimeGeneration = Symbol("management-loop");

export function getManagementLoopService(): ManagementLoopService {
  return moduleRuntime("management-loop", runtimeGeneration, () => {
    if (process.env.DATABASE_URL) {
      const database = createPostgresDatabase(process.env.DATABASE_URL);
      const events = new PostgresEventStore(database);
      return new ManagementLoopService(new PostgresManagementLoopRepository(database), events);
    }
    const events = new InMemoryEventStore();
    return new ManagementLoopService(getDevelopmentManagementRepository(), events);
  });
}
