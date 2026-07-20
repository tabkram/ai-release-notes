/**
 * Main generator orchestrator
 */

import { loadConfig, resolveProviderAlias } from "./config.js";
import { getChangelog, parseCommits } from "./git.js";
import { callLLM } from "./llm.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompts/builder.js";
import { formatReleaseNote, markdownToHtml } from "./release.js";
import { loadContextFiles } from "./context.js";
import type { GenerateOptions, GenerateResult } from "./types.js";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";

/**
 * Generate release notes from git tags.
 * Main entry point for programmatic usage.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const config = await loadConfig(options.configPath);

  const providerName = options.provider
    ? resolveProviderAlias(options.provider)
    : (config.provider as any);

  const providerConfig = config.providers[providerName];
  if (!providerConfig) {
    throw new Error(
      `Provider "${providerName}" not configured. ` +
        `Add it to your config file under providers.${providerName}`
    );
  }

  // ── Extract commits ──
  let rawCommits: string[];
  if (options.changelog) {
    rawCommits = options.changelog
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } else if (options.changelogFile) {
    const changelogPath = resolve(options.changelogFile);
    if (!existsSync(changelogPath)) {
      throw new Error(`Changelog file not found: ${changelogPath}`);
    }
    const content = await readFile(changelogPath, "utf-8");
    rawCommits = content.split("\n").map((l) => l.trim()).filter(Boolean);
  } else {
    rawCommits = await getChangelog(options.fromVersion, options.toVersion);
  }

  if (rawCommits.length === 0) {
    throw new Error(
      `No commits found between ${options.fromVersion} and ${options.toVersion}`
    );
  }

  const parsedCommits = parseCommits(rawCommits, {
    excludeTypes: config.git?.excludeTypes,
  });

  // ── Load context files (files + dirs in one array) ──
  const contextFiles = await loadContextFiles(options.context);

  // ── Build prompts ──
  const systemPrompt = await buildSystemPrompt(config.prompt);
  const date = options.date || formatDate(new Date());

  const userPrompt = buildUserPrompt({
    fromVersion: options.fromVersion,
    toVersion: options.toVersion,
    environment: options.environment,
    date,
    commits: parsedCommits,
    contextFiles: contextFiles.length > 0 ? contextFiles : undefined,
  });

  // ── Dry run ──
  if (options.dryRun) {
    const dryOutput = `=== DRY RUN ===\n\nSYSTEM PROMPT:\n${systemPrompt}\n\nUSER PROMPT:\n${userPrompt}`;
    return {
      markdown: dryOutput,
      metadata: {
        fromVersion: options.fromVersion,
        toVersion: options.toVersion,
        environment: options.environment,
        date,
        provider: providerName,
        commitCount: parsedCommits.length,
        contextFiles: contextFiles.map((cf) => cf.path),
      },
    };
  }

  // ── Call LLM ──
  const llmOutput = await callLLM(providerName, providerConfig, systemPrompt, userPrompt);

  // ── Format output ──
  const markdown = formatReleaseNote(llmOutput, {
    fromVersion: options.fromVersion,
    toVersion: options.toVersion,
    environment: options.environment,
    date,
  });

  const result: GenerateResult = {
    markdown,
    metadata: {
      fromVersion: options.fromVersion,
      toVersion: options.toVersion,
      environment: options.environment,
      date,
      provider: providerName,
      commitCount: parsedCommits.length,
      contextFiles: contextFiles.map((cf) => cf.path),
    },
  };

  // ── HTML output if requested ──
  const outputFormat = options.format || config.output?.format || "md";
  if (outputFormat === "html") {
    result.html = markdownToHtml(markdown);
  }

  return result;
}

/**
 * Generate release notes from a raw changelog string.
 * Useful for CI/CD pipelines or when git history is not available.
 */
export async function generateFromChangelog(
  changelog: string,
  options: Omit<GenerateOptions, "changelog" | "changelogFile">
): Promise<GenerateResult> {
  return generate({ ...options, changelog });
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}
