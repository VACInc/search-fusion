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

export type SourceTierMode = "off" | "balanced" | "strict";

export type SearchFusionConfig = {
  defaultMode?: string;
  modes?: SearchFusionModeMap;
  defaultProviders?: string[];
  excludeProviders?: string[];
  sourceTierMode?: SourceTierMode;
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
  /**
   * Capability tags declared for this provider by the capability taxonomy.
   * An empty array means the provider is treated as general-purpose / unknown.
   * See `src/provider-capabilities.ts` for the full vocabulary.
   */
  capabilities?: import("./provider-capabilities.js").ProviderCapability[];
};

export type SearchResultFlag =
  | "community"
  | "redirect-wrapper"
  | "sponsored"
  | "tracking-stripped"
  | "video";

export type SearchResultSourceType = "results" | "citations" | "sources";

export type SearchResultSourceTier = "high" | "standard" | "low" | "suppressed";

export type DiscardedSearchResultReason = "missing-url";

export type DiscardedSearchResult = {
  providerId: string;
  sourceType: SearchResultSourceType;
  rawRank: number;
  reason: DiscardedSearchResultReason;
  title?: string;
  snippet?: string;
  rawItem?: unknown;
};

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
  sourceTier: SearchResultSourceTier;
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
  discardedResults: DiscardedSearchResult[];
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
  sourceTier: SearchResultSourceTier;
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
  bestSourceTier: SearchResultSourceTier;
  flags: SearchResultFlag[];
  rankings: SearchResultRanking[];
  variants: NormalizedSearchResult[];
};

export type EvidenceTableColumnKey =
  | "rank"
  | "title"
  | "url"
  | "providers"
  | "providerCount"
  | "bestRank"
  | "score"
  | "answerCitationCount"
  | "flags";

export type EvidenceTableColumn = {
  key: EvidenceTableColumnKey;
  label: string;
  description: string;
};

export type FusionEvidenceProvider = {
  providerId: string;
  rawRank: number;
  score: number;
  nativeScore?: number;
  sourceType: SearchResultSourceType;
  snippet?: string;
  snippetSource?: "provider" | "answer-fallback";
  flags: SearchResultFlag[];
};

export type FusionEvidenceCitationSupport = {
  count: number;
  providerCount: number;
  providers: string[];
};

export type FusionEvidenceRow = {
  rowId: string;
  rank: number;
  title: string;
  url: string;
  canonicalUrl: string;
  siteName?: string;
  snippet?: string;
  providers: string[];
  providerCount: number;
  bestRank: number;
  score: number;
  flags: SearchResultFlag[];
  answerCitationSupport: FusionEvidenceCitationSupport;
  providerEvidence: FusionEvidenceProvider[];
};

export type FusionEvidenceTable = {
  version: 1;
  columns: EvidenceTableColumn[];
  rowCount: number;
  rows: FusionEvidenceRow[];
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
    discardedCount: number;
    attempts: number;
    configured: boolean;
    error?: string;
  }>;
  providerRuns: Array<{
    provider: string;
    ok: boolean;
    tookMs: number;
    rawCount: number;
    discardedCount: number;
    attempts: number;
    configured: boolean;
    error?: string;
    answer?: ProviderAnswerDigest;
    results: NormalizedSearchResult[];
    discardedResults: DiscardedSearchResult[];
    rawPayload?: Record<string, unknown>;
    retryHistory: ProviderRetryEvent[];
  }>;
  discardedResults: DiscardedSearchResult[];
  answers: ProviderAnswerDigest[];
  results: FusionMergedResult[];
  evidenceTable: FusionEvidenceTable;
  externalContent: {
    untrusted: true;
    source: "web_search";
    provider: "search-fusion";
    aggregated: true;
  };
};
