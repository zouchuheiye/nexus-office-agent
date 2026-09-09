// Requirements: SR-001, SR-002, AC-003 (成员管理：新增/编辑/停用均为服务端授权写操作)
import { describe, expect, it } from "vitest";
import { MemberDirectoryService } from "@/src/modules/organization/application/member-directory-service";
import { createMemberSchema, updateMemberSchema } from "@/src/modules/organization/application/member-directory-schemas";
import { assertPositionBelongsToOrg, createMemberProfile, deactivateMember, editMemberProfile } from "@/src/modules/organization/domain/member-directory";
import { InMemoryMemberDirectoryRepository, DEMO_DELIVERY_ORG_ID, DEMO_DELIVERY_POSITION_ID, DEMO_PRODUCT_ORG_ID, DEMO_PRODUCT_POSITION_ID } from "@/src/modules/organization/infrastructure/in-memory-member-directory-repository";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

const DELIVERY_OWNER_ID = "10000000-0000-4000-8000-000000000002";

function manager() { return createDevelopmentRequestContext("member-manager"); }
function member() { return createDevelopmentRequestContext("member-reader", "delivery"); }
function noPermission() { return { ...createDevelopmentRequestContext("member-outsider", "operations"), permissions: [] as string[] }; }

async function fixture() {
  const service = new MemberDirectoryService(new InMemoryMemberDirectoryRepository());
  return { service };
}

describe("member-directory domain", () => {
  it("creates a profile with name validation and normalizes email", () => {
    const member = createMemberProfile({ id: "uuid-1", displayName: "  新同事  ", email: " NEW@EXAMPLE.com ", orgUnitId: DEMO_DELIVERY_ORG_ID });
    expect(member.displayName).toBe("新同事");
    expect(member.email).toBe("NEW@EXAMPLE.com");
    expect(member).toMatchObject({ status: "active", version: 1, isManager: false });
    expect(() => createMemberProfile({ id: "x", displayName: "A" })).toThrow("MEMBER_DISPLAY_NAME_REQUIRED");
    expect(() => createMemberProfile({ id: "x", displayName: "小明", email: "not-an-email" })).toThrow("MEMBER_EMAIL_INVALID");
  });

  it("edits only provided fields and increments the version", () => {
    const base = createMemberProfile({ id: "uuid-1", displayName: "周然", orgUnitId: DEMO_DELIVERY_ORG_ID });
    const edited = editMemberProfile(base, { positionId: DEMO_PRODUCT_POSITION_ID, isManager: true });
    expect(edited.positionId).toBe(DEMO_PRODUCT_POSITION_ID);
    expect(edited.orgUnitId).toBe(DEMO_DELIVERY_ORG_ID);
    expect(edited.isManager).toBe(true);
    expect(edited.version).toBe(2);
    expect(() => editMemberProfile(base, { email: "bad" })).toThrow("MEMBER_EMAIL_INVALID");
  });

  it("deactivates only once and never deletes the row", () => {
    const base = createMemberProfile({ id: "uuid-1", displayName: "周然" });
    const departed = deactivateMember(base);
    expect(departed.status).toBe("departed");
    expect(departed.archivedAt).toBeDefined();
    expect(departed.version).toBe(2);
    expect(() => deactivateMember(departed)).toThrow("MEMBER_ALREADY_DEPARTED");
  });

  it("rejects a position that belongs to another org unit", () => {
    expect(() => assertPositionBelongsToOrg(undefined, DEMO_DELIVERY_ORG_ID)).not.toThrow();
    expect(() => assertPositionBelongsToOrg({ id: DEMO_PRODUCT_POSITION_ID, orgUnitId: DEMO_PRODUCT_ORG_ID, name: "产品负责人", code: "product", status: "active" }, DEMO_DELIVERY_ORG_ID)).toThrow("MEMBER_POSITION_ORG_MISMATCH");
  });
});

