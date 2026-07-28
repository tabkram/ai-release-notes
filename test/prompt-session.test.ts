import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReleaseNoteTemplate } from "../src/generator.js";
import { PromptSession, readSessionAction, type EditModelCall } from "../src/prompt-session.js";
import { dedupeReleaseDocument, replaceReleaseContent } from "../src/release-document.js";
import {
  readOutputIndexReleaseRecords,
  readOutputIndexReleaseMarkers,
  renderReleaseNoteHtml,
  sanitizeReleaseHtml,
  sanitizeReleaseIndexHtml,
} from "../src/release.js";
import { changedLines } from "../src/text-diff.js";

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ai-release-prompt-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeConfig(directory: string, output: string[]): Promise<string> {
  const path = join(directory, ".ai-release-notes.yml");
  await writeFile(path, [
    "projectName: Test Platform",
    "provider: openai",
    "providers:",
    "  openai:",
    "    model: gpt-4o",
    ...output,
  ].join("\n"), "utf-8");
  return path;
}

async function writeRelease(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf-8");
}

/**
 * The material a revision request carries, as the model would read it.
 *
 * A release note and an index's list travel in blocks of their own, so the one
 * a request actually carries is the one read back.
 */
function noteFrom(userPrompt: string): string {
  const block = userPrompt.includes("===== BEGIN RELEASE LIST") ? "RELEASE LIST" : "RELEASE NOTE";
  const opening = userPrompt.indexOf(`===== BEGIN ${block}`);
  const closing = userPrompt.indexOf(`===== END ${block}`);
  return userPrompt.slice(userPrompt.indexOf("\n", opening) + 1, closing).trim();
}

interface FakeModel {
  call: EditModelCall;
  /** The release notes it was asked to revise, in order. */
  revised: string[];
  /** The messages it was asked to place, in order. */
  routed: string[];
  /** Primary-evidence questions, before any large-answer synthesis. */
  answered: string[];
  /** Final answer calls that combine independently grounded findings. */
  synthesized: string[];
  /** Calls that write only the opening of a structurally merged note. */
  merged: string[];
}

/**
 * A model that answers without a provider.
 *
 * Every session role reaches one function. Classifying by the role-specific
 * system contract makes tests fail loudly if planning, answering, synthesis,
 * merge-opening, and editing are accidentally substituted for one another.
 */
function fakeModel(answers: {
  route?: unknown | ((prompt: string, index: number) => unknown);
  answer?: string | ((prompt: string, index: number) => string);
  synthesis?: string | ((prompt: string, index: number) => string);
  merge?: string | ((prompt: string, index: number) => string);
  edit?: (note: string) => string;
}): FakeModel {
  const model: FakeModel = {
    revised: [],
    routed: [],
    answered: [],
    synthesized: [],
    merged: [],
    call: async ({ system, user }) => {
      const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };

      if (system.includes("# Placing a message")) {
        model.routed.push(user);
        const route = typeof answers.route === "function"
          ? answers.route(user, model.routed.length - 1)
          : answers.route;
        return {
          text: typeof route === "string"
            ? route
            : JSON.stringify(route ?? { action: "revise", instruction: "revise it" }),
          usage,
        };
      }

      if (system.includes("# Answering a question")) {
        if (user.includes("===== BEGIN GROUNDED FINDINGS")) {
          model.synthesized.push(user);
          const reply = typeof answers.synthesis === "function"
            ? answers.synthesis(user, model.synthesized.length - 1)
            : answers.synthesis;
          return { text: reply ?? "Synthesized answer.", usage };
        }

        model.answered.push(user);
        const reply = typeof answers.answer === "function"
          ? answers.answer(user, model.answered.length - 1)
          : answers.answer;
        return { text: reply ?? "Grounded answer.", usage };
      }

      if (system.includes("# Writing a merged release opening")) {
        model.merged.push(user);
        const reply = typeof answers.merge === "function"
          ? answers.merge(user, model.merged.length - 1)
          : answers.merge;
        if (reply === undefined) throw new Error("No fake merge opening supplied");
        return { text: reply, usage };
      }

      if (
        !system.includes("# Revising a release note") &&
        !system.includes("# Revising a release index")
      ) {
        throw new Error("Unknown model role in test");
      }
      const note = noteFrom(user);
      model.revised.push(note);
      return { text: answers.edit ? answers.edit(note) : note, usage };
    },
  };
  return model;
}

const NOTE = `# Test Platform · Release v1.1.0

_prd · June 03, 2026 · Changes since v1.0.0_

---

This release adds exports.

### 🚀 New Features

- Added the export button

### ⚙️ Technical

- Updated the Docker base image to node:22
`;

function markdownRelease(
  fromVersion: string,
  toVersion: string,
  feature: string,
  date: string
): string {
  return `# Test Platform · Release ${toVersion}

_PRD · ${date} · Changes since ${fromVersion}_

---

${feature} is now available.

### 🚀 New Features

- ${feature}
`;
}

function markdownMergedOpening(
  fromVersion: string,
  toVersion: string,
  date: string,
  summary = "The selected releases now read as one continuous update."
): string {
  return `# Test Platform · Release ${toVersion}

_PRD · ${date} · Changes since ${fromVersion}_

---

${summary}`;
}

/** One listed release, as a generation writes it: its marker, then its entry. */
function indexEntry(from: string, to: string, date: string): string {
  const record = { environment: "PRD", fromVersion: from, toVersion: to, date, href: `release-notes_${from}_${to}.md` };
  return `<!-- ai-release-notes:release ${JSON.stringify(record)} -->
## Release ${to}

_PRD · ${date} · Changes since ${from}_

[Read release notes →](${record.href})
`;
}

