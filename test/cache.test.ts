import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callLLM } from "../src/llm.js";
import { generate, GenerationError } from "../src/generator.js";
import { loadConfig, resolveProviderConfig } from "../src/config.js";
import { clearModelCache, modelCacheKey, parseCacheTtl, resolveCacheConfig } from "../src/cache/index.js";
import { json, mockModel, modelResponse } from "./helpers/mock-model.js";
import { updateOutputIndexes } from "../src/output-index.js";
import { translateOutputIndexTemplate } from "../src/output-index-translation.js";

async function workspace(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "release-cache-"));
  const previous = process.cwd();
  process.chdir(directory);
  t.after(async () => { process.chdir(previous); await rm(directory, { recursive: true, force: true }); });
  return directory;
}

test("cache TTL accepts days and rejects invalid or unsafe durations", () => {
  assert.equal(parseCacheTtl("30d"), 30 * 86_400_000);
  assert.equal(parseCacheTtl("1h"), 3_600_000);
  assert.equal(parseCacheTtl("500ms"), 500);
  for (const value of ["0d", "-1d", "1.5h", "forever", "1y", "999999999999999999d"]) {
    assert.throws(() => parseCacheTtl(value));
  }
  const overridden = resolveCacheConfig({ ttl: "1h" }, { cacheTtl: "7d" });
  assert.ok(overridden);
  assert.equal(overridden.ttlMs, 7 * 86_400_000);
  assert.equal(resolveCacheConfig({ enabled: true }, { cache: false }), false);
  assert.equal(resolveCacheConfig({ enabled: false }), false);
});

test("YAML and API configure both caches without losing provider overrides", async t => {
  const directory = await workspace(t);
  const path = join(directory, "config.yml");
  await writeFile(path, "provider: anthropic\nproviders:\n  anthropic:\n    promptCache:\n      ttl: 1h\ncache:\n  ttl: 30d\n");
  const config = await loadConfig(path);
  assert.equal(config.cache?.ttl, "30d");
  assert.deepEqual(resolveProviderConfig(config.providers.anthropic, { promptCacheTtl: "5m" }).promptCache, { ttl: "5m" });
  assert.deepEqual(resolveProviderConfig(config.providers.anthropic, { promptCache: false }).promptCache, { ttl: "1h", enabled: false });
  await writeFile(path, "providers: {}\ncache:\n  ttl: -1d\n");
  await assert.rejects(loadConfig(path), /cache.ttl/);
});

test("identical requests use a persisted response with no new token charges", async t => {
  const directory = await workspace(t);
  const requests = mockModel(t, "mistral", () => modelResponse("mistral", "  Reviewed text.\n"));
  const cache = resolveCacheConfig(undefined);
  const first = await callLLM("mistral", {}, "system", "release", cache);
  const second = await callLLM("mistral", {}, "system", "release", cache);
  assert.equal(requests.length, 1);
  assert.equal(second.text, first.text);
  assert.deepEqual(second.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheHits: 1 });
  const files = (await readdir(join(directory, ".ai-release-notes/cache"))).filter(file => file.endsWith(".json"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.json$/);
  const saved = await readFile(join(directory, ".ai-release-notes/cache", files[0]), "utf8");
  assert.doesNotMatch(saved, /test-MISTRAL_API_KEY|"system"|"release"/);
  assert.equal((await stat(join(directory, ".ai-release-notes/cache", files[0]))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(directory, ".ai-release-notes/cache/.gitignore"), "utf8"), "*\n");
});

test("output-affecting changes miss the cache but retry settings do not", async t => {
  await workspace(t);
  const requests = mockModel(t, "mistral");
  const cache = resolveCacheConfig(undefined);
  await callLLM("mistral", {}, "system", "release", cache);
  await callLLM("mistral", { maxRetries: 5 }, "system", "release", cache);
  assert.equal(requests.length, 1);
  await callLLM("mistral", {}, "changed rules", "release", cache);
  await callLLM("mistral", {}, "system", "changed context", cache);
  await callLLM("mistral", { model: "ministral-3b-latest" }, "system", "release", cache);
  await callLLM("mistral", { temperature: 0.8 }, "system", "release", cache);
  await callLLM("mistral", { maxTokens: 1000 }, "system", "release", cache);
  assert.equal(requests.length, 6);
  assert.notEqual(modelCacheKey("openai", {}, "s", "u"), modelCacheKey("mistral", {}, "s", "u"));
  assert.notEqual(modelCacheKey("azure-openai", { baseURL: "https://a.test" }, "s", "u"),
    modelCacheKey("azure-openai", { baseURL: "https://b.test" }, "s", "u"));
});

