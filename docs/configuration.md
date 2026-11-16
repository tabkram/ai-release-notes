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

The commands that call a model also accept optional `--model`, `--temperature`,
`--max-tokens`, and `--base-url` overrides. A supplied command-line value wins
over the selected provider's configuration; omitted values continue to come
from this file.

For the exact configuration and comments, see the annotated
[example `.ai-release-notes.yml`](../examples/.ai-release-notes.yml). The
[examples guide](../examples/README.md) then walks through a first run, writing
instructions, templates, and output layouts.

## Caching model requests

Successful model responses are cached locally for seven days by default:

```yaml
cache:
  enabled: true
  ttl: 7d

providers:
  anthropic:
    model: claude-sonnet-4-20250514
    promptCache:
      enabled: true
      ttl: 1h
```

`--no-cache` forces fresh model calls by bypassing local reads and writes.
`--cache-ttl 30d` overrides the local lifetime; `cache clear` removes local entries.
Provider prompt caching is separate: `--provider-cache-ttl 1h` overrides the
selected provider's lifetime, and `--no-provider-cache` disables explicit cache
options. Automatic server-side caches can remain active.

See [caching](caching.md) for provider/model compatibility, official documentation,
partial-failure recovery, and API overrides. Unsupported provider TTLs fail
before sending a model request; durations are never silently shortened.

## Retrying model requests

Retry settings belong to the selected provider, alongside its model:

```yaml
providers:
  mistral:
    model: ministral-3b-latest
    maxRetries: 5
    initialRetryDelayMs: 5000
```

`maxRetries` counts additional attempts after the first request. It defaults to
the SDK's existing two retries; `0` disables retries. `initialRetryDelayMs` sets
the first wait in milliseconds, then doubles it for each retry: `5000` means
5, 10, 20, 40, then 80 seconds with five retries. A longer valid `Retry-After`
or `retry-after-ms` value from the provider takes precedence over that wait.
Both settings accept non-negative integers, including a zero initial delay.
With a custom initial delay, waits are capped at Node's timer limit of
2,147,483,647 milliseconds (about 24.9 days), including provider retry headers.

When `initialRetryDelayMs` is omitted, the SDK's existing retry strategy is
preserved, including its usual two-second initial backoff and handling of retry
headers. Existing configurations need no changes.

`generate`, `promote`, and `prompt` accept `--max-retries` and
`--initial-retry-delay-ms` to override the provider's settings for one run:

```bash
ai-release-notes generate --from v1.37.0 --to v1.38.0 --env QUA \
  --max-retries 5 --initial-retry-delay-ms 5000
```

Only the failed model request is retried. For example, a rate limit while
translating an index template does not regenerate the release notes already
written. Authentication and other non-retryable errors fail immediately;
exhausted retries still report an error. Increasing waits can help with temporary
rate limits, but does not resolve an exhausted account quota.

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

The entry template is read from its file on every run. Creating a localized
index translates the summary and entry templates together. Updating an existing
index translates only the entry template: the page and its CSS are not sent to
the model again. One source template per purpose serves every language, with no
localized files or additional configuration. Release-note generation and
translation are unchanged.

Each entry stores what the index knows about its release — environment, versions,
date, link — in a comment marker. A run inserts or updates its own release;
historical entries keep their reviewed wording and formatting. The list is bounded by
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

## Shared release ledger

```yaml
stateFile: ./releases/{env}/.release-notes-state.json
```

The CLI uses one ledger for deployment records and generation progress, with a
separate entry for each environment/range. Without `stateFile`, its directory is
derived from the common output patterns, before language/version placeholders.
See [automatic resumption](generate.md#automatic-resumption) for the entry fields,
legacy-file migration and the distinction between a recorded deployment and an
unfinished generation. No extra pending file or per-note sidecar is created.
