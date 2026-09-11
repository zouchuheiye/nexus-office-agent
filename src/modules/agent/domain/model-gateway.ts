export type ModelToolCall = { id: string; name: string; arguments: Record<string, unknown> };

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: ModelToolCall[];
};

export type ModelToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ModelRequest = {
  tenantId: string;
  traceId: string;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  toolChoice?: "auto" | "none";
  responseFormat?: "text" | "json";
  dataClassification: DataClassification;
};

export type ModelResponse = {
  content: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  toolCalls?: ModelToolCall[];
};

export interface ModelGateway {
  complete(request: ModelRequest): Promise<ModelResponse>;
  /**
   * P5（token 级流式输出）：可选能力。支持流式的实现边收边把**原始分片**交给 `onDelta`；
   * 不支持时上层退回 `complete`（因此这是能力探测，不是必须实现的接口）。
   * 注意：交给 `onDelta` 的是模型原始输出（可能是 JSON 片段），可见文本的抽取由上层
   * `AnswerStreamExtractor` 负责——不要把未校验的模型文本直接当答案展示。
   */
  completeStream?(request: ModelRequest, onDelta: (chunk: string) => void): Promise<ModelResponse>;
}

export class FakeModelGateway implements ModelGateway {
  constructor(private readonly answer = "这是受控测试模型响应。") {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.dataClassification === "restricted") throw new Error("MODEL_POLICY_DENIED");
    const content = request.responseFormat === "json" && !this.answer.trim().startsWith("{")
      ? JSON.stringify({ answer: this.answer })
      : this.answer;
    return {
      content,
      provider: "fake",
      model: "deterministic-test-model",
      inputTokens: request.messages.reduce((sum, message) => sum + message.content.length, 0),
      outputTokens: content.length,
      latencyMs: 0,
    };
  }

  /** 与 `complete` 同结果，但把内容切成固定大小的片段交出去（用于验证流式链路）。 */
  async completeStream(request: ModelRequest, onDelta: (chunk: string) => void): Promise<ModelResponse> {
    const response = await this.complete(request);
    for (let index = 0; index < response.content.length; index += 8) onDelta(response.content.slice(index, index + 8));
    return response;
  }
}