test("expiry is fixed from creation, and bypass neither reads nor overwrites cached responses", async t => {
  await workspace(t);
  const requests = mockModel(t, "mistral", (_request, index) => modelResponse("mistral", `answer ${index}`));
  let now = Date.parse("2026-11-14T12:00:00Z");
  t.mock.method(Date, "now", () => now);
  const cache = resolveCacheConfig({ ttl: "1h" });
  await callLLM("mistral", {}, "s", "u", cache);
  now += 30 * 60_000;
  assert.equal((await callLLM("mistral", {}, "s", "u", cache)).text, "answer 0");
  assert.equal((await callLLM("mistral", {}, "s", "u", false)).text, "answer 1");
  assert.equal((await callLLM("mistral", {}, "s", "u", cache)).text, "answer 0");
  now += 30 * 60_000;
  assert.equal((await callLLM("mistral", {}, "s", "u", cache)).text, "answer 2");
  assert.equal(requests.length, 3);
  await clearModelCache();
  await callLLM("mistral", {}, "s", "u", cache);
  assert.equal(requests.length, 4);
});

test("corrupt cache files are replaced and failed requests are never cached", async t => {
  await workspace(t);
  let fail = true;
  const requests = mockModel(t, "mistral", () => fail
    ? json({ message: "rejected", object: "error", type: "api_error" }, 401) : modelResponse("mistral"));
  const cache = resolveCacheConfig(undefined);
  await assert.rejects(callLLM("mistral", {}, "s", "u", cache));
  fail = false;
  await callLLM("mistral", {}, "s", "u", cache);
  const directory = join(process.cwd(), ".ai-release-notes/cache");
  const file = (await readdir(directory)).find(file => file.endsWith(".json"))!;
  await writeFile(join(directory, file), "{interrupted");
  await callLLM("mistral", {}, "s", "u", cache);
  assert.equal(requests.length, 3);
  const readBack = await readFile(join(directory, file), "utf8");
  assert.doesNotThrow(() => JSON.parse(readBack));
});

for (const [text, finishReason] of [["", "stop"], ["Truncated release note.", "length"]]) {
  test(`does not cache ${text ? "truncated" : "empty"} model output`, async t => {
    await workspace(t);
    const requests = mockModel(t, "mistral", () => modelResponse("mistral", text, 0, finishReason));
    const cache = resolveCacheConfig(undefined);
    await callLLM("mistral", {}, "s", "u", cache);
    await callLLM("mistral", {}, "s", "u", cache);
    assert.equal(requests.length, 2);
  });
}

test("cache write failures warn without losing the generated response", async t => {
  const directory = await workspace(t);
  const blocked = join(directory, "not-a-directory");
  await writeFile(blocked, "existing file");
  const warnings: string[] = [];
  t.mock.method(console, "warn", message => warnings.push(String(message)));
  mockModel(t, "mistral");
  const result = await callLLM("mistral", {}, "s", "u", { directory: blocked, ttlMs: 1000 });
  assert.match(result.text, /useful change/);
  assert.ok(warnings.some(warning => warning.includes("Could not save model cache")));
});

test("an invalid index translation is evicted so a rerun can recover", async t => {
  await workspace(t);
  const requests = mockModel(t, "mistral", (request, index) => {
    if (index === 0) return modelResponse("mistral", "A response that dropped the template slots.");
    const messages = request.body.messages as Array<{ role: string; content: Array<{ text: string }> }>;
    const prompt = messages.find(message => message.role === "user")!.content.map(part => part.text).join("");
    return modelResponse("mistral", prompt.split("Template:\n")[1]);
  });
  const cache = resolveCacheConfig(undefined);
  const template = "## Version {{toVersion}}\n\n[Read notes]({{href}})";
  await assert.rejects(translateOutputIndexTemplate(template, "fr", "mistral", {}, cache), /did not preserve/);
  const recovered = await translateOutputIndexTemplate(template, "fr", "mistral", {}, cache);
  assert.equal(requests.length, 2);
  assert.equal(recovered.text, template);
});

