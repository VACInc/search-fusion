import type {
  NormalizedSearchResult,
  ProviderAnswerCitation,
  ProviderAnswerDigest,
} from "./types.js";
import { canonicalizeUrl, cleanProviderText, resolveSiteName, truncate } from "./text.js";

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(obj: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function firstNumber(obj: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function titleFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

function mapResultArray(params: {
  items: unknown[];
  providerId: string;
  sourceType: "results" | "citations" | "sources";
  fallbackSnippet?: string;
}): NormalizedSearchResult[] {
  const mapped: Array<NormalizedSearchResult | null> = params.items.map((item, index) => {
    const stringItem = typeof item === "string" ? item.trim() : "";
    const obj = asObject(item);
    const url = stringItem || firstString(obj, ["url", "link", "href"]);
    if (!url) return null;

    const title = firstString(obj, ["title", "name", "headline", "label"]) ?? titleFromUrl(url);
    const providerSnippet = cleanProviderText(
      firstString(obj, ["description", "snippet", "content", "body", "text", "summary"]),
    );
    const snippet = providerSnippet || (params.fallbackSnippet ? truncate(params.fallbackSnippet) : undefined);
    const score =
      firstNumber(obj, ["score", "confidence", "relevance"]) ?? Math.max(0.1, 1 - index * 0.05);

    return {
      title,
      url,
      canonicalUrl: canonicalizeUrl(url),
      snippet,
      siteName: firstString(obj, ["siteName", "site", "domain"]) ?? resolveSiteName(url),
      providerId: params.providerId,
      score,
      rawRank: index + 1,
      sourceType: params.sourceType,
      snippetSource: providerSnippet ? "provider" : params.fallbackSnippet ? "answer-fallback" : undefined,
      rawItem: item,
    } satisfies NormalizedSearchResult;
  });

  return mapped.flatMap((result) => (result ? [result] : []));
}

function buildCitationDetails(citationsRaw: unknown[]): ProviderAnswerCitation[] {
  return citationsRaw.flatMap<ProviderAnswerCitation>((entry) => {
    if (typeof entry === "string") {
      const url = entry.trim();
      return url ? [{ url, raw: entry }] : [];
    }

    const obj = asObject(entry);
    const url = firstString(obj, ["url", "link", "href"]);
    if (!url) return [];

    return [
      {
        url,
        title: firstString(obj, ["title", "name", "headline", "label"]),
        raw: entry,
      } satisfies ProviderAnswerCitation,
    ];
  });
}

export function extractProviderAnswer(
  payload: Record<string, unknown>,
  providerId: string,
): ProviderAnswerDigest | undefined {
  const fullContent = cleanProviderText(payload.content ?? payload.answer);
  if (!fullContent) return undefined;

  const citationsRaw = Array.isArray(payload.citations) ? payload.citations : [];
  const citationDetails = buildCitationDetails(citationsRaw);

  return {
    providerId,
    summary: truncate(fullContent, 320),
    fullContent,
    summaryTruncated: fullContent.length > 320,
    citations: citationDetails.map((entry) => entry.url),
    citationDetails,
  };
}

export function normalizeProviderPayload(params: {
  providerId: string;
  payload: Record<string, unknown>;
}): {
  results: NormalizedSearchResult[];
  answer?: ProviderAnswerDigest;
  error?: string;
} {
  const payload = params.payload;
  const answer = extractProviderAnswer(payload, params.providerId);

  const resultArrays: NormalizedSearchResult[] = [];
  const topLevelResults = Array.isArray(payload.results) ? payload.results : [];
  if (topLevelResults.length > 0) {
    resultArrays.push(
      ...mapResultArray({
        items: topLevelResults,
        providerId: params.providerId,
        sourceType: "results",
        fallbackSnippet: answer?.fullContent,
      }),
    );
  }

  const topLevelSources = Array.isArray(payload.sources) ? payload.sources : [];
  if (topLevelSources.length > 0) {
    resultArrays.push(
      ...mapResultArray({
        items: topLevelSources,
        providerId: params.providerId,
        sourceType: "sources",
        fallbackSnippet: answer?.fullContent,
      }),
    );
  }

  const nestedWebResults = Array.isArray(asObject(payload.web)?.results)
    ? (asObject(payload.web)?.results as unknown[])
    : [];
  if (nestedWebResults.length > 0) {
    resultArrays.push(
      ...mapResultArray({
        items: nestedWebResults,
        providerId: params.providerId,
        sourceType: "results",
        fallbackSnippet: answer?.fullContent,
      }),
    );
  }

  const citations = Array.isArray(payload.citations) ? payload.citations : [];
  if (citations.length > 0) {
    resultArrays.push(
      ...mapResultArray({
        items: citations,
        providerId: params.providerId,
        sourceType: "citations",
        fallbackSnippet: answer?.fullContent,
      }),
    );
  }

  const errorParts = [payload.error, payload.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  const error =
    errorParts.length > 0 && resultArrays.length === 0 && !answer
      ? errorParts.join(": ")
      : undefined;

  return { results: resultArrays, answer, error };
}
