import { z } from "zod";
import { createMemberSchema, displayName, memberEmail } from "@/src/modules/organization/application/member-directory-schemas";
import type { MemberDirectoryService } from "@/src/modules/organization/application/member-directory-service";
import { ToolRegistry } from "@/src/modules/agent/domain/tool";

/**
 * 员工目录的 Agent 通道。
 *
 * 设计取舍：
 * - 入职登记（add_member）与资料维护（update_member）是低风险名册维护：只要求姓名、部门/岗位可留空，
 *   不授予角色或权限、无外部副作用、可软删除，因此按 riskLevel 1 / confirmationPolicy never 直接执行
 *   （与 work.create_task_template、communication.publish_message 同级）。写入仍受 organization_member:admin
 *   权限约束，并由 users/memberships 的 RLS 与原子审计触发器留痕。
 * - 停用/离职（deactivate_member）会改变在岗名单与任务分配可见性，按 riskLevel 2 / confirmationPolicy always
 *   只生成待人工确认的提案。
 * - 三者都不会修改角色、权限或账号能力（identity-administration 仍不向 Agent 开放）。
 */

const listMembersSchema = z.object({ keyword: z.string().trim().max(80).optional() }).strict();

const updateMemberToolSchema = z.object({
  memberId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  displayName: displayName.optional(),
  email: memberEmail.optional(),
  orgUnitId: z.uuid().optional(),
  positionId: z.uuid().optional(),
  isManager: z.boolean().optional(),
  /** 仅用于确认卡/Debug 展示的在岗姓名，服务端以 memberId 为准。 */
  memberName: displayName.optional(),
}).strict().superRefine((value, context) => {
  const provided = ["displayName", "email", "orgUnitId", "positionId", "isManager"].some((key) => value[key as keyof typeof value] !== undefined);
  if (!provided) context.addIssue({ code: "custom", path: [], message: "至少需要修改一个字段。" });
});

const deactivateMemberToolSchema = z.object({
  memberId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  memberName: displayName.optional(),
}).strict();

const reactivateMemberToolSchema = z.object({
  memberId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  memberName: displayName.optional(),
  orgUnitId: z.uuid().optional(),
  positionId: z.uuid().optional(),
  isManager: z.boolean().optional(),
}).strict();

const addMemberJsonSchema = {
  type: "object", additionalProperties: false,
  properties: {
    displayName: { type: "string", minLength: 1, maxLength: 80, description: "员工姓名。入职登记只要姓名即可，不要因为缺少职位/部门而拒绝或反复追问。" },
    email: { type: "string", description: "可选；未知就留空" },
    orgUnitId: { type: "string", format: "uuid", description: "可选；只能使用 organization.list_members 返回的真实部门 ID，不得编造" },
    positionId: { type: "string", format: "uuid", description: "可选；必须属于所选部门，只能使用真实岗位 ID" },
    isManager: { type: "boolean", description: "可选；是否部门负责人，未知时省略" },
  }, required: ["displayName"],
} as const;

const updateMemberJsonSchema = {
  type: "object", additionalProperties: false,
  properties: {
    memberId: { type: "string", format: "uuid" }, expectedVersion: { type: "integer", minimum: 1 },
    displayName: { type: "string" }, email: { type: "string" },
    orgUnitId: { type: "string", format: "uuid" }, positionId: { type: "string", format: "uuid" },
    isManager: { type: "boolean" }, memberName: { type: "string", description: "可选；用于确认卡展示的姓名" },
  }, required: ["memberId", "expectedVersion"],
} as const;

const deactivateMemberJsonSchema = {
  type: "object", additionalProperties: false,
  properties: {
    memberId: { type: "string", format: "uuid" }, expectedVersion: { type: "integer", minimum: 1 },
    memberName: { type: "string", description: "可选；用于确认卡展示的姓名" },
  }, required: ["memberId", "expectedVersion"],
} as const;