function releaseIndex(entries: string[]): string {
  return `# Test Platform release notes

A concise release history for PRD. The newest release is listed first.

<!-- ai-release-notes:releases -->
${entries.join("")}<!-- ai-release-notes:/releases -->

---
_Generated with [tabkram/ai-release-notes](https://github.com/tabkram/ai-release-notes)._
`;
}

const INDEX = `# Test Platform release notes

A concise release history for PRD. The newest release is listed first.

<!-- ai-release-notes:releases -->
${indexEntry("v1.1.0", "v1.2.0", "2026-06-10")}${indexEntry("v1.0.0", "v1.1.0", "2026-06-03")}<!-- ai-release-notes:/releases -->

---
_Generated with [tabkram/ai-release-notes](https://github.com/tabkram/ai-release-notes)._
`;

/** A config whose environment holds release notes and one index listing them. */
async function writeIndexConfig(directory: string): Promise<string> {
  return writeConfig(directory, [
    "output:",
    "  - format: markdown",
    `    saveTo: ${join(directory, "{env}", "release-notes_{from}_{to}.md")}`,
    "outputIndex:",
    "  format: markdown",
    `  saveTo: ${join(directory, "{env}", "index.md")}`,
  ]);
}

// ─────────────────────────────────────────
// Opening a session
// ─────────────────────────────────────────

test("opens the release notes one environment holds, and leaves the others alone", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, [
      "output:",
      "  - format: markdown",
      `    saveTo: ${join(directory, "{env}", "release-notes_{from}_{to}.md")}`,
    ]);
    await writeRelease(join(directory, "PRD", "release-notes_v1.0.0_v1.1.0.md"), NOTE);
    await writeRelease(join(directory, "QUA", "release-notes_v1.0.0_v1.1.0.md"), NOTE);

    const session = await PromptSession.open({
      environment: "prd",
      configPath,
      callModel: fakeModel({}).call,
    });

    assert.equal(session.documents.length, 1);
    assert.match(session.documents[0].path, /PRD/);
    assert.equal(session.documents[0].fromVersion, "v1.0.0");
    assert.equal(session.documents[0].toVersion, "v1.1.0");
  });
});

test("opens only the releases the asked-for range covers", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, [
      "output:",
      "  - format: markdown",
      `    saveTo: ${join(directory, "{env}", "release-notes_{from}_{to}.md")}`,
    ]);
    for (const [from, to] of [["v1.0.0", "v1.1.0"], ["v1.1.0", "v1.2.0"], ["v1.2.0", "v1.3.0"]]) {
      await writeRelease(join(directory, "PRD", `release-notes_${from}_${to}.md`), NOTE);
    }

    const session = await PromptSession.open({
      environment: "PRD",
      fromVersion: "v1.1.0",
      toVersion: "v1.3.0",
      configPath,
      callModel: fakeModel({}).call,
    });

    assert.deepEqual(
      session.documents.map((document) => `${document.fromVersion} ${document.toVersion}`).sort(),
      ["v1.1.0 v1.2.0", "v1.2.0 v1.3.0"]
    );
  });
});

test("says so when an environment holds no release notes at all", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, [
      "output:",
      "  - format: markdown",
      `    saveTo: ${join(directory, "{env}", "release-notes_{from}_{to}.md")}`,
    ]);

    await assert.rejects(
      PromptSession.open({ environment: "PRD", configPath, callModel: fakeModel({}).call }),
      /No release notes found for PRD/
    );
  });
});

// ─────────────────────────────────────────
// Revising
// ─────────────────────────────────────────

test("holds a revision until it is saved, and writes it when it is", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "PRD", "release-notes_v1.0.0_v1.1.0.md");
    const configPath = await writeConfig(directory, [
      "output:",
      "  - format: markdown",
      `    saveTo: ${join(directory, "{env}", "release-notes_{from}_{to}.md")}`,
    ]);
    await writeRelease(path, NOTE);

    const model = fakeModel({
      edit: (note) => note.replace(/### ⚙️ Technical[\s\S]*$/, "").trim(),
    });
    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: model.call,
    });

    const result = await session.revise("drop the technical section");
    assert.equal(result.edits.length, 1);
    assert.equal(result.edits[0].changed, true);
    assert.equal(result.usage.modelCalls, 1);
    assert.equal(session.pending().length, 1);

    // The model was handed the note itself, and the file still holds it.
    assert.match(model.revised[0], /Docker base image/);
    assert.match(await readFile(path, "utf-8"), /Technical/);

    assert.deepEqual(await session.save(), [path]);
    const written = await readFile(path, "utf-8");
    assert.doesNotMatch(written, /Technical/);
    assert.match(written, /Added the export button/);
    assert.equal(session.pending().length, 0);
  });
});

test("takes a revision back, one request at a time", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "PRD", "release-notes_v1.0.0_v1.1.0.md");
    const configPath = await writeConfig(directory, [
      "output:",
      "  - format: markdown",
      `    saveTo: ${join(directory, "{env}", "release-notes_{from}_{to}.md")}`,
    ]);
    await writeRelease(path, NOTE);

    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: fakeModel({ edit: (note) => `${note}\n\n- One more line\n` }).call,
    });

    await session.revise("add a line");
    await session.revise("add another");
    assert.equal(session.documents[0].content.match(/One more line/g)?.length, 2);

    assert.equal(session.undo(), true);
    assert.equal(session.documents[0].content.match(/One more line/g)?.length, 1);

    session.reset();
    assert.equal(session.documents[0].content, NOTE);
    assert.equal(session.pending().length, 0);
    assert.equal(session.undo(), false);
  });
});

