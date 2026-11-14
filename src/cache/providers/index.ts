import type { ProviderConfig, ProviderName } from "../../types.js";
import { anthropicCache } from "./anthropic.js";
import { azureCache } from "./azure.js";
import { googleCache } from "./google.js";
import { mistralCache } from "./mistral.js";
import { ollamaCache } from "./ollama.js";
import { openaiCache } from "./openai.js";
import type { ProviderCacheAdapter, ProviderCacheContext } from "./types.js";

const providers: Record<ProviderName, ProviderCacheAdapter> = {
  openai: openaiCache,
  anthropic: anthropicCache,
  mistral: mistralCache,
  google: googleCache,
  "azure-openai": azureCache,
  ollama: ollamaCache,
};

export function validateProviderCache(provider: ProviderName, config: ProviderConfig): void {
  if (!providers[provider]) throw new Error(`Unknown provider: ${provider}`);
  if (config.promptCache?.model && provider !== "azure-openai") {
    throw new Error("promptCache.model is only used to identify the underlying model of an Azure deployment");
  }
  providers[provider].validate(config);
}

export function prepareProviderCache(context: ProviderCacheContext) {
  return providers[context.provider].prepare(context);
}
