/**
 * LLM provider wrapper using Vercel AI SDK
 * API keys are read from environment variables, never from config files.
 * Only the API key for the active provider is required.
 */

import { APICallError, generateText, RetryError } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createMistral } from "@ai-sdk/mistral";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { resolve } from "node:path";
import type { ProviderName, ProviderConfig } from "./types.js";
import {
  modelCacheKey, readModelCache, writeModelCache, shareModelRequest, prepareProviderCache, validateProviderCache,
  type ModelCacheOptions, type ProviderCacheContext, type ProviderCacheRequest,
} from "./cache/index.js";

export interface LLMCallResult {
  text: string;
  finishReason?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheHits?: number;
    coalescedCalls?: number;
    providerCacheReadTokens?: number;
    providerCacheWriteTokens?: number;
  };
}

/**
 * Environment variable names for each provider.
 */
const API_KEY_ENV_VARS: Record<ProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  mistral: "MISTRAL_API_KEY",
  google: "GOOGLE_API_KEY",
  "azure-openai": "AZURE_OPENAI_API_KEY",
  ollama: "OLLAMA_API_KEY",
};

const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
  mistral: "mistral-large-latest",
  google: "gemini-1.5-pro",
  "azure-openai": "gpt-4o",
  ollama: "llama3.1",
};

/** Resolve defaults and reject unsupported cache settings before any work is billed. */
export function resolveLLMConfig(provider: ProviderName, config: ProviderConfig): ProviderConfig {
  const resolved = { ...config, model: config.model || DEFAULT_MODELS[provider] };
  validateProviderCache(provider, resolved);
  return resolved;
}

/**
 * Get API key for a specific provider from environment variables.
 * Only the active provider's key is required.
 */
function getApiKey(providerName: ProviderName, key: string | undefined): string {
  const envVar = API_KEY_ENV_VARS[providerName];

  if (!key && providerName !== "ollama") {
    throw new LLMError(
      `Missing API key for ${providerName}.\n` +
        `Set the environment variable: export ${envVar}=your-key-here`
    );
  }

  return key || "ollama";
}

/** Hostnames that keep a request on the machine running the generator. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"]);

/**
 * Check a configured endpoint before any prompt or key is sent to it.
 *
 * A config file travels with the repository, so a pull request can propose a
 * baseURL. Pointing it at another host sends the whole prompt there, and for
 * azure-openai the API key as well.
 */
