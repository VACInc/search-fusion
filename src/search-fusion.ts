import type {
  FusionMergedResult,
  FusionSearchPayload,
  ProviderRunResult,
  ProviderSelectionRequest,
  ResolvedProvider,
  SearchFusionConfig,
  SearchFusionProviderConfig,
  SearchFusionRetryConfig,
  SearchResultConsensusHint,
  SearchResultConsensusSignals,
  SearchResultFlag,
  SearchResultSourceType,
  SearchRuntime,
} from "./types.js";
import { discoverProviders, resolveSelectedProviders } from "./provider-discovery.js";
import { normalizeProviderPayload } from "./result-normalizer.js";

const DEFAULT_COUNT_PER_PROVIDER = 5;
const DEFAULT_MAX_MERGED_RESULTS = 10;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 750;
const DEFAULT_RETRY_BACKOFF_MULTIPLIER = 2;
const DEFAULT_RETRY_MAX_BACKOFF_MS = 5000;
const SEARCH_FUSION_PROVIDER_ID = "search-fusion";

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
};

function asConfig(pluginConfig: unknown): SearchFusionConfig {
  return pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig)
    ? (pluginConfig as SearchFusionConfig)
    : {};
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
  return error instanceof Error ? error.message : String(error);
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

function mergedFlagPenalty(flags: readonly SearchResultFlag[]): number {
  let penalty = 0;
  if (flags.includes("sponsored")) penalty += 0.65;
  if (flags.includes("redirect-wrapper")) penalty += 0.1;
  if (flags.includes("community")) penalty += 0.08;
  if (flags.includes("video")) penalty += 0.08;
  if (flags.includes("tracking-stripped")) penalty += 0.02;
  return penalty;
}

function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function buildEmptySourceTypeCountMap(): Record<SearchResultSourceType, number> {
  return {
    results: 0,
    sources: 0,
    citations: 0,
  };
}

function normalizeAgreementText(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1]! + sorted[middle]!) / 2;
  }
  return sorted[middle]!;
}

type MergedEntryWithoutScore = Omit<FusionMergedResult, "score" | "consensus">;

