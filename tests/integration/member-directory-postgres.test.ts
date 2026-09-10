// Requirements: SR-001, SR-002, SR-004, AC-003
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemberDirectoryService } from "@/src/modules/organization/application/member-directory-service";
import { PostgresMemberDirectoryRepository } from "@/src/modules/organization/infrastructure/postgres-member-directory-repository";
import { TaskCommandService } from "@/src/modules/task-command/application/service";
import { PostgresTaskCommandRepository } from "@/src/modules/task-command/infrastructure/postgres-repository";
import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

const DELIVERY_ORG_ID = "20000000-0000-4000-8000-000000000002";
const DELIVERY_POSITION_ID = "50000000-0000-4000-8000-000000000002";

const MIGRATIONS = ["0001_foundation.sql","0002_management_loop.sql","0003_agent_platform.sql","0004_connector_platform.sql","0005_workflow_knowledge.sql","0006_strategy_organization_talent.sql","0007_client_platform.sql","0008_security_hardening.sql","0009_atomic_audit.sql","0010_immutable_audit.sql","0011_enterprise_governance.sql","0012_enterprise_acceptance.sql","0013_connector_test_notifications.sql","0014_durable_runtime.sql","0015_agent_job_control.sql","0016_management_intelligence.sql","0017_work_command_center.sql","0018_work_message_pools.sql","0019_work_task_handoffs.sql","0023_work_artifact_evidence_chain.sql","0043_work_task_templates.sql","0045_work_task_progress_tracking.sql","0046_work_task_handoff_card.sql","0047_announcement_center.sql","0048_work_package_subtasks.sql","0049_work_task_notifications.sql","0050_task_reminder_scheduler.sql"];

