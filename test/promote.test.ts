import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverReleases, formatOutputPath } from "../src/output-path.js";
import {
  extractReleaseContent,
  mergeReleaseDocuments,
  parseReleaseDocument,
  serializeReleaseDocument,
} from "../src/release-document.js";
import { planPromotion, promote, PromotionError } from "../src/promote.js";
import { updateOutputIndexes } from "../src/output-index.js";
import { loadReleaseNoteTemplate } from "../src/generator.js";
import { renderReleaseNoteHtml } from "../src/release.js";

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ai-release-promote-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeRelease(path: string, content: string, modifiedAt?: Date): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf-8");
  if (modifiedAt) await utimes(path, modifiedAt, modifiedAt);
}

async function writeConfig(directory: string, output: string): Promise<string> {
  const path = join(directory, ".ai-release-notes.yml");
  await writeFile(path, [
    "projectName: Test Platform",
    "provider: openai",
    "providers:",
    "  openai:",
    "    model: gpt-4o",
    output,
  ].join("\n"), "utf-8");
  return path;
}

function release(fromVersion: string, toVersion: string, modifiedAt = 0) {
  return { path: `${fromVersion}_${toVersion}`, fromVersion, toVersion, modifiedAt };
}

// ─────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────

test("finds the releases an environment already holds", async () => {
  await withDirectory(async (directory) => {
    const saveTo = join(directory, "{env}", "release-notes_{from}_{to}.html");
    await writeRelease(join(directory, "QUA", "release-notes_start_v0.23.0.html"), "one");
    await writeRelease(join(directory, "QUA", "release-notes_v0.23.0_v0.24.0.html"), "two");
    await writeRelease(join(directory, "PROD", "release-notes_start_v0.23.0.html"), "promoted");

    const discovered = await discoverReleases(saveTo, { environment: "qua" });

    assert.deepEqual(
      discovered.map(({ fromVersion, toVersion }) => `${fromVersion} → ${toVersion}`),
      ["start → v0.23.0", "v0.23.0 → v0.24.0"]
    );
  });
});

test("reads the environment and language a path carries", async () => {
  await withDirectory(async (directory) => {
    const saveTo = join(directory, "{env}", "{lang}", "notes_{from}_{to}.md");
    await writeRelease(join(directory, "QUA", "en", "notes_v1.0.0_v1.1.0.md"), "english");
    await writeRelease(join(directory, "QUA", "fr", "notes_v1.0.0_v1.1.0.md"), "french");

    const discovered = await discoverReleases(saveTo, { environment: "QUA" });

    assert.deepEqual(discovered.map(({ language }) => language), ["en", "fr"]);
    assert.deepEqual([...new Set(discovered.map(({ environment }) => environment))], [undefined]);
  });
});

test("finds nothing when every release shares one file", async () => {
  await withDirectory(async (directory) => {
    const saveTo = join(directory, "CHANGELOG_{env}.md");
    await writeRelease(join(directory, "CHANGELOG_QUA.md"), "everything");

    assert.deepEqual(await discoverReleases(saveTo, { environment: "QUA" }), []);
  });
});

test("keeps a version that looks like an environment out of the environment slot", () => {
  assert.equal(
    formatOutputPath("./notes_{env}_{from}_{to}.md", {
      environment: "pre-prod",
      fromVersion: "v1.0.0",
      toVersion: "v1.1.0",
    }),
    "./notes_PRE_PROD_v1.0.0_v1.1.0.md"
  );
});

// ─────────────────────────────────────────
// Planning
// ─────────────────────────────────────────

test("promotes one release from a single file", () => {
  const plan = planPromotion({
    available: [release("start", "v0.23.0")],
    fromVersion: "start",
    toVersion: "v0.23.0",
  });

  assert.equal(plan.segments.length, 1);
  assert.deepEqual(plan.segments[0].releases.map(({ path }) => path), ["start_v0.23.0"]);
});

