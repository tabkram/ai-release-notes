#!/usr/bin/env node
/**
 * CLI entry point
 */

import { Command } from "commander";
import chalk from "chalk";
import { generate, GenerationError } from "../generator.js";
import { callLLM } from "../llm.js";
import {
  applyOutputIndexLanguageSwitcher,
  hasOutputIndexLanguageSwitcher,
  markdownToHtml,
  outputIndexReleaseId,
  readLegacyOutputIndexEntries,
  readOutputIndexReleaseRecords,
  readOutputIndexReleasesRegion,
  renderOutputIndexLanguageSwitcher,
  renderOutputIndexReleases,
  replaceOutputIndexReleases,
  upsertOutputIndexReleaseRecord,
  RELEASES_MARKER,
  RELEASES_END_MARKER,
  type OutputIndexEntryTemplate,
  type OutputIndexLanguageLink,
  type OutputIndexReleaseRecord,
} from "../release.js";
import { createDefaultConfig, loadConfig, resolveProviderAlias } from "../config.js";
import { discoverOutputIndexLanguages } from "../output-index.js";
import { FIRST_RELEASE, getLatestTag, isFirstRelease } from "../git.js";
import { writeFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve, join, dirname, relative } from "path";
import clipboardy from "clipboardy";
import ora from "ora";
import type { GenerateResult, PromptSource, ProviderConfig, ProviderName, ReleaseNotesConfig } from "../types.js";
import { AI_RELEASE_NOTES_VERSION } from "../version.js";

const CLI_VERSION = AI_RELEASE_NOTES_VERSION;
const LANGUAGE_PATH_PLACEHOLDER = "aireleasenoteslanguageplaceholder";
const program = new Command();

type OutputTarget = {
  path: string;
  markdown: string;
  html?: string;
  format?: string;
  language?: string;
  /**
   * The path names this release and no other, so the file holds one release:
   * regenerating it replaces its content. A path shared by every release
   * accumulates them instead.
   */
  ownedByRelease?: boolean;
};

type OutputIndexTarget = {
  path: string;
  groupId: number;
  language?: string;
  format: "markdown" | "html";
  templatePath?: string;
  entryTemplatePath?: string;
  templateLanguage: string;
};

type OutputIndexLanguageTarget = Pick<
  OutputIndexTarget,
  "path" | "groupId" | "format" | "templatePath"
> & { language: string };

function printStatus(stdout: boolean, message: string): void {
  if (stdout) {
    console.error(message);
    return;
  }
  console.log(message);
}

/** Where a prompt comes from, for the verbose report. */
function describePromptSource(source?: PromptSource): string {
  if (!source) return "built-in defaults";
  return typeof source === "string" ? "inline configuration" : `file ${source.file}`;
}

function printVerboseGenerationDetails(
  stdout: boolean,
  config: ReleaseNotesConfig,
  result: GenerateResult,
  dryRun: boolean
): void {
  const languages = config.prompt?.languages || ["en"];
  const instructions = config.prompt?.instructions;

  printStatus(stdout, chalk.gray("\n🧭 Generation details"));
  printStatus(stdout, chalk.gray(`   Main language: ${languages[0]}`));
  printStatus(stdout, chalk.gray(`   Instructions: ${describePromptSource(instructions)}`));
  if (languages.length > 1) {
    const mode = dryRun ? "configured" : "completed";
    printStatus(
      stdout,
      chalk.gray(`   Translations ${mode}: ${languages[0]} → ${languages.slice(1).join(", ")} (translation only; facts and structure are preserved)`)
    );
  }
  printStatus(stdout, chalk.gray(`   Provider: ${result.metadata.provider} | Model calls: ${result.metadata.usage.modelCalls}`));
}

function printGenerationSummary(stdout: boolean, result: Pick<GenerateResult, "metadata">): void {
  const usage = result.metadata.usage;
  printStatus(stdout, chalk.gray(
    `\n📊 ${result.metadata.commitCount} commits | ${result.metadata.provider} | ${result.metadata.date} | ${formatDuration(usage.durationMs)}`
  ));
  if (usage.modelCalls > 0) {
    printStatus(stdout, chalk.gray(
      `🪙 Tokens: ${formatNumber(usage.inputTokens)} input + ${formatNumber(usage.outputTokens)} output = ${formatNumber(usage.totalTokens)} | ${usage.modelCalls} model call${usage.modelCalls === 1 ? "" : "s"}`
    ));
  } else {
    printStatus(stdout, chalk.gray("🪙 Tokens: no model tokens used (dry run)"));
  }
  if (result.metadata.contextFiles && result.metadata.contextFiles.length > 0) {
    printStatus(stdout, chalk.gray(`📎 Context files: ${result.metadata.contextFiles.join(", ")}`));
  }
}

