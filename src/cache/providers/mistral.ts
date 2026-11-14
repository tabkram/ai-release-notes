import { promptCacheKey, withCacheRequestFields } from "./shared.js";
import type { ProviderCacheAdapter } from "./types.js";

export const mistralCache: ProviderCacheAdapter = {
  validate(config) {
    if (config.promptCache?.enabled !== false && config.promptCache?.ttl) {
      throw new Error("Mistral does not expose a configurable prompt cache TTL");
    }
  },
  prepare(context) {
    return {
      system: [{ role: "system", content: context.system }],
      fetch: context.config.promptCache?.enabled === false ? undefined
        : withCacheRequestFields({ prompt_cache_key: promptCacheKey(context) }),
    };
  },
};
