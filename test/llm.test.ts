import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { APICallError, RetryError } from "ai";
import { callLLM } from "../src/llm.js";

function mockProvider(t: TestContext, responses: Array<{ status: number; headers?: Record<string, string> }>) {
  const previous = process.env.MISTRAL_API_KEY;
  process.env.MISTRAL_API_KEY = "test-key";
  t.after(() => {
    if (previous === undefined) delete process.env.MISTRAL_API_KEY;
    else process.env.MISTRAL_API_KEY = previous;
  });
  const bodies: unknown[] = [];
  const waits: number[] = [];
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    waits.push(delay ?? 0);
    return originalTimeout(callback, 0, ...args);
  });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const response = responses[Math.min(bodies.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(response.status === 200 ? {
      id: "test", object: "chat.completion", created: 0, model: "ministral-3b-latest",
      choices: [{ index: 0, message: { role: "assistant", content: "Unchanged release note." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } : { message: "Request rejected", object: "error", type: "api_error" }), {
      status: response.status, headers: { "content-type": "application/json", ...response.headers },
    });
  });
  return { bodies, waits };
}

test("existing settings keep the SDK's two retries", async t => {
  const { bodies } = mockProvider(t, [{ status: 429, headers: { "retry-after": "0" } }]);
  await assert.rejects(callLLM("mistral", {}, "system", "release"), error =>
    RetryError.isInstance(error) && error.errors.length === 3);
  assert.equal(bodies.length, 3);
});

test("maxRetries configures the SDK without changing its delay strategy", async t => {
  const { bodies } = mockProvider(t, [
    ...Array.from({ length: 4 }, () => ({ status: 429, headers: { "retry-after": "0" } })),
    { status: 200 },
  ]);
  const result = await callLLM("mistral", { maxRetries: 4 }, "system", "release");
  assert.equal(bodies.length, 5);
  assert.equal(result.text, "Unchanged release note.");
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
});

test("custom backoff starts at five seconds and doubles without nested retries", async t => {
  const { bodies, waits } = mockProvider(t, [{ status: 429 }, { status: 429 }, { status: 200 }]);
  await callLLM("mistral", { initialRetryDelayMs: 5000 }, "system", "release");
  assert.equal(bodies.length, 3);
  assert.deepEqual(waits, [5000, 10000]);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(bodies[1], bodies[2]);
});

test("custom backoff stops at the configured retry count and preserves the final error", async t => {
  const { bodies, waits } = mockProvider(t, [{ status: 429 }]);
  await assert.rejects(callLLM("mistral", { maxRetries: 3, initialRetryDelayMs: 5000 }, "system", "release"), error =>
    RetryError.isInstance(error) && error.errors.length === 4 && APICallError.isInstance(error.lastError));
  assert.equal(bodies.length, 4);
  assert.deepEqual(waits, [5000, 10000, 20000]);
});

test("zero retries disables retries with or without a custom delay", async t => {
  const { bodies, waits } = mockProvider(t, [{ status: 429 }]);
  for (const initialRetryDelayMs of [undefined, 5000]) {
    await assert.rejects(callLLM("mistral", { maxRetries: 0, initialRetryDelayMs }, "system", "release"), error =>
      APICallError.isInstance(error) && error.statusCode === 429);
  }
  assert.equal(bodies.length, 2);
  assert.deepEqual(waits, []);
});

test("authentication errors are not retried", async t => {
  const { bodies, waits } = mockProvider(t, [{ status: 401 }]);
  await assert.rejects(callLLM("mistral", { maxRetries: 5, initialRetryDelayMs: 5000 }, "system", "release"), error =>
    APICallError.isInstance(error) && error.statusCode === 401);
  assert.equal(bodies.length, 1);
  assert.deepEqual(waits, []);
});

for (const [label, headers, expected] of [
  ["seconds", { "retry-after": "7" }, 7000],
  ["milliseconds", { "retry-after-ms": "7500" }, 7500],
  ["HTTP date", { "retry-after": "Tue, 10 Nov 2026 12:00:10 GMT" }, 10000],
  ["invalid header", { "retry-after": "invalid" }, 5000],
  ["shorter server delay", { "retry-after": "1" }, 5000],
] as const) {
  test(`custom backoff handles Retry-After: ${label}`, async t => {
    t.mock.method(Date, "now", () => Date.parse("2026-11-10T12:00:00Z"));
    const { waits } = mockProvider(t, [{ status: 429, headers }, { status: 200 }]);
    await callLLM("mistral", { maxRetries: 1, initialRetryDelayMs: 5000 }, "system", "release");
    assert.deepEqual(waits, [expected]);
  });
}

test("a zero initial delay is supported", async t => {
  const { waits } = mockProvider(t, [{ status: 429 }, { status: 200 }]);
  await callLLM("mistral", { maxRetries: 1, initialRetryDelayMs: 0 }, "system", "release");
  assert.deepEqual(waits, [0]);
});

test("large initial retry delays stay within Node's timer limit", async t => {
  const { bodies, waits } = mockProvider(t, [{ status: 429 }, { status: 200 }]);
  await callLLM("mistral", { maxRetries: 1, initialRetryDelayMs: 3_000_000_000 }, "system", "release");
  assert.equal(bodies.length, 2);
  assert.deepEqual(waits, [2_147_483_647]);
});

test("exponential retry delays saturate instead of overflowing Node's timers", async t => {
  const { bodies, waits } = mockProvider(t, [{ status: 429 }, { status: 429 }, { status: 429 }, { status: 200 }]);
  await callLLM("mistral", { maxRetries: 3, initialRetryDelayMs: 1_500_000_000 }, "system", "release");
  assert.equal(bodies.length, 4);
  assert.deepEqual(waits, [1_500_000_000, 2_147_483_647, 2_147_483_647]);
});

for (const headers of [{ "retry-after-ms": "3000000000" }, { "retry-after": "3000000" }]) {
  test(`large ${Object.keys(headers)[0]} values stay within Node's timer limit`, async t => {
    const { waits } = mockProvider(t, [{ status: 429, headers }, { status: 200 }]);
    await callLLM("mistral", { maxRetries: 1, initialRetryDelayMs: 5000 }, "system", "release");
    assert.deepEqual(waits, [2_147_483_647]);
  });
}
