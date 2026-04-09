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
- configured `defaultMode`
- configured `defaultProviders` (backward compatibility)
- otherwise all configured providers

`providerConfig.<id>` is the canonical place for per-provider overrides like `retry`, `timeoutMs`, and `count`.

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
- **emits filter diagnostics** so the LLM and callers can see which filter args were silently ignored, unsupported, or only partially applied by each provider

## Filter diagnostics

Search Fusion passes every user-supplied filter arg (`country`, `language`, `freshness`, `date_after`, `date_before`, `search_lang`, `ui_lang`) to every provider verbatim. Providers silently drop args they do not support — without diagnostics, there is no way to know why results did not match the requested filters.

The filter diagnostics feature adds structured per-provider reporting to `providerDetails` and `providerRuns`. Each entry carries:

```ts
filterDiagnostics?: {
  providerId: string;
  filtersFullyApplied: boolean;  // false when any arg was unsupported / ignored / degraded
  issues: Array<{
    arg: string;           // e.g. "date_after"
    sentValue: string;     // e.g. "2024-01-01"
    level: "unsupported" | "ignored" | "degraded";
    message: string;       // human-readable description
  }>;
};
```

Support levels:

| Level | Meaning |
|---|---|
| `supported` | Provider accepts and applies this filter. No issue emitted. |
| `unsupported` | Provider does not accept the arg; it is dropped before the request. |
| `ignored` | Provider receives the arg but does not act on it; results are unaffected. |
| `degraded` | Provider accepts the arg but its effect is partial or approximate (e.g. freshness maps to coarse time buckets). |

The diagnostics appear inline in `renderFusionSummary` output under each provider's status line. Providers not in the registry emit no diagnostics — no false positives for custom or uncatalogued providers.

Example summary output:

```
Provider status:
- tavily: ok (5 hits, 312ms)
  ⚠ [unsupported] date_after="2024-01-01": tavily does not support the "date_after" filter — the argument is not accepted and will be dropped.
  ⚠ [ignored] country="US": tavily does not apply the "country" filter — the argument is accepted but has no effect on results.
- brave: ok (5 hits, 198ms)
```

## Next upgrades

- provider weighting
- cost-aware routing modes
- result reranking beyond URL dedupe
- caching at the broker layer
- optional fetch/expansion of top merged hits
