import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReleaseNoteTemplate } from "../src/generator.js";

test("loads a custom release-note template", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-release-notes-template-"));
  const templatePath = join(directory, "release-note.html");
  const template = "<main class=\"container\">{{content}}</main>";

  try {
    await writeFile(templatePath, template, "utf-8");
    assert.equal(await loadReleaseNoteTemplate(templatePath), template);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("reports a missing custom release-note template", async () => {
  const templatePath = join(
    tmpdir(),
    `missing-ai-release-notes-template-${Date.now()}.html`
  );

  await assert.rejects(
    loadReleaseNoteTemplate(templatePath),
    new RegExp(`Release note template not found: ${templatePath}`)
  );
});
