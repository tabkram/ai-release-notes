# Contributing to ai-release-notes

Thanks for helping improve ai-release-notes.

For npm releases, PR canaries and trusted publisher setup, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Before submitting a change

- Add or update tests for behavior changes.
- Document public API changes and user-facing behavior.
- Run `npm run lint` and `npm test`.

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
