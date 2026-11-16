import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { GenerationStateSchema, atomicWrite, defaultReleaseStatePath, loadReleaseState, readOptional, releaseStateId, saveReleaseState, type GenerationState } from "./release-state.js";
import TurndownService from "turndown";
import { extractReleaseContent } from "./release-document.js";
import { formatOutputPath, isReleaseSpecificPath, normalizeEnvironment } from "./output-path.js";
import { DEFAULT_RELEASE_NOTE_TEMPLATE_PATH, readOutputIndexReleaseRecords, renderReleaseNoteHtml } from "./release.js";
import { resolveReleaseDate } from "./release-date.js";
import { updateOutputIndexes } from "./output-index.js";
import { translateOutputIndexTemplate } from "./output-index-translation.js";
import { resolveCacheConfig } from "./cache/index.js";
import { resolveProviderAlias, resolveProviderConfig } from "./config.js";
import type { GenerateOptions, GenerateResult, GenerationUsage, ProviderName, ReleaseNotesConfig } from "./types.js";
import { addModelUsage } from "./model-usage.js";

export interface ReleaseTarget {
  path: string;
  language: string;
  format: "markdown" | "html";
  template?: string;
  pattern?: string;
}


type Release = GenerateResult["localized"][number];
type ProgressOptions = Pick<GenerateOptions, "environment" | "fromVersion" | "toVersion" | "date" | "regenerate" | "provider">
  & Partial<GenerateOptions>;

export const contentHash = (content: string): string => createHash("sha256").update(content).digest("hex");


/** Final files are authoritative; generation and deployment metadata share one ledger. */
export class ReleaseProgress {
  private readonly staleLanguages = new Set<string>();
  private constructor(
    readonly path: string,
    readonly targets: ReleaseTarget[],
    private readonly config: ReleaseNotesConfig,
    private readonly options: ProgressOptions,
    private readonly state: GenerationState,
    private readonly legacyPaths: string[],
  ) {}

  get date(): string { return this.state.date; }

  static async open(
    config: ReleaseNotesConfig,
    options: ProgressOptions,
    targets: ReleaseTarget[],
    operation: "generate" | "promote" = "generate",
  ): Promise<ReleaseProgress> {
    if (targets.length === 0) throw new Error("No release-specific output files configured.");
    const path = config.stateFile ? resolve(formatOutputPath(config.stateFile, options))
      : defaultReleaseStatePath(targets.map(target => target.path), targets.map(target => target.pattern ?? target.path));
    const ledger = await loadReleaseState(path, options.environment);
    const identity = { environment: options.environment, fromVersion: options.fromVersion, toVersion: options.toVersion };
    const entry = ledger.releases.find(entry => releaseStateId(entry) === releaseStateId(identity));
    let previous = entry?.generation;
    const legacyPaths: string[] = [];
    for (const target of targets) {
      const legacyPath = target.path + ".generation.json", saved = await readOptional(legacyPath);
      if (saved === undefined) continue;
      const legacy = JSON.parse(saved);
      if (releaseStateId(legacy) !== releaseStateId(identity)) throw new Error(`Release identity differs from ${legacyPath}`);
      if (!previous) {
        previous = GenerationStateSchema.parse(legacy);
        const from = dirname(legacyPath), to = dirname(path);
        const remap = (key: string) => relative(to, resolve(from, key));
        previous.files = Object.fromEntries(Object.entries(previous.files).map(([key, value]) => [remap(key), value]));
        previous.pending = previous.pending.map(remap);
      }
      legacyPaths.push(legacyPath);
    }
    const state: GenerationState = previous ?? {
      operation, date: await resolveReleaseDate({ date: options.date ?? entry?.deployment?.date }, options.toVersion), status: "pending",
      files: {}, indexes: {}, pending: [],
    };
    if (options.regenerate) {
      state.operation = operation;
      state.requestHash = undefined;
      if (options.date || !previous) state.date = await resolveReleaseDate(options, options.toVersion);
    }
    if (state.operation !== operation) throw new Error(`Generation operation differs from ${path}; use --regenerate.`);
    if (!options.regenerate && previous && options.date && !["now", "tag"].includes(options.date.toLowerCase())
      && await resolveReleaseDate(options, options.toVersion) !== state.date) {
      throw new Error(`Release date differs from ${path}. Use --regenerate to change it.`);
    }
    const progress = new ReleaseProgress(path, targets, config, options, state, legacyPaths);
    if (options.regenerate) state.pending = [...new Set([...state.pending,
      ...targets.filter(target => !options.language || target.language.toLowerCase() === options.language.toLowerCase())
        .map(target => progress.key(target.path)),
    ])];
    return progress;
  }

