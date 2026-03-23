# OpenClaw Search Broker

Federated web search for OpenClaw.

This plugin reuses the web search providers you already have configured, fans them out in parallel, merges duplicate URLs, and preserves which provider found what.

## Requirements

- OpenClaw `2026.3.22` or newer

The broker relies on the newer plugin runtime web-search helpers. Older OpenClaw builds may install the package but will not provide the runtime surface this plugin expects.

## What it adds

- A **web search provider** named `search-broker`
- A direct **agent tool** named `search_broker`
- A helper tool named `search_broker_providers`

## Why this exists

OpenClaw already has solid search providers. The missing piece was orchestration.

Search Broker is the orchestration layer:
- discover configured providers
- run them in parallel
- merge duplicate URLs
- keep provider attribution intact
- expose one clean result set back to the agent

## Install

```bash
openclaw plugins install @vacinc/openclaw-search-broker
```

## Configure

Optional plugin config:

```json
{
  "plugins": {
    "entries": {
      "search-broker": {
        "enabled": true,
        "config": {
          "defaultProviders": ["brave", "tavily", "firecrawl"],
          "excludeProviders": ["grok"],
          "countPerProvider": 5,
          "maxMergedResults": 10,
          "providerTimeoutMs": 15000
        }
      }
    }
  }
}
```

If you want the built-in `web_search` tool to route through the broker by default:

```json
{
  "tools": {
    "web": {
      "search": {
        "provider": "search-broker"
      }
    }
  }
}
```

## Tool usage

### `search_broker`

Example prompt:

- Search across all configured providers for `openclaw plugin sdk runtime helpers`
- Search brave and tavily only for `best local llm web search api` with 3 results each

Supported arguments:
- `query`
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

### `search_broker_providers`

Lists the providers visible to the broker and whether they appear configured.

## Development

```bash
pnpm install
pnpm check
pnpm test
```

## Current behavior

- defaults to configured providers when no provider list is given
- excludes itself to avoid recursion
- dedupes by canonical URL
- carries answer-style providers (Gemini / Grok / Kimi / Perplexity) as provider digests plus citation-derived hits

## Next upgrades

- provider weighting
- cost-aware routing modes
- result reranking beyond URL dedupe
- caching at the broker layer
- optional fetch/expansion of top merged hits
