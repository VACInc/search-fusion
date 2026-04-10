import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type {
  FusionEvidenceRow,
  FusionEvidenceTable,
  FusionMergedResult,
  FusionRankingMeta,
  FusionScoreBreakdown,
  FusionSearchPayload,
  ProviderAnswerDigest,
  ProviderRunResult,
  ProviderSelectionRequest,
  ResolvedProvider,
  SearchFusionConfig,
  SearchFusionProviderConfig,
  SearchFusionRetryConfig,
  SearchResultFlag,
  SearchRuntime,
  SourceTierMode,
} from "./types.js";
import { discoverProviders, resolveSelectedProviders } from "./provider-discovery.js";
import { normalizeProviderPayload } from "./result-normalizer.js";
import {
  compareSourceTierDesc,
  coerceSourceTierMode,
  pickHigherSourceTier,
  sourceTierMergedAdjustment,
} from "./source-tier.js";
import { canonicalizeUrl } from "./text.js";

const DEFAULT_COUNT_PER_PROVIDER = 5;
const DEFAULT_MAX_MERGED_RESULTS = 10;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 750;
const DEFAULT_RETRY_BACKOFF_MULTIPLIER = 2;
const DEFAULT_RETRY_MAX_BACKOFF_MS = 5000;
const DEFAULT_PROVIDER_WEIGHT = 1;
const MIN_PROVIDER_WEIGHT = 0.1;
const MAX_PROVIDER_WEIGHT = 5;
const SEARCH_FUSION_PROVIDER_ID = "search-fusion";
const MERGED_RANKING_STRATEGY = "merged-score-v1" as const;
const MERGED_SORT_ORDER = ["score:desc", "bestRank:asc", "providerCount:desc", "title:asc"] as const;

const EVIDENCE_TABLE_COLUMNS: ReadonlyArray<FusionEvidenceTable["columns"][number]> = [
  {
    key: "rank",
    label: "Rank",
    description: "Merged ordering position after dedupe and score computation.",
  },
  {
    key: "title",
    label: "Title",
    description: "Best available title for the merged URL.",
  },
  {
    key: "url",
    label: "URL",
    description: "Display URL for the merged hit.",
  },
  {
    key: "providers",
    label: "Providers",
    description: "Provider ids that independently surfaced this URL.",
  },
  {
    key: "providerCount",
    label: "Provider Count",
    description: "How many providers corroborated this URL.",
  },
  {
    key: "bestRank",
    label: "Best Rank",
    description: "Best raw rank observed across providers.",
  },
  {
    key: "score",
    label: "Merged Score",
    description: "Final broker score used for merged ordering.",
  },
  {
    key: "answerCitationCount",
    label: "Answer Citations",
    description: "How many answer-style provider citations referenced this URL.",
  },
  {
    key: "flags",
    label: "Flags",
    description: "Deterministic flags inferred during normalization and merge.",
  },
];

type ResolvedRetryConfig = {
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
};

type ResolvedProviderConfig = {
  count: number;
  timeoutMs: number;
  retry: ResolvedRetryConfig;
  weight: number;
};

type ProviderRunTaskRejection = {
  error: unknown;
  tookMs: number;
};

function asConfig(pluginConfig: unknown): SearchFusionConfig {
  return pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig)
    ? (pluginConfig as SearchFusionConfig)
    : {};
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function applyProviderWeight(score: number, weight: number): number {
  return Math.max(0.01, roundScore(score * weight));
}

function resolveProviderConfig(
  config: SearchFusionConfig,
  providerId: string,
): SearchFusionProviderConfig {
  return config.providerConfig?.[providerId] ?? {};
}

function resolveRetryConfig(config: SearchFusionConfig, providerId: string): ResolvedRetryConfig {
  const globalRetry = config.retry ?? {};
  const legacyProviderRetry = config.providerRetries?.[providerId] ?? {};
  const providerRetry = resolveProviderConfig(config, providerId).retry ?? {};
  const merged: SearchFusionRetryConfig = {
    ...globalRetry,
    ...legacyProviderRetry,
    ...providerRetry,
  };

  return {
    maxAttempts: clamp(merged.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS, 1, 10),
    backoffMs: clamp(merged.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS, 0, 30000),
    backoffMultiplier: clamp(merged.backoffMultiplier ?? DEFAULT_RETRY_BACKOFF_MULTIPLIER, 1, 10),
    maxBackoffMs: clamp(merged.maxBackoffMs ?? DEFAULT_RETRY_MAX_BACKOFF_MS, 0, 120000),
  };
}