test("chains releases in release order, not version order", () => {
  const plan = planPromotion({
    available: [
      release("v0.1.0", "v0.1.2"),
      release("v0.23.0", "v0.1.0"),
      release("start", "v0.23.0"),
    ],
    fromVersion: "v0.23.0",
    toVersion: "v0.1.2",
  });

  assert.deepEqual(
    plan.segments.map(({ fromVersion, toVersion }) => `${fromVersion} → ${toVersion}`),
    ["v0.23.0 → v0.1.0", "v0.1.0 → v0.1.2"]
  );
});

test("promotes the whole chain when no range is asked for", () => {
  const plan = planPromotion({
    available: [
      release("v1.1.0", "v1.2.0"),
      release("start", "v1.1.0"),
    ],
  });

  assert.equal(plan.fromVersion, "start");
  assert.equal(plan.toVersion, "v1.2.0");
  assert.equal(plan.segments.length, 2);
});

test("starts where the target environment already is", () => {
  const plan = planPromotion({
    available: [
      release("start", "v1.1.0"),
      release("v1.1.0", "v1.2.0"),
    ],
    promotedVersion: "v1.1.0",
  });

  assert.equal(plan.fromVersion, "v1.1.0");
  assert.deepEqual(plan.segments.map(({ toVersion }) => toVersion), ["v1.2.0"]);
});

test("has nothing to promote when both environments are level", () => {
  const plan = planPromotion({
    available: [release("start", "v1.1.0")],
    promotedVersion: "v1.1.0",
  });

  assert.equal(plan.segments.length, 0);
});

test("reports the releases available when the chain has a hole", () => {
  assert.throws(
    () => planPromotion({
      available: [release("start", "v1.0.0"), release("v1.5.0", "v2.0.0")],
      fromVersion: "start",
      toVersion: "v2.0.0",
    }),
    (error: unknown) => error instanceof PromotionError && /start → v1\.0\.0/.test(error.message)
  );
});

test("chains files that name only the version they end at", () => {
  const plan = planPromotion({
    available: [
      { path: "b", toVersion: "v1.2.0", modifiedAt: 2 },
      { path: "a", toVersion: "v1.1.0", modifiedAt: 1 },
    ],
  });

  assert.equal(plan.fromVersion, "start");
  assert.deepEqual(
    plan.segments.map(({ fromVersion, toVersion }) => `${fromVersion} → ${toVersion}`),
    ["start → v1.1.0", "v1.1.0 → v1.2.0"]
  );
});

// ─────────────────────────────────────────
// Merging
// ─────────────────────────────────────────

const firstNote = `# Release v0.1.0

A first summary paragraph.

## New features

- Added a dashboard.
- Added filters.

## Fixes

- Fixed the login button.`;

const secondNote = `# Release v0.1.2

A second summary paragraph.

## New features

- Added export to CSV.
- Added filters.

## Known issues

- Export is slow on large accounts.`;

