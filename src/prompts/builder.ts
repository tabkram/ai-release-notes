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

/**
 * Build the system prompt from config or use a default.
 */
export async function buildSystemPrompt(config?: PromptConfig): Promise<string> {
  // If user provided a custom system prompt, use it directly
  if (config?.system) {
    return config.system;
  }

  // Otherwise build from config pieces
  const language = config?.language || "en";
  const vocab = config?.vocabulary?.join(", ") || "";
  const sections = config?.sections;
  const instructions = await resolveInstructions(config?.instructions);

  let sectionGuide = "";
  if (sections && Object.keys(sections).length > 0) {
    sectionGuide = Object.entries(sections)
      .map(([_, s]) => `${s.icon || "•"} ${s.title}`)
      .join("\n");
  }

  const vocabLine = vocab
    ? `\nPreserve the following technical vocabulary without over-translating: ${vocab}`
    : "";

  const instructionsBlock = instructions
    ? `\n\nAdditional instructions:\n${instructions}`
    : "";

  return `You are a release notes writer.

Your goal: Transform technical changelog entries into clean, business-readable release notes.

Language: ${language}${vocabLine}

Output structure:
${sectionGuide || "- Features\n- Improvements\n- Bug Fixes\n- Technical"}

Guidelines:
- Do NOT mention commit hashes.
- Do NOT mention internal ticket IDs.
- Keep sentences concise.
- Group by domain.
- Preserve chronological order.
- Never create fake features.
- If a release contains only fixes, do not create a features section.
- Use bullet points.${instructionsBlock}
`;
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
