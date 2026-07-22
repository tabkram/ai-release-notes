import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOutputIndexLanguageSwitcher,
  insertOrUpdateOutputIndexReleaseEntry,
  markdownToHtml,
  renderOutputIndexLanguageSwitcher,
  renderReleaseNoteHtml,
} from "../src/release.js";

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

  assert.match(html, /<footer>v1\.0\.0<\/footer>/);
  assert.doesNotMatch(html, /{{version}}/);
});

test("can place a template-defined footer in generated HTML", () => {
  const footer = '<footer>Generated with <a href="https://github.com/tabkram/ai-release-notes">tabkram/ai-release-notes</a></footer>';
  const html = markdownToHtml("Release content", "Release", footer);

  assert.match(html, new RegExp(footer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(html.indexOf(footer) < html.indexOf("</main>"));
});

test("renders Markdown links between localized output indexes", () => {
  const switcher = renderOutputIndexLanguageSwitcher("markdown", [
    { language: "en", href: "RELEASE_INDEX_PROD_en.md", active: true },
    { language: "fr", href: "RELEASE_INDEX_PROD_fr.md", active: false },
  ]);

  assert.match(switcher, /<!-- ai-release-notes:languages -->/);
  assert.match(switcher, /\*\*EN\*\* · \[FR\]\(RELEASE_INDEX_PROD_fr\.md\)/);
  assert.match(switcher, /<!-- ai-release-notes:\/languages -->/);
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

  assert.equal(updated.match(/<!-- ai-release-notes:languages -->/g)?.length, 1);
  assert.equal(updated.match(/<nav class="language-switcher"/g)?.length, 1);
});

test("keeps language markers when only one localized index exists", () => {
  const switcher = renderOutputIndexLanguageSwitcher("markdown", [
    { language: "en", href: "index_en.md", active: true },
  ]);

  assert.equal(
    switcher,
    "<!-- ai-release-notes:languages -->\n<!-- ai-release-notes:/languages -->"
  );
});

test("updating a release entry preserves a switcher placed after the releases", () => {
  const releaseId = "PROD_v1.0.0_v1.1.0";
  const oldEntry = `<!-- ai-release-notes:release ${releaseId} -->\n## Old release`;
  const newEntry = `<!-- ai-release-notes:release ${releaseId} -->\n## Updated release`;
  const switcher = renderOutputIndexLanguageSwitcher("markdown", [
    { language: "en", href: "index_en.md", active: true },
    { language: "fr", href: "index_fr.md", active: false },
  ]);
  const existing = `# Index

<!-- ai-release-notes:releases -->
${oldEntry}
<!-- ai-release-notes:/releases -->

${switcher}

---
Footer
`;

  const updated = insertOrUpdateOutputIndexReleaseEntry(existing, newEntry, releaseId);

  assert.doesNotMatch(updated, /Old release/);
  assert.match(updated, /Updated release/);
  assert.match(updated, /<!-- ai-release-notes:languages -->/);
  assert.match(updated, /Footer/);
});

test("legacy indexes stop release replacement before a following language switcher", () => {
  const releaseId = "PROD_v1.0.0_v1.1.0";
  const marker = `<!-- ai-release-notes:release ${releaseId} -->`;
  const existing = `${marker}\n## Old\n<!-- ai-release-notes:languages -->\nButtons\n<!-- ai-release-notes:/languages -->`;
  const updated = insertOrUpdateOutputIndexReleaseEntry(
    existing,
    `${marker}\n## New`,
    releaseId
  );

  assert.match(updated, /## New/);
  assert.match(updated, /Buttons/);
});
