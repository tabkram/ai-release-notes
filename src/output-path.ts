/**
 * Where a release file goes, and which releases are already there.
 *
 * An `output.saveTo` is a pattern: `{env}`, `{lang}`, `{from}` and `{to}` name
 * the parts that change from one release to the next. Filling it in says where
 * to write. Reading it back says what has already been written, which is where
 * promoting a release from one environment to the next starts.
 */

import { readdir, stat } from "fs/promises";
import type { Dirent } from "fs";
import { existsSync } from "fs";
import { resolve, sep } from "path";

/** The placeholders a `saveTo` pattern may carry. */
export const OUTPUT_PATH_PLACEHOLDERS = ["env", "lang", "from", "to"] as const;

export type OutputPathPlaceholder = (typeof OUTPUT_PATH_PLACEHOLDERS)[number];

export interface OutputPathValues {
  environment?: string;
  language?: string;
  fromVersion?: string;
  toVersion?: string;
}

/** An environment as it appears in a path: `pre-prod` and `PRE PROD` are one. */
export function normalizeEnvironment(environment: string): string {
  return environment.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/** A language as it appears in a path. */
export function normalizeLanguage(language: string): string {
  return language.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/**
 * Fill a `saveTo` pattern with the values it is given.
 *
 * A value that is not supplied leaves its placeholder standing, so a pattern
 * can be filled in stages: the environment now, the versions once they are
 * known — or never, when what is wanted is a pattern to search with.
 */
export function formatOutputPath(saveTo: string, values: OutputPathValues): string {
  return saveTo
    .replaceAll("{env}", values.environment === undefined
      ? "{env}"
      : normalizeEnvironment(values.environment))
    .replaceAll("{lang}", values.language === undefined
      ? "{lang}"
      : normalizeLanguage(values.language))
    .replaceAll("{from}", values.fromVersion ?? "{from}")
    .replaceAll("{to}", values.toVersion ?? "{to}");
}

/**
 * Whether a `saveTo` pattern resolves to a different file for every release.
 *
 * With a version placeholder each release gets its own file and owns it.
 * Without one, every release resolves to the same path, which is how a
 * cumulative changelog is configured, and there the releases stack up instead.
 */
export function isReleaseSpecificPath(saveTo: string): boolean {
  return saveTo.includes("{from}") || saveTo.includes("{to}");
}

/** A release file found on disk, and what its path says about it. */
export interface DiscoveredRelease {
  path: string;
  environment?: string;
  language?: string;
  /** Absent when the pattern names only the version a release ends at. */
  fromVersion?: string;
  toVersion: string;
  /** Last write time: the only order available when versions cannot be read. */
  modifiedAt: number;
}

/**
 * The releases already written for a `saveTo` pattern.
 *
 * Known values are filled in before the pattern is read back, so what is
 * searched for is only what varies: given an environment, only that
 * environment's releases are found, and a version that happens to look like an
 * environment cannot be mistaken for one.
 *
 * A pattern that names no version matches one shared file rather than one file
 * per release, so there is nothing to discover and nothing is returned.
 */
export async function discoverReleases(
  saveTo: string,
  values: OutputPathValues = {}
): Promise<DiscoveredRelease[]> {
  const pattern = formatOutputPath(saveTo, { ...values, fromVersion: undefined, toVersion: undefined });
  if (!pattern.includes("{to}")) return [];

  const segments = resolve(pattern).split(sep);
  const releases = await walkPatternSegments(segments[0] || sep, segments.slice(1), {});
  return releases.sort(compareDiscoveredReleases);
}

interface CapturedValues {
  env?: string;
  lang?: string;
  from?: string;
  to?: string;
}

async function walkPatternSegments(
  directory: string,
  segments: string[],
  captured: CapturedValues
): Promise<DiscoveredRelease[]> {
  const [segment, ...rest] = segments;
  if (segment === undefined) return [];

  const matcher = compileSegment(segment);
  const isLeaf = rest.length === 0;

  if (!matcher) {
    const path = joinSegment(directory, segment);
    if (!existsSync(path)) return [];
    return isLeaf ? describeRelease(path, captured) : walkPatternSegments(path, rest, captured);
  }

  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  // Only the last segment names a file; every segment before it is a folder.
  const wantsDirectory = !isLeaf;
  const matched = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory() !== wantsDirectory) return [];
    const match = matcher.regex.exec(entry.name);
    if (!match) return [];

    const merged = { ...captured };
    matcher.keys.forEach((key, index) => {
      merged[key] = match[index + 1];
    });

    const path = joinSegment(directory, entry.name);
    return isLeaf
      ? describeRelease(path, merged)
      : walkPatternSegments(path, rest, merged);
  }));

  return matched.flat();
}

async function describeRelease(
  path: string,
  captured: CapturedValues
): Promise<DiscoveredRelease[]> {
  if (!captured.to) return [];

  let modifiedAt = 0;
  try {
    modifiedAt = (await stat(path)).mtimeMs;
  } catch {
    return [];
  }

  return [{
    path,
    environment: captured.env,
    language: captured.lang,
    fromVersion: captured.from,
    toVersion: captured.to,
    modifiedAt,
  }];
}

function joinSegment(directory: string, segment: string): string {
  return directory.endsWith(sep) ? directory + segment : directory + sep + segment;
}

/**
 * What each placeholder may stand for inside one path segment.
 *
 * An environment and a language are normalized on their way into a path, so
 * what they may contain is known. A version is whatever the repository tags
 * are, so it is bounded only by the separators around it: a version carrying
 * the character that separates it from the next one cannot be told apart from
 * two versions, and is the one shape this cannot read back.
 */
const PLACEHOLDER_PATTERNS: Record<OutputPathPlaceholder, string> = {
  env: "[A-Za-z0-9_]+?",
  lang: "[A-Za-z0-9_]+?",
  from: ".+?",
  to: ".+?",
};

const PLACEHOLDER = /\{(env|lang|from|to)\}/g;

interface SegmentMatcher {
  regex: RegExp;
  keys: OutputPathPlaceholder[];
}

/** A matcher for one path segment, or nothing when the segment is literal. */
function compileSegment(segment: string): SegmentMatcher | undefined {
  const keys: OutputPathPlaceholder[] = [];
  let source = "";
  let position = 0;

  PLACEHOLDER.lastIndex = 0;
  for (let match = PLACEHOLDER.exec(segment); match; match = PLACEHOLDER.exec(segment)) {
    const key = match[1] as OutputPathPlaceholder;
    keys.push(key);
    source += escapeRegExp(segment.slice(position, match.index));
    source += `(${PLACEHOLDER_PATTERNS[key]})`;
    position = match.index + match[0].length;
  }

  if (keys.length === 0) return undefined;
  source += escapeRegExp(segment.slice(position));
  return { regex: new RegExp(`^${source}$`), keys };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareDiscoveredReleases(left: DiscoveredRelease, right: DiscoveredRelease): number {
  return (
    (left.language || "").localeCompare(right.language || "") ||
    (left.fromVersion || "").localeCompare(right.fromVersion || "") ||
    left.toVersion.localeCompare(right.toVersion) ||
    left.path.localeCompare(right.path)
  );
}
