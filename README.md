# 🤖 ai-release-notes

Generic AI-powered release notes generator using the [Vercel AI SDK](https://sdk.vercel.ai).

Transform your git changelog into clean, business-readable release notes — with support for OpenAI, Anthropic, Mistral, Google, Ollama, and more. Usable as a CLI or as a library.

- **generate** — write the notes for a version range, in Markdown and/or HTML, in one or several languages.
- **promote** — carry a reviewed note to the next environment, word for word.
- **prompt** — ask, in your own words, for a change to notes already written.

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

→ [Setting environment variables](docs/api-keys.md#setting-environment-variables) on macOS, Linux, Windows, or from a `.env` file.

### 2. Initialize configuration

```bash
npx ai-release-notes init
```

This creates `.ai-release-notes.yml` in your project root. **No API keys are stored in this file.**

### 3. Generate release notes

```bash
# The full Git history through v1.1.0, with the configured provider
npx ai-release-notes generate --to v1.1.0 --env PROD

# One range, with Anthropic — needs ANTHROPIC_API_KEY
npx ai-release-notes generate --from v1.0.0 --to v1.1.0 --env PROD --with claude

# Print to the terminal instead of writing release files and indexes
npx ai-release-notes generate --to v1.1.0 --env PROD --stdout
```

Files are saved where your configuration says, and the run reports the paths it
updated together with the tokens it spent.

→ [Generating release notes](docs/generate.md) — **CLI options**, `--dry-run`, release dates, context files.

### 4. Promote a release to the next environment

A note written for QUA has already been read and agreed on. Promoting it to PROD
reuses those files instead of asking a model to write them again — no prompt is
built, no provider is called, no API key is needed:

```bash
# Everything PROD is missing, in one command
npx ai-release-notes promote --from-env QUA --to-env PROD

# Or one explicit range
npx ai-release-notes promote --from-env QUA --to-env PROD --from v1.0.0 --to v1.1.0
```

When several releases cover the range they are merged section by section, and a
model is asked for one thing only: the single opening that covers them all.

→ [Promoting a release](docs/promote.md) — **CLI options**, merge rules, environment folders.

### 5. Ask for a change

A generated note is rarely wrong so much as not yet right. Regenerating loses
every correction already made to it, so `prompt` opens the notes an environment
holds and asks what to change:

```bash
npx ai-release-notes prompt --env PROD --from v1.0.0 --to v1.1.0
```

```
💬 Is there anything you would like to change?
› remove the exact duplicate lines
› drop the technical section, I don't want to talk about the docker part
› that's it, save them
```

Each request shows what it changed, line by line, and nothing is written until
you ask for it. In CI, pass the requests as `--ask` instead of answering them.

→ [Asking for a change](docs/prompt.md) — **CLI options**, CI mode, HTML pages.

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
  toDir: "./docs/releases",
  context: ["./specs/api-v2.md", "./docs/models/"],
});

console.log(result.markdown, result.html);
```

`promote(options)` returns the files a promotion would write without writing
them, and `PromptSession` applies requests to notes already on disk, saving only
when you say so.

→ [Programmatic API](docs/api.md) — `generate`, `promote`, `PromptSession`, and the steps they are built from.

---

## Documentation

| Guide | What it covers |
|-------|----------------|
| [API keys](docs/api-keys.md) | A key per provider, and where to put it |
| [Generating release notes](docs/generate.md) | `generate`, CLI options, dates, context files |
| [Promoting a release](docs/promote.md) | `promote`, merging a range, environment folders |
| [Asking for a change](docs/prompt.md) | `prompt`, revising written notes, CI mode |
| [Configuration](docs/configuration.md) | `.ai-release-notes.yml`, output paths, indexes, templates |
| [Instructions](docs/instructions.md) | What the model is told to write |
| [Programmatic API](docs/api.md) | Using the package as a library |
| [CI/CD integration](docs/ci-cd.md) | GitHub Actions, secrets, non-interactive runs |

The [example configuration](examples/.ai-release-notes.yml) is annotated, and the
[examples guide](examples/README.md) walks through a first run.

---

## Security 🔒

Commit messages come from anyone who can land a commit, and a config file travels
with the repository. Both are treated as untrusted: a scope guard no
configuration key removes opens every system prompt, the changelog and context
reach the model in labelled blocks, model-written markup is escaped and its link
targets restricted, and `git.maxCommits` caps what one run can spend.

A release note is still model output written from unreviewed input. Review one
before publishing it. Full details and reporting instructions are in
[security.md](security.md).

---

## Contributing 🤝

If you find any issues or have suggestions for improvement, feel free to open an issue or submit a pull request.
Contributions are welcome!

Before getting started, please read our [Contribution Guidelines](CONTRIBUTING.md).

This project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md); security issues should follow the [Security Policy](security.md).

## Community 👥

Love `ai-release-notes`? Give our repo a star ⭐ ⬆️.

## License 📄

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
