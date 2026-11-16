/**
 * Moving a release from one environment to the next.
 *
 * A release note written for QUA has already been read, corrected and agreed
 * on. When that same release reaches PROD, nothing about it has changed, so
 * nothing here asks a model to write it again: the files QUA already holds are
 * found, put in release order, and written out under the target environment.
 * Promoting one release builds no prompt and calls no provider.
 *
 * When one environment is several releases behind, every release in between is
 * taken along and the notes are merged into the one note that covers the whole
 * range. Their sections merge on their own wording, so every line a reviewer
 * agreed on survives word for word. Their openings cannot merge that way —
 * three headings, three dates and three summaries are not one release note —
 * so that, and only that, is what a model is asked for.
 */

import { ReleaseProgress, contentHash, type ReleaseTarget } from "./release-progress.js";
import { addModelUsage } from "./model-usage.js";
import { readFile } from "fs/promises";
import { basename, join, resolve } from "path";
import { loadConfig, resolveProviderAlias, resolveProviderConfig } from "./config.js";
import { FIRST_RELEASE } from "./git.js";
import { loadReleaseNoteTemplate, stripEnclosingCodeFence } from "./generator.js";
import { callLLM, resolveLLMConfig, type LLMCallResult } from "./llm.js";
import { resolveCacheConfig, type CacheOverrides } from "./cache/index.js";
import {
  discoverReleases,
  formatOutputPath,
  isReleaseSpecificPath,
  normalizeLanguage,
  type DiscoveredRelease,
} from "./output-path.js";
import {
  buildPromoteOpeningSystemPrompt,
  buildPromoteOpeningUserPrompt,
  resolveInstructions,
} from "./prompts/builder.js";
import {
  extractReleaseContent,
  isReleaseDocumentReadable,
  joinReleaseDocuments,
  mergeReleaseDocuments,
  splitReleaseOpening,
  type ReleaseFormat,
} from "./release-document.js";
import { renderReleaseNotePage, sanitizeReleaseHtml } from "./release.js";
import { resolveReleaseDate } from "./release-date.js";
import type { GenerationUsage, ProviderName, ProviderOverrides, ReleaseNotesConfig } from "./types.js";

export class PromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionError";
  }
}

// ─────────────────────────────────────────
// Planning
// ─────────────────────────────────────────

/** One already written release, on its way to the target environment. */
export interface PromotionSegment {
  fromVersion: string;
  toVersion: string;
  releases: DiscoveredRelease[];
}

/** The releases that take the target environment from one version to another. */
export interface PromotionPlan {
  fromVersion: string;
  toVersion: string;
  /** In release order, oldest first. Empty when there is nothing to promote. */
  segments: PromotionSegment[];
}

/**
 * Work out which releases carry an environment from one version to another.
 *
 * Each release file names the range it covers, so the releases form a chain:
 * the one that ends where the next one starts. The plan is the part of that
 * chain between the two versions asked for — it is read from the files
 * themselves rather than from version numbers, so a project that does not
 * release in ascending order is chained just as well.
 */
export function planPromotion(params: {
  /** Every release the source environment holds. */
  available: DiscoveredRelease[];
  fromVersion?: string;
  toVersion?: string;
  /** The version the target environment is already at, when nothing is asked. */
  promotedVersion?: string;
}): PromotionPlan {
  const releases = withInferredRanges(params.available);
  if (releases.length === 0) {
    throw new PromotionError("No release files found for the source environment.");
  }

  const segments = groupSegments(releases);
  const toVersion = params.toVersion || latestVersion(segments);
  const fromVersion = params.fromVersion
    || (params.promotedVersion && knowsVersion(segments, params.promotedVersion)
      ? params.promotedVersion
      : chainStart(segments, toVersion));

  if (fromVersion === toVersion) {
    return { fromVersion, toVersion, segments: [] };
  }

  return { fromVersion, toVersion, segments: chainSegments(segments, fromVersion, toVersion) };
}

/**
 * A release whose file names only the version it ends at.
 *
 * Such a file says where a release arrived but not where it started, so the
 * releases are put in version order and each one is taken to start where the
 * one before it ended.
 */
