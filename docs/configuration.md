# Configuration

`.ai-release-notes.yml` describes your project and where generated files belong.
Create it with `npx ai-release-notes init` (`-g` writes it to your home
directory, `-f` overwrites an existing one). Keep API keys in environment
variables; they are never stored in the configuration file.

The main parts are simple:

- `projectName` gives the generated notes their product name.
- `provider` chooses the AI provider; `providers` lets you set its model and
  generation options.
- `prompt` selects the release languages and where the writing rules come from.
  See [Instructions](instructions.md).
- `output` lists the Markdown and/or HTML release files to create. Use `{env}`,
  `{lang}`, `{from}`, and `{to}` in their names. Missing `--from` and `--to`
  become `start` and `end`. A name carrying `{from}` or `{to}` belongs to a
  single release, so regenerating it rewrites that file. A name without either is
  shared by every release, and each new one is added to it.
- `outputIndex` is optional. It maintains a release summary with links to every
  release file. It may be one destination or a list, for example one Markdown and
  one HTML summary. Add `{lang}` when each language needs its own summary.
  `entryTemplate` sets the shape of one listed release; see
  [Index entries](#index-entries). Index templates can place links between those
  summaries with `{{languages}}` (or `{{langages}}`). That slot is spent the
  first time an index is written: afterwards the switcher is found by the markup
  it was rendered as, so a generated page carries a switcher rather than a marker
  of ours. A single language shows no switcher at all. The switcher merges
  languages from the current prompt with localized index files already present on
  disk. An index template is assumed to be written in the first
  `prompt.languages` entry, and an index in any other language is translated.

Custom instruction and summary templates are optional. The generated config keeps
their lines commented until you need them.

For the exact configuration and comments, see the annotated
[example `.ai-release-notes.yml`](../examples/.ai-release-notes.yml). The
[examples guide](../examples/README.md) then walks through a first run, writing
instructions, templates, and output layouts.

## Index entries

One listed release is one template: markup with `{{slot}}` placeholders, and
nothing else. The bundled one lives in
`templates/default-release-summary-entry.md` and `.html`:

```html
<section class="release-entry">
<h2>Release {{toVersion}}</h2>
<p><em>{{environment}} · {{date}} · Changes since {{fromVersion}}</em></p>
<p><a href="{{href}}">Read release notes</a></p>
</section>
```

The slots are `{{environment}}`, `{{date}}`, `{{fromVersion}}`, `{{toVersion}}`
and `{{href}}`. Everything else is yours to write. Point `entryTemplate` at your
own file to replace it:

```yaml
outputIndex:
  - format: html
    saveTo: ./releases/{env}/{lang}/index.html
    template: ./templates/summary.html
    entryTemplate: ./templates/entry.html
```

The entry template is read from its file on every run and translated together
with the summary template, so an index never carries a copy of it: editing the
file is what changes the shape.

Each entry stores what the index knows about its release — environment, versions,
date, link — in a comment marker, and the whole list is rendered again on every
run. Edit the entry template, or switch the index to another language, and the
entire history is relabelled at the next release. The list is bounded by
`<!-- ai-release-notes:releases -->` and `<!-- ai-release-notes:/releases -->`;
everything outside those two lines belongs to the summary template.

An entry that carries no record is kept word for word, below the rendered ones,
since there is nothing to render it from.

## The release page

An HTML release note is rendered inside `templates/default-release-note.html`,
and that file owns every word of the page: its `<title>`, its footer, and its
styles are the template's own. `--template` (or `output[].template`) points at a
file of yours instead. These slots are filled, and anything else is left as
written:

| Slot | Value |
|------|-------|
| `{{content}}` | The release note itself |
| `{{projectName}}` | `projectName` from the config |
| `{{fromVersion}}` / `{{toVersion}}` | The version range |
| `{{environment}}` | `--env` |
| `{{date}}` | The resolved release date |
| `{{version}}` | The `ai-release-notes` version |

A page title is a sentence, so it is written in the template's `<title>` rather
than assembled from the versions: there is no `{{title}}` slot.
