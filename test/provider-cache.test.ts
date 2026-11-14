import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { callLLM } from "../src/llm.js";
import { resolveCacheConfig, validateProviderCache } from "../src/cache/index.js";
import { buildSystemPrompt, buildTranslationSystemPrompt } from "../src/prompts/builder.js";
import type { ProviderConfig, ProviderName } from "../src/types.js";
import { json, mockModel, modelResponse } from "./helpers/mock-model.js";

const system = "Shared instructions.\n\n## Task\n\nWrite release notes.";

test("generation and translations share project rules before their task-specific instructions", async () => {
  const instructions = "Always spell ENVIRO exactly this way.";
  const prompts = await Promise.all([
    buildSystemPrompt({ instructions, languages: ["en"] }),
    buildTranslationSystemPrompt("fr", instructions),
    buildTranslationSystemPrompt("de", instructions),
  ]);
  assert.equal(new Set(prompts.map(prompt => prompt.split("\n\n## Task\n\n")[0])).size, 1);
  for (const prompt of prompts) assert.match(prompt, /^You write release notes, and nothing else\./);
});

test("Anthropic sends 1h cache controls on shared rules and the full system, and reports cache usage", async t => {
  const requests = mockModel(t, "anthropic", () => modelResponse("anthropic", "Release.", 8));
  const result = await callLLM("anthropic", { promptCache: { ttl: "1h" } }, system, "release");
  const blocks = requests[0].body.system as Array<{ text: string; cache_control?: { type: string; ttl: string } }>;
  assert.equal(blocks[0].text, "Shared instructions.");
  assert.equal(blocks.length, 2);
  for (const block of blocks) assert.deepEqual(block.cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(result.usage.providerCacheReadTokens, 8);
  assert.equal(result.usage.providerCacheWriteTokens, 20);
  await callLLM("anthropic", { promptCache: { enabled: false } }, system, "release");
  assert.doesNotMatch(JSON.stringify(requests[1].body), /cache_control/);
});

test("OpenAI recent Responses models send explicit breakpoints and the requested 12h TTL", async t => {
  const requests = mockModel(t, "openai", () => modelResponse("openai", "Release.", 8));
  const config = { model: "gpt-5.6", promptCache: { ttl: "12h" } };
  const result = await callLLM("openai", config, system, "release");
  assert.match(requests[0].url, /\/responses$/);
  assert.deepEqual(requests[0].body.prompt_cache_options, { mode: "explicit", ttl: "12h" });
  assert.match(JSON.stringify(requests[0].body.input), /prompt_cache_breakpoint/);
  assert.equal(result.usage.providerCacheReadTokens, 8);
  await callLLM("openai", { model: "gpt-5.6", promptCache: { enabled: false } }, system, "release");
  assert.deepEqual(requests[1].body.prompt_cache_options, { mode: "explicit" });
  assert.doesNotMatch(JSON.stringify(requests[1].body.input), /prompt_cache_breakpoint/);
});

test("OpenAI legacy models use only supported retention controls", async t => {
  const requests = mockModel(t, "openai");
  await callLLM("openai", { model: "gpt-4.1", promptCache: { ttl: "24h" } }, system, "release");
  assert.equal(requests[0].body.prompt_cache_retention, "24h");
  assert.equal(requests[0].body.prompt_cache_options, undefined);
  await callLLM("openai", { model: "gpt-4o" }, system, "release");
  assert.equal(requests[1].body.prompt_cache_retention, undefined);
  assert.equal(requests[1].body.prompt_cache_options, undefined);
  assert.ok(requests[1].body.prompt_cache_key);
});

test("Azure deployment aliases use their configured underlying model without changing the deployment", async t => {
  const requests = mockModel(t, "azure-openai");
  await callLLM("azure-openai", {
    model: "release-notes-prod", baseURL: "http://localhost/openai/v1",
    promptCache: { model: "gpt-5.6", ttl: "12h" },
  }, system, "release");
  assert.equal(requests[0].body.model, "release-notes-prod");
  assert.deepEqual(requests[0].body.prompt_cache_options, { mode: "explicit", ttl: "12h" });
  assert.match(requests[0].url, /localhost\/openai\/v1\/responses/);
});

test("Mistral adds a stable cache key on the actual request and reads cached-token usage", async t => {
  const requests = mockModel(t, "mistral", () => modelResponse("mistral", "Release.", 8));
  const result = await callLLM("mistral", {}, system, "release one");
  await callLLM("mistral", {}, system.replace("Write release notes", "Translate release notes"), "release two");
  assert.match(String(requests[0].body.prompt_cache_key), /^[a-f0-9]{64}$/);
  assert.equal(requests[0].body.prompt_cache_key, requests[1].body.prompt_cache_key);
  assert.equal(result.usage.providerCacheReadTokens, 8);
  await callLLM("mistral", { promptCache: { enabled: false } }, system, "release");
  assert.equal(requests[2].body.prompt_cache_key, undefined);
});

test("Gemini implicit caching and Ollama receive no foreign cache fields", async t => {
  const requests = mockModel(t, "google", request => modelResponse(request.url.includes("googleapis") ? "google" : "ollama", "Release.", 8));
  const google = await callLLM("google", { model: "gemini-2.5-flash" }, system, "release");
  assert.equal(google.usage.providerCacheReadTokens, 8);
  await callLLM("ollama", {}, system, "release");
  for (const request of requests) {
    assert.doesNotMatch(JSON.stringify(request.body), /prompt_cache|cache_control|cachedContent/);
  }
});

async function localCache(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "release-provider-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return resolveCacheConfig(undefined, {}, directory);
}

test("Gemini creates and reuses an explicit resource with a TTL in days", async t => {
  const local = await localCache(t);
  const requests = mockModel(t, "google", request => request.url.endsWith("/cachedContents")
    ? json({ name: "cachedContents/shared_rules", expireTime: new Date(Date.now() + 7 * 86_400_000).toISOString(), usageMetadata: { totalTokenCount: 2048 } })
    : modelResponse("google", "Release.", 8));
  const config = { model: "gemini-2.5-flash", promptCache: { ttl: "7d" } };
  const first = await callLLM("google", config, system, "release one", local);
  const second = await callLLM("google", config, system, "release two", local);
  assert.equal(first.usage.providerCacheWriteTokens, 2048);
  assert.equal(second.usage.providerCacheWriteTokens, undefined);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].body.ttl, "604800s");
  assert.deepEqual(requests[0].body.systemInstruction, { parts: [{ text: system }] });
  for (const request of requests.slice(1)) {
    assert.equal(request.body.cachedContent, "cachedContents/shared_rules");
    assert.equal(request.body.systemInstruction, undefined);
  }
});

