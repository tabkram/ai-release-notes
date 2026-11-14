# Model caching

Start at [index.ts](index.ts), the entry point used by the rest of the application.

| File | Responsibility |
| --- | --- |
| [config.ts](config.ts) | YAML schemas, TTL parsing and runtime overrides |
| [local.ts](local.ts) | Request fingerprints, response files, expiration and clearing |
| [in-flight.ts](in-flight.ts) | Share pending requests using execution-engine 5's zero-TTL memoization |
| [providers/index.ts](providers/index.ts) | Dispatch to the selected provider |
| [providers/types.ts](providers/types.ts) | The common adapter contract |
| [providers/shared.ts](providers/shared.ts) | Stable system prefixes and SDK transport helpers |
| [providers/anthropic.ts](providers/anthropic.ts) | Cache-control breakpoints and 5m/1h validation |
| [providers/openai.ts](providers/openai.ts) | Model-specific Responses cache controls |
| [providers/azure.ts](providers/azure.ts) | OpenAI rules applied to Azure deployment aliases |
| [providers/mistral.ts](providers/mistral.ts) | Stable prompt cache keys; no configurable TTL |
| [providers/google.ts](providers/google.ts) | Implicit caching or explicit remote cache resources |
| [providers/ollama.ts](providers/ollama.ts) | Compatibility without unsupported cache fields |

[llm.ts](../llm.ts) validates provider settings, checks the local response cache, prepares
the provider request, and saves a completed response. Provider-specific resource
creation and recovery stay inside the corresponding adapter. Token accounting
lives in [model-usage.ts](../model-usage.ts).

See [configuration and official provider documentation](../../docs/caching.md).
