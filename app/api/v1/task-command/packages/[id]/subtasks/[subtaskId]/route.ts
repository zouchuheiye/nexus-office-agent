import { NextResponse } from "next/server";
import { deletePackageSubtaskSchema, updatePackageSubtaskSchema } from "@/src/modules/task-command/application/schemas";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; subtaskId: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id, subtaskId } = await params;
    const input = updatePackageSubtaskSchema.parse(await parseJson(request));
    const result = await getTaskCommandService().updatePackageSubtask(context, { ...input, packageId: id, subtaskId });
    return NextResponse.json({ data: result, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; subtaskId: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const url = new URL(request.url);
    const expectedVersion = Number(url.searchParams.get("expectedVersion") ?? "0");
    const input = deletePackageSubtaskSchema.parse({ packageId: (await params).id, subtaskId: (await params).subtaskId, expectedVersion });
    const result = await getTaskCommandService().deletePackageSubtask(context, input);
    return NextResponse.json({ data: result, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