function formatGenerationError(
  error: unknown,
  result?: Pick<GenerateResult, "metadata">,
  config?: ReleaseNotesConfig,
  providerOverride?: ProviderName
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!/rate limit|too many requests|\b429\b|quota/i.test(message)) {
    return message;
  }

  const provider = result?.metadata.provider || providerOverride;
  const model = provider ? config?.providers[provider]?.model : undefined;
  const target = [provider, model].filter(Boolean).join(" / ") || "the selected provider";

  return [
    `Rate limit reached for ${target}.`,
    "The provider rejected another API request because the active API key/account exceeded a request-rate or token-throughput quota.",
    "This is not a limit on the number of commits or context files in this release.",
    "The provider did not include the exact quota or reset time in this error; wait briefly, reduce the prompt/context or number of generated languages, or use an API key/account with more capacity.",
    `Provider error: ${message}`,
  ].join("\n");
}

program
  .name("ai-release-notes")
  .description("🤖 AI-powered release notes generator")
  .version(CLI_VERSION);

// ── init ──
program
  .command("init")
  .description("Create a default configuration file")
  .option("-g, --global", "Create in home directory (~/.ai-release-notes.yml)")
  .option("-f, --force", "Overwrite existing file")
  .action(async (opts) => {
    const { homedir } = await import("os");
    const { resolve } = await import("path");
    const { existsSync } = await import("fs");

    const targetPath = opts.global
      ? resolve(homedir(), ".ai-release-notes.yml")
      : resolve(process.cwd(), ".ai-release-notes.yml");

    if (existsSync(targetPath) && !opts.force) {
      console.log(chalk.yellow("⚠️  Config file already exists. Use --force to overwrite."));
      process.exit(1);
    }

    await createDefaultConfig(targetPath);
    console.log(chalk.green(`✅ Created config: ${targetPath}`));
  });

