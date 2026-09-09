// Requirements: SR-001, SR-002, SR-004, AC-003
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as listIdentities } from "@/app/api/v1/auth/development-identities/route";
import { POST as switchIdentity } from "@/app/api/v1/auth/development-identities/switch/route";
import { GET as getBootstrap } from "@/app/api/v1/workspace/bootstrap/route";
import { GET as getBoard } from "@/app/api/v1/task-command/board/route";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { DEMO_MANAGER_ID } from "@/src/platform/context/development-context";
import { DEMO_DELIVERY_OWNER_ID } from "@/src/modules/task-command/infrastructure/in-memory-repository";
import { verifySessionCookieValue } from "@/src/platform/identity/session";

const secret = "0123456789abcdef0123456789abcdef";

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

afterEach(() => vi.unstubAllEnvs());

describe("development identity API", () => {
  it("lists only server-defined identities and never exposes their grants", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", secret);

    const response = await listIdentities();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.identities).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "manager", displayName: "开发管理员" }),
      expect.objectContaining({ key: "delivery", displayName: "周然" }),
      expect.objectContaining({ key: "product", displayName: "林悦" }),
      expect.objectContaining({ key: "operations", displayName: "陈屿" }),
    ]));
    expect(payload.data.identities[0]).not.toHaveProperty("permissions");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("fails closed when production has not explicitly enabled demo identity", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXUS_ALLOW_DEMO_IDENTITY", "false");
    vi.stubEnv("SESSION_SECRET", secret);

    const response = await listIdentities();
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "DEMO_IDENTITY_DISABLED" } });
  });

  it("does not expose a switch when its signing secret is missing", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", "");

    const response = await listIdentities();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "DEMO_IDENTITY_SECRET_MISSING" } });
  });

  it("rejects unknown keys instead of silently falling back to the manager", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", secret);

    const response = await switchIdentity(jsonRequest({ key: "arbitrary-actor" }));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "DEMO_IDENTITY_NOT_FOUND" } });
  });

  it("rotates the signed session and resolves permissions from the server whitelist", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", secret);

    const response = await switchIdentity(jsonRequest({ key: "delivery" }));
    expect(response.status).toBe(200);
    const cookie = sessionFromResponse(response);
    const claims = verifySessionCookieValue(cookie, secret);
    expect(claims.actorId).toBe(DEMO_DELIVERY_OWNER_ID);
    expect(claims.sessionId).toBeTruthy();
    // 会话 Cookie 只携带最小身份标识（避免超 4KB 浏览器限制被丢弃）；权限由服务端白名单重建。
    expect(claims.permissions).toBeUndefined();

    const context = await resolveRequestContext(new Request("http://localhost", {
      headers: { cookie: `nexus_session=${encodeURIComponent(cookie)}`, "x-user-id": DEMO_MANAGER_ID },
    }));
    expect(context.actorId).toBe(DEMO_DELIVERY_OWNER_ID);
    expect(context.permissions).toEqual(expect.arrayContaining(["work_task:claim"]));
    expect(context.permissions).not.toContain("work_task:admin");
  });

  it("ignores a signed cookie from another tenant rather than impersonating its actor", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", secret);
    const response = await switchIdentity(jsonRequest({ key: "delivery" }));
    const cookie = sessionFromResponse(response);
    const altered = `${cookie.slice(0, cookie.lastIndexOf("."))}.${cookie.slice(cookie.lastIndexOf(".") + 1)}`;
    const payload = JSON.parse(Buffer.from(altered.split(".")[0], "base64url").toString("utf8")) as { tenantId: string };
    payload.tenantId = "attacker-tenant";
    const forgedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const forged = `${forgedPayload}.${cookie.slice(cookie.lastIndexOf(".") + 1)}`;

    const context = await resolveRequestContext(new Request("http://localhost", { headers: { cookie: `nexus_session=${encodeURIComponent(forged)}` } }));
    expect(context.actorId).toBe(DEMO_MANAGER_ID);
  });

  it("P1: switch cookie re-scopes bootstrap identity, board actor and task-command workspace to 周然", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", secret);
    const response = await switchIdentity(jsonRequest({ key: "delivery" }));
    expect(response.status).toBe(200);
    const cookie = sessionFromResponse(response);
    const headers = { cookie: `nexus_session=${encodeURIComponent(cookie)}`, "x-trace-id": "dev-identity-scoped" };

    const bootstrap = await getBootstrap(new Request("http://localhost/api/v1/workspace/bootstrap", { headers }));
    expect(bootstrap.status).toBe(200);
    const bootstrapPayload = await bootstrap.json();
    expect(bootstrapPayload.data.identity.actorId).toBe(DEMO_DELIVERY_OWNER_ID);
    expect(bootstrapPayload.data.identity.displayName).toBe("周然");

    const board = await getBoard(new Request("http://localhost/api/v1/task-command/board", { headers }));
    expect(board.status).toBe(200);
    expect((await board.json()).data.actorId).toBe(DEMO_DELIVERY_OWNER_ID);

    const context = await resolveRequestContext(new Request("http://localhost", { headers: { cookie: `nexus_session=${encodeURIComponent(cookie)}` } }));
    expect(context.actorId).toBe(DEMO_DELIVERY_OWNER_ID);
  });

  it("keeps the highest-grant manager cookie small enough for browsers to overwrite stale identities", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", secret);
    // 权限最大的“开发管理员”此前把完整权限集写进 Cookie，接近 5KB 超过浏览器 4KB 上限，
    // 导致切换后新 Cookie 被静默丢弃、界面停留旧身份（如周然）。Cookie 现在只承载身份标识。
    const response = await switchIdentity(jsonRequest({ key: "manager" }));
    expect(response.status).toBe(200);
    const cookie = sessionFromResponse(response);
    expect(cookie.length).toBeLessThan(2_000);
    const claims = verifySessionCookieValue(cookie, secret);
    expect(claims.actorId).toBe(DEMO_MANAGER_ID);
    expect(claims.permissions).toBeUndefined();
    const context = await resolveRequestContext(new Request("http://localhost", {
      headers: { cookie: `nexus_session=${encodeURIComponent(cookie)}` },
    }));
    expect(context.actorId).toBe(DEMO_MANAGER_ID);
    expect(context.permissions).toContain("work_task:admin");
  });
});
