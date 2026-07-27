# Programmatic API

```bash
npm install ai-release-notes
```

Everything the CLI does is exported. The three entry points below cover the three
commands; the table at the end lists the steps they are built from, for when you
need only part of one.

## generate

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

console.log(result.markdown);
console.log(result.html);
```

`generateFromChangelog(...)` takes a raw changelog instead of reading git.

`markdownToHtml(markdown, options?)` wraps Markdown in the bundled release-note
template, which supplies the page title and footer:

```typescript
markdownToHtml(markdown, { trustedHtml: true });
```

## promote

`promote(options)` returns the files a promotion would write, without writing any
of them, so you can review or publish them yourself:

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

## PromptSession

`PromptSession` opens the notes and release indexes an environment holds. It can
answer grounded questions, revise a relevant subset, or structurally merge a
contiguous release range. Nothing reaches disk until `save`, and `callModel`
lets the session run on a model of your own:

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

The existing route-and-revise pattern above remains valid. A routed question has
the `answer` action and is read-only:

```typescript
const routed = await session.route("Compare the audience of the two newest notes");

if (routed.action === "answer") {
  const answer = await session.answer(
    routed.instruction,
    routed.scope,
    routed.answerFrom
  );
  console.log(answer.text);
}
```

Questions are answered only from the documents open in the session.
`PromptSession.open({ fromVersion, toVersion, language })` places a hard boundary
around those documents; within it, `answer` selects the relevant versions and an
appropriate language. It does not alter `documents`, `pending()`, or undo
history. The same optional scope can be passed to
`session.revise(routed.instruction, routed.scope)` so a programmatic assistant
changes only the files the message addresses.

`SessionAction` also includes a `merge` action. Its optional `scope` is a
`SessionScope` carrying the versions, languages, or document kinds the router
found in the request:

```typescript
interface SessionScope {
  fromVersion?: string;
  toVersion?: string;
  languages?: string[];
  kinds?: Array<"release" | "index">;
}
```

```typescript
const routed = await session.route("Combine the selected release chain");

if (routed.action === "merge") {
  const result = await session.merge({
    instruction: routed.instruction,
    ...routed.scope,
  });

  for (const edit of result.edits) {
    console.log(edit.operation ?? "update", edit.path);
  }
}
```

Calling `session.merge(scope)` directly is also supported. Supply the outer
endpoints of the contiguous range and, when needed, the languages to merge:

```typescript
const result = await session.merge({
  fromVersion: "v2.2.0",
  toVersion: "v2.5.0",
  languages: ["fr"],
});
```

For a direct call, `fromVersion` and `toVersion` identify the merge even though
the fields are optional on the more general `SessionScope` type. When dispatching
a routed action, carrying `instruction` lets the session recover endpoints the
router left in the original wording. The selected notes must form one
contiguous chain. The merge combines their section trees and stages a single
note for the outer range, deletion of the replaced notes, and the corresponding
release-index updates. Selection, paths, and section merging are deterministic;
the model is called only to synthesize the merged opening. These creations,
changes, and deletions remain in memory until `save()`. `undo()` reverses the
last staged operation, `reset()` restores the last saved state, and callers can
inspect `pending()` to implement a dry run without calling `save()`.

## The steps on their own

| Function | What it does |
|----------|--------------|
| `discoverReleases(saveTo, values)` | Read a `saveTo` pattern back off disk: which releases exist, and what their paths say about them |
| `formatOutputPath(saveTo, values)` | Fill `{env}`, `{lang}`, `{from}`, `{to}`; anything not supplied stays a placeholder |
| `planPromotion({ available, … })` | Chain release files into the run that carries one version to another |
| `mergeReleaseDocuments(docs, format, opts)` | Merge release notes by section and list; `leadWith: "newest"` puts the last release's lines first |
| `splitReleaseOpening(content, format)` | Cut a note where its first section begins: the title, date and summary on one side, the sections on the other |
| `dedupeReleaseDocument(content, format)` | Drop the lines a note lists twice, and report which they were |
| `parseReleaseDocument` / `serializeReleaseDocument` | A release note as a section tree, and back again |
| `extractReleaseContent(page, template?)` | Read a release note back out of the HTML page it was rendered into |
| `replaceReleaseContent(page, revised, template?)` | Put a revised note back on its page, leaving the page around it standing |
| `sanitizeReleaseHtml(html)` | Reduce model-written markup to what a release note is made of |
| `diffLines(before, after)` | What a revision changed, line by line |
| `updateOutputIndexes(params)` | Add a release to every configured index, creating the ones that do not exist |

Configuration (`loadConfig`), git (`getChangelog`, `getLatestTag`), prompt
building (`buildSystemPrompt`, `buildUserPrompt`), the provider call (`callLLM`)
and the TypeScript types of all of the above are exported too — see
[`src/index.ts`](../src/index.ts) for the full list.
