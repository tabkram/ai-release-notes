/**
 * Context file loader — specs, models, etc.
 * Accepts a mixed array of file paths and directory paths.
 *
 * Everything loaded here is sent to a third-party LLM, so the loader is
 * deliberately narrow. A path named on the command line is honoured, with a
 * warning when it looks sensitive; a file merely swept up by a directory scan
 * is skipped instead, because nobody asked for it by name.
 */

import { readFile, readdir } from "fs/promises";
import { existsSync, statSync } from "fs";
import { resolve, join, relative, isAbsolute, basename } from "path";
import type { ContextFile } from "./types.js";

/** Caps that bound both the prompt bill and the blast radius of a wide path. */
export const CONTEXT_LIMITS = {
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxFiles: 200,
  maxDepth: 8,
} as const;

/** Directories that never hold release-note context and often hold secrets. */
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".aws",
  ".ssh",
  ".gnupg",
  "node_modules",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".terraform",
]);

/** Filenames and suffixes that commonly carry credentials. */
const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^\.htpasswd$/i,
  /^credentials?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg)$/i,
  /secrets?\.(ya?ml|json|toml|ini)$/i,
];

/** Shapes of well-known credentials, checked against file content. */
const SECRET_CONTENT_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];

function looksSensitive(path: string): boolean {
  const name = basename(path);
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function containsSecret(content: string): boolean {
  return SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(content));
}

/** A NUL byte in the first block is the usual sign of a non-text file. */
function looksBinary(content: string): boolean {
  return content.slice(0, 8000).includes("\u0000");
}

function isOutsideProject(absPath: string): boolean {
  const rel = relative(process.cwd(), absPath);
  return rel.startsWith("..") || isAbsolute(rel);
}

interface LoadState {
  files: ContextFile[];
  seen: Set<string>;
  totalBytes: number;
  truncated: boolean;
}

/**
 * Load context files from a mixed array of file paths and directory paths.
 * Directories are scanned recursively for files.
 */
export async function loadContextFiles(
  paths?: string[]
): Promise<ContextFile[]> {
  if (!paths || paths.length === 0) return [];

  const state: LoadState = { files: [], seen: new Set(), totalBytes: 0, truncated: false };

  for (const p of paths) {
    const absPath = resolve(p);
    if (!existsSync(absPath)) {
      console.warn(`⚠️  Context path not found: ${absPath}`);
      continue;
    }

    if (isOutsideProject(absPath)) {
      console.warn(
        `⚠️  Context path is outside this project and will be sent to the LLM: ${absPath}`
      );
    }

    const stat = statSync(absPath);
    if (stat.isDirectory()) {
      await scanDirectory(absPath, state, 0);
    } else {
      // Named directly on the command line, so a sensitive-looking file is
      // still loaded — the warning is the safeguard, not a refusal.
      await addFile(absPath, state, { explicit: true });
    }
  }

  if (state.truncated) {
    console.warn(
      `⚠️  Context truncated at ${state.files.length} files / ` +
        `${Math.round(state.totalBytes / 1024)} KB. Narrow --context to include the rest.`
    );
  }

  return state.files;
}

async function addFile(
  absPath: string,
  state: LoadState,
  options: { explicit: boolean }
): Promise<void> {
  if (state.seen.has(absPath)) return;
  if (
    state.files.length >= CONTEXT_LIMITS.maxFiles ||
    state.totalBytes >= CONTEXT_LIMITS.maxTotalBytes
  ) {
    state.truncated = true;
    return;
  }

  const sensitive = looksSensitive(absPath);
  if (sensitive && !options.explicit) {
    console.warn(`⚠️  Skipped possible credential file while scanning: ${absPath}`);
    return;
  }

  if (statSync(absPath).size > CONTEXT_LIMITS.maxFileBytes) {
    console.warn(
      `⚠️  Skipped context file over ${CONTEXT_LIMITS.maxFileBytes / 1024} KB: ${absPath}`
    );
    return;
  }

  const content = await readFile(absPath, "utf-8");
  if (looksBinary(content)) {
    console.warn(`⚠️  Skipped binary context file: ${absPath}`);
    return;
  }

  if (containsSecret(content)) {
    if (!options.explicit) {
      console.warn(`⚠️  Skipped context file that looks like it holds a secret: ${absPath}`);
      return;
    }
    console.warn(`⚠️  ${absPath} looks like it holds a secret and is being sent to the LLM.`);
  }
  if (sensitive) {
    console.warn(`⚠️  ${absPath} looks like a credential file and is being sent to the LLM.`);
  }

  state.files.push({ path: absPath, content });
  state.seen.add(absPath);
  state.totalBytes += Buffer.byteLength(content, "utf-8");
}

async function scanDirectory(
  dirPath: string,
  state: LoadState,
  depth: number
): Promise<void> {
  if (depth > CONTEXT_LIMITS.maxDepth) {
    console.warn(`⚠️  Stopped scanning below ${CONTEXT_LIMITS.maxDepth} levels: ${dirPath}`);
    return;
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await scanDirectory(absPath, state, depth + 1);
    } else if (entry.isFile()) {
      await addFile(absPath, state, { explicit: false });
    }
  }
}