function resolveRuntimeProviderConfig(
  request: ProviderSelectionRequest,
  config: SearchFusionConfig,
  providerId: string,
): ResolvedProviderConfig {
  const providerConfig = resolveProviderConfig(config, providerId);

  return {
    count: clamp(
      request.count ?? providerConfig.count ?? config.countPerProvider ?? DEFAULT_COUNT_PER_PROVIDER,
      1,
      10,
    ),
    timeoutMs: clamp(
      providerConfig.timeoutMs ?? config.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
      1000,
      120000,
    ),
    retry: resolveRetryConfig(config, providerId),
    weight: clamp(providerConfig.weight ?? DEFAULT_PROVIDER_WEIGHT, MIN_PROVIDER_WEIGHT, MAX_PROVIDER_WEIGHT),
  };
}

function buildProviderArgs(
  request: ProviderSelectionRequest,
  config: SearchFusionConfig,
  providerId: string,
): Record<string, unknown> {
  const providerConfig = resolveRuntimeProviderConfig(request, config, providerId);

  return {
    query: request.query,
    count: providerConfig.count,
    country: request.country,
    language: request.language,
    freshness: request.freshness,
    date_after: request.date_after,
    date_before: request.date_before,
    search_lang: request.search_lang,
    ui_lang: request.ui_lang,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string" &&
    (error as { message: string }).message.length > 0
  ) {
    return (error as { message: string }).message;
  }

  try {
    const rendered = String(error);
    if (rendered.length > 0 && rendered !== "[object Object]") {
      return rendered;
    }
  } catch {
    // Ignore stringify errors and fall back to a generic message.
  }

  return "Unknown error";
}

function isProviderRunTaskRejection(value: unknown): value is ProviderRunTaskRejection {
  return (
    value !== null &&
    typeof value === "object" &&
    "tookMs" in value &&
    typeof (value as { tookMs?: unknown }).tookMs === "number" &&
    "error" in value
  );
}

function asUnhandledProviderFailure(params: {
  provider: ResolvedProvider;
  tookMs: number;
  error: unknown;
}): ProviderRunResult {
  return {
    providerId: params.provider.id,
    label: params.provider.label,
    configured: params.provider.configured,
    ok: false,
    tookMs: Math.max(0, params.tookMs),
    rawCount: 0,
    attempts: 1,
    results: [],
    discardedResults: [],
    retryHistory: [],
    error: asErrorMessage(params.error),
  };
}

function shouldRetry(errorMessage: string): boolean {
  const nonRetriablePatterns = [
    /401\b/,
    /403\b/,
    /400\b/,
    /unauthorized/i,
    /forbidden/i,
    /invalid api key/i,
    /api key/i,
    /credential/i,
    /unknown provider/i,
    /unsupported/i,
    /bad request/i,
  ];

  return !nonRetriablePatterns.some((pattern) => pattern.test(errorMessage));
}

function computeBackoffDelay(policy: ResolvedRetryConfig, attempt: number): number {
  if (policy.backoffMs <= 0) return 0;
  return Math.min(
    policy.maxBackoffMs,
    Math.round(policy.backoffMs * Math.pow(policy.backoffMultiplier, Math.max(0, attempt - 1))),
  );
}

function mergeFlags(...flagLists: Array<readonly SearchResultFlag[]>): SearchResultFlag[] {
  return [...new Set(flagLists.flatMap((flags) => [...flags]))].sort();
}

type MergeCandidate = Omit<FusionMergedResult, "score" | "ranking">;

type ScoredMergeCandidate = MergeCandidate & {
  score: number;
  scoreBreakdown: FusionScoreBreakdown;
};