function withInferredRanges(releases: DiscoveredRelease[]): DiscoveredRelease[] {
  if (releases.every((release) => release.fromVersion)) return releases;

  const ordered = [...releases].sort(
    (left, right) => compareVersions(left.toVersion, right.toVersion) || left.modifiedAt - right.modifiedAt
  );
  const previous = new Map<string, string>();
  let last = FIRST_RELEASE;
  for (const release of ordered) {
    if (release.toVersion === last) continue;
    previous.set(release.toVersion, last);
    last = release.toVersion;
  }

  return releases.map((release) => release.fromVersion
    ? release
    : { ...release, fromVersion: previous.get(release.toVersion) || FIRST_RELEASE });
}

function groupSegments(releases: DiscoveredRelease[]): PromotionSegment[] {
  const segments = new Map<string, PromotionSegment>();
  for (const release of releases) {
    const fromVersion = release.fromVersion || FIRST_RELEASE;
    const id = `${fromVersion}\0${release.toVersion}`;
    const segment = segments.get(id) || { fromVersion, toVersion: release.toVersion, releases: [] };
    segment.releases.push(release);
    segments.set(id, segment);
  }
  return [...segments.values()].sort(
    (left, right) =>
      left.fromVersion.localeCompare(right.fromVersion) ||
      left.toVersion.localeCompare(right.toVersion)
  );
}

/**
 * Where the chain ends: the version no later release starts from.
 *
 * When several branches end nowhere, the most recently written file decides,
 * since nothing in the versions themselves can.
 */
function latestVersion(segments: PromotionSegment[]): string {
  const starts = new Set(segments.map((segment) => segment.fromVersion));
  const heads = segments.filter((segment) => !starts.has(segment.toVersion));
  const candidates = heads.length > 0 ? heads : segments;
  return candidates.reduce((latest, segment) =>
    lastModified(segment) > lastModified(latest) ? segment : latest
  ).toVersion;
}

/** Where a chain ending at `toVersion` begins. */
function chainStart(segments: PromotionSegment[], toVersion: string): string {
  const ends = new Set(segments.map((segment) => segment.toVersion));
  const roots = segments
    .filter((segment) => !ends.has(segment.fromVersion))
    .filter((segment) => chainSegments(segments, segment.fromVersion, toVersion, true).length > 0)
    .map((segment) => segment.fromVersion);

  if (roots.includes(FIRST_RELEASE)) return FIRST_RELEASE;
  return roots[0] || FIRST_RELEASE;
}

function knowsVersion(segments: PromotionSegment[], version: string): boolean {
  return segments.some(
    (segment) => segment.fromVersion === version || segment.toVersion === version
  );
}

/** The newest release an environment already holds, if it holds any. */
export function latestPromotedVersion(releases: DiscoveredRelease[]): string | undefined {
  if (releases.length === 0) return undefined;
  return latestVersion(groupSegments(withInferredRanges(releases)));
}

/**
 * The shortest run of releases from one version to another.
 *
 * Releases are followed from `fromVersion` until `toVersion` is reached, so a
 * range covered by one file promotes that file, and a range covered by four
 * promotes all four in the order they were released.
 */
function chainSegments(
  segments: PromotionSegment[],
  fromVersion: string,
  toVersion: string,
  quiet = false
): PromotionSegment[] {
  const queue: Array<{ version: string; path: PromotionSegment[] }> = [
    { version: fromVersion, path: [] },
  ];
  const visited = new Set([fromVersion]);

  while (queue.length > 0) {
    const { version, path } = queue.shift()!;
    if (version === toVersion) return path;

    for (const segment of segments.filter((candidate) => candidate.fromVersion === version)) {
      if (visited.has(segment.toVersion)) continue;
      visited.add(segment.toVersion);
      queue.push({ version: segment.toVersion, path: [...path, segment] });
    }
  }

  if (quiet) return [];
  throw new PromotionError(
    `No release chain leads from ${fromVersion} to ${toVersion}.\n` +
    `Releases available in the source environment:\n` +
    segments.map((segment) => `  - ${segment.fromVersion} → ${segment.toVersion}`).join("\n") +
    `\nPromote a range these releases cover, or generate the missing one first.`
  );
}

