/**
 * Main generator orchestrator
 */

import { loadConfig, resolveProviderAlias } from "./config.js";
import { getChangelog, getTagCreationDate, parseCommits } from "./git.js";
import { callLLM } from "./llm.js";
import {
  buildSystemPrompt,
  buildTranslationSystemPrompt,
  buildUserPrompt,
  resolveInstructions,
} from "./prompts/builder.js";
import { formatReleaseNote, renderReleaseNoteHtml } from "./release.js";
import { loadContextFiles } from "./context.js";
import type { GenerateOptions, GenerateResult, GenerationUsage } from "./types.js";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";

export class GenerationError extends Error {
  constructor(message: string, public readonly metadata: GenerateResult["metadata"]) {
    super(message);
    this.name = "GenerationError";
  }
}

/**
 * Generate release notes from git tags.
 * Main entry point for programmatic usage.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const startedAt = Date.now();
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
  const date = await resolveReleaseDate(options, options.toVersion);

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
      localized: [{ language: config.prompt?.languages?.[0] || "en", markdown: dryOutput }],
      metadata: {
        fromVersion: options.fromVersion,
        toVersion: options.toVersion,
        environment: options.environment,
        date,
        provider: providerName,
        commitCount: parsedCommits.length,
        contextFiles: contextFiles.map((cf) => cf.path),
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          modelCalls: 0,
          durationMs: Date.now() - startedAt,
        },
      },
    };
  }

  // ── Call LLM ──
  const usage: GenerationUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    modelCalls: 0,
    durationMs: 0,
  };
  const errorMetadata = {
    fromVersion: options.fromVersion,
    toVersion: options.toVersion,
    environment: options.environment,
    date,
    provider: providerName,
    commitCount: parsedCommits.length,
    contextFiles: contextFiles.map((cf) => cf.path),
    usage,
  };
  let primaryMarkdown = "";
  const translatedReleases: GenerateResult["localized"] = [];
  try {
    const llmResult = await callLLM(providerName, providerConfig, systemPrompt, userPrompt);
    addUsage(usage, llmResult.usage);
    primaryMarkdown = formatReleaseNote(llmResult.text, {
      fromVersion: options.fromVersion,
      toVersion: options.toVersion,
      environment: options.environment,
      date,
      projectName: config.projectName,
    });

    const translationInstructions = await resolveInstructions(config.prompt?.instructions);
    for (const language of (config.prompt?.languages || ["en"]).slice(1)) {
      const translatedRelease = await callLLM(
        providerName,
        providerConfig,
        await buildTranslationSystemPrompt(language, translationInstructions),
        primaryMarkdown
      );
      addUsage(usage, translatedRelease.usage);
      translatedReleases.push({ language, markdown: translatedRelease.text.trim() });
    }
  } catch (error) {
    usage.durationMs = Date.now() - startedAt;
    throw new GenerationError(
      error instanceof Error ? error.message : String(error),
      errorMetadata
    );
  }

  // ── Format output ──
  const localized = [{
    language: config.prompt?.languages?.[0] || "en",
    markdown: primaryMarkdown,
  }, ...translatedReleases];
  const markdown = localized
    .map((release, index) => index === 0
      ? release.markdown
      : "---\n\n## " + release.language + "\n\n" + release.markdown)
    .join("\n\n");

  const result: GenerateResult = {
    markdown,
    localized,
    metadata: {
      fromVersion: options.fromVersion,
      toVersion: options.toVersion,
      environment: options.environment,
      date,
      provider: providerName,
      commitCount: parsedCommits.length,
      contextFiles: contextFiles.map((cf) => cf.path),
      usage,
    },
  };

  // ── HTML output if requested ──
  const outputConfigs = config.output
    ? (Array.isArray(config.output) ? config.output : [config.output])
    : [];
  const needsHtml = outputConfigs.some((output) => output.format === "html");
  const outputFormat = options.format || outputConfigs[0]?.format || "md";
  if (outputFormat === "html" || needsHtml) {
    const template = await readFile(
      resolve(__dirname, "../templates/default-release-note.html"),
      "utf-8"
    );
    const renderHtmlRelease = (releaseMarkdown: string) => renderReleaseNoteHtml(template, releaseMarkdown, {
      fromVersion: options.fromVersion,
      toVersion: options.toVersion,
      environment: options.environment,
      date,
      projectName: config.projectName,
    });
    result.html = renderHtmlRelease(markdown);
    for (const release of result.localized) {
      release.html = renderHtmlRelease(release.markdown);
    }
  }

  usage.durationMs = Date.now() - startedAt;

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

async function resolveReleaseDate(options: GenerateOptions, toVersion: string): Promise<string> {
  if (!options.releaseDate) {
    return options.date || formatDate(new Date());
  }

  const value = options.releaseDate.trim();
  if (value.toLowerCase() === "now") {
    return formatDate(new Date());
  }
  if (value.toLowerCase() === "tag") {
    const tagDate = await getTagCreationDate(toVersion);
    if (!tagDate) {
      throw new Error(
        `Could not find a creation date for tag "${toVersion}". ` +
        `Use --release-date now or an ISO date such as 2026-07-20.`
      );
    }
    return formatDate(tagDate);
  }

  const specificDate = parseSpecificDate(value);
  if (!specificDate) {
    throw new Error(
      `Invalid release date "${value}". Use now, tag, or an ISO date such as 2026-07-20.`
    );
  }
  return formatDate(specificDate);
}

function parseSpecificDate(value: string): Date | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    return date.getFullYear() === Number(year) && date.getMonth() === Number(month) - 1 && date.getDate() === Number(day)
      ? date
      : null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addUsage(
  total: GenerationUsage,
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.totalTokens += usage.totalTokens;
  total.modelCalls += 1;
}