function mergedFlagPenalty(flags: readonly SearchResultFlag[]): number {
  let penalty = 0;
  if (flags.includes("sponsored")) penalty += 0.65;
  if (flags.includes("redirect-wrapper")) penalty += 0.1;
  if (flags.includes("community")) penalty += 0.08;
  if (flags.includes("video")) penalty += 0.08;
  if (flags.includes("tracking-stripped")) penalty += 0.02;
  return penalty;
}

function mergedSortOrder(sourceTierMode: SourceTierMode): string[] {
  return sourceTierMode === "off"
    ? [...MERGED_SORT_ORDER]
    : ["score:desc", "bestSourceTier:desc", "bestRank:asc", "providerCount:desc", "title:asc"];
}

function computeMergedScoreBreakdown(
  entry: MergeCandidate,
  sourceTierMode: SourceTierMode,
): FusionScoreBreakdown {
  const bestVariantScore = entry.variants.reduce((max, variant) => Math.max(max, variant.score), 0);
  const corroborationBonus = Math.max(0, entry.providerCount - 1) * 0.12;
  const bestRankBonus = Math.max(0, 0.35 - (entry.bestRank - 1) * 0.04);
  const tierAdjustment = sourceTierMergedAdjustment(entry.bestSourceTier, sourceTierMode);
  const flagPenalty = mergedFlagPenalty(entry.flags);

  return {
    bestVariantScore,
    corroborationBonus,
    bestRankBonus,
    tierAdjustment,
    flagPenalty,
    finalScore: Math.max(0.01, bestVariantScore + corroborationBonus + bestRankBonus + tierAdjustment - flagPenalty),
  };
}

function compareMergedCandidates(
  a: Pick<FusionMergedResult, "score" | "bestSourceTier" | "bestRank" | "providerCount" | "title">,
  b: Pick<FusionMergedResult, "score" | "bestSourceTier" | "bestRank" | "providerCount" | "title">,
  sourceTierMode: SourceTierMode,
): number {
  if (b.score !== a.score) return b.score - a.score;
  if (sourceTierMode !== "off") {
    const tierDelta = compareSourceTierDesc(a.bestSourceTier, b.bestSourceTier);
    if (tierDelta !== 0) return tierDelta;
  }
  if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
  if (b.providerCount !== a.providerCount) return b.providerCount - a.providerCount;
  return a.title.localeCompare(b.title);
}

function buildRankingExplanation(params: {
  rank: number;
  title: string;
  bestRank: number;
  bestSourceTier: FusionMergedResult["bestSourceTier"];
  providerCount: number;
  scoreBreakdown: FusionScoreBreakdown;
}): FusionMergedResult["ranking"] {
  return {
    strategy: MERGED_RANKING_STRATEGY,
    rank: params.rank,
    scoreBreakdown: params.scoreBreakdown,
    tieBreakers: {
      bestSourceTier: params.bestSourceTier,
      bestRank: params.bestRank,
      providerCount: params.providerCount,
      title: params.title,
    },
  };
}

function emptyRankingMeta(sourceTierMode: SourceTierMode): FusionRankingMeta {
  return {
    strategy: MERGED_RANKING_STRATEGY,
    sortOrder: mergedSortOrder(sourceTierMode),
    consideredCount: 0,
    returnedCount: 0,
    droppedCount: 0,
    dropped: [],
  };
}

