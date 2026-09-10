// Requirements: SR-001, SR-002, AC-003（员工登记 Agent 通道：仅姓名即可登记，写入受权限约束并留痕）
import { describe, expect, it } from "vitest";
import { MemberDirectoryService } from "@/src/modules/organization/application/member-directory-service";
import { registerMemberDirectoryTools } from "@/src/modules/organization/application/member-directory-agent-tools";
import {
  DEMO_DELIVERY_ORG_ID, DEMO_DELIVERY_POSITION_ID, DEMO_PRODUCT_ORG_ID, DEMO_PRODUCT_POSITION_ID,
  InMemoryMemberDirectoryRepository,
} from "@/src/modules/organization/infrastructure/in-memory-member-directory-repository";
import { assertToolPolicy, ToolRegistry } from "@/src/modules/agent/domain/tool";
import { createDefaultSkillRegistry } from "@/src/modules/agent/domain/skill";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID } from "@/src/platform/context/development-context";

const TOOL_IDS = ["organization.list_members", "organization.add_member", "organization.update_member", "organization.deactivate_member", "organization.reactivate_member"];

function setup() {
  const service = new MemberDirectoryService(new InMemoryMemberDirectoryRepository());
  const registry = new ToolRegistry();
  registerMemberDirectoryTools(registry, service);
  return { service, registry };
}

const manager = () => createDevelopmentRequestContext("member-tools-manager");
const reader = () => createDevelopmentRequestContext("member-tools-reader", "delivery");
const nobody = () => ({ ...createDevelopmentRequestContext("member-tools-outsider", "operations"), permissions: [] as string[] });

function tool(registry: ToolRegistry, id: string, context = manager()) {
  const found = registry.available(context).find((item) => item.id === id);
  if (!found) throw new Error(`tool unavailable: ${id}`);
  return found;
}

