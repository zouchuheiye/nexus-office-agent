// 成员管理（员工目录）：组织/人员/岗位与现行任职关系的读与管理员变更。
// 变更规则都收敛在域层：姓名/邮箱/任职可改，停用是软删除（只关成员关系与状态，
// 不物理删 users 行），以保留任务历史与审计链。RLS 与原子审计由 0001/0009 保障。

export type MemberStatus = "invited" | "active" | "suspended" | "departed";

export type DirectoryMember = {
  id: string;
  displayName: string;
  email?: string;
  status: MemberStatus;
  version: number;
  orgUnitId?: string;
  orgUnitName?: string;
  positionId?: string;
  positionName?: string;
  isManager: boolean;
  archivedAt?: string;
};

export type OrgUnitOption = { id: string; name: string; status: "active" | "archived" };
export type PositionOption = { id: string; orgUnitId: string; name: string; code: string; status: "active" | "archived" };

export function isMemberActive(status: MemberStatus): boolean {
  return status === "active";
}

export function createMemberProfile(input: {
  id: string;
  displayName: string;
  email?: string;
  orgUnitId?: string;
  positionId?: string;
  isManager?: boolean;
}): DirectoryMember {
  // 入职登记只强求姓名：部门、岗位、邮箱在入职当天常常还没定，留空合法，后续用 editMemberProfile 补全。
  if (!input.displayName || input.displayName.trim().length < 1) throw new Error("MEMBER_DISPLAY_NAME_REQUIRED");
  if (input.displayName.trim().length > 80) throw new Error("MEMBER_DISPLAY_NAME_TOO_LONG");
  if (input.email !== undefined && input.email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) throw new Error("MEMBER_EMAIL_INVALID");
  return {
    id: input.id,
    displayName: input.displayName.trim(),
    email: input.email?.trim() || undefined,
    status: "active",
    version: 1,
    orgUnitId: input.orgUnitId,
    positionId: input.positionId,
    isManager: input.isManager ?? false,
  };
}

export function editMemberProfile(
  current: DirectoryMember,
  input: { displayName?: string; email?: string; orgUnitId?: string; positionId?: string; isManager?: boolean },
): DirectoryMember {
  if (input.displayName !== undefined && (input.displayName.trim().length < 1 || input.displayName.trim().length > 80)) throw new Error("MEMBER_DISPLAY_NAME_REQUIRED");
  if (input.email !== undefined && input.email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) throw new Error("MEMBER_EMAIL_INVALID");
  return {
    ...current,
    displayName: input.displayName?.trim() || current.displayName,
    email: input.email === undefined ? current.email : (input.email.trim() || undefined),
    orgUnitId: input.orgUnitId ?? current.orgUnitId,
    positionId: input.positionId === undefined ? current.positionId : (input.positionId || undefined),
    isManager: input.isManager ?? current.isManager,
    version: current.version + 1,
  };
}

/** 停用（软删除）：仍保留 users 行与历史；列表默认只展示在职成员。 */
export function deactivateMember(current: DirectoryMember): DirectoryMember {
  if (current.status === "departed") throw new Error("MEMBER_ALREADY_DEPARTED");
  return {
    ...current,
    status: "departed",
    archivedAt: new Date().toISOString(),
    version: current.version + 1,
  };
}

export function assertPositionBelongsToOrg(position: PositionOption | undefined, orgUnitId: string | undefined): void {
  if (!position) return;
  if (!orgUnitId || position.orgUnitId !== orgUnitId) throw new Error("MEMBER_POSITION_ORG_MISMATCH");
}
