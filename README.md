# Search Fusion

Federated web search for OpenClaw.

This plugin reuses the web search providers you already have configured, fans them out in parallel, merges duplicate URLs, preserves which provider found what, and keeps the raw evidence attached.

## Requirements

- OpenClaw `2026.3.22` or newer

The broker relies on the newer plugin runtime web-search helpers. Older OpenClaw builds may install the package but will not provide the runtime surface this plugin expects.

## What it adds

- A **web search provider** named `search-fusion`
- A direct **agent tool** named `search_fusion`
- A helper tool named `search_fusion_providers`

## Why this exists

OpenClaw already has solid search providers. The missing piece was orchestration.

Search Fusion is the orchestration layer:
- discover configured providers
- run them in parallel
- retry transient provider failures with configurable policy
- merge duplicate URLs
- keep provider attribution intact
- preserve raw provider payloads and per-provider merged variants
- expose native ranks, deterministic flags, and merged rankings
- expose one clean result set back to the agent

## Install

```bash
openclaw plugins install @vacinc/search-fusion
```

## Configure

Optional plugin config:

```json
{
  "plugins": {
    "entries": {
      "search-fusion": {
        "enabled": true,
        "config": {
          "modes": {
            "fast": ["brave"],
            "balanced": ["brave", "tavily"],
            "deep": ["brave", "tavily", "gemini"],
            "cheap": ["duckduckgo", "brave"],
            "results": ["brave", "tavily", "duckduckgo"],
            "answers": ["gemini"]
          },
          "intentProviders": {
            "research": ["gemini", "tavily", "brave"],
            "keyword":  ["brave", "duckduckgo"],
            "answer":   ["gemini"],
            "news":     ["brave", "tavily"],
            "local":    ["brave"]
          },
          "defaultMode": "balanced",
          "excludeProviders": ["grok"],
          "countPerProvider": 5,
          "maxMergedResults": 10,
          "providerTimeoutMs": 15000,
          "retry": {
            "maxAttempts": 3,
            "backoffMs": 750,
            "backoffMultiplier": 2,
            "maxBackoffMs": 5000
          },
          "providerConfig": {
            "gemini": {
              "timeoutMs": 60000,
              "retry": {
                "maxAttempts": 4,
                "backoffMs": 1500
              }
            }
          }
        }
      }
    }
  }
}
```

Resolution order:
- explicit `providers`
- explicit `mode`
- `intent` hint → matched against `intentProviders` map
- configured `defaultMode`
- configured `defaultProviders` (backward compatibility)
- otherwise all configured providers

`providerConfig.<id>` is the canonical place for per-provider overrides like `retry`, `timeoutMs`, and `count`.

### Intent-based routing

Set `intentProviders` to bias provider selection when a caller passes an `intent` hint. The intent is applied after explicit `providers`/`mode` but before `defaultMode`/`defaultProviders`, so it only kicks in when the caller leaves routing unspecified.

Supported intents:

| Intent | Suggested use | Example providers |
|---|---|---|
| `research` | In-depth investigation; prefers answer/grounding | `gemini`, `tavily`, `brave` |
| `keyword` | Classic keyword/web search | `brave`, `duckduckgo` |
| `answer` | Direct answer expected | `gemini`, `perplexity`, `grok` |
| `news` | Recent news / current events | `brave`, `tavily` |
| `local` | Location-aware queries | `brave` |

Example config snippet:

```json
{
  "plugins": {
    "entries": {
      "search-fusion": {
        "config": {
          "intentProviders": {
            "research": ["gemini", "tavily", "brave"],
            "keyword":  ["brave", "duckduckgo"],
            "answer":   ["gemini", "perplexity"],
            "news":     ["brave", "tavily"],
            "local":    ["brave"]
          }
        }
      }
    }
  }
}
```

When `intentProviders` has no entry for the given intent, or the mapped providers are unavailable, routing falls through to `defaultMode`, `defaultProviders`, and finally all configured providers.

If you want the built-in `web_search` tool to route through the broker by default:

```json
{
  "tools": {
    "web": {
      "search": {
        "provider": "search-fusion"
      }
    }
  }
}
```

## Tool usage

### `search_fusion`

Example prompt:

- Search across all configured providers for `openclaw plugin sdk runtime helpers`
- Search brave and tavily only for `best local llm web search api` with 3 results each
- Search in `deep` mode for `best local llm web search api`

Supported arguments:
- `query`
- `intent` — optional routing hint: `research`, `keyword`, `answer`, `news`, or `local`
- `mode` — user-defined mode name from plugin config
- `providers` — provider ids, or `all`
- `count`
- `maxMergedResults`
- `country`
- `language`
- `freshness`
- `date_after`
- `date_before`
- `search_lang`
- `ui_lang`
- `includeFailures`

### `search_fusion_providers`

Lists the providers visible to the broker and whether they appear configured.

## Development

```bash
pnpm install
pnpm check
pnpm test
```

## Current behavior

- no hardcoded modes; users define modes in config if they want them
- falls back to all configured providers when nothing else is specified
- treats keyless providers (for example DuckDuckGo) as configured/available
- excludes itself to avoid recursion
- dedupes by canonical URL
- retries transient provider failures with global defaults and per-provider overrides via `providerConfig.<id>.retry`
- preserves raw provider payloads in `providerRuns[]`
- preserves per-provider merged variants in `results[].variants[]`
- surfaces deterministic flags like `sponsored`, `redirect-wrapper`, `tracking-stripped`, `community`, and `video`
- surfaces native ranks and merged rankings so the LLM can see where each hit came from
- carries answer-style providers (Gemini / Grok / Kimi / Perplexity) as provider digests with `fullContent`, citation details, and citation-derived hits
- supports `intent` routing hints (`research`, `keyword`, `answer`, `news`, `local`) that bias provider selection without overriding explicit `providers` or `mode`

## Next upgrades

- provider weighting
- cost-aware routing modes
- result reranking beyond URL dedupe
- caching at the broker layer
- optional fetch/expansion of top merged hits
