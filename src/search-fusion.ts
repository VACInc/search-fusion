import type {
  FusionMergedResult,
  FusionPayloadConfidence,
  FusionResultConfidence,
  FusionSearchPayload,
  ProviderRunResult,
  ProviderSelectionRequest,
  ResolvedProvider,
  SearchFusionConfig,
  SearchFusionProviderConfig,
  SearchFusionRetryConfig,
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

type MergedEntry = Omit<FusionMergedResult, "score" | "confidence">;

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

function resolveDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function isResultLikeSource(sourceType: SearchResultSourceType): boolean {
  return sourceType === "results" || sourceType === "sources";
}

function deriveCorroborationLevel(params: {
  providerCount: number;
  domainCount: number;
  resultEvidenceCount: number;
}): FusionResultConfidence["corroborationLevel"] {
  if (params.providerCount >= 3 || (params.providerCount >= 2 && params.domainCount >= 2)) {
    return "high";
  }

  if (params.providerCount >= 2 || (params.domainCount >= 2 && params.resultEvidenceCount >= 2)) {
    return "medium";
  }

  return "low";
}

function deriveConfidenceLevel(score: number): FusionResultConfidence["confidenceLevel"] {
  if (score >= 0.72) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

function computeResultConfidence(entry: MergedEntry): FusionResultConfidence {
  const supportingDomains = [...new Set(entry.variants.map((variant) => resolveDomain(variant.canonicalUrl)).filter(Boolean))] as string[];
  const resultEvidenceCount = entry.variants.filter((variant) => isResultLikeSource(variant.sourceType)).length;
  const citationEvidenceCount = entry.variants.filter((variant) => variant.sourceType === "citations").length;
  const answerFallbackCount = entry.variants.filter((variant) => variant.snippetSource === "answer-fallback").length;
  const synthesisHeavy =
    citationEvidenceCount > resultEvidenceCount ||
    (resultEvidenceCount === 0 && citationEvidenceCount > 0) ||
    (answerFallbackCount > 0 && resultEvidenceCount <= citationEvidenceCount);

  const providerSignal = Math.min(1, entry.providerCount / 3);
  const domainSignal = Math.min(1, supportingDomains.length / 3);
  const evidenceTotal = resultEvidenceCount + citationEvidenceCount;
  const evidenceQualitySignal =
    evidenceTotal > 0 ? (resultEvidenceCount + citationEvidenceCount * 0.35) / evidenceTotal : 0;
  const rankSignal = Math.max(0, 1 - (entry.bestRank - 1) * 0.08);
  const confidenceScore = clamp(
    0.4 * providerSignal +
      0.25 * domainSignal +
      0.25 * evidenceQualitySignal +
      0.1 * rankSignal -
      (synthesisHeavy ? 0.15 : 0),
    0,
    1,
  );
  const corroborationLevel = deriveCorroborationLevel({
    providerCount: entry.providerCount,
    domainCount: supportingDomains.length,
    resultEvidenceCount,
  });

  const weakEvidenceReasonSet = new Set<FusionResultConfidence["weakEvidenceReasons"][number]>();
  if (entry.providerCount <= 1) {
    weakEvidenceReasonSet.add("single-provider");
  }
  if (entry.providerCount <= 1 && supportingDomains.length <= 1) {
    weakEvidenceReasonSet.add("single-provider-single-domain");
  }
  if (resultEvidenceCount === 0 && citationEvidenceCount > 0) {
    weakEvidenceReasonSet.add("citation-only");
  }
  if (synthesisHeavy) {
    weakEvidenceReasonSet.add("synthesis-heavy");
  }
  if (confidenceScore < 0.45) {
    weakEvidenceReasonSet.add("low-confidence-score");
  }

  const weakEvidenceReasons = [...weakEvidenceReasonSet].sort();

  return {
    supportingVariantCount: entry.variants.length,
    supportingProviderCount: entry.providerCount,
    supportingDomainCount: supportingDomains.length,
    resultEvidenceCount,
    citationEvidenceCount,
    answerFallbackCount,
    corroborationLevel,
    confidenceScore,
    confidenceLevel: deriveConfidenceLevel(confidenceScore),
    weakEvidence: weakEvidenceReasons.length > 0,
    synthesisHeavy,
    weakEvidenceReasons,
  };
}

function computeMergedScore(entry: MergedEntry): number {
  const bestVariantScore = entry.variants.reduce((max, variant) => Math.max(max, variant.score), 0);
  const corroborationBonus = Math.max(0, entry.providerCount - 1) * 0.12;
  const bestRankBonus = Math.max(0, 0.35 - (entry.bestRank - 1) * 0.04);
  return Math.max(0.01, bestVariantScore + corroborationBonus + bestRankBonus - mergedFlagPenalty(entry.flags));
}

function summarizePayloadConfidence(params: {
  selectedProviderCount: number;
  providerRuns: ProviderRunResult[];
  mergedResults: FusionMergedResult[];
}): FusionPayloadConfidence {
  const succeededProviderCount = params.providerRuns.filter((run) => run.ok).length;
  const failedProviderCount = params.providerRuns.length - succeededProviderCount;
  const multiProviderResultCount = params.mergedResults.filter(
    (result) => result.confidence.supportingProviderCount >= 2,
  ).length;
  const multiDomainResultCount = params.mergedResults.filter(
    (result) => result.confidence.supportingDomainCount >= 2,
  ).length;
  const lowCorroborationResultCount = params.mergedResults.filter(
    (result) => result.confidence.corroborationLevel === "low",
  ).length;
  const weakEvidenceResultCount = params.mergedResults.filter((result) => result.confidence.weakEvidence).length;
  const synthesisHeavyResultCount = params.mergedResults.filter(
    (result) => result.confidence.synthesisHeavy,
  ).length;

  const weakEvidence =
    params.mergedResults.length === 0
      ? succeededProviderCount <= 1
      : weakEvidenceResultCount > 0 || succeededProviderCount <= 1;

  return {
    queriedProviderCount: params.selectedProviderCount,
    succeededProviderCount,
    failedProviderCount,
    mergedResultCount: params.mergedResults.length,
    multiProviderResultCount,
    multiDomainResultCount,
    lowCorroborationResultCount,
    weakEvidenceResultCount,
    synthesisHeavyResultCount,
    weakEvidence,
  };
}

function mergeResults(results: ProviderRunResult[], maxMergedResults: number): FusionMergedResult[] {
  const merged = new Map<string, MergedEntry>();

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
      const normalizedEntry: MergedEntry = {
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

      return {
        ...normalizedEntry,
        confidence: computeResultConfidence(normalizedEntry),
        score: computeMergedScore(normalizedEntry),
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
      confidence: {
        queriedProviderCount: 0,
        succeededProviderCount: 0,
        failedProviderCount: 0,
        mergedResultCount: 0,
        multiProviderResultCount: 0,
        multiDomainResultCount: 0,
        lowCorroborationResultCount: 0,
        weakEvidenceResultCount: 0,
        synthesisHeavyResultCount: 0,
        weakEvidence: true,
      },
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
  const confidence = summarizePayloadConfidence({
    selectedProviderCount: selectedProviders.length,
    providerRuns,
    mergedResults,
  });

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
    confidence,
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
  lines.push(
    `Corroboration: ${payload.confidence.multiProviderResultCount}/${payload.confidence.mergedResultCount} multi-provider, ${payload.confidence.synthesisHeavyResultCount} synthesis-heavy, ${payload.confidence.weakEvidenceResultCount} weak-evidence results (${payload.confidence.weakEvidence ? "weak evidence detected" : "stable"}).`,
  );

  if (payload.results.length > 0) {
    lines.push("");
    lines.push(`Merged results (${payload.results.length}):`);
    payload.results.forEach((result, index) => {
      lines.push(`${index + 1}. ${result.title}`);
      lines.push(`   ${result.url}`);
      lines.push(`   Providers: ${result.providers.join(", ")} • Best rank: #${result.bestRank}`);
      lines.push(
        `   Confidence: ${result.confidence.confidenceLevel} (${Math.round(result.confidence.confidenceScore * 100)}%) • Corroboration: ${result.confidence.corroborationLevel} • Evidence: ${result.confidence.supportingProviderCount} provider(s), ${result.confidence.supportingDomainCount} domain(s), ${result.confidence.resultEvidenceCount} result-style, ${result.confidence.citationEvidenceCount} citation-derived`,
      );
      if (result.confidence.weakEvidenceReasons.length > 0) {
        lines.push(`   Weak-evidence signals: ${result.confidence.weakEvidenceReasons.join(", ")}`);
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