export class OpenAICompatibleModelGateway implements ModelGateway {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs = 30_000,
  ) {}

  private requestBody(request: ModelRequest, stream: boolean): string {
    return JSON.stringify({
      model: this.model,
      temperature: 0.2,
      stream: stream || undefined,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        tool_call_id: message.toolCallId,
        name: message.name,
        tool_calls: message.toolCalls?.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
      })),
      tools: request.tools?.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
      tool_choice: request.tools?.length ? request.toolChoice ?? "auto" : undefined,
      response_format: request.responseFormat === "json" ? { type: "json_object" } : undefined,
    });
  }

  /**
   * P5：真正的 token 级流式。
   *
   * 与 `complete` 共用请求体（只多一个 `stream: true`）与同一套错误分类；解析 OpenAI 兼容的
   * `data: {...}` 分片：文本增量交给 `onDelta`，工具调用增量按 `index` 累积（`id`/`name` 与
   * `arguments` 会分片到达），流结束后组装成与非流式完全相同的 `ModelResponse`。
   *
   * 失败语义：**在收到任何分片之前**出错会退回非流式 `complete`（例如服务端不支持 `stream`），
   * 已经流出内容后再出错则直接抛出——此时重试会造成"同一段话生成两遍"。
   */
  async completeStream(request: ModelRequest, onDelta: (chunk: string) => void): Promise<ModelResponse> {
    if (request.dataClassification === "restricted") throw new Error("MODEL_POLICY_DENIED");
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let delivered = false;
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}`, accept: "text/event-stream" },
        signal: controller.signal,
        body: this.requestBody(request, true),
      });
      if (!response.ok || !response.body) throw new Error(`MODEL_PROVIDER_ERROR:${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let outputTokens = 0;
      let inputTokens = 0;
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
      const consume = (line: string) => {
        if (!line.startsWith("data:")) return;
        const payload = line.slice("data:".length).trim();
        if (!payload || payload === "[DONE]") return;
        let chunk: { choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        try { chunk = JSON.parse(payload); } catch { return; }
        inputTokens = chunk.usage?.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage?.completion_tokens ?? outputTokens;
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          content += delta.content;
          delivered = true;
          onDelta(delta.content);
        }
        for (const call of delta?.tool_calls ?? []) {
          const index = call.index ?? 0;
          const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
          toolCalls.set(index, {
            id: call.id ?? current.id,
            name: call.function?.name ?? current.name,
            arguments: current.arguments + (call.function?.arguments ?? ""),
          });
          delivered = true;
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) consume(line.trim());
      }
      if (buffer.trim()) consume(buffer.trim());

      const parsedToolCalls = [...toolCalls.values()].map((call) => {
        if (!call.id || !call.name || !call.arguments) throw new Error("MODEL_TOOL_CALL_INVALID");
        let argumentsValue: unknown;
        try { argumentsValue = JSON.parse(call.arguments); } catch { throw new Error("MODEL_TOOL_ARGUMENTS_INVALID"); }
        if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) throw new Error("MODEL_TOOL_ARGUMENTS_INVALID");
        return { id: call.id, name: call.name, arguments: argumentsValue as Record<string, unknown> };
      });
      const trimmed = content.trim();
      if (!trimmed && parsedToolCalls.length === 0) throw new Error("MODEL_RESPONSE_INVALID");
      return {
        content: trimmed, provider: "openai-compatible", model: this.model,
        inputTokens, outputTokens, latencyMs: Date.now() - startedAt,
        toolCalls: parsedToolCalls,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (delivered) throw new Error("MODEL_TIMEOUT");
        return this.complete(request);
      }
      if (error instanceof Error && error.message.startsWith("MODEL_")) {
        // 还没流出任何内容时，退回流式失败前的非流式通道（例如服务端不支持 stream 参数）。
        if (!delivered && !error.message.startsWith("MODEL_TOOL_") && error.message !== "MODEL_RESPONSE_INVALID") return this.complete(request);
        throw error;
      }
      if (!delivered) return this.complete(request);
      throw new Error("MODEL_PROVIDER_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.dataClassification === "restricted") throw new Error("MODEL_POLICY_DENIED");
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
        body: this.requestBody(request, false),
      });
      if (!response.ok) throw new Error(`MODEL_PROVIDER_ERROR:${response.status}`);
      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const message = payload.choices?.[0]?.message;
      const content = message?.content?.trim() ?? "";
      const toolCalls = (message?.tool_calls ?? []).map((call) => {
        if (!call.id || !call.function?.name || typeof call.function.arguments !== "string") throw new Error("MODEL_TOOL_CALL_INVALID");
        let parsed: unknown;
        try { parsed = JSON.parse(call.function.arguments); } catch { throw new Error("MODEL_TOOL_ARGUMENTS_INVALID"); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MODEL_TOOL_ARGUMENTS_INVALID");
        return { id: call.id, name: call.function.name, arguments: parsed as Record<string, unknown> };
      });
      if (!content && toolCalls.length === 0) throw new Error("MODEL_RESPONSE_INVALID");
      return {
        content, provider: "openai-compatible", model: this.model,
        inputTokens: payload.usage?.prompt_tokens ?? 0, outputTokens: payload.usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - startedAt,
        toolCalls,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("MODEL_TIMEOUT");
      if (error instanceof Error && error.message.startsWith("MODEL_")) throw error;
      throw new Error("MODEL_PROVIDER_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class UnavailableModelGateway implements ModelGateway {
  async complete(): Promise<ModelResponse> { throw new Error("MODEL_UNAVAILABLE"); }
}
import type { DataClassification } from "@/src/platform/security/data-classification";
