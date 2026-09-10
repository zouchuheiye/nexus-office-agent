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
import { DEFAULT_TASK_REMINDER_OPTIONS, TaskReminderWorker } from "../src/modules/task-command/application/reminder-worker";
import { PostgresTenantDirectory } from "../src/platform/workers/postgres-work-repositories";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not configured. Set it before running this script.");
  process.exitCode = 1;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("REMINDER_CONFIGURATION_INVALID");
  return parsed;
}

/**
 * 提醒扫描的手工/一次性入口。常驻调度请用 `WORKER_ROLES=task-reminder npm run worker`：
 * 那条路径有 supervisor 的租户枚举、心跳与优雅排空。
 *
 * 该脚本与常驻 Worker 走同一个系统扫描入口（`runScheduledReminderScan`）：
 * 池消息与通知都以 system 署名写入，不借用任何同事身份，也不再只扫演示租户。
 */
async function main() {
  const database = createPostgresDatabase(databaseUrl!);
  const worker = new TaskReminderWorker(
    new TaskCommandService(new PostgresTaskCommandRepository(database)),
    {
      intervalMs: positiveInteger(process.env.TASK_REMINDER_INTERVAL_MS, DEFAULT_TASK_REMINDER_OPTIONS.intervalMs),
      dueSoonHours: positiveInteger(process.env.TASK_REMINDER_DUE_SOON_HOURS, DEFAULT_TASK_REMINDER_OPTIONS.dueSoonHours),
      blockedEscalationHours: positiveInteger(process.env.TASK_REMINDER_BLOCKED_HOURS, DEFAULT_TASK_REMINDER_OPTIONS.blockedEscalationHours),
      timeoutMs: positiveInteger(process.env.TASK_REMINDER_TIMEOUT_MS, DEFAULT_TASK_REMINDER_OPTIONS.timeoutMs),
      summary: { enabled: false, scope: "daily" },
    },
  );
  try {
    const tenantIndex = process.argv.indexOf("--tenant");
    const explicitTenant = tenantIndex >= 0 ? process.argv[tenantIndex + 1] : undefined;
    const tenants = explicitTenant ? [explicitTenant] : await new PostgresTenantDirectory(database).listActiveTenantIds();
    if (!tenants.length) {
      console.info(JSON.stringify({ tenants: 0, results: [] }));
      return;
    }
    const results = [];
    for (const tenantId of tenants) {
      // 手工入口显式忽略节流：每次运行都真的扫一遍。
      results.push({ tenantId, ...(await worker.processTenant(tenantId, "task-reminder-script", new Date())) });
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
