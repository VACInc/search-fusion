import type { NormalizedSearchResult, ProviderAnswerDigest } from "./types.js";
import { canonicalizeUrl, cleanProviderText, resolveSiteName, truncate } from "./text.js";

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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

      const title =
        firstString(obj, ["title", "name", "headline", "label"]) ?? titleFromUrl(url);
      const snippet =
        cleanProviderText(
          firstString(obj, ["description", "snippet", "content", "body", "text", "summary"]),
        ) || (params.fallbackSnippet ? truncate(params.fallbackSnippet) : undefined);
      const score = firstNumber(obj, ["score", "confidence", "relevance"]) ?? Math.max(0.1, 1 - index * 0.05);

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
      } satisfies NormalizedSearchResult;
    });

  return mapped.flatMap((result) => (result ? [result] : []));
}

export function extractProviderAnswer(payload: Record<string, unknown>, providerId: string): ProviderAnswerDigest | undefined {
  const content = cleanProviderText(payload.content ?? payload.answer);
  if (!content) return undefined;

  const citationsRaw = Array.isArray(payload.citations) ? payload.citations : [];
  const citations = citationsRaw
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      const obj = asObject(entry);
      return firstString(obj, ["url", "link", "href"]);
    })
    .filter((entry): entry is string => Boolean(entry));

  return {
    providerId,
    summary: truncate(content, 320),
    citations,
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
        fallbackSnippet: answer?.summary,
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
        fallbackSnippet: answer?.summary,
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
        fallbackSnippet: answer?.summary,
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
        fallbackSnippet: answer?.summary,
      }),
    );
  }

  const errorParts = [payload.error, payload.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  const error = errorParts.length > 0 && resultArrays.length === 0 && !answer
    ? errorParts.join(": ")
    : undefined;

  return { results: resultArrays, answer, error };
}
