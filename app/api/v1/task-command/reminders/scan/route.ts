import { NextResponse } from "next/server";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { runReminderScanSchema } from "@/src/modules/task-command/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const body = await request.json().catch(() => ({}));
    const input = runReminderScanSchema.parse(body);
    const result = await getTaskCommandService().runReminderScan(context, input);
    return NextResponse.json({ data: result, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
