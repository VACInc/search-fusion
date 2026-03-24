import type {
  FusionMergedResult,
  FusionSearchPayload,
  ProviderRunResult,
  ProviderSelectionRequest,
  ResolvedProvider,
  SearchFusionConfig,
  SearchRuntime,
} from "./types.js";
import { discoverProviders, resolveSelectedProviders } from "./provider-discovery.js";
import { normalizeProviderPayload } from "./result-normalizer.js";

const DEFAULT_COUNT_PER_PROVIDER = 5;
const DEFAULT_MAX_MERGED_RESULTS = 10;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15000;
const SEARCH_FUSION_PROVIDER_ID = "search-fusion";

function asConfig(pluginConfig: unknown): SearchFusionConfig {
  return pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig)
    ? (pluginConfig as SearchFusionConfig)
    : {};
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildProviderArgs(request: ProviderSelectionRequest, config: SearchFusionConfig): Record<string, unknown> {
  return {
    query: request.query,
    count: clamp(request.count ?? config.countPerProvider ?? DEFAULT_COUNT_PER_PROVIDER, 1, 10),
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

function mergeResults(results: ProviderRunResult[], maxMergedResults: number): FusionMergedResult[] {
  const merged = new Map<string, FusionMergedResult>();

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
          score: item.score,
        });
        continue;
      }

      if (!existing.providers.includes(item.providerId)) {
        existing.providers.push(item.providerId);
        existing.providerCount = existing.providers.length;
      }
      if ((!existing.snippet || existing.snippet.length < (item.snippet?.length ?? 0)) && item.snippet) {
        existing.snippet = item.snippet;
      }
      if (existing.title.length < item.title.length) {
        existing.title = item.title;
      }
      if (!existing.siteName && item.siteName) {
        existing.siteName = item.siteName;
      }
      existing.score = Math.max(existing.score, item.score) + (existing.providerCount - 1) * 0.1;
    }
  }

  return [...merged.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.providerCount !== a.providerCount) return b.providerCount - a.providerCount;
      return a.title.localeCompare(b.title);
    })
    .slice(0, maxMergedResults)
    .map((entry) => ({
      ...entry,
      providers: [...entry.providers].sort(),
      providerCount: entry.providers.length,
    }));
}

async function runProvider(params: {
  runtime: SearchRuntime;
  config: unknown;
  provider: ResolvedProvider;
  args: Record<string, unknown>;
  timeoutMs: number;
}): Promise<ProviderRunResult> {
  const start = Date.now();
  try {
    const response: { provider: string; result: Record<string, unknown> } = await withTimeout(
      params.runtime.webSearch.search({
        config: params.config,
        providerId: params.provider.id,
        args: params.args,
      }),
      params.timeoutMs,
      `Provider ${params.provider.id}`,
    );

    const normalized = normalizeProviderPayload({
      providerId: params.provider.id,
      payload: response.result,
    });

    return {
      providerId: params.provider.id,
      label: params.provider.label,
      configured: params.provider.configured,
      ok: !normalized.error,
      tookMs: Date.now() - start,
      rawCount: normalized.results.length,
      results: normalized.results,
      answer: normalized.answer,
      error: normalized.error,
    };
  } catch (error) {
    return {
      providerId: params.provider.id,
      label: params.provider.label,
      configured: params.provider.configured,
      ok: false,
      tookMs: Date.now() - start,
      rawCount: 0,
      results: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
      configuredProviders: availableProviders.filter((provider) => provider.configured).map((provider) => provider.id),
      providersQueried: [],
      providersSucceeded: [],
      providersFailed: [],
      providerDetails: [],
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
  const timeoutMs = clamp(
    brokerConfig.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
    1000,
    120000,
  );
  const maxMergedResults = clamp(
    params.request.maxMergedResults ?? brokerConfig.maxMergedResults ?? DEFAULT_MAX_MERGED_RESULTS,
    1,
    50,
  );
  const providerArgs = buildProviderArgs(params.request, brokerConfig);

  const providerRuns = await Promise.all(
    selectedProviders.map((provider) =>
      runProvider({
        runtime: params.runtime,
        config: params.config,
        provider,
        args: providerArgs,
        timeoutMs,
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
      configured: run.configured,
      error: run.error,
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
      lines.push(`   Providers: ${result.providers.join(", ")}`);
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
    lines.push(
      `- ${detail.provider}: ${detail.ok ? `ok (${detail.rawCount} hits, ${detail.tookMs}ms)` : `failed (${detail.tookMs}ms)${detail.error ? ` — ${detail.error}` : ""}`}`,
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
