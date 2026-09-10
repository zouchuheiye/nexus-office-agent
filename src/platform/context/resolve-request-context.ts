import { createDevelopmentRequestContext, getDevelopmentIdentityByActorId } from "@/src/platform/context/development-context";
import { assertRequestContext, type RequestContext } from "@/src/platform/context/request-context";
import { readCookie, SESSION_COOKIE_NAME, verifySessionCookieWithRotation } from "@/src/platform/identity/session";
import { getEmployeeStatusChecker } from "@/src/platform/identity/employee-status";
import { enterRequestContext } from "@/src/platform/context/request-context-storage";
import { getProductionAuthorizationResolver, type AuthorizationResolver } from "@/src/platform/identity/authorization-resolver";
import { isLanDeployment } from "@/src/platform/config/runtime-config";

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("AUTHENTICATION_REQUIRED");
    this.name = "AuthenticationRequiredError";
  }
}

export async function resolveRequestContext(request: Request, authorizationResolver?: AuthorizationResolver): Promise<RequestContext> {
  const demoIdentityEnabled = process.env.NEXUS_ALLOW_DEMO_IDENTITY === "true";
  const lanIdentityEnabled = isLanDeployment() && demoIdentityEnabled;
  if (process.env.NODE_ENV === "production" && !demoIdentityEnabled && !lanIdentityEnabled) {
    const serialized = readCookie(request, SESSION_COOKIE_NAME);
    const secret = process.env.SESSION_SECRET;
    if (!serialized || !secret) throw new AuthenticationRequiredError();
    let session;
    try {
      session = verifySessionCookieWithRotation(serialized, [secret, process.env.SESSION_SECRET_PREVIOUS ?? ""]);
    } catch {
      throw new AuthenticationRequiredError();
    }
    const authorization = await (authorizationResolver ?? getProductionAuthorizationResolver()).resolve(session.tenantId, session.actorId);
    if (!authorization) throw new AuthenticationRequiredError();
    try {
      const context: RequestContext = {
        tenantId: session.tenantId,
        actorId: session.actorId,
        sessionId: session.sessionId,
        channel: session.channel,
        roles: authorization.roles,
        permissions: authorization.permissions,
        dataScopes: authorization.dataScopes,
        traceId: request.headers.get("x-trace-id")?.trim().slice(0, 128) || randomTraceId(),
      };
      assertRequestContext(context);
      enterRequestContext(context);
      return context;
    } catch {
      throw new AuthenticationRequiredError();
    }
  }

  const traceId = request.headers.get("x-trace-id")?.trim() || undefined;
  const demoSession = readCookie(request, SESSION_COOKIE_NAME);
  if (demoSession && process.env.SESSION_SECRET) {
    let session: ReturnType<typeof verifySessionCookieWithRotation> | null = null;
    try {
      session = verifySessionCookieWithRotation(demoSession, [process.env.SESSION_SECRET, process.env.SESSION_SECRET_PREVIOUS ?? ""]);
    } catch {
      // 无效或过期的开发 Cookie 被忽略；开发夹具回退到默认身份。
      session = null;
    }
    if (session) {
      const identity = getDevelopmentIdentityByActorId(session.actorId);
      if (identity && session.tenantId === createDevelopmentRequestContext().tenantId) {
        // 被停用/离职的员工不能再用旧会话进入枢纽 Agent：失败关闭，
        // 且绝不回退成默认管理员（否则等于把"已停用"变成提权）。
        if (!(await getEmployeeStatusChecker().isActive(session.tenantId, session.actorId))) throw new AuthenticationRequiredError();
        const context = createDevelopmentRequestContext(traceId, identity.key, session.sessionId);
        assertRequestContext(context);
        enterRequestContext(context);
        return context;
      }
    }
  }
  const context = createDevelopmentRequestContext(traceId);
  assertRequestContext(context);
  enterRequestContext(context);
  return context;
}

function randomTraceId(): string {
  return crypto.randomUUID();
}