for (const format of ["markdown", "html"] as const) {
  for (const language of ["en", "fr"]) {
    test(`${format}: an empty fenced ${language} note is evicted and a return-only rerun recovers`, async t => {
      const directory = await workspace(t);
      const configPath = join(directory, "config.yml");
      await writeFile(configPath, "provider: mistral\nproviders:\n  mistral:\n    maxRetries: 0\nprompt:\n  languages: [en, fr]\n");
      let invalid = true;
      const requests = mockModel(t, "mistral", request => {
        const translating = JSON.stringify(request.body).includes("precise release-notes translator");
        return modelResponse("mistral", invalid && translating === (language === "fr")
          ? "```markdown\n\n```" : "# Valid note\n\nA complete improvement.");
      });
      const options = { configPath, fromVersion: "v1", toVersion: "v2", environment: "PROD", date: "2026-11-16",
        changelog: "feat: improvement", format };
      await assert.rejects(generate(options), error => {
        assert(error instanceof GenerationError);
        assert.equal(error.metadata.outputs?.find(output => output.language === language)?.status, "failed");
        return true;
      });
      invalid = false;
      const recovered = await generate(options);
      assert.equal(requests.length, 3);
      assert(recovered.localized.every(release => release.markdown.includes("A complete improvement")));
    });
  }

  test(`${format}: a failed translation resumes completed languages and --no-cache forces new calls`, async t => {
    const directory = await workspace(t);
    const configPath = join(directory, "config.yml");
    await writeFile(configPath, `provider: mistral\nproviders:\n  mistral:\n    maxRetries: 0\nprompt:\n  languages: [en, fr, de, es]\noutput:\n  format: ${format}\n`);
    let fail = true;
    const requests = mockModel(t, "mistral", (_request, index) => fail && index === 2
      ? json({ message: "failed translation", object: "error", type: "api_error" }, 503)
      : modelResponse("mistral", `# Release\n\nAnswer ${index}.`));
    const options = { configPath, fromVersion: "v1", toVersion: "v2", environment: "PROD", date: "2026-11-14", changelog: "feat: useful change", format };
    await assert.rejects(generate(options), error => {
      assert.ok(error instanceof GenerationError);
      assert.deepEqual(error.completed.map(output => output.language), ["en", "fr"]);
      assert.deepEqual(error.metadata.outputs?.map(output => output.status), ["generated", "generated", "failed", "not-attempted"]);
      return true;
    });
    fail = false;
    const resumed = await generate(options);
    assert.equal(requests.length, 5);
    assert.equal(resumed.metadata.usage.cacheHits, 2);
    assert.equal(resumed.metadata.usage.modelCalls, 2);
    assert.deepEqual(resumed.metadata.outputs?.map(output => output.status), ["cached", "cached", "generated", "generated"]);
    assert.equal(resumed.localized[0].markdown, "# Release\n\nAnswer 0.");
    if (format === "html") assert.match(resumed.localized[0].html!, /Answer 0/);
    await generate(options);
    assert.equal(requests.length, 5);
    await generate({ ...options, cache: false });
    assert.equal(requests.length, 9);
  });

  test(`${format}: index failures preserve note responses, and creation primes the entry translation cache`, async t => {
    const directory = await workspace(t);
    let failIndex = true;
    const requests = mockModel(t, "mistral", request => {
      const messages = request.body.messages as Array<{ role: string; content: string | Array<{ text: string }> }>;
      const content = messages.find(message => message.role === "user")!.content;
      const prompt = typeof content === "string" ? content : content.map(part => part.text).join("");
      if (!prompt.includes("Template:\n")) return modelResponse("mistral");
      if (failIndex) return json({ message: "index failed", object: "error", type: "api_error" }, 503);
      const translated = prompt.split("Template:\n")[1];
      return modelResponse("mistral", format === "html" ? "```html\n" + translated + "\n```" : translated);
    });
    const cache = resolveCacheConfig(undefined);
    const config = { maxRetries: 0 };
    const indexPath = join(directory, "{lang}", `index.${format === "html" ? "html" : "md"}`);
    const params = {
      outputIndexes: [{ format, saveTo: indexPath }],
      releases: [{ path: join(directory, "fr", "notes.md"), format: "markdown", language: "fr" }],
      environment: "PROD", fromVersion: "v1", toVersion: "v2", date: "2026-11-14",
      languages: ["fr"], primaryLanguage: "en",
      translateTemplate: async (template: string, language: string) =>
        (await translateOutputIndexTemplate(template, language, "mistral", config, cache)).text,
    };
    await callLLM("mistral", config, "system", "note", cache);
    await assert.rejects(updateOutputIndexes(params));
    failIndex = false;
    await callLLM("mistral", config, "system", "note", cache);
    await updateOutputIndexes(params);
    assert.equal(requests.length, 3);
    await updateOutputIndexes(params);
    assert.equal(requests.length, 3);
  });
}