function lastModified(segment: PromotionSegment): number {
  return Math.max(...segment.releases.map((release) => release.modifiedAt));
}

/**
 * Compare two version-like strings, digits as numbers.
 *
 * Only used when the files cannot say what follows what — a layout that names
 * one version per file. `start` comes before everything.
 */
export function compareVersions(left: string, right: string): number {
  if (left === right) return 0;
  if (left === FIRST_RELEASE) return -1;
  if (right === FIRST_RELEASE) return 1;

  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (typeof a === "number" && typeof b === "number") {
      if (a !== b) return a - b;
    } else if (String(a) !== String(b)) {
      return String(a).localeCompare(String(b));
    }
  }
  return 0;
}

function versionParts(version: string): Array<string | number> {
  return (version.match(/\d+|\D+/g) || []).map((part) =>
    /^\d+$/.test(part) ? Number(part) : part.toLowerCase()
  );
}

// ─────────────────────────────────────────
// Promoting
// ─────────────────────────────────────────

export interface PromoteOptions extends ProviderOverrides, CacheOverrides {
  /** The environment whose release notes are reused, for example QUA. */
  fromEnvironment: string;
  /** The environment they are promoted to, for example PROD. */
  toEnvironment: string;
  /** Defaults to where the target environment already is. */
  fromVersion?: string;
  /** Defaults to the newest release the source environment holds. */
  toVersion?: string;
  /** Read the source releases from this folder instead of `output.saveTo`. */
  fromDir?: string;
  /** Write the promoted releases to this folder instead of `output.saveTo`. */
  toDir?: string;
  /** File-name pattern inside those folders, `{from}` and `{to}` included. */
  pattern?: string;
  configPath?: string;
  /** Release date: "now" (default), "tag", or an ISO date such as "2026-07-20". */
  date?: string;
  /** Promote one language only. */
  language?: string;
  /** LLM provider override for the one call that writes the opening. */
  provider?: string;
  /** Persist completed files and resume existing target documents. Used by the CLI. */
  persist?: boolean;
  /** Explicitly replace existing target documents. */
  regenerate?: boolean;
  /** Write the opening with this instead of the configured provider. */
  callModel?: OpeningModelCall;
}

/** Writes the one opening a merged range carries. Supplied to run it yourself. */
export type OpeningModelCall = (request: {
  system: string;
  user: string;
}) => Promise<LLMCallResult>;

/** A release note ready to be written to the target environment. */
export interface PromotedFile {
  path: string;
  content: string;
  format: ReleaseFormat;
  language?: string;
  /** The source files it was built from, in release order. */
  sources: string[];
  ownedByRelease: boolean;
  /** Whether the model wrote the one opening this note carries. */
  openingRewritten?: boolean;
}

export interface PromoteResult {
  files: PromotedFile[];
  plan: PromotionPlan;
  config: ReleaseNotesConfig;
  metadata: {
    fromEnvironment: string;
    toEnvironment: string;
    fromVersion: string;
    toVersion: string;
    date: string;
    /** Configured outputs that name no version, so hold no single release. */
    skipped: string[];
    /** What the one opening cost. Zero calls when nothing needed folding. */
    usage: GenerationUsage;
    /**
     * Why the newest release's opening stands for the range, when the one that
     * covers it could not be written. Absent when nothing was in the way.
     */
    openingSkipped?: string;
    progressFile?: string;
  };
}

/** One configured output, pointed at both environments. */
interface PromotionTarget {
  format: "markdown" | "html";
  template?: string;
  saveTo: string;
  /** Where that output's releases are read from, environment filled in. */
  source: string;
  /** Where the promoted releases are written. */
  destination: string;
}

/**
 * Promote the releases one environment holds to the next one.
 *
 * Nothing is written: the files are returned so a caller can review, print or
 * save them.
 */
