/**
 * Configuration loader & validation
 * API keys are NEVER stored in config files — they come from environment variables.
 * Only the API key for the active provider is required at runtime.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import YAML from "yaml";
import {
  ReleaseNotesConfigSchema,
  type ReleaseNotesConfig,
  type ProviderName,
} from "./types.js";

const GLOBAL_CONFIG_PATH = resolve(homedir(), ".ai-release-notes.yml");
const LOCAL_CONFIG_NAMES = [
  ".ai-release-notes.yml",
  ".ai-release-notes.yaml",
  "ai-release-notes.config.yml",
];

/**
 * Load and validate configuration from file(s).
 * Priority: explicit path > local > global
 */
export async function loadConfig(
  explicitPath?: string
): Promise<ReleaseNotesConfig> {
  const configPath = explicitPath
    ? resolve(explicitPath)
    : findLocalConfig() || GLOBAL_CONFIG_PATH;

  if (!existsSync(configPath)) {
    throw new ConfigError(
      `Config file not found: ${configPath}\n\n` +
        `Run \"npx ai-release-notes init\" to create one, ` +
        `or provide --config <path>.` +
        `\n\nNote: API keys are NOT stored in config files. ` +
        `Only the API key for your chosen provider is required via environment variable.`
    );
  }

  const raw = await readFile(configPath, "utf-8");
  const parsed = YAML.parse(raw);

  const result = ReleaseNotesConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `Invalid config in ${configPath}:\n` +
        result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")
    );
  }

  return result.data;
}

/**
 * Create a default config file at the given path
 */
export async function createDefaultConfig(targetPath: string): Promise<void> {
  const { writeFile, mkdir } = await import("fs/promises");
  await mkdir(dirname(targetPath), { recursive: true });

  const defaultConfig = `# ai-release-notes configuration
#
# IMPORTANT: API keys are NOT stored in this file.
# Only the API key for the provider you use is required.
# Set it as an environment variable before running:
#
#   export OPENAI_API_KEY=sk-...        # for OpenAI
#   export ANTHROPIC_API_KEY=sk-ant-... # for Anthropic
#   export MISTRAL_API_KEY=...          # for Mistral
#   export GOOGLE_API_KEY=...           # for Google
#   export AZURE_OPENAI_API_KEY=...     # for Azure OpenAI
#
# You only need ONE — the one matching your chosen provider.

# ─────────────────────────────────────────
# LLM Provider
# ─────────────────────────────────────────

provider: openai

providers:
  openai:
    model: gpt-4o
    temperature: 0.3
    maxTokens: 4000

  anthropic:
    model: claude-sonnet-4-20250514
    temperature: 0.3
    maxTokens: 4000

  mistral:
    model: mistral-large-latest
    temperature: 0.3
    maxTokens: 4000

  google:
    model: gemini-1.5-pro
    temperature: 0.3
    maxTokens: 4000

  ollama:
    baseURL: http://localhost:11434/v1
    model: llama3.1
    temperature: 0.3

# ─────────────────────────────────────────
# Prompt customization (optional)
# ─────────────────────────────────────────

prompt:
  language: en

  vocabulary:
    - API
    - endpoint
    - dashboard
    - webhook

  sections:
    features:
      icon: "🚀"
      title: "New Features"
    improvements:
      icon: "✨"
      title: "Improvements"
    fixes:
      icon: "🐛"
      title: "Bug Fixes"
    technical:
      icon: "⚙️"
      title: "Technical"

  instructions: |
    - Do NOT mention commit hashes
    - Do NOT mention internal ticket IDs
    - Keep sentences concise
    - Group by domain

# ─────────────────────────────────────────
# Git settings
# ─────────────────────────────────────────

git:
  commitFormat: conventional
  excludeTypes:
    - chore
    - docs
    - style
  maxCommits: 200

# ─────────────────────────────────────────
# Output settings
# ─────────────────────────────────────────

output:
  format: markdown
  saveTo: ./RELEASE_NOTES.md
`;

  await writeFile(targetPath, defaultConfig, "utf-8");
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

function findLocalConfig(): string | null {
  const cwd = process.cwd();
  for (const name of LOCAL_CONFIG_NAMES) {
    const path = resolve(cwd, name);
    if (existsSync(path)) return path;
  }
  return null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Map CLI alias to canonical provider name
 */
export function resolveProviderAlias(alias: string): ProviderName {
  const map: Record<string, ProviderName> = {
    claude: "anthropic",
    gpt4: "openai",
    gpt: "openai",
    mistral: "mistral",
    gemini: "google",
    ollama: "ollama",
    azure: "azure-openai",
  };
  return map[alias.toLowerCase()] || (alias as ProviderName);
}
