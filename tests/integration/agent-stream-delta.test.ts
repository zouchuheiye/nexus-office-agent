// Requirements: PR-005, PR-006, MR-005, MR-030, AC-004（P5：token 级流式输出的端到端契约）
//
// 这个用例独占一个测试文件：`moduleRuntime` 会缓存运行期实例，而这里需要让运行期真的构造出
// "支持流式"的模型网关（OpenAI 兼容 + 被替换的 fetch），所以必须在第一次取 orchestrator 之前
// 就把环境变量与 fetch 准备好。
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as createRun } from "@/app/api/v1/agent/runs/route";
import { modelToolName } from "@/src/modules/agent/domain/tool";

/** 形状与 OpenAI 兼容接口一致的 SSE 响应：按 `sliceSize` 切分，模拟真实网络分包。 */
function sseResponse(chunks: string[], sliceSize: number) {
  const payload = chunks.map((chunk) => `data: ${chunk}\n\n`).join("") + "data: [DONE]\n\n";
  const parts: string[] = [];
  for (let index = 0; index < payload.length; index += sliceSize) parts.push(payload.slice(index, index + sliceSize));
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    }),
  };
}

function frames(text: string) {
  return text.split("\n\n").filter(Boolean).map((frame) => {
    const lines = frame.split("\n");
    return {
      event: lines.find((line) => line.startsWith("event: "))?.slice(7).trim(),
      data: JSON.parse(lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}") as Record<string, unknown>,
    };
  });
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function streamRequest(clientRequestId: string, message = "分析当前项目风险") {
  return new Request("http://localhost/api/v1/agent/runs?stream=1", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", "x-trace-id": "agent-stream-delta" },
    body: JSON.stringify({ message, clientRequestId }),
  });
}

describe("Agent 流式回答的端到端契约（token 级）", () => {
  it("模型边流边推：SST 里出现 delta 事件，拼接结果与最终回答一致，且不含协议噪声", async () => {
    vi.stubEnv("OPENAI_API_KEY", "stream-test-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://model.example/v1");
    vi.stubEnv("OPENAI_MODEL", "stream-test-model");
    // 回答里带转义与中文，确保增量是按字符解码后的文本，而不是原始 JSON 片段。
    const answer = "接口延迟正在压缩灰度验证窗口。\n建议先缩小灰度范围，再观察 30 分钟。";
    const content = JSON.stringify({ answer, skillsUsed: ["enterprise-analysis"] });
    const pieces = [...content].map((char) => char); // 逐字符分包：最苛刻的分片边界
    const fetchMock = vi.fn(async () => sseResponse(pieces.map((char) => JSON.stringify({ choices: [{ delta: { content: char } }] })), 11));
    vi.stubGlobal("fetch", fetchMock);

    const response = await createRun(streamRequest("agent-stream-delta-001"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const parsed = frames(await new Response(response.body).text());

    const deltas = parsed.filter((frame) => frame.event === "delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((frame) => String(frame.data.text)).join("")).toBe(answer);
    for (const frame of deltas) {
      expect(frame.data.round).toBe(1);
      expect(String(frame.data.text)).not.toContain("\"answer\"");
      expect(String(frame.data.text)).not.toMatch(/[{}]/);
      expect(String(frame.data.text)).not.toContain("\\n");
    }
    // 增量必须早于最终结果（否则不叫流式），且阶段进度照旧存在。
    const firstDelta = parsed.findIndex((frame) => frame.event === "delta");
    const finalIndex = parsed.findIndex((frame) => frame.event === "final");
    expect(firstDelta).toBeGreaterThan(-1);
    expect(firstDelta).toBeLessThan(finalIndex);
    expect(parsed.filter((frame) => frame.event === "stage").map((frame) => frame.data.stage)).toEqual(expect.arrayContaining(["classification", "thinking", "answer"]));
    const final = parsed[finalIndex];
    expect((final.data.run as { output: { content: string } }).output.content).toBe(answer);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("模型返回工具调用轮时不把协议片段当成回答推给界面", async () => {
    vi.stubEnv("OPENAI_API_KEY", "stream-test-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://model.example/v1");
    vi.stubEnv("OPENAI_MODEL", "stream-test-model");
    // 第一轮流式返回一个工具调用（没有 answer 字段），第二轮返回最终回答。
    const rounds = [
      [JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: modelToolName("work.list_my_notifications"), arguments: "{}" } }] } }] })],
      [JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ answer: "已按你的权限查过通知。" }) } }] })],
    ];
    const fetchMock = vi.fn(async () => sseResponse(rounds.shift() ?? [JSON.stringify({ choices: [{ delta: { content: "{}" } }] })] , 4096));
    vi.stubGlobal("fetch", fetchMock);

    const response = await createRun(streamRequest("agent-stream-delta-tools", "看看我的通知"));
    const parsed = frames(await new Response(response.body).text());
    const deltas = parsed.filter((frame) => frame.event === "delta");

    // 工具调用轮没有 answer 字段 → 不产生增量；最终回答轮才产生。
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.map((frame) => String(frame.data.text)).join("")).toBe("已按你的权限查过通知。");
    expect(deltas.map((frame) => Number(frame.data.round))).toEqual([2]);
  });
});
