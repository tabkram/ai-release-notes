import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReleaseNoteTemplate } from "../src/generator.js";
import { PromptSession, readSessionAction, type EditModelCall } from "../src/prompt-session.js";
import { dedupeReleaseDocument, replaceReleaseContent } from "../src/release-document.js";
import { renderReleaseNoteHtml, sanitizeReleaseHtml } from "../src/release.js";
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

/** The release note a revision request carries, as the model would read it. */
function noteFrom(userPrompt: string): string {
  const opening = userPrompt.indexOf("===== BEGIN RELEASE NOTE");
  const closing = userPrompt.indexOf("===== END RELEASE NOTE");
  return userPrompt.slice(userPrompt.indexOf("\n", opening) + 1, closing).trim();
}

interface FakeModel {
  call: EditModelCall;
  /** The release notes it was asked to revise, in order. */
  revised: string[];
  /** The messages it was asked to place, in order. */
  routed: string[];
}

/**
 * A model that answers without a provider.
 *
 * Both kinds of call reach one function, so a test that never routes anything
 * still fails loudly if the session routes behind its back.
 */
function fakeModel(answers: {
  route?: unknown;
  edit?: (note: string) => string;
}): FakeModel {
  const model: FakeModel = {
    revised: [],
    routed: [],
    call: async ({ user }) => {
      const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };

      if (user.includes("===== BEGIN MESSAGE =====")) {
        model.routed.push(user);
        return {
          text: typeof answers.route === "string"
            ? answers.route
            : JSON.stringify(answers.route ?? { action: "revise", instruction: "revise it" }),
          usage,
        };
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

  assert.equal(readSessionAction("Sure, I can help with that!", "remove duplicates").action, "revise");
  assert.equal(
    readSessionAction("Sure, I can help with that!", "remove duplicates").instruction,
    "remove duplicates"
  );
  // An action this does not have is no action at all.
  assert.equal(readSessionAction('{"action":"deploy"}', "ship it").action, "revise");
});

test("routes a message through the model, and falls back to revising when it cannot", async () => {
  await withDirectory(async (directory) => {
    const configPath = await writeConfig(directory, [
      "output:",
      "  - format: markdown",
      `    saveTo: ${join(directory, "{env}", "release-notes_{from}_{to}.md")}`,
    ]);
    await writeRelease(join(directory, "PRD", "release-notes_v1.0.0_v1.1.0.md"), NOTE);

    const model = fakeModel({ route: { action: "dedupe", reply: "Dropping the repeats." } });
    const session = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: model.call,
    });

    const action = await session.route("remove exact duplicate lines");
    assert.equal(action.action, "dedupe");
    assert.equal(action.reply, "Dropping the repeats.");
    // The desk is told what it is looking at, never what the notes say.
    assert.match(model.routed[0], /Release notes open: 1, for PRD/);
    assert.doesNotMatch(model.routed[0], /export button/);

    const unreachable = await PromptSession.open({
      environment: "PRD",
      configPath,
      callModel: async () => {
        throw new Error("no provider today");
      },
    });
    const fallback = await unreachable.route("drop the docker line");
    assert.deepEqual(fallback, { action: "revise", instruction: "drop the docker line", reply: "" });
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
