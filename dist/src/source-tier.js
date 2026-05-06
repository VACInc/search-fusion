const SOURCE_TIER_ORDER = {
    suppressed: 0,
    low: 1,
    standard: 2,
    high: 3,
};
export function coerceSourceTierMode(value) {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (normalized === "off" || normalized === "balanced" || normalized === "strict") {
        return normalized;
    }
    return "balanced";
}
export function sourceTierRank(tier) {
    return SOURCE_TIER_ORDER[tier] ?? SOURCE_TIER_ORDER.standard;
}
export function compareSourceTierDesc(a, b) {
    return sourceTierRank(b) - sourceTierRank(a);
}
export function pickHigherSourceTier(a, b) {
    return sourceTierRank(a) >= sourceTierRank(b) ? a : b;
}
export function classifySourceTier(params) {
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
export function sourceTierMultiplier(tier, mode) {
    if (mode === "off")
        return 1;
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
export function sourceTierMergedAdjustment(tier, mode) {
    if (mode === "off")
        return 0;
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
