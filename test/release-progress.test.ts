import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, dirname } from "node:path";
import YAML from "yaml";
import { loadReleaseState, recordSkippedRelease } from "../src/release-state.js";
import { ReleaseProgress, contentHash, type ReleaseTarget } from "../src/release-progress.js";
import { loadConfig } from "../src/config.js";
import { promote } from "../src/promote.js";
import { generate, GenerationError } from "../src/generator.js";
import { json, mockModel, modelResponse } from "./helpers/mock-model.js";

const english = "# Release v2\n\nReviewed summary.\n\n### Improvements\n\n- Added filters.\n";

async function setup(t: TestContext, format: string) {
  const dir = await mkdtemp(join(tmpdir(), "release-progress-"));
  const before = process.cwd();
  process.chdir(dir);
  t.after(async () => { process.chdir(before); await rm(dir, { recursive: true, force: true }); });
  await writeFile("config.yml", `provider: mistral\nproviders:\n  mistral:\n    maxRetries: 0\ncache:\n  enabled: false\nprompt:\n  languages: [en, fr]\noutput:\n  format: ${format}\n  saveTo: './notes/{env}/{lang}/{from}_{to}.${format === "html" ? "html" : "md"}'\noutputIndex:\n  format: ${format}\n  saveTo: './notes/{env}/{lang}/index.${format === "html" ? "html" : "md"}'\n`);
  const path = (lang: string) => `notes/QUA/${lang}/v1_v2.${format === "html" ? "html" : "md"}`;
  const options = { configPath: "config.yml", fromVersion: "v1", toVersion: "v2", environment: "QUA", date: "2026-11-16",
    changelog: "feat: added filters", persist: true };
  return { dir, path, options };
}

for (const format of ["markdown", "html"]) {
  test(`${format}: completed final notes survive translation failure and resume without a response cache`, async t => {
    const f = await setup(t, format);
    let fail = true;
    const requests = mockModel(t, "mistral", request => {
      const prompt = JSON.stringify(request.body.messages);
      if (prompt.includes("Template:")) {
        const messages = request.body.messages as { role: string; content: string | { text: string }[] }[];
        const value = messages.find(message => message.role === "user")!.content;
        const text = typeof value === "string" ? value : value.map(part => part.text).join("");
        return modelResponse("mistral", text.split("Template:\n")[1]);
      }
      if (fail && prompt.includes("precise release-notes translator")) return json({ message: "limited", object: "error", type: "api_error" }, 429);
      return modelResponse("mistral", english);
    });
    await assert.rejects(generate(f.options), GenerationError);
    const initial = await readFile(f.path("en"), "utf8");
    assert.match(initial, /Added filters/);
    await access(`notes/QUA/en/index.${format === "html" ? "html" : "md"}`);
    await assert.rejects(access(".ai-release-notes/cache"));
    const edited = initial.replace("Added filters", "Manually reviewed filtering");
    await writeFile(f.path("en"), edited);
    fail = false;
    const resumed = await generate(f.options);
    assert.equal(resumed.metadata.outputs?.[0].status, "reused");
    assert.equal(await readFile(f.path("en"), "utf8"), edited);
    if (format === "html") assert.equal(resumed.localized[0].html, edited);
    assert.match(JSON.stringify(requests[2].body), /Manually reviewed filtering/);
    const calls = requests.length;
    await generate({ ...f.options, cache: false });
    assert.equal(requests.length, calls, "--no-cache must not replace completed documents");
    const sidecar = JSON.parse(await readFile("notes/QUA/.release-notes-state.json", "utf8"));
    assert(sidecar.releases[0].generation.indexes.en && sidecar.releases[0].generation.indexes.fr);
    assert.equal(sidecar.releases[0].generation.status, "complete");
    assert.doesNotMatch(JSON.stringify(sidecar), /Manually reviewed filtering/, "State must not duplicate note content");
    const secondEdit = edited.replace("Manually reviewed filtering", "Updated source for translation");
    await writeFile(f.path("en"), secondEdit);
    const refreshed = await generate(f.options);
    assert.equal(await readFile(f.path("en"), "utf8"), secondEdit);
    assert.equal(requests.length, calls + 1, "Only the stale translation must be regenerated");
    assert.equal(refreshed.metadata.outputs?.find(output => output.language === "fr")?.retranslatedFrom, "en");
    assert.match(JSON.stringify(requests.at(-1)!.body), /Updated source for translation/);
    const previousTranslation = await readFile(f.path("fr"), "utf8");
    await writeFile(f.path("en"), secondEdit.replace("Updated source", "Another source edit"));
    fail = true;
    await assert.rejects(generate(f.options), error => {
      assert(error instanceof GenerationError);
      const output = error.metadata.outputs?.find(output => output.language === "fr");
      assert.equal(output?.status, "failed");
      assert.equal(output?.retranslatedFrom, undefined, "Do not report a replacement that failed");
      return true;
    });
    assert.equal(await readFile(f.path("fr"), "utf8"), previousTranslation);
    await assert.rejects(generate({ ...f.options, changelog: "feat: different change" }), /inputs changed/);
  });

  test(`${format}: force replaces legacy documents without a sidecar`, async t => {
    const f = await setup(t, format);
    mockModel(t, "mistral", () => modelResponse("mistral", english));
    await generate({ ...f.options, language: "en" });
    await rm("notes/QUA/.release-notes-state.json");
    await writeFile(f.path("en"), format === "html" ? "<main><h1>Old release</h1><p>Old content</p></main>" : "# Old release\n\nOld content");
    await generate({ ...f.options, force: true, language: "en", cache: false });
    assert.match(await readFile(f.path("en"), "utf8"), /Added filters/);
  });
}

