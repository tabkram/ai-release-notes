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
| `--lang <language>` | Write one configured language only (default: all of them) |
| `--config <path>` | Path to config file |
| `--output <path>` | Output file path (overrides `output.saveTo`) |
| `--to-dir <dir>` | Write the release into this folder (auto-names the file) |
| `--format <markdown\|html>` | Output format (default: `markdown`) |
| `--template <path>` | Custom template file |
| `--changelog-file <path>` | Raw changelog file (skip git) |
| `--context <paths...>` | Context files or directories (mixed) |
| `--dry-run` | Show prompts without calling LLM |
| `-v, --verbose` | Show applied instructions and generation steps |
| `--stdout` | Write generated Markdown to standard output without saving files or indexes |
| `--clipboard` | Copy result to clipboard |

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
