import { NextResponse } from "next/server";
import { getAgentOrchestrator } from "@/src/modules/agent/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const proposal = await getAgentOrchestrator().getProposal(context, id);
    return NextResponse.json(
      { data: { proposal }, meta: { traceId: context.traceId } },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
