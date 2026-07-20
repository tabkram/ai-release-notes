/**
 * Git changelog extraction
 */

import { simpleGit, type SimpleGit } from "simple-git";
import type { ParsedCommit } from "./types.js";

/**
 * Extract commits between two tags/refs.
 */
export async function getChangelog(
  from: string,
  to: string,
  repoPath?: string
): Promise<string[]> {
  const git: SimpleGit = simpleGit(repoPath || process.cwd());

  const log = await git.log({
    from,
    to,
    format: {
      hash: "%H",
      date: "%ai",
      message: "%s",
      author_name: "%an",
      body: "%b",
    },
    splitter: "|||",
  });

  return log.all.map((entry) => entry.message.trim());
}

/**
 * Parse conventional commits from raw messages.
 */
export function parseCommits(
  messages: string[],
  options?: {
    excludeTypes?: string[];
  }
): ParsedCommit[] {
  const conventionalRegex = /^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/;

  return messages
    .map((msg) => {
      const match = conventionalRegex.exec(msg);
      if (!match) {
        return {
          hash: "",
          type: "other",
          message: msg,
          author: "",
          date: "",
        };
      }
      const [, type, scope, message] = match;
      return {
        hash: "",
        type,
        scope: scope || undefined,
        message,
        author: "",
        date: "",
      };
    })
    .filter((c) => {
      if (!options?.excludeTypes) return true;
      return !options.excludeTypes.includes(c.type);
    });
}

/**
 * Get the latest tag in the repo
 */
export async function getLatestTag(repoPath?: string): Promise<string | null> {
  const git: SimpleGit = simpleGit(repoPath || process.cwd());
  try {
    const tags = await git.tags({ sort: "-creatordate" });
    return tags.latest || null;
  } catch {
    return null;
  }
}

/**
 * Get the tag before the given one
 */
export async function getPreviousTag(
  tag: string,
  repoPath?: string
): Promise<string | null> {
  const git: SimpleGit = simpleGit(repoPath || process.cwd());
  try {
    const tags = await git.tags({ sort: "-creatordate" });
    const idx = tags.all.indexOf(tag);
    if (idx >= 0 && idx < tags.all.length - 1) {
      return tags.all[idx + 1];
    }
    return null;
  } catch {
    return null;
  }
}
