# Asking for a change

A generated note is rarely wrong so much as not yet right: it repeats a line, it
says more about the build than anyone wants to read, or it drifted from your own
writing rules. Regenerating answers none of that — the changelog has not changed,
so the same note comes back and every correction already made to it is lost.

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
all work.

Without `--from` and `--to`, every release note the environment holds is opened
at once — along with the index listing them — and each request is applied to all
of them.

- **Nothing is written until you say so.** Each request shows what it changed,
  line by line, and the files stay as they were until you ask for them to be
  saved.
- **Repeated lines are compared, not rewritten.** Asking for exact duplicates to
  go calls no model at all: the lines are compared here, the first of each stays
  where you meet it, and a section left empty goes with them.
- **A request reaches whatever it is about.** One about a section finds the notes
  that have one; one about the list of releases finds the index. Neither is read
  as if it were the other, and a file a request does not reach is left as it was,
  word for word.

## The index listing your releases

An [`outputIndex`](configuration.md) names no version, so a range asks for one
release's own note and leaves it out. Open an environment without one and the
index is open too, for the requests a list takes rather than a note:

```
› only keep the last five releases on the index
› put the oldest release first
› group them under a heading per year
› say "security release" under v1.26.0
› drop v1.25.7 from the list, it was rolled back
```

Only the releases the index lists are ever sent or replaced — the page keeps its
heading, its language switcher and its footer. Each listed release carries a
marker that says which release it is, so a request may drop a release along with
its marker, and an answer that wrote, repeated or edited one is reported and the
file left alone: an index cannot gain a release nobody released.

A later `generate` run renders each listed release from its own marker again. An
order you asked for survives it; wording you changed on an entry does not, since
the run rewrites every entry from the template.

## In CI

Pass the requests instead of answering them, and the same session runs with
nothing to type. It saves at the end, and exits non-zero if a request failed:

```bash
npx ai-release-notes prompt --env PRD \
  --ask "remove exact duplicate lines" \
  --ask "drop any line about internal tooling" \
  --dry-run
```

## CLI options

| Option | Description |
|--------|-------------|
| `--env <environment>` | **Required.** Whose release notes to open |
| `--from <version>` / `--to <version>` | Open only the releases a range covers |
| `--lang <language>` | Open one language only |
| `--with <provider>` | LLM override; see [provider aliases](../README.md#1-providers-and-api-keys) |
| `--config <path>` | Path to config file |
| `--ask <request>` | Apply a request and save, with nothing to answer. Repeatable, for CI |
| `--dry-run` | Show what the requests would change without writing anything |
| `-v, --verbose` | Show the provider and instructions the requests are answered with |
| `--stdout` | Write the revised notes to the terminal without saving files (needs `--ask`) |

An HTML release note is a whole page, so only the note on it is ever sent or
replaced: the page keeps its head, its styles, its footer, and the values the
template filled in when it was generated. A page whose note cannot be told apart
from the page around it is reported and left alone.

## Related

- [Generating release notes](generate.md) · [Promoting a release](promote.md)
- [Programmatic API](api.md#promptsession) — drive the same session from code
