import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReleaseNoteTemplate, stripEnclosingCodeFence } from "../src/generator.js";
import { renderReleaseNoteHtml } from "../src/release.js";

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

const releaseNote = [
  "# 🌿 Enviro · Release v1.28.0",
  "",
  "_qua · July 25, 2026 · Changes since v1.21.0_",
  "",
  "---",
  "",
  "Streamlined assessment workflows.",
  "",
  "### 🚀 New Features",
  "",
  "- Added a thing.",
].join("\n");

test("unwraps a release note the model returned inside a code fence", () => {
  for (const fence of ["```markdown", "```md", "```", "~~~markdown", "````"]) {
    const closing = fence.startsWith("~") ? "~~~" : "`".repeat(Math.max(3, fence.replace(/[^`]/g, "").length));
    assert.equal(
      stripEnclosingCodeFence(`${fence}\n${releaseNote}\n${closing}`),
      releaseNote,
      `failed to unwrap ${fence}`
    );
  }
});

test("unwraps a doubly fenced release note", () => {
  assert.equal(
    stripEnclosingCodeFence("```\n```markdown\n" + releaseNote + "\n```\n```"),
    releaseNote
  );
});

test("leaves an unfenced release note untouched", () => {
  assert.equal(stripEnclosingCodeFence(releaseNote), releaseNote);
  assert.equal(stripEnclosingCodeFence(`\n\n${releaseNote}\n\n`), releaseNote);
});

test("keeps a code fence that does not enclose the whole release note", () => {
  const withInnerFence = `${releaseNote}\n\n\`\`\`\nnpm install\n\`\`\`\n\n### 🐛 Bug Fixes\n\n- Fixed a thing.`;
  assert.equal(stripEnclosingCodeFence(withInnerFence), withInnerFence);

  const unterminated = "```markdown\n" + releaseNote;
  assert.equal(stripEnclosingCodeFence(unterminated), unterminated);
});

test("renders an unwrapped release note as HTML rather than one code block", () => {
  const params = {
    fromVersion: "v1.21.0",
    toVersion: "v1.28.0",
    environment: "QUA",
    date: "July 25, 2026",
  };
  const fenced = "```markdown\n" + releaseNote + "\n```";

  assert.match(renderReleaseNoteHtml("<main>{{content}}</main>", fenced, params), /<pre><code>/);

  const html = renderReleaseNoteHtml(
    "<main>{{content}}</main>",
    stripEnclosingCodeFence(fenced),
    params
  );
  assert.doesNotMatch(html, /<pre><code>/);
  assert.match(html, /<h1>🌿 Enviro · Release v1\.28\.0<\/h1>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<h3>🚀 New Features<\/h3>/);
  assert.match(html, /<li>Added a thing\.<\/li>|<li>Added a thing\./);
});
