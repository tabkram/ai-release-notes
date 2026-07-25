import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  applyOutputIndexLanguageSwitcher,
  hasOutputIndexLanguageSwitcher,
  markdownToHtml,
  outputIndexReleaseId,
  readLegacyOutputIndexEntries,
  readOutputIndexReleaseRecords,
  readOutputIndexReleasesRegion,
  renderOutputIndexLanguageSwitcher,
  renderOutputIndexReleases,
  replaceOutputIndexReleases,
  upsertOutputIndexReleaseRecord,
  type OutputIndexEntryTemplate,
  renderReleaseNoteHtml,
} from "../src/release.js";
import { AI_RELEASE_NOTES_VERSION } from "../src/version.js";

function bundledEntryFile(format: "markdown" | "html"): Promise<string> {
  const extension = format === "html" ? "html" : "md";
  return readFile(
    resolve(import.meta.dirname, `../templates/default-release-summary-entry.${extension}`),
    "utf-8"
  );
}

async function bundledEntryTemplate(format: "markdown" | "html") {
  return (await bundledEntryFile(format)).trim();
}

const template = "<main>{{content}}</main>";
const params = {
  fromVersion: "v1.0.0",
  toVersion: "v1.1.0",
  environment: "PROD",
  date: "July 21, 2026",
};

