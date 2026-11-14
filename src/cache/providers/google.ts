import { createHash } from "node:crypto";
import { APICallError } from "ai";
import { z } from "zod";
import { parseCacheTtl } from "../config.js";
import { readModelCache, removeModelCache, writeModelCache } from "../local.js";
import type { ProviderCacheAdapter, ProviderCacheContext, ProviderCacheRequest } from "./types.js";

const ResourceSchema = z.object({
  name: z.string().regex(/^cachedContents\/[\w-]+$/),
  expireTime: z.string().refine(value => Number.isFinite(Date.parse(value))),
  usageMetadata: z.object({ totalTokenCount: z.number().nonnegative().optional() }).optional(),
});

/** Gemini's explicit cache is a remote resource, unlike other providers' hints. */
async function createResource({ config, apiKey, system }: ProviderCacheContext, ttlMs: number) {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/cachedContents", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ model: `models/${config.model}`, systemInstruction: { parts: [{ text: system }] }, ttl: `${ttlMs / 1000}s` }),
  });
  if (!response.ok) {
    const details = await response.text();
    if (response.status === 400 && /too (?:small|short)|minimum.*token|token.*minimum/i.test(details)) {
      console.warn("Gemini system prompt is below the minimum explicit cache size; using a normal model request.");
      return undefined;
    }
    throw new Error(`Gemini prompt cache creation failed (HTTP ${response.status}): ${details}`);
  }
  return ResourceSchema.parse(await response.json());
}

export const googleCache: ProviderCacheAdapter = {
  validate(config) {
    const ttl = config.promptCache?.ttl;
    if (config.promptCache?.enabled === false || !ttl) return;
    if (!/^gemini-(?:2\.5|3(?:\.|-))/.test(config.model ?? "")) {
      throw new Error(`Explicit prompt caching is not supported for ${config.model}; use a compatible Gemini 2.5 or 3 model, or omit the provider TTL for implicit caching`);
    }
    if (parseCacheTtl(ttl) % 1000 !== 0) throw new Error("Gemini prompt cache TTL must be a whole number of seconds");
  },
  async prepare(context) {
    const { config, apiKey, system, local } = context;
    const normal: ProviderCacheRequest = { system: [{ role: "system", content: system }] };
    if (config.promptCache?.enabled === false || !config.promptCache?.ttl) return normal;
    const ttlMs = parseCacheTtl(config.promptCache.ttl);
    // Account scope is hashed, never persisted as a credential or sent in the URL.
    const key = createHash("sha256").update(JSON.stringify({ kind: "google-prompt-cache", model: config.model, apiKey, system, ttlMs })).digest("hex");
    let resource: z.infer<typeof ResourceSchema> | undefined;
    let cacheWriteTokens: number | undefined;
    const stored = local ? await readModelCache({ ...local, ttlMs }, key) : undefined;
    if (stored) {
      try {
        const candidate = ResourceSchema.parse(JSON.parse(stored));
        if (Date.parse(candidate.expireTime) > Date.now()) resource = candidate;
      } catch { /* An invalid handle is recreated. */ }
    }
    if (!resource) {
      resource = await createResource(context, ttlMs);
      cacheWriteTokens = resource?.usageMetadata?.totalTokenCount;
      if (resource && local) await writeModelCache(local, key, JSON.stringify(resource));
    }
    if (!resource) return normal;
    return {
      providerOptions: { google: { cachedContent: resource.name } },
      cacheWriteTokens,
      async recover(error) {
        if (!APICallError.isInstance(error) || (error.statusCode !== 400 && error.statusCode !== 404)) return undefined;
        if (local) await removeModelCache(local, key);
        return normal;
      },
    };
  },
};
