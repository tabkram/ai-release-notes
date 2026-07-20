#!/usr/bin/env node
/**
 * CLI entry point
 */

import { Command } from "commander";
import chalk from "chalk";
import { generate } from "../generator.js";
import { callLLM } from "../llm.js";
import { markdownToHtml } from "../release.js";
import { createDefaultConfig, loadConfig, resolveProviderAlias } from "../config.js";
import { getLatestTag, getPreviousTag } from "../git.js";
import { writeFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve, join, dirname, relative } from "path";
import clipboardy from "clipboardy";
import ora from "ora";
import type { ProviderConfig, ProviderName } from "../types.js";

const CLI_VERSION = "1.0.0";
const program = new Command();

type OutputTarget = {
  path: string;
  markdown: string;
  html?: string;
  format?: string;
  language?: string;
};

type OutputIndexTarget = {
  path: string;
  language?: string;
  format: "markdown" | "html";
  templatePath?: string;
  templateLanguage: string;
};

function printStatus(stdout: boolean, message: string): void {
  if (stdout) {
    console.error(message);
    return;
  }
  console.log(message);
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
  .option("--from <version>", "Previous version tag (e.g. v1.0.0)")
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
  .option("--stdout", "Write generated release notes to the terminal without saving files")
  .option("--clipboard", "Copy result to clipboard")
  .action(async (opts) => {
    try {
      // Auto-detect tags if not provided
      let fromVersion = opts.from;
      let toVersion = opts.to;

      if (!toVersion) {
        toVersion = await getLatestTag();
        if (!toVersion) {
          console.error(chalk.red("❌ Could not detect current tag. Use --to <version>"));
          process.exit(1);
        }
        printStatus(opts.stdout, chalk.blue(`📌 Detected current tag: ${toVersion}`));
      }

      if (!fromVersion) {
        fromVersion = await getPreviousTag(toVersion);
        if (!fromVersion) {
          console.error(chalk.red("❌ Could not detect previous tag. Use --from <version>"));
          process.exit(1);
        }
        printStatus(opts.stdout, chalk.blue(`📌 Detected previous tag: ${fromVersion}`));
      }

      const spinner = ora("🤖 Generating release notes...").start();

      const result = await generate({
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

      spinner.succeed("✅ Done!");

      if (opts.stdout) {
        console.log(result.markdown);
      }

      // Determine output path
      let outputTargets: OutputTarget[] = !opts.stdout && opts.output
        ? [{ path: opts.output, markdown: result.markdown, html: result.html, format: opts.format }]
        : [];
      if (!opts.stdout && outputTargets.length === 0 && opts.outputDir) {
        const ext = opts.format === "html" ? "html" : "md";
        const filename = `RELEASE_NOTES_${toVersion.replace(/^v/, "")}.${ext}`;
        outputTargets = [{ path: join(resolve(opts.outputDir), filename), markdown: result.markdown, html: result.html, format: opts.format }];
      }

      const config = await loadConfig(opts.config);
      if (!opts.stdout && outputTargets.length === 0) {
        if (config.output) {
          const outputConfigs = Array.isArray(config.output) ? config.output : [config.output];
          outputTargets = outputConfigs.flatMap((output) => {
            if (!output.saveTo) return [];
            const saveTo = Array.isArray(output.saveTo) ? output.saveTo : [output.saveTo];
            return saveTo.flatMap((path) => path.includes("{lang}")
              ? result.localized.map((release) => ({
                  path: getOutputPath(path, opts.env, release.language, opts.from, opts.to),
                  markdown: release.markdown,
                  html: release.html,
                  format: output.format,
                  language: release.language,
                }))
              : [{
                  path: getOutputPath(path, opts.env, undefined, opts.from, opts.to),
                  markdown: result.markdown,
                  html: result.html,
                  format: output.format,
                }]
            );
          });
        }
      }

      const outputIndexConfigs = config.outputIndex
        ? (Array.isArray(config.outputIndex) ? config.outputIndex : [config.outputIndex])
        : [];
      const outputIndexTargets: OutputIndexTarget[] = outputIndexConfigs.flatMap((outputIndex) =>
        outputIndex.saveTo.includes("{lang}")
          ? result.localized.map((release) => ({
              path: resolve(getOutputPath(outputIndex.saveTo, opts.env, release.language, opts.from, opts.to)),
              language: release.language,
              format: outputIndex.format,
              templatePath: outputIndex.template,
              templateLanguage: outputIndex.templateLanguage,
            }))
          : [{
              path: resolve(getOutputPath(outputIndex.saveTo, opts.env, undefined, opts.from, opts.to)),
              format: outputIndex.format,
              templatePath: outputIndex.template,
              templateLanguage: outputIndex.templateLanguage,
            }]
      );
      if (outputIndexTargets.some((index) => outputTargets.some((target) => resolve(target.path) === index.path))) {
        throw new Error("outputIndex.saveTo must be different from every output.saveTo path");
      }

      // Save to file
      for (const target of outputTargets) {
        const outputPath = target.path;
        await mkdir(dirname(resolve(outputPath)), { recursive: true });
        const content = target.format === "html" && target.html
          ? target.html
          : target.markdown;
        const saved = await saveReleaseNotes(resolve(outputPath), content, target.markdown);
        if (saved === "skipped") {
          console.log(chalk.yellow("ℹ️  Release " + fromVersion + " → " + toVersion + " is already in " + outputPath));
        } else {
          console.log(chalk.green("💾 Saved to " + outputPath));
        }
      }

      if (outputIndexTargets.length > 0 && outputTargets.length > 0) {
        for (const index of outputIndexTargets) {
          await mkdir(dirname(index.path), { recursive: true });
          const releasePaths = getReleasePathsForIndex(index, outputTargets);
          const outputIndexContent = await createOrUpdateOutputIndex({
            outputPath: index.path,
            format: index.format,
            templatePath: index.templatePath,
            translateTemplate: !opts.dryRun && shouldTranslateTemplate(index.templateLanguage, index.language)
              ? async (template) => {
                  const translated = await translateOutputIndexTemplate(
                    template,
                    index.language!,
                    result.metadata.provider as ProviderName,
                    config.providers[result.metadata.provider] as ProviderConfig
                  );
                  addTemplateUsage(result.metadata.usage, translated.usage);
                  return translated.text;
                }
              : undefined,
            projectName: config.projectName,
            environment: opts.env,
            language: index.language,
            fromVersion,
            toVersion,
            date: result.metadata.date,
            releasePaths,
          });
          await writeFile(index.path, outputIndexContent, "utf-8");
          console.log(chalk.green("📚 Updated output index " + index.path));
        }
      }

      // Clipboard
      if (opts.clipboard) {
        await clipboardy.write(result.markdown);
        printStatus(opts.stdout, chalk.blue("📋 Copied to clipboard"));
      }

      // Metadata
      const usage = result.metadata.usage;
      printStatus(opts.stdout, chalk.gray(
        `\n📊 ${result.metadata.commitCount} commits | ${result.metadata.provider} | ${result.metadata.date} | ${formatDuration(usage.durationMs)}`
      ));
      if (usage.modelCalls > 0) {
        printStatus(opts.stdout, chalk.gray(
          `🪙 Tokens: ${formatNumber(usage.inputTokens)} input + ${formatNumber(usage.outputTokens)} output = ${formatNumber(usage.totalTokens)} | ${usage.modelCalls} model call${usage.modelCalls === 1 ? "" : "s"}`
        ));
      } else {
        printStatus(opts.stdout, chalk.gray("🪙 Tokens: no model tokens used (dry run)"));
      }
      if (result.metadata.contextFiles && result.metadata.contextFiles.length > 0) {
        printStatus(opts.stdout, chalk.gray(`📎 Context files: ${result.metadata.contextFiles.join(", ")}`));
      }

    } catch (err: any) {
      console.error(chalk.red("\n❌ Error:"), err.message);
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
    .replaceAll("{from}", fromVersion || "start")
    .replaceAll("{to}", toVersion || "end");
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

const RELEASES_MARKER = "<!-- ai-release-notes:releases -->";

type OutputIndexCopy = {
  release: string;
  releaseNotes: string;
  intro: (environment: string) => string;
  changesSince: string;
  readReleaseNotes: string;
  generatedWith: string;
};

async function createOrUpdateOutputIndex(params: {
  outputPath: string;
  format: "markdown" | "html";
  templatePath?: string;
  translateTemplate?: (template: string) => Promise<string>;
  projectName?: string;
  environment: string;
  language?: string;
  fromVersion: string;
  toVersion: string;
  date: string;
  releasePaths: string[];
}): Promise<string> {
  const copy = getOutputIndexCopy(params.language);
  const localizedDate = localizeIndexDate(params.date, params.language);
  const releaseId = [params.environment, params.fromVersion, params.toVersion]
    .map((value) => encodeURIComponent(value))
    .join("_");
  const releaseEntry = buildOutputIndexEntry(params, releaseId, copy, localizedDate);
  const indexTitle = `${params.projectName ? params.projectName + " · " : ""}${copy.releaseNotes}`;
  const intro = copy.intro(params.environment);

  if (existsSync(params.outputPath)) {
    const existing = await readFile(params.outputPath, "utf-8");
    return ensureOutputIndexFooter(
      insertOrUpdateReleaseEntry(
        localizeExistingIndexChrome(existing, params.format, indexTitle, intro),
        releaseEntry,
        releaseId
      ),
      params.format,
      copy
    );
  }

  const template = await loadOutputIndexTemplate(params.templatePath, params.format);
  const localizedTemplate = params.translateTemplate
    ? await params.translateTemplate(template)
    : template;
  const rendered = renderOutputIndexTemplate(localizedTemplate, {
    projectName: params.projectName || "Project",
    environment: params.environment,
    language: params.language || "",
    date: localizedDate,
    releases: releaseEntry,
    version: CLI_VERSION,
  });
  if (params.format === "markdown") {
    return rendered.trim() + "\n";
  }

  const isHtmlTemplate = !params.templatePath || /\.html?$/i.test(params.templatePath);
  const html = isHtmlTemplate
    ? rendered
    : markdownToHtml(rendered, "Release index");
  return html;
}

function buildOutputIndexEntry(
  params: {
    outputPath: string;
    format: "markdown" | "html";
    environment: string;
    fromVersion: string;
    toVersion: string;
    date: string;
    releasePaths: string[];
  },
  releaseId: string,
  copy: OutputIndexCopy,
  localizedDate: string
): string {
  const releasePaths = [...new Set(params.releasePaths)];
  const marker = `<!-- ai-release-notes:release ${releaseId} -->`;
  const title = `${copy.release} ${params.toVersion}`;
  const metadata = `${params.environment} · ${localizedDate} · ${copy.changesSince} ${params.fromVersion}`;

  if (params.format === "html") {
    const links = releasePaths
      .map((path) => {
        const href = escapeHtml(toRelativeLink(params.outputPath, path));
        return `<a href="${href}">${escapeHtml(copy.readReleaseNotes)} <span aria-hidden="true">→</span></a>`;
      })
      .join("\n");
    return `${marker}\n<section class="release-entry">\n<h2>${escapeHtml(title)}</h2>\n<p class="release-meta">${escapeHtml(metadata)}</p>\n<p class="release-link">${links}</p>\n</section>`;
  }

  const links = releasePaths
    .map((path) => `[${copy.readReleaseNotes} →](${toRelativeLink(params.outputPath, path)})`)
    .join("\n");
  return `${marker}\n## ${title}\n\n_${metadata}_\n\n${links}`;
}

async function loadOutputIndexTemplate(
  templatePath: string | undefined,
  format: "markdown" | "html"
): Promise<string> {
  if (!templatePath) {
    const extension = format === "html" ? "html" : "md";
    return readFile(resolve(__dirname, `../../templates/default-release-summary.${extension}`), "utf-8");
  }

  const resolvedTemplatePath = resolve(templatePath);
  if (!existsSync(resolvedTemplatePath)) {
    throw new Error(`Output index template not found: ${resolvedTemplatePath}`);
  }
  return readFile(resolvedTemplatePath, "utf-8");
}

function renderOutputIndexTemplate(
  template: string,
  values: {
    projectName: string;
    environment: string;
    language: string;
    date: string;
    releases: string;
    version: string;
  }
): string {
  return template
    .replaceAll("{{projectName}}", values.projectName)
    .replaceAll("{{environment}}", values.environment)
    .replaceAll("{{language}}", values.language)
    .replaceAll("{{date}}", values.date)
    .replaceAll("{{releases}}", values.releases)
    .replaceAll("{{version}}", values.version);
}

function buildOutputIndexFooter(format: "markdown" | "html", copy: OutputIndexCopy): string {
  const attribution = `ai-release-notes v${CLI_VERSION}`;
  if (format === "html") {
    return `<footer>${copy.generatedWith} ${attribution}</footer>`;
  }
  return `---\n_${copy.generatedWith} ${attribution}._`;
}

function ensureOutputIndexFooter(
  content: string,
  format: "markdown" | "html",
  copy: OutputIndexCopy
): string {
  const footer = buildOutputIndexFooter(format, copy);
  if (format === "markdown") {
    const generatedFooter = /\n---\n_(?:Generated by|Generated with|Generado con) [\s\S]*?\._\s*$/;
    if (generatedFooter.test(content)) {
      return content.replace(generatedFooter, "\n" + footer + "\n");
    }
    return content.trimEnd() + "\n\n" + footer + "\n";
  }
  const generatedFooter = /<footer>(?:Generated (?:by|with)|Generado con)[\s\S]*?<\/footer>/i;
  if (generatedFooter.test(content)) {
    return content.replace(generatedFooter, footer);
  }
  if (/<\/main>\s*<\/body>/i.test(content)) {
    return content.replace(/<\/main>\s*<\/body>/i, footer + "\n</main>\n</body>");
  }
  return content.replace(/<\/body>/i, footer + "\n</body>");
}

function localizeExistingIndexChrome(
  content: string,
  format: "markdown" | "html",
  indexTitle: string,
  intro: string
): string {
  if (format === "markdown") {
    return content
      .replace(/^# .*?(?:release notes|release index)\s*$/im, `# ${indexTitle}`)
      .replace(
        /^A concise release history for .*?\. The newest release is listed first\.\s*$/im,
        intro
      );
  }

  return content
    .replace(/<title>.*?(?:release notes|release index)<\/title>/i, `<title>${escapeHtml(indexTitle)}</title>`)
    .replace(/<h1>.*?(?:release notes|release index)<\/h1>/i, `<h1>${escapeHtml(indexTitle)}</h1>`)
    .replace(
      /<p class="intro">A concise release history for .*?\. The newest release is listed first\.<\/p>/i,
      `<p class="intro">${escapeHtml(intro)}</p>`
    );
}

function getOutputIndexCopy(language?: string): OutputIndexCopy {
  const code = language?.toLowerCase().split(/[-_]/, 1)[0];
  if (code === "es") {
    return {
      release: "Versión",
      releaseNotes: "Notas de la versión",
      intro: (environment) => `Un historial conciso de versiones para ${environment}. Las más recientes aparecen primero.`,
      changesSince: "Cambios desde",
      readReleaseNotes: "Ver notas de la versión",
      generatedWith: "Generado con",
    };
  }
  return {
    release: "Release",
    releaseNotes: "Release notes",
    intro: (environment) => `A concise release history for ${environment}. The newest release is listed first.`,
    changesSince: "Changes since",
    readReleaseNotes: "Read release notes",
    generatedWith: "Generated with",
  };
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
  const translated = restoreTemplateTokens(result.text, protectedTemplate.tokens);
  if (!translated.includes(RELEASES_MARKER) || !translated.includes("{{releases}}")) {
    throw new Error("Translated output-index template did not preserve the required releases marker or {{releases}} token");
  }
  return { text: translated, usage: result.usage };
}

function protectTemplateTokens(template: string): { template: string; tokens: Array<[string, string]> } {
  const values = [RELEASES_MARKER, "{{projectName}}", "{{environment}}", "{{language}}", "{{date}}", "{{releases}}", "{{version}}"];
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

function insertOrUpdateReleaseEntry(existing: string, entry: string, releaseId: string): string {
  const marker = `<!-- ai-release-notes:release ${releaseId} -->`;
  const entryPattern = new RegExp(
    `${escapeRegExp(marker)}[\\s\\S]*?(?=(?:<br>)?\\s*<!-- ai-release-notes:release [^>]+ -->|$)`
  );
  if (entryPattern.test(existing)) {
    return existing.replace(entryPattern, entry);
  }
  if (existing.includes(RELEASES_MARKER)) {
    return existing.replace(RELEASES_MARKER, `${RELEASES_MARKER}\n${entry}`);
  }
  return existing.trimEnd() + "\n\n" + entry + "\n";
}

function toRelativeLink(fromPath: string, toPath: string): string {
  return encodeURI(relative(dirname(fromPath), toPath)).replaceAll("\\", "/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function saveReleaseNotes(outputPath: string, content: string, markdown: string): Promise<"saved" | "skipped"> {
  const header = markdown.split("\n", 1)[0];
  const existing = existsSync(outputPath) ? await readFile(outputPath, "utf-8") : "";
  if (existing.includes(header)) return "skipped";

  const merged = outputPath.endsWith(".html")
    ? appendHtmlRelease(existing, content)
    : existing.trim()
      ? content.trim() + "\n\n---\n\n" + existing.trim() + "\n"
      : content.trim() + "\n";
  await writeFile(outputPath, merged, "utf-8");
  return "saved";
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