// ── generate ──
program
  .command("generate")
  .alias("gen")
  .description("Generate release notes from git tags")
  .option(
    "--from <version>",
    `Previous version tag, or "${FIRST_RELEASE}" for the full history`,
    FIRST_RELEASE
  )
  .option("--to <version>", "Current version tag (e.g. v1.1.0)")
  .requiredOption("--env <environment>", "Environment: PROD, STAGING, DEV...")
  .option("--release-date <value>", 'Release date: "now", "tag", or an ISO date (default: now)')
  .option("--date <value>", 'Alias for --release-date ("now", "tag", or an ISO date)')
  .option("--with <provider>", "LLM provider override (claude, gpt4, mistral, gemini, ollama)")
  .option("--config <path>", "Path to config file")
  .option("--output <path>", "Output file path (override config)")
  .option("--output-dir <dir>", "Output directory (default: current dir)")
  .option("--format <format>", "Output format: md or html")
  .option("--template <path>", "Path to custom template file")
  .option("--changelog <path>", "Path to a file containing raw changelog (skip git)")
  .option("--context <paths...>", "Context files or directories (specs, models, etc.)")
  .option("--dry-run", "Show prompts without calling LLM")
  .option("-v, --verbose", "Show applied instructions and generation steps")
  .option("--stdout", "Write generated release notes to the terminal without saving files")
  .option("--clipboard", "Copy result to clipboard")
  .action(async (opts) => {
    let result: GenerateResult | undefined;
    let config: ReleaseNotesConfig | undefined;
    let summaryPrinted = false;
    try {
      // Start at the repository's first commit unless an explicit tag/ref is provided.
      const fromVersion = opts.from;
      let toVersion = opts.to;

      if (!toVersion) {
        toVersion = await getLatestTag();
        if (!toVersion) {
          console.error(chalk.red("❌ Could not detect current tag. Use --to <version>"));
          process.exit(1);
        }
        printStatus(opts.stdout, chalk.blue(`📌 Detected current tag: ${toVersion}`));
      }

      const loadedConfig = await loadConfig(opts.config);
      config = loadedConfig;
      const spinner = ora("🤖 Generating release notes...").start();

      const generatedResult = await generate({
        fromVersion,
        toVersion,
        environment: opts.env,
        releaseDate: opts.releaseDate || opts.date,
        provider: opts.with,
        configPath: opts.config,
        changelogFile: opts.changelog,
        dryRun: opts.dryRun,
        clipboard: opts.clipboard,
        outputPath: opts.output,
        outputDir: opts.outputDir,
        format: opts.format,
        template: opts.template,
        context: opts.context,
      });
      result = generatedResult;

      spinner.succeed("✅ Done!");

      if (opts.verbose) {
        printVerboseGenerationDetails(opts.stdout, loadedConfig, generatedResult, opts.dryRun);
      }

      if (opts.stdout) {
        console.log(generatedResult.markdown);
      }

      // Determine output path
      let outputTargets: OutputTarget[] = !opts.stdout && opts.output
        ? [{ path: opts.output, markdown: generatedResult.markdown, html: generatedResult.html, format: opts.format, ownedByRelease: true }]
        : [];
      if (!opts.stdout && outputTargets.length === 0 && opts.outputDir) {
        const ext = opts.format === "html" ? "html" : "md";
        const filename = `RELEASE_NOTES_${toVersion.replace(/^v/, "")}.${ext}`;
        outputTargets = [{ path: join(resolve(opts.outputDir), filename), markdown: generatedResult.markdown, html: generatedResult.html, format: opts.format, ownedByRelease: true }];
      }

      if (!opts.stdout && outputTargets.length === 0) {
        if (loadedConfig.output) {
          const outputConfigs = Array.isArray(loadedConfig.output) ? loadedConfig.output : [loadedConfig.output];
          outputTargets = outputConfigs.flatMap((output) => {
            if (!output.saveTo) return [];
            const saveTo = Array.isArray(output.saveTo) ? output.saveTo : [output.saveTo];
            return saveTo.flatMap((path) => {
              const ownedByRelease = isReleaseSpecificPath(path);
              return path.includes("{lang}")
                ? generatedResult.localized.map((release) => ({
                    path: getOutputPath(path, opts.env, release.language, opts.from, opts.to),
                    markdown: release.markdown,
                    html: release.html,
                    format: output.format,
                    language: release.language,
                    ownedByRelease,
                  }))
                : [{
                    path: getOutputPath(path, opts.env, undefined, opts.from, opts.to),
                    markdown: generatedResult.markdown,
                    html: generatedResult.html,
                    format: output.format,
                    ownedByRelease,
                  }];
            });
          });
        }
      }

      const outputIndexConfigs = loadedConfig.outputIndex
        ? (Array.isArray(loadedConfig.outputIndex) ? loadedConfig.outputIndex : [loadedConfig.outputIndex])
        : [];
      // An index template is written in the language the release is generated
      // in, so prompt.languages already answers this.
      const primaryLanguage = generatedResult.localized[0]?.language ?? "en";
      const outputIndexTargets: OutputIndexTarget[] = outputIndexConfigs.flatMap((outputIndex, groupId) =>
        outputIndex.saveTo.includes("{lang}")
          ? generatedResult.localized.map((release) => ({
              path: resolve(getOutputPath(outputIndex.saveTo, opts.env, release.language, opts.from, opts.to)),
              groupId,
              language: release.language,
              format: outputIndex.format,
              templatePath: outputIndex.template,
              entryTemplatePath: outputIndex.entryTemplate,
              templateLanguage: primaryLanguage,
            }))
          : [{
              path: resolve(getOutputPath(outputIndex.saveTo, opts.env, undefined, opts.from, opts.to)),
              groupId,
              format: outputIndex.format,
              templatePath: outputIndex.template,
              entryTemplatePath: outputIndex.entryTemplate,
              templateLanguage: primaryLanguage,
            }]
      );
      if (outputIndexTargets.some((index) => outputTargets.some((target) => resolve(target.path) === index.path))) {
        throw new Error("outputIndex.saveTo must be different from every output.saveTo path");
      }
      const duplicateIndexPath = outputIndexTargets.find((target, index) =>
        outputIndexTargets.findIndex(
          (candidate) => candidate.path.toLowerCase() === target.path.toLowerCase()
        ) !== index
      );
      if (duplicateIndexPath) {
        throw new Error(
          `outputIndex.saveTo resolves more than once to ${duplicateIndexPath.path}. ` +
          `Use distinct paths and language values.`
        );
      }
      const outputIndexLanguageTargets: OutputIndexLanguageTarget[] = outputIndexTargets
        .flatMap((target) => target.language ? [{ ...target, language: target.language }] : []);
      for (const [groupId, outputIndex] of outputIndexConfigs.entries()) {
        if (!outputIndex.saveTo.includes("{lang}")) continue;
        const patternPath = resolve(getOutputPath(
          outputIndex.saveTo,
          opts.env,
          LANGUAGE_PATH_PLACEHOLDER,
          opts.from,
          opts.to
        ));
        const discovered = await discoverOutputIndexLanguages(
          patternPath,
          LANGUAGE_PATH_PLACEHOLDER
        );
        for (const existingIndex of discovered) {
          const alreadyAvailable = outputIndexLanguageTargets.some((target) =>
            target.groupId === groupId &&
            target.path.toLowerCase() === existingIndex.path.toLowerCase()
          );
          if (!alreadyAvailable) {
            outputIndexLanguageTargets.push({
              ...existingIndex,
              groupId,
              format: outputIndex.format,
              templatePath: outputIndex.template,
            });
          }
        }
      }

      // Save to file
      for (const target of outputTargets) {
        const outputPath = target.path;
        await mkdir(dirname(resolve(outputPath)), { recursive: true });
        const content = target.format === "html" && target.html
          ? target.html
          : target.markdown;
        const saved = await saveReleaseNotes(
          resolve(outputPath),
          content,
          target.markdown,
          target.ownedByRelease === true
        );
        if (saved === "skipped") {
          console.log(chalk.yellow("ℹ️  Release " + fromVersion + " → " + toVersion + " is already in " + outputPath));
        } else if (saved === "replaced") {
          console.log(chalk.green("💾 Replaced " + outputPath));
        } else {
          console.log(chalk.green("💾 Saved to " + outputPath));
        }
      }

      if (outputIndexTargets.length > 0 && outputTargets.length > 0) {
        for (const index of outputIndexTargets) {
          await mkdir(dirname(index.path), { recursive: true });
          const releasePaths = getReleasePathsForIndex(index, outputTargets);
          const languageLinks = getOutputIndexLanguageLinks(index, outputIndexLanguageTargets);
          const outputIndexContent = await createOrUpdateOutputIndex({
            outputPath: index.path,
            format: index.format,
            templatePath: index.templatePath,
            entryTemplatePath: index.entryTemplatePath,
            translateTemplate: !opts.dryRun && shouldTranslateTemplate(index.templateLanguage, index.language)
              ? async (template) => {
                  const translated = await translateOutputIndexTemplate(
                    template,
                    index.language!,
                    generatedResult.metadata.provider as ProviderName,
                    loadedConfig.providers[generatedResult.metadata.provider] as ProviderConfig
                  );
                  addTemplateUsage(generatedResult.metadata.usage, translated.usage);
                  return translated.text;
              }
              : undefined,
            projectName: loadedConfig.projectName,
            environment: opts.env,
            language: index.language,
            fromVersion,
            toVersion,
            date: generatedResult.metadata.date,
            releasePaths,
            languageLinks,
          });
          await writeFile(index.path, outputIndexContent, "utf-8");
          console.log(chalk.green("📚 Updated output index " + index.path));
        }

        const currentIndexPaths = new Set(
          outputIndexTargets.map((target) => target.path.toLowerCase())
        );
        for (const existingIndex of outputIndexLanguageTargets) {
          if (currentIndexPaths.has(existingIndex.path.toLowerCase())) continue;

          const existing = await readFile(existingIndex.path, "utf-8");
          const languageLinks = getOutputIndexLanguageLinks(
            existingIndex,
            outputIndexLanguageTargets
          );
          const languageSwitcher = renderOutputIndexLanguageSwitcher(
            existingIndex.format,
            languageLinks
          );
          const hasLanguageSwitcher = hasOutputIndexLanguageSwitcher(existing);
          let updated = applyOutputIndexLanguageSwitcher(existing, languageSwitcher);
          if (
            !hasLanguageSwitcher &&
            !existingIndex.templatePath &&
            languageLinks.length > 1 &&
            existing.includes(RELEASES_MARKER)
          ) {
            updated = existing.replace(
              RELEASES_MARKER,
              `${languageSwitcher}\n\n${RELEASES_MARKER}`
            );
          }
          if (updated !== existing) {
            await writeFile(existingIndex.path, updated, "utf-8");
            console.log(chalk.green("🌐 Refreshed languages in " + existingIndex.path));
          }
        }
      }

      // Clipboard
      if (opts.clipboard) {
        await clipboardy.write(generatedResult.markdown);
        printStatus(opts.stdout, chalk.blue("📋 Copied to clipboard"));
      }

      // Metadata
      printGenerationSummary(opts.stdout, generatedResult);
      summaryPrinted = true;

    } catch (err: any) {
      const partialResult = result || (err instanceof GenerationError ? { metadata: err.metadata } : undefined);
      if (partialResult && !summaryPrinted) {
        printGenerationSummary(opts.stdout, partialResult);
      }
      const providerOverride = config
        ? (opts.with ? resolveProviderAlias(opts.with) : config.provider as ProviderName)
        : undefined;
      console.error(chalk.red("\n❌ Error:"), formatGenerationError(err, partialResult, config, providerOverride));
      process.exit(1);
    }
  });