test("reports the file a model call failed on, and stops asking", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, [
      "output:",
      "  - format: markdown",
      `    saveTo: ${join(directory, "{env}", "release-notes_{from}_{to}.md")}`,
    ]);
    for (const to of ["v1.1.0", "v1.2.0", "v1.3.0"]) {
      await writeRelease(join(directory, "PRD", `release-notes_v1.0.0_${to}.md`), NOTE);
    }

    let calls = 0;
    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: async () => {
        calls += 1;
        throw new Error("Rate limit reached");
      },
    });

    const result = await session.revise("tidy them up");
    assert.equal(calls, 1);
    assert.match(result.edits[0].skipped ?? "", /Rate limit/);
    assert.match(result.edits[1].skipped ?? "", /abandoned/);
    assert.equal(session.pending().length, 0);
    // Every call failed, so no tokens were spent — but a model was asked, and
    // reporting that none was would be reporting the opposite of what happened.
    assert.equal(result.usage.modelCalls, 0);
    assert.equal(result.via, "model");
  });
});

test("leaves the file alone when the model answers with nothing", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, [
      "output:",
      "  - format: markdown",
      `    saveTo: ${join(directory, "{env}", "release-notes_{from}_{to}.md")}`,
    ]);
    await writeRelease(join(directory, "PRD", "release-notes_v1.0.0_v1.1.0.md"), NOTE);

    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: fakeModel({ edit: () => "   " }).call,
    });

    const result = await session.revise("empty it");
    assert.match(result.edits[0].skipped ?? "", /answered with nothing/);
    assert.equal(session.pending().length, 0);
  });
});

// ─────────────────────────────────────────
// Repeated lines
// ─────────────────────────────────────────

test("drops repeated lines exactly, without calling a model", async () => {
  const repeated = `# Release v1.2.0

### 🚀 New Features

- Added the export button
- **Added the export button**
- Added search

### ⚙️ Technical

- Added search
`;

  const { content, removed } = dedupeReleaseDocument(repeated, "markdown");
  assert.equal(removed.length, 2);
  assert.equal(content.match(/Added the export button/g)?.length, 1);
  assert.equal(content.match(/Added search/g)?.length, 1);
  // The section it emptied goes with the line it held.
  assert.doesNotMatch(content, /Technical/);
});

test("a de-duplication reports what it dropped and calls no provider", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "PRD", "release-notes_v1.0.0_v1.1.0.md");
    const configPath = await writeConfig(directory, [
      "output:",
      "  - format: markdown",
      `    saveTo: ${join(directory, "{env}", "release-notes_{from}_{to}.md")}`,
    ]);
    await writeRelease(path, `# Release v1.1.0\n\n### 🚀 New Features\n\n- Added exports\n- Added exports\n`);

    const model = fakeModel({});
    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: model.call,
    });

    const result = session.dedupe();
    assert.equal(result.usage.modelCalls, 0);
    assert.equal(result.via, "comparison");
    assert.equal(model.revised.length, 0);
    assert.deepEqual(result.edits[0].removed, ["- Added exports"]);
    assert.equal(result.edits[0].changed, true);
  });
});

// ─────────────────────────────────────────
// Release notes that are pages
// ─────────────────────────────────────────

test("revises the note on a page and leaves the page around it standing", async () => {
  await withDirectory(async (directory) => {
    const template = await loadReleaseNoteTemplate();
    const page = renderReleaseNoteHtml(template, NOTE, {
      fromVersion: "v1.0.0",
      toVersion: "v1.1.0",
      environment: "PRD",
      date: "June 03, 2026",
      projectName: "Test Platform",
    });
    const path = join(directory, "PRD", "release-notes_v1.0.0_v1.1.0.html");
    const configPath = await writeConfig(directory, [
      "output:",
      "  - format: html",
      `    saveTo: ${join(directory, "{env}", "release-notes_{from}_{to}.html")}`,
    ]);
    await writeRelease(path, page);

    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      // An answer carrying markup a release note is not made of.
      callModel: fakeModel({
        edit: () => `<h1>Release v1.1.0</h1>\n<script>alert(1)</script>\n<p onclick="steal()">Exports are here.</p>\n<a href="javascript:go()">link</a>`,
      }).call,
    });

    assert.equal(session.documents[0].unrevisable, undefined);
    await session.revise("shorten it");
    await session.save();

    const written = await readFile(path, "utf-8");
    assert.doesNotMatch(written, /<script>/);
    assert.doesNotMatch(written, /onclick/);
    assert.doesNotMatch(written, /javascript:/);
    assert.match(written, /Exports are here\./);
    // The page keeps everything that was never the release note.
    assert.match(written, /<!DOCTYPE html>/);
    assert.match(written, /color-scheme/);
    assert.match(written, /tabkram\/ai-release-notes/);
  });
});

test("refuses to rewrite a page whose release note it cannot find", async () => {
  await withDirectory(async (directory) => {
    const templatePath = join(directory, "bare-template.html");
    await writeFile(templatePath, "<html><body>a template with no content slot</body></html>", "utf-8");

    const path = join(directory, "PRD", "release-notes_v1.0.0_v1.1.0.html");
    const configPath = await writeConfig(directory, [
      "output:",
      "  - format: html",
      `    template: ${templatePath}`,
      `    saveTo: ${join(directory, "{env}", "release-notes_{from}_{to}.html")}`,
    ]);
    await writeRelease(path, "<html><body><h1>Release v1.1.0</h1></body></html>");

    const model = fakeModel({ edit: () => "<h1>rewritten</h1>" });
    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: model.call,
    });

    assert.match(session.documents[0].unrevisable ?? "", /cannot be told apart/);
    const result = await session.revise("shorten it");
    assert.equal(model.revised.length, 0);
    assert.equal(result.edits[0].changed, false);
    assert.equal(await readFile(path, "utf-8"), "<html><body><h1>Release v1.1.0</h1></body></html>");
  });
});

