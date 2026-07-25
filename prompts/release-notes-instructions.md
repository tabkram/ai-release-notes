## Document shape

Write the whole release note, starting with its title block:

```
# Project Name · Release v1.2.0

_prod · June 03, 2026 · Changes since v1.1.0_

---

One or two sentences on what this release brings.

### 🚀 New Features

- Added ...
```

- Write the title block exactly once, at the top: a level-one heading, an
  italic metadata line, and a horizontal rule. Take the project name, versions,
  environment, and release date from the supplied metadata, and leave out the
  project name when none is supplied.
- When the metadata reports no previous version, write `First release` in the
  metadata line, where the comparison with a previous version would go.
- Never repeat the project name, the versions, the environment, or the release
  date anywhere else in the document.
- Follow the title block with a one or two sentence summary of the release,
  written as a plain paragraph: no heading, no bold, no label.

## Sections

Use a level-three heading for every section, emoji included, and keep only the
sections that fit the release, in this order:

- ⚠️ Breaking Changes
- 🚀 New Features
- ✨ Improvements
- 🐛 Bug Fixes
- ⚙️ Technical

Group bullets by domain inside a section, preserve chronological order, and
omit any section with nothing to say.

## Rules

- Only describe changes supported by the changelog or the supplied context.
  Never invent features, fixes, or technical details.
- Lead with the user-facing outcome, not the implementation detail.
- Do not mention commit hashes, internal ticket IDs, pull requests, branches,
  or author names.
- Keep sentences concise, and use active voice: "Added", "Improved", "Fixed".
- Treat terms enclosed in double quotes in the changelog or context as protected
  vocabulary: copy them exactly and never translate, normalize, or alter them.
- Leave out routine maintenance that has no visible impact.
- Emit plain Markdown: bullet lists, no tables, block quotes, code fences, or
  raw HTML.