test('changing any configured primary language refreshes every secondary language, preserving the primary file', async t => {
  const f = await setup(t, "markdown");
  const config = YAML.parse(await readFile("config.yml", "utf8"));
  config.prompt.languages = ["fr", "en", "de"];
  delete config.outputIndex;
  await writeFile("config.yml", YAML.stringify(config));
  const requests = mockModel(t, "mistral", () => modelResponse("mistral", english));
  await generate(f.options);
  assert.equal(requests.length, 3);
  const primary = f.path("fr");
  await writeFile(primary, "# Source principale corrigée\n\nUne modification métier.\n");
  await generate({ ...f.options, language: "fr" });
  assert.equal((await loadReleaseState("notes/QUA/.release-notes-state.json")).releases[0].generation?.status, "pending");
  assert.equal(requests.length, 3, "An explicitly limited run must leave stale secondary languages pending");
  await writeFile(f.path("en"), "# Manually reviewed English wording\n");
  const refreshed = await generate(f.options);
  assert.equal(requests.length, 5);
  assert.equal(refreshed.metadata.outputs?.find(output => output.language === "en")?.retranslatedFrom, "fr");
  assert.equal(refreshed.metadata.outputs?.find(output => output.language === "de")?.retranslatedFrom, "fr");
  assert.doesNotMatch(await readFile(f.path("en"), "utf8"), /Manually reviewed English/);
  for (const request of requests.slice(3)) assert.match(JSON.stringify(request.body), /Une modification métier/);
  assert.match(await readFile(primary, "utf8"), /Source principale corrigée/);
  const reused = await generate({ ...f.options, cache: false });
  assert.equal(requests.length, 5);
  assert(reused.metadata.outputs?.every(output => output.retranslatedFrom === undefined));
  config.prompt.languages.push("es");
  await writeFile("config.yml", YAML.stringify(config));
  await generate(f.options);
  assert.equal(requests.length, 6, "Adding a secondary language must not regenerate completed notes");
});

test('incomplete model output never creates a final document', async t => {
  const f = await setup(t, "markdown");
  mockModel(t, "mistral", () => modelResponse("mistral", "# Truncated", 0, "length"));
  await assert.rejects(generate(f.options), /did not complete/);
  await assert.rejects(access(f.path("en")));
});

