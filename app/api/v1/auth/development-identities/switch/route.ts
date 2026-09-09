import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getDevelopmentIdentity } from "@/src/platform/context/development-context";
import { isLanDeployment } from "@/src/platform/config/runtime-config";
import { createSessionCookieValue, sessionCookieHeader } from "@/src/platform/identity/session";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({ key: z.string().trim().min(1).max(32) }).strict();

function isDevelopmentIdentityAllowed() {
  return process.env.NODE_ENV !== "production"
    || (isLanDeployment() && process.env.NEXUS_ALLOW_DEMO_IDENTITY === "true")
    || process.env.NEXUS_ALLOW_DEMO_IDENTITY === "true";
}

export async function POST(request: Request) {
  try {
    if (!isDevelopmentIdentityAllowed()) throw new Error("DEMO_IDENTITY_DISABLED");
    const secret = process.env.SESSION_SECRET;
    if (!secret) throw new Error("DEMO_IDENTITY_SECRET_MISSING");
    const input = schema.parse(await parseJson(request));
    const identity = getDevelopmentIdentity(input.key);
    if (!identity) throw new Error("DEMO_IDENTITY_NOT_FOUND");
    const value = createSessionCookieValue({
      tenantId: "00000000-0000-4000-8000-000000000001",
      actorId: identity.actorId,
      channel: "web",
      roles: identity.roles,
      permissions: identity.permissions,
      dataScopes: identity.dataScopes,
      sessionId: randomUUID(),
    }, secret);
    const response = NextResponse.json({ data: { identity: { key: identity.key, actorId: identity.actorId, displayName: identity.displayName, roles: identity.roles } } });
    response.headers.append("set-cookie", sessionCookieHeader(value));
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
