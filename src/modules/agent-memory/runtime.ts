import { AgentMemoryService } from "@/src/modules/agent-memory/application/service";
import { getDevelopmentAgentMemoryRepository } from "@/src/modules/agent-memory/infrastructure/in-memory-repository";
import { PostgresAgentMemoryRepository } from "@/src/modules/agent-memory/infrastructure/postgres-repository";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { moduleRuntime } from "@/src/platform/runtime/module-runtime";

const runtimeGeneration = Symbol("agent-memory");

export function getAgentMemoryService(): AgentMemoryService {
  return moduleRuntime("agent-memory", runtimeGeneration, () => {
    const repository = process.env.DATABASE_URL
      ? new PostgresAgentMemoryRepository(createPostgresDatabase(process.env.DATABASE_URL))
      : getDevelopmentAgentMemoryRepository();
    return new AgentMemoryService(repository);
  });
}
