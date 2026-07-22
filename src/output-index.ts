/**
 * Output-index filesystem helpers.
 */

import { readdir } from "fs/promises";
import { existsSync } from "fs";
import type { Dirent } from "fs";
import { basename, dirname, join } from "path";

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