export async function promote(options: PromoteOptions): Promise<PromoteResult> {
  const config = await loadConfig(options.configPath);
  const outputs = config.output
    ? (Array.isArray(config.output) ? config.output : [config.output])
    : [];

  const targets: PromotionTarget[] = outputs.flatMap((output) => {
    const saveTo = output.saveTo
      ? (Array.isArray(output.saveTo) ? output.saveTo : [output.saveTo])
      : [];
    return saveTo.map((path) => ({
      format: output.format,
      template: output.template,
      saveTo: path,
      source: environmentPattern(path, options.fromEnvironment, options.fromDir, options.pattern),
      destination: environmentPattern(path, options.toEnvironment, options.toDir, options.pattern),
    }));
  });

  if (targets.length === 0) {
    throw new PromotionError(
      "Promoting reuses the files a generation wrote, so it needs to know where they are. " +
      "Add an output with a saveTo path to your config."
    );
  }

  const promotable = targets.filter((target) => isReleaseSpecificPath(target.saveTo));
  const skipped = targets
    .filter((target) => !isReleaseSpecificPath(target.saveTo))
    .map((target) => target.saveTo);
  if (promotable.length === 0) {
    throw new PromotionError(
      `None of the configured outputs holds a single release: ${skipped.join(", ")}. ` +
      "Add {from} and {to} to a saveTo path so each release has its own file."
    );
  }

  const overlapping = promotable.find((target) => target.source === target.destination);
  if (overlapping) {
    throw new PromotionError(
      `Both environments resolve to the same path: ${overlapping.saveTo}. ` +
      "Add {env} to the saveTo path, or pass --from-dir and --to-dir."
    );
  }

  // Every output promotes the same range, so the range is settled once, from
  // everything both environments hold, before any single output is looked at.
  const sources = await Promise.all(promotable.map((target) => discoverReleases(target.source, {
    environment: options.fromEnvironment,
    language: options.language,
  })));
  const promoted = await Promise.all(promotable.map((target) => discoverReleases(target.destination, {
    environment: options.toEnvironment,
    language: options.language,
  })));

  const available = sources.flat();
  if (available.length === 0) {
    throw new PromotionError(
      `No release files found for ${options.fromEnvironment} at ` +
      `${promotable.map((target) => target.source).join(", ")}.`
    );
  }

  let plan = planPromotion({
    available,
    fromVersion: options.fromVersion,
    toVersion: options.toVersion,
    promotedVersion: latestPromotedVersion(promoted.flat()),
  });

  if (options.persist && plan.segments.length === 0) {
    const previous = promoted.flat().find(release => release.toVersion === plan.toVersion && release.fromVersion);
    if (previous?.fromVersion) plan = planPromotion({ available, fromVersion: previous.fromVersion, toVersion: plan.toVersion });
  }
  const targetLanguages = (target: PromotionTarget, releases: DiscoveredRelease[]) => {
    const found = languagesOf(releases, options.language);
    return !options.language && target.source.includes("{lang}") && config.prompt?.languages
      ? [...new Set([...found, ...config.prompt.languages])] : found;
  };
  const progressTargets: ReleaseTarget[] = promotable.flatMap((target, index) =>
    targetLanguages(target, sources[index]).map(language => ({
      path: resolve(formatOutputPath(target.destination, { language, fromVersion: plan.fromVersion, toVersion: plan.toVersion })),
      language: language ?? config.prompt?.languages?.[0] ?? "en", format: target.format, template: target.template, pattern: target.destination,
    })));
  const progress = options.persist && progressTargets.length > 0 && plan.segments.length > 0
    ? await ReleaseProgress.open(config, { ...options, environment: options.toEnvironment,
      fromVersion: plan.fromVersion, toVersion: plan.toVersion }, progressTargets, "promote") : undefined;
  const date = progress?.date ?? await resolveReleaseDate(options, plan.toVersion);
  await progress?.prepare(contentHash(JSON.stringify({ fromEnvironment: options.fromEnvironment,
    provider: options.provider ?? config.provider, output: config.output, outputIndex: config.outputIndex })));

  const files: PromotedFile[] = [];
  const usage = emptyUsage();

  // One release carries its own opening already, so the model is only reached
  // for when several of them become one note.
  const opening = plan.segments.length > 1
    ? resolveOpeningWriter(config, options)
    : { skipped: undefined, write: undefined };

  if (plan.segments.length > 0) {
    for (const [index, target] of promotable.entries()) {
      for (const language of targetLanguages(target, sources[index])) {
        files.push(await promoteRelease({
          plan,
          language,
          date,
          config,
          options,
          target,
          available: sources[index],
          writeOpening: opening.write,
          usage,
          outcome: opening,
          progress,
        }));
      }
    }
  }

  await progress?.finish();
  return {
    files,
    plan,
    config,
    metadata: {
      fromEnvironment: options.fromEnvironment,
      toEnvironment: options.toEnvironment,
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
      date,
      skipped,
      usage,
      openingSkipped: opening.skipped,
      progressFile: progress?.path,
    },
  };
}

