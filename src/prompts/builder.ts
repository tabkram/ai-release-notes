/**
 * Prompt builder — fully customizable via config
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import type {
  ParsedCommit,
  PromptConfig,
  PromptSource,
  ContextFile,
  InstructionsConfig,
} from "../types.js";

const BUNDLED_PROMPTS = resolve(__dirname, "../../prompts");

/** Read a prompt from inline text or from a file. */
export async function resolvePromptSource(source?: PromptSource): Promise<string> {
  if (!source) return "";
  if (typeof source === "string") return source;

  const filePath = resolve(source.file);
  if (!existsSync(filePath)) {
    throw new Error(`Prompt file not found: ${filePath}`);
  }
  return await readFile(filePath, "utf-8");
}

/** Resolve the project's writing rules; they apply to every prompt. */
export async function resolveInstructions(
  instructions?: InstructionsConfig
): Promise<string> {
  return resolvePromptSource(instructions);
}

/** Build the system prompt used to translate an already-generated release note. */
export async function buildTranslationSystemPrompt(
  language: string,
  instructions?: string
): Promise<string> {
  const template = await readFile(
    resolve(BUNDLED_PROMPTS, "release-notes-translation-system.md"),
    "utf-8"
  );
  const translationInstructions = instructions?.trim() || "No additional project instructions were supplied.";

  return template
    .replaceAll("{{language}}", language)
    .replaceAll("{{instructions}}", translationInstructions)
    .trim();
}

/**
 * Build the system prompt from config or use a default.
 *
 * Project instructions replace the built-in ones; the built-in instructions
 * apply whenever a project supplies none.
 */
export async function buildSystemPrompt(config?: PromptConfig): Promise<string> {
  const instructionOverride = await resolveInstructions(config?.instructions);
  const instructions = instructionOverride || await readFile(
    resolve(BUNDLED_PROMPTS, "release-notes-instructions.md"),
    "utf-8"
  );

  // A custom system prompt still receives either the override or built-in rules.
  const customSystem = await resolvePromptSource(config?.system);
  if (customSystem) {
    return customSystem.trim() + "\n\n" + instructions.trim() + "\n";
  }

  // Otherwise load the bundled prompt template and add project instructions.
  const language = config?.languages?.[0] || "en";
  const template = await readFile(
    resolve(BUNDLED_PROMPTS, "release-notes-system.md"),
    "utf-8"
  );

  return template
    .replaceAll("{{language}}", language)
    .replaceAll("{{instructions}}", instructions.trim())
    .trim() + "\n";
}

/**
 * Build the user prompt from commits, metadata, and optional context files.
 */
export function buildUserPrompt(params: {
  fromVersion: string;
  toVersion: string;
  environment: string;
  date: string;
  commits: ParsedCommit[];
  projectName?: string;
  contextFiles?: ContextFile[];
  language?: string;
  template?: string;
}): string {
  const changelog = params.commits
    .map((c) => {
      const scope = c.scope ? `[${c.scope}] ` : "";
      return `- ${c.type}: ${scope}${c.message}`;
    })
    .join("\n");

  const context = (params.contextFiles ?? [])
    .map((cf) => `\n--- Context from ${cf.path} ---\n${cf.content}\n---\n`)
    .join("\n");

  if (params.template?.trim()) {
    const values: Record<string, string> = {
      projectName: params.projectName ?? "",
      fromVersion: params.fromVersion,
      toVersion: params.toVersion,
      environment: params.environment,
      date: params.date,
      language: params.language ?? "",
      commitCount: String(params.commits.length),
      changelog,
      context,
    };
    return params.template
      .replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => values[key] ?? match)
      .trim();
  }

  const project = params.projectName ? `Project: ${params.projectName}\n` : "";

  return `${project}Previous version: ${params.fromVersion}
Current version: ${params.toVersion}
Environment: ${params.environment}
Release date: ${params.date}

Changelog (${params.commits.length} commits):
${changelog}${context}

Generate the release notes in the requested format.`;
}
