# Examples

This folder contains a small configuration for a project called ACME Platform.
Use it as a starting point, then make the words and file paths your own.

## 1. Start with the example

Copy `.ai-release-notes.yml` to your project root.

Set the API key for the provider selected in the file:

```bash
export ANTHROPIC_API_KEY=your-key
```

Then generate a release:

```bash
npx ai-release-notes generate \
  --to v1.28.0 \
  --with claude \
  --env PROD \
  --date tag
```

Omitting `--from` is the same as passing `--from start`: both include the
full Git history through the `--to` ref. Pass a tag or ref to `--from` when
you only want the commits after that point. With no previous version to compare
against, the release note says `First release` where that comparison would go,
and `{from}` in a file name becomes `start`.

The example writes one release file and updates a shared output index. It
reports those file paths in the terminal. Use `--stdout` when you want to
generate Markdown for the terminal only, without writing those files.

```text
your-project/
├── .ai-release-notes.yml
├── .ai-release-instructions.md       (optional)
├── .ai-output-index-template.md      (optional)
└── releases/
    ├── RELEASE_INDEX_PROD.md
    └── RELEASE_NOTES_PROD_v1.25.9_v1.28.0.md
```

`RELEASE_NOTES_...` contains the release content. `RELEASE_INDEX_...` is a
short list of releases with links to those files.

## 2. Tell the writer what to say

Use an instructions file when your team has rules that should apply to every
release. In `.ai-release-notes.yml`, point to the file:

```yaml
prompt:
  languages:
    - en
    - fr
  instructions:
    file: ./.ai-release-instructions.md
```

Create `.ai-release-instructions.md` with clear, practical guidance:

```md
# Release-note style

- Write for customers, not for developers.
- Start with the customer benefit.
- Group changes under New features, Improvements, and Fixes.
- Keep API names and product names exactly as written.
- Treat any term in double quotes as protected vocabulary: copy it exactly and
  never translate it.
- Do not mention ticket numbers, commit hashes, or internal project names.
- For a breaking change, add a short “Action required” note.
```

Keep this file focused on tone, wording, and rules. The git commits still
provide the facts. Its content replaces the built-in `{{instructions}}` block,
so include every rule and section name your project needs.

The first language is written from the changelog. Each later language is a
translation of that finished release note: terminology rules are preserved,
but the translator does not regroup, add, remove, or reorganize its content.
Run with `--verbose` to confirm that the instructions file was loaded.

## 3. Customize the output index

The `outputIndex` file is the release landing page. It is updated after every
generation and links to each release file.

```yaml
outputIndex:
  format: markdown
  saveTo: ./releases/RELEASE_INDEX_{env}_{lang}.md
  # Uncomment after creating the file:
  # template: ./.ai-output-index-template.md
```

Create `.ai-output-index-template.md` to control its introduction and layout:

```md
# {{projectName}} release notes

A concise release history for {{environment}}.

{{languages}}

<!-- ai-release-notes:releases -->
{{releases}}

---
_Generated with ai-release-notes v{{version}}._
```

Write the surrounding text freely. For an `_es` index, the CLI translates the
template text while preserving `{{projectName}}`, `{{environment}}`,
`{{languages}}`, `{{releases}}`, and `{{version}}`. Keep the
`ai-release-notes:releases` marker and the `{{releases}}` token: together they
open the release list. A matching `<!-- ai-release-notes:/releases -->` is
written for you where the list ends, and from then on those two lines bound the
part of the file the tool rewrites. Everything outside them stays yours.

`{{languages}}` renders links to every localized index in Markdown and styled
buttons in HTML, with the current language highlighted. Put the token on its
own line at the desired content position in a custom index template. The
spelling `{{langages}}` is also accepted. The slot is spent the first time the
index is written: afterwards the switcher is recognized by the markup it was
rendered as, so a published page carries a switcher and no marker of ours. The
switcher is available when the index path contains `{lang}`, so each configured
language has a sibling index to link to; with a single language, nothing is
rendered. Previously generated sibling indexes are discovered too: if `en`
already exists and the current prompt contains `[fr, it]`, every index links to
`en`, `fr`, and `it`. Remove an old localized index file when it should no
longer appear.

