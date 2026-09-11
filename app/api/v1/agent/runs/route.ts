import { NextResponse } from "next/server";
import { createAgentRunSchema } from "@/src/modules/agent/application/schemas";
import { getAgentOrchestrator } from "@/src/modules/agent/runtime";
import type { AgentAnswerDelta, AgentStageEvent } from "@/src/modules/agent/domain/agent-stage";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, describeApplicationError, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function wantsStream(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("stream") === "1") return true;
  return (request.headers.get("accept") ?? "").includes("text/event-stream");
}

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = createAgentRunSchema.parse(await parseJson(request));
    const orchestrator = getAgentOrchestrator();
    if (!wantsStream(request)) {
      const run = await orchestrator.createRun(context, input);
      const proposal = run.output?.proposalId ? await orchestrator.getProposal(context, run.output.proposalId) : undefined;
      return NextResponse.json({ data: { run, proposal }, meta: { traceId: context.traceId } }, { status: 201 });
    }

    // P5：真实阶段进度 + token 级流式预览。运行本身仍是同一条服务端链路，只是把"走到哪一步"和
    // "正在生成哪几个字"边跑边推给页面，避免用户对着转圈猜 10~30 秒。
    // 事件类型：stage（阶段）/ delta（回答文本增量预览）/ final（结果）/ error（失败）。
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const send = (event: string, data: unknown) => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }
          catch { closed = true; }
        };
        send("ready", { traceId: context.traceId, actorId: context.actorId });
        try {
          const run = await orchestrator.createRun(context, input, {
            onStage: (stage: AgentStageEvent) => send("stage", stage),
            onDelta: (delta: AgentAnswerDelta) => send("delta", delta),
          });
          const proposal = run.output?.proposalId ? await orchestrator.getProposal(context, run.output.proposalId) : undefined;
          send("final", { run, proposal });
        } catch (error) {
          // 响应头已经发出，失败只能用事件表达；文案与普通 HTTP 通道共用同一份映射。
          const described = describeApplicationError(error);
          send("error", { code: described.code, message: described.message, fields: described.fields });
        } finally {
          closed = true;
          try { controller.close(); } catch { /* 客户端已断开 */ }
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