test("a page keeps its footer when its note is replaced", () => {
  const page = "<html><body><main>\n<h1>Note</h1>\n</main>\n<footer>Generated with something</footer>\n</body></html>";
  const replaced = replaceReleaseContent(page, "<h1>Revised</h1>");
  assert.match(replaced ?? "", /Revised/);
  assert.match(replaced ?? "", /Generated with something/);
});

// ─────────────────────────────────────────
// The markup a revised page may carry
// ─────────────────────────────────────────

test("reduces a revised page to the markup a release note is made of", () => {
  assert.equal(sanitizeReleaseHtml("<p>Kept</p>"), "<p>Kept</p>");
  assert.equal(sanitizeReleaseHtml("<script>alert(1)</script><p>Kept</p>"), "<p>Kept</p>");
  assert.equal(sanitizeReleaseHtml("<style>body{}</style><p>Kept</p>"), "<p>Kept</p>");
  assert.equal(sanitizeReleaseHtml("<p onclick=\"x()\">Kept</p>"), "<p>Kept</p>");
  assert.equal(sanitizeReleaseHtml("<a href=\"javascript:x()\">Kept</a>"), "<a>Kept</a>");
  assert.equal(sanitizeReleaseHtml("<a href=\"https://example.com\">Kept</a>"), "<a href=\"https://example.com\">Kept</a>");
  assert.equal(sanitizeReleaseHtml("<!-- hidden --><p>Kept</p>"), "<p>Kept</p>");
  // An element that is not release-note markup loses its tags, never its words.
  assert.equal(sanitizeReleaseHtml("<marquee>Kept</marquee>"), "Kept");
  assert.equal(sanitizeReleaseHtml("<ul class=\"x\"><li>Kept</li></ul>"), "<ul class=\"x\"><li>Kept</li></ul>");
  // An unclosed scripting element still loses its tag.
  assert.equal(sanitizeReleaseHtml("<script>alert(1)"), "alert(1)");
});

// ─────────────────────────────────────────
// The index listing every release
// ─────────────────────────────────────────

test("opens the release index when no version is named, and leaves it out of a range", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeIndexConfig(directory);
    await writeRelease(join(directory, "PRD", "release-notes_v1.0.0_v1.1.0.md"), NOTE);
    await writeRelease(join(directory, "PRD", "index.md"), INDEX);

    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: fakeModel({}).call,
    });
    assert.deepEqual(
      session.documents.map((document) => document.kind).sort(),
      ["index", "release"]
    );

    // A range asks for one release's own note, and an index names no version.
    const ranged = await PromptSession.open({
      environment: "PRD",
      fromVersion: "v1.0.0",
      configPath,
      callModel: fakeModel({}).call,
    });
    assert.deepEqual(ranged.documents.map((document) => document.kind), ["release"]);
  });
});

test("revises the list of releases and leaves the page around it standing", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeIndexConfig(directory);
    // An index whose list was never closed: the footer still stays out of it.
    await writeRelease(
      join(directory, "PRD", "index.md"),
      INDEX.replace("<!-- ai-release-notes:/releases -->\n", "")
    );

    // Keep the newer release, drop the older one, marker and all.
    const model = fakeModel({
      edit: (list) => list.slice(0, list.indexOf("<!-- ai-release-notes:release", 1)).trim(),
    });
    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: model.call,
    });

    const result = await session.revise("only keep the latest release");
    assert.equal(result.edits[0].changed, true);
    await session.save();

    // The model is handed the listed releases, never the page carrying them.
    assert.match(model.revised[0], /Release v1\.2\.0/);
    assert.doesNotMatch(model.revised[0], /release history for PRD/);
    assert.doesNotMatch(model.revised[0], /Generated with/);

    const written = await readFile(join(directory, "PRD", "index.md"), "utf-8");
    assert.match(written, /Release v1\.2\.0/);
    assert.doesNotMatch(written, /Release v1\.1\.0/);
    // The heading above the list and the footer below it are nobody's release.
    assert.match(written, /release history for PRD/);
    assert.match(written, /Generated with/);
    // The release that stayed keeps the marker a later run recognizes it by.
    assert.equal(readOutputIndexReleaseMarkers(written).length, 1);
  });
});

test("leaves the index alone when an answer edits the markers", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeIndexConfig(directory);
    await writeRelease(join(directory, "PRD", "index.md"), INDEX);

    // A release nobody released, carrying a marker nobody generated.
    const invented = '<!-- ai-release-notes:release {"environment":"PRD",' +
      '"fromVersion":"v1.2.0","toVersion":"v9.9.9","date":"2026-07-01",' +
      '"href":"release-notes_v1.2.0_v9.9.9.md"} -->\n## Release v9.9.9';
    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: fakeModel({ edit: (list) => `${invented}\n${list}` }).call,
    });

    const result = await session.revise("add the upcoming release");
    assert.equal(result.edits[0].changed, false);
    assert.match(result.edits[0].skipped ?? "", /markers that identify each listed release/);
    assert.equal(session.pending().length, 0);
  });
});

