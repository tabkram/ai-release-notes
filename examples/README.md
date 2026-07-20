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
  --from v1.25.9 \
  --to v1.28.0 \
  --with claude \
  --env PROD \
  --release-date tag
```

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
  languages: [en]
  # Uncomment after creating the file:
  # instructions:
  #   file: ./.ai-release-instructions.md
```

Create `.ai-release-instructions.md` with clear, practical guidance:

```md
# Release-note style

- Write for customers, not for developers.
- Start with the customer benefit.
- Group changes under New features, Improvements, and Fixes.
- Keep API names and product names exactly as written.
- Do not mention ticket numbers, commit hashes, or internal project names.
- For a breaking change, add a short “Action required” note.
```

Keep this file focused on tone, wording, and rules. The git commits still
provide the facts.

## 3. Customize the output index

The `outputIndex` file is the release landing page. It is updated after every
generation and links to each release file.

```yaml
outputIndex:
  format: markdown
  saveTo: ./releases/RELEASE_INDEX_{env}.md
  # Uncomment after creating the file:
  # template: ./.ai-output-index-template.md
```

Create `.ai-output-index-template.md` to control its introduction and layout:

```md
# {{projectName}} release notes

A concise release history for {{environment}}.

<!-- ai-release-notes:releases -->
{{releases}}

---
_Generated with ai-release-notes v{{version}}._
```

Write the surrounding text freely. For an `_es` index, the CLI translates the
template text while preserving `{{projectName}}`, `{{environment}}`,
`{{releases}}`, and `{{version}}`. Keep the `ai-release-notes:releases`
marker: new release links are inserted directly below it.

To publish an HTML index instead, change the format and file extension:

```yaml
outputIndex:
  format: html
  saveTo: ./releases/RELEASE_INDEX_{env}.html
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
links to both files. If `--from` or `--to` is omitted, the filename uses
`start` or `end` for that part.

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

This creates a release file and an output index per language.
