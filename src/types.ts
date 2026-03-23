export type SearchBrokerConfig = {
  defaultProviders?: string[];
  excludeProviders?: string[];
  countPerProvider?: number;
  maxMergedResults?: number;
  providerTimeoutMs?: number;
};

export type ProviderSelectionRequest = {
  query: string;
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
};

export type ProviderAnswerDigest = {
  providerId: string;
  summary: string;
  citations: string[];
};

export type ProviderRunResult = {
  providerId: string;
  label: string;
  configured: boolean;
  ok: boolean;
  tookMs: number;
  rawCount: number;
  results: NormalizedSearchResult[];
  answer?: ProviderAnswerDigest;
  error?: string;
};

export type BrokerMergedResult = {
  title: string;
  url: string;
  canonicalUrl: string;
  snippet?: string;
  siteName?: string;
  providers: string[];
  providerCount: number;
  score: number;
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

export type BrokerSearchPayload = {
  query: string;
  provider: "search-broker";
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
    configured: boolean;
    error?: string;
  }>;
  answers: ProviderAnswerDigest[];
  results: BrokerMergedResult[];
  externalContent: {
    untrusted: true;
    source: "web_search";
    provider: "search-broker";
    aggregated: true;
  };
};
