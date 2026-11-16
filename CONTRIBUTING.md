# Contributing to ai-release-notes

Thanks for helping improve ai-release-notes.

For npm releases, PR canaries and trusted publisher setup, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Before submitting a change

- Add or update tests for behavior changes.
- Document public API changes and user-facing behavior.
- Run `npm run lint`, `npm test`, and `npm run eval`.

## Checking release-note quality

`npm run eval` runs the offline snapshot checks also used in CI. It needs no
API key and blocks network requests. Five frozen version ranges cover this
project, Express, and Underscore, including non-conventional subjects, merge
noise, repeated work, documentation changes, and maintenance-heavy histories.

Each fixture checks the actual generator's `dryRun` output (the assembled
system and user prompts), then renders a hand-authored recorded Markdown note
with the shipped HTML template. The package-version slot is replaced with a
stable marker so a version bump alone does not invalidate every snapshot.
Additional snapshots cover the translation,
promotion, and session prompts. A changed prompt or rendered template produces
a diff and a non-zero exit code. This checks the instructions and rendering;
it does **not** measure how a live model follows those instructions.

For live writing quality, opt in explicitly:

```sh
# Uses MISTRAL_API_KEY; Mistral is the default provider.
npm run eval -- --judge

# Optionally choose a model and a blocking quality threshold.
EVAL_MODEL=mistral-large-latest EVAL_MIN_SCORE=3 npm run eval -- --judge

# Other supported providers/aliases can still be selected explicitly.
EVAL_PROVIDER=openai npm run eval -- --judge
```

Judge mode uses the provider's normal environment variables (Azure also needs
`AZURE_OPENAI_ENDPOINT`, the full OpenAI-compatible base URL). It generates a
fresh English note for each fixture, then asks the same provider/model to score
it against [the rubric](test/eval/rubric.md). The five scores (readability,
categorization, jargon, identifiers, faithfulness) range from 1 to 5; 4 is the
target for good quality. The table includes every score and an explanation.
`EVAL_MIN_SCORE` is the blocking threshold, an integer from 0 to 5, defaulting
to **0**. Any criterion strictly below this threshold fails the run. Scores
below 4 that are not blocking produce warnings: with the default 0, every
quality problem is advisory; with 3, a score of 2 fails and a score of 3 warns.

Missing credentials, exhausted quotas, rate limits, network/provider failures,
and incomplete/malformed model responses always produce warnings and exit
successfully unless an earlier fixture already scored below the configured
threshold. After a provider/response failure, remaining fixtures are skipped
to avoid wasting a free quota. WARN/SKIP means the assessment is incomplete,
not that quality passed. Invalid options/configuration, broken fixture files,
and snapshot drift remain errors. There are at most two model calls per fixture,
with response and provider prompt caching disabled, no automatic retries, and
a 30-second timeout per HTTP request. No release files
are written. Model judgments can vary: review the explanation before changing
a prompt to satisfy a score. Judge mode runs separately from offline snapshots.

CI runs both modes. Offline snapshots remain mandatory. The optional Mistral
step emits GitHub warning annotations when AI evaluation cannot run. To enable
it, add a repository Actions secret named `MISTRAL_API_KEY`; without it CI
continues with a warning. Set repository Actions variables `EVAL_MODEL` to a
model available on your plan and `EVAL_MIN_SCORE` to a blocking threshold when
ready (initially 0). The reusable build declares the key as optional, and push
and pull-request workflows pass it explicitly. Fork PRs without access to the
secret skip AI evaluation with a warning as well.

To add a fixture:

1. Create `test/fixtures/eval/<descriptive-name>/input.json`. Copy an existing
   fixture's shape: project, version range, fixed ISO date, environment, source
   repository URL and resolved endpoint SHAs, and the complete list of commit
   SHAs and original one-line subjects for that range. Preserve the captured
   ordering. These files are the inputs; eval never fetches Git history.
2. Write `recorded.md`, a reviewed example note grounded in those commits. It is
   a stable input for rendering, not a simulated model proving writing quality.
3. Run `npm run eval -- --update`, review the committed snapshot diffs, then run
   `npm run eval`. Updates are explicit and cannot be combined with `--judge`.
   After an intentional prompt/template change, use the same review process;
   a changed snapshot is a request for review, not proof of a regression.

Fixtures were captured from local tags for this repository and GitHub compare
responses for Express/Underscore; only commit subjects and provenance are kept.
Inspect an original range at `<repository>/compare/<fromSha>...<toSha>`.
The regression tests deliberately alter every shipped prompt in an isolated
copy and verify that the unchanged snapshots reject it. Eval tooling and
fixtures live under `test/`, outside the published package's `files` whitelist.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
type(scope): short summary
```

Use a present-tense, lowercase summary without a trailing period. Common types are `build`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, and `test`. The scope is optional.

Examples:

```text
feat(cli): add JSON output
fix(config): validate output paths
docs: clarify API key setup
```
