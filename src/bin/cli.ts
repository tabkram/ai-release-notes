#!/usr/bin/env node
/**
 * CLI entry point
 */

import { Command } from "commander";
import chalk from "chalk";
import { generate, GenerationError } from "../generator.js";
import { callLLM } from "../llm.js";
import { RELEASES_MARKER } from "../release.js";
import { createDefaultConfig, loadConfig, resolveProviderAlias } from "../config.js";
import {
  ENTRY_TEMPLATE_SEPARATOR,
  unwrapHtmlDocumentCodeFence,
  updateOutputIndexes,
} from "../output-index.js";
import { formatOutputPath, isReleaseSpecificPath } from "../output-path.js";
import { promote, PromotionError } from "../promote.js";
import { FIRST_RELEASE, getLatestTag } from "../git.js";
import { writeFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve, join, dirname, basename } from "path";
import clipboardy from "clipboardy";
import ora from "ora";
import type {
  GenerateResult,
  OutputIndexConfig,
  PromptSource,
  ProviderConfig,
  ProviderName,
  ReleaseNotesConfig,
} from "../types.js";
import { AI_RELEASE_NOTES_VERSION } from "../version.js";

const CLI_VERSION = AI_RELEASE_NOTES_VERSION;
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
            // A release generated without --to is saved under the name the
            // config asks for, which is not the tag it was detected as.
            const versions = { fromVersion: opts.from || FIRST_RELEASE, toVersion: opts.to || "end" };
            return saveTo.flatMap((path) => {
              const ownedByRelease = isReleaseSpecificPath(path);
              return path.includes("{lang}")
                ? generatedResult.localized.map((release) => ({
                    path: formatOutputPath(path, { ...versions, environment: opts.env, language: release.language }),
                    markdown: release.markdown,
                    html: release.html,
                    format: output.format,
                    language: release.language,
                    ownedByRelease,
                  }))
                : [{
                    path: formatOutputPath(path, { ...versions, environment: opts.env }),
                    markdown: generatedResult.markdown,
                    html: generatedResult.html,
                    format: output.format,
                    ownedByRelease,
                  }];
            });
          });
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

      await updateOutputIndexes({
        outputIndexes: outputIndexConfigs(loadedConfig),
        releases: outputTargets,
        projectName: loadedConfig.projectName,
        environment: opts.env,
        fromVersion,
        toVersion,
        // A release generated without --to is saved under the name the config
        // asks for, which is not the tag it was detected as.
        pathFromVersion: opts.from || FIRST_RELEASE,
        pathToVersion: opts.to || "end",
        date: generatedResult.metadata.date,
        languages: generatedResult.localized.map((release) => release.language),
        // An index template is written in the language the release is generated
        // in, so prompt.languages already answers this.
        primaryLanguage: generatedResult.localized[0]?.language ?? "en",
        translateTemplate: opts.dryRun
          ? undefined
          : async (template, language) => {
              const translated = await translateOutputIndexTemplate(
                template,
                language,
                generatedResult.metadata.provider as ProviderName,
                loadedConfig.providers[generatedResult.metadata.provider] as ProviderConfig
              );
              addTemplateUsage(generatedResult.metadata.usage, translated.usage);
              return translated.text;
            },
        onUpdated: printOutputIndexUpdate,
      });

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