test("merges sections carrying the same heading", () => {
  const merged = mergeReleaseDocuments([firstNote, secondNote], "markdown");

  assert.equal(merged.match(/## New features/g)?.length, 1);
  assert.match(merged, /- Added a dashboard\./);
  assert.match(merged, /- Added export to CSV\./);
  assert.match(merged, /## Known issues/);
  // A line both releases carry is listed once.
  assert.equal(merged.match(/- Added filters\./g)?.length, 1);
});

test("names a merged release after the newest one in it", () => {
  const merged = mergeReleaseDocuments([firstNote, secondNote], "markdown");

  assert.match(merged, /^# Release v0\.1\.2/);
  assert.doesNotMatch(merged, /# Release v0\.1\.0/);
  // Both summaries are kept: neither was written by this tool.
  assert.match(merged, /A first summary paragraph\./);
  assert.match(merged, /A second summary paragraph\./);
});

test("keeps a single release exactly as it was written", () => {
  assert.equal(mergeReleaseDocuments([firstNote], "markdown"), firstNote);
});

test("keeps the order sections were released in", () => {
  const merged = mergeReleaseDocuments([firstNote, secondNote], "markdown");

  assert.ok(merged.indexOf("## New features") < merged.indexOf("## Fixes"));
  assert.ok(merged.indexOf("## Fixes") < merged.indexOf("## Known issues"));
});

test("merges lists inside an HTML release note", () => {
  const merged = mergeReleaseDocuments([
    "<h1>Release v1</h1>\n<h2>New features</h2>\n<ul>\n<li>Added a dashboard.\n</li>\n</ul>",
    "<h1>Release v2</h1>\n<h2>New features</h2>\n<ul>\n<li>Added a dashboard.\n</li>\n<li>Added export.\n</li>\n</ul>",
  ], "html");

  assert.equal(merged.match(/<h2>New features<\/h2>/g)?.length, 1);
  assert.equal(merged.match(/<ul>/g)?.length, 1);
  assert.equal(merged.match(/Added a dashboard\./g)?.length, 1);
  assert.match(merged, /Added export\./);
  assert.match(merged, /<h1>Release v2<\/h1>/);
});

test("reads a release note back through its own headings", () => {
  const document = parseReleaseDocument(firstNote, "markdown");

  assert.equal(document.children.length, 1);
  assert.equal(document.children[0].heading, "Release v0.1.0");
  assert.deepEqual(
    document.children[0].children.map(({ heading }) => heading),
    ["New features", "Fixes"]
  );
  assert.equal(serializeReleaseDocument(document, "markdown"), firstNote);
});

// ─────────────────────────────────────────
// Reading a note back off a page
// ─────────────────────────────────────────

test("reads a release note out of the page it was written into", async () => {
  const template = await loadReleaseNoteTemplate();
  const page = renderReleaseNoteHtml(template, firstNote, {
    fromVersion: "start",
    toVersion: "v0.1.0",
    environment: "QUA",
    date: "July 21, 2026",
  });

  const content = extractReleaseContent(page, template);

  assert.match(content || "", /<h1>Release v0\.1\.0<\/h1>/);
  assert.doesNotMatch(content || "", /<footer>/);
  assert.doesNotMatch(content || "", /<!DOCTYPE/i);
});

test("reads a note off a page whose template is not at hand", () => {
  const page = "<html><body><main>\n<h1>Release v1</h1>\n</main>\n<footer>tool</footer></body></html>";

  assert.equal(extractReleaseContent(page), "<h1>Release v1</h1>");
});

test("reads a note out of a template of your own", () => {
  const template = "<div class=\"page\">\n<section id=\"notes\">\n{{content}}\n</section>\n<p>{{date}}</p>\n</div>";
  const page = "<div class=\"page\">\n<section id=\"notes\">\n<h1>Release v1</h1>\n</section>\n<p>July 26, 2026</p>\n</div>";

  assert.equal(extractReleaseContent(page, template), "<h1>Release v1</h1>");
});

test("declines to guess when a page carries no landmark", () => {
  assert.equal(extractReleaseContent("<div>Release v1</div>"), undefined);
});

// ─────────────────────────────────────────
// Promoting end to end
// ─────────────────────────────────────────

test("promotes one release without touching a model", async () => {
  await withDirectory(async (directory) => {
    const saveTo = join(directory, "{env}", "release-notes_{from}_{to}.html");
    const configPath = await writeConfig(directory, `output:\n  - format: html\n    saveTo: ${saveTo}`);
    const template = await loadReleaseNoteTemplate();
    await writeRelease(
      join(directory, "QUA", "release-notes_start_v0.23.0.html"),
      renderReleaseNoteHtml(template, firstNote, {
        fromVersion: "start",
        toVersion: "v0.23.0",
        environment: "QUA",
        date: "July 21, 2026",
      })
    );

    const result = await promote({
      fromEnvironment: "QUA",
      toEnvironment: "PROD",
      configPath,
      date: "July 26, 2026",
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, join(directory, "PROD", "release-notes_start_v0.23.0.html"));
    // The words are the ones QUA was given; only the page around them is new.
    assert.match(result.files[0].content, /<h1>Release v0\.1\.0<\/h1>/);
    assert.match(result.files[0].content, /Fixed the login button\./);
    assert.equal(result.metadata.fromVersion, "start");
    assert.equal(result.metadata.toVersion, "v0.23.0");
  });
});

test("merges the releases a lagging environment missed", async () => {
  await withDirectory(async (directory) => {
    const saveTo = join(directory, "{env}", "notes_{from}_{to}.md");
    const configPath = await writeConfig(directory, `output:\n  - format: markdown\n    saveTo: ${saveTo}`);
    await writeRelease(join(directory, "QUA", "notes_start_v0.1.0.md"), firstNote);
    await writeRelease(join(directory, "QUA", "notes_v0.1.0_v0.1.2.md"), secondNote);
    await writeRelease(join(directory, "PROD", "notes_start_v0.1.0.md"), firstNote);

    const result = await promote({
      fromEnvironment: "QUA",
      toEnvironment: "PROD",
      configPath,
    });

    assert.equal(result.metadata.fromVersion, "v0.1.0");
    assert.equal(result.metadata.toVersion, "v0.1.2");
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, join(directory, "PROD", "notes_v0.1.0_v0.1.2.md"));
    assert.equal(result.files[0].content, secondNote);
  });
});

test("promotes each language it finds", async () => {
  await withDirectory(async (directory) => {
    const saveTo = join(directory, "{env}", "{lang}", "notes_{from}_{to}.md");
    const configPath = await writeConfig(directory, `output:\n  - format: markdown\n    saveTo: ${saveTo}`);
    await writeRelease(join(directory, "QUA", "en", "notes_start_v1.0.0.md"), firstNote);
    await writeRelease(join(directory, "QUA", "fr", "notes_start_v1.0.0.md"), "# Version v1.0.0");

    const result = await promote({ fromEnvironment: "QUA", toEnvironment: "PROD", configPath });

    assert.deepEqual(result.files.map(({ language }) => language), ["en", "fr"]);
    assert.deepEqual(result.files.map(({ path }) => path), [
      join(directory, "PROD", "en", "notes_start_v1.0.0.md"),
      join(directory, "PROD", "fr", "notes_start_v1.0.0.md"),
    ]);
  });
});

test("lists a promoted release in the target environment's index", async () => {
  await withDirectory(async (directory) => {
    const saveTo = join(directory, "{env}", "notes_{from}_{to}.md");
    const configPath = await writeConfig(directory, `output:\n  - format: markdown\n    saveTo: ${saveTo}`);
    await writeRelease(join(directory, "QUA", "notes_start_v1.0.0.md"), firstNote);

    const result = await promote({ fromEnvironment: "QUA", toEnvironment: "PROD", configPath });
    const updated: string[] = [];
    await updateOutputIndexes({
      outputIndexes: [{ format: "markdown", saveTo: join(directory, "{env}", "INDEX.md") }],
      releases: result.files,
      environment: "PROD",
      fromVersion: result.metadata.fromVersion,
      toVersion: result.metadata.toVersion,
      date: result.metadata.date,
      languages: ["en"],
      primaryLanguage: "en",
      onUpdated: (path) => updated.push(path),
    });

    assert.deepEqual(updated, [join(directory, "PROD", "INDEX.md")]);
    const index = await readFile(join(directory, "PROD", "INDEX.md"), "utf-8");
    assert.match(index, /"environment":"PROD"/);
    assert.match(index, /"toVersion":"v1\.0\.0"/);
    assert.match(index, /\(notes_start_v1\.0\.0\.md\)/);
  });
});

test("refuses to promote an environment onto itself", async () => {
  await withDirectory(async (directory) => {
    const saveTo = join(directory, "notes_{from}_{to}.md");
    const configPath = await writeConfig(directory, `output:\n  - format: markdown\n    saveTo: ${saveTo}`);
    await writeRelease(join(directory, "notes_start_v1.0.0.md"), firstNote);

    await assert.rejects(
      promote({ fromEnvironment: "QUA", toEnvironment: "PROD", configPath }),
      (error: unknown) => error instanceof PromotionError && /same path/.test(error.message)
    );
  });
});
