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
  promote,
  planPromotion,
  latestPromotedVersion,
  compareVersions,
  PromotionError,
} from "./promote.js";

export {
  discoverReleases,
  formatOutputPath,
  isReleaseSpecificPath,
  normalizeEnvironment,
  normalizeLanguage,
  OUTPUT_PATH_PLACEHOLDERS,
} from "./output-path.js";

export {
  parseReleaseDocument,
  serializeReleaseDocument,
  mergeReleaseDocuments,
  joinReleaseDocuments,
  mergeSections,
  extractReleaseContent,
} from "./release-document.js";

export {
  updateOutputIndexes,
  createOrUpdateOutputIndex,
  discoverOutputIndexLanguages,
} from "./output-index.js";

export {
  resolveReleaseDate,
  formatDate,
} from "./release-date.js";

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
  getTagCreationDate,
} from "./git.js";

export {
  callLLM,
  LLMError,
} from "./llm.js";

export {
  buildSystemPrompt,
  buildUserPrompt,
  resolveInstructions,
  resolvePromptSource,
} from "./prompts/builder.js";

export {
  renderReleaseNoteHtml,
  renderReleaseNotePage,
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
  OutputConfig,
  OutputIndexConfig,
  PromptConfig,
  PromptSource,
  InstructionsConfig,
  ContextFile,
} from "./types.js";

export type {
  PromoteOptions,
  PromoteResult,
  PromotedFile,
  PromotionPlan,
  PromotionSegment,
} from "./promote.js";

export type { DiscoveredRelease, OutputPathValues } from "./output-path.js";

export type { ReleaseFormat, ReleaseBlock, ReleaseSection } from "./release-document.js";

export type { OutputIndexRelease, UpdateOutputIndexesParams } from "./output-index.js";

export type { ReleaseNoteParams } from "./release.js";
