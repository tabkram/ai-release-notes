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
# Uses the full Git history through v1.1.0
npx ai-release-notes generate --to v1.1.0 --env PROD

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
| `--from <version>` | Previous version tag, or `start` for the full history (default: `start`) |
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

## Promoting a release to the next environment

A release note written for QUA has already been read, corrected and agreed on.
When that same release reaches PROD, nothing about it has changed — so
`promote` reuses the files QUA already holds instead of asking a model to write
them again. **No prompt is built and no provider is called**, which is also why
no API key is needed:

```bash
# Everything PROD is missing, in one command
npx ai-release-notes promote --from-env QUA --to-env PROD

# Or one explicit range
npx ai-release-notes promote --from-env QUA --to-env PROD --from start --to v0.23.0
```

`ai-release-notes levelup` is the same command.

Each release file names the range it covers, so the files themselves form the
chain — `start → v0.23.0`, `v0.23.0 → v0.24.0`, and so on. Promoting reads that
chain rather than the version numbers, so a project that does not release in
ascending order is followed just as well.

- **One file covers the range** — it is promoted as it stands, word for word.
- **Several files cover it** — they are merged, oldest first, into the one note
  that covers the whole range: sections carrying the same heading become one
  section, their lists become one list, and a line both releases carry is
  listed once. The merged note takes its title from the newest release in it.
  `--merge concat` keeps each note whole instead, one after the other.

With no `--from`, promotion starts where the target environment already is, so
running it twice does nothing the second time. With no `--to`, it goes to the
newest release the source environment holds. The target environment's output
index is updated exactly as a generation would update it.

### Where the files are

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

### Promote options

