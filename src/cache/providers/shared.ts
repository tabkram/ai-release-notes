import { createHash } from "node:crypto";
import type { ProviderCacheContext, SystemMessage } from "./types.js";

/** Stable rules precede task-specific instructions in the bundled prompts. */
export function systemMessages(system: string): SystemMessage[] {
  const marker = system.includes("\n\n## Task\n\n") ? "\n\n## Task\n\n" : "\n\n";
  const boundary = system.indexOf(marker);
  return boundary < 0 ? [{ role: "system", content: system }] : [
    { role: "system", content: system.slice(0, boundary) },
    { role: "system", content: system.slice(boundary + 2) },
  ];
}

export function promptCacheKey({ provider, config, system }: ProviderCacheContext): string {
  return createHash("sha256").update(JSON.stringify({
    provider, model: config.promptCache?.model ?? config.model, prefix: systemMessages(system)[0].content,
  })).digest("hex");
}

/** Transport adapter for documented fields not yet exposed by the installed SDK. */
export function withCacheRequestFields(fields: Record<string, unknown>): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body !== "string") throw new Error("Expected a JSON model request when applying prompt cache options");
    return globalThis.fetch(input, { ...init, body: JSON.stringify({ ...JSON.parse(init.body), ...fields }) });
  };
}
