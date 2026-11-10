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
import type { ProviderName, ProviderConfig } from "./types.js";

export interface LLMCallResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
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

/**
 * Get API key for a specific provider from environment variables.
 * Only the active provider's key is required.
 */
function getApiKey(providerName: ProviderName): string {
  const envVar = API_KEY_ENV_VARS[providerName];
  const key = process.env[envVar];

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
  user: string
): Promise<LLMCallResult> {
  const apiKey = getApiKey(providerName);
  const model = createModel(providerName, config, apiKey);

  const request = () => generateText({
    model,
    system,
    prompt: user,
    temperature: config.temperature ?? 0.3,
    maxOutputTokens: config.maxTokens ?? 4000,
    maxRetries: config.initialRetryDelayMs === undefined ? config.maxRetries : 0,
  });
  const { text, usage } = config.initialRetryDelayMs === undefined
    ? await request()
    : await retryRequest(request, config.maxRetries ?? 2, config.initialRetryDelayMs);

  return {
    text,
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
    },
  };
}

async function retryRequest<T>(request: () => Promise<T>, maxRetries: number, initialDelayMs: number): Promise<T> {
  const errors: unknown[] = [];
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
      const backoffMs = initialDelayMs * 2 ** (errors.length - 1);
      const delayMs = Math.max(backoffMs, Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0);
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function createModel(
  providerName: ProviderName,
  config: ProviderConfig,
  apiKey: string
) {
  switch (providerName) {
    case "openai": {
      const openai = createOpenAI({ apiKey });
      return openai(config.model || "gpt-4o");
    }

    case "anthropic": {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(config.model || "claude-sonnet-4-20250514");
    }

    case "mistral": {
      const mistral = createMistral({ apiKey });
      return mistral(config.model || "mistral-large-latest");
    }

    case "google": {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(config.model || "gemini-1.5-pro");
    }

    case "azure-openai": {
      const azure = createOpenAI({
        apiKey,
        baseURL: resolveBaseURL(providerName, config),
      });
      return azure(config.model || "gpt-4o");
    }

    case "ollama": {
      const ollama = createOpenAI({
        apiKey: apiKey || "ollama",
        baseURL: resolveBaseURL(providerName, config) || "http://localhost:11434/v1",
      });
      return ollama(config.model || "llama3.1");
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