/** Whether the opening covering a range was written, and what stopped it. */
interface OpeningOutcome {
  write?: OpeningModelCall;
  skipped?: string;
}

/**
 * Settle who writes the one opening, before any release is looked at.
 *
 * A provider that is not configured is not an error: promoting is about reusing
 * words that were already reviewed, and it has always worked without a model.
 * The reason is carried back so the run can say what it fell back to.
 */
function resolveOpeningWriter(
  config: ReleaseNotesConfig,
  options: PromoteOptions
): OpeningOutcome {
  if (options.callModel) return { write: options.callModel };

  const provider = (options.provider
    ? resolveProviderAlias(options.provider)
    : config.provider) as ProviderName | undefined;
  const configuredProvider = provider
    ? config.providers?.[provider]
    : undefined;
  if (!provider || !configuredProvider) {
    return { skipped: "no provider is configured, so the newest release's opening stands for the range" };
  }
  const providerConfig = resolveLLMConfig(provider, resolveProviderConfig(configuredProvider, options));
  const cache = resolveCacheConfig(config.cache, options);

  return {
    write: (request) => callLLM(provider, providerConfig, request.system, request.user, cache),
  };
}

interface PromoteReleaseParams {
  progress?: ReleaseProgress;
  plan: PromotionPlan;
  language?: string;
  date: string;
  config: ReleaseNotesConfig;
  options: PromoteOptions;
  target: PromotionTarget;
  /** The releases this one output holds, of every version and language. */
  available: DiscoveredRelease[];
  /** Absent when one release is promoted, or when no model answers for it. */
  writeOpening?: OpeningModelCall;
  /** What every opening written for this run has cost so far. */
  usage: GenerationUsage;
  /** Where a refusal or a failed call is recorded, for the run to report. */
  outcome: OpeningOutcome;
}

async function promoteRelease(params: PromoteReleaseParams): Promise<PromotedFile> {
  const { plan, language, target } = params;
  const paths = new Set(params.available.map((release) => release.path));
  const sources = plan.segments.map((segment) => {
    const release = segment.releases.find(
      (candidate) => paths.has(candidate.path) && sameLanguage(candidate.language, language)
    );
    if (!release) {
      throw new PromotionError(
        `Release ${segment.fromVersion} → ${segment.toVersion} is missing from ` +
        `${target.source}${language ? ` in ${language}` : ""}. ` +
        "Generate it in the source environment first, or promote a shorter range."
      );
    }
    return release;
  });

  const documents = await Promise.all(sources.map((release) => readFile(release.path, "utf-8")));
  const path = resolve(formatOutputPath(target.destination, {
    language,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
  }));

  const progressTarget = { path, language: language ?? "en", format: target.format, template: target.template };
  const sourceHash = contentHash(JSON.stringify(documents));
  const existing = await params.progress?.readPromoted(progressTarget, sourceHash);
  if (existing !== undefined) {
    await params.progress!.savePromoted(progressTarget, existing, sourceHash);
    await params.progress!.index(progressTarget.language, params.usage);
    return { path, content: existing, format: target.format, language,
      sources: sources.map(release => release.path), ownedByRelease: true };
  }

  const note = target.format === "html"
    ? await promoteHtml(documents, params)
    : await mergeNotes(documents, "markdown", params);

  if (params.progress) {
    await params.progress.savePromoted(progressTarget, note.content, sourceHash);
    await params.progress.index(progressTarget.language, params.usage);
  }
  return {
    path,
    content: note.content,
    format: target.format,
    language,
    sources: sources.map((release) => release.path),
    ownedByRelease: true,
    openingRewritten: note.openingRewritten,
  };
}

