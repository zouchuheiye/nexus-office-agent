import { TaskCommandService } from "@/src/modules/task-command/application/service";
import { getDevelopmentTaskCommandRepository } from "@/src/modules/task-command/infrastructure/in-memory-repository";
import { PostgresTaskCommandRepository } from "@/src/modules/task-command/infrastructure/postgres-repository";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { moduleRuntime } from "@/src/platform/runtime/module-runtime";

const runtimeGeneration = Symbol("task-command");

export function getTaskCommandService() {
  return moduleRuntime("task-command", runtimeGeneration, () => {
    const repository = process.env.DATABASE_URL
      ? new PostgresTaskCommandRepository(createPostgresDatabase(process.env.DATABASE_URL))
      : getDevelopmentTaskCommandRepository();
    return new TaskCommandService(repository);
  });
}