  async prepare(requestHash: string): Promise<void> {
    if (this.state.requestHash && this.state.requestHash !== requestHash) {
      throw new Error("Generation inputs changed. Use --regenerate to replace existing notes; --no-cache only bypasses API response caching.");
    }
    this.state.requestHash = requestHash;
    this.state.status = "pending";
    await this.flush();
  }

  private key(path: string): string { return relative(dirname(this.path), path); }

  async read(language: string, primary?: string, allowRegenerate = false): Promise<Release | undefined> {
    if (this.options.regenerate && !allowRegenerate) return undefined;
    for (const target of this.targets.filter(target => target.language === language)) {
      if (this.state.pending.includes(this.key(target.path))) return undefined;
      const content = await readOptional(target.path);
      if (content === undefined) continue;
      if (!content.trim()) throw new Error(`Existing release is empty: ${target.path}. Remove it or use --regenerate.`);
      const record = this.state.files[this.key(target.path)];
      if (primary !== undefined && record?.sourceHash && record.sourceHash !== contentHash(primary)) {
        this.staleLanguages.add(language);
        return undefined;
      }
      if (target.format === "markdown") return { language, markdown: content.trim() };
      const template = target.template ? await readFile(target.template, "utf8") : undefined;
      const body = extractReleaseContent(content, template);
      if (!body?.trim()) throw new Error(`Cannot locate release content in ${target.path}. Use its original template or --regenerate.`);
      const converter = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", hr: "---", codeBlockStyle: "fenced" });
      return { language, markdown: converter.turndown(body), html: content };
    }
    return undefined;
  }

  async save(release: Release, primary?: string): Promise<Release> {
    for (const target of this.targets.filter(target => target.language === release.language)) {
      const existing = await readOptional(target.path);
      let content = existing;
      if (existing === undefined || this.options.regenerate || this.staleLanguages.has(release.language) || this.state.pending.includes(this.key(target.path))) {
        const template = target.format === "html" ? await readFile(target.template!, "utf8") : undefined;
        content = template ? renderReleaseNoteHtml(template, release.markdown, {
          projectName: this.config.projectName, fromVersion: this.options.fromVersion,
          toVersion: this.options.toVersion, environment: this.options.environment, date: this.date,
        }) : release.markdown.trim() + "\n";
        await atomicWrite(target.path, content);
        this.state.indexes[release.language] = false;
      }
      this.state.pending = this.state.pending.filter(path => path !== this.key(target.path));
      this.state.files[this.key(target.path)] = {
        hash: contentHash(content!), ...(primary === undefined ? {} : { sourceHash: contentHash(primary) }),
      };
    }
    await this.flush();
    // Read HTML back once so the initial translation and a resumed translation use the same source.
    return (await this.read(release.language, primary, true))!;
  }

  async index(language: string, usage: GenerationUsage): Promise<void> {
    const indexes = this.config.outputIndex
      ? (Array.isArray(this.config.outputIndex) ? this.config.outputIndex : [this.config.outputIndex]) : [];
    const completed = await Promise.all(indexes.map(async index => {
      const path = formatOutputPath(index.saveTo, { ...this.options, language });
      const content = await readOptional(path);
      return !!content && readOutputIndexReleaseRecords(content).some(record =>
        record.environment === normalizeEnvironment(this.options.environment)
        && record.fromVersion === this.options.fromVersion && record.toVersion === this.options.toVersion && record.date === this.date);
    }));
    if (!this.options.regenerate && completed.every(Boolean)) {
      this.state.indexes[language] = true;
      await this.flush();
      return;
    }
    const provider = (this.options.provider ? resolveProviderAlias(this.options.provider) : this.config.provider) as ProviderName;
    await updateOutputIndexes({
      outputIndexes: indexes,
      releases: this.targets.filter(target => target.language === language),
      projectName: this.config.projectName, environment: this.options.environment,
      fromVersion: this.options.fromVersion, toVersion: this.options.toVersion, date: this.date,
      languages: [language], primaryLanguage: this.config.prompt?.languages?.[0] ?? "en",
      translateTemplate: this.state.operation === "promote" ? undefined : async (template, language) => {
        const result = await translateOutputIndexTemplate(template, language, provider,
          resolveProviderConfig(this.config.providers[provider], this.options),
          resolveCacheConfig(this.config.cache, this.options));
        addModelUsage(usage, result.usage);
        return result.text;
      },
    });
    this.state.indexes[language] = true;
    await this.flush();
  }

