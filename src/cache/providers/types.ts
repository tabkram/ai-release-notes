import type { generateText } from "ai";
import type { ProviderConfig, ProviderName } from "../../types.js";
import type { ModelCacheOptions } from "../config.js";

export type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;
export type SystemMessage = { role: "system"; content: string; providerOptions?: ProviderOptions };

export interface ProviderCacheContext {
  provider: ProviderName;
  config: ProviderConfig;
  system: string;
  apiKey: string;
  local: ModelCacheOptions | false;
}

export interface ProviderCacheRequest {
  system?: SystemMessage[];
  providerOptions?: ProviderOptions;
  fetch?: typeof fetch;
  cacheWriteTokens?: number;
  /** Recover only cache-specific failures, without changing the original prompt. */
  recover?: (error: unknown) => Promise<ProviderCacheRequest | undefined>;
}

export interface ProviderCacheAdapter {
  validate: (config: ProviderConfig) => void;
  prepare: (context: ProviderCacheContext) => ProviderCacheRequest | Promise<ProviderCacheRequest>;
}