export function registerMemberDirectoryTools(registry: ToolRegistry, service: MemberDirectoryService) {
  registry.register({
    id: "organization.list_members", skillId: "organization-member-directory", version: 1,
    description: "只读查询当前租户的员工目录（姓名、邮箱、部门、岗位、是否负责人、在职状态、版本号）。回答“公司有哪些人/某人在哪个部门/谁负责哪个部门”以及需要成员 ID 之前必须先调用本工具核验，不得凭记忆编造成员或部门 ID。",
    requiredPermissions: ["organization_member:read"], riskLevel: 0, confirmationPolicy: "never", sideEffect: "none", timeoutMs: 10_000, maxAttempts: 2,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"],
    inputJsonSchema: { type: "object", additionalProperties: false, properties: { keyword: { type: "string", maxLength: 80, description: "可选；按姓名包含匹配过滤" } }, required: [] },
    inputSchema: listMembersSchema,
    preview(input) { const value = listMembersSchema.parse(input ?? {}); return value.keyword ? `按“${value.keyword}”查询员工目录。` : "读取员工目录。"; },
    execute(context, input) {
      const value = listMembersSchema.parse(input ?? {});
      return service.list(context).then((directory) => value.keyword
        ? { ...directory, members: directory.members.filter((member) => member.displayName.includes(value.keyword!) || (member.email ?? "").includes(value.keyword!)) }
        : directory);
    },
  });
  registry.register({
    id: "organization.add_member", skillId: "organization-member-directory", version: 1,
    description: "登记一名员工（入职登记）。只要用户说明“某人是新同事/今天入职/把他加进团队”，就调用本工具：入职当天职位、部门、邮箱往往还没定，只有姓名也必须登记，未知字段直接留空，不要追问职位部门、不要编造部门或岗位 ID。本工具只建立员工名册记录，不授予任何角色或权限，也不发送外部消息；如需真实部门/岗位 ID 先用 organization.list_members 查询。",
    requiredPermissions: ["organization_member:admin"], riskLevel: 1, confirmationPolicy: "never", sideEffect: "internal_idempotent", timeoutMs: 10_000, maxAttempts: 2,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"],
    inputJsonSchema: addMemberJsonSchema,
    inputSchema: createMemberSchema,
    preview(input) {
      const value = createMemberSchema.parse(input);
      const gaps = [!value.orgUnitId ? "部门" : "", !value.positionId ? "岗位" : ""].filter(Boolean).join("、");
      return `将登记新员工“${value.displayName}”${gaps ? `；${gaps}待补充，可稍后再补` : ""}。`;
    },
    execute(context, input, execution) { void execution; return service.createMember(context, createMemberSchema.parse(input)); },
  });
  registry.register({
    id: "organization.update_member", skillId: "organization-member-directory", version: 1,
    description: "补全或修改员工资料（姓名、邮箱、部门、岗位、是否部门负责人）。用户说“张三现在到产品部/岗位是产品经理/邮箱是…”时使用；必须先经 organization.list_members 取得 memberId 与当前 expectedVersion，ID 只能取自工具结果，不得猜测。本工具不改变角色与权限。",
    requiredPermissions: ["organization_member:admin"], riskLevel: 1, confirmationPolicy: "never", sideEffect: "internal_idempotent", timeoutMs: 10_000, maxAttempts: 2,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"],
    inputJsonSchema: updateMemberJsonSchema,
    inputSchema: updateMemberToolSchema,
    preview(input) {
      const value = updateMemberToolSchema.parse(input);
      const changes = [value.displayName ? `姓名→${value.displayName}` : "", value.email ? `邮箱→${value.email}` : "", value.orgUnitId ? "部门" : "", value.positionId ? "岗位" : "", value.isManager !== undefined ? (value.isManager ? "设为部门负责人" : "取消部门负责人") : ""].filter(Boolean).join("、");
      return `将更新员工“${value.memberName ?? value.memberId}”的资料（${changes}）。`;
    },
    execute(context, input) {
      const { memberId, memberName, ...changes } = updateMemberToolSchema.parse(input);
      void memberName;
      return service.updateMember(context, memberId, changes);
    },
  });
  registry.register({
    id: "organization.deactivate_member", skillId: "organization-member-directory", version: 1,
    description: "停用（离职）一名员工。用于用户明确要求“某人离职/停用/移除成员”。这是软删除：只结束现行任职并标记离职，保留历史任务与审计，不存在物理删除，不能声称数据已彻底删除；仍有进行中任务的成员会被服务端拒绝，需要先完成或交接。本工具只生成待人工确认的提案，确认后才执行。",
    requiredPermissions: ["organization_member:admin"], riskLevel: 2, confirmationPolicy: "always", sideEffect: "internal_idempotent", timeoutMs: 10_000, maxAttempts: 3,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"],
    inputJsonSchema: deactivateMemberJsonSchema,
    inputSchema: deactivateMemberToolSchema,
    preview(input) {
      const value = deactivateMemberToolSchema.parse(input);
      return `将停用员工“${value.memberName ?? value.memberId}”（软删除：结束现行任职并标记离职，保留历史任务与审计）。`;
    },
    execute(context, input) {
      const { memberId, memberName, expectedVersion } = deactivateMemberToolSchema.parse(input);
      void memberName;
      return service.deactivateMember(context, memberId, { expectedVersion });
    },
  });
  registry.register({
    id: "organization.reactivate_member", skillId: "organization-member-directory", version: 1,
    description: "重新启用一名已停用/离职的员工（恢复在职）。用于用户明确要求“把某人恢复/重新启用/加回来”。只恢复在职身份与任职（部门/岗位/负责人可留空以沿用停用前设置），停用时被收回的角色授权、委托、设备与外部身份不会自动恢复，需要管理员另行授予或重新登录；本工具只生成待人工确认的提案，确认后才执行。",
    requiredPermissions: ["organization_member:admin"], riskLevel: 2, confirmationPolicy: "always", sideEffect: "internal_idempotent", timeoutMs: 10_000, maxAttempts: 3,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"],
    inputJsonSchema: {
      type: "object", additionalProperties: false,
      properties: {
        memberId: { type: "string", format: "uuid" }, expectedVersion: { type: "integer", minimum: 1 },
        memberName: { type: "string", description: "可选；用于确认卡展示的姓名" },
        orgUnitId: { type: "string", format: "uuid", description: "可选；留空沿用停用前部门" },
        positionId: { type: "string", format: "uuid", description: "可选；必须属于所选部门" },
        isManager: { type: "boolean", description: "可选；是否部门负责人" },
      }, required: ["memberId", "expectedVersion"],
    },
    inputSchema: reactivateMemberToolSchema,
    preview(input) {
      const value = reactivateMemberToolSchema.parse(input);
      return `将重新启用员工“${value.memberName ?? value.memberId}”（恢复在职与任职；不自动恢复角色授权与设备）。`;
    },
    execute(context, input) {
      const { memberId, memberName, ...rest } = reactivateMemberToolSchema.parse(input);
      void memberName;
      return service.reactivateMember(context, memberId, rest);
    },
  });
}
