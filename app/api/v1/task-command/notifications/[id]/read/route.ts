import { NextResponse } from "next/server";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

/** P4：把本人某条通知标记为已读（幂等；他人通知一律 404）。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const data = await getTaskCommandService().markNotificationRead(context, id);
    return NextResponse.json({ data, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
