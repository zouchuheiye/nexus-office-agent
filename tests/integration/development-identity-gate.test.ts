// Requirements: SR-001, SR-002, AC-003（停用/离职员工不得再进入枢纽 Agent）
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as listIdentities } from "@/app/api/v1/auth/development-identities/route";
import { POST as switchIdentity } from "@/app/api/v1/auth/development-identities/switch/route";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";
import { markEmployeeActive } from "@/src/platform/identity/employee-status";
import { getMemberDirectoryService } from "@/src/modules/organization/runtime";

const secret = "0123456789abcdef0123456789abcdef";
const DELIVERY_ID = "10000000-0000-4000-8000-000000000002";
const PRODUCT_ID = "10000000-0000-4000-8000-000000000003";

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/v1/auth/development-identities/switch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sessionFromResponse(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(/nexus_session=([^;]+)/);
  if (!match) throw new Error("session cookie missing");
  return decodeURIComponent(match[1]);
}

function requestWithCookie(cookie: string) {
  return new Request("http://localhost", { headers: { cookie: `nexus_session=${encodeURIComponent(cookie)}` } });
}

afterEach(() => {
  markEmployeeActive(DELIVERY_ID);
  markEmployeeActive(PRODUCT_ID);
  vi.unstubAllEnvs();
});

describe("停用员工的进入权", () => {
  it("停用后旧会话立即失效，且不会退化成默认管理员", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", secret);
    vi.stubEnv("DATABASE_URL", "");

    const switched = await switchIdentity(jsonRequest({ key: "delivery" }));
    expect(switched.status).toBe(200);
    const cookie = sessionFromResponse(switched);
    await expect(resolveRequestContext(requestWithCookie(cookie))).resolves.toMatchObject({ actorId: DELIVERY_ID, tenantId: DEMO_TENANT_ID });

    const manager = createDevelopmentRequestContext("gate-manager");
    const deactivated = await getMemberDirectoryService().deactivateMember(manager, DELIVERY_ID, { expectedVersion: 1 });
    expect(deactivated.deactivatedMemberId).toBe(DELIVERY_ID);

    // 旧 Cookie 仍然验签通过，但员工已停用：必须 401，且绝不能回退成管理员身份。
    await expect(resolveRequestContext(requestWithCookie(cookie))).rejects.toThrow("AUTHENTICATION_REQUIRED");
  });

  it("停用的身份不再出现在切换列表里，也无法再切换过去", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", secret);
    vi.stubEnv("DATABASE_URL", "");

    const before = await (await listIdentities()).json();
    expect(before.data.identities.map((identity: { key: string }) => identity.key)).toContain("product");

    await getMemberDirectoryService().deactivateMember(createDevelopmentRequestContext("gate-manager"), PRODUCT_ID, { expectedVersion: 1 });

    const after = await (await listIdentities()).json();
    const keys = after.data.identities.map((identity: { key: string }) => identity.key);
    expect(keys).not.toContain("product");
    expect(keys).toContain("manager");

    const rejected = await switchIdentity(jsonRequest({ key: "product" }));
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: "DEMO_IDENTITY_INACTIVE" } });

    // 其他在职身份不受影响
    const ok = await switchIdentity(jsonRequest({ key: "manager" }));
    expect(ok.status).toBe(200);
    expect((await resolveRequestContext(requestWithCookie(sessionFromResponse(ok)))).actorId).toBe(DEMO_MANAGER_ID);
  });
});
