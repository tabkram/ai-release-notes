import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ProviderConfig, ProviderName } from "../types.js";
import { AI_RELEASE_NOTES_VERSION } from "../version.js";
import type { ModelCacheOptions } from "./config.js";

/** Hash only output-affecting inputs; retry settings and credentials are excluded. */
export function modelCacheKey(provider: ProviderName, config: ProviderConfig, system: string, user: string): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    application: AI_RELEASE_NOTES_VERSION,
    provider,
    model: config.model,
    baseURL: config.baseURL,
    temperature: config.temperature ?? 0.3,
    maxTokens: config.maxTokens ?? 4000,
    system,
    user,
  })).digest("hex");
}

const EntrySchema = z.object({
  version: z.literal(1),
  createdAt: z.number().int().nonnegative(),
  text: z.string().refine(text => text.trim().length > 0),
});

export async function readModelCache(cache: ModelCacheOptions, key: string): Promise<string | undefined> {
  try {
    const entry = EntrySchema.safeParse(JSON.parse(await readFile(join(cache.directory, `${key}.json`), "utf8")));
    if (!entry.success) return undefined;
    const age = Date.now() - entry.data.createdAt;
    return age >= 0 && age < cache.ttlMs ? entry.data.text : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    console.warn(`Could not read model cache: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export async function writeModelCache(cache: ModelCacheOptions, key: string, text: string): Promise<void> {
  const temporary = join(cache.directory, `${key}.${randomUUID()}.tmp`);
  try {
    await mkdir(cache.directory, { recursive: true, mode: 0o700 });
    // Also protect consumers whose repository does not yet ignore this directory.
    await writeFile(join(cache.directory, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    await writeFile(temporary, JSON.stringify({ version: 1, createdAt: Date.now(), text }), { mode: 0o600 });
    await rename(temporary, join(cache.directory, `${key}.json`));
  } catch (error) {
    // Cache persistence must not discard an answer the caller already paid for.
    console.warn(`Could not save model cache: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function clearModelCache(): Promise<void> {
  await rm(resolve(".ai-release-notes/cache"), { recursive: true, force: true });
}

export async function removeModelCache(cache: ModelCacheOptions, key: string): Promise<void> {
  try {
    await rm(join(cache.directory, `${key}.json`), { force: true });
  } catch (error) {
    console.warn(`Could not remove model cache entry: ${error instanceof Error ? error.message : String(error)}`);
  }
}
