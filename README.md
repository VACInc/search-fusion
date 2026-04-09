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
- emit structured `payload.evidenceTable` rows for downstream evidence-table renderers (for example Atlas)
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

## Evidence table output (`payload.evidenceTable`)

Search Fusion emits a table-ready structure for downstream consumers like Atlas.

- `columns[]` provides stable column metadata (`key`, `label`, `description`)
- `rows[]` has one row per merged URL (`rowId` is the canonical URL)
- `rows[].answerCitationSupport` tracks citation count and citing providers from answer-style runs
- `rows[].providerEvidence[]` keeps provider-level rank, score, source type, flags, and snippets for drill-down cells

Example flattening transform:

```ts
const tableRows = payload.evidenceTable.rows.map((row) => ({
  rank: row.rank,
  title: row.title,
  url: row.url,
  providers: row.providers.join(", "),
  providerCount: row.providerCount,
  bestRank: row.bestRank,
  score: Number(row.score.toFixed(3)),
  answerCitationCount: row.answerCitationSupport.count,
  flags: row.flags.join(", "),
}));
```

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
- emits `evidenceTable.columns[]` and `evidenceTable.rows[]` for direct evidence-table rendering
- includes `evidenceTable.rows[].answerCitationSupport` and `providerEvidence[]` helper fields for claim-support views
- surfaces deterministic flags like `sponsored`, `redirect-wrapper`, `tracking-stripped`, `community`, and `video`
- surfaces native ranks and merged rankings so the LLM can see where each hit came from
- carries answer-style providers (Gemini / Grok / Kimi / Perplexity) as provider digests with `fullContent`, citation details, and citation-derived hits

## Next upgrades

- provider weighting
- cost-aware routing modes
- result reranking beyond URL dedupe
- caching at the broker layer
- optional fetch/expansion of top merged hits
