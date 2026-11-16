# CI/CD integration

## GitHub Actions

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

`fetch-depth: 0` matters: the tags and history the range is read from are not
there in a shallow clone.

## Revising without a terminal

`prompt --ask` applies requests with nothing to answer, saves at the end, and
exits non-zero if a request failed — see
[Asking for a change](prompt.md#in-ci).

## Promoting on a pipeline

Promotion calls no provider unless a range has to be merged, so a promotion step
usually needs no secret at all:

```yaml
      - run: npx ai-release-notes promote --from-env QUA --to-env PROD
```

## Running from a `.env` file

```bash
npm install -g dotenv-cli
dotenv -e .env -- npx ai-release-notes generate --from v1.0.0 --to v1.1.0 --env PROD
```

## Retaining partial documents

Automatic resumption reads the configured final note files and their shared
`.release-notes-state.json` ledger. A hosted runner's filesystem is temporary, so retain
those documents, the ledger and the corresponding indexes as CI artifacts after success or
failure, then restore them before rerunning the exact same environment and range.
Do not overlay artifacts from another range or deployment on a newer release's
history. Final documents do not expire; artifact retention is controlled by CI.
The API response cache remains an independent, optional optimization.
