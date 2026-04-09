import type { ResolvedProvider, RuntimeWebSearchProvider, SearchFusionConfig } from "./types.js";
import { resolveProviderCapabilities } from "./provider-capabilities.js";

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

function buildStarterModes(providers: ResolvedProvider[]): Map<string, string[]> {
  const providerIds = providers.map((provider) => provider.id);
  const starterEntries: Array<[string, string[]]> = [
    ["fast", providerIds.slice(0, 1)],
    ["balanced", providerIds.slice(0, 2)],
    ["deep", providerIds],
  ];

  return new Map(starterEntries.filter((entry) => entry[1].length > 0));
}

function resolveModes(params: {
  configuredProviders: ResolvedProvider[];
  availableProviders: ResolvedProvider[];
  configModes: SearchFusionConfig["modes"];
}): Map<string, string[]> {
  const customModes = normalizeModes(params.configModes);
  if (customModes.size > 0) {
    return customModes;
  }

  const pool = params.configuredProviders.length > 0
    ? params.configuredProviders
    : params.availableProviders;
  return buildStarterModes(pool);
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
      capabilities: [...resolveProviderCapabilities(provider.id)],
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
  config: SearchFusionConfig;
}): ResolvedProvider[] {
  const excluded = new Set(normalizeIdList(params.config.excludeProviders));
  const available = params.availableProviders.filter((provider) => !excluded.has(provider.id));
  const byId = new Map(available.map((provider) => [provider.id, provider]));
  const configured = available.filter((provider) => provider.configured);
  const requested = normalizeIdList(params.requestProviders);
  const requestMode = normalizeName(params.requestMode);
  const modes = resolveModes({
    configuredProviders: configured,
    availableProviders: available,
    configModes: params.config.modes,
  });

  const expandAll = requested.includes("all") || requested.includes("*");
  if (expandAll) {
    return configured.length > 0 ? configured : available;
  }

  if (requested.length > 0) {
    return requested.map((id) => byId.get(id)).filter((provider): provider is ResolvedProvider => Boolean(provider));
  }

  if (requestMode) {
    const selectedForMode = resolveModeProviders({ mode: requestMode, modes, byId });
    if (!selectedForMode) {
      throw new Error(`Unknown Search Fusion mode: ${params.requestMode}`);
    }
    if (selectedForMode.length === 0) {
      throw new Error(`Search Fusion mode \"${params.requestMode}\" resolved to no available providers.`);
    }
    return selectedForMode;
  }

  const defaultMode = normalizeName(params.config.defaultMode);
  if (defaultMode) {
    const selectedForDefaultMode = resolveModeProviders({ mode: defaultMode, modes, byId });
    if (selectedForDefaultMode && selectedForDefaultMode.length > 0) {
      return selectedForDefaultMode;
    }
  }

  const defaults = normalizeIdList(params.config.defaultProviders)
    .map((id) => byId.get(id))
    .filter((provider): provider is ResolvedProvider => Boolean(provider));
  if (defaults.length > 0) {
    return defaults;
  }

  return configured.length > 0 ? configured : available;
}
