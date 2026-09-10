// Requirements: SR-001, SR-002（已停用/离职名单只对管理员可见）
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as listMembers, POST as createMember } from "@/app/api/v1/organization/members/route";
import { DELETE as deactivateMember } from "@/app/api/v1/organization/members/[id]/route";
import { POST as reactivateMember } from "@/app/api/v1/organization/members/[id]/reactivate/route";
import { createSessionCookieValue } from "@/src/platform/identity/session";
import { markEmployeeActive } from "@/src/platform/identity/employee-status";
import { DEMO_MANAGER_ID } from "@/src/platform/context/development-context";

const secret = "0123456789abcdef0123456789abcdef";
const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const DELIVERY_ID = "10000000-0000-4000-8000-000000000002";

function cookieFor(actorId: string) {
  return `nexus_session=${encodeURIComponent(createSessionCookieValue({ tenantId: TENANT_ID, actorId, channel: "web" }, secret))}`;
}

function request(url: string, cookie: string, body?: unknown, method = "GET") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterEach(() => {
  markEmployeeActive(DELIVERY_ID);
  vi.unstubAllEnvs();
});

describe("organization member HTTP 权限边界", () => {
  it("hides departed members from non-admins and denies the explicit request", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", secret);
    vi.stubEnv("DATABASE_URL", "");
    const managerCookie = cookieFor(DEMO_MANAGER_ID);
    const readerCookie = cookieFor(DELIVERY_ID);

    const created = await createMember(request("http://localhost/api/v1/organization/members", managerCookie, { displayName: "接口离职样例" }, "POST"));
    expect(created.status).toBe(201);
    const member = (await created.json()).data.member as { id: string; version: number };

    const deactivated = await deactivateMember(
      request(`http://localhost/api/v1/organization/members/${member.id}?expectedVersion=${member.version}`, managerCookie, undefined, "DELETE"),
      { params: Promise.resolve({ id: member.id }) },
    );
    expect(deactivated.status).toBe(200);

    // 普通成员：默认目录不含离职者
    const readerList = await listMembers(request("http://localhost/api/v1/organization/members", readerCookie));
    expect(readerList.status).toBe(200);
    const readerPayload = await readerList.json();
    expect(readerPayload.data.canManage).toBe(false);
    expect(readerPayload.data.members.some((item: { id: string }) => item.id === member.id)).toBe(false);

    // 普通成员：显式索取离职名单被拒（403，不是静默忽略）
    const denied = await listMembers(request("http://localhost/api/v1/organization/members?includeDeparted=true", readerCookie));
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("ACCESS_DENIED");

    // 管理员：可以看到已停用成员
    const adminList = await listMembers(request("http://localhost/api/v1/organization/members?includeDeparted=true", managerCookie));
    expect(adminList.status).toBe(200);
    const adminPayload = await adminList.json();
    expect(adminPayload.data.canManage).toBe(true);
    expect(adminPayload.data.members.find((item: { id: string }) => item.id === member.id)).toMatchObject({ status: "departed" });

    // 非管理员也不能重新启用
    const forbidden = await reactivateMember(
      request(`http://localhost/api/v1/organization/members/${member.id}/reactivate`, readerCookie, { expectedVersion: member.version + 1 }, "POST"),
      { params: Promise.resolve({ id: member.id }) },
    );
    expect(forbidden.status).toBe(403);
  });
});
