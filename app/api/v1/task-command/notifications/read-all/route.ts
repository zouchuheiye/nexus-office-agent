import { NextResponse } from "next/server";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

/** P4：一键把本人所有未读通知标记为已读（幂等，只影响当前主体）。 */
export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const data = await getTaskCommandService().markAllNotificationsRead(context);
    return NextResponse.json({ data, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
