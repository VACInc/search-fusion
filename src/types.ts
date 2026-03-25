export type SearchFusionModeMap = Record<string, string[]>;

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

export type NormalizedSearchResult = {
  title: string;
  url: string;
  canonicalUrl: string;
  snippet?: string;
  siteName?: string;
  providerId: string;
  score: number;
  rawRank: number;
  sourceType: "results" | "citations" | "sources";
  snippetSource?: "provider" | "answer-fallback";
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

export type FusionMergedResult = {
  title: string;
  url: string;
  canonicalUrl: string;
  snippet?: string;
  siteName?: string;
  providers: string[];
  providerCount: number;
  score: number;
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