describe("member-directory service", () => {
  it("lists only with read permission and reports canManage for admins", async () => {
    const { service } = await fixture();
    const view = await service.list(manager());
    expect(view.members.map(({ displayName }) => displayName)).toEqual(expect.arrayContaining(["周然", "开发管理员"]));
    expect(view.orgUnits.length).toBeGreaterThanOrEqual(4);
    expect(view.canManage).toBe(true);
    const readerView = await service.list(member());
    expect(readerView.canManage).toBe(false);
    await expect(service.list(noPermission())).rejects.toThrow("POLICY_DENIED:organization_member:read");
  });

  it("admins can add, move and deactivate a member; email collisions and stale versions are rejected", async () => {
    const { service } = await fixture();
    const actor = manager();
    const created = await service.createMember(actor, createMemberSchema.parse({ displayName: "新员工甲", email: "new-hire@nexus.local", orgUnitId: DEMO_DELIVERY_ORG_ID, positionId: DEMO_DELIVERY_POSITION_ID }));
    expect(created).toMatchObject({ status: "active", version: 1, orgUnitName: "交付中心" });

    await expect(service.createMember(actor, { displayName: "另一个", email: "new-hire@nexus.local" })).rejects.toThrow("MEMBER_EMAIL_TAKEN");
    // 移动部门时岗位必须属于目标部门
    await expect(service.updateMember(actor, created.id, { expectedVersion: 1, orgUnitId: DEMO_PRODUCT_ORG_ID, positionId: DEMO_DELIVERY_POSITION_ID })).rejects.toThrow("MEMBER_POSITION_ORG_MISMATCH");
    const moved = await service.updateMember(actor, created.id, { expectedVersion: 1, orgUnitId: DEMO_PRODUCT_ORG_ID, positionId: DEMO_PRODUCT_POSITION_ID });
    expect(moved).toMatchObject({ orgUnitName: "产品中心", positionName: "产品负责人", version: 2 });

    await expect(service.updateMember(actor, created.id, { expectedVersion: 1, displayName: "旧版本写入" })).rejects.toThrow("MEMBER_VERSION_CONFLICT");
    const deactivated = await service.deactivateMember(actor, created.id, { expectedVersion: 2 });
    expect(deactivated.deactivatedMemberId).toBe(created.id);
    expect((await service.list(actor)).members.find(({ id }) => id === created.id)).toBeUndefined();
  });

  it("non-admins cannot create, edit or deactivate members", async () => {
    const { service } = await fixture();
    const reader = member();
    await expect(service.createMember(reader, { displayName: "越权" })).rejects.toThrow("POLICY_DENIED:organization_member:admin");
    await expect(service.updateMember(reader, DELIVERY_OWNER_ID, { expectedVersion: 1, displayName: "越权改名" })).rejects.toThrow("POLICY_DENIED:organization_member:admin");
    await expect(service.deactivateMember(reader, DELIVERY_OWNER_ID, { expectedVersion: 1 })).rejects.toThrow("POLICY_DENIED:organization_member:admin");
  });

  it("forbids deactivating yourself so an admin cannot lock the tenant out", async () => {
    const { service } = await fixture();
    await expect(service.deactivateMember(manager(), DEMO_MANAGER_ID, { expectedVersion: 1 })).rejects.toThrow("MEMBER_SELF_DEACTIVATE_DENIED");
  });

  it("schemas keep strict shapes and require at least one editable field", () => {
    expect(createMemberSchema.safeParse({ displayName: "", email: "a@b.c" }).success).toBe(false);
    expect(updateMemberSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(updateMemberSchema.safeParse({ expectedVersion: 1, displayName: "周然" }).success).toBe(true);
    expect(updateMemberSchema.safeParse({ expectedVersion: 1, displayName: "周然", extra: true }).success).toBe(false);
  });

  it("guard: manager actor id must match tenant fixture (sanity for dev context)", () => {
    expect(manager().tenantId).toBe(DEMO_TENANT_ID);
    expect(manager().actorId).toBe(DEMO_MANAGER_ID);
  });
});
