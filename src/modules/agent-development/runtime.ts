import { AgentDevelopmentService } from "@/src/modules/agent-development/application/service";
import { InMemoryAgentDevelopmentStore } from "@/src/modules/agent-development/infrastructure/in-memory-store";
import { PostgresAgentDevelopmentStore } from "@/src/modules/agent-development/infrastructure/postgres-store";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { moduleRuntime } from "@/src/platform/runtime/module-runtime";

const runtimeGeneration = Symbol("agent-development");

export function getAgentDevelopmentService(): AgentDevelopmentService {
  return moduleRuntime("agent-development", runtimeGeneration, () => {
    const database = process.env.DATABASE_URL ? createPostgresDatabase(process.env.DATABASE_URL) : undefined;
    return new AgentDevelopmentService(database ? new PostgresAgentDevelopmentStore(database) : new InMemoryAgentDevelopmentStore());
  });
}