function mergeResults(
  results: ProviderRunResult[],
  maxMergedResults: number,
  sourceTierMode: SourceTierMode,
): { results: FusionMergedResult[]; ranking: FusionRankingMeta } {
  const merged = new Map<string, MergeCandidate>();

  for (const provider of results) {
    for (const item of provider.results) {
      const existing = merged.get(item.canonicalUrl);
      if (!existing) {
        merged.set(item.canonicalUrl, {
          title: item.title,
          url: item.url,
          canonicalUrl: item.canonicalUrl,
          snippet: item.snippet,
          siteName: item.siteName,
          providers: [item.providerId],
          providerCount: 1,
          bestRank: item.rawRank,
          bestSourceTier: item.sourceTier,
          flags: [...item.flags],
          rankings: [
            {
              providerId: item.providerId,
              rawRank: item.rawRank,
              score: item.score,
              nativeScore: item.nativeScore,
              sourceType: item.sourceType,
              sourceTier: item.sourceTier,
              flags: [...item.flags],
            },
          ],
          variants: [item],
        });
        continue;
      }

      existing.variants.push(item);
      if (!existing.providers.includes(item.providerId)) {
        existing.providers.push(item.providerId);
      }
      existing.providerCount = existing.providers.length;
      existing.bestRank = Math.min(existing.bestRank, item.rawRank);
      existing.bestSourceTier = pickHigherSourceTier(existing.bestSourceTier, item.sourceTier);
      existing.flags = mergeFlags(existing.flags, item.flags);
      existing.rankings.push({
        providerId: item.providerId,
        rawRank: item.rawRank,
        score: item.score,
        nativeScore: item.nativeScore,
        sourceType: item.sourceType,
        sourceTier: item.sourceTier,
        flags: [...item.flags],
      });
      if ((!existing.snippet || existing.snippet.length < (item.snippet?.length ?? 0)) && item.snippet) {
        existing.snippet = item.snippet;
      }
      if (existing.title.length < item.title.length) {
        existing.title = item.title;
      }
      if (!existing.siteName && item.siteName) {
        existing.siteName = item.siteName;
      }
    }
  }

  const rankedCandidates: ScoredMergeCandidate[] = [...merged.values()]
    .map((entry) => {
      const normalized: MergeCandidate = {
        ...entry,
        providers: [...entry.providers].sort(),
        providerCount: entry.providers.length,
        flags: [...entry.flags].sort(),
        rankings: [...entry.rankings].sort((a, b) => {
          if (a.rawRank !== b.rawRank) return a.rawRank - b.rawRank;
          if (sourceTierMode !== "off") {
            const tierDelta = compareSourceTierDesc(a.sourceTier, b.sourceTier);
            if (tierDelta !== 0) return tierDelta;
          }
          return a.providerId.localeCompare(b.providerId);
        }),
        variants: [...entry.variants].sort((a, b) => {
          if (a.rawRank !== b.rawRank) return a.rawRank - b.rawRank;
          if (b.score !== a.score) return b.score - a.score;
          if (sourceTierMode !== "off") {
            const tierDelta = compareSourceTierDesc(a.sourceTier, b.sourceTier);
            if (tierDelta !== 0) return tierDelta;
          }
          return a.providerId.localeCompare(b.providerId);
        }),
      };
      const scoreBreakdown = computeMergedScoreBreakdown(normalized, sourceTierMode);

      return {
        ...normalized,
        score: scoreBreakdown.finalScore,
        scoreBreakdown,
      };
    })
    .sort((a, b) => compareMergedCandidates(a, b, sourceTierMode));

  const mergedResults: FusionMergedResult[] = rankedCandidates
    .slice(0, maxMergedResults)
    .map((entry, index) => {
      const { scoreBreakdown, ...base } = entry;
      return {
        ...base,
        ranking: buildRankingExplanation({
          rank: index + 1,
          title: base.title,
          bestRank: base.bestRank,
          bestSourceTier: base.bestSourceTier,
          providerCount: base.providerCount,
          scoreBreakdown,
        }),
      };
    });

  const dropped = rankedCandidates.slice(maxMergedResults).map((entry, index) => ({
    rank: maxMergedResults + index + 1,
    reason: "maxMergedResults" as const,
    title: entry.title,
    url: entry.url,
    canonicalUrl: entry.canonicalUrl,
    score: entry.score,
    bestRank: entry.bestRank,
    providerCount: entry.providerCount,
  }));

  return {
    results: mergedResults,
    ranking:
      rankedCandidates.length === 0
        ? emptyRankingMeta(sourceTierMode)
        : {
            strategy: MERGED_RANKING_STRATEGY,
            sortOrder: mergedSortOrder(sourceTierMode),
            consideredCount: rankedCandidates.length,
            returnedCount: mergedResults.length,
            droppedCount: dropped.length,
            dropped,
          },
  };
}

type CitationSupportStats = {
  count: number;
  providers: Set<string>;
};