/**
 * Put a promoted release back on a page.
 *
 * The note is read out of the page it was written into and rendered into the
 * template again, so the promoted page states its own environment, versions and
 * date rather than the ones it was reviewed under. A page this cannot be read
 * out of — a template of yours this has never seen — is promoted as it stands,
 * word for word, which is the whole point of promoting.
 */
async function promoteHtml(
  pages: string[],
  params: PromoteReleaseParams
): Promise<MergedNote> {
  const template = await loadReleaseNoteTemplate(params.target.template);
  const contents = pages.map((page) => extractReleaseContent(page, template));
  if (contents.some((content) => content === undefined)) {
    return {
      content: pages.length === 1
        ? pages[0]
        : joinReleaseDocuments(pages.map((page) => page.trim()), "html"),
    };
  }

  const note = await mergeNotes(contents as string[], "html", params);
  return {
    ...note,
    content: renderReleaseNotePage(template, note.content, {
      fromVersion: params.plan.fromVersion,
      toVersion: params.plan.toVersion,
      environment: params.options.toEnvironment,
      date: params.date,
      projectName: params.config.projectName,
    }),
  };
}

/** A release note built from several, and who wrote the opening it carries. */
interface MergedNote {
  content: string;
  openingRewritten?: boolean;
}

/**
 * Fold several release notes into the one note that covers their range.
 *
 * The sections merge on their own wording, so every line a reviewer agreed on
 * survives word for word. Only the opening cannot be folded that way — three
 * headings, three dates and three summaries do not add up to one — so what the
 * merge leaves standing there is pointed at the promoted range, and the model
 * is asked for the summary that covers all of it.
 *
 * Which of the two it is, is the notes' own answer: folding them is worth doing
 * only on notes this can read back word for word, so a note whose shape it
 * cannot follow sends the whole range down the same path an unreadable page
 * takes, kept whole and put one after another.
 */
async function mergeNotes(
  documents: string[],
  format: ReleaseFormat,
  params: PromoteReleaseParams
): Promise<MergedNote> {
  if (!documents.every((document) => isReleaseDocumentReadable(document, format))) {
    return { content: joinReleaseDocuments(documents, format) };
  }

  const merged = retargetOpening(
    mergeReleaseDocuments(documents, format, { leadWith: "newest" }),
    format,
    params
  );
  if (documents.length < 2 || !params.writeOpening) return { content: merged };

  const opening = await writeOneOpening(documents, format, params);
  if (!opening) return { content: merged };

  const { sections } = splitReleaseOpening(merged, format);
  return {
    content: `${opening}\n\n${sections}`.trim(),
    openingRewritten: true,
  };
}

/**
 * Point the opening of a merged note at the range that was promoted.
 *
 * What a merge leaves at the top is the newest release's opening, so it still
 * names the environment that release was written for and the version it
 * followed. Both of those are known here and every word around them was
 * already reviewed, so only those two values are written over. Nothing below
 * the first section is read, and a note carrying neither value is unchanged.
 */
function retargetOpening(
  content: string,
  format: ReleaseFormat,
  params: PromoteReleaseParams
): string {
  const { opening, sections } = splitReleaseOpening(content, format);
  const previousVersion = params.plan.segments.at(-1)?.fromVersion;

  const retargeted = [
    (text: string) => previousVersion && previousVersion !== params.plan.fromVersion
      ? replaceValue(text, previousVersion, params.plan.fromVersion)
      : text,
    (text: string) => replaceValue(text, params.options.fromEnvironment, params.options.toEnvironment),
  ].reduce((text, rewrite) => rewrite(text), opening);

  return sections ? `${retargeted.trimEnd()}\n\n${sections}` : retargeted;
}