// ── providers ──
program
  .command("providers")
  .description("List supported LLM providers")
  .action(() => {
    console.log(chalk.cyan("Supported providers:\n"));
    const providers = [
      { alias: "claude",   name: "anthropic",   desc: "Claude 3.5 Sonnet, Claude 3 Opus" },
      { alias: "gpt4",     name: "openai",      desc: "GPT-4o, GPT-4o-mini" },
      { alias: "mistral",  name: "mistral",     desc: "Mistral Large, Mistral Medium" },
      { alias: "gemini",   name: "google",      desc: "Gemini 1.5 Pro, Gemini 1.5 Flash" },
      { alias: "ollama",   name: "ollama",      desc: "Local models (Llama, Mistral, etc.)" },
      { alias: "azure",    name: "azure-openai", desc: "Azure OpenAI Service" },
    ];
    providers.forEach((p) => {
      console.log(`  ${chalk.green("●")} ${chalk.bold(p.alias.padEnd(10))} → ${p.name.padEnd(14)} ${chalk.gray(p.desc)}`);
    });
    console.log(chalk.gray("\nUse --with <alias> to override the default provider."));
  });

program.parse();

function getOutputPath(
  saveTo: string,
  environment: string,
  language?: string,
  fromVersion?: string,
  toVersion?: string
): string {
  const normalizedEnvironment = environment.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const normalizedLanguage = language?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return saveTo
    .replaceAll("{env}", normalizedEnvironment)
    .replaceAll("{lang}", normalizedLanguage || "{lang}")
    .replaceAll("{from}", fromVersion || FIRST_RELEASE)
    .replaceAll("{to}", toVersion || "end");
}

