import type { ProviderCacheAdapter } from "./types.js";

/** The OpenAI-compatible endpoint has no prompt-retention control. */
export const ollamaCache: ProviderCacheAdapter = {
  validate(config) {
    if (config.promptCache?.enabled !== false && config.promptCache?.ttl) {
      throw new Error("Ollama's OpenAI endpoint does not expose a prompt cache TTL; keep_alive controls model loading, not prompt retention");
    }
  },
  prepare({ system }) {
    return { system: [{ role: "system", content: system }] };
  },
};
