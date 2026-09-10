import { NextResponse } from "next/server";
import { createDevelopmentRequestContext, listDevelopmentIdentities } from "@/src/platform/context/development-context";
import { getMemberDirectoryService } from "@/src/modules/organization/runtime";
import { isLanDeployment } from "@/src/platform/config/runtime-config";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

function isDevelopmentIdentityAllowed() {
  return process.env.NODE_ENV !== "production"
    || (isLanDeployment() && process.env.NEXUS_ALLOW_DEMO_IDENTITY === "true")
    || process.env.NEXUS_ALLOW_DEMO_IDENTITY === "true";
}

/**
 * 只列出仍是"在职员工"的开发验证身份：已停用/离职的成员不再出现在切换器里，
 * 与成员管理（员工目录）保持一致。目录不可用时保留原列表（仅影响开发夹具的列表展示，
 * 服务端是否放行仍由 resolve-request-context + organization_member 状态判定）。
 */
async function activeIdentityKeys(): Promise<Set<string> | null> {
  try {
    const directory = await getMemberDirectoryService().list(createDevelopmentRequestContext("development-identities"));
    const activeIds = new Set(directory.members.map((member) => member.id));
    return new Set(listDevelopmentIdentities().filter((identity) => activeIds.has(identity.actorId)).map((identity) => identity.key));
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    if (!isDevelopmentIdentityAllowed()) throw new Error("DEMO_IDENTITY_DISABLED");
    if (!process.env.SESSION_SECRET) throw new Error("DEMO_IDENTITY_SECRET_MISSING");
    const identities = listDevelopmentIdentities();
    const active = await activeIdentityKeys();
    return NextResponse.json(
      { data: { identities: active ? identities.filter((identity) => active.has(identity.key)) : identities }, meta: { mode: isLanDeployment() ? "lan" : "development" } },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