describe("member directory agent tools", () => {
  it("registers the four tools under the organization-member-directory skill", () => {
    const { registry } = setup();
    const ids = registry.list().map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(TOOL_IDS));
    const skills = createDefaultSkillRegistry();
    for (const id of TOOL_IDS) expect(skills.forTool(id)?.id).toBe("organization-member-directory");
  });

  it("exposes writes only to admins and keeps the directory readable for members", () => {
    const { registry } = setup();
    expect(registry.available(manager()).map((item) => item.id)).toEqual(expect.arrayContaining(TOOL_IDS));
    expect(registry.available(reader()).map((item) => item.id)).toEqual(["organization.list_members"]);
    expect(registry.available(nobody())).toEqual([]);
  });

  it("gates deactivation behind human confirmation while onboarding writes directly", () => {
    const { registry } = setup();
    expect(assertToolPolicy(manager(), tool(registry, "organization.add_member"))).toEqual({ requiresConfirmation: false });
    expect(assertToolPolicy(manager(), tool(registry, "organization.update_member"))).toEqual({ requiresConfirmation: false });
    expect(assertToolPolicy(manager(), tool(registry, "organization.deactivate_member"))).toEqual({ requiresConfirmation: true });
    expect(assertToolPolicy(manager(), tool(registry, "organization.reactivate_member"))).toEqual({ requiresConfirmation: true });
  });

  it("reactivates a departed member through a confirmation-gated proposal", async () => {
    const { registry } = setup();
    const addTool = tool(registry, "organization.add_member");
    const created = await addTool.execute(manager(), { displayName: "回流同事", orgUnitId: DEMO_PRODUCT_ORG_ID }) as { id: string; version: number };
    const deactivateTool = tool(registry, "organization.deactivate_member");
    await deactivateTool.execute(manager(), { memberId: created.id, expectedVersion: created.version, memberName: "回流同事" });

    const reactivateTool = tool(registry, "organization.reactivate_member");
    expect(reactivateTool.preview({ memberId: created.id, expectedVersion: 2, memberName: "回流同事" })).toContain("重新启用");
    const restored = await reactivateTool.execute(manager(), { memberId: created.id, expectedVersion: 2, memberName: "回流同事" }) as { status: string; version: number; orgUnitName?: string };
    expect(restored).toMatchObject({ status: "active", version: 3, orgUnitName: "产品中心" });
    // 已在职者不能再次"重新启用"
    await expect(reactivateTool.execute(manager(), { memberId: created.id, expectedVersion: 3 })).rejects.toThrow("MEMBER_NOT_DEPARTED");
  });

  it("registers a new hire from a name alone and says which fields are still open", async () => {
    const { registry } = setup();
    const addTool = tool(registry, "organization.add_member");
    expect(addTool.preview({ displayName: "张三" })).toContain("张三");
    expect(addTool.preview({ displayName: "张三" })).toContain("部门");
    const created = await addTool.execute(manager(), { displayName: "张三" }) as { id: string; displayName: string; status: string; orgUnitId?: string };
    expect(created).toMatchObject({ displayName: "张三", status: "active" });
    expect(created.orgUnitId).toBeUndefined();
    // 单字姓名同样可以登记
    const single = await addTool.execute(manager(), { displayName: "李" }) as { displayName: string };
    expect(single.displayName).toBe("李");
  });

  it("accepts org and position when known but rejects a position from another department", async () => {
    const { registry } = setup();
    const addTool = tool(registry, "organization.add_member");
    const withOrg = await addTool.execute(manager(), { displayName: "王五", orgUnitId: DEMO_DELIVERY_ORG_ID, positionId: DEMO_DELIVERY_POSITION_ID }) as { orgUnitName?: string; positionName?: string };
    expect(withOrg).toMatchObject({ orgUnitName: "交付中心", positionName: "交付负责人" });
    await expect(addTool.execute(manager(), { displayName: "赵六", orgUnitId: DEMO_DELIVERY_ORG_ID, positionId: DEMO_PRODUCT_POSITION_ID })).rejects.toThrow("MEMBER_POSITION_ORG_MISMATCH");
  });

  it("completes a member profile later with list lookup, version CAS and org/position move", async () => {
    const { registry } = setup();
    const addTool = tool(registry, "organization.add_member");
    const created = await addTool.execute(manager(), { displayName: "张三" }) as { id: string; version: number };

    const listTool = tool(registry, "organization.list_members");
    const filtered = await listTool.execute(manager(), { keyword: "张三" }) as { members: Array<{ id: string }> };
    expect(filtered.members).toEqual([expect.objectContaining({ id: created.id })]);

    const updateTool = tool(registry, "organization.update_member");
    const updated = await updateTool.execute(manager(), { memberId: created.id, expectedVersion: created.version, memberName: "张三", orgUnitId: DEMO_PRODUCT_ORG_ID, positionId: DEMO_PRODUCT_POSITION_ID }) as { orgUnitName?: string; positionName?: string; version: number };
    expect(updated).toMatchObject({ orgUnitName: "产品中心", positionName: "产品负责人", version: 2 });
    await expect(updateTool.execute(manager(), { memberId: created.id, expectedVersion: created.version, displayName: "张三丰" })).rejects.toThrow("MEMBER_VERSION_CONFLICT");
    // 空改动在入口 schema 就被拒绝（同步抛出，不进入服务层）
    expect(() => updateTool.execute(manager(), { memberId: created.id, expectedVersion: 2 })).toThrow(/至少需要修改一个字段/);
  });

  it("keeps departure soft, confirmation-gated and never self-targeted", async () => {
    const { registry } = setup();
    const addTool = tool(registry, "organization.add_member");
    const created = await addTool.execute(manager(), { displayName: "待离职同事" }) as { id: string; version: number };
    const deactivateTool = tool(registry, "organization.deactivate_member");
    expect(deactivateTool.preview({ memberId: created.id, expectedVersion: 1, memberName: "待离职同事" })).toContain("软删除");
    const result = await deactivateTool.execute(manager(), { memberId: created.id, expectedVersion: created.version, memberName: "待离职同事" }) as { deactivatedMemberId: string; version: number };
    expect(result).toMatchObject({ deactivatedMemberId: created.id, version: 2 });
    const listTool = tool(registry, "organization.list_members");
    const after = await listTool.execute(manager(), {}) as { members: Array<{ id: string }> };
    expect(after.members.some(({ id }) => id === created.id)).toBe(false);
    await expect(deactivateTool.execute(manager(), { memberId: DEMO_MANAGER_ID, expectedVersion: 1 })).rejects.toThrow("MEMBER_SELF_DEACTIVATE_DENIED");
  });
});
