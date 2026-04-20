/**
 * Provider Capability Taxonomy
 *
 * A lightweight, enumerated model that describes what each known web-search
 * provider is good at.  It is deliberately narrow: the goal is to give future
 * routing logic a stable vocabulary to reason over rather than trying to rank
 * providers along every possible dimension.
 *
 * Design principles
 * -----------------
 * - Additive: adding a new capability never breaks existing code.
 * - Non-exclusive: a provider can (and usually does) have multiple capabilities.
 * - Declared, not detected: capabilities are statically registered per provider
 *   id, not inferred at runtime from credentials or payloads.
 * - Conservative: only include capabilities we have reasonable evidence for; an
 *   empty set is valid and means "general-purpose / unknown".
 *
 * How routing code can use this
 * ------------------------------
 * A mode like "answers" can select providers where `hasCapability(p, "answer")`
 * is true; a "news" mode can prefer providers with "news"; cost-aware routing
 * can prefer providers with "free-tier"; etc.
 *
 *   import { resolveProviderCapabilities, hasCapability } from "./provider-capabilities.js";
 *
 *   const caps = resolveProviderCapabilities("gemini");
 *   if (hasCapability(caps, "answer")) { ... }
 */

// ---------------------------------------------------------------------------
// Capability names
// ---------------------------------------------------------------------------

/**
 * The full set of recognised capability tags.
 *
 * - `"results"`       Provider returns a ranked list of URLs/snippets (classic
 *                     10-blue-links style).  Nearly every provider has this.
 * - `"answer"`        Provider synthesises a grounded prose answer in addition
 *                     to (or instead of) ranked links.  Examples: Gemini, Grok,
 *                     Perplexity Sonar, Kimi.
 * - `"news"`          Provider has a dedicated news index or freshness signal
 *                     that makes it materially better for recency-sensitive
 *                     queries.  Examples: Brave (news tab), Google Custom Search.
 * - `"images"`        Provider can return image results.
 * - `"video"`         Provider can return video results.
 * - `"local"`         Provider has strong local/maps intent handling.
 * - `"academic"`      Provider has indexed academic or scientific content.
 *                     Examples: Exa (with a domain filter), Semantic Scholar.
 * - `"code"`          Provider is particularly good at code / technical queries.
 * - `"neural"`        Provider uses neural / semantic retrieval rather than
 *                     (only) keyword matching.  Examples: Exa, Perplexity.
 * - `"free-tier"`     Provider is usable without a paid API key at a meaningful
 *                     call volume.  Examples: DuckDuckGo, SearXNG.
 * - `"privacy"`       Provider explicitly avoids user-level tracking.  Examples:
 *                     DuckDuckGo, Brave, SearXNG.
 */
export type ProviderCapability =
  | "results"
  | "answer"
  | "news"
  | "images"
  | "video"
  | "local"
  | "academic"
  | "code"
  | "neural"
  | "free-tier"
  | "privacy";

/** Immutable ordered list of all known capability tags (useful for validation). */
export const ALL_PROVIDER_CAPABILITIES: readonly ProviderCapability[] = [
  "results",
  "answer",
  "news",
  "images",
  "video",
  "local",
  "academic",
  "code",
  "neural",
  "free-tier",
  "privacy",
] as const;

// ---------------------------------------------------------------------------
// Per-provider capability registry
// ---------------------------------------------------------------------------

/**
 * Known capabilities for each provider id.
 *
 * Keys are lowercase provider ids as registered with the OpenClaw web search
 * runtime.  Values are sorted arrays of ProviderCapability.  Any provider id
 * NOT in this map is treated as having an empty capability set (i.e. completely
 * general-purpose).
 *
 * This is the single source of truth — keep it alphabetically sorted by key
 * to make diffs reviewable.
 */
const PROVIDER_CAPABILITY_REGISTRY: Readonly<Record<string, readonly ProviderCapability[]>> = {
  brave: ["news", "privacy", "results"],
  duckduckgo: ["free-tier", "privacy", "results"],
  exa: ["academic", "code", "neural", "results"],
  gemini: ["answer", "results"],
  google: ["images", "local", "news", "results", "video"],
  grok: ["answer", "news", "results"],
  kimi: ["answer", "results"],
  minimax: ["code", "results"],
  perplexity: ["answer", "neural", "results"],
  searxng: ["free-tier", "privacy", "results"],
  serper: ["images", "local", "news", "results", "video"],
  tavily: ["answer", "neural", "results"],
};

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Return the registered capability set for the given provider id, normalised
 * to lowercase.  Returns an empty array for unknown providers.
 */
export function resolveProviderCapabilities(providerId: string): readonly ProviderCapability[] {
  return PROVIDER_CAPABILITY_REGISTRY[providerId.toLowerCase()] ?? [];
}

/**
 * Check whether a capability set includes a particular capability.
 */
export function hasCapability(
  capabilities: readonly ProviderCapability[],
  capability: ProviderCapability,
): boolean {
  return capabilities.includes(capability);
}

/**
 * Return the subset of providers from `providerIds` that have ALL of the
 * requested capabilities.
 */
export function filterByCapabilities(
  providerIds: readonly string[],
  required: readonly ProviderCapability[],
): string[] {
  if (required.length === 0) return [...providerIds];
  return providerIds.filter((id) => {
    const caps = resolveProviderCapabilities(id);
    return required.every((cap) => caps.includes(cap));
  });
}

/**
 * Return the subset of providers from `providerIds` that have AT LEAST ONE of
 * the requested capabilities.
 */
export function filterByAnyCapability(
  providerIds: readonly string[],
  any: readonly ProviderCapability[],
): string[] {
  if (any.length === 0) return [...providerIds];
  return providerIds.filter((id) => {
    const caps = resolveProviderCapabilities(id);
    return any.some((cap) => caps.includes(cap));
  });
}
