import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { callLLM } from "../src/llm.js";
import { addModelUsage } from "../src/model-usage.js";
import type { GenerationUsage, ProviderName } from "../src/types.js";
import { json, mockModel, modelResponse } from "./helpers/mock-model.js";

async function localCache(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "release-in-flight-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, ttlMs: 60_000 };
}

for (const provider of ["openai", "anthropic", "mistral", "google", "azure-openai", "ollama"] as ProviderName[]) {
  test(`${provider}: parallel cache misses share one API call and count its usage once`, async t => {
    const cache = await localCache(t);
    let started!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const requests = mockModel(t, provider, async () => {
      started();
      await pending;
      return modelResponse(provider, "Shared release.", 8);
    });
    const ownerCall = callLLM(provider, {}, "system", "release", cache);
    await ready;
    // A zero-TTL entry must survive a timer turn while the provider is pending.
    await wait(0);
    const waiters = Array.from({ length: 2 }, () => callLLM(provider, {}, "system", "release", cache));
    finish();
    const results = await Promise.all([ownerCall, ...waiters]);
    assert.equal(requests.length, 1);
    assert.ok(results.every(result => result.text === "Shared release."));
    assert.equal(results.filter(result => result.usage.coalescedCalls).length, 2);
    const total: GenerationUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0, durationMs: 0 };
    for (const result of results) addModelUsage(total, result.usage);
    const owner = results.find(result => !result.usage.coalescedCalls)!;
    assert.equal(total.modelCalls, 1);
    assert.equal(total.inputTokens, owner.usage.inputTokens);
    assert.equal(total.outputTokens, owner.usage.outputTokens);
    assert.equal(total.totalTokens, owner.usage.totalTokens);
    assert.equal(total.providerCacheReadTokens, owner.usage.providerCacheReadTokens);
    assert.equal(total.providerCacheWriteTokens, owner.usage.providerCacheWriteTokens);
    assert.equal(total.coalescedCalls, 2);
    assert.equal(total.cacheHits, undefined);
    const cached = await callLLM(provider, {}, "system", "release", cache);
    assert.equal(cached.usage.cacheHits, 1);
    assert.equal(cached.usage.coalescedCalls, undefined);
    assert.equal(requests.length, 1);
    assert.equal((await readdir(cache.directory)).filter(file => file.endsWith(".json")).length, 1);
  });
}

test("cache: false forces independent parallel calls and preserves a stored response", async t => {
  const cache = await localCache(t);
  const requests = mockModel(t, "mistral", async (_request, index) => {
    await wait(20);
    return modelResponse("mistral", `response ${index}`);
  });
  const saved = await callLLM("mistral", {}, "s", "u", cache);
  const fresh = await Promise.all(Array.from({ length: 2 }, () => callLLM("mistral", {}, "s", "u", false)));
  assert.equal(requests.length, 3);
  assert.ok(fresh.every(result => !result.usage.coalescedCalls && !result.usage.cacheHits && result.usage.totalTokens > 0));
  assert.notEqual(fresh[0].text, fresh[1].text);
  assert.equal((await callLLM("mistral", {}, "s", "u", cache)).text, saved.text);
  assert.equal(requests.length, 3);
});

test("different prompts, models, cache directories and execution settings stay independent", async t => {
  const cache = await localCache(t);
  const other = await localCache(t);
  const requests = mockModel(t, "mistral", async () => { await wait(20); return modelResponse("mistral"); });
  await Promise.all([
    callLLM("mistral", {}, "s", "u", cache),
    callLLM("mistral", {}, "s", "different", cache),
    callLLM("mistral", { model: "ministral-3b-latest" }, "s", "u", cache),
    callLLM("mistral", {}, "s", "u", other),
    callLLM("mistral", {}, "s", "u", { ...cache, ttlMs: 1000 }),
    callLLM("mistral", { maxRetries: 0 }, "s", "u", cache),
    callLLM("mistral", { promptCache: { enabled: false } }, "s", "u", cache),
  ]);
  assert.equal(requests.length, 7);
});

test("credentials are part of the in-flight identity", async t => {
  const cache = await localCache(t);
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const requests = mockModel(t, "mistral", async () => {
    started();
    await wait(30);
    return modelResponse("mistral");
  });
  const first = callLLM("mistral", {}, "s", "u", cache);
  await ready;
  process.env.MISTRAL_API_KEY = "different-account";
  const second = callLLM("mistral", {}, "s", "u", cache);
  await Promise.all([first, second]);
  assert.equal(requests.length, 2);
});

test("a shared provider failure reaches all callers and a rerun succeeds", async t => {
  const cache = await localCache(t);
  let fail = true;
  const requests = mockModel(t, "mistral", async () => {
    await wait(20);
    return fail ? json({ message: "rejected", object: "error", type: "api_error" }, 401) : modelResponse("mistral");
  });
  const failed = await Promise.allSettled(Array.from({ length: 3 }, () => callLLM("mistral", {}, "s", "u", cache)));
  assert.equal(requests.length, 1);
  assert.ok(failed.every(result => result.status === "rejected"));
  assert.deepEqual(await readdir(cache.directory), []);
  fail = false;
  assert.match((await callLLM("mistral", {}, "s", "u", cache)).text, /useful change/);
  assert.equal(requests.length, 2);
});

test("parallel callers share one retry sequence", async t => {
  const cache = await localCache(t);
  const requests = mockModel(t, "mistral", async (_request, index) => {
    await wait(20);
    return index === 0 ? json({ message: "busy", object: "error", type: "api_error" }, 429) : modelResponse("mistral");
  });
  const results = await Promise.all(Array.from({ length: 3 }, () =>
    callLLM("mistral", { maxRetries: 1, initialRetryDelayMs: 0 }, "s", "u", cache)));
  assert.equal(requests.length, 2);
  assert.equal(results.filter(result => result.usage.coalescedCalls).length, 2);
});

test("Gemini parallel calls share explicit cache preparation as well as generation", async t => {
  const cache = await localCache(t);
  const requests = mockModel(t, "google", async request => {
    await wait(20);
    return request.url.endsWith("/cachedContents") ? json({
      name: "cachedContents/shared_rules",
      expireTime: new Date(Date.now() + 3_600_000).toISOString(),
      usageMetadata: { totalTokenCount: 40 },
    }) : modelResponse("google", "Release.", 8);
  });
  const results = await Promise.all(Array.from({ length: 2 }, () =>
    callLLM("google", { model: "gemini-2.5-flash", promptCache: { ttl: "1h" } }, "s", "u", cache)));
  assert.equal(requests.length, 2);
  assert.equal(requests.filter(request => request.url.endsWith("/cachedContents")).length, 1);
  assert.equal(results.reduce((total, result) => total + (result.usage.providerCacheWriteTokens ?? 0), 0), 40);
  assert.equal(results.filter(result => result.usage.coalescedCalls).length, 1);
});
