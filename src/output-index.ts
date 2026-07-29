/**
 * The release summary: one page per environment listing every release it has,
 * newest first, each linking to its notes.
 *
 * It is created on the first release and updated on every one after it,
 * whether that release was just written or promoted from another environment.
 */

import { readdir, readFile, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import type { Dirent } from "fs";
import { basename, dirname, join, relative, resolve } from "path";
import {
  applyOutputIndexLanguageSwitcher,
  hasOutputIndexLanguageSwitcher,
  markdownToHtml,
  readOutputIndexReleaseRecords,
  renderOutputIndexLanguageSwitcher,
  renderOutputIndexReleases,
  replaceOutputIndexReleases,
  RELEASES_MARKER,
  RELEASES_END_MARKER,
  type OutputIndexEntryTemplate,
  type OutputIndexLanguageLink,
  type OutputIndexReleaseRecord,
} from "./release.js";
import { formatOutputPath } from "./output-path.js";
import { compareVersions } from "./promote.js";
import { AI_RELEASE_NOTES_VERSION } from "./version.js";
import type { OutputIndexConfig } from "./types.js";

export interface DiscoveredOutputIndexLanguage {
  language: string;
  path: string;
}

/**
 * Discover index files whose path differs at one language placeholder.
 * The placeholder may be a whole folder name or part of a filename.
 */
export async function discoverOutputIndexLanguages(
  patternPath: string,
  placeholder: string
): Promise<DiscoveredOutputIndexLanguage[]> {
  let variablePathSegment = patternPath;
  const trailingSegments: string[] = [];

  while (!basename(variablePathSegment).includes(placeholder)) {
    const parent = dirname(variablePathSegment);
    if (parent === variablePathSegment) return [];
    trailingSegments.unshift(basename(variablePathSegment));
    variablePathSegment = parent;
  }

  const parentDirectory = dirname(variablePathSegment);
  const segmentPattern = basename(variablePathSegment);
  const placeholderIndex = segmentPattern.indexOf(placeholder);
  const prefix = segmentPattern.slice(0, placeholderIndex);
  const suffix = segmentPattern.slice(placeholderIndex + placeholder.length);

  let entries: Dirent[];
  try {
    entries = await readdir(parentDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  return entries
    .flatMap((entry) => {
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) return [];
      const languageEnd = suffix.length > 0
        ? entry.name.length - suffix.length
        : entry.name.length;
      const language = entry.name.slice(prefix.length, languageEnd);
      if (!language || !/^[a-z0-9_]+$/i.test(language)) return [];

      const outputPath = join(parentDirectory, entry.name, ...trailingSegments);
      return existsSync(outputPath) ? [{ language, path: outputPath }] : [];
    })
    .sort((left, right) => left.language.localeCompare(right.language));
}

// ─────────────────────────────────────────
// Updating the indexes of a run
// ─────────────────────────────────────────

/** A release file an index links to. */
export interface OutputIndexRelease {
  path: string;
  format?: string;
  language?: string;
}

export interface UpdateOutputIndexesParams {
  outputIndexes: OutputIndexConfig[];
  /** The release files this run wrote. An index without one is left alone. */
  releases: OutputIndexRelease[];
  projectName?: string;
  environment: string;
  /** The release, as the index lists it. */
  fromVersion: string;
  toVersion: string;
  /**
   * The versions the file names of this run carry, when a release is written
   * to a path that does not name the versions it actually covers.
   */
  pathFromVersion?: string;
  pathToVersion?: string;
  date: string;
  /** The languages this run produced. */
  languages: string[];
  /** The language its templates are written in; the others are translated. */
  primaryLanguage: string;
  /** Left out when a run may not call a model, and templates stay as written. */
  translateTemplate?: (template: string, language: string) => Promise<string>;
  /** Called for every index written: with the release, or with its siblings. */
  onUpdated?: (path: string, change: "release" | "languages") => void;
}

interface OutputIndexTarget {
  path: string;
  groupId: number;
  language?: string;
  format: "markdown" | "html";
  templatePath?: string;
  entryTemplatePath?: string;
  templateLanguage: string;
}

type OutputIndexLanguageTarget = Pick<
  OutputIndexTarget,
  "path" | "groupId" | "format" | "templatePath"
> & { language: string };

/**
 * Add a release to every configured index, creating the ones that do not exist.
 *
 * Only the indexes and the release entry produced by this run are changed.
 * Historical entries keep the wording and formatting already reviewed.
 */
export async function updateOutputIndexes(params: UpdateOutputIndexesParams): Promise<void> {
  if (params.outputIndexes.length === 0 || params.releases.length === 0) return;

  const pathVersions = {
    fromVersion: params.pathFromVersion ?? params.fromVersion,
    toVersion: params.pathToVersion ?? params.toVersion,
  };
  const indexPath = (saveTo: string, language?: string) =>
    resolve(formatOutputPath(saveTo, {
      ...pathVersions,
      environment: params.environment,
      language,
    }));

  const outputIndexTargets: OutputIndexTarget[] = params.outputIndexes.flatMap((outputIndex, groupId) =>
    outputIndex.saveTo.includes("{lang}")
      ? params.languages.map((language) => ({
          path: indexPath(outputIndex.saveTo, language),
          groupId,
          language,
          format: outputIndex.format,
          templatePath: outputIndex.template,
          entryTemplatePath: outputIndex.entryTemplate,
          templateLanguage: params.primaryLanguage,
        }))
      : [{
          path: indexPath(outputIndex.saveTo),
          groupId,
          format: outputIndex.format,
          templatePath: outputIndex.template,
          entryTemplatePath: outputIndex.entryTemplate,
          templateLanguage: params.primaryLanguage,
        }]
  );

  if (outputIndexTargets.some((index) => params.releases.some((release) => resolve(release.path) === index.path))) {
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

  for (const index of outputIndexTargets) {
    await mkdir(dirname(index.path), { recursive: true });
    const outputIndexContent = await createOrUpdateOutputIndex({
      outputPath: index.path,
      format: index.format,
      templatePath: index.templatePath,
      entryTemplatePath: index.entryTemplatePath,
      translateTemplate: params.translateTemplate && shouldTranslateTemplate(index.templateLanguage, index.language)
        ? (template) => params.translateTemplate!(template, index.language!)
        : undefined,
      projectName: params.projectName,
      environment: params.environment,
      language: index.language,
      fromVersion: params.fromVersion,
      toVersion: params.toVersion,
      date: params.date,
      releasePaths: getReleasePathsForIndex(index, params.releases),
      languageLinks: getOutputIndexLanguageLinks(index, outputIndexLanguageTargets),
    });
    await writeFile(index.path, outputIndexContent, "utf-8");
    params.onUpdated?.(index.path, "release");
  }
}

function getReleasePathsForIndex(
  index: Pick<OutputIndexTarget, "language" | "format">,
  releases: OutputIndexRelease[]
): string[] {
  const languageReleases = releases.filter(
    (release) => !index.language || !release.language || release.language === index.language
  );
  const preferred = languageReleases.filter(
    (release) => releaseFormat(release) === index.format
  );
  const selected = preferred.length > 0
    ? preferred
    : languageReleases.filter((release) => releaseFormat(release) !== index.format);

  return [...new Set(selected.map((release) => resolve(release.path)))];
}

function releaseFormat(release: OutputIndexRelease): "markdown" | "html" {
  return release.format === "html" ? "html" : "markdown";
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

export async function createOrUpdateOutputIndex(params: {
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
    assertOutputIndexStructure(normalizedExisting, params.outputPath, params.format);
    // The entry template is read from its file on every run, so an index never
    // has to carry a copy of it: editing the file is what changes the shape.
    const { entryTemplate } = await loadOutputIndexEntryTemplate(params);

    // A generation owns this release only. Historical entries may have been
    // translated or edited by hand, so their blocks stay byte-for-byte intact.
    const updated = upsertOutputIndexReleaseEntry(
      normalizedExisting,
      record,
      renderReleases([record], entryTemplate)
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
    version: AI_RELEASE_NOTES_VERSION,
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

interface IndexedOutputIndexEntry {
  start: number;
  payload: string;
  release?: Pick<OutputIndexReleaseRecord, "environment" | "fromVersion" | "toVersion">;
}

// A serialized record may contain `>`; its serializer escapes `--`, so the
// first comment terminator is the marker's own safe boundary.
const OUTPUT_INDEX_RELEASE_MARKER =
  /<!--\s*ai-release-notes:release\s+([\s\S]*?)\s*-->/g;

/**
 * Add one new release in descending version order, or update that same release
 * in place. No other entry is rendered, moved, translated, or reformatted.
 */
function upsertOutputIndexReleaseEntry(
  content: string,
  record: OutputIndexReleaseRecord,
  renderedEntry: string
): string {
  const markerStart = content.indexOf(RELEASES_MARKER);
  if (markerStart < 0) {
    return replaceOutputIndexReleases(content, renderedEntry);
  }

  const regionStart = markerStart + RELEASES_MARKER.length;
  const markerEnd = content.indexOf(RELEASES_END_MARKER, regionStart);
  const regionEnd = markerEnd < 0 ? content.length : markerEnd;
  const region = content.slice(regionStart, regionEnd);
  const entries = readIndexedOutputIndexEntries(region);
  const existingIndex = entries.findIndex((entry) =>
    outputIndexEntryIdentifies(entry, record)
  );

  if (existingIndex >= 0) {
    const existing = entries[existingIndex];
    const end = entries[existingIndex + 1]?.start ?? region.length;
    const oldEntry = region.slice(existing.start, end);
    const trailingWhitespace = oldEntry.match(/\s*$/)?.[0] ?? "";
    const updatedRegion =
      region.slice(0, existing.start) +
      renderedEntry.trimEnd() +
      trailingWhitespace +
      region.slice(end);
    return content.slice(0, regionStart) + updatedRegion + content.slice(regionEnd);
  }

  // An opaque legacy marker is an ordering barrier. Placing the new managed
  // entry before it avoids moving across history whose version is ambiguous.
  const before = entries.find((entry) =>
    !entry.release || compareVersions(entry.release.toVersion, record.toVersion) < 0
  );
  const updatedRegion = before
    ? insertOutputIndexEntryBefore(region, before.start, renderedEntry, lineEnding(content))
    : appendOutputIndexEntry(region, renderedEntry, lineEnding(content));
  return content.slice(0, regionStart) + updatedRegion + content.slice(regionEnd);
}

function readIndexedOutputIndexEntries(region: string): IndexedOutputIndexEntry[] {
  return [...region.matchAll(OUTPUT_INDEX_RELEASE_MARKER)].map((marker) => ({
    start: marker.index,
    payload: marker[1].trim(),
    release: readOutputIndexReleaseRecords(marker[0])[0] ?? readLegacyOutputIndexRelease(marker[1]),
  }));
}

/**
 * Legacy IDs use `environment_from_to`. Only exactly three decodable parts are
 * safe to order; IDs containing extra underscores remain opaque.
 */
function readLegacyOutputIndexRelease(
  payload: string
): IndexedOutputIndexEntry["release"] {
  const parts = payload.trim().split("_");
  if (parts.length !== 3) return undefined;
  try {
    const [environment, fromVersion, toVersion] = parts.map(decodeURIComponent);
    return { environment, fromVersion, toVersion };
  } catch {
    return undefined;
  }
}

function outputIndexEntryIdentifies(
  entry: IndexedOutputIndexEntry,
  record: OutputIndexReleaseRecord
): boolean {
  if (entry.release) {
    return entry.release.environment.toLowerCase() === record.environment.toLowerCase()
      && entry.release.fromVersion === record.fromVersion
      && entry.release.toVersion === record.toVersion;
  }

  // Even an otherwise ambiguous legacy ID can identify this known range: its
  // exact from/to suffix leaves only the environment to compare.
  const suffix = `_${encodeURIComponent(record.fromVersion)}_${encodeURIComponent(record.toVersion)}`;
  if (!entry.payload.endsWith(suffix)) return false;
  return entry.payload.slice(0, -suffix.length).toLowerCase()
    === encodeURIComponent(record.environment).toLowerCase();
}

function insertOutputIndexEntryBefore(
  region: string,
  offset: number,
  renderedEntry: string,
  eol: string
): string {
  const before = region.slice(0, offset);
  const separator = before.match(/\s*$/)?.[0] ?? "";
  return before +
    (separator ? "" : eol) +
    renderedEntry.trimEnd() +
    (separator || eol) +
    region.slice(offset);
}

function appendOutputIndexEntry(region: string, renderedEntry: string, eol: string): string {
  const trailingWhitespace = region.match(/\s*$/)?.[0] ?? "";
  const end = region.length - trailingWhitespace.length;
  const separator = trailingWhitespace || eol;
  return region.slice(0, end) +
    separator +
    renderedEntry.trimEnd() +
    (trailingWhitespace || eol);
}

function lineEnding(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Joins the summary and the entry template on their way to the translator.
 *
 * It exists for the length of one call: it is never written to a template nor
 * to a generated index.
 */
export const ENTRY_TEMPLATE_SEPARATOR = "__AI_RELEASE_NOTES_PART__";

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
  return readFile(resolve(__dirname, `../templates/${name}.${extension}`), "utf-8");
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

function languageCode(language: string): string {
  return language.toLowerCase().split(/[-_]/, 1)[0];
}

/** Models occasionally wrap an HTML template in a Markdown code fence. */
export function unwrapHtmlDocumentCodeFence(content: string): string {
  const openingFence = /^\s*```html?\s*\r?\n(?=\s*<!doctype html|\s*<html\b)/i;
  if (!openingFence.test(content)) return content;
  return content
    .replace(openingFence, "")
    .replace(/\r?\n```\s*$/, "");
}

/**
 * Give an index whose list runs to the end of the page a boundary to end at.
 *
 * An index written before the list was bounded carries only its opening marker,
 * so everything after it — a footer, a closing rule — reads as part of the list.
 * Closing it is what tells a run, and a revision, where the releases stop.
 */
export function ensureOutputIndexReleaseBoundary(
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

/**
 * Refuse to compound an index whose managed region cannot be identified
 * unambiguously. Appending another region would silently put invalid markup
 * after the document or preserve an unresolved merge conflict.
 */
function assertOutputIndexStructure(
  content: string,
  outputPath: string,
  format: "markdown" | "html"
): void {
  if (/^(?:<{7}|>{7})(?:\s|$)/m.test(content)) {
    throw new Error(
      `Output index contains unresolved Git conflict markers: ${outputPath}`
    );
  }

  const starts = markerPositions(content, RELEASES_MARKER);
  const ends = markerPositions(content, RELEASES_END_MARKER);
  const entries = [...content.matchAll(OUTPUT_INDEX_RELEASE_MARKER)]
    .map((entry) => entry.index);

  if (starts.length === 0 && ends.length === 0 && entries.length === 0) {
    if (format === "html") {
      throw new Error(
        `HTML output index has no managed releases region: ${outputPath}`
      );
    }
    return;
  }

  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
    throw new Error(
      `Output index has malformed release boundaries: ${outputPath}`
    );
  }

  if (entries.some((position) => position < starts[0] || position > ends[0])) {
    throw new Error(
      `Output index has release entries outside its managed region: ${outputPath}`
    );
  }

  if (format === "html") {
    const htmlEnd = content.toLowerCase().lastIndexOf("</html>");
    if (htmlEnd >= 0 && (starts[0] > htmlEnd || ends[0] > htmlEnd)) {
      throw new Error(
        `HTML output index has a managed releases region after </html>: ${outputPath}`
      );
    }
  }
}

function markerPositions(content: string, marker: string): number[] {
  const positions: number[] = [];
  let from = 0;
  while (from < content.length) {
    const position = content.indexOf(marker, from);
    if (position < 0) break;
    positions.push(position);
    from = position + marker.length;
  }
  return positions;
}

export function toRelativeLink(fromPath: string, toPath: string): string {
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