function buildEvidenceTable(
  results: FusionMergedResult[],
  answers: ProviderAnswerDigest[],
): FusionEvidenceTable {
  const citationSupportByUrl = new Map<string, CitationSupportStats>();

  for (const answer of answers) {
    for (const citationUrl of answer.citations) {
      const canonicalCitationUrl = canonicalizeUrl(citationUrl);
      if (!canonicalCitationUrl) {
        continue;
      }

      const existing = citationSupportByUrl.get(canonicalCitationUrl);
      if (existing) {
        existing.count += 1;
        existing.providers.add(answer.providerId);
        continue;
      }

      citationSupportByUrl.set(canonicalCitationUrl, {
        count: 1,
        providers: new Set([answer.providerId]),
      });
    }
  }

  const rows: FusionEvidenceRow[] = results.map((result, index) => {
    const citationSupport = citationSupportByUrl.get(result.canonicalUrl);
    const citationProviders = citationSupport ? [...citationSupport.providers].sort() : [];

    return {
      rowId: result.canonicalUrl,
      rank: index + 1,
      title: result.title,
      url: result.url,
      canonicalUrl: result.canonicalUrl,
      siteName: result.siteName,
      snippet: result.snippet,
      providers: [...result.providers],
      providerCount: result.providerCount,
      bestRank: result.bestRank,
      score: result.score,
      flags: [...result.flags],
      answerCitationSupport: {
        count: citationSupport?.count ?? 0,
        providerCount: citationProviders.length,
        providers: citationProviders,
      },
      providerEvidence: result.variants.map((variant) => ({
        providerId: variant.providerId,
        rawRank: variant.rawRank,
        score: variant.score,
        nativeScore: variant.nativeScore,
        sourceType: variant.sourceType,
        snippet: variant.snippet,
        snippetSource: variant.snippetSource,
        flags: [...variant.flags],
      })),
    } satisfies FusionEvidenceRow;
  });

  return {
    version: 1,
    columns: EVIDENCE_TABLE_COLUMNS.map((column) => ({ ...column })),
    rowCount: rows.length,
    rows,
  };
}

async function runProvider(params: {
  runtime: SearchRuntime;
  config: unknown;
  brokerConfig: SearchFusionConfig;
  request: ProviderSelectionRequest;
  provider: ResolvedProvider;
  sourceTierMode: SourceTierMode;
}): Promise<ProviderRunResult> {
  const start = Date.now();
  const providerConfig = resolveRuntimeProviderConfig(
    params.request,
    params.brokerConfig,
    params.provider.id,
  );
  const retryPolicy = providerConfig.retry;
  const providerArgs = buildProviderArgs(params.request, params.brokerConfig, params.provider.id);
  const retryHistory: ProviderRunResult["retryHistory"] = [];
  let lastError: string | undefined;
  let lastRawPayload: Record<string, unknown> | undefined;

  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
    try {
      const response: { provider: string; result: Record<string, unknown> } = await withTimeout(
        params.runtime.webSearch.search({
          config: params.config,
          providerId: params.provider.id,
          args: providerArgs,
        }),
        providerConfig.timeoutMs,
        `Provider ${params.provider.id}`,
      );

      lastRawPayload = response.result;
      const normalized = normalizeProviderPayload({
        providerId: params.provider.id,
        payload: response.result,
        sourceTierMode: params.sourceTierMode,
      });

      if (normalized.error) {
        throw new Error(normalized.error);
      }

      const weightedResults = normalized.results.map((result) => ({
        ...result,
        score: applyProviderWeight(result.score, providerConfig.weight),
      }));

      return {
        providerId: params.provider.id,
        label: params.provider.label,
        configured: params.provider.configured,
        ok: true,
        tookMs: Date.now() - start,
        rawCount: normalized.results.length,
        attempts: attempt,
        rawPayload: response.result,
        results: weightedResults,
        discardedResults: normalized.discardedResults,
        answer: normalized.answer,
        retryHistory,
      };
    } catch (error) {
      lastError = asErrorMessage(error);
      const canRetry = attempt < retryPolicy.maxAttempts && shouldRetry(lastError);
      if (!canRetry) {
        return {
          providerId: params.provider.id,
          label: params.provider.label,
          configured: params.provider.configured,
          ok: false,
          tookMs: Date.now() - start,
          rawCount: 0,
          attempts: attempt,
          rawPayload: lastRawPayload,
          results: [],
          discardedResults: [],
          retryHistory,
          error: lastError,
        };
      }

      const delayMs = computeBackoffDelay(retryPolicy, attempt);
      retryHistory.push({ attempt, error: lastError, delayMs });
      await sleep(delayMs);
    }
  }

  return {
    providerId: params.provider.id,
    label: params.provider.label,
    configured: params.provider.configured,
    ok: false,
    tookMs: Date.now() - start,
    rawCount: 0,
    attempts: retryPolicy.maxAttempts,
    rawPayload: lastRawPayload,
    results: [],
    discardedResults: [],
    retryHistory,
    error: lastError ?? "Unknown error",
  };
}

