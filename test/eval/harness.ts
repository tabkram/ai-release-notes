import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { generate, GenerationError, loadReleaseNoteTemplate, stripEnclosingCodeFence } from "../../src/generator.js";
import { callLLM } from "../../src/llm.js";
import { resolveProviderAlias } from "../../src/config.js";
import { renderReleaseNoteHtml } from "../../src/release.js";
import { changedLines } from "../../src/text-diff.js";
import * as prompts from "../../src/prompts/builder.js";
import type { ProviderConfig, ProviderName } from "../../src/types.js";

export const fixtureRoot = resolve(__dirname, "../fixtures/eval");
const fixtureSchema = z.object({
  projectName: z.string().min(1), fromVersion: z.string(), toVersion: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), environment: z.string(),
  source: z.object({ repository: z.string().url(), fromSha: z.string().regex(/^[a-f0-9]{40}$/),
    toSha: z.string().regex(/^[a-f0-9]{40}$/) }),
  commits: z.array(z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/), subject: z.string().min(1) })).min(1).max(200),
});
export type Fixture = z.infer<typeof fixtureSchema>;
const score = z.number().int().min(1).max(5);
export const verdictSchema = z.object({
  readability: score, categorization: score, jargon: score, identifiers: score,
  faithfulness: score, reason: z.string().trim().min(1),
}).strict();
export type Verdict = z.infer<typeof verdictSchema>;
export const criteria = ["readability", "categorization", "jargon", "identifiers", "faithfulness"] as const;
export function passes(verdict: Verdict): boolean {
  return criteria.every(key => verdict[key] >= 4);
}

class JudgeUnavailable extends Error {}
function warning(message: string): void {
  const escaped = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.warn(process.env.GITHUB_ACTIONS === "true" ? `::warning::${escaped}` : `WARNING: ${message}`);
}
export function minimumScore(): number {
  return z.coerce.number().int().min(0).max(5).parse(process.env.EVAL_MIN_SCORE || "0");
}

export async function fixtures(): Promise<Array<{ name: string; directory: string; input: Fixture }>> {
  const entries = await readdir(fixtureRoot, { withFileTypes: true });
  const result = [];
  for (const entry of entries.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = join(fixtureRoot, entry.name);
    result.push({ name: entry.name, directory,
      input: fixtureSchema.parse(JSON.parse(await readFile(join(directory, "input.json"), "utf8"))) });
  }
  if (!result.length) throw new Error("No eval fixtures found");
  return result;
}

