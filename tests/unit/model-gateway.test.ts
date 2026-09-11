// Requirements: PR-005, PR-006, MR-005, MR-030, SR-003, SR-004, SR-006, AC-004, AC-006, AC-007
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModelGateway, type ModelRequest } from "@/src/modules/agent/domain/model-gateway";
import type { DataClassification } from "@/src/platform/security/data-classification";

function request(dataClassification: DataClassification = "internal", toolCalls = false): ModelRequest {
  return {
    tenantId: "tenant",
    traceId: "trace",
    messages: [{ role: "user", content: "分析当前风险" }],
    dataClassification,
    responseFormat: toolCalls ? undefined : "json",
  };
}

function okResponse(overrides: Record<string, unknown> = {}) {
  return { ok: true, status: 200, json: async () => overrides };
}

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible model gateway failure classification", () => {
  it("maps a generic provider network failure to MODEL_PROVIDER_UNAVAILABLE", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("fetch failed"))));
    const gateway = new OpenAICompatibleModelGateway("key", "https://model.example/v1", "test-model");
    await expect(gateway.complete(request())).rejects.toThrow("MODEL_PROVIDER_UNAVAILABLE");
  });

  it("maps an HTTP provider error to MODEL_PROVIDER_ERROR with its status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const gateway = new OpenAICompatibleModelGateway("key", "https://model.example/v1", "test-model");
    await expect(gateway.complete(request())).rejects.toThrow("MODEL_PROVIDER_ERROR:503");
  });

  it("maps an aborted request to MODEL_TIMEOUT", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(abort)));
    const gateway = new OpenAICompatibleModelGateway("key", "https://model.example/v1", "test-model");
    await expect(gateway.complete(request())).rejects.toThrow("MODEL_TIMEOUT");
  });

  it("refuses restricted classification before any network call", async () => {
    const fetchMock = vi.fn(async () => okResponse({ choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new OpenAICompatibleModelGateway("key", "https://model.example/v1", "test-model");
    await expect(gateway.complete(request("restricted"))).rejects.toThrow("MODEL_POLICY_DENIED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on malformed tool-call arguments and keeps MODEL_ codes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({
      choices: [{ message: { content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "work.create_task_template", arguments: "{broken" } }] } }],
    })));
    const gateway = new OpenAICompatibleModelGateway("key", "https://model.example/v1", "test-model");
    await expect(gateway.complete(request("internal", true))).rejects.toThrow("MODEL_TOOL_ARGUMENTS_INVALID");
  });

  it("parses a valid chat completion response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({
      choices: [{ message: { content: "{\"answer\":\"当前无高风险。\"}" } }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    })));
    const gateway = new OpenAICompatibleModelGateway("key", "https://model.example/v1", "test-model");
    const response = await gateway.complete(request());
    expect(response.provider).toBe("openai-compatible");
    expect(response.content).toContain("当前无高风险");
    expect(response.inputTokens).toBe(12);
    expect(response.outputTokens).toBe(4);
  });
});

/** 造一个 OpenAI 兼容的 SSE 响应体（按行切成若干分片，模拟网络分包）。 */
function sseResponse(chunks: string[], options: { sliceSize?: number } = {}) {
  const payload = chunks.map((chunk) => `data: ${chunk}\n\n`).join("") + "data: [DONE]\n\n";
  const size = options.sliceSize ?? payload.length;
  const parts: string[] = [];
  for (let index = 0; index < payload.length; index += size) parts.push(payload.slice(index, index + size));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream };
}

describe("OpenAI-compatible model gateway streaming", () => {
  it("边收边报文本增量，并把分片拼成与非流式一致的响应", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { content: "{\"answer\":\"正在" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "压缩灰度" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "窗口。\"}" } }], usage: { prompt_tokens: 9, completion_tokens: 7 } }),
    ], { sliceSize: 37 })));
    const gateway = new OpenAICompatibleModelGateway("key", "https://model.example/v1", "test-model");
    const deltas: string[] = [];
    const response = await gateway.completeStream(request(), (chunk) => deltas.push(chunk));

    expect(deltas.join("")).toBe("{\"answer\":\"正在压缩灰度窗口。\"}");
    expect(response.content).toBe("{\"answer\":\"正在压缩灰度窗口。\"}");
    expect(response.provider).toBe("openai-compatible");
    expect(response.inputTokens).toBe(9);
    expect(response.outputTokens).toBe(7);
  });

  it("按 index 累积分片到达的工具调用参数", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "work.find_task", arguments: "{\"que" } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "ry\":\"巡检\"}" } }] } }] }),
    ])));
    const gateway = new OpenAICompatibleModelGateway("key", "https://model.example/v1", "test-model");
    const response = await gateway.completeStream(request("internal", true), () => undefined);

    expect(response.content).toBe("");
    expect(response.toolCalls).toEqual([{ id: "call-1", name: "work.find_task", arguments: { query: "巡检" } }]);
  });

  it("服务端不接受 stream 参数时退回非流式调用（没流出内容才回退）", async () => {
    const responses = [
      () => ({ ok: false, status: 400, json: async () => ({}) }),
      () => okResponse({ choices: [{ message: { content: "{\"answer\":\"兜底成功\"}" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!());
    vi.stubGlobal("fetch", fetchMock);

    const gateway = new OpenAICompatibleModelGateway("key", "https://model.example/v1", "test-model");
    const deltas: string[] = [];
    const response = await gateway.completeStream(request(), (chunk) => deltas.push(chunk));

    expect(response.content).toBe("{\"answer\":\"兜底成功\"}");
    expect(deltas).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("已经流出内容后再出错不重试（避免同一段话生成两遍）", async () => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "半句话" } }] })}\n\n`));
        await new Promise((resolve) => setTimeout(resolve, 5));
        controller.error(new Error("socket closed"));
      },
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, body: stream }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new OpenAICompatibleModelGateway("key", "https://model.example/v1", "test-model");
    const deltas: string[] = [];

    await expect(gateway.completeStream(request(), (chunk) => deltas.push(chunk))).rejects.toThrow("MODEL_PROVIDER_UNAVAILABLE");
    expect(deltas.join("")).toBe("半句话");
    // 已流出内容后不再发起第二次请求。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("流里既没有文本也没有工具调用时按响应非法处理", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([JSON.stringify({ choices: [{ delta: {} }] })])));
    const gateway = new OpenAICompatibleModelGateway("key", "https://model.example/v1", "test-model");
    await expect(gateway.completeStream(request(), () => undefined)).rejects.toThrow("MODEL_RESPONSE_INVALID");
  });
});