export async function runSearchFusion(params: {
  runtime: SearchRuntime;
  config: unknown;
  pluginConfig: unknown;
  request: ProviderSelectionRequest;
}): Promise<FusionSearchPayload> {
  const brokerConfig = asConfig(params.pluginConfig);
  const sourceTierMode = coerceSourceTierMode(brokerConfig.sourceTierMode);
  const runtimeConfig = getRuntimeConfigSnapshot() ?? params.config;
  const availableProviders = discoverProviders({
    providers: params.runtime.webSearch.listProviders({ config: runtimeConfig }),
    config: runtimeConfig,
    selfId: SEARCH_FUSION_PROVIDER_ID,
  });
  const selectedProviders = resolveSelectedProviders({
    availableProviders,
    requestMode: params.request.mode,
    requestProviders: params.request.providers,
    requestIntent: params.request.intent,
    config: brokerConfig,
  });

  if (selectedProviders.length === 0) {
    return {
      query: params.request.query,
      provider: SEARCH_FUSION_PROVIDER_ID,
      tookMs: 0,
      count: 0,
      configuredProviders: availableProviders
        .filter((provider) => provider.configured)
        .map((provider) => provider.id),
      providersQueried: [],
      providersSucceeded: [],
      providersFailed: [],
      providerDetails: [],
      providerRuns: [],
      discardedResults: [],
      answers: [],
      results: [],
      ranking: emptyRankingMeta(sourceTierMode),
      evidenceTable: buildEvidenceTable([], []),
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: SEARCH_FUSION_PROVIDER_ID,
        aggregated: true,
      },
    };
  }

  const start = Date.now();
  const maxMergedResults = clamp(
    params.request.maxMergedResults ?? brokerConfig.maxMergedResults ?? DEFAULT_MAX_MERGED_RESULTS,
    1,
    50,
  );

  const providerRunTasks = selectedProviders.map((provider) => {
    const startedAt = Date.now();
    return {
      provider,
      startedAt,
      promise: runProvider({
        runtime: params.runtime,
        config: runtimeConfig,
        brokerConfig,
        request: params.request,
        provider,
        sourceTierMode,
      }).catch((error) => {
        const rejection: ProviderRunTaskRejection = {
          error,
          tookMs: Math.max(0, Date.now() - startedAt),
        };
        throw rejection;
      }),
    };
  });

  const providerRuns = (
    await Promise.allSettled(providerRunTasks.map((task) => task.promise))
  ).map((settled, index) => {
    if (settled.status === "fulfilled") {
      return settled.value;
    }

    const rejection = isProviderRunTaskRejection(settled.reason) ? settled.reason : undefined;
    return asUnhandledProviderFailure({
      provider: providerRunTasks[index].provider,
      tookMs: rejection?.tookMs ?? Math.max(0, Date.now() - providerRunTasks[index].startedAt),
      error: rejection?.error ?? settled.reason,
    });
  });

  const merged = mergeResults(providerRuns.filter((run) => run.ok), maxMergedResults, sourceTierMode);
  const mergedResults = merged.results;
  const discardedResults = providerRuns.flatMap((run) => run.discardedResults);
  const answers = providerRuns
    .map((run) => run.answer)
    .filter((answer): answer is NonNullable<ProviderRunResult["answer"]> => Boolean(answer));

  return {
    query: params.request.query,
    provider: SEARCH_FUSION_PROVIDER_ID,
    tookMs: Date.now() - start,
    count: mergedResults.length,
    configuredProviders: availableProviders.filter((provider) => provider.configured).map((provider) => provider.id),
    providersQueried: selectedProviders.map((provider) => provider.id),
    providersSucceeded: providerRuns.filter((run) => run.ok).map((run) => run.providerId),
    providersFailed: providerRuns
      .filter((run) => !run.ok && run.error)
      .map((run) => ({ provider: run.providerId, error: run.error ?? "Unknown error" })),
    providerDetails: providerRuns.map((run) => ({
      provider: run.providerId,
      ok: run.ok,
      tookMs: run.tookMs,
      rawCount: run.rawCount,
      discardedCount: run.discardedResults.length,
      attempts: run.attempts,
      configured: run.configured,
      error: run.error,
    })),
    providerRuns: providerRuns.map((run) => ({
      provider: run.providerId,
      ok: run.ok,
      tookMs: run.tookMs,
      rawCount: run.rawCount,
      discardedCount: run.discardedResults.length,
      attempts: run.attempts,
      configured: run.configured,
      error: run.error,
      answer: run.answer,
      results: run.results,
      discardedResults: run.discardedResults,
      rawPayload: run.rawPayload,
      retryHistory: run.retryHistory,
    })),
    discardedResults,
    answers,
    results: mergedResults,
    ranking: merged.ranking,
    evidenceTable: buildEvidenceTable(mergedResults, answers),
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: SEARCH_FUSION_PROVIDER_ID,
      aggregated: true,
    },
  };
}

