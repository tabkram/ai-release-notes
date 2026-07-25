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
