# Generating release notes

`generate` reads the commits between two versions and writes the release notes
your configuration describes.

```bash
# The full Git history through v1.1.0
npx ai-release-notes generate --to v1.1.0 --env PROD

# One range, with the default provider (openai) — needs OPENAI_API_KEY
npx ai-release-notes generate --from v1.0.0 --to v1.1.0 --env PROD

# Uses Anthropic — needs ANTHROPIC_API_KEY
npx ai-release-notes generate --from v1.0.0 --to v1.1.0 --env PROD --with claude

# Uses Mistral — needs MISTRAL_API_KEY
npx ai-release-notes generate --from v1.0.0 --to v1.1.0 --env PROD --with mistral
```

The command saves files according to your configuration and reports the paths it
updated.

## CLI options

| Option | Description |
|--------|-------------|
| `--from <version>` | Previous version tag, or `start` for the full history (default: `start`) |
| `--to <version>` | Current version tag |
| `--env <env>` | **Required.** Environment name (PROD, STAGING, etc.) |
| `--date <date>` | Release date: `now` (default), `tag`, or an ISO date such as `2026-07-20` |
| `--with <provider>` | LLM override; see [provider aliases](../README.md#1-providers-and-api-keys) |
| `--model <model>` | Model override for the selected provider |
| `--temperature <number>` | Generation temperature override, from `0` to `2` |
| `--max-tokens <number>` | Maximum output tokens override |
| `--base-url <url>` | Provider base URL override |
| `--lang <language>` | Write one configured language only (default: all of them) |
| `--config <path>` | Path to config file |
| `--output <path>` | Output file path (overrides `output.saveTo`) |
| `--to-dir <dir>` | Write the release into this folder (auto-names the file) |
| `--format <markdown\|html>` | Output format (default: `markdown`) |
| `--template <path>` | Custom template file |
| `--changelog-file <path>` | Raw changelog file (skip git) |
| `--context <paths...>` | Context files or directories (mixed) |
| `--dry-run` | Show prompts without calling LLM or writing output |
| `--force` | Replace existing release documents, including files created by older versions |
| `-v, --verbose` | Show applied instructions and generation steps |
| `--stdout` | Write generated Markdown to standard output without saving files or indexes |
| `--clipboard` | Copy result to clipboard |

## Automatic resumption

For outputs that name one file per release and language, `generate` saves each
completed language immediately, then updates its index. If a later translation
or index fails, the completed files are already at their configured final paths.
Run the same command again to complete missing outputs. No resume flag is needed.

Existing documents are preserved, including notes written by an older version
with no generation metadata. Missing translations are made from the saved primary
note (the first configured language), including manual corrections. For HTML,
only the release body is extracted and converted locally to Markdown; the page,
styles and footer are not sent as translation content.

A single `.release-notes-state.json` ledger in the common output directory
holds one entry per environment and version range. The directory is derived from
the output patterns before language/version placeholders, so adding a language
or changing the selected range does not create another ledger. Set `stateFile`
in the configuration to choose an explicit path (for example,
`./releases/{env}/.release-notes-state.json`).

Each entry can contain a recorded `deployment` date and `notesSkipped` fact,
alongside `generation` metadata: original generation date, request fingerprint,
completed files, source fingerprints, pending replacements and index progress.
Generation status is `pending` until all configured outputs and indexes are
verified, then `complete`. Completing generation preserves the deployment record.
There is no TTL and no duplicate note content, prompts or API credentials.
Missing files are repaired even when an old entry says they finished. A failed
explicit regeneration stays pending while its old final document remains usable.

Former `.pending-release-notes.json` records are imported with their original
ranges and deployment dates. A former per-note `.generation.json` is imported
when that range is resumed, remapping file paths into the shared ledger. Old
files are removed only after their state has been saved successfully. For a
recorded skipped deployment, its date is the default when generation has not
started and no date override is supplied.

If the primary note changes, the next run automatically retranslates all selected
secondary languages whose recorded source fingerprint is stale, replacing their
content, including manual corrections. The console reports each automatic
replacement and names the primary language that changed. Otherwise their manual
corrections are preserved. Without an old source
fingerprint, existing translations are adopted as reviewed; use `--force`
if they need replacing. `--lang` limits the requested outputs; other languages
are checked on their next run.

`--force` deliberately replaces the selected existing documents, whether or
not they have recorded generation state. When French is a secondary language,
`--force --lang fr` retains the saved primary note and replaces French from it.
`--no-cache` independently bypasses API response
caching: it does not discard final documents. Use both flags for fresh model
calls and replacement output:

```bash
ai-release-notes generate --from v1 --to v2 --env QUA --force --no-cache
```

`--force` replaces the former `--regenerate` option; the old name is no longer
accepted. The corresponding API option is `force: true`.

Adding a secondary language completes only that missing language.

A changed release date or generation request is reported instead of silently
mixing documents from different inputs; use `--force` to replace them.
Retry settings and cache controls do not change the request fingerprint. A
resumed `--date now` run retains the ledger's original date across days.

Progressive persistence applies to separate release/language files. Cumulative
changelogs and combined multi-language files retain their existing append/save
behavior. `--stdout` and `--dry-run` never write files, indexes or progress state.

## Terminal only

To generate notes for the terminal only — without writing release files or
indexes — use `--stdout`. The Markdown is written to standard output; status and
token information go to standard error:

```bash
npx ai-release-notes generate --from v1.25.9 --to v1.28.0 --with mistral --env PROD --stdout
```

`--dry-run` is different: it shows the prompt without calling the AI provider.
Use `--verbose` to see the instruction source, main language, and configured
translation steps. It reports execution details, not private model reasoning.

After a generation, the command shows the provider-reported input, output, and
total token counts, together with the number of model calls and elapsed time.
Translated releases include every translation call in these totals.

## Release date

Use the current date (the default), the selected `--to` tag's creation date, or
an explicit ISO date:

```bash
ai-release-notes generate --from v1.25.9 --to v1.28.0 --env PROD --date now
ai-release-notes generate --from v1.25.9 --to v1.28.0 --env PROD --date tag
ai-release-notes generate --from v1.25.9 --to v1.28.0 --env PROD --date 2026-07-20
```

In the library API, pass the same values as `date`.

## The first release

`--from start` — the default — reads the whole history, so there is no previous
version to compare against. The release note says `First release` where a
comparison would go, and the file name still uses `start` for `{from}`.

## Context files

Provide additional context to the LLM. `--context` accepts a **mixed array** of
files and directories:

```bash
npx ai-release-notes generate --from v1.0.0 --to v1.1.0 --env PROD \
  --context ./specs/main.md ./docs/models/ ./README.md
```

Context is sent to your LLM provider, so a directory scan skips what it should
not upload: credential-shaped files, content matching known key formats, binary
files, and `.git`, `.ssh`, `.aws`, `node_modules` and similar. A file you name
explicitly is always loaded, with a warning when it looks sensitive. Scans stop
at 256 KB per file, 1 MB total, 200 files, and 8 directory levels.

## Related

- [Configuration](configuration.md) — output paths, indexes, templates
- [Instructions](instructions.md) — what the model is told to write
- [Promoting a release](promote.md) · [Asking for a change](prompt.md)