export function renderFusionSummary(payload: FusionSearchPayload, includeFailures = false): string {
  const lines: string[] = [];
  lines.push(
    `Search broker ran ${payload.providersQueried.length} provider${payload.providersQueried.length === 1 ? "" : "s"} in ${payload.tookMs}ms.`,
  );

  if (payload.results.length > 0) {
    lines.push("");
    lines.push(`Merged results (${payload.results.length}):`);
    payload.results.forEach((result, index) => {
      lines.push(`${index + 1}. ${result.title}`);
      lines.push(`   ${result.url}`);
      lines.push(
        `   Providers: ${result.providers.join(", ")} • Best rank: #${result.bestRank} • Source tier: ${result.bestSourceTier}`,
      );
      if (result.flags.length > 0) {
        lines.push(`   Flags: ${result.flags.join(", ")}`);
      }
      if (result.snippet) {
        lines.push(`   ${result.snippet}`);
      }
    });
  } else {
    lines.push("");
    lines.push("No merged results.");
  }

  if (payload.discardedResults.length > 0) {
    lines.push("");
    lines.push(`Preserved ${payload.discardedResults.length} non-merged item${payload.discardedResults.length === 1 ? "" : "s"} as provenance evidence.`);
  }

  if (payload.answers.length > 0) {
    lines.push("");
    lines.push("Provider answer digests:");
    for (const answer of payload.answers) {
      lines.push(`- ${answer.providerId}: ${answer.summary}`);
    }
  }

  lines.push("");
  lines.push("Provider status:");
  for (const detail of payload.providerDetails) {
    if (!includeFailures && !detail.ok) {
      continue;
    }
    const attemptText = detail.attempts > 1 ? `, ${detail.attempts} attempts` : "";
    lines.push(
      `- ${detail.provider}: ${detail.ok ? `ok (${detail.rawCount} hits, ${detail.tookMs}ms${attemptText})` : `failed (${detail.tookMs}ms${attemptText})${detail.error ? ` — ${detail.error}` : ""}`}`,
    );
  }

  if (includeFailures && payload.providersFailed.length > 0) {
    lines.push("");
    lines.push("Failures:");
    for (const failure of payload.providersFailed) {
      lines.push(`- ${failure.provider}: ${failure.error}`);
    }
  }

  return lines.join("\n");
}
