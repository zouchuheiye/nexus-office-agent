import { NextResponse } from "next/server";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const result = await getTaskCommandService().board(context);
    return NextResponse.json({ data: result, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
