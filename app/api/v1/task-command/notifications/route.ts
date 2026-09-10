import { NextResponse } from "next/server";
import { listNotificationsSchema } from "@/src/modules/task-command/application/schemas";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

/** P4：站内通知列表。收件人恒为当前会话身份，客户端不能指定他人。 */
export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const url = new URL(request.url);
    const input = listNotificationsSchema.parse({
      unreadOnly: url.searchParams.get("unreadOnly") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    const data = await getTaskCommandService().notifications(context, {
      unreadOnly: input.unreadOnly === "true",
      limit: input.limit,
    });
    return NextResponse.json({ data, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
