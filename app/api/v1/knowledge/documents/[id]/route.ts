import { NextResponse } from "next/server";
import { resolveActorApplicability } from "@/src/modules/knowledge/application/actor-applicability";
import { getGovernanceRuntime } from "@/src/modules/governance-workspace/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

/** 条目详情：正文/文件元数据之外的版本历史与适用范围（信息库详情页用）。 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const actor = await resolveActorApplicability(context);
    const data = await getGovernanceRuntime().knowledge.describeDocument(context, id, actor);
    return NextResponse.json({
      data: {
        document: data.document,
        accessBasis: data.accessBasis,
        versions: data.versions,
      },
      meta: { traceId: context.traceId },
    });
  } catch (error) { return applicationErrorResponse(error); }
}
