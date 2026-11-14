import { resolve } from "node:path";
import { z } from "zod";

/** Durations are checked as timestamps, so days never overflow a Node timer. */
export function parseCacheTtl(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const milliseconds = match ? Number(match[1]) * units[match[2]] : NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error("Cache TTL must be a positive duration such as 30m, 1h, or 7d");
  }
  return milliseconds;
}

export const CacheConfigSchema = z.object({
  enabled: z.boolean().optional(),
  ttl: z.string().refine(value => {
    try { parseCacheTtl(value); return true; } catch { return false; }
  }, "Expected a positive duration such as 30m, 1h, or 7d").optional(),
});

export type CacheConfig = z.infer<typeof CacheConfigSchema>;

export interface CacheOverrides {
  /** false bypasses both cache reads and writes. */
  cache?: boolean;
  cacheTtl?: string;
}

export interface ModelCacheOptions {
  directory: string;
  ttlMs: number;
}

export function resolveCacheConfig(
  configured: CacheConfig | undefined,
  overrides: CacheOverrides = {},
  directory = resolve(".ai-release-notes/cache")
): ModelCacheOptions | false {
  const ttlMs = parseCacheTtl(overrides.cacheTtl ?? configured?.ttl ?? "7d");
  return (overrides.cache ?? configured?.enabled ?? true) ? { directory, ttlMs } : false;
}

export const PromptCacheConfigSchema = z.object({
  enabled: z.boolean().optional(),
  ttl: z.string().optional(),
  /** Underlying model when Azure's deployment name does not identify it. */
  model: z.string().optional(),
});