test("a de-duplication passes the index by", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeIndexConfig(directory);
    await writeRelease(join(directory, "PRD", "index.md"), INDEX);

    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: fakeModel({}).call,
    });

    const result = session.dedupe();
    assert.equal(result.edits[0].changed, false);
    assert.match(result.edits[0].skipped ?? "", /not to the release index/);
  });
});

test("keeps a listed release's marker while reducing the markup around it", () => {
  const marker = '<!-- ai-release-notes:release {"environment":"PRD"} -->';
  assert.equal(
    sanitizeReleaseIndexHtml(`${marker}<script>alert(1)</script><p>Kept</p>`),
    `${marker}<p>Kept</p>`
  );
  // Every other comment is markup the list has no use for.
  assert.equal(sanitizeReleaseIndexHtml("<!-- hidden --><p>Kept</p>"), "<p>Kept</p>");
});

// ─────────────────────────────────────────
// Merging a contiguous release chain
// ─────────────────────────────────────────

test("stages one combined note and source deletions, all reversible before save", async () => {
  await withDirectory(async (directory) => {
    const pattern = join(directory, "{env}", "release-notes_{from}_{to}.md");
    const configPath = await writeConfig(directory, [
      "output:",
      "  - format: markdown",
      `    saveTo: ${pattern}`,
    ]);
    const sources = [
      ["v2.0.0", "v2.1.0", "Alpha controls", "July 01, 2026"],
      ["v2.1.0", "v2.2.0", "Beta exports", "July 02, 2026"],
      ["v2.2.0", "v2.3.0", "Gamma filters", "July 03, 2026"],
    ] as const;
    const sourcePaths: string[] = [];
    for (const [from, to, feature, date] of sources) {
      const path = join(directory, "PRD", `release-notes_${from}_${to}.md`);
      sourcePaths.push(path);
      await writeRelease(path, markdownRelease(from, to, feature, date));
    }
    const unrelatedPath = join(
      directory,
      "PRD",
      "release-notes_v8.0.0_v8.1.0.md"
    );
    const unrelated = markdownRelease(
      "v8.0.0",
      "v8.1.0",
      "Unrelated billing",
      "July 04, 2026"
    );
    await writeRelease(unrelatedPath, unrelated);

    const model = fakeModel({
      merge: markdownMergedOpening("v2.0.0", "v2.3.0", "July 03, 2026"),
    });
    const open = () => PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: model.call,
    });
    const destination = join(
      directory,
      "PRD",
      "release-notes_v2.0.0_v2.3.0.md"
    );

    const undoSession = await open();
    const staged = await undoSession.merge({
      fromVersion: "v2.0.0",
      // The planner may omit a conventional prefix; the catalog owns spelling.
      toVersion: "2.3.0",
      kinds: ["release"],
    });

    assert.equal(staged.usage.modelCalls, 1);
    assert.equal(model.merged.length, 1);
    assert.match(model.merged[0], /Opening of v2\.0\.0 → v2\.1\.0/);
    assert.match(model.merged[0], /Opening of v2\.1\.0 → v2\.2\.0/);
    assert.match(model.merged[0], /Opening of v2\.2\.0 → v2\.3\.0/);
    assert.doesNotMatch(model.merged[0], /Unrelated billing|v8\.1\.0/);
    assert.deepEqual(
      staged.edits.map((edit) => edit.operation).sort(),
      ["create", "delete", "delete", "delete"]
    );
    assert.equal(
      staged.edits.find((edit) => edit.operation === "create")?.path,
      destination
    );
    assert.equal(undoSession.pending().length, 4);

    const combined = undoSession.documents.find(
      (document) => document.path === destination
    );
    assert.equal(combined?.created, true);
    assert.match(combined?.content ?? "", /^# Test Platform · Release v2\.3\.0/m);
    assert.match(combined?.content ?? "", /Changes since v2\.0\.0/);
    for (const feature of ["Alpha controls", "Beta exports", "Gamma filters"]) {
      assert.equal(combined?.content.match(new RegExp(feature, "g"))?.length, 1);
    }
    assert.equal(
      undoSession.documents.find((document) => document.path === unrelatedPath)?.removed,
      undefined
    );

    // Staging has not touched disk.
    await assert.rejects(readFile(destination, "utf-8"), { code: "ENOENT" });
    for (const path of sourcePaths) {
      assert.match(await readFile(path, "utf-8"), /New Features/);
    }
    assert.equal(await readFile(unrelatedPath, "utf-8"), unrelated);

    assert.equal(undoSession.undo(), true);
    assert.equal(undoSession.pending().length, 0);
    assert.equal(
      undoSession.documents.some((document) => document.path === destination),
      false
    );
    assert.deepEqual(
      undoSession.documents.map((document) => document.path).sort(),
      [...sourcePaths, unrelatedPath].sort()
    );

    // Reset has the same topology guarantee when used instead of undo.
    const resetSession = await open();
    const callsBeforeResetMerge = model.merged.length;
    await resetSession.merge({ fromVersion: "v2.0.0", toVersion: "v2.3.0" });
    assert.equal(model.merged.length, callsBeforeResetMerge + 1);
    resetSession.reset();
    assert.equal(resetSession.pending().length, 0);
    assert.equal(
      resetSession.documents.some((document) => document.path === destination),
      false
    );
    assert.deepEqual(
      resetSession.documents.map((document) => document.path).sort(),
      [...sourcePaths, unrelatedPath].sort()
    );
  });
});

