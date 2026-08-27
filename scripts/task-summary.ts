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
import { createDevelopmentRequestContext } from "../src/platform/context/development-context";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not configured. Set it before running this script.");
  process.exitCode = 1;
}

async function runSummary() {
  const database = createPostgresDatabase(databaseUrl!);
  try {
    const service = new TaskCommandService(new PostgresTaskCommandRepository(database));
    const context = createDevelopmentRequestContext("task-summary");
    const scopeIndex = process.argv.indexOf("--scope");
    const scope = scopeIndex >= 0 ? process.argv[scopeIndex + 1] : "daily";
    if (scope !== "daily" && scope !== "weekly") throw new Error("SCOPE_INVALID");
    const result = await service.generatePeriodicSummary(context, { scope });
    console.info(JSON.stringify(result));
  } finally {
    await database.close();
  }
}

async function main() {
  const watch = process.argv.includes("--watch");
  const intervalIndex = process.argv.indexOf("--interval");
  const intervalMinutes = intervalIndex >= 0 ? Number(process.argv[intervalIndex + 1]) : 1440;
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) throw new Error("INTERVAL_INVALID");
  await runSummary();
  if (!watch) return;
  console.info(`task-summary watch mode: next summary in ${intervalMinutes} minutes`);
  const timer = setInterval(() => { void runSummary(); }, intervalMinutes * 60_000);
  process.once("SIGTERM", () => { clearInterval(timer); process.exit(0); });
  process.once("SIGINT", () => { clearInterval(timer); process.exit(0); });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

