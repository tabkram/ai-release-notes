/**
 * Context file loader — specs, models, etc.
 * Accepts a mixed array of file paths and directory paths.
 */

import { readFile, readdir } from "fs/promises";
import { existsSync, statSync } from "fs";
import { resolve, join } from "path";
import type { ContextFile } from "./types.js";

/**
 * Load context files from a mixed array of file paths and directory paths.
 * Directories are scanned recursively for files.
 */
export async function loadContextFiles(
  paths?: string[]
): Promise<ContextFile[]> {
  if (!paths || paths.length === 0) return [];

  const files: ContextFile[] = [];
  const seen = new Set<string>();

  for (const p of paths) {
    const absPath = resolve(p);
    if (!existsSync(absPath)) {
      console.warn(`⚠️  Context path not found: ${absPath}`);
      continue;
    }

    const stat = statSync(absPath);
    if (stat.isDirectory()) {
      // Recursively scan directory
      await scanDirectory(absPath, files, seen);
    } else {
      // Load single file
      if (seen.has(absPath)) continue;
      const content = await readFile(absPath, "utf-8");
      files.push({ path: absPath, content });
      seen.add(absPath);
    }
  }

  return files;
}

async function scanDirectory(
  dirPath: string,
  files: ContextFile[],
  seen: Set<string>
): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(absPath, files, seen);
    } else if (entry.isFile()) {
      if (seen.has(absPath)) continue;
      const content = await readFile(absPath, "utf-8");
      files.push({ path: absPath, content });
      seen.add(absPath);
    }
  }
}
