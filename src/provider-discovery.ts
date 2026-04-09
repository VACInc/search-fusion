import type {
  ProviderCostTier,
  ResolvedProvider,
  RuntimeWebSearchProvider,
  SearchFusionConfig,
} from "./types.js";

const COST_TIER_ORDER: Record<ProviderCostTier, number> = {
  cheap: 0,
  standard: 1,
  premium: 2,
};

function asSearchConfig(config: unknown): Record<string, unknown> | undefined {
  const maybe = (config as { tools?: { web?: { search?: Record<string, unknown> } } } | undefined)?.tools?.web
    ?.search;
  return maybe && typeof maybe === "object" && !Array.isArray(maybe) ? maybe : undefined;
}

function hasValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return false;
}

function normalizeName(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function normalizeCostTier(value: string | undefined): ProviderCostTier | undefined {
  const normalized = normalizeName(value);
  if (normalized === "cheap" || normalized === "standard" || normalized === "premium") {
    return normalized;
  }
  return undefined;
}

function normalizeIdList(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function normalizeModes(modes: SearchFusionConfig["modes"]): Map<string, string[]> {
  const entries = Object.entries(modes ?? {});
  return new Map(
    entries
      .map(([name, providers]) => [normalizeName(name), normalizeIdList(providers)] as const)
      .filter((entry): entry is [string, string[]] => Boolean(entry[0])),
  );
}

function normalizeProviderCostTiers(
  providerCostTiers: SearchFusionConfig["providerCostTiers"],
): Map<string, ProviderCostTier> {
  const entries = Object.entries(providerCostTiers ?? {});
  return new Map(
    entries
      .map(([providerId, tier]) => [normalizeName(providerId), normalizeCostTier(tier)] as const)
      .filter((entry): entry is [string, ProviderCostTier] => Boolean(entry[0] && entry[1])),
  );
}

function resolveModeProviders(params: {
  mode: string;
  modes: Map<string, string[]>;
  byId: Map<string, ResolvedProvider>;
}): ResolvedProvider[] | undefined {
  const providerIds = params.modes.get(params.mode);
  if (!providerIds) return undefined;
  return providerIds
    .map((id) => params.byId.get(id))
    .filter((provider): provider is ResolvedProvider => Boolean(provider));
}

function applyCostAwareSelection(params: {
  selectedProviders: ResolvedProvider[];
  requestMaxCostTier?: ProviderCostTier;
  config: SearchFusionConfig;
}): ResolvedProvider[] {
  if (params.selectedProviders.length <= 1) {
    return params.selectedProviders;
  }

  const maxCostTier = normalizeCostTier(params.requestMaxCostTier ?? params.config.defaultMaxCostTier);
  if (!maxCostTier) {
    return params.selectedProviders;
  }

  const providerCostTiers = normalizeProviderCostTiers(params.config.providerCostTiers);
  const selectedWithCost = params.selectedProviders.map((provider, index) => {
    const normalizedId = normalizeName(provider.id) ?? provider.id;
    const tier = providerCostTiers.get(normalizedId) ?? "standard";
    return {
      provider,
      index,
      tier,
      tierRank: COST_TIER_ORDER[tier],
    };
  });

  const maxTierRank = COST_TIER_ORDER[maxCostTier];
  const withinBudget = selectedWithCost.filter((entry) => entry.tierRank <= maxTierRank);
  const cheapestTierRank = Math.min(...selectedWithCost.map((candidate) => candidate.tierRank));
  const constrainedPool =
    withinBudget.length > 0
      ? withinBudget
      : selectedWithCost.filter((entry) => entry.tierRank === cheapestTierRank);

  return [...constrainedPool]
    .sort((a, b) => {
      if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
      return a.index - b.index;
    })
    .map((entry) => entry.provider);
}

export function isProviderConfigured(provider: RuntimeWebSearchProvider, config: unknown): boolean {
  if (provider.requiresCredential === false) {
    return true;
  }

  try {
    if (hasValue(provider.getConfiguredCredentialValue?.(config))) {
      return true;
    }
  } catch {
    // ignore provider accessor errors
  }

  try {
    if (hasValue(provider.getCredentialValue?.(asSearchConfig(config)))) {
      return true;
    }
  } catch {
    // ignore provider accessor errors
  }

  for (const envVar of provider.envVars ?? []) {
    if (hasValue(process.env[envVar])) {
      return true;
    }
  }

  return false;
}

export function discoverProviders(params: {
  providers: RuntimeWebSearchProvider[];
  config: unknown;
  selfId: string;
}): ResolvedProvider[] {
  return params.providers
    .filter((provider) => provider.id !== params.selfId)
    .map((provider) => ({
      id: provider.id,
      label: provider.label,
      hint: provider.hint,
      autoDetectOrder: provider.autoDetectOrder,
      configured: isProviderConfigured(provider, params.config),
    }))
    .sort((a, b) => {
      const orderA = a.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return a.id.localeCompare(b.id);
    });
}

export function resolveSelectedProviders(params: {
  availableProviders: ResolvedProvider[];
  requestMode?: string;
  requestProviders?: string[];
  requestMaxCostTier?: ProviderCostTier;
  config: SearchFusionConfig;
}): ResolvedProvider[] {
  const finalizeSelection = (selectedProviders: ResolvedProvider[]): ResolvedProvider[] =>
    applyCostAwareSelection({
      selectedProviders,
      requestMaxCostTier: params.requestMaxCostTier,
      config: params.config,
    });

  const excluded = new Set(normalizeIdList(params.config.excludeProviders));
  const available = params.availableProviders.filter((provider) => !excluded.has(provider.id));
  const byId = new Map(available.map((provider) => [provider.id, provider]));
  const configured = available.filter((provider) => provider.configured);
  const requested = normalizeIdList(params.requestProviders);
  const requestMode = normalizeName(params.requestMode);
  const modes = normalizeModes(params.config.modes);

  const expandAll = requested.includes("all") || requested.includes("*");
  if (expandAll) {
    return finalizeSelection(configured.length > 0 ? configured : available);
  }

  if (requested.length > 0) {
    return finalizeSelection(
      requested.map((id) => byId.get(id)).filter((provider): provider is ResolvedProvider => Boolean(provider)),
    );
  }

  if (requestMode) {
    const selectedForMode = resolveModeProviders({ mode: requestMode, modes, byId });
    if (!selectedForMode) {
      throw new Error(`Unknown Search Fusion mode: ${params.requestMode}`);
    }
    if (selectedForMode.length === 0) {
      throw new Error(`Search Fusion mode \"${params.requestMode}\" resolved to no available providers.`);
    }
    return finalizeSelection(selectedForMode);
  }

  const defaultMode = normalizeName(params.config.defaultMode);
  if (defaultMode) {
    const selectedForDefaultMode = resolveModeProviders({ mode: defaultMode, modes, byId });
    if (selectedForDefaultMode && selectedForDefaultMode.length > 0) {
      return finalizeSelection(selectedForDefaultMode);
    }
  }

  const defaults = normalizeIdList(params.config.defaultProviders)
    .map((id) => byId.get(id))
    .filter((provider): provider is ResolvedProvider => Boolean(provider));
  if (defaults.length > 0) {
    return finalizeSelection(defaults);
  }

  return finalizeSelection(configured.length > 0 ? configured : available);
}
