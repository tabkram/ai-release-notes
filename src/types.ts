/**
 * Core types for ai-release-notes
 */

import { z } from "zod";

// ─────────────────────────────────────────
// Commit types
// ─────────────────────────────────────────

export interface ParsedCommit {
  hash: string;
  type: string;
  scope?: string;
  message: string;
  body?: string;
  author: string;
  date: string;
}

// ─────────────────────────────────────────
// Provider configuration
// ─────────────────────────────────────────

export const ProviderConfigSchema = z.object({
  model: z.string().optional(),
  baseURL: z.string().url().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export type ProviderName =
  | "openai"
  | "anthropic"
  | "mistral"
  | "google"
  | "azure-openai"
  | "ollama";

// ─────────────────────────────────────────
// Section configuration
// ─────────────────────────────────────────

export const SectionConfigSchema = z.object({
  icon: z.string().optional(),
  title: z.string(),
});

export type SectionConfig = z.infer<typeof SectionConfigSchema>;

// ─────────────────────────────────────────
// Instructions — can be inline text or a file path
// ─────────────────────────────────────────

export const InstructionsConfigSchema = z.union([
  z.string(),                        // inline instructions
  z.object({                         // file reference
    file: z.string(),
  }),
]);

export type InstructionsConfig = z.infer<typeof InstructionsConfigSchema>;

// ─────────────────────────────────────────
// Prompt configuration
// ─────────────────────────────────────────

export const PromptConfigSchema = z.object({
  system: z.string().optional(),
  user: z.string().optional(),
  language: z.string().default("en"),
  vocabulary: z.array(z.string()).optional(),
  sections: z.record(SectionConfigSchema).optional(),
  /**
   * Additional instructions for the LLM.
   * Can be:
   * - A string (inline instructions)
   * - { file: "path/to/instructions.md" } (load from file)
   */
  instructions: InstructionsConfigSchema.optional(),
});

export type PromptConfig = z.infer<typeof PromptConfigSchema>;

// ─────────────────────────────────────────
// Full configuration schema
// ─────────────────────────────────────────

export const GitConfigSchema = z.object({
  commitFormat: z.enum(["conventional", "raw"]).default("conventional"),
  excludeTypes: z.array(z.string()).optional(),
  maxCommits: z.number().positive().default(200),
});

export const OutputConfigSchema = z.object({
  format: z.enum(["markdown", "html"]).default("markdown"),
  template: z.string().optional(),
  saveTo: z.string().optional(),
  clipboard: z.boolean().default(false),
});

export const ReleaseNotesConfigSchema = z.object({
  provider: z.string().default("openai"),
  providers: z.record(ProviderConfigSchema),
  prompt: PromptConfigSchema.optional(),
  git: GitConfigSchema.optional(),
  output: OutputConfigSchema.optional(),
});

export type ReleaseNotesConfig = z.infer<typeof ReleaseNotesConfigSchema>;

// ─────────────────────────────────────────
// Context file (specs, models, etc.)
// ─────────────────────────────────────────

export interface ContextFile {
  path: string;
  content: string;
}

// ─────────────────────────────────────────
// Generation options
// ─────────────────────────────────────────

export interface GenerateOptions {
  /** Previous version tag (e.g. "v1.0.0") */
  fromVersion: string;
  /** Current version tag (e.g. "v1.1.0") */
  toVersion: string;
  /** Environment name: PROD, QUA, DEV, etc. */
  environment: string;
  /** Release date (default: today) */
  date?: string;
  /** Override LLM provider */
  provider?: ProviderName | string;
  /** Path to config file */
  configPath?: string;
  /** Raw changelog text (skip git extraction) */
  changelog?: string;
  /** Path to a changelog file (skip git extraction) */
  changelogFile?: string;
  /** Dry-run: show prompt without calling LLM */
  dryRun?: boolean;
  /** Copy result to clipboard */
  clipboard?: boolean;
  /** Output file path */
  outputPath?: string;
  /** Output folder (default: current dir) */
  outputDir?: string;
  /** Output format: md or html */
  format?: "md" | "html";
  /** Template file path (Handlebars/Mustache) */
  template?: string;
  /**
   * Context files or directories to include in the prompt.
   * Files are loaded directly. Directories are scanned recursively.
   * Example: ["./specs/api.md", "./docs/models/"]
   */
  context?: string[];
}

// ─────────────────────────────────────────
// Release note result
// ─────────────────────────────────────────

export interface GenerateResult {
  markdown: string;
  html?: string;
  metadata: {
    fromVersion: string;
    toVersion: string;
    environment: string;
    date: string;
    provider: string;
    commitCount: number;
    contextFiles?: string[];
  };
}