test("saving a merge creates the combined note, removes its sources, and reconciles the index", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeIndexConfig(directory);
    const selected = [
      ["v4.0.0", "v4.1.0", "First capability", "July 10, 2026"],
      ["v4.1.0", "v4.2.0", "Second capability", "July 11, 2026"],
      ["v4.2.0", "v4.3.0", "Third capability", "July 12, 2026"],
    ] as const;
    const sourcePaths: string[] = [];
    for (const [from, to, feature, date] of selected) {
      const path = join(directory, "PRD", `release-notes_${from}_${to}.md`);
      sourcePaths.push(path);
      await writeRelease(path, markdownRelease(from, to, feature, date));
    }
    const unrelatedPath = join(
      directory,
      "PRD",
      "release-notes_v9.0.0_v9.1.0.md"
    );
    await writeRelease(
      unrelatedPath,
      markdownRelease("v9.0.0", "v9.1.0", "Independent capability", "July 13, 2026")
    );
    const indexPath = join(directory, "PRD", "index.md");
    await writeRelease(indexPath, releaseIndex([
      indexEntry("v9.0.0", "v9.1.0", "2026-07-13"),
      indexEntry("v4.2.0", "v4.3.0", "2026-07-12"),
      indexEntry("v4.1.0", "v4.2.0", "2026-07-11"),
      indexEntry("v4.0.0", "v4.1.0", "2026-07-10"),
    ]));

    const model = fakeModel({
      merge: markdownMergedOpening("v4.0.0", "v4.3.0", "July 12, 2026"),
    });
    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: model.call,
    });
    const destination = join(
      directory,
      "PRD",
      "release-notes_v4.0.0_v4.3.0.md"
    );

    const result = await session.merge({
      fromVersion: "v4.0.0",
      toVersion: "v4.3.0",
    });
    assert.equal(model.merged.length, 1);
    assert.equal(result.usage.modelCalls, 1);
    assert.deepEqual(
      result.edits.map((edit) => edit.operation).sort(),
      ["create", "delete", "delete", "delete", "update"]
    );

    const stagedIndex = session.documents.find(
      (document) => document.path === indexPath
    )!.content;
    const stagedRecords = readOutputIndexReleaseRecords(stagedIndex);
    assert.deepEqual(
      stagedRecords.map((record) => [
        record.fromVersion,
        record.toVersion,
        record.href,
      ]),
      [
        ["v9.0.0", "v9.1.0", "release-notes_v9.0.0_v9.1.0.md"],
        ["v4.0.0", "v4.3.0", "release-notes_v4.0.0_v4.3.0.md"],
      ]
    );
    assert.match(stagedIndex, /Release v4\.3\.0/);
    assert.match(stagedIndex, /Changes since v4\.0\.0/);
    assert.doesNotMatch(stagedIndex, /Release v4\.1\.0|Release v4\.2\.0/);

    const saved = await session.save();
    assert.deepEqual(
      new Set(saved),
      new Set([destination, indexPath, ...sourcePaths])
    );
    const combined = await readFile(destination, "utf-8");
    for (const feature of [
      "First capability",
      "Second capability",
      "Third capability",
    ]) {
      assert.equal(combined.match(new RegExp(feature, "g"))?.length, 1);
    }
    for (const path of sourcePaths) {
      await assert.rejects(readFile(path, "utf-8"), { code: "ENOENT" });
    }
    assert.match(await readFile(unrelatedPath, "utf-8"), /Independent capability/);
    assert.deepEqual(
      readOutputIndexReleaseRecords(await readFile(indexPath, "utf-8")).map(
        (record) => `${record.fromVersion} → ${record.toVersion}`
      ),
      ["v9.0.0 → v9.1.0", "v4.0.0 → v4.3.0"]
    );
    assert.equal(session.pending().length, 0);
    assert.equal(session.undo(), false);
  });
});

test("a gap or unknown boundary fails before staging or calling the opening model", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, [
      "output:",
      "  - format: markdown",
      `    saveTo: ${join(directory, "{env}", "release-notes_{from}_{to}.md")}`,
    ]);
    await writeRelease(
      join(directory, "PRD", "release-notes_v5.0.0_v5.1.0.md"),
      markdownRelease("v5.0.0", "v5.1.0", "Before the gap", "July 20, 2026")
    );
    await writeRelease(
      join(directory, "PRD", "release-notes_v5.2.0_v5.3.0.md"),
      markdownRelease("v5.2.0", "v5.3.0", "After the gap", "July 21, 2026")
    );

    const model = fakeModel({
      merge: markdownMergedOpening("v5.0.0", "v5.3.0", "July 21, 2026"),
    });
    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: model.call,
    });
    const before = session.documents.map((document) => ({ ...document }));

    await assert.rejects(
      session.merge({ fromVersion: "v5.0.0", toVersion: "v5.3.0" }),
      /No release chain leads from v5\.0\.0 to v5\.3\.0/
    );
    await assert.rejects(
      session.merge({ fromVersion: "v5.0.0", toVersion: "v7.7.7" }),
      /Version "v7\.7\.7" is not a boundary in the open release catalog/
    );
    assert.equal(model.merged.length, 0);
    assert.equal(session.pending().length, 0);
    assert.deepEqual(session.documents, before);
  });
});

