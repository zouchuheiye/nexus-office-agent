import { NextResponse } from "next/server";
import { amendProposalSchema } from "@/src/modules/agent/application/schemas";
import { getAgentOrchestrator } from "@/src/modules/agent/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { proposalHash, input } = amendProposalSchema.parse(await parseJson(request));
    const { id } = await params;
    const result = await getAgentOrchestrator().amendProposal(context, id, proposalHash, input);
    return NextResponse.json(
      { data: result, meta: { traceId: context.traceId } },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
