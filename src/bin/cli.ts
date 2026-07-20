#!/usr/bin/env node
/**
 * CLI entry point
 */

import { Command } from "commander";
import chalk from "chalk";
import { generate } from "../generator.js";
import { createDefaultConfig, loadConfig, resolveProviderAlias } from "../config.js";
import { getLatestTag, getPreviousTag } from "../git.js";
import { writeFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve, join, dirname } from "path";
import clipboardy from "clipboardy";
import ora from "ora";

const program = new Command();

program
  .name("ai-release-notes")
  .description("🤖 AI-powered release notes generator")
  .version("1.0.0");

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
  .option("--date <date>", "Release date (default: today)")
  .option("--with <provider>", "LLM provider override (claude, gpt4, mistral, gemini, ollama)")
  .option("--config <path>", "Path to config file")
  .option("--output <path>", "Output file path (override config)")
  .option("--output-dir <dir>", "Output directory (default: current dir)")
  .option("--format <format>", "Output format: md or html")
  .option("--template <path>", "Path to custom template file")
  .option("--changelog <path>", "Path to a file containing raw changelog (skip git)")
  .option("--context <paths...>", "Context files or directories (specs, models, etc.)")
  .option("--dry-run", "Show prompts without calling LLM")
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
        console.log(chalk.blue(`📌 Detected current tag: ${toVersion}`));
      }

      if (!fromVersion) {
        fromVersion = await getPreviousTag(toVersion);
        if (!fromVersion) {
          console.error(chalk.red("❌ Could not detect previous tag. Use --from <version>"));
          process.exit(1);
        }
        console.log(chalk.blue(`📌 Detected previous tag: ${fromVersion}`));
      }

      const spinner = ora("🤖 Generating release notes...").start();

      const result = await generate({
        fromVersion,
        toVersion,
        environment: opts.env,
        date: opts.date,
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

      // Output
      console.log("\n" + chalk.cyan("─".repeat(60)));
      console.log(result.markdown);
      console.log(chalk.cyan("─".repeat(60)) + "\n");

      // Determine output path
      let outputTargets = opts.output
        ? [{ path: opts.output, markdown: result.markdown, html: result.html, format: opts.format }]
        : [];
      if (outputTargets.length === 0 && opts.outputDir) {
        const ext = opts.format === "html" ? "html" : "md";
        const filename = `RELEASE_NOTES_${toVersion.replace(/^v/, "")}.${ext}`;
        outputTargets = [{ path: join(resolve(opts.outputDir), filename), markdown: result.markdown, html: result.html, format: opts.format }];
      }

      if (outputTargets.length === 0) {
        const config = await loadConfig(opts.config);
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

      // Clipboard
      if (opts.clipboard) {
        await clipboardy.write(result.markdown);
        console.log(chalk.blue("📋 Copied to clipboard"));
      }

      // Metadata
      console.log(chalk.gray(`\n📊 ${result.metadata.commitCount} commits | ${result.metadata.provider} | ${result.metadata.date}`));
      if (result.metadata.contextFiles && result.metadata.contextFiles.length > 0) {
        console.log(chalk.gray(`📎 Context files: ${result.metadata.contextFiles.join(", ")}`));
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
    .trim();
  return existing.replace(/<\/body>/i, "<hr>\n<section>\n" + newBody + "\n</section>\n</body>");
}