test("merges every open language as a separate atomic output group", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, [
      "prompt:",
      "  languages:",
      "    - en",
      "    - fr",
      "output:",
      "  - format: markdown",
      `    saveTo: ${join(directory, "{env}", "{lang}", "release-notes_{from}_{to}.md")}`,
    ]);
    for (const language of ["en", "fr"]) {
      await writeRelease(
        join(directory, "PRD", language, "release-notes_v6.0.0_v6.1.0.md"),
        markdownRelease(
          "v6.0.0",
          "v6.1.0",
          language === "fr" ? "Commandes en lot" : "Batch controls",
          "July 22, 2026"
        )
      );
      await writeRelease(
        join(directory, "PRD", language, "release-notes_v6.1.0_v6.2.0.md"),
        markdownRelease(
          "v6.1.0",
          "v6.2.0",
          language === "fr" ? "Exports planifiés" : "Scheduled exports",
          "July 23, 2026"
        )
      );
    }

    const model = fakeModel({
      merge: (prompt) => markdownMergedOpening(
        "v6.0.0",
        "v6.2.0",
        "July 23, 2026",
        prompt.includes("Language: fr")
          ? "Les deux livraisons forment maintenant une seule mise à jour."
          : "Both releases now form one update."
      ),
    });
    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: model.call,
    });

    const result = await session.merge({
      fromVersion: "v6.0.0",
      toVersion: "v6.2.0",
    });
    assert.equal(model.merged.length, 2);
    assert.equal(result.usage.modelCalls, 2);
    assert.deepEqual(
      result.edits.map((edit) => edit.operation).sort(),
      ["create", "create", "delete", "delete", "delete", "delete"]
    );
    assert.deepEqual(
      session.documents
        .filter((document) => document.created)
        .map((document) => document.language)
        .sort(),
      ["en", "fr"]
    );
    assert.equal(session.pending().length, 6);
    session.reset();
    assert.equal(session.pending().length, 0);
    assert.equal(session.documents.length, 4);
  });
});

// ─────────────────────────────────────────
// Reading what was asked for
// ─────────────────────────────────────────

test("reads the action a message turned out to mean", () => {
  assert.deepEqual(
    readSessionAction('{"action":"save","instruction":"","reply":"Writing them now."}', "write them"),
    { action: "save", instruction: "write them", reply: "Writing them now." }
  );

  const revise = readSessionAction(
    '```json\n{"action":"revise","instruction":"Remove the Docker line from the Technical section","reply":"Dropping it."}\n```',
    "i dont want to talk about the docker part"
  );
  assert.equal(revise.action, "revise");
  assert.equal(revise.instruction, "Remove the Docker line from the Technical section");

  assert.deepEqual(
    readSessionAction(
      JSON.stringify({
        action: "merge",
        instruction: "",
        reply: "Combining that range.",
        scope: {
          fromVersion: "v2.0.0",
          toVersion: "v2.3.0",
          languages: ["fr"],
          kinds: ["release"],
        },
      }),
      "combine the selected run"
    ),
    {
      action: "merge",
      instruction: "combine the selected run",
      reply: "Combining that range.",
      scope: {
        fromVersion: "v2.0.0",
        toVersion: "v2.3.0",
        languages: ["fr"],
        kinds: ["release"],
      },
    }
  );

  assert.deepEqual(
    readSessionAction(
      '{"action":"answer","instruction":"Assess the recurring theme","reply":"I will inspect it.",' +
        '"answerFrom":"notes","scope":{"toVersion":"v2.2.0","kinds":["release"]}}',
      "assess that release"
    ),
    {
      action: "answer",
      instruction: "Assess the recurring theme",
      reply: "I will inspect it.",
      answerFrom: "notes",
      scope: { toVersion: "v2.2.0", kinds: ["release"] },
    }
  );

  for (const malformed of [
    "Sure, I can help with that!",
    '{"action":"deploy"}',
    '{"action":"merge","scope":{"kinds":["repository"]}}',
    '{"action":"answer","answerFrom":"internet"}',
    '{"action":',
  ]) {
    assert.deepEqual(
      readSessionAction(malformed, "keep this request intact"),
      { action: "unclear", instruction: "keep this request intact", reply: "" }
    );
  }
});

test("routes with the document catalog and the previous exchange, and fails closed", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, [
      "output:",
      "  - format: markdown",
      `    saveTo: ${join(directory, "{env}", "release-notes_{from}_{to}.md")}`,
    ]);
    await writeRelease(join(directory, "PRD", "release-notes_v1.0.0_v1.1.0.md"), NOTE);

    const model = fakeModel({
      route: (_prompt, index) => index === 0
        ? {
            action: "answer",
            instruction: "Report the state of the open material",
            reply: "I will inspect the open material.",
            answerFrom: "catalog",
          }
        : { action: "done", reply: "Finished." },
    });
    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: model.call,
    });

    const action = await session.route("report the current release-note state");
    assert.equal(action.action, "answer");
    assert.equal(action.answerFrom, "catalog");
    assert.equal(action.reply, "I will inspect the open material.");

    // The planner sees authoritative identities and state, never note prose.
    assert.match(model.routed[0], /Release notes open: 1, for PRD/);
    assert.match(model.routed[0], /BEGIN DOCUMENT CATALOG/);
    assert.match(
      model.routed[0],
      /"kind":"release","language":null,"from":"v1\.0\.0","to":"v1\.1\.0","dirty":false,"readable":true/
    );
    assert.doesNotMatch(model.routed[0], /export button/);

    await session.route("that is all");
    assert.equal(model.routed.length, 2);
    assert.match(model.routed[1], /The exchange just before this one:/);
    assert.match(model.routed[1], /They said: report the current release-note state/);
    assert.match(model.routed[1], /You placed it as: answer/);
    assert.match(model.routed[1], /You answered: I will inspect the open material\./);

    const unreachable = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: async () => {
        throw new Error("no provider today");
      },
    });
    const fallback = await unreachable.route("explain the newest note");
    assert.deepEqual(
      fallback,
      { action: "unclear", instruction: "explain the newest note", reply: "" }
    );
  });
});

