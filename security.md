# Security Policy

## Trust model

This tool reads material nobody reviewed — commit messages come from anyone who
can land a commit, and a config file travels with the repository — and sends it
to a third-party API. Inputs are treated accordingly.

**Untrusted, always:** commit messages, `--changelog` files, context files, and
everything the model writes back.

**Trusted:** the bundled prompts, and the release index this tool assembles from
its own escaped entries.

### The scope guard

Every request opens with [`prompts/release-notes-scope.md`](prompts/release-notes-scope.md).
It is prepended to the system prompt, including a fully custom `prompt.system`,
and no configuration key removes it. It states that the only permitted output is
a release note, and that changelog and context text is material to describe
rather than instructions to follow.

`prompt.instructions` and `prompt.system` still shape wording, sections, tone,
language, and terminology. They cannot turn the tool into a general-purpose
assistant running on the user's API key.

The changelog and context are additionally wrapped in labelled data blocks, and
any text inside them that imitates a block delimiter is rewritten so it cannot
close the block early.

A determined prompt injection may still influence the wording of a release note.
Treat generated notes as untrusted text and review them before publishing.

### Context files

`--context` sends file contents to the LLM, so the loader is deliberately
narrow. A path named explicitly is loaded, with a warning if it looks sensitive.
A file merely swept up by a directory scan is skipped instead when it looks like
a credential, when its content matches a known key format, when it is binary, or
when it exceeds the size cap.

Directory scans never descend into `.git`, `.ssh`, `.aws`, `.gnupg`,
`node_modules`, and similar. Limits: 256 KB per file, 1 MB total, 200 files,
8 directory levels.

### Rendered output

Release notes are model output, so raw HTML in them is escaped and link targets
are restricted to `http`, `https`, `mailto`, and relative paths. Scripting
schemes such as `javascript:` are rendered as plain text.

### Promoted releases

`promote` calls no provider: it moves release files this tool already wrote from
one environment to the next. Their markup was escaped when it was generated, and
is placed on the promoted page as it stands rather than escaped a second time —
so the files under `output.saveTo` are trusted to the same degree as the rest of
the repository they live in. A release note edited by hand after generation is
promoted with those edits, markup included.

### Spend

`git.maxCommits` (default 200) bounds how many commits one run sends to a paid
API.

### Endpoints

`providers.<name>.baseURL` must use `http` or `https`. A non-local endpoint
produces a warning before any prompt is sent, because that endpoint receives the
entire prompt — and for `azure-openai`, the API key. Review any config that sets
`baseURL`, particularly one arriving in a pull request.

### Out of scope

API keys are read from environment variables and never written to config files
or generated output. The tool does not sandbox the LLM providers it calls, and
does not verify that generated notes are factually correct.

## Supported Versions

Security fixes are applied to the latest 1.x release.

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes |
| < 1.0   | No |

## Reporting a Vulnerability

Please report vulnerabilities privately to _t a b k r a m [at] g m a i l [dot] c o m_. Include a description, affected version, reproduction steps, and any proof-of-concept code.

Do not disclose the issue publicly until it has been addressed. Reports are acknowledged within four business days, and maintainers will provide progress updates.