for (const language of ["en", "fr"]) {
  test(`incomplete ${language} output is reported as failed without saving or replacing its final document`, async t => {
    const f = await setup(t, "markdown");
    const config = YAML.parse(await readFile("config.yml", "utf8"));
    delete config.outputIndex;
    await writeFile("config.yml", YAML.stringify(config));
    let fail = false;
    mockModel(t, "mistral", request => {
      const translating = JSON.stringify(request.body).includes("precise release-notes translator");
      return modelResponse("mistral", fail && translating === (language === "fr") ? "# Truncated" : english,
        0, fail && translating === (language === "fr") ? "length" : "stop");
    });
    await generate(f.options);
    const previous = await readFile(f.path(language), "utf8");
    fail = true;
    await assert.rejects(generate({ ...f.options, force: true, language }), error => {
      assert(error instanceof GenerationError);
      assert.match(error.message, /did not complete/);
      const output = error.metadata.outputs?.find(output => output.language === language);
      assert.equal(output?.status, "failed");
      assert.equal(output?.retranslatedFrom, undefined);
      return true;
    });
    assert.equal(await readFile(f.path(language), "utf8"), previous);
    assert.equal((await loadReleaseState("notes/QUA/.release-notes-state.json")).releases[0].generation?.status, "pending");
  });
}

test("a resumed promotion records the replacement content hash after an interrupted force", async t => {
  const f = await setup(t, "markdown");
  const config = await loadConfig("config.yml");
  const target: ReleaseTarget = { path: resolve(f.path("en")), language: "en", format: "markdown" };
  const initial = await ReleaseProgress.open(config, f.options, [target], "promote");
  await initial.prepare("request");
  await initial.savePromoted(target, "# Previous note", "source");
  const forced = await ReleaseProgress.open(config, { ...f.options, force: true }, [target], "promote");
  await forced.prepare("request");
  // Stop before the write; the next invocation must complete this pending replacement.
  const resumed = await ReleaseProgress.open(config, f.options, [target], "promote");
  await resumed.prepare("request");
  assert.equal(await resumed.readPromoted(target, "source"), undefined);
  await resumed.savePromoted(target, "# Replacement note", "source");
  const actual = await readFile(target.path, "utf8");
  const entry = (await loadReleaseState(resumed.path)).releases[0].generation!;
  assert.equal(entry.files[relative(dirname(resumed.path), target.path)].hash, contentHash(actual));
  assert.equal(entry.pending.length, 0);
  assert.equal(await resumed.readPromoted(target, "source"), actual);
});

for (const format of ["markdown", "html"]) {
  test(`${format}: promotion saves a completed language before a missing source, then resumes and force replaces legacy targets`, async t => {
    const f = await setup(t, format);
    mockModel(t, "mistral", () => modelResponse("mistral", english));
    await generate({ ...f.options, language: "en" });
    const options = { configPath: "config.yml", fromEnvironment: "QUA", toEnvironment: "PRD",
      fromVersion: "v1", toVersion: "v2", date: "2026-11-16", persist: true };
    await assert.rejects(promote(options), /missing.*fr/s);
    const target = f.path("en").replace("QUA", "PRD");
    const first = await readFile(target, "utf8");
    const reviewed = first.replace("Added filters", "Reviewed production note");
    await writeFile(target, reviewed);
    // Supply the source that was missing; no provider is needed for a single-range promotion.
    const fr = f.path("fr");
    await import("node:fs/promises").then(fs => fs.mkdir(join(fr, ".."), { recursive: true }));
    await writeFile(fr, await readFile(f.path("en"), "utf8"));
    await promote({ ...options, fromVersion: undefined, toVersion: undefined });
    assert.equal(await readFile(target, "utf8"), reviewed);
    await access(fr.replace("QUA", "PRD"));
    await rm("notes/PRD/.release-notes-state.json");
    await promote({ ...options, force: true });
    assert.match(await readFile(target, "utf8"), /Added filters/);
    assert.doesNotMatch(await readFile(target, "utf8"), /Reviewed production note/);
  });
}