  async savePromoted(target: ReleaseTarget, content: string, sourceHash: string): Promise<void> {
    const existing = await readOptional(target.path);
    if (existing === undefined || this.options.regenerate || this.state.pending.includes(this.key(target.path))) await atomicWrite(target.path, content);
    this.state.pending = this.state.pending.filter(path => path !== this.key(target.path));
    this.state.files[this.key(target.path)] = { hash: contentHash(this.options.regenerate ? content : existing ?? content), sourceHash };
    await this.flush();
  }

  async readPromoted(target: ReleaseTarget, sourceHash: string): Promise<string | undefined> {
    if (this.options.regenerate || this.state.pending.includes(this.key(target.path))) return undefined;
    const record = this.state.files[this.key(target.path)];
    if (record?.sourceHash && record.sourceHash !== sourceHash) {
      throw new Error(`Promotion sources changed for ${target.path}. Review the target or use --regenerate.`);
    }
    const content = await readOptional(target.path);
    if (content !== undefined && !content.trim()) throw new Error(`Existing release is empty: ${target.path}`);
    return content;
  }

  async finish(primary?: string): Promise<void> {
    const exists = await Promise.all(this.targets.map(async target => !!(await readOptional(target.path))?.trim()));
    const source = this.config.prompt?.languages?.[0] ?? "en";
    const translationsCurrent = primary === undefined || this.state.operation !== "generate"
      || this.targets.every(target => target.language === source
        || this.state.files[this.key(target.path)]?.sourceHash === contentHash(primary));
    this.state.status = translationsCurrent && this.state.pending.length === 0 && exists.every(Boolean)
      && this.targets.every(target => !!this.state.files[this.key(target.path)] && this.state.indexes[target.language])
      ? "complete" : "pending";
    await this.flush();
  }

  private async flush(): Promise<void> {
    await saveReleaseState(this.path, { version: 1, releases: [{
      environment: normalizeEnvironment(this.options.environment), fromVersion: this.options.fromVersion,
      toVersion: this.options.toVersion, generation: this.state,
    }] }, this.options.environment);
    for (const path of this.legacyPaths) await rm(path, { force: true });
  }
}

export async function generationTargets(config: ReleaseNotesConfig, options: GenerateOptions): Promise<ReleaseTarget[]> {
  const languages = config.prompt?.languages ?? ["en"];
  const selected = languages;
  const outputs = options.outputPath || options.toDir
    ? [{ format: options.format ?? "markdown", template: options.template,
      saveTo: options.outputPath ?? join(options.toDir!, `RELEASE_NOTES_${options.toVersion.replace(/^v/, "")}.${options.format === "html" ? "html" : "md"}`) }]
    : config.output ? (Array.isArray(config.output) ? config.output : [config.output]) : [];
  const targets: ReleaseTarget[] = [];
  for (const output of outputs) {
    for (const path of output.saveTo ? (Array.isArray(output.saveTo) ? output.saveTo : [output.saveTo]) : []) {
      if (!options.outputPath && !options.toDir && !isReleaseSpecificPath(path)) return [];
      if (selected.length > 1 && !path.includes("{lang}")) return [];
      for (const language of selected) targets.push({
        path: resolve(formatOutputPath(path, { ...options, language })), language, format: output.format,
        pattern: formatOutputPath(path, { environment: options.environment }),
        template: options.template ?? output.template ?? (output.format === "html" ? DEFAULT_RELEASE_NOTE_TEMPLATE_PATH : undefined),
      });
    }
  }
  if (new Set(targets.map(target => target.path)).size !== targets.length) throw new Error("Release output paths overlap.");
  return targets;
}