describe("Postgres member directory repository", () => {
  let database: PGlite;
  let directory: MemberDirectoryService;
  let tasks: TaskCommandService;

  beforeEach(async () => {
    database = new PGlite();
    for (const file of MIGRATIONS) await database.exec(await readFile(path.resolve("src/platform/database/migrations", file), "utf8"));
    const executor: DatabaseExecutor = {
      async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) { return (await database.query<T>(sql, params as never[])).rows; },
    };
    const adapter: TransactionalDatabase = {
      ...executor,
      async withTenant<T>(tenantId: string, work: (scoped: DatabaseExecutor) => Promise<T>) {
        await database.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]);
        return work(executor);
      },
      async close() { await database.close(); },
    };
    directory = new MemberDirectoryService(new PostgresMemberDirectoryRepository(adapter));
    tasks = new TaskCommandService(new PostgresTaskCommandRepository(adapter));
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES($1,'demo','Demo','active')", [DEMO_TENANT_ID]);
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [DEMO_TENANT_ID]);
    await database.query("INSERT INTO org_units(id,tenant_id,name,path,status,version) VALUES($1,$2,'交付中心','/交付中心','active',1)", [DELIVERY_ORG_ID, DEMO_TENANT_ID]);
    await database.query("INSERT INTO positions(id,tenant_id,org_unit_id,code,name,status,version) VALUES($1,$2,$3,'delivery-head','交付负责人','active',1)", [DELIVERY_POSITION_ID, DEMO_TENANT_ID, DELIVERY_ORG_ID]);
    await database.query("INSERT INTO users(id,tenant_id,display_name,email,status,version) VALUES($1,$2,'开发管理员','manager@example.test','active',1)", [DEMO_MANAGER_ID, DEMO_TENANT_ID]);
  });

  afterEach(async () => { await database.close(); });

  it("persists a new member with RLS, reflects edits and soft-deactivates without deleting the row", async () => {
    const manager = createDevelopmentRequestContext("pg-member-manager");
    const created = await directory.createMember(manager, { displayName: "新员工乙", email: "h2@example.test", orgUnitId: DELIVERY_ORG_ID, positionId: DELIVERY_POSITION_ID });
    expect(created).toMatchObject({ status: "active", orgUnitName: "交付中心", positionName: "交付负责人" });

    const moved = await directory.updateMember(manager, created.id, { expectedVersion: 1, displayName: "新员工乙·改", isManager: true });
    expect(moved).toMatchObject({ displayName: "新员工乙·改", isManager: true, version: 2 });

    await expect(directory.createMember(manager, { displayName: "重名邮箱", email: "H2@example.test" })).rejects.toThrow("MEMBER_EMAIL_TAKEN");

    const result = await directory.deactivateMember(manager, created.id, { expectedVersion: 2 });
    expect(result.deactivatedMemberId).toBe(created.id);
    expect((await directory.list(manager)).members.find(({ id }) => id === created.id)).toBeUndefined();

    const retained = await database.query<{ status: string; archived_at: string | null }>("SELECT status,archived_at FROM users WHERE id=$1", [created.id]);
    expect(retained.rows[0].status).toBe("departed");
    expect(retained.rows[0].archived_at).not.toBeNull();
  });

  it("revokes the other doors on deactivation so a departed employee cannot get back in", async () => {
    const manager = createDevelopmentRequestContext("pg-member-revoke");
    const member = await directory.createMember(manager, { displayName: "离职收回验证", email: "revoke@example.test", orgUnitId: DELIVERY_ORG_ID });
    // 设备、角色授权、外部身份是除会话之外的其他入口，停用后必须一并收回。
    const roleId = crypto.randomUUID();
    await database.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'employee','员工') ON CONFLICT (tenant_id,code) DO NOTHING", [roleId, DEMO_TENANT_ID]);
    await database.query("INSERT INTO user_roles(id,tenant_id,user_id,role_id,scope_type) VALUES($1,$2,$3,(SELECT id FROM roles WHERE tenant_id=$2 AND code='employee'),'tenant')", [crypto.randomUUID(), DEMO_TENANT_ID, member.id]);
    await database.query("INSERT INTO client_devices(id,tenant_id,user_id,installation_id,display_name,client_type,platform,app_version,status,revoked_at) VALUES($1,$2,$3,$4,'离职员工设备','web_pwa','Windows','0.14.0','active',NULL)", [crypto.randomUUID(), DEMO_TENANT_ID, member.id, crypto.randomUUID()]);

    await directory.deactivateMember(manager, member.id, { expectedVersion: member.version });

    const roles = await database.query<{ expires_at: string | null }>("SELECT expires_at FROM user_roles WHERE user_id=$1", [member.id]);
    expect(roles.rows[0].expires_at).not.toBeNull();
    const devices = await database.query<{ status: string; revoked_at: string | null }>("SELECT status,revoked_at FROM client_devices WHERE user_id=$1", [member.id]);
    expect(devices.rows[0]).toMatchObject({ status: "revoked" });
    expect(devices.rows[0].revoked_at).not.toBeNull();
    // 员工档案仍保留（软删除，不物理删）
    expect((await database.query("SELECT 1 FROM users WHERE id=$1", [member.id])).rows).toHaveLength(1);
  });

  it("reactivates a departed member in place and reopens a current membership", async () => {
    const manager = createDevelopmentRequestContext("pg-member-reactivate");
    const member = await directory.createMember(manager, { displayName: "回流员工", email: "rejoin@example.test", orgUnitId: DELIVERY_ORG_ID, positionId: DELIVERY_POSITION_ID });
    await directory.deactivateMember(manager, member.id, { expectedVersion: member.version });

    // 已停用成员默认不在目录里，includeDeparted 时可见（供重新启用入口使用）
    expect((await directory.list(manager)).members.find(({ id }) => id === member.id)).toBeUndefined();
    expect((await directory.list(manager, { includeDeparted: true })).members.find(({ id }) => id === member.id)).toMatchObject({ status: "departed" });
    await expect(directory.reactivateMember(manager, member.id, { expectedVersion: 1 })).rejects.toThrow("MEMBER_VERSION_CONFLICT");
    // 留空部门/岗位：沿用停用前任职
    const restored = await directory.reactivateMember(manager, member.id, { expectedVersion: 2 });
    expect(restored).toMatchObject({ status: "active", orgUnitName: "交付中心", positionName: "交付负责人", version: 3 });
    const user = await database.query<{ status: string; archived_at: string | null }>("SELECT status,archived_at FROM users WHERE id=$1", [member.id]);
    expect(user.rows[0]).toMatchObject({ status: "active", archived_at: null });
    const open = await database.query("SELECT 1 FROM memberships WHERE user_id=$1 AND ends_at IS NULL", [member.id]);
    expect(open.rows).toHaveLength(1);
    expect((await directory.list(manager)).members.find(({ id }) => id === member.id)).toMatchObject({ status: "active" });

    // 已在职者不能重复重新启用
    await expect(directory.reactivateMember(manager, member.id, { expectedVersion: 3 })).rejects.toThrow("MEMBER_NOT_DEPARTED");
  });

  it("refuses deactivation while the member still holds an active package and keeps the task assignee intact", async () => {
    const manager = createDevelopmentRequestContext("pg-member-guard");
    const assignee = await directory.createMember(manager, { displayName: "进行中任务负责人", email: "busy@example.test", orgUnitId: DELIVERY_ORG_ID });
    const conversation = (await tasks.workspace(manager)).conversation;
    await tasks.publishMission(manager, {
      conversationId: conversation.id,
      title: "成员在职校验",
      objective: "验证有进行中任务时不能停用成员。",
      priority: "medium",
      dueAt: "2030-09-01T10:00:00.000Z",
      packages: [{ title: "分配中的任务", description: "仍在推进。", acceptanceCriteria: "完成。", requiredSkills: [], assignmentMode: "direct", assigneeId: assignee.id, priority: "medium", dueAt: "2030-08-30T10:00:00.000Z", startedAt: "2030-08-01T00:00:00.000Z", estimatedDays: 7, capacityPoints: 2 }],
    });
    await expect(directory.deactivateMember(manager, assignee.id, { expectedVersion: assignee.version })).rejects.toThrow("MEMBER_HAS_ACTIVE_WORK");
    const stillActive = await database.query<{ status: string }>("SELECT status FROM users WHERE id=$1", [assignee.id]);
    expect(stillActive.rows[0].status).toBe("active");
  });

  it("enforces tenant isolation and records atomic audit on user/membership writes", async () => {
    const manager = createDevelopmentRequestContext("pg-member-audit");
    const created = await directory.createMember(manager, { displayName: "审计成员", email: "audit@example.test", orgUnitId: DELIVERY_ORG_ID });
    await database.query("SELECT set_config('app.tenant_id',$1,false)", ["00000000-0000-4000-8000-000000000002"]);
    await database.query("INSERT INTO tenants(id,slug,name,status) VALUES('00000000-0000-4000-8000-000000000002','b','Tenant B','active')");
    await database.query("SELECT set_config('app.tenant_id',$1,false)", [DEMO_TENANT_ID]);
    const listA = await directory.list(manager);
    expect(listA.members.some(({ id }) => id === created.id)).toBe(true);

    await database.query("SELECT set_config('app.tenant_id',$1,false)", ["00000000-0000-4000-8000-000000000002"]);
    const audit = await database.query<{ resource_type: string }>(
      "SELECT DISTINCT resource_type FROM audit_events WHERE resource_type IN ('users','memberships') ORDER BY resource_type",
    );
    expect(audit.rows.map(({ resource_type }) => resource_type)).toEqual(["memberships", "users"]);
  });
});