test('a failed forced replacement remains pending and a normal rerun replaces the old file', async t => {
  const f = await setup(t, "markdown");
  let fail = false;
  const requests = mockModel(t, "mistral", () => fail
    ? json({ message: "limited", object: "error", type: "api_error" }, 429) : modelResponse("mistral", english));
  await generate({ ...f.options, language: "en" });
  await writeFile(f.path("en"), "# Old reviewed content");
  fail = true;
  await assert.rejects(generate({ ...f.options, force: true, language: "en" }), GenerationError);
  assert.match(await readFile(f.path("en"), "utf8"), /Old reviewed content/);
  const pending = JSON.parse(await readFile("notes/QUA/.release-notes-state.json", "utf8"));
  assert.equal(pending.releases[0].generation.pending.length, 1);
  fail = false;
  await generate({ ...f.options, language: "en" });
  assert.equal(requests.length, 3);
  assert.match(await readFile(f.path("en"), "utf8"), /Added filters/);
});

test('force retains the original recorded date unless a replacement date is explicit', async t => {
  const f = await setup(t, "markdown");
  mockModel(t, "mistral", () => modelResponse("mistral", english));
  const original = await generate({ ...f.options, language: "en", date: "2020-01-01" });
  const regenerated = await generate({ ...f.options, language: "en", date: undefined, force: true });
  assert.equal(regenerated.metadata.date, original.metadata.date);
});

test('one shared ledger retains several ranges and skipped deployment dates while completing notes', async t => {
  const f = await setup(t, "markdown");
  const config = YAML.parse(await readFile("config.yml", "utf8"));
  config.prompt.languages = ["en"];
  delete config.outputIndex;
  await writeFile("config.yml", YAML.stringify(config));
  mockModel(t, "mistral", () => modelResponse("mistral", english));
  const statePath = "notes/QUA/.release-notes-state.json";
  await recordSkippedRelease({ path: statePath, environment: "QUA", fromVersion: "v1", toVersion: "v2", date: "2020-01-01" });
  const recovered = await generate({ ...f.options, date: undefined });
  assert.equal(recovered.metadata.date, "January 01, 2020");
  await generate({ ...f.options, fromVersion: "v2", toVersion: "v3" });
  const state = await loadReleaseState(statePath);
  assert.equal(state.releases.length, 2);
  assert.equal(state.releases[0].deployment?.date, "2020-01-01");
  assert.equal(state.releases[0].generation?.status, "complete");
  assert.equal(state.releases[1].generation?.status, "complete");
  await assert.rejects(access(f.path("en") + ".generation.json"));
});

test('legacy pending and generation files migrate together without losing dates or finished output', async t => {
  const f = await setup(t, "markdown");
  const config = YAML.parse(await readFile("config.yml", "utf8"));
  config.prompt.languages = ["en"];
  delete config.outputIndex;
  await writeFile("config.yml", YAML.stringify(config));
  const requests = mockModel(t, "mistral", () => modelResponse("mistral", english));
  await generate(f.options);
  const statePath = "notes/QUA/.release-notes-state.json";
  const state = await loadReleaseState(statePath);
  const legacy = { version: 1, environment: "QUA", fromVersion: "v1", toVersion: "v2", ...state.releases[0].generation };
  legacy.files = Object.fromEntries(Object.entries(legacy.files!).map(([path, value]) => ["../" + path, value]));
  await writeFile(f.path("en") + ".generation.json", JSON.stringify(legacy));
  await writeFile("notes/QUA/.pending-release-notes.json", JSON.stringify([{ from: "v0", to: "v1", date: "2019-05-12" }]));
  await rm(statePath);
  await generate(f.options);
  assert.equal(requests.length, 1);
  const migrated = await loadReleaseState(statePath);
  assert.equal(migrated.releases.length, 2);
  assert.equal(migrated.releases.find(entry => entry.toVersion === "v1")?.deployment?.date, "2019-05-12");
  assert.equal(migrated.releases.find(entry => entry.toVersion === "v2")?.generation?.status, "complete");
  await assert.rejects(access(f.path("en") + ".generation.json"));
  await assert.rejects(access("notes/QUA/.pending-release-notes.json"));
});
