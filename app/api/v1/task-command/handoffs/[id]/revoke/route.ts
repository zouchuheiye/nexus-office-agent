import { NextResponse } from "next/server";
import { z } from "zod";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

const revokeSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const input = revokeSchema.parse(await parseJson(request));
    const result = await getTaskCommandService().revokeTaskHandoff(context, id, input.expectedVersion, { source: "human" });
    return NextResponse.json({ data: result, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
