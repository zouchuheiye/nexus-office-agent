import { NextResponse } from "next/server";
import { listDevelopmentIdentities } from "@/src/platform/context/development-context";
import { isLanDeployment } from "@/src/platform/config/runtime-config";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

function isDevelopmentIdentityAllowed() {
  return process.env.NODE_ENV !== "production"
    || (isLanDeployment() && process.env.NEXUS_ALLOW_DEMO_IDENTITY === "true")
    || process.env.NEXUS_ALLOW_DEMO_IDENTITY === "true";
}

export async function GET() {
  try {
    if (!isDevelopmentIdentityAllowed()) throw new Error("DEMO_IDENTITY_DISABLED");
    if (!process.env.SESSION_SECRET) throw new Error("DEMO_IDENTITY_SECRET_MISSING");
    return NextResponse.json(
      { data: { identities: listDevelopmentIdentities() }, meta: { mode: isLanDeployment() ? "lan" : "development" } },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