/**
 * Whether a `saveTo` pattern resolves to a different file for every release.
 *
 * With a version placeholder each release gets its own file and owns it. Without
 * one, every release resolves to the same path, which is how a cumulative
 * changelog is configured, and there the releases stack up instead.
 */
function isReleaseSpecificPath(saveTo: string): boolean {
  return saveTo.includes("{from}") || saveTo.includes("{to}");
}

function getReleasePathsForIndex(index: OutputIndexTarget, outputTargets: OutputTarget[]): string[] {
  const languageTargets = outputTargets.filter(
    (target) => !index.language || !target.language || target.language === index.language
  );
  const preferredFormat = index.format;
  const preferredTargets = languageTargets.filter(
    (target) => getOutputFormat(target) === preferredFormat
  );
  const selectedTargets = preferredTargets.length > 0
    ? preferredTargets
    : languageTargets.filter((target) => getOutputFormat(target) !== preferredFormat);

  return [...new Set(selectedTargets.map((target) => resolve(target.path)))];
}

function getOutputFormat(target: OutputTarget): "markdown" | "html" {
  return target.format === "html" ? "html" : "markdown";
}

function getOutputIndexLanguageLinks(
  index: Pick<OutputIndexLanguageTarget, "path" | "groupId">,
  targets: OutputIndexLanguageTarget[]
): OutputIndexLanguageLink[] {
  return targets
    .filter((candidate) => candidate.groupId === index.groupId)
    .map((candidate) => ({
      language: candidate.language,
      href: toRelativeLink(index.path, candidate.path),
      active: candidate.path.toLowerCase() === index.path.toLowerCase(),
    }));
}

