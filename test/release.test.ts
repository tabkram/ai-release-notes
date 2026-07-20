import assert from "node:assert/strict";
import test from "node:test";
import { markdownToHtml, renderReleaseNoteHtml } from "../src/release.js";

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
