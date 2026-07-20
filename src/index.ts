/**
 * ai-release-notes
 * Generic AI-powered release notes generator
 *
 * Public API
 */

export {
  generate,
  generateFromChangelog,
} from "./generator.js";

export {
  loadConfig,
  createDefaultConfig,
  resolveProviderAlias,
  ConfigError,
} from "./config.js";

export {
  getChangelog,
  parseCommits,
  getLatestTag,
  getPreviousTag,
} from "./git.js";

export {
  callLLM,
  LLMError,
} from "./llm.js";

export {
  buildSystemPrompt,
  buildUserPrompt,
} from "./prompts/builder.js";

export {
  formatReleaseNote,
  markdownToHtml,
} from "./release.js";

export {
  loadContextFiles,
} from "./context.js";

export type {
  ParsedCommit,
  ProviderConfig,
  ProviderName,
  ReleaseNotesConfig,
  GenerateOptions,
  GenerateResult,
  SectionConfig,
  PromptConfig,
  ContextFile,
} from "./types.js";