async function createOrUpdateOutputIndex(params: {
  outputPath: string;
  format: "markdown" | "html";
  templatePath?: string;
  entryTemplatePath?: string;
  translateTemplate?: (template: string) => Promise<string>;
  projectName?: string;
  environment: string;
  language?: string;
  fromVersion: string;
  toVersion: string;
  date: string;
  releasePaths: string[];
  languageLinks: OutputIndexLanguageLink[];
}): Promise<string> {
  const languageSwitcher = renderOutputIndexLanguageSwitcher(params.format, params.languageLinks);
  const record: OutputIndexReleaseRecord = {
    environment: params.environment,
    fromVersion: params.fromVersion,
    toVersion: params.toVersion,
    date: params.date,
    href: toRelativeLink(params.outputPath, params.releasePaths[0]),
  };
  const renderReleases = (
    records: OutputIndexReleaseRecord[],
    entryTemplate: OutputIndexEntryTemplate
  ) => renderOutputIndexReleases({
    records,
    entryTemplate,
    format: params.format,
    localizeDate: (date) => localizeIndexDate(date, params.language),
  });

  if (existsSync(params.outputPath)) {
    const existing = await readFile(params.outputPath, "utf-8");
    // An index written before the releases were bounded ends its list at the
    // first thing that follows it, so give it that boundary before reading the
    // list back out.
    const normalizedExisting = ensureOutputIndexReleaseBoundary(
      params.format === "html" ? unwrapHtmlDocumentCodeFence(existing) : existing,
      params.format
    );
    // The entry template is read from its file on every run, so an index never
    // has to carry a copy of it: editing the file is what changes the shape.
    const { entryTemplate } = await loadOutputIndexEntryTemplate(params);

    // Every release the index knows is rendered again from its record, so a
    // template or a language that changed reaches the whole history, not just
    // the release being added.
    const region = readOutputIndexReleasesRegion(normalizedExisting);
    const records = upsertOutputIndexReleaseRecord(
      readOutputIndexReleaseRecords(region),
      record
    );
    const legacyEntries = readLegacyOutputIndexEntries(
      region,
      records.map(outputIndexReleaseId)
    );
    const updated = replaceOutputIndexReleases(
      normalizedExisting,
      [renderReleases(records, entryTemplate), ...legacyEntries].filter(Boolean).join("\n")
    );

    const hasLanguageSwitcher = hasOutputIndexLanguageSwitcher(updated);
    const withLanguageSwitcher = applyOutputIndexLanguageSwitcher(updated, languageSwitcher);
    if (!params.templatePath && params.languageLinks.length > 1 && !hasLanguageSwitcher) {
      return updated.replace(RELEASES_MARKER, `${languageSwitcher}\n\n${RELEASES_MARKER}`);
    }
    return withLanguageSwitcher;
  }

  const { template, entryTemplate } = await loadOutputIndexEntryTemplate(params);
  const rendered = renderOutputIndexTemplate(template, {
    projectName: params.projectName || "Project",
    environment: params.environment,
    language: params.language || "",
    date: localizeIndexDate(params.date, params.language),
    releases: renderReleases([record], entryTemplate),
    languages: languageSwitcher,
    version: CLI_VERSION,
  }, params.format);
  if (params.format === "markdown") {
    return rendered.trim() + "\n";
  }

  const isHtmlTemplate = !params.templatePath || /\.html?$/i.test(params.templatePath);
  // An index is assembled here from the template and already-escaped entries,
  // so its own markup is allowed through. A release note is model output and
  // never gets that trust.
  const html = isHtmlTemplate
    ? rendered
    : markdownToHtml(rendered, { trustedHtml: true });
  return html;
}

/**
 * Joins the summary and the entry template on their way to the translator.
 *
 * It exists for the length of one call: it is never written to a template nor
 * to a generated index.
 */
const ENTRY_TEMPLATE_SEPARATOR = "__AI_RELEASE_NOTES_PART__";

/**
 * The summary template to render, and the entry shape to list releases with.
 *
 * The entry shape is not configurable, so it never comes from the summary
 * template. Both are translated in one pass, then split apart again: only the
 * summary is rendered, and the entry shape is stored in the index.
 */
async function loadOutputIndexEntryTemplate(params: {
  templatePath?: string;
  entryTemplatePath?: string;
  format: "markdown" | "html";
  translateTemplate?: (template: string) => Promise<string>;
}): Promise<{ template: string; entryTemplate: OutputIndexEntryTemplate }> {
  const summary = await loadOutputIndexTemplate(params.templatePath, params.format);
  const entryFile = await loadEntryTemplate(params.entryTemplatePath, params.format);
  const joined = `${summary}\n${ENTRY_TEMPLATE_SEPARATOR}\n${entryFile}`;
  const localized = params.translateTemplate
    ? await params.translateTemplate(joined)
    : joined;

  // A translation that lost the separator cannot be split back apart. The
  // summary stays usable; the entry falls back to the file that was sent.
  const separator = localized.lastIndexOf(ENTRY_TEMPLATE_SEPARATOR);
  return {
    template: (separator < 0 ? localized : localized.slice(0, separator)).trimEnd(),
    entryTemplate: separator < 0
      ? entryFile.trim()
      : localized.slice(separator + ENTRY_TEMPLATE_SEPARATOR.length).trim(),
  };
}

