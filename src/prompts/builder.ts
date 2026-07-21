/**
 * Prompt builder — fully customizable via config
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import type { ParsedCommit, PromptConfig, ContextFile, InstructionsConfig } from "../types.js";

/**
 * Resolve instructions from inline text or file path.
 */
export async function resolveInstructions(
  instructions?: InstructionsConfig
): Promise<string> {
  if (!instructions) return "";

  if (typeof instructions === "string") {
    return instructions;
  }

  // It's a file reference
  const filePath = resolve(instructions.file);
  if (!existsSync(filePath)) {
    throw new Error(`Instructions file not found: ${filePath}`);
  }
  return await readFile(filePath, "utf-8");
}

/** Build the system prompt used to translate an already-generated release note. */
export async function buildTranslationSystemPrompt(
  language: string,
  instructions?: string
): Promise<string> {
  const template = await readFile(
    resolve(__dirname, "../../prompts/release-notes-translation-system.md"),
    "utf-8"
  );
  const translationInstructions = instructions || "No additional project instructions were supplied.";

  return template
    .replaceAll("{{language}}", language)
    .replaceAll("{{instructions}}", translationInstructions)
    .trim();
}

/**
 * Build the system prompt from config or use a default.
 */
export async function buildSystemPrompt(config?: PromptConfig): Promise<string> {
  const instructionOverride = await resolveInstructions(config?.instructions);
  const instructions = instructionOverride || await readFile(
    resolve(__dirname, "../../prompts/release-notes-instructions.md"),
    "utf-8"
  );

  // A custom system prompt still receives either the override or built-in rules.
  if (config?.system) {
    return config.system.trim() + "\n\n" + instructions.trim() + "\n";
  }

  // Otherwise load the bundled prompt template and add project instructions.
  const language = config?.languages?.[0] || "en";
  const template = await readFile(
    resolve(__dirname, "../../prompts/release-notes-system.md"),
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
  contextFiles?: ContextFile[];
}): string {
  const commitLines = params.commits
    .map((c) => {
      const scope = c.scope ? `[${c.scope}] ` : "";
      return `- ${c.type}: ${scope}${c.message}`;
    })
    .join("\n");

  let contextBlock = "";
  if (params.contextFiles && params.contextFiles.length > 0) {
    contextBlock = params.contextFiles
      .map(
        (cf) => `\n--- Context from ${cf.path} ---\n${cf.content}\n---\n`
      )
      .join("\n");
  }

  return `Previous version: ${params.fromVersion}
Current version: ${params.toVersion}
Environment: ${params.environment}
Release date: ${params.date}

Changelog (${params.commits.length} commits):
${commitLines}${contextBlock}

Generate the release notes in the requested format.`;
}
