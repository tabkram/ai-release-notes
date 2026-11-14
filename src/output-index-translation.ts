import { callLLM, resolveLLMConfig } from "./llm.js";
import { RELEASES_MARKER } from "./release.js";
import { ENTRY_TEMPLATE_SEPARATOR, unwrapHtmlDocumentCodeFence } from "./output-index.js";
import { modelCacheKey, removeModelCache, writeModelCache, type ModelCacheOptions } from "./cache/index.js";
import type { ProviderConfig, ProviderName } from "./types.js";

const TRANSLATION_SYSTEM = "You translate release-summary templates. Return only the translated template. " +
  "Translate every human-readable sentence into the requested language, but preserve all HTML, CSS, Markdown syntax, URLs, and protected tokens exactly.";

function translationPrompt(template: string, language: string): string {
  return `Target language: ${language}\n\nTemplate:\n${protectTemplateTokens(template).template}`;
}

export async function translateOutputIndexTemplate(
  template: string,
  language: string,
  providerName: ProviderName,
  providerConfig: ProviderConfig,
  cache: ModelCacheOptions | false
) {
  providerConfig = resolveLLMConfig(providerName, providerConfig);
  const cacheKey = (source: string) => modelCacheKey(providerName, providerConfig, TRANSLATION_SYSTEM, translationPrompt(source, language));
  const protectedTemplate = protectTemplateTokens(template);
  const result = await callLLM(
    providerName,
    providerConfig,
    TRANSLATION_SYSTEM,
    translationPrompt(template, language),
    cache
  );
  const translated = unwrapHtmlDocumentCodeFence(
    restoreTemplateTokens(result.text, protectedTemplate.tokens)
  );
  const missingToken = protectedTemplate.tokens.find(([value]) =>
    template.includes(value) && !translated.includes(value)
  );
  if (missingToken) {
    if (cache) await removeModelCache(cache, cacheKey(template));
    throw new Error(`Translated output-index template did not preserve ${missingToken[0]}`);
  }
  // Creation translates summary + entry together. Save the entry separately so
  // the first update can reuse it without paying for a second translation.
  if (cache && !result.usage.cacheHits && result.finishReason === "stop" && template.includes(ENTRY_TEMPLATE_SEPARATOR)) {
    const sourceEntry = template
      .slice(template.lastIndexOf(ENTRY_TEMPLATE_SEPARATOR) + ENTRY_TEMPLATE_SEPARATOR.length)
      .replace(/^\r?\n/, "");
    const translatedEntry = translated
      .slice(translated.lastIndexOf(ENTRY_TEMPLATE_SEPARATOR) + ENTRY_TEMPLATE_SEPARATOR.length)
      .trim();
    await writeModelCache(cache, cacheKey(sourceEntry), translatedEntry);
  }
  return { text: translated, usage: result.usage };
}

function protectTemplateTokens(template: string): { template: string; tokens: Array<[string, string]> } {
  const values = [
    RELEASES_MARKER,
    // A new index translates both templates while preserving their boundary.
    ENTRY_TEMPLATE_SEPARATOR,
    "{{projectName}}",
    "{{environment}}",
    "{{language}}",
    "{{languages}}",
    "{{langages}}",
    "{{date}}",
    "{{releases}}",
    "{{version}}",
    "{{fromVersion}}",
    "{{toVersion}}",
    "{{fromToComparison}}",
    "{{links}}",
    "{{href}}",
  ];
  const tokens = values.map((value, index) => [value, `__AI_RELEASE_TEMPLATE_TOKEN_${index}__`] as [string, string]);
  return {
    template: tokens.reduce((result, [value, token]) => result.replaceAll(value, token), template),
    tokens,
  };
}

function restoreTemplateTokens(template: string, tokens: Array<[string, string]>): string {
  return tokens.reduce((result, [value, token]) => result.replaceAll(token, value), template);
}