export function resolveBaseURL(
  providerName: ProviderName,
  config: ProviderConfig
): string | undefined {
  if (!config.baseURL) return undefined;

  let url: URL;
  try {
    url = new URL(config.baseURL);
  } catch {
    throw new LLMError(`Invalid baseURL for ${providerName}: ${config.baseURL}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LLMError(
      `baseURL for ${providerName} must use http or https, got "${url.protocol}"`
    );
  }

  if (!LOCAL_HOSTS.has(url.hostname)) {
    const alsoKey = providerName === "azure-openai" ? " and the API key" : "";
    console.warn(
      `⚠️  ${providerName} is configured to send prompts${alsoKey} to ${url.origin}. ` +
        `Confirm that this endpoint is one you control.`
    );
  }

  return config.baseURL;
}

/**
 * Call an LLM with the given system/user prompts.
 * Only the selected provider's API key is checked.
 */
export async function callLLM(
  providerName: ProviderName,
  config: ProviderConfig,
  system: string,
  user: string,
  cache: ModelCacheOptions | false = false
): Promise<LLMCallResult> {
  config = resolveLLMConfig(providerName, config);
  const apiKey = process.env[API_KEY_ENV_VARS[providerName]];
  const request = () => requestLLM({
    provider: providerName, config, system, apiKey: getApiKey(providerName, apiKey), local: cache,
  }, user);
  if (!cache) return request();

  const key = modelCacheKey(providerName, config, system, user);
  // Register before disk I/O so even a delayed cache miss joins the same work.
  const { value, shared } = await shareModelRequest({
    responseKey: key,
    directory: resolve(cache.directory),
    ttlMs: cache.ttlMs,
    // These affect execution rather than the persisted answer's fingerprint.
    apiKey,
    maxRetries: config.maxRetries ?? 2,
    initialRetryDelayMs: config.initialRetryDelayMs,
    promptCacheEnabled: config.promptCache?.enabled ?? true,
    promptCacheTtl: config.promptCache?.ttl,
    promptCacheModel: config.promptCache?.model,
  }, async () => {
    const text = await readModelCache(cache, key);
    if (text !== undefined) {
      return { text, finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheHits: 1 } };
    }
    const result = await request();
    if (result.text.trim() && result.finishReason === "stop") {
      await writeModelCache(cache, key, result.text);
    }
    return result;
  });

  if (!shared || value.usage.cacheHits) return value;
  return {
    ...value,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, coalescedCalls: 1 },
  };
}

async function requestLLM(context: ProviderCacheContext, user: string): Promise<LLMCallResult> {
  const { provider: providerName, config, apiKey } = context;
  let providerCache = await prepareProviderCache(context);
  const cacheWriteTokens = providerCache.cacheWriteTokens;
  const model = createModel(providerName, config, apiKey, providerCache);

  const request = async (): Promise<Awaited<ReturnType<typeof generateText>>> => {
    try {
      return await generateText({
        model,
        system: providerCache.system,
        prompt: user,
        providerOptions: providerCache.providerOptions,
        temperature: config.temperature ?? 0.3,
        maxOutputTokens: config.maxTokens ?? 4000,
        maxRetries: config.initialRetryDelayMs === undefined ? config.maxRetries : 0,
      });
    } catch (error) {
      const recovered = await providerCache.recover?.(error);
      if (recovered) {
        providerCache = recovered;
        return request();
      }
      throw error;
    }
  };
  const { text, usage, finishReason } = config.initialRetryDelayMs === undefined
    ? await request()
    : await retryRequest(request, config.maxRetries ?? 2, config.initialRetryDelayMs);

  return {
    text,
    finishReason,
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      ...(usage.inputTokenDetails.cacheReadTokens !== undefined
        ? { providerCacheReadTokens: usage.inputTokenDetails.cacheReadTokens } : {}),
      ...(usage.inputTokenDetails.cacheWriteTokens !== undefined || cacheWriteTokens !== undefined
        ? { providerCacheWriteTokens: (usage.inputTokenDetails.cacheWriteTokens ?? 0) + (cacheWriteTokens ?? 0) } : {}),
    },
  };
}

// Node turns larger timer delays into 1 ms rather than waiting longer.
const MAX_RETRY_DELAY_MS = 2_147_483_647;

async function retryRequest<T>(request: () => Promise<T>, maxRetries: number, initialDelayMs: number): Promise<T> {
  const errors: unknown[] = [];
  let backoffMs = Math.min(initialDelayMs, MAX_RETRY_DELAY_MS);
  while (true) {
    try {
      return await request();
    } catch (error) {
      if (maxRetries === 0) throw error;
      errors.push(error);
      const retryable = APICallError.isInstance(error) && error.isRetryable;
      if (!retryable || errors.length > maxRetries) {
        if (!retryable && errors.length === 1) throw error;
        throw new RetryError({
          message: `Failed after ${errors.length} attempts. Last error: ${error instanceof Error ? error.message : String(error)}`,
          reason: retryable ? "maxRetriesExceeded" : "errorNotRetryable",
          errors,
        });
      }
      const headers = error.responseHeaders ?? {};
      let retryAfterMs = Number.parseFloat(headers["retry-after-ms"] ?? "");
      if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
        const retryAfter = headers["retry-after"] ?? "";
        const seconds = Number.parseFloat(retryAfter);
        retryAfterMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
      }
      const delayMs = Math.min(
        MAX_RETRY_DELAY_MS,
        Math.max(backoffMs, Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0)
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      backoffMs = Math.min(backoffMs * 2, MAX_RETRY_DELAY_MS);
    }
  }
}

function createModel(
  providerName: ProviderName,
  config: ProviderConfig,
  apiKey: string,
  providerCache: ProviderCacheRequest
) {
  const modelId = config.model || DEFAULT_MODELS[providerName];
  switch (providerName) {
    case "openai": {
      const openai = createOpenAI({ apiKey, fetch: providerCache.fetch });
      return openai(modelId);
    }

    case "anthropic": {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelId);
    }

    case "mistral": {
      const mistral = createMistral({ apiKey, fetch: providerCache.fetch });
      return mistral(modelId);
    }

    case "google": {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelId);
    }

    case "azure-openai": {
      const azure = createOpenAI({
        apiKey,
        baseURL: resolveBaseURL(providerName, config),
        fetch: providerCache.fetch,
      });
      return azure(modelId);
    }

    case "ollama": {
      const ollama = createOpenAI({
        apiKey: apiKey || "ollama",
        baseURL: resolveBaseURL(providerName, config) || "http://localhost:11434/v1",
      });
      return ollama(modelId);
    }

    default:
      throw new LLMError(`Unknown provider: ${providerName}`);
  }
}

export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
  }
}
