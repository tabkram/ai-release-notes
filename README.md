# 🤖 ai-release-notes

Generic AI-powered release notes generator using the [Vercel AI SDK](https://sdk.vercel.ai).

Transform your git changelog into clean, business-readable release notes — with support for OpenAI, Anthropic, Mistral, Google, Ollama, and more.

**Fully customizable** via configuration: language, instructions, output format, templates, and context files.

**Security-first**: API keys are never stored in config files. Only the key for your chosen provider is required via environment variable.

---

## Installation

### Global (CLI usage)
```bash
npm install -g ai-release-notes
```

### Local (programmatic usage)
```bash
npm install ai-release-notes
```

---

## Quick Start

### 1. Providers and API Keys

API keys are **never** stored in config files. Only the key for the active provider is read from environment variables at runtime.

| Provider | CLI alias | Environment variable | Default models | Setup guide |
|----------|-----------|----------------------|----------------|-------------|
| OpenAI | `gpt4`, `gpt`, or default | `OPENAI_API_KEY` | GPT-4o, GPT-4o-mini | [Get an OpenAI key](docs/api-keys.md#openai) |
| Anthropic | `claude` | `ANTHROPIC_API_KEY` | Claude 3.5 Sonnet, Claude 3 Opus | [Get an Anthropic key](docs/api-keys.md#anthropic-claude) |
| Mistral | `mistral` | `MISTRAL_API_KEY` | Mistral Large, Mistral Medium | [Get a Mistral key](docs/api-keys.md#mistral) |
| Google | `gemini` | `GOOGLE_API_KEY` | Gemini 1.5 Pro, Gemini 1.5 Flash | [Get a Google key](docs/api-keys.md#google-gemini) |
| Azure OpenAI | `azure` | `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_ENDPOINT` | GPT-4o via Azure | [Get Azure credentials](docs/api-keys.md#azure-openai) |
| Ollama | `ollama` | None for local use; optional `OLLAMA_API_KEY` for Ollama Cloud | Local models, including Llama and Mistral | [Set up Ollama](docs/api-keys.md#ollama) |

#### Setting environment variables

**macOS / Linux:**
```bash
export OPENAI_API_KEY=sk-...
```

**Windows (PowerShell):**
```powershell
$env:OPENAI_API_KEY="sk-..."
```

**Windows (CMD):**
```cmd
set OPENAI_API_KEY=sk-...
```

**`.env` file (with dotenv):**
```bash
# Install dotenv-cli
npm install -g dotenv-cli

# Run with env file
dotenv -e .env -- npx ai-release-notes generate --from v1.0.0 --to v1.1.0 --env PROD
```

### 2. Initialize configuration

```bash
npx ai-release-notes init
```

This creates `.ai-release-notes.yml` in your project root. **No API keys are stored in this file.**

### 3. Generate release notes

```bash
# Uses the default provider (openai) — needs OPENAI_API_KEY
npx ai-release-notes generate --from v1.0.0 --to v1.1.0 --env PROD

# Uses Anthropic — needs ANTHROPIC_API_KEY
npx ai-release-notes generate --from v1.0.0 --to v1.1.0 --env PROD --with claude

# Uses Mistral — needs MISTRAL_API_KEY
npx ai-release-notes generate --from v1.0.0 --to v1.1.0 --env PROD --with mistral
```

The command saves files according to your configuration and reports the paths
it updated. To generate notes for the terminal only—without writing release
files or indexes—use `--stdout`. The Markdown is written to standard output;
status and token information go to standard error:

```bash
npx ai-release-notes generate --from v1.25.9 --to v1.28.0 --with mistral --env PROD --stdout
```

`--dry-run` is different: it shows the prompt without calling the AI provider.
Use `--verbose` to see the instruction source, main language, and configured
translation steps. It reports execution details, not private model reasoning.

After a generation, the command shows the provider-reported input, output,
and total token counts, together with the number of model calls and elapsed
time. Translated releases include every translation call in these totals.

## CLI Options

| Option | Description |
|--------|-------------|
| `--from <version>` | Previous version tag |
| `--to <version>` | Current version tag |
| `--env <env>` | **Required.** Environment name (PROD, STAGING, etc.) |
| `--release-date <value>` | Release date: `now` (default), `tag`, or an ISO date such as `2026-07-20` |
| `--date <value>` | Alias for `--release-date` |
| `--with <provider>` | LLM override; see [provider aliases](#1-providers-and-api-keys) |
| `--config <path>` | Path to config file |
| `--output <path>` | Output file path (overrides `output.saveTo`) |
| `--output-dir <dir>` | Output directory (auto-names the file) |
| `--format <md\|html>` | Output format (default: `md`) |
| `--template <path>` | Custom template file |
| `--changelog <path>` | Raw changelog file (skip git) |
| `--context <paths...>` | Context files or directories (mixed) |
| `--dry-run` | Show prompts without calling LLM |
| `-v, --verbose` | Show applied instructions and generation steps |
| `--stdout` | Write generated Markdown to standard output without saving files or indexes |
| `--clipboard` | Copy result to clipboard |

### Release date

Use the current date (the default), the selected `--to` tag's creation date,
or an explicit ISO date:

```bash
ai-release-notes generate --from v1.25.9 --to v1.28.0 --env PROD --release-date now
ai-release-notes generate --from v1.25.9 --to v1.28.0 --env PROD --release-date tag
ai-release-notes generate --from v1.25.9 --to v1.28.0 --env PROD --release-date 2026-07-20
```

In the library API, pass the same values as `releaseDate`. The older `date`
field remains available when you need to supply an already formatted display
date.

---

## Configuration

`.ai-release-notes.yml` describes your project and where generated files
belong. Keep API keys in environment variables; they are never stored in the
configuration file.

The main parts are simple:

- `projectName` gives the generated notes their product name.
- `provider` chooses the AI provider; `providers` lets you set its model and
  generation options.
- `prompt` selects the release languages and can point to an instructions file
  when your team has writing rules. Its content replaces the built-in release
  instructions through the `{{instructions}}` section.
- `output` lists the Markdown and/or HTML release files to create. Use
  `{env}`, `{lang}`, `{from}`, and `{to}` in their names. Missing `--from` and
  `--to` become `start` and `end`.
- `outputIndex` is optional. It maintains a release summary with links to
  every release file. It may be one destination or a list, for example one
  Markdown and one HTML summary. Add `{lang}` when each language needs its own
  summary. Index templates can place links between those summaries with
  `{{languages}}` (or `{{langages}}`). The switcher merges languages from the
  current prompt with localized index files already present on disk.

Custom instruction and summary templates are optional. The generated config
keeps their lines commented until you need them.

For the exact configuration and comments, see the annotated
[example `.ai-release-notes.yml`](examples/.ai-release-notes.yml). The
[examples guide](examples/README.md) then walks through a first run, writing
instructions, templates, and output layouts.

---

## Context Files

Provide additional context to the LLM. Accepts a **mixed array** of files and directories:

```bash
npx ai-release-notes generate --from v1.0.0 --to v1.1.0 --env PROD \
  --context ./specs/main.md ./docs/models/ ./README.md
```

---

## Programmatic API

```typescript
import { generate } from "ai-release-notes";

const result = await generate({
  fromVersion: "v1.0.0",
  toVersion: "v1.1.0",
  environment: "PROD",
  provider: "claude",  // only ANTHROPIC_API_KEY is needed
  format: "html",
  outputDir: "./docs/releases",
  context: ["./specs/api-v2.md", "./docs/models/"],
});

console.log(result.markdown);
console.log(result.html);
```

---

## CI/CD Integration

### GitHub Actions

```yaml
name: Release Notes
on:
  push:
    tags: ["v*"]

jobs:
  release-notes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - run: npm install -g ai-release-notes

      - name: Generate
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: |
          CURRENT=${GITHUB_REF#refs/tags/}
          PREVIOUS=$(git describe --tags --abbrev=0 ${CURRENT}^)
          ai-release-notes generate --from $PREVIOUS --to $CURRENT --env PROD --output RELEASE_NOTES.md

      - uses: softprops/action-gh-release@v1
        with:
          body_path: RELEASE_NOTES.md
```

---

## Contributing 🤝

If you find any issues or have suggestions for improvement, feel free to open an issue or submit a pull request.
Contributions are welcome!

Before getting started, please read our [Contribution Guidelines](CONTRIBUTING.md).

This project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md); security issues should follow the [Security Policy](security.md).

## Community 👥

Love `ai-release-note` ? Give our repo a star ⭐ ⬆️.

## License 📄

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
