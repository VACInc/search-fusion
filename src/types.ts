export type SearchFusionModeMap = Record<string, string[]>;

/**
 * Hint describing the caller's intent for a search query.
 *
 * - `"research"` — in-depth investigation; prefer answer/grounding providers alongside broad
 *   web search (e.g. Gemini, Perplexity, Tavily).
 * - `"keyword"` — keyword / classic web search; prefer fast index-based providers
 *   (e.g. Brave, DuckDuckGo).
 * - `"answer"` — direct answer expected; prefer answer-style providers
 *   (e.g. Gemini, Grok, Perplexity).
 * - `"news"` — recent news / current events; prefer freshness-optimized providers.
 * - `"local"` — location-aware query; prefer providers with local/map results.
 *
 * When an intent is provided it influences provider selection but never overrides
 * explicit `providers` or `mode` parameters.
 */
export type SearchQueryIntent = "research" | "keyword" | "answer" | "news" | "local";

export type SearchFusionRetryConfig = {
  maxAttempts?: number;
  backoffMs?: number;
  backoffMultiplier?: number;
  maxBackoffMs?: number;
};

export type SearchFusionProviderConfig = {
  retry?: SearchFusionRetryConfig;
  timeoutMs?: number;
  count?: number;
};

export type SearchFusionConfig = {
  defaultMode?: string;
  modes?: SearchFusionModeMap;
  /**
   * Provider lists keyed by `SearchQueryIntent`.
   * When a request carries an `intent` hint and no explicit `providers`/`mode`,
   * Search Fusion uses this map to pick the provider set.
   * Falls back to the normal default-resolution chain when the intent is absent
   * or has no entry here.
   *
   * Example:
   * ```json
   * "intentProviders": {
   *   "research": ["gemini", "tavily", "brave"],
   *   "keyword":  ["brave", "duckduckgo"],
   *   "answer":   ["gemini", "perplexity"],
   *   "news":     ["brave", "tavily"],
   *   "local":    ["brave"]
   * }
   * ```
   */
  intentProviders?: Partial<Record<SearchQueryIntent, string[]>>;
  defaultProviders?: string[];
  excludeProviders?: string[];
  countPerProvider?: number;
  maxMergedResults?: number;
  providerTimeoutMs?: number;
  retry?: SearchFusionRetryConfig;
  providerConfig?: Record<string, SearchFusionProviderConfig>;
  providerRetries?: Record<string, SearchFusionRetryConfig>;
};

export type ProviderSelectionRequest = {
  query: string;
  /**
   * Optional intent hint that biases provider selection without overriding
   * explicit `providers` or `mode`.
   *
   * Resolution order:
   * 1. explicit `providers`
   * 2. explicit `mode`
   * 3. `intent` → matched against `config.intentProviders`
   * 4. configured `defaultMode`
   * 5. configured `defaultProviders`
   * 6. all configured providers
   */
  intent?: SearchQueryIntent;
  mode?: string;
  providers?: string[];
  count?: number;
  maxMergedResults?: number;
  country?: string;
  language?: string;
  freshness?: string;
  date_after?: string;
  date_before?: string;
  search_lang?: string;
  ui_lang?: string;
  includeFailures?: boolean;
};

export type RuntimeWebSearchProvider = {
  id: string;
  label: string;
  hint?: string;
  autoDetectOrder?: number;
  requiresCredential?: boolean;
  envVars?: readonly string[];
  getConfiguredCredentialValue?: (config?: unknown) => unknown;
  getCredentialValue?: (searchConfig?: Record<string, unknown> | undefined) => unknown;
};

export type ResolvedProvider = {
  id: string;
  label: string;
  hint?: string;
  autoDetectOrder?: number;
  configured: boolean;
};

export type SearchResultFlag =
  | "community"
  | "redirect-wrapper"
  | "sponsored"
  | "tracking-stripped"
  | "video";

export type SearchResultSourceType = "results" | "citations" | "sources";

export type NormalizedSearchResult = {
  title: string;
  url: string;
  originalUrl: string;
  canonicalUrl: string;
  snippet?: string;
  siteName?: string;
  providerId: string;
  score: number;
  nativeScore?: number;
  rawRank: number;
  sourceType: SearchResultSourceType;
  snippetSource?: "provider" | "answer-fallback";
  flags: SearchResultFlag[];
  rawItem?: unknown;
};

export type ProviderAnswerCitation = {
  url: string;
  title?: string;
  raw?: unknown;
};

export type ProviderAnswerDigest = {
  providerId: string;
  summary: string;
  fullContent: string;
  summaryTruncated: boolean;
  citations: string[];
  citationDetails: ProviderAnswerCitation[];
};

export type ProviderRetryEvent = {
  attempt: number;
  error: string;
  delayMs: number;
};

export type ProviderRunResult = {
  providerId: string;
  label: string;
  configured: boolean;
  ok: boolean;
  tookMs: number;
  rawCount: number;
  attempts: number;
  rawPayload?: Record<string, unknown>;
  results: NormalizedSearchResult[];
  answer?: ProviderAnswerDigest;
  retryHistory: ProviderRetryEvent[];
  error?: string;
};

export type SearchResultRanking = {
  providerId: string;
  rawRank: number;
  score: number;
  nativeScore?: number;
  sourceType: SearchResultSourceType;
  flags: SearchResultFlag[];
};

export type FusionMergedResult = {
  title: string;
  url: string;
  canonicalUrl: string;
  snippet?: string;
  siteName?: string;
  providers: string[];
  providerCount: number;
  score: number;
  bestRank: number;
  flags: SearchResultFlag[];
  rankings: SearchResultRanking[];
  variants: NormalizedSearchResult[];
};

export type SearchRuntime = {
  webSearch: {
    listProviders: (params?: { config?: unknown }) => RuntimeWebSearchProvider[];
    search: (params: {
      config?: unknown;
      providerId?: string;
      args: Record<string, unknown>;
    }) => Promise<{ provider: string; result: Record<string, unknown> }>;
  };
};

export type FusionSearchPayload = {
  query: string;
  provider: "search-fusion";
  tookMs: number;
  count: number;
  configuredProviders: string[];
  providersQueried: string[];
  providersSucceeded: string[];
  providersFailed: Array<{ provider: string; error: string }>;
  providerDetails: Array<{
    provider: string;
    ok: boolean;
    tookMs: number;
    rawCount: number;
    attempts: number;
    configured: boolean;
    error?: string;
  }>;
  providerRuns: Array<{
    provider: string;
    ok: boolean;
    tookMs: number;
    rawCount: number;
    attempts: number;
    configured: boolean;
    error?: string;
    answer?: ProviderAnswerDigest;
    results: NormalizedSearchResult[];
    rawPayload?: Record<string, unknown>;
    retryHistory: ProviderRetryEvent[];
  }>;
  answers: ProviderAnswerDigest[];
  results: FusionMergedResult[];
  externalContent: {
    untrusted: true;
    source: "web_search";
    provider: "search-fusion";
    aggregated: true;
  };
};
