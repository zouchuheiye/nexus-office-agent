import { NextResponse } from "next/server";
import { taskDraftInputSchema } from "@/src/modules/agent/application/task-draft";
import { getTaskDraftService } from "@/src/modules/agent/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * P5：把一段纪要拆成任务包草稿。
 * 只读能力：不落库、不发布；发布仍走 `POST /task-command/missions`（同一套校验与"待补充"标记）。
 * 权限（`work_task:create`）在服务层校验。
 */
export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = taskDraftInputSchema.parse(await parseJson(request));
    const draft = await getTaskDraftService().draftFromMinutes(context, input);
    return NextResponse.json({ data: draft, meta: { traceId: context.traceId } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
