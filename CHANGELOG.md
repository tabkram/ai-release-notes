## [0.4.0](https://github.com/tabkram/ai-release-notes/compare/v0.3.0...v0.4.0) (2026-07-26)

### Features

* add `promote` command to reuse release notes across environments ([3c06b81](https://github.com/tabkram/ai-release-notes/commit/3c06b816b442365c82619961959db6d42952a9d7))
* allow interactive natural language revision of release notes ([b5d8740](https://github.com/tabkram/ai-release-notes/commit/b5d8740445342f48c59391a4ca7b732cdced4de2))
* allow LLM to write single opening for merged release notes ([379573b](https://github.com/tabkram/ai-release-notes/commit/379573bdc6d157046b39b364406cb700bea47fe2))
* improve interactive session clarity and save prompting ([c2d7c1f](https://github.com/tabkram/ai-release-notes/commit/c2d7c1f6d12f2f399b1d96b368d187bb27644da6))
* improve release note comparison robustness and LLM output consistency ([6af4fab](https://github.com/tabkram/ai-release-notes/commit/6af4fab87fba0fbc55c276b5693b97bbad7a4756))
## [0.3.0](https://github.com/tabkram/ai-release-notes/compare/v0.2.0...v0.3.0) (2026-07-25)

### ⚠ BREAKING CHANGES

* markdownToHtml no longer takes title or footer args, and {{title}} is not filled.

### Features

* add canary versioning and improve npm publishing ([b124760](https://github.com/tabkram/ai-release-notes/commit/b12476046c5e416da2a0923eab967db91ca83093))
* let templates own every word of a generated page ([734cf2e](https://github.com/tabkram/ai-release-notes/commit/734cf2e78e91b721e00c21acc5d94469332dbe2b))
## [0.2.0](https://github.com/tabkram/ai-release-notes/compare/v0.1.0...v0.2.0) (2026-07-25)

### Bug Fixes

* strip code fences from release notes and improve duplicate detection ([7ebee00](https://github.com/tabkram/ai-release-notes/commit/7ebee00f90be06d813ffbe3d36ea60ce5b821e6d))
## [0.1.0](https://github.com/tabkram/ai-release-notes/compare/v0.0.2...v0.1.0) (2026-07-24)

### ⚠ BREAKING CHANGES

* **security:** raw HTML in a generated release note is escaped rather than
rendered, git.maxCommits is enforced at 200 by default, and a context
directory scan now skips files it previously uploaded.
* **prompt:** formatReleaseNote is no longer exported and the release
header is no longer added after generation. A project that overrides
prompt.instructions must describe its title block there.

### Features

* **prompt:** let instructions own the whole release note ([56674de](https://github.com/tabkram/ai-release-notes/commit/56674dec3847474ac5be9a44274566363835bb2f))

### Bug Fixes

* **security:** treat changelog, context, and config as untrusted ([f386c0d](https://github.com/tabkram/ai-release-notes/commit/f386c0dcf429fa61050b5009968c294009c45a18))

## [0.0.1](https://github.com/tabkram/ai-release-notes/compare/683de54746e903e8ec1208cf332d65e2fe0b92b0...v0.0.1) (2026-07-22)

### Features

* add language switcher for localized output indexes ([7918066](https://github.com/tabkram/ai-release-notes/commit/7918066099b4caa9da0d97915182bbae4d476d98))
* Add multilingual release notes and history management ([72af88b](https://github.com/tabkram/ai-release-notes/commit/72af88bab78a72d83462e89e6bb85b9c22a38623))
* create a main release notes file ([d9c10cd](https://github.com/tabkram/ai-release-notes/commit/d9c10cd661ed6bf3f1665d6f9df214ec7ed1c272))
* Enhance Markdown rendering for headings and nested lists ([cd2bef6](https://github.com/tabkram/ai-release-notes/commit/cd2bef6bc172b9adf563a6841bb4ce0146186f60))
* Implement AI-powered release notes generator CLI ([683de54](https://github.com/tabkram/ai-release-notes/commit/683de54746e903e8ec1208cf332d65e2fe0b92b0))
* Refine prompt instruction handling and verbose output ([31c9af0](https://github.com/tabkram/ai-release-notes/commit/31c9af085cda0aa028590fd62bf7d94ed08cf588))
* set first version at 0.0.1 ([94faff3](https://github.com/tabkram/ai-release-notes/commit/94faff3f1411ef293fe7e7159b679af4b51f6774))
