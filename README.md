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

### 1. Set your API key (only the one you need)

You only need **one** API key — the one matching the provider you want to use.

```bash
# If you use OpenAI (default)
export OPENAI_API_KEY=sk-...

# If you use Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# If you use Mistral
export MISTRAL_API_KEY=...

# If you use Google
export GOOGLE_API_KEY=...
```

You don't need to set all of them. Just the one you'll use.

> **New to API keys?** See [How to get API keys](#how-to-get-api-keys) below for step-by-step guides for each provider.

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

---

## How to Get API Keys

### OpenAI

1. Go to [platform.openai.com](https://platform.openai.com)
2. Sign up or log in
3. Add a payment method under **Settings > Billing**
4. Go to **API Keys** and click **Create new secret key**
5. Copy the key (shown only once!)
6. Set it as environment variable: `export OPENAI_API_KEY=sk-...`

📖 [Full guide: OpenAI API Key](https://platform.openai.com/api-keys)

---

### Anthropic (Claude)

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up or log in
3. Go to **API Keys** in the sidebar
4. Click **Create Key**
5. Give it a name and copy the key
6. Set it as environment variable: `export ANTHROPIC_API_KEY=sk-ant-...`

📖 [Full guide: Anthropic API Keys](https://docs.anthropic.com/en/api/getting-started)

---

### Mistral

1. Go to [console.mistral.ai](https://console.mistral.ai)
2. Sign up or log in
3. Go to **API Keys** in the sidebar
4. Click **Create API Key**
5. Copy the key
6. Set it as environment variable: `export MISTRAL_API_KEY=...`

📖 [Full guide: Mistral API](https://docs.mistral.ai/getting-started/quickstart/)

---

### Google (Gemini)

1. Go to [Google AI Studio](https://aistudio.google.com)
2. Sign in with your Google account
3. Click **Get API Key** in the sidebar
4. Select or create a Google Cloud project
5. Click **Create API Key**
6. Copy the key
7. Set it as environment variable: `export GOOGLE_API_KEY=...`

📖 [Full guide: Gemini API - Getting Started](https://ai.google.dev/gemini-api/docs/get-started)

> **Note:** Google is transitioning from standard API keys to authorized keys. New keys created in AI Studio are automatically authorized keys. citeweb_search:29#3

---

### Azure OpenAI

1. Go to [Azure Portal](https://portal.azure.com)
2. Create an **Azure OpenAI** resource
3. Once deployed, go to **Keys and Endpoint** in the sidebar
4. Copy **Key 1** or **Key 2**
5. Set it as environment variable: `export AZURE_OPENAI_API_KEY=...`
6. Also set your endpoint: `export AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/`

📖 [Full guide: Azure OpenAI - Create and deploy](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/create-resource)

---

### Ollama (Local, no API key needed!)

Ollama runs entirely on your machine — **no cloud API key required**.

1. Install Ollama: [ollama.com/download](https://ollama.com/download)
2. Pull a model: `ollama pull llama3.1`
3. Start Ollama (runs on `http://localhost:11434`)
4. Use `ai-release-notes` with `--with ollama`

📖 [Full guide: Ollama Documentation](https://github.com/ollama/ollama)

> **Optional:** If you use Ollama Cloud (hosted), set `OLLAMA_API_KEY=sk-...`. For local usage, no key is needed. citeweb_search:29#4

---

## API Keys Summary

API keys are **never** stored in config files. Only the key for the **active provider** is read from environment variables at runtime.

| Provider | Environment Variable | Required if using... | How to get |
|----------|---------------------|----------------------|------------|
| OpenAI | `OPENAI_API_KEY` | `--with gpt4`, `--with gpt`, or default | [platform.openai.com](https://platform.openai.com/api-keys) citeweb_search:29#5 |
| Anthropic | `ANTHROPIC_API_KEY` | `--with claude` | [console.anthropic.com](https://console.anthropic.com) |
| Mistral | `MISTRAL_API_KEY` | `--with mistral` | [console.mistral.ai](https://console.mistral.ai) |
| Google | `GOOGLE_API_KEY` | `--with gemini` | [Google AI Studio](https://aistudio.google.com) citeweb_search:29#2 |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` | `--with azure` | [Azure Portal](https://portal.azure.com) citeweb_search:29#6 |
| Ollama | `OLLAMA_API_KEY` | `--with ollama` | Not needed for local use |

### Setting environment variables

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

---

## CLI Options

| Option | Description |
|--------|-------------|
| `--from <version>` | Previous version tag |
| `--to <version>` | Current version tag |
| `--env <env>` | **Required.** Environment name (PROD, STAGING, etc.) |
| `--date <date>` | Release date |
| `--with <provider>` | LLM override: `claude`, `gpt4`, `mistral`, `gemini`, `ollama` |
| `--config <path>` | Path to config file |
| `--output <path>` | Output file path (overrides `output.saveTo`) |
| `--output-dir <dir>` | Output directory (auto-names the file) |
| `--format <md\|html>` | Output format (default: `md`) |
| `--template <path>` | Custom template file |
| `--changelog <path>` | Raw changelog file (skip git) |
| `--context <paths...>` | Context files or directories (mixed) |
| `--dry-run` | Show prompts without calling LLM |
| `--clipboard` | Copy result to clipboard |

---

## Configuration

The config file (`.ai-release-notes.yml`) contains everything **except** API keys:

```yaml
projectName: My Product

provider: openai

providers:
  openai:
    model: gpt-4o
    temperature: 0.3

  anthropic:
    model: claude-sonnet-4-20250514

# ── Prompt customization ──
prompt:
  languages:
    - en
    - fr
  instructions: |
    - Preserve the terms API, endpoint, and webhook.
    - Use sections for New Features and Bug Fixes when relevant.
    - Do NOT mention commit hashes.
    - Keep sentences concise.

# ── Output settings ──
output:
  - format: markdown
    saveTo: ./RELEASE_NOTES.md
```

### Multiple languages

Set `prompt.languages` in output order. The first language is generated from
the changelog. Each later language is translated from that finished release
note, preserving the facts, Markdown structure, and your inline or file-based
instructions.

```yaml
prompt:
  languages: [en, fr, de]
```

### Saving release history

`output` is a list of format-and-destination definitions. Its `saveTo`
writes release notes automatically when no `--output` or
`--output-dir` is supplied. Releases are added at the top of the file; running
the same `--from` / `--to` range again does not create a duplicate entry.

Use one shared file for every environment:

```yaml
output:
  - format: markdown
    saveTo: ./RELEASE_NOTES.md
```

Use `{env}` only when you want separate files. It is replaced with the
uppercased environment passed through `--env`:

```yaml
output:
  - format: markdown
    saveTo: ./releases/release-notes-{env}.md
```

```bash
ai-release-notes generate --from v1.25.9 --to v1.28.0 --with mistral --env PROD
# writes ./releases/release-notes-PROD.md
```

Use `{from}` and `{to}` to include the versions passed through `--from` and
`--to` in the output filename. When either option is omitted, its placeholder
is replaced with `start` or `end`, respectively:

```yaml
output:
  - format: markdown
    saveTo: ./RELEASE_NOTES_{env}_{from}_{to}.md
```

```bash
ai-release-notes generate --from v1.25.9 --to v1.28.0 --with mistral --env PROD
# writes ./RELEASE_NOTES_PROD_v1.25.9_v1.28.0.md
```

Use {lang} to write one file per configured language. It is replaced with the
lowercased language code:

```yaml
output:
  - format: markdown
    saveTo: ./releases/release-notes-{env}-{lang}.md
  - format: html
    saveTo: ./releases/release-notes-{env}-{lang}.html
```

With prompt.languages: [en, fr] and --env PROD, this writes
release-notes-PROD-en.* and release-notes-PROD-fr.*. A path without {lang}
remains one combined multilingual release-history file.

HTML release history is supported too. Set the format and use an `.html`
file; each release is appended as a section in one valid HTML document:

```yaml
output:
  - format: html
    saveTo: ./releases/release-notes-{env}.html
```

To save Markdown and HTML in the same run, add a destination for each format:

```yaml
output:
  - format: markdown
    saveTo: ./releases/release-notes-{env}.md
  - format: html
    saveTo: ./releases/release-notes-{env}.html
```

---

## Instructions

The `instructions` field lets you give detailed guidance to the LLM.

### Inline instructions

```yaml
prompt:
  instructions: |
    ## Tone & Style
    - Write in professional, concise English
    - Use active voice

    ## Content Rules
    - Do NOT mention commit hashes
    - Do NOT mention internal ticket IDs

    ## Translation Examples
    - "feat(auth): add OAuth2" → "Added OAuth2 authentication support"
    - "fix(api): resolve race condition" → "Fixed a race condition in the API layer"
```

### File-based instructions

`ai-release-notes init` creates an `.ai-release-instructions.md` file next
to the config. The generated config keeps its file reference commented, so
built-in instructions remain active until you opt in.

```yaml
prompt:
  instructions:
    file: ./.ai-release-instructions.md
```

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

## Supported Providers

| Alias | Provider | Env Var | Models |
|-------|----------|---------|--------|
| `claude` | Anthropic | `ANTHROPIC_API_KEY` | Claude 3.5 Sonnet, Claude 3 Opus |
| `gpt4` / `gpt` | OpenAI | `OPENAI_API_KEY` | GPT-4o, GPT-4o-mini |
| `mistral` | Mistral | `MISTRAL_API_KEY` | Mistral Large, Mistral Medium |
| `gemini` | Google | `GOOGLE_API_KEY` | Gemini 1.5 Pro, Gemini 1.5 Flash |
| `ollama` | Ollama | `OLLAMA_API_KEY` | Llama 3, Mistral, CodeLlama (local) |
| `azure` | Azure OpenAI | `AZURE_OPENAI_API_KEY` | GPT-4o via Azure |

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

## License

MIT