To publish an HTML index instead, change the format and file extension:

```yaml
outputIndex:
  format: html
  saveTo: ./releases/RELEASE_INDEX_{env}_{lang}.html
  # Uncomment after creating the file:
  # template: ./.ai-output-index-template.html
```

## 4. Choose the release-file layout

The `output` section controls the release files themselves. Use `{env}` for
the environment and `{from}` / `{to}` for the version range.

```yaml
output:
  - format: markdown
    saveTo: ./releases/RELEASE_NOTES_{env}_{from}_{to}.md
  - format: html
    saveTo: ./releases/RELEASE_NOTES_{env}_{from}_{to}.html
```

This produces one Markdown and one HTML file per release. The output index
links to both files. If `--from` is omitted, the filename uses `start`.

For several languages, add them in the order you want:

```yaml
prompt:
  languages: [en, fr]

output:
  - format: markdown
    saveTo: ./releases/RELEASE_NOTES_{env}_{lang}_{from}_{to}.md

outputIndex:
  format: markdown
  saveTo: ./releases/RELEASE_INDEX_{env}_{lang}.md
```

This creates a release file and an output index per language. The default index
template includes the language switcher; a custom template can position it with
`{{languages}}` or `{{langages}}`.

## 5. Decide what one listed release shows

The index template writes the page around the list; an *entry* template writes
one release inside it. The bundled Markdown one is five lines:

```md
## Release {{toVersion}}

_{{environment}} · {{date}} · Changes since {{fromVersion}}_

[Read release notes →]({{href}})
```

The slots are `{{environment}}`, `{{date}}`, `{{fromVersion}}`, `{{toVersion}}`
and `{{href}}`. Every other word — the label `Release`, the separators, the link
text — is the template's, so replacing the file replaces the wording:

```yaml
outputIndex:
  format: markdown
  saveTo: ./releases/RELEASE_INDEX_{env}_{lang}.md
  entryTemplate: ./.ai-index-entry-template.md
```

The file is read on every run, and each listed release stores what the index
knows about it — environment, versions, date, link — in a comment marker beside
it. The whole list is rendered again from those records at each generation, so
editing the entry template, or generating the index in another language,
relabels the entire history rather than only the release being added.

An entry that carries no record is kept word for word below the rendered ones,
since there is nothing to render it from.

## 6. Restyle the release page

An HTML release note is rendered inside `templates/default-release-note.html`.
That file owns the whole page — its `<title>`, its footer, its styles — and
nothing is added around it. Copy it, edit it, and point `template` at your copy:

```yaml
output:
  - format: html
    saveTo: ./releases/RELEASE_NOTES_{env}_{from}_{to}.html
    template: ./.ai-release-page.html
```

The slots filled in a page template are `{{content}}`, `{{projectName}}`,
`{{fromVersion}}`, `{{toVersion}}`, `{{environment}}`, `{{date}}` and
`{{version}}`. Anything else is left exactly as written, so the page title
belongs in the template's own `<title>`.

## 7. Move a release to the next environment

Generating is for a release nobody has read yet. Once QUA's notes have been
read and corrected, PROD gets the same words rather than new ones:

```bash
npx ai-release-notes promote --from-env QUA --to-env PROD
```

No prompt is built and no provider is called, so no API key is needed. With the
layout from step 4, the QUA files are found by their names, the range PROD is
missing is worked out from them, and the PROD files and index are written.

If PROD is several releases behind, every release in between comes along and
the notes are merged into the one note covering the whole range: sections
carrying the same heading become one section, their lists become one list, and
a line two releases share is listed once. `--merge concat` keeps each note
whole instead.

`--dry-run` shows the plan — which releases would be taken, into which files —
without writing anything:

```bash
npx ai-release-notes promote --from-env QUA --to-env PROD --dry-run
```

When each environment lives in its own folder and the path does not name it,
name the folders instead:

```bash
npx ai-release-notes promote --from-dir ./releases/env1 --to-dir ./releases/env2
```
