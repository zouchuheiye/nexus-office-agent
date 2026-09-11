import { randomUUID } from "node:crypto";
import { assertPositionBelongsToOrg, createMemberProfile, deactivateMember, editMemberProfile, reactivateMember as applyReactivation, type DirectoryMember } from "@/src/modules/organization/domain/member-directory";
import type { MemberDirectoryQuery, MemberDirectoryRepository, PreviousMembership } from "@/src/modules/organization/application/member-directory-contracts";
import type { CreateMemberInput, DeactivateMemberInput, ReactivateMemberInput, UpdateMemberInput } from "@/src/modules/organization/application/member-directory-schemas";
import type { RequestContext } from "@/src/platform/context/request-context";

function hasPermission(context: RequestContext, permission: string): boolean {
  return context.permissions.includes(permission) || context.permissions.includes("*");
}

function requirePermission(context: RequestContext, permission: string) {
  if (!hasPermission(context, permission)) throw new Error(`POLICY_DENIED:${permission}`);
}

export class MemberDirectoryService {
  constructor(private readonly repository: MemberDirectoryRepository) {}

  async list(context: RequestContext, query: MemberDirectoryQuery = {}) {
    requirePermission(context, "organization_member:read");
    const canManage = hasPermission(context, "organization_member:admin");
    // 已停用/离职名单属于敏感人事事实：只有管理员能查看；
    // 普通成员只能看到在职同事（不报错也不静默降级，直接拒绝越权请求）。
    if (query.includeDeparted && !canManage) throw new Error("POLICY_DENIED:organization_member:admin");
    const directory = await this.repository.list(context.tenantId, { includeDeparted: canManage && query.includeDeparted === true });
    return { ...directory, canManage };
  }

  /**
   * E-161：把**当前主体**解析成"适用范围"判据（部门 + 岗位名）。
   *
   * 只查自己，因此不需要人事管理权限；查不到（例如新入职还没建任职）就返回空数组，
   * 由调用方按"不匹配"处理——外部文件不该因为解析不到组织信息就变成人人可见。
   * 岗位目前用**名称**匹配：成员目录对外暴露的就是岗位名（`positionName`），等岗位 ID 在更广的
   * 读模型里稳定后再升级为 ID 匹配（届时要同时回填历史文件条目）。
   */
  async actorApplicability(context: RequestContext): Promise<{ orgUnitIds: string[]; positionNames: string[] }> {
    const member = await this.repository.get(context.tenantId, context.actorId);
    if (!member) return { orgUnitIds: [], positionNames: [] };
    return {
      orgUnitIds: member.orgUnitId ? [member.orgUnitId] : [],
      positionNames: member.positionName ? [member.positionName] : [],
    };
  }

  async createMember(context: RequestContext, input: CreateMemberInput) {
    requirePermission(context, "organization_member:admin");
    const member = createMemberProfile({ id: randomUUID(), ...input });
    if (input.email) {
      const taken = await this.repository.emailTaken(context.tenantId, member.email!);
      if (taken) throw new Error("MEMBER_EMAIL_TAKEN");
    }
    if (input.orgUnitId) {
      const options = await this.repository.list(context.tenantId);
      const position = input.positionId ? options.positions.find((item) => item.id === input.positionId) : undefined;
      assertPositionBelongsToOrg(position, input.orgUnitId);
    }
    const created = await this.repository.create(context.tenantId, member);
    if (!created) throw new Error("MEMBER_CREATE_CONFLICT");
    return (await this.repository.get(context.tenantId, member.id)) ?? member;
  }

  async updateMember(context: RequestContext, userId: string, input: UpdateMemberInput) {
    requirePermission(context, "organization_member:admin");
    const current = await this.repository.get(context.tenantId, userId);
    if (!current) throw new Error("MEMBER_NOT_FOUND");
    const next = editMemberProfile(current, input);
    if (input.email && input.email.trim() && input.email !== current.email) {
      const taken = await this.repository.emailTaken(context.tenantId, next.email!, userId);
      if (taken) throw new Error("MEMBER_EMAIL_TAKEN");
    }
    if (input.orgUnitId) {
      const options = await this.repository.list(context.tenantId);
      const position = input.positionId ? options.positions.find((item) => item.id === input.positionId) : undefined;
      assertPositionBelongsToOrg(position, input.orgUnitId);
    }
    const updated = await this.repository.update(context.tenantId, next, input.expectedVersion);
    if (!updated) throw new Error("MEMBER_VERSION_CONFLICT");
    return this.repository.get(context.tenantId, userId);
  }

  async deactivateMember(context: RequestContext, userId: string, input: DeactivateMemberInput) {
    requirePermission(context, "organization_member:admin");
    if (context.actorId === userId) throw new Error("MEMBER_SELF_DEACTIVATE_DENIED");
    const current = await this.repository.get(context.tenantId, userId);
    if (!current) throw new Error("MEMBER_NOT_FOUND");
    deactivateMember(current); // 域校验：重复停用直接报错
    const result = await this.repository.deactivate(context.tenantId, userId, input.expectedVersion);
    if (result === "version") throw new Error("MEMBER_VERSION_CONFLICT");
    if (result === "active_work") throw new Error("MEMBER_HAS_ACTIVE_WORK");
    return { deactivatedMemberId: userId, version: current.version + 1 };
  }

  /**
   * 重新启用已停用/离职成员：恢复在职身份与任职（部门/岗位/负责人）。
   * 只恢复"能重新上班"，不自动恢复停用时收回的角色授权、委托、设备与外部身份——
   * 那些需要管理员另行授予或重新登录/重新绑定，避免一次误停用变成权限静默回滚。
   */
  async reactivateMember(context: RequestContext, userId: string, input: ReactivateMemberInput) {
    requirePermission(context, "organization_member:admin");
    const current = await this.repository.get(context.tenantId, userId);
    if (!current) throw new Error("MEMBER_NOT_FOUND");
    applyReactivation(current, input); // 域校验：只有在职=departed 才能重新启用

    const previous = await this.repository.lastMembership(context.tenantId, userId);
    const orgUnitId = input.orgUnitId ?? previous?.orgUnitId ?? current.orgUnitId;
    const positionId = input.positionId ?? previous?.positionId;
    let membership: PreviousMembership | null = null;
    if (orgUnitId) {
      const options = await this.repository.list(context.tenantId);
      if (!options.orgUnits.some((unit) => unit.id === orgUnitId)) throw new Error("MEMBER_ORG_NOT_ACTIVE");
      const position = positionId ? options.positions.find((item) => item.id === positionId) : undefined;
      assertPositionBelongsToOrg(position, orgUnitId);
      membership = { orgUnitId, positionId: position?.id, isManager: input.isManager ?? previous?.isManager ?? current.isManager };
    }

    const result = await this.repository.reactivate(context.tenantId, userId, input.expectedVersion, membership);
    if (result === "version") throw new Error("MEMBER_VERSION_CONFLICT");
    if (result === "not_departed") throw new Error("MEMBER_NOT_DEPARTED");
    return this.repository.get(context.tenantId, userId);
  }

  /** UI/内部只读辅助：判断当前主体能否管理目录。 */
  canManage(context: RequestContext): boolean {
    return hasPermission(context, "organization_member:admin");
  }
}

export type { DirectoryMember };
