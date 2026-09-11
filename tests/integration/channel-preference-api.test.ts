// Requirements: PR-009, MR-049（P4：通知通道偏好的 HTTP 契约）
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getPreferences, PUT as putPreferences } from "@/app/api/v1/me/channel-preferences/route";
import { POST as switchIdentity } from "@/app/api/v1/auth/development-identities/switch/route";

const secret = "0123456789abcdef0123456789abcdef";

function request(method: "GET" | "PUT", body?: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-trace-id": "channel-preference-api-test" };
  if (cookie) headers.cookie = `nexus_session=${encodeURIComponent(cookie)}`;
  return new Request("http://localhost/api/v1/me/channel-preferences", { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function sessionFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(/nexus_session=([^;]+)/);
  if (!match) throw new Error("session cookie missing");
  return decodeURIComponent(match[1]);
}

async function identityCookie(key: string): Promise<string> {
  const switched = await switchIdentity(new Request("http://localhost/api/v1/auth/development-identities/switch", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }),
  }));
  expect(switched.status).toBe(200);
  return sessionFrom(switched);
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("通知通道偏好 HTTP 契约", () => {
  it("默认只走站内：未设置过时返回默认值而不是 404", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", secret);
    vi.stubEnv("DATABASE_URL", "");

    const response = await getPreferences(request("GET", undefined, await identityCookie("manager")));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data).toMatchObject({ orderedProviders: ["web"], configured: false, digestEnabled: true, updatedAt: null });
    expect(payload.data.availableProviders).toEqual(["web", "feishu", "dingtalk", "wecom"]);
  });

  it("PUT 只写本人：两个身份各写各的，读取互不影响", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", secret);
    vi.stubEnv("DATABASE_URL", "");

    const manager = await identityCookie("manager");
    const delivery = await identityCookie("delivery");
    const written = await putPreferences(request("PUT", { orderedProviders: ["wecom", "web"], quietHours: { start: "22:00", end: "07:00", timezoneOffsetMinutes: 480 } }, manager));
    expect(written.status).toBe(200);
    expect((await written.json()).data).toMatchObject({ orderedProviders: ["wecom", "web"], configured: true });

    const other = await (await getPreferences(request("GET", undefined, delivery))).json();
    expect(other.data).toMatchObject({ orderedProviders: ["web"], configured: false });
    const rereadManager = await (await getPreferences(request("GET", undefined, manager))).json();
    expect(rereadManager.data.orderedProviders).toEqual(["wecom", "web"]);
  });

  it("非法入参与多余字段返回 422，而不是写进去一半", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", secret);
    vi.stubEnv("DATABASE_URL", "");
    const manager = await identityCookie("manager");

    const bad = await putPreferences(request("PUT", { orderedProviders: ["slack"] }, manager));
    expect(bad.status).toBe(422);
    const extra = await putPreferences(request("PUT", { orderedProviders: ["web"], userId: "10000000-0000-4000-8000-000000000002" }, manager));
    expect(extra.status).toBe(422);
    const after = await (await getPreferences(request("GET", undefined, manager))).json();
    expect(after.data.orderedProviders).not.toContain("slack");
  });
});