// ── promote ──
program
  .command("promote")
  .alias("levelup")
  .description("Move release notes from one environment to the next, reusing their wording")
  .option("--from-env <environment>", "Environment to promote from: QUA, STAGING... (default: --from-dir's name)")
  .option("--to-env <environment>", "Environment to promote to: PROD, PREPROD... (default: --to-dir's name)")
  .option("--from <version>", "Start of the range (default: where the target environment is)")
  .option("--to <version>", "End of the range (default: the newest release in the source)")
  .option("--from-dir <dir>", "Read the source releases from this folder")
  .option("--to-dir <dir>", "Write the promoted releases to this folder")
  .option("--pattern <pattern>", "File name inside those folders, with {from} and {to}")
  .option("--merge <strategy>", "Several releases into one: sections or concat", "sections")
  .option("--lang <language>", "Promote one language only")
  .option("--release-date <value>", 'Release date: "now", "tag", or an ISO date (default: now)')
  .option("--date <value>", 'Alias for --release-date ("now", "tag", or an ISO date)')
  .option("--config <path>", "Path to config file")
  .option("--dry-run", "Show what would be promoted without writing anything")
  .option("--stdout", "Write the promoted release notes to the terminal without saving files")
  .action(async (opts) => {
    try {
      // A layout that keeps each environment in a folder has already named
      // them, so the folder answers for the environment when nothing else does.
      const fromEnvironment = opts.fromEnv || folderName(opts.fromDir);
      const toEnvironment = opts.toEnv || folderName(opts.toDir);
      if (!fromEnvironment || !toEnvironment) {
        throw new PromotionError(
          "Promoting needs both environments: pass --from-env and --to-env, " +
          "or --from-dir and --to-dir to take their names from the folders."
        );
      }

      const result = await promote({
        fromEnvironment,
        toEnvironment,
        fromVersion: opts.from,
        toVersion: opts.to,
        fromDir: opts.fromDir,
        toDir: opts.toDir,
        pattern: opts.pattern,
        merge: opts.merge === "concat" ? "concat" : "sections",
        language: opts.lang,
        releaseDate: opts.releaseDate || opts.date,
        configPath: opts.config,
      });

      const { fromVersion, toVersion } = result.metadata;
      if (result.plan.segments.length === 0) {
        console.log(chalk.yellow(
          `✅ ${toEnvironment} is already at ${toVersion}. Nothing to promote from ${fromEnvironment}.`
        ));
        return;
      }

      printStatus(opts.stdout, chalk.blue(
        `🚀 Promoting ${fromEnvironment} → ${toEnvironment}: ${fromVersion} → ${toVersion}`
      ));
      for (const segment of result.plan.segments) {
        printStatus(opts.stdout, chalk.gray(`   ${segment.fromVersion} → ${segment.toVersion}`));
      }
      for (const skipped of result.metadata.skipped) {
        printStatus(opts.stdout, chalk.gray(
          `   Skipped ${skipped}: it holds every release, not one per file.`
        ));
      }

      if (opts.stdout) {
        console.log(result.files.map((file) => file.content).join("\n\n"));
      }

      if (opts.dryRun || opts.stdout) {
        for (const file of result.files) {
          printStatus(opts.stdout, chalk.gray(`   ${file.path} ← ${file.sources.join(", ")}`));
        }
        printStatus(opts.stdout, chalk.gray("\n🤖 No model was called: the wording is the one already reviewed."));
        return;
      }

      for (const file of result.files) {
        await mkdir(dirname(file.path), { recursive: true });
        const saved = await saveReleaseNotes(file.path, file.content, file.content, file.ownedByRelease);
        console.log(chalk.green(`${saved === "replaced" ? "💾 Replaced" : "💾 Saved to"} ${file.path}`));
      }

      const languages = [...new Set(result.files.flatMap((file) => file.language ? [file.language] : []))];
      await updateOutputIndexes({
        outputIndexes: outputIndexConfigs(result.config),
        releases: result.files,
        projectName: result.config.projectName,
        environment: toEnvironment,
        fromVersion,
        toVersion,
        date: result.metadata.date,
        languages: languages.length > 0 ? languages : (result.config.prompt?.languages ?? ["en"]),
        primaryLanguage: result.config.prompt?.languages?.[0] ?? languages[0] ?? "en",
        // Promoting calls no model, so an index in a language its template is
        // not written in keeps the template's own wording.
        onUpdated: printOutputIndexUpdate,
      });

      console.log(chalk.gray(
        `\n📊 ${result.plan.segments.length} release${result.plan.segments.length === 1 ? "" : "s"} promoted | ` +
        `${result.metadata.date} | no model calls`
      ));
    } catch (err: any) {
      const message = err instanceof PromotionError ? err.message : (err?.message || String(err));
      console.error(chalk.red("\n❌ Error:"), message);
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

/** The name of a folder, used as the environment it holds. */
function folderName(directory?: string): string | undefined {
  return directory ? basename(resolve(directory)) : undefined;
}

function outputIndexConfigs(config: ReleaseNotesConfig): OutputIndexConfig[] {
  if (!config.outputIndex) return [];
  return Array.isArray(config.outputIndex) ? config.outputIndex : [config.outputIndex];
}

function printOutputIndexUpdate(path: string, change: "release" | "languages"): void {
  console.log(chalk.green(change === "languages"
    ? "🌐 Refreshed languages in " + path
    : "📚 Updated output index " + path));
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