function buildConsensusSignals(entry: MergedEntryWithoutScore): SearchResultConsensusSignals {
  const sourceTypeMentionCounts = buildEmptySourceTypeCountMap();
  const sourceTypeProviderSets: Record<SearchResultSourceType, Set<string>> = {
    results: new Set<string>(),
    sources: new Set<string>(),
    citations: new Set<string>(),
  };

  const providerSupportMap = new Map<
    string,
    {
      providerId: string;
      bestRank: number;
      mentionCount: number;
      sourceTypes: Set<SearchResultSourceType>;
    }
  >();

  for (const ranking of entry.rankings) {
    sourceTypeMentionCounts[ranking.sourceType] += 1;
    sourceTypeProviderSets[ranking.sourceType].add(ranking.providerId);

    const existingSupport = providerSupportMap.get(ranking.providerId);
    if (!existingSupport) {
      providerSupportMap.set(ranking.providerId, {
        providerId: ranking.providerId,
        bestRank: ranking.rawRank,
        mentionCount: 1,
        sourceTypes: new Set<SearchResultSourceType>([ranking.sourceType]),
      });
      continue;
    }

    existingSupport.bestRank = Math.min(existingSupport.bestRank, ranking.rawRank);
    existingSupport.mentionCount += 1;
    existingSupport.sourceTypes.add(ranking.sourceType);
  }

  const providerSupport = [...providerSupportMap.values()]
    .map((support) => ({
      providerId: support.providerId,
      bestRank: support.bestRank,
      mentionCount: support.mentionCount,
      sourceTypes: [...support.sourceTypes].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => {
      if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
      return a.providerId.localeCompare(b.providerId);
    });

  const independentSupportCount = providerSupport.length;
  const rankValues = providerSupport.map((support) => support.bestRank);
  const bestRank = rankValues.length > 0 ? Math.min(...rankValues) : entry.bestRank;
  const worstRank = rankValues.length > 0 ? Math.max(...rankValues) : entry.bestRank;
  const rankSpread = worstRank - bestRank;
  const medianRank = rankValues.length > 0 ? computeMedian(rankValues) : entry.bestRank;
  const meanRank =
    rankValues.length > 0
      ? rankValues.reduce((sum, rank) => sum + rank, 0) / rankValues.length
      : entry.bestRank;

  const sourceTypeProviderCounts: Record<SearchResultSourceType, number> = {
    results: sourceTypeProviderSets.results.size,
    sources: sourceTypeProviderSets.sources.size,
    citations: sourceTypeProviderSets.citations.size,
  };

  const nonCitationMentions = sourceTypeMentionCounts.results + sourceTypeMentionCounts.sources;
  const totalMentions = entry.rankings.length;

  const supportComponent = Math.min(1, independentSupportCount / 4);
  const rankAgreementComponent = 1 / (1 + rankSpread / 2);
  const directEvidenceShare = totalMentions > 0 ? nonCitationMentions / totalMentions : 0;
  const evidenceComponent = 0.6 + directEvidenceShare * 0.4;
  const corroborationScore = round(
    clamp(supportComponent * 0.55 + rankAgreementComponent * 0.3 + evidenceComponent * 0.15, 0, 1),
    3,
  );

  const disagreementHints: SearchResultConsensusHint[] = [];
  if (independentSupportCount <= 1) {
    disagreementHints.push("single-provider-support");
  }
  if (independentSupportCount > 1 && rankSpread >= 3) {
    disagreementHints.push("rank-spread");
  }
  if (sourceTypeMentionCounts.citations > nonCitationMentions) {
    disagreementHints.push("citation-heavy");
  }

  const providerPreferredTitles = new Map<string, { rank: number; title: string }>();
  for (const variant of entry.variants) {
    const existingTitle = providerPreferredTitles.get(variant.providerId);
    if (
      !existingTitle ||
      variant.rawRank < existingTitle.rank ||
      (variant.rawRank === existingTitle.rank && variant.title.length > existingTitle.title.length)
    ) {
      providerPreferredTitles.set(variant.providerId, {
        rank: variant.rawRank,
        title: variant.title,
      });
    }
  }

  const normalizedTitles = new Set(
    [...providerPreferredTitles.values()]
      .map((entryTitle) => normalizeAgreementText(entryTitle.title))
      .filter((title) => title.length > 0),
  );
  if (independentSupportCount > 1 && normalizedTitles.size > 1) {
    disagreementHints.push("title-variance");
  }

  return {
    independentSupportCount,
    totalMentions,
    sourceTypeMentionCounts,
    sourceTypeProviderCounts,
    providerSupport,
    rankAgreement: {
      bestRank,
      worstRank,
      rankSpread,
      medianRank: round(medianRank, 2),
      meanRank: round(meanRank, 2),
    },
    corroborationScore,
    supportLabel:
      corroborationScore >= 0.72 ? "high" : corroborationScore >= 0.45 ? "medium" : "low",
    disagreementHints,
  };
}

function computeMergedScore(
  entry: MergedEntryWithoutScore,
  consensus: SearchResultConsensusSignals,
): number {
  const bestVariantScore = entry.variants.reduce((max, variant) => Math.max(max, variant.score), 0);
  const corroborationBonus = Math.max(0, consensus.independentSupportCount - 1) * 0.1;
  const rankAgreementBonus = Math.max(0, 0.2 - consensus.rankAgreement.rankSpread * 0.03);
  const confidenceBonus = consensus.corroborationScore * 0.08;
  const disagreementPenalty =
    (consensus.disagreementHints.includes("rank-spread") ? 0.06 : 0) +
    (consensus.disagreementHints.includes("citation-heavy") ? 0.04 : 0);

  return Math.max(
    0.01,
    bestVariantScore +
      corroborationBonus +
      rankAgreementBonus +
      confidenceBonus -
      mergedFlagPenalty(entry.flags) -
      disagreementPenalty,
  );
}

function mergeResults(results: ProviderRunResult[], maxMergedResults: number): FusionMergedResult[] {
  const merged = new Map<string, MergedEntryWithoutScore>();

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
          flags: [...item.flags],
          rankings: [
            {
              providerId: item.providerId,
              rawRank: item.rawRank,
              score: item.score,
              nativeScore: item.nativeScore,
              sourceType: item.sourceType,
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
      existing.flags = mergeFlags(existing.flags, item.flags);
      existing.rankings.push({
        providerId: item.providerId,
        rawRank: item.rawRank,
        score: item.score,
        nativeScore: item.nativeScore,
        sourceType: item.sourceType,
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

  return [...merged.values()]
    .map((entry) => {
      const normalizedEntry: MergedEntryWithoutScore = {
        ...entry,
        providers: [...entry.providers].sort(),
        providerCount: entry.providers.length,
        flags: [...entry.flags].sort(),
        rankings: [...entry.rankings].sort((a, b) => {
          if (a.rawRank !== b.rawRank) return a.rawRank - b.rawRank;
          return a.providerId.localeCompare(b.providerId);
        }),
        variants: [...entry.variants].sort((a, b) => {
          if (a.rawRank !== b.rawRank) return a.rawRank - b.rawRank;
          if (b.score !== a.score) return b.score - a.score;
          return a.providerId.localeCompare(b.providerId);
        }),
      };
      const consensus = buildConsensusSignals(normalizedEntry);

      return {
        ...normalizedEntry,
        consensus,
        score: computeMergedScore(normalizedEntry, consensus),
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
      if (b.providerCount !== a.providerCount) return b.providerCount - a.providerCount;
      return a.title.localeCompare(b.title);
    })
    .slice(0, maxMergedResults);
}

async function runProvider(params: {
  runtime: SearchRuntime;
  config: unknown;
  brokerConfig: SearchFusionConfig;
  request: ProviderSelectionRequest;
  provider: ResolvedProvider;
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
      });

      if (normalized.error) {
        throw new Error(normalized.error);
      }

      return {
        providerId: params.provider.id,
        label: params.provider.label,
        configured: params.provider.configured,
        ok: true,
        tookMs: Date.now() - start,
        rawCount: normalized.results.length,
        attempts: attempt,
        rawPayload: response.result,
        results: normalized.results,
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
  const availableProviders = discoverProviders({
    providers: params.runtime.webSearch.listProviders({ config: params.config }),
    config: params.config,
    selfId: SEARCH_FUSION_PROVIDER_ID,
  });
  const selectedProviders = resolveSelectedProviders({
    availableProviders,
    requestMode: params.request.mode,
    requestProviders: params.request.providers,
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
      answers: [],
      results: [],
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

  const providerRuns = await Promise.all(
    selectedProviders.map((provider) =>
      runProvider({
        runtime: params.runtime,
        config: params.config,
        brokerConfig,
        request: params.request,
        provider,
      }),
    ),
  );

  const mergedResults = mergeResults(providerRuns.filter((run) => run.ok), maxMergedResults);
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
      attempts: run.attempts,
      configured: run.configured,
      error: run.error,
    })),
    providerRuns: providerRuns.map((run) => ({
      provider: run.providerId,
      ok: run.ok,
      tookMs: run.tookMs,
      rawCount: run.rawCount,
      attempts: run.attempts,
      configured: run.configured,
      error: run.error,
      answer: run.answer,
      results: run.results,
      rawPayload: run.rawPayload,
      retryHistory: run.retryHistory,
    })),
    answers,
    results: mergedResults,
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
      lines.push(`   Providers: ${result.providers.join(", ")} • Best rank: #${result.bestRank}`);
      lines.push(
        `   Consensus: ${result.consensus.independentSupportCount} independent support • corroboration ${result.consensus.corroborationScore} (${result.consensus.supportLabel}) • rank spread ${result.consensus.rankAgreement.rankSpread}`,
      );
      if (result.consensus.disagreementHints.length > 0) {
        lines.push(`   Disagreement hints: ${result.consensus.disagreementHints.join(", ")}`);
      }
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
