import { NextResponse } from "next/server";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 100;

function cursor(value: string | null) {
  const parsed = Number(value ?? "0");
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function limit(value: string | null) {
  const parsed = Number(value ?? "50");
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_LIMIT) : 50;
}

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const url = new URL(request.url);
    const after = cursor(url.searchParams.get("after"));
    const requestedLimit = limit(url.searchParams.get("limit"));
    // Read one sentinel event so a page ending exactly at the requested size
    // does not claim there is another page when the visible history is exhausted.
    const visibleEvents = await getTaskCommandService().events(context, after, requestedLimit + 1);
    const events = visibleEvents.slice(0, requestedLimit);
    const hasMore = visibleEvents.length > requestedLimit;
    const nextCursor = hasMore ? events.at(-1)?.sequence ?? null : null;
    return NextResponse.json({
      data: {
        events,
        nextCursor,
        hasMore,
        generatedAt: new Date().toISOString(),
      },
      meta: { traceId: context.traceId },
    });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
