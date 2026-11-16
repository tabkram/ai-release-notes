# Caching

Local caching reuses complete responses without an API call. Provider prompt
caching discounts repeated input; generating a new answer still calls the model.

## Local responses

```yaml
cache:
  enabled: true
  ttl: 7d
```

Enabled by default for seven days. TTLs accept positive integers followed by
`ms`, `s`, `m`, `h`, or `d`. The configured TTL is measured from creation;
reading an entry does not extend its lifetime.

Responses live in `.ai-release-notes/cache/` under the working directory, with
their own `.gitignore`. Private files store the response and creation time.
SHA-256 filenames identify the provider, endpoint, model, temperature, output
token limit, full prompts and application/cache version. API keys are not saved.

Only non-empty, normally completed responses are saved. Expired, corrupt or
incomplete entries are misses. Writes are atomic; a storage failure warns
without discarding the answer.

Generation rejects truncated or empty notes, including empty Markdown fences,
before returning or saving them. A cached response that becomes empty when
unwrapped is evicted so the next run can recover rather than repeat the failure.

Concurrent identical requests share preparation, retries and persistence through
`execution-engine` 5's `executeMemoize` with `ttl: 0`. Completed or failed calls
are removed immediately. Sharing requires matching credentials, cache directory,
TTL, retry and provider-cache settings; it does not span CLI processes.
`--no-cache` / `cache: false` bypasses local reads, writes and request sharing.

```bash
# Bypass response caching; completed final documents are still reused.
ai-release-notes generate --from v1 --to v2 --env PROD --no-cache

# Replace selected final documents with fresh model responses.
ai-release-notes generate --from v1 --to v2 --env PROD --force --no-cache

# Override the lifetime for this run.
ai-release-notes generate --from v1 --to v2 --env PROD --cache-ttl 30d

# Clear all local responses and saved provider-resource handles for this project.
ai-release-notes cache clear
```

Generation, index translation, promotion openings and prompt sessions use the
cache. Injected `callModel` callbacks and generation dry runs bypass it.

## Provider prompt caching

Provider caching is enabled where supported. `promptCache.enabled: false` or
`--no-provider-cache` disables explicit hints and resource creation. Automatic
provider caching may remain active. `--no-cache` only bypasses the local cache.

| Provider | Behaviour | Configurable lifetime | Official documentation |
| --- | --- | --- | --- |
| Anthropic | Breakpoints on shared system rules and the full system prompt | `5m` or `1h`; defaults to `5m` | [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| OpenAI, GPT-5.6 and newer | Explicit Responses breakpoints on stable system messages | `30m` or `12h`; defaults to `30m` | [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) |
| OpenAI, earlier models | Stable routing key; automatic caching | `24h` only on the documented eligible models; omitted otherwise. `gpt-4o` does not accept this override | [Model differences](https://developers.openai.com/api/docs/guides/prompt-caching#summary-of-model-differences) |
| Azure OpenAI | OpenAI-compatible v1 Responses controls, subject to deployment/model support | Same model-family validation; set `promptCache.model` when the deployment name is an alias | [Azure prompt caching](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching) |
| Mistral | Stable `prompt_cache_key`; cached-token usage reporting | No public TTL control; a supplied TTL is rejected | [Prompt caching](https://docs.mistral.ai/inference/conversations/advanced/prompt-caching) |
| Google Gemini | Implicit caching when the model supports it; explicit resource creation when a TTL is supplied | Explicit caching accepts durations in whole seconds, including days, on compatible Gemini 2.5/3 models. No documented TTL bounds; storage is billed. Gemini 4 explicit caching is unsupported | [Context caching](https://ai.google.dev/gemini-api/docs/generate-content/caching), [Resource API](https://ai.google.dev/api/caching) |
| Ollama | No foreign cache controls are sent to its OpenAI-compatible endpoint | No prompt-cache TTL through this integration; a supplied TTL is rejected. Model `keep_alive` is a different setting | [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) |

GitHub Copilot is not integrated; it manages its own cache.
See [GitHub's guidance](https://docs.github.com/en/copilot/tutorials/optimize-ai-usage#4-preserve-the-cache).

```yaml
providers:
  anthropic:
    promptCache:
      ttl: 1h
  google:
    model: gemini-2.5-flash
    promptCache:
      ttl: 7d             # Explicit remote resource; billed storage.
  azure-openai:
    model: release-notes-prod
    promptCache:
      model: gpt-4.1      # Underlying model behind the deployment alias.
      ttl: 24h
```

`--provider-cache-ttl` overrides YAML. Unsupported provider/model/TTL pairs fail
before any call, even on a local hit. Azure can still reject options unsupported
by its deployment.

Scope guards and project rules precede task instructions so providers can reuse
the prefix. Hits depend on prompt size, model, expiry and routing. Cache writes
and longer retention can cost more; savings are not guaranteed.

Gemini stores explicit caches remotely; local handles include server expiry and
are scoped to the model, account, prompt and TTL. Expired resources are recreated.
Missing resources or undersized prefixes fall back to the original prompt;
other creation errors fail. The default `gemini-1.5-pro` cannot use explicit caching.
Clearing local entries does not delete remote resources or stop storage charges.

## Partial failures and reporting

Successful responses are saved before the next call. If German fails after
English and French, the error reports completed, failed and unattempted languages.
A rerun reuses completed responses. The CLI also saves each completed language
at its final destination before starting the next language. Separate release
files resume automatically from those documents, independently of cache expiry
or `--no-cache`; see [automatic resumption](generate.md#automatic-resumption).

For response-cache reuse, inputs must match, including the release date: use `--date tag` or a fixed date
to resume across days. An index failure also preserves note responses for the
rerun. Markdown and HTML follow the same rules; HTML rendering is local.

`cacheHits` counts local reuse; `coalescedCalls` counts shared pending calls.
Neither adds model calls or tokens. Only the initiating caller reports usage.
`providerCacheReadTokens` / `providerCacheWriteTokens` report API token counts
when available, not monetary cost or storage charges. `reused` output status means
the final document was read from disk; it is not an API response-cache hit.

## Programmatic API

```typescript
const result = await generate({
  fromVersion: "v1", toVersion: "v2", environment: "PROD",
  cacheTtl: "30d",
  promptCacheTtl: "1h", // With an Anthropic provider.
});

// Force a new response; disable explicit provider caching too if desired.
await generate({
  fromVersion: "v1", toVersion: "v2", environment: "PROD",
  cache: false,
  promptCache: false,
});
```

API options override YAML. `promote()` and `PromptSession.open()` accept the same
options; `clearModelCache()` clears local entries. `GenerationError.completed`
contains successful Markdown outputs; `metadata.outputs` carries language statuses.
Low-level `callLLM()` uses local caching only when its fifth argument supplies
`ModelCacheOptions`; provider caching follows `ProviderConfig.promptCache`.
