import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtures, judgeFixture, passes, run, verdictSchema } from "./eval/harness.js";
import { mockModel, modelResponse } from "./helpers/mock-model.js";

const exec = promisify(execFile);
const root = resolve(__dirname, "..");
const good = { readability: 5, categorization: 4, jargon: 5, identifiers: 5, faithfulness: 4, reason: "Clear and grounded." };
function judgeEnvironment(t: TestContext, threshold = "0") {
  for (const [key, value] of Object.entries({ EVAL_PROVIDER: "mistral", EVAL_MIN_SCORE: threshold })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "table", () => {});
  return t.mock.method(console, "warn", () => {});
}

test("offline eval rejects changes to every shipped prompt, rendering drift, and missing snapshots", async t => {
  const directory = await mkdtemp(join(tmpdir(), "eval-regression-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const path of ["src", "prompts", "templates", "test/eval", "test/fixtures/eval", "package.json", "tsconfig.json"]) {
    await cp(join(root, path), join(directory, path), { recursive: true });
  }
  await symlink(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  // Clear real keys and deny fetch independently of the runner's own guard.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.endsWith("_API_KEY"))),
    EVAL_PROVIDER: "openai", GITHUB_ACTIONS: "true" };
  const preload = join(directory, "offline.cjs");
  await writeFile(preload, "globalThis.fetch = async () => { throw new Error('Unexpected network call'); };\n");
  const execute = (...args: string[]) => exec(process.execPath,
    ["--require", preload, "--import", "tsx", "test/eval/run.ts", ...args], { cwd: directory, env });
  const baseline = await execute();
  assert.match(baseline.stdout, /PASS/);
  const missingKey = await execute("--judge");
  assert.match(missingKey.stderr, /requires OPENAI_API_KEY/);
  assert.match(missingKey.stderr, /::warning::/);
  assert.match(missingKey.stdout, /SKIP/);
  for (const file of (await readdir(join(directory, "prompts"))).filter(file => file.endsWith(".md"))) {
    const path = join(directory, "prompts", file);
    const original = await readFile(path, "utf8");
    await writeFile(path, original + "\nDeliberate regression: expose commit hashes.\n");
    try {
      await assert.rejects(execute(), error => {
        const result = error as Error & { code: number; stdout: string; stderr: string };
        assert.equal(result.code, 1, file);
        assert.match(result.stdout, /FAIL/, file);
        assert.match(result.stderr, /Deliberate regression/, file);
        return true;
      });
    } finally { await writeFile(path, original); }
  }
  const templatePath = join(directory, "templates/default-release-note.html");
  const template = await readFile(templatePath, "utf8");
  await writeFile(templatePath, template.replace("{{content}}", "<p>Lost release content</p>"));
  try {
    await assert.rejects(execute(), error => {
      assert.match((error as { stdout: string }).stdout, /FAIL/);
      return true;
    });
  } finally { await writeFile(templatePath, template); }
  // A package release only changes the footer version, not writing quality.
  const packagePath = join(directory, "package.json");
  const packageData = JSON.parse(await readFile(packagePath, "utf8"));
  await writeFile(packagePath, JSON.stringify({ ...packageData, version: "99.0.0" }));
  await execute();
  const fixture = join(directory, "test/fixtures/eval/express-routing");
  await writeFile(join(fixture, "recorded.md"), "# Changed heading\n\n### Renamed section\n\n- Changed text.\n");
  await assert.rejects(execute(), /Command failed/);
  const updated = await execute("--update");
  assert.match(updated.stdout, /UPDATED/);
  await execute();
  await rm(join(fixture, "expected.snap.json"));
  await assert.rejects(execute(), error => {
    assert.match((error as { stderr: string }).stderr, /Missing snapshot/);
    return true;
  });
});

test("judge generates fresh notes from frozen inputs and scores the candidate through the SDK", async t => {
  const input = (await fixtures())[0].input;
  const candidate = "# Candidate from the live generation path\n\nA reviewed improvement.";
  const requests = mockModel(t, "mistral", (_request, index) =>
    modelResponse("mistral", index === 0 ? candidate : JSON.stringify(good)));
  const verdict = await judgeFixture(input, "mistral", { maxRetries: 0, promptCache: { enabled: false } });
  assert.equal(passes(verdict), true);
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[0].body), /Transform technical changelog/);
  assert.ok(JSON.stringify(requests[0].body).includes(input.commits[0].subject));
  const judging = JSON.stringify(requests[1].body);
  assert.ok(judging.includes(candidate.split("\n")[0]));
  assert.match(judging, /faithfulness/);
  assert.match(judging, /untrusted source material/);
});

