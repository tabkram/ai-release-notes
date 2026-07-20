# Release Notes Instructions

## Tone & Style
- Write in professional, concise English
- Use active voice
- Avoid jargon unless it's in the vocabulary list

## Content Rules
- Do NOT mention commit hashes
- Do NOT mention internal ticket IDs (JIRA, GitHub issues, etc.)
- Do NOT invent features that do not exist in the changelog
- If a release contains only fixes, do NOT create a "New Features" section

## Translation Guidelines
- "feat(auth): add OAuth2 login" → "Added OAuth2 authentication support"
- "fix(api): resolve race condition" → "Fixed a race condition in the API layer"
- "perf(db): optimize queries" → "Improved database query performance"
- "refactor(core): extract service" → "Refactored core service architecture"

## Section Priorities
1. Security fixes always go first in Bug Fixes
2. Breaking API changes must be highlighted
3. Performance improvements deserve their own bullet

## Audience
These release notes are read by:
- Engineering managers
- DevOps teams
- External API consumers
- Keep all of them in mind when writing
