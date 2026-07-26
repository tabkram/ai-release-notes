# Promoting a release to the next environment

A release note written for QUA has already been read, corrected and agreed on.
When that same release reaches PROD, nothing about it has changed — so `promote`
reuses the files QUA already holds instead of asking a model to write them again.
**Promoting one release builds no prompt and calls no provider**, which is also
why no API key is needed:

```bash
# Everything PROD is missing, in one command
npx ai-release-notes promote --from-env QUA --to-env PROD

# Or one explicit range
npx ai-release-notes promote --from-env QUA --to-env PROD --from start --to v0.23.0
```

Each release file names the range it covers, so the files themselves form the
chain — `start → v0.23.0`, `v0.23.0 → v0.24.0`, and so on. Promoting reads that
chain rather than the version numbers, so a project that does not release in
ascending order is followed just as well.

- **One file covers the range** — it is promoted as it stands, word for word.
- **Several files cover it** — they are merged into the one note that covers
  the whole range: sections carrying the same heading become one section,
  their scopes become one scope, their lists become one list, and a line two
  releases both carry is listed once. Inside a list the newest release's lines
  come first, then the ones released before them.
- **A note whose shape cannot be read back** — it is never rewritten to fit.
  The notes are kept whole and put one after another instead. Nothing to
  choose: a note that does not survive being read and written out unchanged
  answers this on its own.

## The one thing a model is asked for

Every section survives that merge word for word — the reviewed wording is the
whole point. What cannot survive it is the opening: three headings, three dates
and three summaries do not add up to one release note. So the merged note is
given a single opening, and that is the one thing a model is asked for:

```text
🚀 Promoting QUA → PROD: v1.25.7 → v1.28.0
   v1.25.7 → v1.26.0
   v1.26.0 → v1.27.0
   v1.27.0 → v1.28.0
   Sections merged word for word; one title and summary written for the range.
```

The model is shown the three openings and nothing else, so it cannot reach the
sections, and an answer that comes back carrying sections of its own is refused.

When no provider is configured, when the call fails, or when the answer is
refused, the newest release's title and summary stand for the range instead,
with the environment and the version it followed pointed at what was actually
promoted. That is a true opening, only narrower than the range it covers, so the
run says so rather than reading as a success:

```text
   ⚠️  The v1.28.0 title and summary stand for the whole range: no provider is configured.
```

With no `--from`, promotion starts where the target environment already is, so
running it twice does nothing the second time. With no `--to`, it goes to the
newest release the source environment holds. The target environment's output
index is updated exactly as a generation would update it.

## Where the files are

Promotion reads and writes the paths `output.saveTo` already describes, so a
layout naming its environment needs nothing else:

```yaml
output:
  - format: html
    saveTo: ./releases/{env}/release-notes_{from}_{to}.html
```

When each environment lives in a folder that the path does not name, point at
the folders instead — their names become the environments:

```bash
npx ai-release-notes promote --from-dir ./releases/env1 --to-dir ./releases/env2
```

A `saveTo` with neither `{from}` nor `{to}` holds every release in one file
rather than one release per file, so there is nothing to promote from it; those
outputs are reported as skipped.

## CLI options

| Option | Description |
|--------|-------------|
| `--from-env <environment>` | Environment to promote from (default: `--from-dir`'s folder name) |
| `--to-env <environment>` | Environment to promote to (default: `--to-dir`'s folder name) |
| `--from <version>` | Start of the range (default: where the target environment is) |
| `--to <version>` | End of the range (default: the newest release in the source) |
| `--from-dir <dir>` / `--to-dir <dir>` | Read/write the releases in these folders |
| `--pattern <pattern>` | File name inside those folders (default: the configured one) |
| `--with <provider>` | LLM provider used to write the opening of a merged range |
| `--lang <language>` | Promote one language only |
| `--date <date>` | Release date: `now` (default), `tag`, or an ISO date |
| `--config <path>` | Path to config file |
| `--dry-run` | Show what would be promoted without writing anything |
| `-v, --verbose` | Show what was promoted, release by release |
| `--stdout` | Write the promoted notes to the terminal without saving files |

An HTML release note is read back out of the page it was written into and
rendered into the template again, so the promoted page states its own
environment, versions and date. A page written through a template this cannot
read is copied as it stands, which is the whole point of promoting.

## Related

- [Generating release notes](generate.md) · [Asking for a change](prompt.md)
- [Programmatic API](api.md#promote) — `promote()` returns the files without writing them
