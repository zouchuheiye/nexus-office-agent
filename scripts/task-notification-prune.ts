import { existsSync, readFileSync } from "node:fs";

if (!process.env.DATABASE_URL && existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
import { createPostgresDatabase } from "../src/platform/database/postgres";
import { PostgresTaskCommandRepository } from "../src/modules/task-command/infrastructure/postgres-repository";
import { TaskCommandService } from "../src/modules/task-command/application/service";
import { notificationRetentionOptionsFromEnv } from "../src/modules/task-command/application/notification-retention";
import { PostgresTenantDirectory } from "../src/platform/workers/postgres-work-repositories";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not configured. Set it before running this script.");
  process.exitCode = 1;
}

/**
 * 站内通知留存清理的手工入口。常驻调度请用 `WORKER_ROLES=task-reminder npm run worker`：
 * 那条路径有 supervisor 的租户枚举、心跳与优雅排空，并且每个租户每天自动清理一次。
 *
 * 保留口径由环境变量决定（与常驻 Worker 完全同一份映射）：
 * - `TASK_NOTIFICATION_RETENTION_DAYS`（默认 90）：已读通知保留天数；
 * - `TASK_NOTIFICATION_MAX_AGE_DAYS`（默认 365）：无论已读与否的硬上限；
 * - `TASK_NOTIFICATION_RETENTION_BATCH`（默认 500）：单批删除条数；
 * - `TASK_NOTIFICATION_RETENTION_ENABLED=false`：整条链路关闭。
 *
 * 清理的是投递态通知，不是业务事实：任务与事件链仍在 work_packages / work_task_events，
 * 被删通知的创建与删除都在原子审计表里留痕。
 */
async function main() {
  const database = createPostgresDatabase(databaseUrl!);
  const options = notificationRetentionOptionsFromEnv();
  const service = new TaskCommandService(new PostgresTaskCommandRepository(database), options);
  try {
    const tenantIndex = process.argv.indexOf("--tenant");
    const explicitTenant = tenantIndex >= 0 ? process.argv[tenantIndex + 1] : undefined;
    const tenants = explicitTenant ? [explicitTenant] : await new PostgresTenantDirectory(database).listActiveTenantIds();
    const results = [];
    for (const tenantId of tenants) {
      results.push({ tenantId, ...(await service.pruneNotifications({ tenantId })) });
    }
    console.info(JSON.stringify({
      tenants: tenants.length,
      options: { enabled: options.enabled, readDays: options.readDays, maxAgeDays: options.maxAgeDays, batchSize: options.batchSize },
      readPruned: results.reduce((total, item) => total + item.readPruned, 0),
      expiredPruned: results.reduce((total, item) => total + item.expiredPruned, 0),
      results,
    }));
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
