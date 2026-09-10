import type { TransactionalDatabase } from "@/src/platform/database/executor";
import { createPostgresDatabase } from "@/src/platform/database/postgres";

/**
 * "这名主体是否仍是可登录的在职员工"——成员管理停用（软删除）后，用于在鉴权入口
 * 阻止其继续进入枢纽 Agent。生产路径另有授权解析器按 users.status 判定；
 * 这里主要补齐开发/内网验证身份模式（会话 Cookie 只证明"曾经是谁"，不代表"现在还能进"）。
 */
export interface EmployeeStatusChecker {
  isActive(tenantId: string, actorId: string): Promise<boolean>;
}

export class PostgresEmployeeStatusChecker implements EmployeeStatusChecker {
  constructor(private readonly database: TransactionalDatabase) {}

  async isActive(tenantId: string, actorId: string): Promise<boolean> {
    const rows = await this.database.withTenant(tenantId, (executor) => executor.query<{ status: string; archived_at: Date | string | null }>(
      "SELECT status, archived_at FROM users WHERE tenant_id=$1 AND id=$2",
      [tenantId, actorId],
    ));
    const user = rows[0];
    // 没有员工档案的主体（例如尚未登记的外部主体）不在此处判定，交由授权解析器处理。
    if (!user) return true;
    return user.status === "active" && !user.archived_at;
  }
}

/**
 * 无数据库（内存演示夹具）时的等效实现：成员目录的内存仓储在停用/编辑时同步标记，
 * 使开发夹具模式下的"停用后不能再次进入"同样成立。
 */
const memoryRegistry = globalThis as typeof globalThis & { __nexusInactiveEmployees?: Set<string> };
function inactiveEmployees(): Set<string> {
  return memoryRegistry.__nexusInactiveEmployees ??= new Set<string>();
}
export function markEmployeeInactive(actorId: string): void { inactiveEmployees().add(actorId); }
export function markEmployeeActive(actorId: string): void { inactiveEmployees().delete(actorId); }
export function isEmployeeMarkedInactive(actorId: string): boolean { return inactiveEmployees().has(actorId); }

export class InMemoryEmployeeStatusChecker implements EmployeeStatusChecker {
  async isActive(_tenantId: string, actorId: string): Promise<boolean> { return !isEmployeeMarkedInactive(actorId); }
}

const runtime = globalThis as typeof globalThis & {
  __nexusEmployeeStatus?: EmployeeStatusChecker;
  __nexusEmployeeStatusKey?: string;
};

/** 有 DATABASE_URL 时查员工档案；否则用开发夹具的内存标记。 */
export function getEmployeeStatusChecker(): EmployeeStatusChecker {
  const databaseUrl = process.env.DATABASE_URL;
  const key = databaseUrl ?? "in-memory";
  if (!runtime.__nexusEmployeeStatus || runtime.__nexusEmployeeStatusKey !== key) {
    runtime.__nexusEmployeeStatus = databaseUrl ? new PostgresEmployeeStatusChecker(createPostgresDatabase(databaseUrl)) : new InMemoryEmployeeStatusChecker();
    runtime.__nexusEmployeeStatusKey = key;
  }
  return runtime.__nexusEmployeeStatus;
}