test("judge validates scores and rejects invalid JSON and incomplete responses", async t => {
  const input = (await fixtures())[0].input;
  assert.equal(passes({ ...good, identifiers: 3 }), false);
  assert.throws(() => verdictSchema.parse({ ...good, faithfulness: 6 }));
  assert.throws(() => verdictSchema.parse({ ...good, identifiers: undefined }));
  assert.throws(() => verdictSchema.parse({ ...good, reason: " " }));
  let answer = "not JSON", finish = "stop";
  mockModel(t, "mistral", (_request, index) => modelResponse("mistral",
    index % 2 === 0 ? "# Generated note" : answer, 0, finish));
  await assert.rejects(judgeFixture(input, "mistral", { maxRetries: 0 }), /JSON/);
  answer = JSON.stringify(good);
  finish = "length";
  await assert.rejects(judgeFixture(input, "mistral", { maxRetries: 0 }), /did not complete/);
});

test("judge runner returns failure for a low score and continues all fixtures", async t => {
  judgeEnvironment(t, "3");
  const requests = mockModel(t, "mistral", (_request, index) => modelResponse("mistral",
    index % 2 === 0 ? "# Generated note" : JSON.stringify({ ...good, jargon: index === 1 ? 2 : 5 })));
  assert.equal(await run(["--judge"]), 1);
  assert.equal(requests.length, (await fixtures()).length * 2);
  assert.equal(await run(["--judge"]), 0);
  assert.equal(requests.length, (await fixtures()).length * 4);
});

test("quality is advisory by default, and only scores strictly below the configured threshold fail", async t => {
  const warnings = judgeEnvironment(t);
  mockModel(t, "mistral", (_request, index) => modelResponse("mistral",
    index % 2 === 0 ? "# Generated note" : JSON.stringify({ ...good, jargon: 2 })));
  assert.equal(await run(["--judge"]), 0);
  assert.equal(warnings.mock.callCount(), (await fixtures()).length);
  process.env.EVAL_MIN_SCORE = "2";
  assert.equal(await run(["--judge"]), 0);
  process.env.EVAL_MIN_SCORE = "3";
  assert.equal(await run(["--judge"]), 1);
});

test("AI access and response problems warn and stop remaining paid calls regardless of the threshold", async t => {
  const cases = [401, 402, 429, 500, "network", "timeout", "malformed", "truncated"] as const;
  for (const scenario of cases) await t.test(String(scenario), async t => {
    const warnings = judgeEnvironment(t, "5");
    const requests = mockModel(t, "mistral", (_request, index) => {
      if (index === 0) return modelResponse("mistral", "# Generated note");
      if (typeof scenario === "number") return new Response(JSON.stringify({ message: "Service unavailable" }),
        { status: scenario, headers: { "content-type": "application/json" } });
      if (scenario === "network") throw new TypeError("fetch failed");
      if (scenario === "timeout") throw new DOMException("Request timed out", "TimeoutError");
      return modelResponse("mistral", scenario === "malformed" ? "not JSON" : JSON.stringify(good),
        0, scenario === "truncated" ? "length" : "stop");
    });
    assert.equal(await run(["--judge"]), 0);
    assert.equal(requests.length, 2);
    assert.equal(warnings.mock.callCount(), 1);
    assert.match(String(warnings.mock.calls[0].arguments[0]), /assessment is incomplete/);
  });
});

test("generation quota failures also warn, while earlier scores below the threshold remain failures", async t => {
  judgeEnvironment(t, "3");
  let failImmediately = true;
  const requests = mockModel(t, "mistral", (_request, index) => {
    if (failImmediately || index >= 3) return new Response('{"message":"Quota exhausted"}', { status: 429 });
    return modelResponse("mistral", index === 1 ? "# Generated note" : JSON.stringify({ ...good, jargon: 2 }));
  });
  assert.equal(await run(["--judge"]), 0);
  assert.equal(requests.length, 1);
  failImmediately = false;
  assert.equal(await run(["--judge"]), 1);
  assert.equal(requests.length, 4);
});

test("invalid thresholds and unknown providers remain configuration errors", async t => {
  judgeEnvironment(t);
  for (const threshold of ["-1", "6", "2.5", "banana"]) {
    process.env.EVAL_MIN_SCORE = threshold;
    await assert.rejects(run(["--judge"]));
  }
  process.env.EVAL_MIN_SCORE = "0";
  process.env.EVAL_PROVIDER = "typo";
  await assert.rejects(run(["--judge"]), /Unsupported EVAL_PROVIDER/);
});

test("eval rejects unknown options and judge/update together before any work", async () => {
  await assert.rejects(run(["--judge", "--update"]), /Usage/);
  await assert.rejects(run(["--typo"]), /Usage/);
});
