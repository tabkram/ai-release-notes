import assert from "node:assert/strict";
import test, { before } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exec = promisify(execFile);
const cli = resolve(__dirname, "../dist/bin/cli.js");

// Exercise the shipped executable; tsx can misresolve its ESM-only dependencies.
before(() => exec("npm", ["run", "build"], { cwd: resolve(__dirname, "..") }));

test("CLI cache flags force requests, preserve configuration defaults, and clear cached responses", async t => {
  const directory = await mkdtemp(join(tmpdir(), "release-cache-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = join(directory, "mock.cjs");
  const log = join(directory, "requests.jsonl");
  const config = join(directory, "config.yml");
  const changelog = join(directory, "changelog.txt");
  await writeFile(config, "provider: mistral\nproviders:\n  mistral: {}\ncache:\n  ttl: 30d\n");
  await writeFile(changelog, "feat: useful change");
  await writeFile(preload, `
    const fs = require('node:fs');
    globalThis.fetch = async (_url, init) => {
      fs.appendFileSync(${JSON.stringify(log)}, init.body + '\\n');
      return new Response(JSON.stringify({
        id:'test', object:'chat.completion', created:0, model:'mistral-large-latest',
        choices:[{index:0,message:{role:'assistant',content:'# Release\\n\\nA useful change.'},finish_reason:'stop'}],
        usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}
      }), {headers:{'content-type':'application/json'}});
    };
  `);
  const run = (...args: string[]) => exec(process.execPath, ["--require", preload, cli, ...args], {
    cwd: directory, env: { ...process.env, MISTRAL_API_KEY: "test-key" },
  });
  const generate = (...args: string[]) => run("generate", "--from", "v1", "--to", "v2", "--env", "PROD", "--date", "2026-11-14",
    "--config", config, "--changelog-file", changelog, "--stdout", ...args);
  const first = await generate();
  const repeated = await generate();
  assert.equal(repeated.stdout, first.stdout);
  assert.match(repeated.stderr, /Local cache: 1 response/);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);

  await generate("--no-cache", "--no-provider-cache", "--cache-ttl", "7d");
  const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(requests.length, 2);
  assert.ok(requests[0].prompt_cache_key);
  assert.equal(requests[1].prompt_cache_key, undefined);
  await generate();
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2);

  await assert.rejects(generate("--cache-ttl", "-1d"), /positive duration/);
  await assert.rejects(generate("--provider-cache-ttl", "1h"), /Mistral does not expose/);
  await run("cache", "clear");
  await generate();
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 3);

  await writeFile(config, "provider: mistral\nproviders:\n  mistral: {}\ncache:\n  enabled: false\n");
  await generate();
  await generate();
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 5);
});

test("CLI force replaces selected documents independently of caching and reports automatic retranslation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "release-force-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.yml"), changelog = join(directory, "changelog.txt");
  const preload = join(directory, "mock.cjs"), log = join(directory, "requests.jsonl");
  await writeFile(config, "provider: mistral\nproviders:\n  mistral:\n    maxRetries: 0\ncache:\n  ttl: 30d\nprompt:\n  languages: [fr, en]\noutput:\n  format: markdown\n  saveTo: './notes/{env}/{lang}/{from}_{to}.md'\n");
  await writeFile(changelog, "feat: useful change");
  await writeFile(preload, `
    const fs = require('node:fs');
    globalThis.fetch = async (_url, init) => {
      fs.appendFileSync(${JSON.stringify(log)}, init.body + '\\n');
      return new Response(JSON.stringify({
        id:'test', object:'chat.completion', created:0, model:'mistral-large-latest',
        choices:[{index:0,message:{role:'assistant',content:'# Release\\n\\nGenerated wording.'},finish_reason:'stop'}],
        usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}
      }), {headers:{'content-type':'application/json'}});
    };
  `);
  const run = (...args: string[]) => exec(process.execPath, ["--require", preload, cli, ...args], {
    cwd: directory, env: { ...process.env, MISTRAL_API_KEY: "test-key" },
  });
  const generate = (...args: string[]) => run("generate", "--from", "v1", "--to", "v2", "--env", "PROD", "--date", "2026-11-16",
    "--config", config, "--changelog-file", changelog, ...args);
  const calls = async () => (await readFile(log, "utf8")).trim().split("\n").length;
  const fr = join(directory, "notes/PROD/fr/v1_v2.md"), en = join(directory, "notes/PROD/en/v1_v2.md");
  const initial = await generate();
  assert.equal(await calls(), 2);
  assert.doesNotMatch(initial.stdout, /automatically retranslated/);

  const reviewedFrench = "# Release\n\nSource française corrigée manuellement.\n";
  await writeFile(fr, reviewedFrench);
  await writeFile(en, "# Release\n\nManually reviewed English wording.\n");
  const translated = await generate();
  assert.equal(await calls(), 3);
  assert.equal(await readFile(fr, "utf8"), reviewedFrench);
  assert.match(await readFile(en, "utf8"), /Generated wording/);
  assert.match(translated.stdout, /en: automatically retranslated because primary language fr changed/);
  assert.match(translated.stdout, /including any manual corrections, was replaced/);

  const reviewedEnglish = "# Release\n\nAnother English correction.\n";
  await writeFile(en, reviewedEnglish);
  const reused = await generate("--no-cache");
  assert.equal(await calls(), 3);
  assert.equal(await readFile(en, "utf8"), reviewedEnglish);
  assert.doesNotMatch(reused.stdout, /automatically retranslated/);

  const forced = await generate("--force", "--lang", "en");
  assert.equal(await calls(), 3, "--force can reuse a cached response");
  assert.match(forced.stdout, /Local cache: 1 response/);
  assert.match(await readFile(en, "utf8"), /Generated wording/);
  assert.equal(await readFile(fr, "utf8"), reviewedFrench);
  await generate("--force", "--lang", "en", "--no-cache");
  assert.equal(await calls(), 4, "--force --no-cache must call the model");

  assert.match((await run("promote", "--help")).stdout, /--force/);
  await assert.rejects(generate("--regenerate"), /unknown option '--regenerate'/);
  await assert.rejects(run("promote", "--from-env", "PROD", "--to-env", "QUA", "--regenerate"), /unknown option '--regenerate'/);
});
