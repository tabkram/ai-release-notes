/**
 * Main generator orchestrator
 */

import { loadConfig, resolveProviderAlias } from "./config.js";
import { getChangelog, parseCommits } from "./git.js";
import { resolveReleaseDate } from "./release-date.js";
import { callLLM } from "./llm.js";
import {
  buildSystemPrompt,
  buildTranslationSystemPrompt,
  buildUserPrompt,
  resolveInstructions,
  resolvePromptSource,
} from "./prompts/builder.js";
import { DEFAULT_RELEASE_NOTE_TEMPLATE_PATH, renderReleaseNoteHtml } from "./release.js";
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
 * Unwrap a release note the model returned inside a code fence.
 *
 * Models routinely present a whole Markdown document as ```markdown … ```,
 * sometimes more than once. Left in place, that fence is faithfully rendered as
 * one big <pre><code> block: the reader gets the Markdown source instead of the
 * release note. Only a fence enclosing the entire document is removed, so a
 * fence used inside a note is still rendered as code.
 */
export function stripEnclosingCodeFence(markdown: string): string {
  let current = markdown.trim();

  // A doubly wrapped document needs more than one pass; the bound keeps a
  // pathological response from looping.
  for (let pass = 0; pass < 3; pass += 1) {
    const lines = current.split("\n");
    if (lines.length < 2) return current;

    const opening = /^(`{3,}|~{3,})[ \t]*[\w+-]*[ \t]*$/.exec(lines[0].trim());
    if (!opening) return current;

    // Without a matching closing fence on the very last line, the fence belongs
    // to the content rather than wrapping it.
    const marker = opening[1][0];
    const closing = new RegExp(`^\\${marker}{${opening[1].length},}[ \t]*$`);
    if (!closing.test(lines[lines.length - 1].trim())) return current;

    current = lines.slice(1, -1).join("\n").trim();
  }

  return current;
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

  const allCommits = parseCommits(rawCommits, {
    excludeTypes: config.git?.excludeTypes,
  });

  // git.maxCommits bounds what a single run can send to a paid API, so a repo
  // with years of history behind a missing tag cannot turn into one huge call.
  const maxCommits = config.git?.maxCommits ?? 200;
  const parsedCommits = allCommits.slice(0, maxCommits);
  if (allCommits.length > parsedCommits.length) {
    console.warn(
      `⚠️  ${allCommits.length} commits found; using the most recent ${maxCommits}. ` +
        `Raise git.maxCommits to include more.`
    );
  }

  // ── Load context files (files + dirs in one array) ──
  const contextFiles = await loadContextFiles(options.context);

  // ── Build prompts ──
  const languages = config.prompt?.languages?.length ? config.prompt.languages : ["en"];
  const primaryLanguage = languages[0];
  const systemPrompt = await buildSystemPrompt(config.prompt);
  const date = await resolveReleaseDate(options, options.toVersion);

  const userPrompt = buildUserPrompt({
    projectName: config.projectName,
    fromVersion: options.fromVersion,
    toVersion: options.toVersion,
    environment: options.environment,
    date,
    commits: parsedCommits,
    contextFiles: contextFiles.length > 0 ? contextFiles : undefined,
    language: primaryLanguage,
    template: await resolvePromptSource(config.prompt?.user),
  });

  // ── Dry run ──
  if (options.dryRun) {
    const dryOutput = `=== DRY RUN ===\n\nSYSTEM PROMPT:\n${systemPrompt}\n\nUSER PROMPT:\n${userPrompt}`;
    return {
      markdown: dryOutput,
      localized: [{ language: primaryLanguage, markdown: dryOutput }],
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
    primaryMarkdown = stripEnclosingCodeFence(llmResult.text);

    const translationInstructions = await resolveInstructions(config.prompt?.instructions);
    for (const language of languages.slice(1)) {
      const translatedRelease = await callLLM(
        providerName,
        providerConfig,
        await buildTranslationSystemPrompt(language, translationInstructions),
        primaryMarkdown
      );
      addUsage(usage, translatedRelease.usage);
      translatedReleases.push({
        language,
        markdown: stripEnclosingCodeFence(translatedRelease.text),
      });
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
    language: primaryLanguage,
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
    const htmlOutput = outputConfigs.find((output) => output.format === "html");
    const template = await loadReleaseNoteTemplate(options.template || htmlOutput?.template);
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

/** Load a custom release-note template, falling back to the bundled HTML template. */
export async function loadReleaseNoteTemplate(templatePath?: string): Promise<string> {
  const resolvedTemplatePath = templatePath
    ? resolve(templatePath)
    : DEFAULT_RELEASE_NOTE_TEMPLATE_PATH;

  if (templatePath && !existsSync(resolvedTemplatePath)) {
    throw new Error(`Release note template not found: ${resolvedTemplatePath}`);
  }

  return readFile(resolvedTemplatePath, "utf-8");
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

function addUsage(
  total: GenerationUsage,
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.totalTokens += usage.totalTokens;
  total.modelCalls += 1;
}
