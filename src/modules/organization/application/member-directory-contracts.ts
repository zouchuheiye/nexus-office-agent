import type { DirectoryMember, OrgUnitOption, PositionOption } from "@/src/modules/organization/domain/member-directory";

export type MemberDirectoryResult = {
  members: DirectoryMember[];
  orgUnits: OrgUnitOption[];
  positions: PositionOption[];
};

export type MemberDirectoryQuery = {
  /** 是否连已停用/离职成员一起返回（用于"重新启用"入口）；默认只返回在职成员。 */
  includeDeparted?: boolean;
};

export type PreviousMembership = { orgUnitId: string; positionId?: string; isManager: boolean };

export interface MemberDirectoryRepository {
  list(tenantId: string, query?: MemberDirectoryQuery): Promise<MemberDirectoryResult>;
  get(tenantId: string, userId: string): Promise<DirectoryMember | null>;
  /** 邮箱是否已被本租户其他成员占用。 */
  emailTaken(tenantId: string, email: string, excludeUserId?: string): Promise<boolean>;
  /** 新增成员：users + 现行任职同一事务；users/email 冲突返回 false。 */
  create(tenantId: string, member: DirectoryMember): Promise<boolean>;
  /** CAS(users.version) 更新资料与现行任职；返回是否命中版本。 */
  update(tenantId: string, member: DirectoryMember, expectedVersion: number): Promise<boolean>;
  /** 停用返回码：version(版本变化)/active_work(仍有进行中任务)/ok。 */
  deactivate(tenantId: string, userId: string, expectedVersion: number): Promise<"ok" | "version" | "active_work">;
  /** 停用前最近一次任职（用于重新启用时沿用部门/岗位）。 */
  lastMembership(tenantId: string, userId: string): Promise<PreviousMembership | null>;
  /** 重新启用：status 回 active、清 archived_at，并按需新建现行任职；返回码 version/not_departed/ok。 */
  reactivate(tenantId: string, userId: string, expectedVersion: number, membership: PreviousMembership | null): Promise<"ok" | "version" | "not_departed">;
}
