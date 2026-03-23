import type { ResolvedProvider, RuntimeWebSearchProvider, SearchBrokerConfig } from "./types.js";

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

export function isProviderConfigured(provider: RuntimeWebSearchProvider, config: unknown): boolean {
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

function normalizeIdList(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

export function resolveSelectedProviders(params: {
  availableProviders: ResolvedProvider[];
  requestProviders?: string[];
  config: SearchBrokerConfig;
}): ResolvedProvider[] {
  const excluded = new Set(normalizeIdList(params.config.excludeProviders));
  const available = params.availableProviders.filter((provider) => !excluded.has(provider.id));
  const byId = new Map(available.map((provider) => [provider.id, provider]));
  const configured = available.filter((provider) => provider.configured);
  const requested = normalizeIdList(params.requestProviders);

  const expandAll = requested.includes("all") || requested.includes("*");
  if (expandAll) {
    return configured.length > 0 ? configured : available;
  }

  if (requested.length > 0) {
    return requested.map((id) => byId.get(id)).filter((provider): provider is ResolvedProvider => Boolean(provider));
  }

  const defaults = normalizeIdList(params.config.defaultProviders)
    .map((id) => byId.get(id))
    .filter((provider): provider is ResolvedProvider => Boolean(provider));
  if (defaults.length > 0) {
    return defaults;
  }

  return configured.length > 0 ? configured : available;
}