// ─────────────────────────────────────────
// Answering from what is open
// ─────────────────────────────────────────

test("answers catalog questions without revising or writing any file", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "PRD", "release-notes_v1.0.0_v1.1.0.md");
    const configPath = await writeConfig(directory, [
      "output:",
      "  - format: markdown",
      `    saveTo: ${join(directory, "{env}", "release-notes_{from}_{to}.md")}`,
    ]);
    await writeRelease(path, NOTE);

    const model = fakeModel({ answer: "One release note is open and no changes are pending." });
    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: model.call,
    });
    const before = session.documents.map((document) => ({ ...document }));

    const result = await session.answer(
      "Report the number and save state of the open documents",
      undefined,
      "catalog"
    );

    assert.equal(result.text, "One release note is open and no changes are pending.");
    assert.equal(result.usage.modelCalls, 1);
    assert.equal(model.answered.length, 1);
    assert.equal(model.synthesized.length, 0);
    assert.equal(model.revised.length, 0);
    assert.match(model.answered[0], /Release notes open: 1/);
    assert.match(model.answered[0], /\(none of the open notes could be read\)/);
    assert.doesNotMatch(model.answered[0], /Added the export button/);
    assert.deepEqual(session.documents, before);
    assert.equal(session.pending().length, 0);
    assert.equal(await readFile(path, "utf-8"), NOTE);
  });
});

test("selects the incoming release for one endpoint and every note inside two endpoints", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, [
      "output:",
      "  - format: markdown",
      `    saveTo: ${join(directory, "{env}", "release-notes_{from}_{to}.md")}`,
    ]);
    const fixtures = [
      ["v2.0.0", "v2.1.0", "Alpha controls", "July 01, 2026"],
      ["v2.1.0", "v2.2.0", "Beta exports", "July 02, 2026"],
      ["v2.2.0", "v2.3.0", "Gamma filters", "July 03, 2026"],
      ["v8.0.0", "v8.1.0", "Unrelated billing", "July 04, 2026"],
    ] as const;
    for (const [from, to, feature, date] of fixtures) {
      await writeRelease(
        join(directory, "PRD", `release-notes_${from}_${to}.md`),
        markdownRelease(from, to, feature, date)
      );
    }

    const model = fakeModel({ answer: (_prompt, index) => `Grounded selection ${index + 1}` });
    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: model.call,
    });

    await session.answer("Describe what arrived at v2.2.0", undefined, "notes");
    assert.match(model.answered[0], /Beta exports/);
    assert.doesNotMatch(model.answered[0], /Alpha controls|Gamma filters|Unrelated billing/);
    assert.match(model.answered[0], /--- v2\.1\.0 → v2\.2\.0 ---/);

    await session.answer("Contrast v2.0.0 through v2.3.0", undefined, "notes");
    assert.match(model.answered[1], /Alpha controls/);
    assert.match(model.answered[1], /Beta exports/);
    assert.match(model.answered[1], /Gamma filters/);
    assert.doesNotMatch(model.answered[1], /Unrelated billing/);

    // A conventional missing `v` is resolved back to the catalog's spelling.
    await session.answer("Inspect the material for 2.2.0", undefined, "notes");
    assert.match(model.answered[2], /--- v2\.1\.0 → v2\.2\.0 ---/);
    assert.match(model.answered[2], /Beta exports/);
    assert.doesNotMatch(model.answered[2], /Alpha controls|Gamma filters/);

    assert.equal(session.pending().length, 0);
    assert.equal(model.revised.length, 0);
  });
});

test("answers a large selection in bounded pieces and synthesizes every finding", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, [
      "output:",
      "  - format: markdown",
      `    saveTo: ${join(directory, "{env}", "release-notes_{from}_{to}.md")}`,
    ]);
    const detail = `\n\n${"Grounded detail for this release. ".repeat(1_300)}\n`;
    await writeRelease(
      join(directory, "PRD", "release-notes_v3.0.0_v3.1.0.md"),
      markdownRelease("v3.0.0", "v3.1.0", "First large change", "July 05, 2026") + detail
    );
    await writeRelease(
      join(directory, "PRD", "release-notes_v3.1.0_v3.2.0.md"),
      markdownRelease("v3.1.0", "v3.2.0", "Second large change", "July 06, 2026") + detail
    );

    const model = fakeModel({
      answer: (_prompt, index) => `Finding ${index + 1}`,
      synthesis: "Combined grounded conclusion.",
    });
    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: model.call,
    });

    const result = await session.answer("Identify the common direction across the open notes");

    assert.equal(model.answered.length, 2);
    assert.equal(model.synthesized.length, 1);
    assert.equal(result.text, "Combined grounded conclusion.");
    assert.equal(result.usage.modelCalls, 3);
    assert.match(model.synthesized[0], /Finding 1/);
    assert.match(model.synthesized[0], /Finding 2/);
    assert.match(model.synthesized[0], /Identify the common direction across the open notes/);
    assert.equal(session.pending().length, 0);
  });
});

// ─────────────────────────────────────────
// Showing what changed
// ─────────────────────────────────────────

test("reports the lines a revision removed and added, in reading order", () => {
  const changes = changedLines("one\ntwo\nthree\n", "one\nthree\nfour\n");
  assert.deepEqual(changes, [
    { kind: "removed", text: "two" },
    { kind: "added", text: "four" },
  ]);
});
