import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSystemPrompt,
  buildTranslationSystemPrompt,
  buildUserPrompt,
  resolveInstructions,
} from "../src/prompts/builder.js";
import type { ParsedCommit } from "../src/types.js";

async function writeTempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ai-release-notes-"));
  const path = join(dir, name);
  await writeFile(path, content, "utf-8");
  return path;
}

const commits: ParsedCommit[] = [
  {
    hash: "abc1234",
    type: "feat",
    scope: "dashboard",
    message: "add release filters",
    author: "Dev",
    date: "2026-06-03",
  },
];

test("uses the built-in instructions when a project supplies none", async () => {
  const prompt = await buildSystemPrompt({ languages: ["en"] });

  assert.match(prompt, /Write the title block exactly once/);
});

test("replaces the built-in instructions with the project ones", async () => {
  const prompt = await buildSystemPrompt({
    languages: ["en"],
    instructions: "Keep ENVIRO exactly as written.",
  });

  assert.match(prompt, /Keep ENVIRO exactly as written\./);
  assert.doesNotMatch(prompt, /Write the title block exactly once/);
});

test("asks for an unwrapped answer even when a project's instructions are silent about format", async () => {
  const instructions = "Keep ENVIRO exactly as written.";

  const generation = await buildSystemPrompt({ languages: ["en"], instructions });
  const translation = await buildTranslationSystemPrompt("fr", instructions);

  // The prompt files are hard-wrapped at different points, so compare on text
  // with its line breaks collapsed rather than on the wrapping of the day.
  const flatten = (value: string) => value.replace(/\s+/g, " ");

  for (const prompt of [generation, translation].map(flatten)) {
    assert.match(prompt, /Never wrap it in a code fence/);
    // The rule closes the prompt, so project instructions cannot displace it.
    assert.ok(prompt.indexOf("Never wrap it in a code fence") > prompt.indexOf(instructions));
  }
});

test("reads instructions and system prompt from files", async () => {
  const instructionsFile = await writeTempFile("rules.md", "Mention the migration guide.");
  const systemFile = await writeTempFile("system.md", "You write terse notes.");

  const prompt = await buildSystemPrompt({
    languages: ["en"],
    system: { file: systemFile },
    instructions: { file: instructionsFile },
  });

  assert.match(prompt, /You write terse notes\./);
  assert.match(prompt, /Mention the migration guide\./);
});

test("applies the same instructions to generation and translation", async () => {
  const instructionsFile = await writeTempFile(
    "rules.md",
    "Group bullets by domain. Keep product names in English."
  );
  const instructions = { file: instructionsFile };

  const systemPrompt = await buildSystemPrompt({ languages: ["en", "fr"], instructions });
  const translationPrompt = await buildTranslationSystemPrompt(
    "fr",
    await resolveInstructions(instructions)
  );

  assert.match(systemPrompt, /Keep product names in English\./);
  assert.match(translationPrompt, /Keep product names in English\./);
});

test("keeps translation distinct from content rewriting", async () => {
  const prompt = await buildTranslationSystemPrompt(
    "fr",
    "Preserve ENVIRO as written. Regroup redundant information."
  );

  assert.match(prompt, /Do not regenerate the\s+notes from the changelog\./);
  assert.match(prompt, /do not do that during translation/i);
  assert.match(prompt, /protected vocabulary/i);
  assert.match(prompt, /Preserve ENVIRO as written/);
});

test("supplies the release metadata the instructions can compose a title with", () => {
  const prompt = buildUserPrompt({
    projectName: "ACME Platform",
    fromVersion: "v1.0.0",
    toVersion: "v1.1.0",
    environment: "prod",
    date: "June 03, 2026",
    commits,
  });

  assert.match(prompt, /Project: ACME Platform/);
  assert.match(prompt, /Previous version: v1\.0\.0/);
  assert.match(prompt, /- feat: \[dashboard\] add release filters/);
});

test("describes a first release instead of naming the start sentinel", () => {
  const prompt = buildUserPrompt({
    projectName: "ACME Platform",
    fromVersion: "start",
    toVersion: "v1.1.0",
    environment: "prod",
    date: "June 03, 2026",
    commits,
  });

  assert.doesNotMatch(prompt, /Previous version: start/);
  assert.match(prompt, /Previous version: none — this is the first release/);
});

test("leaves the start sentinel untouched in a custom user prompt template", () => {
  const prompt = buildUserPrompt({
    fromVersion: "start",
    toVersion: "v1.1.0",
    environment: "prod",
    date: "June 03, 2026",
    commits,
    template: "{{fromVersion}} → {{toVersion}}",
  });

  assert.match(prompt, /^start → v1\.1\.0$/m);
});

test("fills a custom user prompt template", () => {
  const prompt = buildUserPrompt({
    projectName: "ACME Platform",
    fromVersion: "v1.0.0",
    toVersion: "v1.1.0",
    environment: "prod",
    date: "June 03, 2026",
    language: "fr",
    commits,
    template: "{{projectName}} {{toVersion}} ({{language}}, {{commitCount}} commits)\n{{changelog}}\n{{unknown}}",
  });

  assert.match(prompt, /^ACME Platform v1\.1\.0 \(fr, 1 commits\)$/m);
  assert.match(prompt, /- feat: \[dashboard\] add release filters/);
  // An unknown placeholder stays visible instead of silently emptying the prompt.
  assert.match(prompt, /\{\{unknown\}\}/);
});
