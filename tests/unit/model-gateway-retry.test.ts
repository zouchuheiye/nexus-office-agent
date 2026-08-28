import { describe, expect, it } from "vitest";
import { OpenAICompatibleModelGateway } from "@/src/modules/agent/domain/model-gateway";

describe("OpenAICompatibleModelGateway network resilience", () => {
  it("normalizes transient network failures to MODEL_PROVIDER_UNAVAILABLE and retries", async () => {
    const gateway = new OpenAICompatibleModelGateway(
      "test-key",
      "http://127.0.0.1:1",
      "test-model",
      1_000,
      3,
    );
    await expect(gateway.complete({
      tenantId: "tenant",
      traceId: "trace",
      dataClassification: "internal",
      messages: [{ role: "user", content: "hi" }],
      responseFormat: "json",
    })).rejects.toThrow("MODEL_PROVIDER_UNAVAILABLE");
  });
});
