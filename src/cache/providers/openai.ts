import { promptCacheKey, systemMessages, withCacheRequestFields } from "./shared.js";
import type { ProviderConfig } from "../../types.js";
import type { ProviderCacheAdapter } from "./types.js";

function modernModel(model: string): boolean {
  const match = /^gpt-(\d+)(?:\.(\d+))?/.exec(model);
  return !!match && (Number(match[1]) >= 6 || (Number(match[1]) === 5 && Number(match[2]) >= 6));
}

function extendedRetention(model: string): boolean {
  return ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.2", "gpt-5.1-codex-max",
    "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1-chat-latest",
    "gpt-5", "gpt-5-codex", "gpt-4.1"].some(name => model === name || model.startsWith(`${name}-20`));
}

function underlyingModel(config: ProviderConfig): string {
  return config.promptCache?.model ?? config.model ?? "";
}

export const openaiCache: ProviderCacheAdapter = {
  validate(config) {
    if (config.promptCache?.enabled === false) return;
    const ttl = config.promptCache?.ttl;
    if (!ttl) return;
    const model = underlyingModel(config);
    const supported = modernModel(model) ? ttl === "30m" || ttl === "12h" : ttl === "24h" && extendedRetention(model);
    if (!supported) {
      throw new Error(`Prompt cache TTL ${ttl} is not supported for OpenAI model ${model}. Recent Responses models accept 30m or 12h; eligible earlier models accept 24h. Azure deployment aliases can set promptCache.model.`);
    }
  },
  prepare(context) {
    const { config, system } = context;
    const messages = [{ role: "system" as const, content: system }];
    const enabled = config.promptCache?.enabled !== false;
    if (modernModel(underlyingModel(config))) {
      return {
        system: enabled ? systemMessages(system).map(message => ({
          ...message, providerOptions: { openai: { promptCacheBreakpoint: { mode: "explicit" } } },
        })) : messages,
        providerOptions: { openai: { promptCacheOptions: { mode: "explicit" } } },
        // The installed SDK validates only 30m; the Responses API also supports 12h.
        fetch: enabled ? withCacheRequestFields({
          prompt_cache_options: { mode: "explicit", ttl: config.promptCache?.ttl ?? "30m" },
          prompt_cache_key: promptCacheKey(context),
        }) : undefined,
      };
    }
    return {
      system: messages,
      providerOptions: enabled ? { openai: {
        promptCacheKey: promptCacheKey(context),
        ...(config.promptCache?.ttl ? { promptCacheRetention: config.promptCache.ttl } : {}),
      } } : undefined,
    };
  },
};
