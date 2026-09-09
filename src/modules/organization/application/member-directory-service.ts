import { randomUUID } from "node:crypto";
import { assertPositionBelongsToOrg, createMemberProfile, deactivateMember, editMemberProfile, type DirectoryMember } from "@/src/modules/organization/domain/member-directory";
import type { MemberDirectoryRepository } from "@/src/modules/organization/application/member-directory-contracts";
import type { CreateMemberInput, DeactivateMemberInput, UpdateMemberInput } from "@/src/modules/organization/application/member-directory-schemas";
import type { RequestContext } from "@/src/platform/context/request-context";

function hasPermission(context: RequestContext, permission: string): boolean {
  return context.permissions.includes(permission) || context.permissions.includes("*");
}

function requirePermission(context: RequestContext, permission: string) {
  if (!hasPermission(context, permission)) throw new Error(`POLICY_DENIED:${permission}`);
}

export class MemberDirectoryService {
  constructor(private readonly repository: MemberDirectoryRepository) {}

  async list(context: RequestContext) {
    requirePermission(context, "organization_member:read");
    const directory = await this.repository.list(context.tenantId);
    return { ...directory, canManage: hasPermission(context, "organization_member:admin") };
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

  /** UI/内部只读辅助：判断当前主体能否管理目录。 */
  canManage(context: RequestContext): boolean {
    return hasPermission(context, "organization_member:admin");
  }
}

export type { DirectoryMember };