/**
 * Write a value over another, wherever the note states it on its own.
 *
 * A version and an environment are values a note quotes rather than words it
 * uses, so only a whole one is replaced: `v1.2.0` inside `v1.2.0-rc1` is part
 * of another version, and `qua` inside `qualité` is part of another word. How
 * the note writes the old one decides how the new one is written, since a
 * project whose rules ask for a lower-case environment wrote it that way.
 */
function replaceValue(text: string, from: string, to: string): string {
  if (!from || from.toLowerCase() === to.toLowerCase()) return text;

  const pattern = new RegExp(`(?<![\\p{L}\\p{N}._-])${escapeRegExp(from)}(?![\\p{L}\\p{N}._-])`, "giu");
  return text.replace(pattern, (match) => {
    if (match === match.toLowerCase()) return to.toLowerCase();
    if (match === match.toUpperCase()) return to.toUpperCase();
    return to;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Ask the model for the one opening a merged range carries.
 *
 * It is shown the openings and nothing else: the sections it never sees are
 * the reviewed wording this whole command exists to preserve, and cannot be
 * rewritten by an answer that wanders. An answer that comes back carrying
 * sections of its own is refused for the same reason.
 */
async function writeOneOpening(
  documents: string[],
  format: ReleaseFormat,
  params: PromoteReleaseParams
): Promise<string | undefined> {
  const openings = params.plan.segments.map((segment, index) => ({
    fromVersion: segment.fromVersion,
    toVersion: segment.toVersion,
    content: splitReleaseOpening(documents[index], format).opening,
  })).filter((opening) => opening.content.trim());
  if (openings.length < 2) return undefined;

  try {
    const answer = await params.writeOpening!({
      system: await buildPromoteOpeningSystemPrompt(
        await resolveInstructions(params.config.prompt?.instructions)
      ),
      user: buildPromoteOpeningUserPrompt({
        openings,
        format,
        environment: params.options.toEnvironment,
        fromVersion: params.plan.fromVersion,
        toVersion: params.plan.toVersion,
        date: params.date,
        projectName: params.config.projectName,
        language: params.language,
      }),
    });
    addModelUsage(params.usage, answer.usage);

    const written = stripEnclosingCodeFence(answer.text).trim();
    const opening = format === "html" ? sanitizeReleaseHtml(written) : written;
    if (isOpening(opening, format)) return opening;

    params.outcome.skipped ??=
      "the model answered with a release note of its own rather than an opening";
    return undefined;
  } catch (error) {
    // A model that will not answer is no reason to lose a promotion: the
    // opening the merge left standing is a true one, only narrower.
    params.outcome.skipped ??= `the model could not be reached: ${oneLine(error)}`;
    return undefined;
  }
}

/**
 * A provider's complaint, on one line.
 *
 * It is reported inside a sentence of a run's own, and a provider that answers
 * with a paragraph — a missing key and the command to set it — would otherwise
 * break out of it.
 */
function oneLine(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
}

/** Whether an answer is an opening, and not a release note of its own. */
function isOpening(answer: string, format: ReleaseFormat): boolean {
  if (!answer.trim()) return false;
  return splitReleaseOpening(answer, format).sections.trim() === "";
}

function emptyUsage(): GenerationUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0, durationMs: 0 };
}


/**
 * Point a `saveTo` at one environment.
 *
 * A path that names its environment only needs it filled in. A layout that
 * keeps each environment in a folder of its own says so instead, and then the
 * file name is what carries over.
 */
function environmentPattern(
  saveTo: string,
  environment: string,
  directory?: string,
  pattern?: string
): string {
  const path = directory
    ? join(directory, pattern || basename(saveTo))
    : saveTo;
  return formatOutputPath(path, { environment });
}

/** The languages a set of discovered releases covers. */
function languagesOf(releases: DiscoveredRelease[], only?: string): Array<string | undefined> {
  const languages = [...new Set(releases.map((release) => release.language))]
    .filter((language) => !only || !language || language === normalizeLanguage(only));
  return languages.length > 0 ? languages.sort() : [undefined];
}

function sameLanguage(left?: string, right?: string): boolean {
  return (left || "") === (right || "");
}
