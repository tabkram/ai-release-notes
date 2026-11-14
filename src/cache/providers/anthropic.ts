import { systemMessages } from "./shared.js";
import type { ProviderCacheAdapter } from "./types.js";

export const anthropicCache: ProviderCacheAdapter = {
  validate(config) {
    const ttl = config.promptCache?.ttl;
    if (config.promptCache?.enabled !== false && ttl && ttl !== "5m" && ttl !== "1h") {
      throw new Error("Anthropic prompt cache TTL must be 5m or 1h");
    }
  },
  prepare({ config, system }) {
    if (config.promptCache?.enabled === false) return { system: [{ role: "system", content: system }] };
    return {
      system: systemMessages(system).map(message => ({
        ...message,
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: config.promptCache?.ttl ?? "5m" } } },
      })),
    };
  },
};
