import type { MemberDirectoryRepository, MemberDirectoryResult } from "@/src/modules/organization/application/member-directory-contracts";
import type { DirectoryMember, OrgUnitOption, PositionOption } from "@/src/modules/organization/domain/member-directory";
import { DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

export const DEMO_MANAGEMENT_ORG_ID = "20000000-0000-4000-8000-000000000001";
export const DEMO_DELIVERY_ORG_ID = "20000000-0000-4000-8000-000000000002";
export const DEMO_PRODUCT_ORG_ID = "20000000-0000-4000-8000-000000000003";
export const DEMO_OPERATIONS_ORG_ID = "20000000-0000-4000-8000-000000000004";

export const DEMO_MANAGEMENT_POSITION_ID = "50000000-0000-4000-8000-000000000001";
export const DEMO_DELIVERY_POSITION_ID = "50000000-0000-4000-8000-000000000002";
export const DEMO_PRODUCT_POSITION_ID = "50000000-0000-4000-8000-000000000003";
export const DEMO_OPERATIONS_POSITION_ID = "50000000-0000-4000-8000-000000000004";

const ORG_UNITS: OrgUnitOption[] = [
  { id: DEMO_MANAGEMENT_ORG_ID, name: "经营管理", status: "active" },
  { id: DEMO_DELIVERY_ORG_ID, name: "交付中心", status: "active" },
  { id: DEMO_PRODUCT_ORG_ID, name: "产品中心", status: "active" },
  { id: DEMO_OPERATIONS_ORG_ID, name: "运营中心", status: "active" },
];

const POSITIONS: PositionOption[] = [
  { id: DEMO_MANAGEMENT_POSITION_ID, orgUnitId: DEMO_MANAGEMENT_ORG_ID, name: "企业负责人", code: "head", status: "active" },
  { id: DEMO_DELIVERY_POSITION_ID, orgUnitId: DEMO_DELIVERY_ORG_ID, name: "交付负责人", code: "delivery-head", status: "active" },
  { id: DEMO_PRODUCT_POSITION_ID, orgUnitId: DEMO_PRODUCT_ORG_ID, name: "产品负责人", code: "product-head", status: "active" },
  { id: DEMO_OPERATIONS_POSITION_ID, orgUnitId: DEMO_OPERATIONS_ORG_ID, name: "运营负责人", code: "ops-head", status: "active" },
];

export const DEMO_MEMBER_IDS = [
  DEMO_MANAGER_ID,
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
] as const;

function seedMembers(): DirectoryMember[] {
  return [
    { id: DEMO_MANAGER_ID, displayName: "开发管理员", email: "manager@nexus.local", status: "active", version: 1, orgUnitId: DEMO_MANAGEMENT_ORG_ID, orgUnitName: "经营管理", positionId: DEMO_MANAGEMENT_POSITION_ID, positionName: "企业负责人", isManager: true },
    { id: DEMO_MEMBER_IDS[1], displayName: "周然", email: "zhouran@nexus.local", status: "active", version: 1, orgUnitId: DEMO_DELIVERY_ORG_ID, orgUnitName: "交付中心", positionId: DEMO_DELIVERY_POSITION_ID, positionName: "交付负责人", isManager: false },
    { id: DEMO_MEMBER_IDS[2], displayName: "林悦", email: "linyue@nexus.local", status: "active", version: 1, orgUnitId: DEMO_PRODUCT_ORG_ID, orgUnitName: "产品中心", positionId: DEMO_PRODUCT_POSITION_ID, positionName: "产品负责人", isManager: false },
    { id: DEMO_MEMBER_IDS[3], displayName: "陈屿", email: "chenyu@nexus.local", status: "active", version: 1, orgUnitId: DEMO_OPERATIONS_ORG_ID, orgUnitName: "运营中心", positionId: DEMO_OPERATIONS_POSITION_ID, positionName: "运营负责人", isManager: false },
  ];
}

export class InMemoryMemberDirectoryRepository implements MemberDirectoryRepository {
  private members: DirectoryMember[];

  constructor(seed = true) {
    this.members = seed ? seedMembers() : [];
  }

  async list(tenantId: string): Promise<MemberDirectoryResult> {
    if (tenantId !== DEMO_TENANT_ID) return { members: [], orgUnits: [], positions: [] };
    return { members: this.members.filter((item) => item.status !== "departed").map((item) => ({ ...item })), orgUnits: ORG_UNITS.map((item) => ({ ...item })), positions: POSITIONS.map((item) => ({ ...item })) };
  }

  async get(tenantId: string, userId: string): Promise<DirectoryMember | null> {
    if (tenantId !== DEMO_TENANT_ID) return null;
    const member = this.members.find((item) => item.id === userId);
    return member ? { ...member } : null;
  }

  async emailTaken(tenantId: string, email: string, excludeUserId?: string): Promise<boolean> {
    if (tenantId !== DEMO_TENANT_ID) return false;
    return this.members.some((item) => item.id !== excludeUserId && item.email?.toLowerCase() === email.trim().toLowerCase());
  }

  async create(tenantId: string, member: DirectoryMember): Promise<boolean> {
    if (tenantId !== DEMO_TENANT_ID) return false;
    if (this.members.some((item) => item.id === member.id)) return false;
    this.members.push({
      ...member,
      status: "active",
      version: 1,
      orgUnitName: ORG_UNITS.find((item) => item.id === member.orgUnitId)?.name,
      positionName: POSITIONS.find((item) => item.id === member.positionId)?.name,
    });
    return true;
  }

  async update(tenantId: string, member: DirectoryMember, expectedVersion: number): Promise<boolean> {
    if (tenantId !== DEMO_TENANT_ID) return false;
    const index = this.members.findIndex((item) => item.id === member.id);
    if (index < 0 || this.members[index].version !== expectedVersion) return false;
    this.members[index] = {
      ...this.members[index],
      displayName: member.displayName,
      email: member.email,
      orgUnitId: member.orgUnitId,
      positionId: member.positionId,
      isManager: member.isManager,
      version: member.version,
      orgUnitName: ORG_UNITS.find((item) => item.id === member.orgUnitId)?.name,
      positionName: POSITIONS.find((item) => item.id === member.positionId)?.name,
    };
    return true;
  }

  async deactivate(tenantId: string, userId: string, expectedVersion: number): Promise<"ok" | "version" | "active_work"> {
    if (tenantId !== DEMO_TENANT_ID) return "version";
    const index = this.members.findIndex((item) => item.id === userId);
    if (index < 0 || this.members[index].version !== expectedVersion) return "version";
    // 内存仓储不模拟 work_packages；always ok after version check.
    this.members[index] = { ...this.members[index], status: "departed", archivedAt: new Date().toISOString(), version: this.members[index].version + 1 };
    return "ok";
  }
}