test("Gemini recreates expired resources", async t => {
  const local = await localCache(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const requests = mockModel(t, "google", request => request.url.endsWith("/cachedContents")
    ? json({ name: "cachedContents/shared_rules", expireTime: new Date(now + 1000).toISOString() }) : modelResponse("google"));
  const config = { model: "gemini-2.5-flash", promptCache: { ttl: "1h" } };
  await callLLM("google", config, system, "one", local);
  now += 2000;
  await callLLM("google", config, system, "two", local);
  assert.equal(requests.filter(request => request.url.endsWith("/cachedContents")).length, 2);
});

test("Gemini falls back with the original system prompt if a cached resource was deleted", async t => {
  const local = await localCache(t);
  const requests = mockModel(t, "google", request => {
    if (request.url.endsWith("/cachedContents")) return json({ name: "cachedContents/shared_rules", expireTime: new Date(Date.now() + 3_600_000).toISOString() });
    if (request.body.cachedContent) return json({ error: { message: "Cache not found", code: 404, status: "NOT_FOUND" } }, 404);
    return modelResponse("google");
  });
  await callLLM("google", { model: "gemini-2.5-flash", maxRetries: 0, promptCache: { ttl: "1h" } }, system, "release", local);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].body.cachedContent, undefined);
  assert.match(JSON.stringify(requests[2].body.systemInstruction), /Shared instructions/);
});

test("Gemini reports a short prefix and continues without an explicit resource", async t => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", message => warnings.push(String(message)));
  const requests = mockModel(t, "google", request => request.url.endsWith("/cachedContents")
    ? json({ error: { message: "Cached content is too small" } }, 400) : modelResponse("google"));
  await callLLM("google", { model: "gemini-2.5-flash", promptCache: { ttl: "1h" } }, system, "release");
  assert.equal(requests.length, 2);
  assert.equal(warnings.length, 1);
  assert.equal(requests[1].body.cachedContent, undefined);
});

const incompatible: Array<[ProviderName, ProviderConfig]> = [
  ["anthropic", { promptCache: { ttl: "7d" } }],
  ["openai", { model: "gpt-4o", promptCache: { ttl: "24h" } }],
  ["openai", { model: "gpt-5.6", promptCache: { ttl: "7d" } }],
  ["azure-openai", { model: "unknown-deployment", promptCache: { ttl: "12h" } }],
  ["mistral", { promptCache: { ttl: "1h" } }],
  ["google", { model: "gemini-1.5-pro", promptCache: { ttl: "7d" } }],
  ["google", { model: "gemini-4-carbon", promptCache: { ttl: "7d" } }],
  ["google", { model: "gemini-2.5-flash", promptCache: { ttl: "1ms" } }],
  ["ollama", { promptCache: { ttl: "1h" } }],
];

for (const [provider, config] of incompatible) {
  test(`${provider} rejects incompatible TTL ${config.promptCache!.ttl} for ${config.model ?? "default model"} before sending a request`, async t => {
    const requests = mockModel(t, provider);
    await assert.rejects(callLLM(provider, config, system, "release"), /TTL|caching is not supported/);
    assert.equal(requests.length, 0);
    assert.doesNotThrow(() => validateProviderCache(provider, { ...config, promptCache: { ...config.promptCache, enabled: false } }));
  });
}
