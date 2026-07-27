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
} from "./release.js";
import { formatOutputPath } from "./output-path.js";
import { AI_RELEASE_NOTES_VERSION } from "./version.js";
import type { OutputIndexConfig } from "./types.js";

/**
 * A language stands where this placeholder does while the localized indexes of
 * a run are looked for. It never reaches a file.
 */
const LANGUAGE_PATH_PLACEHOLDER = "aireleasenoteslanguageplaceholder";

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
 * An index carries what it knows about each release it lists, so the whole list
 * is rendered again on every run: a template or a language that changed reaches
 * the entire history, not just the release being added.
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
  for (const [groupId, outputIndex] of params.outputIndexes.entries()) {
    if (!outputIndex.saveTo.includes("{lang}")) continue;
    const discovered = await discoverOutputIndexLanguages(
      indexPath(outputIndex.saveTo, LANGUAGE_PATH_PLACEHOLDER),
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

  // An index this run did not write may still gain a sibling language, and its
  // switcher is the only thing that has to change.
  const currentIndexPaths = new Set(outputIndexTargets.map((target) => target.path.toLowerCase()));
  for (const existingIndex of outputIndexLanguageTargets) {
    if (currentIndexPaths.has(existingIndex.path.toLowerCase())) continue;

    const existing = await readFile(existingIndex.path, "utf-8");
    const languageLinks = getOutputIndexLanguageLinks(existingIndex, outputIndexLanguageTargets);
    const languageSwitcher = renderOutputIndexLanguageSwitcher(existingIndex.format, languageLinks);
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
      params.onUpdated?.(existingIndex.path, "languages");
    }
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
