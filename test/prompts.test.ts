import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt, buildTranslationSystemPrompt } from "../src/prompts/builder.js";

test("adds project instructions to the main generation prompt", async () => {
  const prompt = await buildSystemPrompt({
    languages: ["en"],
    instructions: "Keep ENVIRO exactly as written.",
  });

  assert.match(prompt, /Keep ENVIRO exactly as written\./);
  assert.doesNotMatch(prompt, /Never create fake features/);
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
