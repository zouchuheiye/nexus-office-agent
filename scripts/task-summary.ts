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
import { PostgresTenantDirectory } from "../src/platform/workers/postgres-work-repositories";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not configured. Set it before running this script.");
  process.exitCode = 1;
}

/**
 * 周期进度摘要的手工/一次性入口。常驻调度请用 `WORKER_ROLES=task-reminder npm run worker`
 * （该角色按 `TASK_SUMMARY_SCOPE` 自动发日报/周报，并有心跳与优雅排空）。
 *
 * 摘要面向整个租户并以 system 署名发布到公司消息池；同一周期重复运行只会得到
 * `created=false`（消息 ID 由「作用域 + 周期」确定）。个人视角请看工作台「我的」与任务进度看板。
 */
async function main() {
  const database = createPostgresDatabase(databaseUrl!);
  try {
    const service = new TaskCommandService(new PostgresTaskCommandRepository(database));
    const scopeIndex = process.argv.indexOf("--scope");
    const scope = scopeIndex >= 0 ? process.argv[scopeIndex + 1] : (process.env.TASK_SUMMARY_SCOPE ?? "daily");
    if (scope !== "daily" && scope !== "weekly") throw new Error("SCOPE_INVALID");
    const tenantIndex = process.argv.indexOf("--tenant");
    const explicitTenant = tenantIndex >= 0 ? process.argv[tenantIndex + 1] : undefined;
    const tenants = explicitTenant ? [explicitTenant] : await new PostgresTenantDirectory(database).listActiveTenantIds();
    const results = [];
    for (const tenantId of tenants) {
      const result = await service.generateScheduledSummary({ tenantId, scope });
      results.push({ tenantId, periodKey: result.periodKey, messageId: result.messageId, created: result.created, effective: result.effective });
    }
    console.info(JSON.stringify({ tenants: tenants.length, results }));
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