| Option | Description |
|--------|-------------|
| `--from-env <env>` | Environment to promote from (default: `--from-dir`'s folder name) |
| `--to-env <env>` | Environment to promote to (default: `--to-dir`'s folder name) |
| `--from <version>` | Start of the range (default: where the target environment is) |
| `--to <version>` | End of the range (default: the newest release in the source) |
| `--from-dir <dir>` / `--to-dir <dir>` | Read/write the releases in these folders |
| `--pattern <pattern>` | File name inside those folders (default: the configured one) |
| `--merge <sections\|concat>` | How several releases become one note (default: `sections`) |
| `--lang <language>` | Promote one language only |
| `--release-date <value>` | `now` (default), `tag`, or an ISO date |
| `--config <path>` | Path to config file |
| `--dry-run` | Show what would be promoted without writing anything |
| `--stdout` | Write the promoted notes to the terminal without saving files |

An HTML release note is read back out of the page it was written into and
rendered into the template again, so the promoted page states its own
environment, versions and date. A page written through a template this cannot
read is copied as it stands, which is the whole point of promoting.

---

## Asking for a change

A generated note is rarely wrong so much as not yet right: it repeats a line,
it says more about the build than anyone wants to read, or it drifted from your
own writing rules. Regenerating answers none of that — the changelog has not
changed, so the same note comes back and every correction already made to it is
lost.

`prompt` opens the notes an environment holds and asks what you would like to
change. You answer in your own words:

```bash
npx ai-release-notes prompt --env PRD --from v1.25.7 --to v1.28.0 --with mistral
```

```
📝 2 release notes open for PRD
   releases/PRD/release-notes_v1.25.7_v1.26.0.md  v1.25.7 → v1.26.0
   releases/PRD/release-notes_v1.26.0_v1.28.0.md  v1.26.0 → v1.28.0

💬 Is there anything you would like to change?
   Say it in your own words. Say you are done when you are done.

› remove the exact duplicate lines
› drop the technical section, I don't want to talk about the docker part
› group everything about "update endpoint logic" under one line
› format them against the project instructions again
› that's it, save them
```

There is nothing to learn first. Every answer is read by a model that works out
what it meant — a change to make, a change to take back, a request to save, or
that you are done — so "put that back", "actually leave it", and "that's all"
all work. `ai-release-notes ask` is the same command.

Without `--from` and `--to`, every release note the environment holds is opened
at once, and each request is applied to all of them.

- **Nothing is written until you say so.** Each request shows what it changed,
  line by line, and the files stay as they were until you ask for them to be
  saved.
- **Repeated lines are compared, not rewritten.** Asking for exact duplicates to
  go calls no model at all: the lines are compared here, the first of each stays
  where you meet it, and a section left empty goes with them.
- **A revision changes what a note says, never which release it is**, so the
  release index still describes it and is left alone.

### In CI

Pass the requests instead of answering them, and the same session runs with
nothing to type. It saves at the end, and exits non-zero if a request failed:

```bash
npx ai-release-notes prompt --env PRD \
  --ask "remove exact duplicate lines" \
  --ask "drop any line about internal tooling" \
  --dry-run
```

### Prompt options

| Option | Description |
|--------|-------------|
| `--env <env>` | **Required.** Whose release notes to open |
| `--from <version>` / `--to <version>` | Open only the releases a range covers |
| `--lang <language>` | Open one language only |
| `--with <provider>` | LLM override; see [provider aliases](#1-providers-and-api-keys) |
| `--config <path>` | Path to config file |
| `--ask <request>` | Apply a request with nothing to answer. Repeatable, for CI |
| `--dry-run` | Show what the requests would change without writing anything |

An HTML release note is a whole page, so only the note on it is ever sent or
replaced: the page keeps its head, its styles, its footer, and the values the
template filled in when it was generated. A page whose note cannot be told apart
from the page around it is reported and left alone.

---

## Configuration

`.ai-release-notes.yml` describes your project and where generated files
belong. Keep API keys in environment variables; they are never stored in the
configuration file.

The main parts are simple:

- `projectName` gives the generated notes their product name.
- `provider` chooses the AI provider; `providers` lets you set its model and
  generation options.
- `prompt` selects the release languages and where the writing rules come from.
  See [Instructions](#instructions).
- `output` lists the Markdown and/or HTML release files to create. Use
  `{env}`, `{lang}`, `{from}`, and `{to}` in their names. Missing `--from` and
  `--to` become `start` and `end`. A name carrying `{from}` or `{to}` belongs
  to a single release, so regenerating it rewrites that file. A name without
  either is shared by every release, and each new one is added to it.
- `outputIndex` is optional. It maintains a release summary with links to
  every release file. It may be one destination or a list, for example one
  Markdown and one HTML summary. Add `{lang}` when each language needs its own
  summary. `entryTemplate` sets the shape of one listed release; see
  [Index entries](#index-entries). Index templates can place links between those
  summaries with `{{languages}}` (or `{{langages}}`). That slot is spent the
  first time an index is written: afterwards the switcher is found by the markup
  it was rendered as, so a generated page carries a switcher rather than a
  marker of ours. A single language shows no switcher at all. The switcher
  merges languages from the current prompt with localized index files already
  present on disk. An index template is assumed to be written in the first
  `prompt.languages` entry, and an index in any other language is translated.

Custom instruction and summary templates are optional. The generated config
keeps their lines commented until you need them.

### Index entries

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

Each entry stores what the index knows about its release — environment,
versions, date, link — in a comment marker, and the whole list is rendered again
on every run. Edit the entry template, or switch the index to another language,
and the entire history is relabelled at the next release. The list is bounded by
`<!-- ai-release-notes:releases -->` and `<!-- ai-release-notes:/releases -->`;
everything outside those two lines belongs to the summary template.

An entry that carries no record is kept word for word, below the rendered ones,
since there is nothing to render it from.

### The release page

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

### The first release

`--from start` — the default — reads the whole history, so there is no previous
version to compare against. The release note says `First release` where a
comparison would go, and the file name still uses `start` for `{from}`.

For the exact configuration and comments, see the annotated
[example `.ai-release-notes.yml`](examples/.ai-release-notes.yml). The
[examples guide](examples/README.md) then walks through a first run, writing
instructions, templates, and output layouts.

---

## Instructions

The release note is written entirely by the model: its title block, its summary,
and its sections all come from the instructions. Built-in instructions apply
until you write your own, so `generate` works with no configuration at all.

`prompt.instructions` replaces the built-in rules with your own, as inline text
or as a file resolved next to the config:

```yaml
prompt:
  languages: [en, fr]
  instructions:
    file: ./.ai-release-instructions.md
```

That one file is the whole contract. A localized release goes through two
prompts — the first language is generated from the changelog, the others are
translated from it — and both receive it, so rules that matter only to one of
them, such as a glossary or protected vocabulary, belong in a section of the
same file.

The prompts themselves can be replaced too. `system` sets the role and goal
that precede the instructions; `user` sets how the release is described to the
model, through these placeholders:

```yaml
prompt:
  system:
    file: ./.ai-release-system.md
  user: |
    {{projectName}} {{fromVersion}} → {{toVersion}} ({{environment}}, {{date}})

    {{commitCount}} commits:
    {{changelog}}
    {{context}}
```

Whatever the model receives, `--dry-run` prints it without calling a provider,
and `--verbose` reports which instructions were applied.

Instructions shape the release note; they do not replace it. Every request opens
with a scope guard that no configuration key removes, so `instructions` and
`system` control wording, sections, tone, language, and terminology, but cannot
repurpose the tool into a general-purpose assistant. See
[Security](#security-) for the full trust model.

---

## Context Files

Provide additional context to the LLM. Accepts a **mixed array** of files and directories:

```bash
npx ai-release-notes generate --from v1.0.0 --to v1.1.0 --env PROD \
  --context ./specs/main.md ./docs/models/ ./README.md
```

Context is sent to your LLM provider, so a directory scan skips what it should
not upload: credential-shaped files, content matching known key formats, binary
files, and `.git`, `.ssh`, `.aws`, `node_modules` and similar. A file you name
explicitly is always loaded, with a warning when it looks sensitive. Scans stop
at 256 KB per file, 1 MB total, 200 files, and 8 directory levels.

---

## Security 🔒

Commit messages come from anyone who can land a commit, and a config file
travels with the repository. Both are treated as untrusted:

- **Scope guard.** Prepended to every system prompt, including a custom
  `prompt.system`, and not removable by configuration.
- **Data boundaries.** The changelog and context go to the model in labelled
  blocks, and text imitating a delimiter is rewritten so it cannot break out.
- **Safe rendering.** Raw HTML in a release note is escaped and link targets are
  limited to `http`, `https`, `mailto`, and relative paths.
- **Bounded spend.** `git.maxCommits` (default 200) caps one run.
- **Promotion.** `promote` calls no provider and reuses files this tool already
  wrote, whose markup was escaped when it was generated; those files are trusted
  like the rest of your repository.
- **Endpoint checks.** `baseURL` must be `http`/`https`, and a non-local one
  warns before any prompt leaves the machine.

A release note is still model output written from unreviewed input. Review one
before publishing it. Full details and reporting instructions are in
[security.md](security.md).

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

`markdownToHtml(markdown, options?)` wraps Markdown in the bundled release-note
template, which supplies the page title and footer:

```typescript
markdownToHtml(markdown, { trustedHtml: true });
```

`promote(options)` returns the files a promotion would write, without writing
any of them, so you can review or publish them yourself:

```typescript
import { promote } from "ai-release-notes";

const { files, plan } = await promote({
  fromEnvironment: "QUA",
  toEnvironment: "PROD",
});

console.log(plan.segments.map((s) => `${s.fromVersion} → ${s.toVersion}`));
for (const file of files) {
  console.log(file.path, "←", file.sources);
}
```

`PromptSession` opens the notes an environment holds and applies requests to
them. Nothing reaches the disk until `save`, and `callModel` lets the session
run on a model of your own:

```typescript
import { PromptSession } from "ai-release-notes";

const session = await PromptSession.open({ environment: "PROD" });

const { action, instruction } = await session.route("drop the docker line");
const result = action === "dedupe"
  ? session.dedupe()
  : await session.revise(instruction);

for (const edit of result.edits) {
  console.log(edit.path, edit.changed ? "revised" : edit.skipped ?? "unchanged");
}

await session.save();
```

Each step is exported on its own when you need only part of it:

| Function | What it does |
|----------|--------------|
| `discoverReleases(saveTo, values)` | Read a `saveTo` pattern back off disk: which releases exist, and what their paths say about them |
| `formatOutputPath(saveTo, values)` | Fill `{env}`, `{lang}`, `{from}`, `{to}`; anything not supplied stays a placeholder |
| `planPromotion({ available, … })` | Chain release files into the run that carries one version to another |
| `mergeReleaseDocuments(docs, format)` | Merge release notes by section and list, oldest first |
| `dedupeReleaseDocument(content, format)` | Drop the lines a note lists twice, and report which they were |
| `parseReleaseDocument` / `serializeReleaseDocument` | A release note as a section tree, and back again |
| `extractReleaseContent(page, template?)` | Read a release note back out of the HTML page it was rendered into |
| `replaceReleaseContent(page, revised, template?)` | Put a revised note back on its page, leaving the page around it standing |
| `sanitizeReleaseHtml(html)` | Reduce model-written markup to what a release note is made of |
| `diffLines(before, after)` | What a revision changed, line by line |
| `updateOutputIndexes(params)` | Add a release to every configured index, creating the ones that do not exist |

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
