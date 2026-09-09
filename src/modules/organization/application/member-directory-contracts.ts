import type { DirectoryMember, OrgUnitOption, PositionOption } from "@/src/modules/organization/domain/member-directory";

export type MemberDirectoryResult = {
  members: DirectoryMember[];
  orgUnits: OrgUnitOption[];
  positions: PositionOption[];
};

export interface MemberDirectoryRepository {
  list(tenantId: string): Promise<MemberDirectoryResult>;
  get(tenantId: string, userId: string): Promise<DirectoryMember | null>;
  /** 邮箱是否已被本租户其他成员占用。 */
  emailTaken(tenantId: string, email: string, excludeUserId?: string): Promise<boolean>;
  /** 新增成员：users + 现行任职同一事务；users/email 冲突返回 false。 */
  create(tenantId: string, member: DirectoryMember): Promise<boolean>;
  /** CAS(users.version) 更新资料与现行任职；返回是否命中版本。 */
  update(tenantId: string, member: DirectoryMember, expectedVersion: number): Promise<boolean>;
  /** 停用返回码：version(版本变化)/active_work(仍有进行中任务)/ok。 */
  deactivate(tenantId: string, userId: string, expectedVersion: number): Promise<"ok" | "version" | "active_work">;
}
