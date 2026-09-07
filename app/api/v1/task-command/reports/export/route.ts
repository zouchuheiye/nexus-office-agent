import { NextResponse } from "next/server";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { exportReportSchema } from "@/src/modules/task-command/application/schemas";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

function escapeCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const url = new URL(request.url);
    const input = exportReportSchema.parse({
      groupBy: url.searchParams.get("groupBy") ?? undefined,
      format: url.searchParams.get("format") ?? undefined,
      assigneeId: url.searchParams.get("assigneeId") ?? undefined,
      missionId: url.searchParams.get("missionId") ?? undefined,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
    });
    const result = await getTaskCommandService().exportReport(context, input);
    if (input.format === "json") {
      return NextResponse.json({ data: result, meta: { traceId: context.traceId } });
    }
    const csv = "\uFEFF" + [result.headers, ...result.rows.map((row) => [
      row.id, row.title, row.missionTitle, row.status, row.assigneeName, row.orgName, row.priority,
      row.startedAt, row.dueAt, row.estimatedDays, row.capacityPoints, row.dueState, row.createdAt, row.updatedAt,
    ].map(escapeCell).join(","))].join("\r\n");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="task-progress-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (error) { return applicationErrorResponse(error); }
}
