import { TaskCommandService } from "@/src/modules/task-command/application/service";
import { notificationRetentionOptionsFromEnv } from "@/src/modules/task-command/application/notification-retention";
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
    // 通知留存策略与常驻 Worker 共用同一份环境变量映射（HTTP 路径不暴露清理入口，只为口径一致）。
    return new TaskCommandService(repository, notificationRetentionOptionsFromEnv());
  });
}