test("renders all Markdown heading levels as HTML headings", () => {
  const html = renderReleaseNoteHtml(template, "# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six", params);

  for (let level = 1; level <= 6; level += 1) {
    assert.match(html, new RegExp(`<h${level}>`));
  }
  assert.doesNotMatch(html, /<p>#### Four<\/p>/);
});

test("preserves nested release-note lists", () => {
  const html = renderReleaseNoteHtml(template, `#### New features

- **Assessment dashboard:**
  - Added a focused dashboard view.
  - Improved filter suggestions.
- **Workflow:**
  - Added status transitions.`, params);

  assert.match(html, /<h4>New features<\/h4>/);
  assert.match(html, /<li><strong>Assessment dashboard:<\/strong>\n<ul>\n<li>Added a focused dashboard view\./);
  assert.match(html, /<li><strong>Workflow:<\/strong>\n<ul>\n<li>Added status transitions\./);
});

test("renders underscore emphasis and thematic breaks", () => {
  const html = renderReleaseNoteHtml(template, "_PROD · 21 juillet 2026 · Changements depuis v1.25.9_\n\n___", params);

  assert.match(html, /<em>PROD · 21 juillet 2026 · Changements depuis v1\.25\.9<\/em>/);
  assert.match(html, /<hr>/);
});

test("renders the package version in a release-note template", () => {
  const html = renderReleaseNoteHtml("<footer>v{{version}}</footer>{{content}}", "Release content", params);

  assert.match(html, new RegExp(`<footer>v${AI_RELEASE_NOTES_VERSION.replace(/\./g, "\\.")}</footer>`));
  assert.doesNotMatch(html, /{{version}}/);
});

test("the page title and the footer are the template's own words", () => {
  const html = markdownToHtml("Release content");

  assert.match(html, /<title>Release notes<\/title>/);
  assert.match(html, /<footer>[\s\S]*ai-release-notes[\s\S]*<\/footer>/);
  // Nothing of either is spelled out in code, so neither takes a slot.
  assert.doesNotMatch(html, /\{\{title\}\}|\{\{footer\}\}/);
});

test("renders Markdown links between localized output indexes", () => {
  const switcher = renderOutputIndexLanguageSwitcher("markdown", [
    { language: "en", href: "RELEASE_INDEX_PROD_en.md", active: true },
    { language: "fr", href: "RELEASE_INDEX_PROD_fr.md", active: false },
  ]);

  // The switcher is the links themselves: nothing wraps them on the page.
  assert.equal(switcher, "**EN** · [FR](RELEASE_INDEX_PROD_fr.md)");
});

test("renders HTML language buttons with the current language highlighted", () => {
  const switcher = renderOutputIndexLanguageSwitcher("html", [
    { language: "en", href: "RELEASE_INDEX_PROD_en.html", active: false },
    { language: "fr", href: "RELEASE_INDEX_PROD_fr.html", active: true },
  ]);

  assert.match(switcher, /<a class="language-option" href="RELEASE_INDEX_PROD_en\.html">EN<\/a>/);
  assert.match(switcher, /<span class="language-option is-active" aria-current="page">FR<\/span>/);
});

test("supports both output-index language placeholders and refreshes existing switchers", () => {
  const english = renderOutputIndexLanguageSwitcher("markdown", [
    { language: "en", href: "index_en.md", active: true },
    { language: "fr", href: "index_fr.md", active: false },
  ]);
  const french = renderOutputIndexLanguageSwitcher("markdown", [
    { language: "en", href: "index_en.md", active: false },
    { language: "fr", href: "index_fr.md", active: true },
  ]);

  assert.equal(
    applyOutputIndexLanguageSwitcher("Before\n{{languages}}\nAfter", english),
    `Before\n${english}\nAfter`
  );
  assert.equal(
    applyOutputIndexLanguageSwitcher("Before\n{{langages}}\nAfter", english),
    `Before\n${english}\nAfter`
  );

  const refreshed = applyOutputIndexLanguageSwitcher(`Before\n${english}\nAfter`, french);
  assert.doesNotMatch(refreshed, /\*\*EN\*\*/);
  assert.match(refreshed, /\*\*FR\*\*/);
});

test("collapses duplicate generated language switchers", () => {
  const switcher = renderOutputIndexLanguageSwitcher("html", [
    { language: "en", href: "../en/index.html", active: false },
    { language: "it", href: "../it/index.html", active: true },
  ]);
  const duplicated = `<main>\n${switcher}\n${switcher}\n</main>`;

  const updated = applyOutputIndexLanguageSwitcher(duplicated, switcher);

  assert.equal(updated.match(/<nav class="language-switcher"/g)?.length, 1);
});

test("shows no switcher when only one localized index exists", () => {
  const switcher = renderOutputIndexLanguageSwitcher("markdown", [
    { language: "en", href: "index_en.md", active: true },
  ]);

  assert.equal(switcher, "");
  // The slot a template offers is spent either way, so no token is left behind.
  assert.equal(applyOutputIndexLanguageSwitcher("Before\n{{languages}}\nAfter", switcher), "Before\n\nAfter");
});

test("a lone link is not mistaken for a language switcher", () => {
  const content = "See the [docs](https://example.com/docs) for more.";

  assert.equal(hasOutputIndexLanguageSwitcher(content), false);
  assert.equal(applyOutputIndexLanguageSwitcher(content, "**EN** · [FR](i.md)"), content);
});

test("the entry template is markup with slots and nothing else", async () => {
  for (const format of ["markdown", "html"] as const) {
    const entryTemplate = await bundledEntryTemplate(format);

    assert.match(entryTemplate, /\{\{toVersion\}\}/);
    assert.match(entryTemplate, /\{\{fromVersion\}\}/);
    assert.match(entryTemplate, /\{\{href\}\}/);
    // No heading, no marker, no syntax of the tool's own.
    assert.doesNotMatch(entryTemplate, /<!--/);
    assert.doesNotMatch(entryTemplate, /ai-release-notes/);
  }
});

const v1 = {
  environment: "QUA",
  fromVersion: "v1.0.0",
  toVersion: "v1.1.0",
  date: "2026-07-21",
  href: "release-notes_v1.0.0_v1.1.0.html",
};
const first = {
  environment: "QUA",
  fromVersion: "start",
  toVersion: "v1.0.0",
  date: "2026-06-02",
  href: "release-notes_start_v1.0.0.html",
};

function renderAll(records: typeof v1[], entryTemplate: string, format: "markdown" | "html") {
  return renderOutputIndexReleases({
    records,
    entryTemplate,
    format,
    localizeDate: (date) => date,
  });
}

test("renders an index entry from the bundled HTML entry template", async () => {
  const entryTemplate = await bundledEntryTemplate("html");
  const entry = renderAll([v1], entryTemplate, "html");

  assert.match(entry, /<h2>Release v1\.1\.0<\/h2>/);
  assert.match(entry, /QUA · 2026-07-21 · Changes since v1\.0\.0/);
  assert.match(entry, /<a href="release-notes_v1\.0\.0_v1\.1\.0\.html">Read release notes/);
});

test("a custom entry template decides everything an entry shows", async () => {
  const entry = renderAll([v1], "<li>{{toVersion}} — {{date}}</li>", "html");

  assert.match(entry, /<li>v1\.1\.0 — 2026-07-21<\/li>/);
  assert.doesNotMatch(entry, /Changes since/);
});

test("escapes index entry values in HTML but not rendered slots", async () => {
  const entryTemplate = await bundledEntryTemplate("html");
  const entry = renderAll([{ ...v1, environment: '<script>"x"' }], entryTemplate, "html");
  const [, page] = entry.split("-->");

  assert.match(page, /&lt;script&gt;&quot;x&quot;/);
  assert.doesNotMatch(page, /<script>/);
  // The comparison and the links are template output, already escaped once.
  assert.match(page, /<a href="release-notes_v1\.0\.0_v1\.1\.0\.html">/);
});

test("a record cannot close its own comment marker", async () => {
  const entryTemplate = await bundledEntryTemplate("html");
  const environment = '--><script>alert(1)</script>';
  const entry = renderAll([{ ...v1, environment }], entryTemplate, "html");

  // One terminator, the marker's own: the raw value stays sealed in the
  // comment, and the page below it only ever sees the escaped form.
  assert.equal(entry.match(/-->/g)?.length, 1);
  assert.doesNotMatch(entry.split("-->")[1], /<script>/);
  assert.equal(readOutputIndexReleaseRecords(entry)[0].environment, environment);
});

test("an entry carries the record its next rendering is built from", async () => {
  const entryTemplate = await bundledEntryTemplate("html");
  const rendered = renderAll([v1, first], entryTemplate, "html");

  assert.deepEqual(readOutputIndexReleaseRecords(rendered), [v1, first]);
});

test("re-rendering an index relabels every release it lists", async () => {
  const entryTemplate = await bundledEntryTemplate("html");
  const index = replaceOutputIndexReleases(
    "<main>\n<!-- ai-release-notes:releases -->\n<!-- ai-release-notes:/releases -->\n</main>",
    renderAll([v1, first], entryTemplate, "html")
  );
  const records = readOutputIndexReleaseRecords(readOutputIndexReleasesRegion(index));

  const translated = entryTemplate
    .replace("Changes since", "Changements depuis")
    .replace("Read release notes", "Voir les notes de version");
  const relabelled = replaceOutputIndexReleases(index, renderAll(records, translated, "html"));

  assert.equal(relabelled.match(/Changements depuis/g)?.length, 2);
  assert.equal(relabelled.match(/Voir les notes de version/g)?.length, 2);
  assert.doesNotMatch(relabelled, /Changes since/);
  assert.equal(relabelled.match(/<section class="release-entry">/g)?.length, 2);
});

test("a rerun of the same release replaces its entry instead of adding one", () => {
  const updated = upsertOutputIndexReleaseRecord([v1, first], { ...v1, date: "2026-07-22" });

  assert.equal(updated.length, 2);
  assert.equal(updated[0].date, "2026-07-22");
  assert.equal(updated[1], first);
});

test("a new release opens the list", () => {
  const updated = upsertOutputIndexReleaseRecord([first], v1);

  assert.deepEqual(updated, [v1, first]);
});

test("entries written without a record are kept word for word", () => {
  const region = `<!-- ai-release-notes:release QUA_v0.9.0_v1.0.0 -->
<section class="release-entry"><h2>Version 1.0.0</h2></section>
<!-- ai-release-notes:release ${JSON.stringify(v1)} -->
<section class="release-entry"><h2>Release v1.1.0</h2></section>`;

  const legacy = readLegacyOutputIndexEntries(region, [outputIndexReleaseId(v1)]);

  assert.equal(legacy.length, 1);
  assert.match(legacy[0], /<h2>Version 1\.0\.0<\/h2>/);
  assert.doesNotMatch(legacy[0], /v1\.1\.0/);
});

test("a legacy entry gives way once its release is rendered from a record", () => {
  const region = `<!-- ai-release-notes:release QUA_v1.0.0_v1.1.0 -->\n<section>old</section>`;

  assert.deepEqual(readLegacyOutputIndexEntries(region, [outputIndexReleaseId(v1)]), []);
});

test("a summary template does not declare the entry shape itself", async () => {
  for (const format of ["markdown", "html"] as const) {
    const extension = format === "html" ? "html" : "md";
    const summary = await readFile(
      resolve(import.meta.dirname, `../templates/default-release-summary.${extension}`),
      "utf-8"
    );

    // The entry shape lives in its own file, and an index stores nothing of it.
    assert.doesNotMatch(summary, /ai-release-notes:item/);
    assert.match(summary, /\{\{releases\}\}/);
  }
});

test("a generated page is the bundled release-note template", () => {
  const html = markdownToHtml("# Release\n\nContent");

  assert.match(html, /<h1>Release<\/h1>/);
  // The look comes from the template, never from markup spelled out in code.
  assert.match(html, /\.release-entry \{/);
  assert.doesNotMatch(html, /\{\{\w+\}\}/);
});
