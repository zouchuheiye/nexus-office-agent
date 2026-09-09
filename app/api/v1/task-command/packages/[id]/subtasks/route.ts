import { NextResponse } from "next/server";
import { addPackageSubtaskSchema } from "@/src/modules/task-command/application/schemas";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const data = await getTaskCommandService().listPackageSubtasks(context, { packageId: id });
    return NextResponse.json({ data, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const input = addPackageSubtaskSchema.parse({ ...(await parseJson(request)) as Record<string, unknown>, packageId: id });
    const result = await getTaskCommandService().addPackageSubtask(context, input);
    return NextResponse.json({ data: result, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
