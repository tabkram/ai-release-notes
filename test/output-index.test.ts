import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverOutputIndexLanguages,
  updateOutputIndexes,
} from "../src/output-index.js";

test("discovers indexes in previously generated language folders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-release-indexes-"));
  const placeholder = "aireleasenoteslanguageplaceholder";

  try {
    await mkdir(join(directory, "PROD", "en"), { recursive: true });
    await mkdir(join(directory, "PROD", "fr"), { recursive: true });
    await mkdir(join(directory, "PROD", "draft"), { recursive: true });
    await writeFile(join(directory, "PROD", "en", "index.html"), "English");
    await writeFile(join(directory, "PROD", "fr", "index.html"), "French");

    const discovered = await discoverOutputIndexLanguages(
      join(directory, "PROD", placeholder, "index.html"),
      placeholder
    );

    assert.deepEqual(
      discovered.map(({ language }) => language),
      ["en", "fr"]
    );
    assert.deepEqual(
      discovered.map(({ path }) => path),
      [
        join(directory, "PROD", "en", "index.html"),
        join(directory, "PROD", "fr", "index.html"),
      ]
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("discovers languages when the placeholder is part of the index filename", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-release-indexes-"));
  const placeholder = "aireleasenoteslanguageplaceholder";

  try {
    await writeFile(join(directory, "INDEX_en.md"), "English");
    await writeFile(join(directory, "INDEX_it.md"), "Italian");
    await writeFile(join(directory, "README.md"), "Ignore me");

    const discovered = await discoverOutputIndexLanguages(
      join(directory, `INDEX_${placeholder}.md`),
      placeholder
    );

    assert.deepEqual(
      discovered.map(({ language }) => language),
      ["en", "it"]
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("updates indexes only for languages produced by the current run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-release-index-scope-"));
  const indexPattern = join(directory, "{lang}", "index.md");
  const untouchedIndex = join(directory, "de", "index.md");
  const untouchedContent = [
    "# German releases",
    "",
    "<!-- ai-release-notes:releases -->",
    "<!-- ai-release-notes:/releases -->",
    "",
  ].join("\n");

  try {
    await mkdir(join(directory, "de"), { recursive: true });
    await writeFile(untouchedIndex, untouchedContent, "utf-8");

    const releases = ["en", "fr"].map((language) => ({
      path: join(directory, language, "release-notes_v1.0.0_v1.1.0.md"),
      format: "markdown",
      language,
    }));
    const updated: string[] = [];

    await updateOutputIndexes({
      outputIndexes: [{ format: "markdown", saveTo: indexPattern }],
      releases,
      environment: "QUA",
      fromVersion: "v1.0.0",
      toVersion: "v1.1.0",
      date: "2026-07-28",
      languages: ["en", "fr"],
      primaryLanguage: "en",
      onUpdated: (path) => updated.push(path),
    });

    assert.deepEqual(updated, [
      join(directory, "en", "index.md"),
      join(directory, "fr", "index.md"),
    ]);
    assert.equal(await readFile(untouchedIndex, "utf-8"), untouchedContent);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inserts an older range in order without rewriting historical entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-release-index-history-"));
  const outputPath = join(directory, "fr", "index.html");
  const newerMarker =
    '<!-- ai-release-notes:release {"environment":"PRD\\u002d\\u002d><script>","fromVersion":"v1.29.5","toVersion":"v1.29.8","date":"2026-07-28","href":"newer.html"} -->';
  const newerEntry = [
    newerMarker,
    '<section data-preserve="newer">',
    "  <h2>Texte relu à conserver exactement</h2>",
    "</section>",
  ].join("\n");
  const olderMarker = "<!-- ai-release-notes:release prd_v1.21.0_v1.25.7 -->";
  const olderEntry = [
    olderMarker,
    '<section data-preserve="legacy">Ancienne mise en forme à conserver</section>',
  ].join("\n");
  const beforeInsertion = [
    "<!doctype html>",
    "<html><body><main>",
    "<!-- ai-release-notes:releases -->",
    newerEntry,
  ].join("\n") + "\n";
  const afterInsertion = [
    olderEntry,
    "<!-- ai-release-notes:/releases -->",
    "</main></body></html>",
    "",
  ].join("\n");

  try {
    await mkdir(join(directory, "fr"), { recursive: true });
    await writeFile(outputPath, beforeInsertion + afterInsertion, "utf-8");

    await updateOutputIndexes({
      outputIndexes: [{
        format: "html",
        saveTo: join(directory, "{lang}", "index.html"),
      }],
      releases: [{
        path: join(directory, "fr", "release-notes_v1.29.5_v1.29.6.html"),
        format: "html",
        language: "fr",
      }],
      environment: "PRD",
      fromVersion: "v1.29.5",
      toVersion: "v1.29.6",
      date: "2026-07-28",
      languages: ["fr"],
      primaryLanguage: "en",
      translateTemplate: async (template) => template
        .replace("Release {{toVersion}}", "Version {{toVersion}}")
        .replace("Changes since", "Changements depuis")
        .replace("Read release notes", "Voir les notes de version"),
    });

    const updated = await readFile(outputPath, "utf-8");
    const insertedMarker =
      '<!-- ai-release-notes:release {"environment":"PRD","fromVersion":"v1.29.5","toVersion":"v1.29.6"';
    const insertedAt = updated.indexOf(insertedMarker);
    const olderAt = updated.indexOf(olderMarker);

    assert.equal(updated.slice(0, insertedAt), beforeInsertion);
    assert.equal(updated.slice(olderAt), afterInsertion);
    assert.ok(updated.indexOf(newerMarker) < insertedAt);
    assert.ok(insertedAt < olderAt);
    assert.match(updated.slice(insertedAt, olderAt), /Version v1\.29\.6/);
    assert.match(updated.slice(insertedAt, olderAt), /Changements depuis v1\.29\.5/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lists a release older than every legacy entry last, and leaves it there", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-release-index-oldest-"));
  const outputPath = join(directory, "fr", "index.html");
  const newerEntry = [
    '<!-- ai-release-notes:release {"environment":"prd","fromVersion":"v1.29.5","toVersion":"v1.29.8","date":"2026-07-28","href":"newer.html"} -->',
    '<section data-preserve="newer">Ne pas déplacer</section>',
  ].join("\n");
  const legacyMarker = "<!-- ai-release-notes:release prd_v1.21.0_v1.25.7 -->";
  const legacyEntry = [
    legacyMarker,
    '<section data-preserve="legacy">Ancienne mise en forme à conserver</section>',
  ].join("\n");
  const oldestMarker =
    '<!-- ai-release-notes:release {"environment":"PRD","fromVersion":"start","toVersion":"v0.23.0"';
  const addRelease = (fromVersion: string, toVersion: string) => updateOutputIndexes({
    outputIndexes: [{
      format: "html",
      saveTo: join(directory, "{lang}", "index.html"),
    }],
    releases: [{
      path: join(directory, "fr", `release-notes_${fromVersion}_${toVersion}.html`),
      format: "html",
      language: "fr",
    }],
    environment: "PRD",
    fromVersion,
    toVersion,
    date: "2026-07-29",
    languages: ["fr"],
    primaryLanguage: "en",
    translateTemplate: async (template) => template
      .replace("Release {{toVersion}}", "Version {{toVersion}}")
      .replace("Changes since", "Changements depuis"),
  });

  try {
    await mkdir(join(directory, "fr"), { recursive: true });
    await writeFile(outputPath, [
      "<!doctype html>",
      "<html><body><main>",
      "<!-- ai-release-notes:releases -->",
      newerEntry,
      legacyEntry,
      "<!-- ai-release-notes:/releases -->",
      "</main></body></html>",
      "",
    ].join("\n"), "utf-8");

    // The very first release a project made is older than everything the index
    // already lists, legacy formatting included, so it belongs at the end.
    await addRelease("start", "v0.23.0");
    const withOldest = await readFile(outputPath, "utf-8");
    assert.ok(withOldest.indexOf(legacyMarker) < withOldest.indexOf(oldestMarker));

    // And a later release does not hoist it back above that legacy history:
    // everything from it onwards is left byte-for-byte as it was.
    await addRelease("v1.29.8", "v1.29.9");
    const withNewest = await readFile(outputPath, "utf-8");
    const newestAt = withNewest.indexOf('"toVersion":"v1.29.9"');
    assert.ok(newestAt >= 0 && newestAt < withNewest.indexOf(newerEntry));
    assert.equal(
      withNewest.slice(withNewest.indexOf(legacyMarker)),
      withOldest.slice(withOldest.indexOf(legacyMarker))
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reruns replace record and legacy ranges in place without moving neighbours", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-release-index-rerun-"));
  const outputPath = join(directory, "fr", "index.html");
  const newerEntry = [
    '<!-- ai-release-notes:release {"environment":"prd","fromVersion":"v1.29.6","toVersion":"v1.29.8","date":"2026-07-28","href":"newer.html"} -->',
    '<section data-preserve="newer">Ne pas déplacer ou réécrire</section>',
  ].join("\n");
  const olderMarker = "<!-- ai-release-notes:release prd_v1.21.0_v1.25.7 -->";
  const olderEntry = [
    olderMarker,
    '<section data-preserve="older">Ne pas déplacer ou réécrire non plus</section>',
  ].join("\n");
  const targetMarkers = [
    '<!-- ai-release-notes:release {"environment":"prd","fromVersion":"v1.29.5","toVersion":"v1.29.6","date":"old date","href":"old.html"} -->',
    "<!-- ai-release-notes:release prd_v1.29.5_v1.29.6 -->",
  ];

  try {
    await mkdir(join(directory, "fr"), { recursive: true });

    for (const targetMarker of targetMarkers) {
      const prefix = [
        "<!doctype html>",
        "<html><body><main>",
        "<!-- ai-release-notes:releases -->",
        newerEntry,
      ].join("\n") + "\n";
      const oldTarget = [
        targetMarker,
        '<section data-replace="target">Ancienne entrée ciblée</section>',
      ].join("\n");
      const suffix = [
        olderEntry,
        "<!-- ai-release-notes:/releases -->",
        "</main></body></html>",
        "",
      ].join("\n");
      await writeFile(outputPath, prefix + oldTarget + "\n" + suffix, "utf-8");

      await updateOutputIndexes({
        outputIndexes: [{
          format: "html",
          saveTo: join(directory, "{lang}", "index.html"),
        }],
        releases: [{
          path: join(directory, "fr", "release-notes_v1.29.5_v1.29.6.html"),
          format: "html",
          language: "fr",
        }],
        environment: "PRD",
        fromVersion: "v1.29.5",
        toVersion: "v1.29.6",
        date: "2026-07-28",
        languages: ["fr"],
        primaryLanguage: "en",
        translateTemplate: async (template) => template
          .replace("Release {{toVersion}}", "Version {{toVersion}}")
          .replace("Changes since", "Changements depuis"),
      });

      const updated = await readFile(outputPath, "utf-8");
      const replacementMarker =
        '<!-- ai-release-notes:release {"environment":"PRD","fromVersion":"v1.29.5","toVersion":"v1.29.6"';
      const replacementAt = updated.indexOf(replacementMarker);
      const olderAt = updated.indexOf(olderMarker);

      assert.equal(updated.slice(0, replacementAt), prefix);
      assert.equal(updated.slice(olderAt), suffix);
      assert.doesNotMatch(updated, /Ancienne entrée ciblée/);
      assert.match(updated.slice(replacementAt, olderAt), /Version v1\.29\.6/);
      assert.ok(updated.indexOf(newerEntry) < replacementAt);
      assert.ok(replacementAt < olderAt);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses an orphan output-index boundary without changing the file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-release-index-boundary-"));
  const outputPath = join(directory, "index.html");
  const malformed = [
    "<!doctype html>",
    "<html><body><main>",
    '<!-- ai-release-notes:release {"environment":"PRD","fromVersion":"v1.0.0","toVersion":"v1.1.0","date":"2026-07-01","href":"old.html"} -->',
    '<section class="release-entry">Old release</section>',
    "<!-- ai-release-notes:/releases -->",
    "</main></body></html>",
    "",
  ].join("\n");

  try {
    await writeFile(outputPath, malformed, "utf-8");

    await assert.rejects(
      updateOutputIndexes({
        outputIndexes: [{ format: "html", saveTo: outputPath }],
        releases: [{ path: join(directory, "new.html"), format: "html" }],
        environment: "PRD",
        fromVersion: "v1.1.0",
        toVersion: "v1.2.0",
        date: "2026-07-28",
        languages: ["en"],
        primaryLanguage: "en",
      }),
      /malformed release boundaries/
    );
    assert.equal(await readFile(outputPath, "utf-8"), malformed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses unresolved conflict markers without changing the index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-release-index-conflict-"));
  const outputPath = join(directory, "index.html");
  const conflicted = [
    "<!doctype html>",
    "<html><body><main>",
    "<!-- ai-release-notes:releases -->",
    "<<<<<<< HEAD",
    "<section>Current</section>",
    "=======",
    "<section>Incoming</section>",
    ">>>>>>> release-branch",
    "<!-- ai-release-notes:/releases -->",
    "</main></body></html>",
    "",
  ].join("\n");

  try {
    await writeFile(outputPath, conflicted, "utf-8");

    await assert.rejects(
      updateOutputIndexes({
        outputIndexes: [{ format: "html", saveTo: outputPath }],
        releases: [{ path: join(directory, "new.html"), format: "html" }],
        environment: "QUA",
        fromVersion: "v1.1.0",
        toVersion: "v1.2.0",
        date: "2026-07-28",
        languages: ["en"],
        primaryLanguage: "en",
      }),
      /unresolved Git conflict markers/
    );
    assert.equal(await readFile(outputPath, "utf-8"), conflicted);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
