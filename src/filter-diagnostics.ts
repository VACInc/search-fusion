/**
 * Provider-specific filter diagnostics.
 *
 * Search Fusion passes every user-supplied filter arg to every provider.
 * Providers silently drop args they do not support. This module tracks which
 * args each known provider is expected to handle and emits structured
 * diagnostics when a request includes args that a provider is unlikely to
 * honour, so callers can see why results may not match their filters instead
 * of having them silently disappear.
 *
 * The registry is best-effort and intentionally conservative: a provider that
 * is NOT listed is treated as fully-unknown (no warnings emitted). A provider
 * listed here only warns for args that are explicitly unsupported — anything
 * outside the known set is treated as pass-through.
 */

/** All filter arg names that Search Fusion may forward to providers. */
export type FilterArgName =
  | "country"
  | "language"
  | "freshness"
  | "date_after"
  | "date_before"
  | "search_lang"
  | "ui_lang";

export const ALL_FILTER_ARG_NAMES: FilterArgName[] = [
  "country",
  "language",
  "freshness",
  "date_after",
  "date_before",
  "search_lang",
  "ui_lang",
];

/**
 * Support level for a single filter arg on a provider.
 *   supported  — provider accepts and applies this filter
 *   ignored    — provider receives the arg but does not act on it
 *   unsupported — provider does not accept this arg at all (may return error)
 *   degraded   — provider accepts the arg but its effect is partial / approximate
 */
export type FilterSupportLevel = "supported" | "ignored" | "unsupported" | "degraded";

export type ProviderFilterCapability = Partial<Record<FilterArgName, FilterSupportLevel>>;

/**
 * Registry of known provider filter capabilities.
 * Only providers listed here produce diagnostics; unknown providers are skipped.
 */
const PROVIDER_FILTER_REGISTRY: Record<string, ProviderFilterCapability> = {
  brave: {
    country: "supported",
    language: "supported",
    freshness: "supported",
    date_after: "supported",
    date_before: "supported",
    search_lang: "supported",
    ui_lang: "supported",
  },
  tavily: {
    country: "ignored",
    language: "ignored",
    freshness: "degraded", // maps to time_range but only coarse buckets
    date_after: "unsupported",
    date_before: "unsupported",
    search_lang: "ignored",
    ui_lang: "ignored",
  },
  duckduckgo: {
    country: "degraded", // region param exists but is not always respected
    language: "supported",
    freshness: "ignored",
    date_after: "unsupported",
    date_before: "unsupported",
    search_lang: "supported",
    ui_lang: "ignored",
  },
  gemini: {
    country: "ignored",
    language: "ignored",
    freshness: "ignored",
    date_after: "ignored",
    date_before: "ignored",
    search_lang: "ignored",
    ui_lang: "ignored",
  },
  grok: {
    country: "ignored",
    language: "ignored",
    freshness: "supported",
    date_after: "unsupported",
    date_before: "unsupported",
    search_lang: "ignored",
    ui_lang: "ignored",
  },
  kimi: {
    country: "ignored",
    language: "ignored",
    freshness: "ignored",
    date_after: "ignored",
    date_before: "ignored",
    search_lang: "ignored",
    ui_lang: "ignored",
  },
  perplexity: {
    country: "ignored",
    language: "ignored",
    freshness: "degraded",
    date_after: "unsupported",
    date_before: "unsupported",
    search_lang: "ignored",
    ui_lang: "ignored",
  },
  exa: {
    country: "ignored",
    language: "ignored",
    freshness: "ignored",
    date_after: "supported",
    date_before: "supported",
    search_lang: "ignored",
    ui_lang: "ignored",
  },
};

/** A single per-arg diagnostic entry for a provider run. */
export type FilterDiagnosticEntry = {
  /** Filter arg name forwarded to the provider. */
  arg: FilterArgName;
  /** Value that was sent. */
  sentValue: string;
  /** Support level for this arg on this provider. */
  level: FilterSupportLevel;
  /** Human-readable description of the issue. */
  message: string;
};

/** Aggregated filter diagnostics for one provider run. */
export type ProviderFilterDiagnostics = {
  /** Provider id. */
  providerId: string;
  /**
   * true when all requested filters are supported (or provider is unknown).
   * false when at least one filter is unsupported, ignored, or degraded.
   */
  filtersFullyApplied: boolean;
  /** Per-arg diagnostic entries (only populated for non-supported levels). */
  issues: FilterDiagnosticEntry[];
};

function describeIssue(arg: FilterArgName, level: FilterSupportLevel, providerId: string): string {
  switch (level) {
    case "unsupported":
      return `${providerId} does not support the "${arg}" filter — the argument is not accepted and will be dropped.`;
    case "ignored":
      return `${providerId} does not apply the "${arg}" filter — the argument is accepted but has no effect on results.`;
    case "degraded":
      return `${providerId} partially supports the "${arg}" filter — results may not match the requested value precisely.`;
    default:
      return "";
  }
}

/**
 * Given a provider id and the set of filter args that were sent, compute
 * structured diagnostics for any args that are unsupported, ignored, or degraded.
 *
 * Returns undefined when the provider is not in the registry (no information
 * available — diagnostics are suppressed to avoid false positives).
 */
export function computeFilterDiagnostics(params: {
  providerId: string;
  sentArgs: Partial<Record<FilterArgName, string | undefined>>;
}): ProviderFilterDiagnostics | undefined {
  const capabilities = PROVIDER_FILTER_REGISTRY[params.providerId];
  if (!capabilities) {
    return undefined;
  }

  const issues: FilterDiagnosticEntry[] = [];

  for (const arg of ALL_FILTER_ARG_NAMES) {
    const sentValue = params.sentArgs[arg];
    if (!sentValue) continue; // arg wasn't requested — nothing to diagnose

    const level = capabilities[arg];
    if (!level || level === "supported") continue; // known-good — skip

    issues.push({
      arg,
      sentValue,
      level,
      message: describeIssue(arg, level, params.providerId),
    });
  }

  return {
    providerId: params.providerId,
    filtersFullyApplied: issues.length === 0,
    issues,
  };
}

/** Format filter diagnostics as a short human-readable string. */
export function renderFilterDiagnostics(diag: ProviderFilterDiagnostics): string {
  if (diag.filtersFullyApplied) return "";
  const lines = diag.issues.map((issue) => `  [${issue.level}] ${issue.arg}=${JSON.stringify(issue.sentValue)}: ${issue.message}`);
  return lines.join("\n");
}
