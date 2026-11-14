import type { GenerationUsage } from "./types.js";
import type { LLMCallResult } from "./llm.js";

/** Reused responses contribute reuse counts, never their original token charges. */
export function addModelUsage(total: GenerationUsage, usage: LLMCallResult["usage"]): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.totalTokens += usage.totalTokens;
  total.modelCalls += usage.cacheHits || usage.coalescedCalls ? 0 : 1;
  for (const field of ["cacheHits", "coalescedCalls", "providerCacheReadTokens", "providerCacheWriteTokens"] as const) {
    const value = usage[field];
    if (value !== undefined) total[field] = (total[field] ?? 0) + value;
  }
}