// Use the actual generator's dry-run path. Explicit config and dates prevent
// local config, Git tags, the clock, or the response cache affecting a fixture.
async function runGeneration(input: Fixture, dryRun: boolean, provider: ProviderName, config: ProviderConfig) {
  const directory = await mkdtemp(join(tmpdir(), "release-eval-"));
  try {
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({ projectName: input.projectName, provider,
      providers: { [provider]: config }, prompt: { languages: ["en"] }, cache: { enabled: false } }));
    return await generate({ configPath, fromVersion: input.fromVersion, toVersion: input.toVersion,
      environment: input.environment, date: input.date, changelog: input.commits.map(c => c.subject).join("\n"),
      dryRun, persist: false, cache: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function fixtureSnapshot(input: Fixture, directory: string): Promise<string> {
  const result = await runGeneration(input, true, "openai", {});
  const recorded = await readFile(join(directory, "recorded.md"), "utf8");
  const template = (await loadReleaseNoteTemplate()).replaceAll("{{version}}", "[package version]");
  const html = renderReleaseNoteHtml(template, stripEnclosingCodeFence(recorded), {
    ...input, date: result.metadata.date,
  });
  return JSON.stringify({ prompt: result.markdown, html }, null, 2) + "\n";
}

// Generation snapshots cover system/instructions/scope. These cover the other
// shipped prompt files through their real builders, including every session role.
export async function supplementalSnapshot(): Promise<string> {
  const builders = {
    translation: () => prompts.buildTranslationSystemPrompt("fr"),
    promotion: () => prompts.buildPromoteOpeningSystemPrompt(),
    router: prompts.buildSessionRouterSystemPrompt, answer: prompts.buildSessionAnswerSystemPrompt,
    merge: prompts.buildSessionMergeSystemPrompt, edit: prompts.buildEditSystemPrompt,
    index: prompts.buildIndexEditSystemPrompt,
  };
  const result: Record<string, string> = {};
  for (const [name, build] of Object.entries(builders)) result[name] = await build();
  return JSON.stringify(result, null, 2) + "\n";
}

async function snapshot(path: string, actual: string, update: boolean): Promise<string | undefined> {
  if (update) {
    await writeFile(path, actual);
    return;
  }
  let expected: string;
  try { expected = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return `Missing snapshot: ${path}. Review and run npm run eval -- --update.`;
  }
  if (actual === expected) return;
  // Expand JSON strings so a prompt edit produces a readable line diff.
  const diff = changedLines(expected.replace(/\\n/g, "\n"), actual.replace(/\\n/g, "\n"));
  return `${path}\n${diff.slice(0, 40).map(line => `${line.kind === "added" ? "+" : "-"} ${line.text}`).join("\n")}` +
    (diff.length > 40 ? "\n… diff truncated" : "");
}

export function judgeConfig(): { provider: ProviderName; config: ProviderConfig } {
  const provider = resolveProviderAlias(process.env.EVAL_PROVIDER || "mistral");
  const keyNames: Record<ProviderName, string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY",
    mistral: "MISTRAL_API_KEY", google: "GOOGLE_API_KEY", "azure-openai": "AZURE_OPENAI_API_KEY", ollama: "OLLAMA_API_KEY" };
  if (!Object.hasOwn(keyNames, provider)) throw new Error(`Unsupported EVAL_PROVIDER: ${provider}`);
  if (provider === "azure-openai" && !process.env.AZURE_OPENAI_ENDPOINT) {
    throw new JudgeUnavailable("--judge with azure requires AZURE_OPENAI_ENDPOINT. No quality assessment was made.");
  }
  if (provider !== "ollama" && !process.env[keyNames[provider]]) {
    throw new JudgeUnavailable(`--judge requires ${keyNames[provider]} (EVAL_PROVIDER=${provider}). No quality assessment was made.`);
  }
  return { provider, config: { model: process.env.EVAL_MODEL,
    baseURL: provider === "azure-openai" ? process.env.AZURE_OPENAI_ENDPOINT : undefined, temperature: 0, maxTokens: 4000,
    maxRetries: 0, promptCache: { enabled: false } } };
}

export async function judgeFixture(input: Fixture, provider: ProviderName, config: ProviderConfig): Promise<Verdict> {
  const rubric = await readFile(join(__dirname, "rubric.md"), "utf8");
  let result;
  try { result = await runGeneration(input, false, provider, config); }
  catch (error) {
    if (!(error instanceof GenerationError)) throw error;
    throw new JudgeUnavailable(error.message);
  }
  if (!result.markdown.trim()) throw new JudgeUnavailable("Generation returned an empty release note");
  let response;
  try {
    response = await callLLM(provider, config, rubric, JSON.stringify({ source: input, candidate: result.markdown }));
  } catch (error) { throw new JudgeUnavailable(error instanceof Error ? error.message : String(error)); }
  if (response.finishReason !== "stop") throw new JudgeUnavailable("Judge response did not complete");
  try { return verdictSchema.parse(JSON.parse(stripEnclosingCodeFence(response.text))); }
  catch { throw new JudgeUnavailable("Judge returned invalid scoring JSON"); }
}

export async function run(args: string[]): Promise<number> {
  if (args.some(arg => !["--judge", "--update"].includes(arg)) || (args.includes("--judge") && args.includes("--update"))) {
    throw new Error("Usage: npm run eval [-- --judge | -- --update]");
  }
  const judging = args.includes("--judge"), update = args.includes("--update");
  const cases = await fixtures();
  const threshold = judging ? minimumScore() : 0;
  let selected: ReturnType<typeof judgeConfig> | undefined;
  if (judging) {
    console.log(`AI failure threshold: ${threshold}/5 (scores below 4 otherwise produce warnings).`);
    try { selected = judgeConfig(); }
    catch (error) {
      if (!(error instanceof JudgeUnavailable)) throw error;
      warning(error.message);
      console.table(cases.map(({ name }) => ({ fixture: name, result: "SKIP" })));
      return 0;
    }
  }
  const originalFetch = globalThis.fetch;
  // A new accidental model call in snapshot mode must fail, even on a machine
  // with real keys set. This guard applies to --update as well.
  globalThis.fetch = judging ? (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return originalFetch(input, { ...init,
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) });
  } : async () => { throw new Error("Network is forbidden in snapshot mode"); };
  let failures = 0;
  let unavailable = false;
  const rows: Array<Record<string, string | number>> = [];
  try {
    if (!judging) {
      const drift = await snapshot(join(fixtureRoot, "supplemental.snap.json"), await supplementalSnapshot(), update);
      rows.push({ fixture: "shared prompts", result: drift ? "FAIL" : update ? "UPDATED" : "PASS" });
      if (drift) { failures++; console.error(drift); }
    }
    for (const { name, directory, input } of cases) {
      if (unavailable) { rows.push({ fixture: name, result: "SKIP" }); continue; }
      try {
        if (selected) {
          const verdict = await judgeFixture(input, selected.provider, selected.config);
          const failed = criteria.some(key => verdict[key] < threshold);
          rows.push({ fixture: name, result: failed ? "FAIL" : passes(verdict) ? "PASS" : "WARN",
            ...Object.fromEntries(criteria.map(key => [key, verdict[key]])) });
          console.log(`${name}: ${verdict.reason}`);
          if (failed) failures++;
          else if (!passes(verdict)) warning(`${name}: quality scores below 4; failure threshold is ${threshold}.`);
        } else {
          const drift = await snapshot(join(directory, "expected.snap.json"), await fixtureSnapshot(input, directory), update);
          rows.push({ fixture: name, result: drift ? "FAIL" : update ? "UPDATED" : "PASS" });
          if (drift) { failures++; console.error(drift); }
        }
      } catch (error) {
        if (judging && error instanceof JudgeUnavailable) {
          unavailable = true;
          rows.push({ fixture: name, result: "WARN" });
          warning(`${name}: AI evaluation unavailable: ${error.message}. Remaining fixtures skipped; quality assessment is incomplete.`);
          continue;
        }
        failures++;
        rows.push({ fixture: name, result: "ERROR" });
        console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.table(rows);
    return failures ? 1 : 0;
  } finally {
    globalThis.fetch = originalFetch;
  }
}
