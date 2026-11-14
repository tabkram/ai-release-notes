import type { TestContext } from "node:test";
import type { ProviderName } from "../../src/types.js";

export interface ModelRequest {
  url: string;
  body: Record<string, unknown>;
}

export function modelResponse(provider: ProviderName, text = "# Release\n\nA useful change.", cached = 0, finishReason = "stop"): Response {
  if (provider === "anthropic") {
    return json({
      id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-4-20250514",
      content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: cached, cache_creation_input_tokens: 20 },
    });
  }
  if (provider === "google") {
    return json({
      candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, cachedContentTokenCount: cached },
    });
  }
  if (provider === "mistral") {
    return json({
      id: "test", object: "chat.completion", created: 0, model: "mistral-large-latest",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: cached } },
    });
  }
  return json({
    id: "resp_test", object: "response", created_at: 0, model: "gpt-4o", status: "completed",
    output: [{ id: "msg_test", type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: cached } },
  });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Exercise the actual SDK serialization/parsing without network or paid calls. */
export function mockModel(
  t: TestContext,
  provider: ProviderName,
  respond: (request: ModelRequest, index: number) => Response | Promise<Response> = () => modelResponse(provider)
) {
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MISTRAL_API_KEY", "GOOGLE_API_KEY", "AZURE_OPENAI_API_KEY"]) {
    const previous = process.env[name];
    process.env[name] = `test-${name}`;
    t.after(() => {
      if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    });
  }
  const requests: ModelRequest[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const request = { url: String(input), body: JSON.parse(String(init?.body ?? "{}")) };
    requests.push(request);
    return respond(request, requests.length - 1);
  });
  return requests;
}
