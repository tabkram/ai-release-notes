# Talk to your release notes

A generated note is rarely wrong so much as not yet right: it repeats a line, it
says more about the build than anyone wants to read, or it drifted from your own
writing rules. You may also need to understand what has already shipped, inspect
the set of release files, or turn several small releases into one note.
Regenerating answers none of that — the changelog has not changed, so the same
notes come back and every correction already made to them is lost.

`prompt` opens the notes an environment holds as a release-note assistant. Ask a
question or request a change in your own words:

```bash
npx ai-release-notes prompt --env PRD --with mistral
```

```
📝 Release notes and indexes open for PRD

💬 What would you like to know or change?
   Say it in your own words. Say you are done when you are done.

› compare the customer impact of the two newest releases
› combine those releases into one note
› keep the earlier release's introduction
› save
```

There is nothing to learn first. Every answer is read by a model that works out
what it meant — a question, a revision, a structural merge, a change to take
back, a request to save, or that you are done. The examples above are not a
command vocabulary: the assistant routes ordinary questions and instructions
from their meaning.

Without `--from` and `--to`, every release note the environment holds is opened
at once — along with the index listing them — and each request is applied to all
of the relevant files. Use `--from`, `--to`, or `--lang` to put a hard boundary
around the session. Within that boundary, a question or change that names a
version, range, language, section, or release is directed only to that scope.

## Ask before you change

Questions are read-only. The assistant can inspect both the release inventory
and the contents of the open notes, then answer arbitrary questions grounded in
those files. That includes reasoning across releases, checking their coverage,
describing pending work, and finding themes in what was published. It selects
the relevant versions and one appropriate language instead of sending every
translation to the model. If the open files do not contain the answer, it says
so rather than filling the gap from general knowledge.

An answer is printed as prose and reports `answered, nothing changed`. It adds
nothing to the undo history, and asking a question never makes `save` write a
file.

## Revise or merge

A revision changes the relevant open notes in place. A merge is different: it
expects a contiguous chain of releases, such as `A → B`, `B → C`, and `C → D`,
and stages one `A → D` release note. Sections and list items are combined
structurally, rather than by pasting complete documents together. File metadata
determines the source chain and destination; the model is used only to produce
the single opening the merged note needs.

The range and language can be stated naturally in the request. If they are
omitted, the assistant uses the eligible scope already open in the session. A
range with a gap or overlapping links is rejected instead of silently inventing
a release.

Merging stages the new combined note and removal of the notes it replaces. It
also updates the affected release indexes so their entries and language links
refer to the combined release. Creating a file, deleting a replaced file, and
editing an index obey the same save boundary as an ordinary text revision:
nothing reaches disk until you save.

- **Nothing is written until you say so.** Each request shows what it changed,
  created, or would delete, and the files stay as they were until you ask for
  them to be saved.
- **Repeated lines are compared, not rewritten.** Asking for exact duplicates to
  go calls no model at all: the lines are compared here, the first of each stays
  where you meet it, and a section left empty goes with them.
- **A request reaches whatever it is about.** One about a section finds the notes
  that have one; one about the list of releases finds the index. Neither is read
  as if it were the other, and a file a request does not reach is left as it was,
  word for word.
- **Staged work is reversible.** Undo takes back the last revision or merge.
  Reset restores the whole session to the files as last saved, including any
  staged creations, deletions, and index changes.

## The index listing your releases

An [`outputIndex`](configuration.md) names no version, so a range asks for one
release's own note and normally leaves it out. Open an environment without a
range and the index is open too, for questions and requests about the release
inventory:

```
› put the newest entries first
› group the entries by quarter
› shorten the descriptions in the list
```

Only the releases the index lists are ever sent or replaced — the page keeps its
heading, its language switcher and its footer. Each listed release carries a
marker that says which release it is, so a request may drop a release along with
its marker, and an answer that wrote, repeated or edited one is reported and the
file left alone: an index cannot gain a release nobody released.

A later `generate` run renders each listed release from its own marker again. An
order you asked for survives it; wording you changed on an entry does not, since
the run rewrites every entry from the template. A merge is the exception to the
usual range rule: it stages the required index updates even when the release
notes were opened with `--from` and `--to`.

## In CI

Pass the requests instead of answering them, and the same session runs with
nothing to type. It saves at the end, and exits non-zero if a request failed:

```bash
npx ai-release-notes prompt --env PRD \
  --ask "remove exact duplicate lines" \
  --ask "combine the releases in the open range" \
  --dry-run
```

`--dry-run` performs the whole staging pass, including merge planning and index
updates, but writes or deletes nothing. The output lists the files that would be
created, changed, or removed.

## CLI options

| Option | Description |
|--------|-------------|
| `--env <environment>` | **Required.** Whose release notes to open |
| `--from <version>` / `--to <version>` | Open only the releases a range covers; also defines the eligible merge range |
| `--lang <language>` | Open one language only |
| `--with <provider>` | LLM override; see [provider aliases](../README.md#1-providers-and-api-keys) |
| `--config <path>` | Path to config file |
| `--ask <request>` | Ask a question or apply a request non-interactively. Repeatable, for CI; staged changes save at the end |
| `--dry-run` | Show every write and deletion the requests would make without changing disk |
| `-v, --verbose` | Show the provider and instructions the requests are answered with |
| `--stdout` | Write the revised notes to the terminal without saving files (needs `--ask`) |

An HTML release note is a whole page, so only the note on it is ever sent or
replaced: the page keeps its head, its styles, its footer, and the values the
template filled in when it was generated. A page whose note cannot be told apart
from the page around it is reported and left alone.

## Related

- [Generating release notes](generate.md) · [Promoting a release](promote.md)
- [Programmatic API](api.md#promptsession) — drive the same session from code
