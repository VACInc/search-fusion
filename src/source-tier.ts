import type {
  SearchResultFlag,
  SearchResultSourceTier,
  SearchResultSourceType,
  SourceTierMode,
} from "./types.js";

const SOURCE_TIER_ORDER: Record<SearchResultSourceTier, number> = {
  suppressed: 0,
  low: 1,
  standard: 2,
  high: 3,
};

export function coerceSourceTierMode(value: unknown): SourceTierMode {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "off" || normalized === "balanced" || normalized === "strict") {
    return normalized;
  }
  return "balanced";
}

export function sourceTierRank(tier: SearchResultSourceTier): number {
  return SOURCE_TIER_ORDER[tier] ?? SOURCE_TIER_ORDER.standard;
}

export function compareSourceTierDesc(a: SearchResultSourceTier, b: SearchResultSourceTier): number {
  return sourceTierRank(b) - sourceTierRank(a);
}

export function pickHigherSourceTier(
  a: SearchResultSourceTier,
  b: SearchResultSourceTier,
): SearchResultSourceTier {
  return sourceTierRank(a) >= sourceTierRank(b) ? a : b;
}

export function classifySourceTier(params: {
  sourceType: SearchResultSourceType;
  flags: readonly SearchResultFlag[];
}): SearchResultSourceTier {
  const { sourceType, flags } = params;

  if (flags.includes("sponsored")) {
    return "suppressed";
  }

  if (flags.includes("redirect-wrapper") || flags.includes("community") || flags.includes("video")) {
    return "low";
  }

  if (sourceType === "citations") {
    return "low";
  }

  if (sourceType === "sources") {
    return "standard";
  }

  return "high";
}

export function sourceTierMultiplier(tier: SearchResultSourceTier, mode: SourceTierMode): number {
  if (mode === "off") return 1;

  if (mode === "strict") {
    switch (tier) {
      case "high":
        return 1.12;
      case "standard":
        return 1;
      case "low":
        return 0.28;
      case "suppressed":
        return 0.12;
    }
  }

  switch (tier) {
    case "high":
      return 1.08;
    case "standard":
      return 1;
    case "low":
      return 0.45;
    case "suppressed":
      return 0.22;
  }
}

export function sourceTierMergedAdjustment(tier: SearchResultSourceTier, mode: SourceTierMode): number {
  if (mode === "off") return 0;

  if (mode === "strict") {
    switch (tier) {
      case "high":
        return 0.1;
      case "standard":
        return 0;
      case "low":
        return -0.24;
      case "suppressed":
        return -0.6;
    }
  }

  switch (tier) {
    case "high":
      return 0.06;
    case "standard":
      return 0;
    case "low":
      return -0.14;
    case "suppressed":
      return -0.4;
  }
}