async function loadEntryTemplate(
  entryTemplatePath: string | undefined,
  format: "markdown" | "html"
): Promise<string> {
  if (!entryTemplatePath) {
    return loadBundledTemplate("default-release-summary-entry", format);
  }

  const resolvedPath = resolve(entryTemplatePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Output index entry template not found: ${resolvedPath}`);
  }
  return readFile(resolvedPath, "utf-8");
}

async function loadOutputIndexTemplate(
  templatePath: string | undefined,
  format: "markdown" | "html"
): Promise<string> {
  if (!templatePath) {
    return loadBundledTemplate("default-release-summary", format);
  }

  const resolvedTemplatePath = resolve(templatePath);
  if (!existsSync(resolvedTemplatePath)) {
    throw new Error(`Output index template not found: ${resolvedTemplatePath}`);
  }
  return readFile(resolvedTemplatePath, "utf-8");
}

function loadBundledTemplate(name: string, format: "markdown" | "html"): Promise<string> {
  const extension = format === "html" ? "html" : "md";
  return readFile(resolve(__dirname, `../../templates/${name}.${extension}`), "utf-8");
}

function renderOutputIndexTemplate(
  template: string,
  values: {
    projectName: string;
    environment: string;
    language: string;
    date: string;
    releases: string;
    languages: string;
    version: string;
  },
  format: "markdown" | "html" = "markdown"
): string {
  // A project name and an environment reach an HTML index straight from config
  // and the command line, so they are escaped like every other value there.
  const value = (raw: string) => (format === "html" ? escapeHtml(raw) : raw);
  const rendered = template
    .replaceAll("{{projectName}}", value(values.projectName))
    .replaceAll("{{environment}}", value(values.environment))
    .replaceAll("{{language}}", value(values.language))
    .replaceAll("{{date}}", value(values.date))
    .replaceAll("{{releases}}", `${values.releases}\n${RELEASES_END_MARKER}`)
    .replaceAll("{{version}}", value(values.version));
  return applyOutputIndexLanguageSwitcher(rendered, values.languages);
}

function localizeIndexDate(date: string, language?: string): string {
  if (!language) return date;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat(language, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(parsed);
}

function shouldTranslateTemplate(templateLanguage: string, outputLanguage?: string): boolean {
  if (!outputLanguage) return false;
  return languageCode(templateLanguage) !== languageCode(outputLanguage);
}

async function translateOutputIndexTemplate(
  template: string,
  language: string,
  providerName: ProviderName,
  providerConfig: ProviderConfig
) {
  const protectedTemplate = protectTemplateTokens(template);
  const result = await callLLM(
    providerName,
    providerConfig,
    "You translate release-summary templates. Return only the translated template. " +
      "Translate every human-readable sentence into the requested language, but preserve all HTML, CSS, Markdown syntax, URLs, and protected tokens exactly.",
    `Target language: ${language}\n\nTemplate:\n${protectedTemplate.template}`
  );
  const translated = unwrapHtmlDocumentCodeFence(
    restoreTemplateTokens(result.text, protectedTemplate.tokens)
  );
  if (!translated.includes(RELEASES_MARKER) || !translated.includes("{{releases}}")) {
    throw new Error("Translated output-index template did not preserve the required releases marker or {{releases}} token");
  }
  if (template.includes(ENTRY_TEMPLATE_SEPARATOR) && !translated.includes(ENTRY_TEMPLATE_SEPARATOR)) {
    throw new Error("Translated output-index template did not preserve its entry template");
  }
  return { text: translated, usage: result.usage };
}

/** Models occasionally wrap an HTML template in a Markdown code fence. */
function unwrapHtmlDocumentCodeFence(content: string): string {
  const openingFence = /^\s*```html?\s*\r?\n(?=\s*<!doctype html|\s*<html\b)/i;
  if (!openingFence.test(content)) return content;
  return content
    .replace(openingFence, "")
    .replace(/\r?\n```\s*$/, "");
}

function protectTemplateTokens(template: string): { template: string; tokens: Array<[string, string]> } {
  const values = [
    RELEASES_MARKER,
    // The entry template travels with the summary. Its labels are meant to be
    // translated; what separates and names its parts is not.
    ENTRY_TEMPLATE_SEPARATOR,
    "{{projectName}}",
    "{{environment}}",
    "{{language}}",
    "{{languages}}",
    "{{langages}}",
    "{{date}}",
    "{{releases}}",
    "{{version}}",
    "{{fromVersion}}",
    "{{toVersion}}",
    "{{fromToComparison}}",
    "{{links}}",
    "{{href}}",
  ];
  const tokens = values.map((value, index) => [value, `__AI_RELEASE_TEMPLATE_TOKEN_${index}__`] as [string, string]);
  return {
    template: tokens.reduce((result, [value, token]) => result.replaceAll(value, token), template),
    tokens,
  };
}

function restoreTemplateTokens(template: string, tokens: Array<[string, string]>): string {
  return tokens.reduce((result, [value, token]) => result.replaceAll(token, value), template);
}

function addTemplateUsage(
  total: { inputTokens: number; outputTokens: number; totalTokens: number; modelCalls: number },
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.totalTokens += usage.totalTokens;
  total.modelCalls += 1;
}

function languageCode(language: string): string {
  return language.toLowerCase().split(/[-_]/, 1)[0];
}

function ensureOutputIndexReleaseBoundary(
  content: string,
  format: "markdown" | "html"
): string {
  if (!content.includes(RELEASES_MARKER) || content.includes(RELEASES_END_MARKER)) {
    return content;
  }

  const releasesStart = content.indexOf(RELEASES_MARKER) + RELEASES_MARKER.length;
  const boundary = [
    format === "html"
      ? content.indexOf("</main>", releasesStart)
      : content.indexOf("\n---\n", releasesStart),
  ].filter((index) => index >= 0)[0];

  if (boundary === undefined) {
    return `${content.trimEnd()}\n${RELEASES_END_MARKER}\n`;
  }
  return `${content.slice(0, boundary).trimEnd()}\n${RELEASES_END_MARKER}\n${content.slice(boundary).replace(/^\n/, "")}`;
}

function toRelativeLink(fromPath: string, toPath: string): string {
  return relative(dirname(fromPath), toPath)
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment === "." || segment === ".." ? segment : encodeURIComponent(segment))
    .join("/");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

async function saveReleaseNotes(
  outputPath: string,
  content: string,
  markdown: string,
  ownedByRelease: boolean
): Promise<"saved" | "replaced" | "skipped"> {
  // A file that belongs to a single release always holds that release as it
  // was last generated: regenerating rewrites it, so re-running the same
  // command twice can never leave two copies behind.
  if (ownedByRelease) {
    const replaced = existsSync(outputPath);
    await writeFile(outputPath, outputPath.endsWith(".html") ? content : content.trim() + "\n", "utf-8");
    return replaced ? "replaced" : "saved";
  }

  const existing = existsSync(outputPath) ? await readFile(outputPath, "utf-8") : "";
  // Probe the form that was actually written: a Markdown heading line never
  // appears in rendered HTML, so comparing one against the other reports every
  // regeneration as new and appends a second copy of the same release.
  const header = releaseIdentityProbe(outputPath, content, markdown);
  if (header && existing.includes(header)) return "skipped";

  const merged = outputPath.endsWith(".html")
    ? appendHtmlRelease(existing, content)
    : existing.trim()
      ? content.trim() + "\n\n---\n\n" + existing.trim() + "\n"
      : content.trim() + "\n";
  await writeFile(outputPath, merged, "utf-8");
  return "saved";
}

/**
 * The line that identifies a release inside the file being written.
 *
 * For HTML that is the rendered title heading; for Markdown, the first line.
 * Returns an empty string when neither is available, which saves rather than
 * risks discarding a release as a false duplicate.
 */
function releaseIdentityProbe(outputPath: string, content: string, markdown: string): string {
  if (!outputPath.endsWith(".html")) return markdown.split("\n", 1)[0];

  const heading = /<h([12])>[\s\S]*?<\/h\1>/.exec(content);
  if (heading) return heading[0];

  const title = /<title>[\s\S]*?<\/title>/.exec(content);
  return title ? title[0] : "";
}

function appendHtmlRelease(existing: string, content: string): string {
  if (!existing.trim()) return content;

  const newBody = content
    .replace(/^[\s\S]*?<body[^>]*>/i, "")
    .replace(/<\/body>[\s\S]*$/i, "")
    .replace(/^\s*<main[^>]*>/i, "")
    .replace(/<\/main>\s*$/i, "")
    .trim();
  const entry = "<hr>\n<section class=\"release-entry\">\n" + newBody + "\n</section>\n";
  return /<\/main>\s*<\/body>/i.test(existing)
    ? existing.replace(/<\/main>\s*<\/body>/i, entry + "</main>\n</body>")
    : existing.replace(/<\/body>/i, entry + "</body>");
}
