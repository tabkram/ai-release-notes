# Instructions

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
them, such as a glossary or protected vocabulary, belong in a section of the same
file.

## Replacing the prompts

The prompts themselves can be replaced too. `system` sets the role and goal that
precede the instructions; `user` sets how the release is described to the model,
through these placeholders:

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

## What instructions cannot do

Instructions shape the release note; they do not replace it. Every request opens
with a scope guard that no configuration key removes, so `instructions` and
`system` control wording, sections, tone, language, and terminology, but cannot
repurpose the tool into a general-purpose assistant. See
[security.md](../security.md) for the full trust model.
