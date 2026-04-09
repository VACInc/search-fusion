import type { ResolvedProvider, RuntimeWebSearchProvider, SearchFusionConfig, ProviderRoutingDecision, ProviderRunReason } from "./types.js";

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
  const modes = normalizeModes(params.config.modes);

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

/**
 * Like `resolveSelectedProviders`, but additionally returns a `ProviderRoutingDecision` for
 * every provider the broker is aware of — covering providers that ran as well as those that were
 * skipped, excluded, or self-guarded. The decisions are stable and machine-readable via the
 * `reason` field.
 *
 * Callers that only need the selected providers should continue to use `resolveSelectedProviders`.
 */
export function resolveSelectedProvidersWithReasons(params: {
  /** All providers discovered for this run (result of discoverProviders, i.e. self already excluded). */
  availableProviders: ResolvedProvider[];
  /** The full raw runtime provider list, used to record the self-exclusion decision. */
  selfId: string;
  requestMode?: string;
  requestProviders?: string[];
  config: SearchFusionConfig;
}): { selected: ResolvedProvider[]; decisions: ProviderRoutingDecision[] } {
  const excluded = new Set(normalizeIdList(params.config.excludeProviders));
  const available = params.availableProviders.filter((provider) => !excluded.has(provider.id));
  const byId = new Map(available.map((provider) => [provider.id, provider]));
  const configured = available.filter((provider) => provider.configured);
  const requested = normalizeIdList(params.requestProviders);
  const requestMode = normalizeName(params.requestMode);
  const modes = normalizeModes(params.config.modes);

  // Work out what the "run" set will be, same logic as resolveSelectedProviders.
  const expandAll = requested.includes("all") || requested.includes("*");

  let selected: ResolvedProvider[];
  let selectionContext:
    | { kind: "all-expand" }
    | { kind: "explicit"; ids: string[] }
    | { kind: "mode"; name: string }
    | { kind: "default-mode"; name: string }
    | { kind: "default-providers"; ids: string[] }
    | { kind: "auto" };

  if (expandAll) {
    selected = configured.length > 0 ? configured : available;
    selectionContext = { kind: "all-expand" };
  } else if (requested.length > 0) {
    selected = requested
      .map((id) => byId.get(id))
      .filter((p): p is ResolvedProvider => Boolean(p));
    selectionContext = { kind: "explicit", ids: requested };
  } else if (requestMode) {
    const selectedForMode = resolveModeProviders({ mode: requestMode, modes, byId });
    if (!selectedForMode) {
      throw new Error(`Unknown Search Fusion mode: ${params.requestMode}`);
    }
    if (selectedForMode.length === 0) {
      throw new Error(`Search Fusion mode "${params.requestMode}" resolved to no available providers.`);
    }
    selected = selectedForMode;
    selectionContext = { kind: "mode", name: requestMode };
  } else {
    const defaultMode = normalizeName(params.config.defaultMode);
    if (defaultMode) {
      const selectedForDefaultMode = resolveModeProviders({ mode: defaultMode, modes, byId });
      if (selectedForDefaultMode && selectedForDefaultMode.length > 0) {
        selected = selectedForDefaultMode;
        selectionContext = { kind: "default-mode", name: defaultMode };
      } else {
        // Default mode resolved to nothing; fall through to defaults / auto.
        const defaults = normalizeIdList(params.config.defaultProviders)
          .map((id) => byId.get(id))
          .filter((p): p is ResolvedProvider => Boolean(p));
        if (defaults.length > 0) {
          selected = defaults;
          selectionContext = { kind: "default-providers", ids: defaults.map((p) => p.id) };
        } else {
          selected = configured.length > 0 ? configured : available;
          selectionContext = { kind: "auto" };
        }
      }
    } else {
      const defaults = normalizeIdList(params.config.defaultProviders)
        .map((id) => byId.get(id))
        .filter((p): p is ResolvedProvider => Boolean(p));
      if (defaults.length > 0) {
        selected = defaults;
        selectionContext = { kind: "default-providers", ids: defaults.map((p) => p.id) };
      } else {
        selected = configured.length > 0 ? configured : available;
        selectionContext = { kind: "auto" };
      }
    }
  }

  const selectedIds = new Set(selected.map((p) => p.id));
  const decisions: ProviderRoutingDecision[] = [];

  // Self is not in availableProviders (discoverProviders already strips it),
  // so record its decision separately first.
  decisions.push({
    id: params.selfId,
    label: "Search Fusion",
    configured: true,
    reason: "skipped-is-self",
    detail: "Excluded from provider pool to prevent recursion.",
  });

  // Walk every provider that made it into the discovery pool.
  for (const provider of params.availableProviders) {
    let reason: ProviderRunReason;
    let detail: string | undefined;

    if (excluded.has(provider.id)) {
      reason = "skipped-excluded";
      detail = `In excludeProviders list.`;
    } else if (selectedIds.has(provider.id)) {
      reason = "ran";
      switch (selectionContext.kind) {
        case "all-expand":
          detail = "Selected because providers=[\"all\"] was requested.";
          break;
        case "explicit":
          detail = `Explicitly requested.`;
          break;
        case "mode":
          detail = `Selected by mode \"${selectionContext.name}\".`;
          break;
        case "default-mode":
          detail = `Selected by default mode \"${selectionContext.name}\".`;
          break;
        case "default-providers":
          detail = `Selected by defaultProviders config.`;
          break;
        case "auto":
          detail = `Selected automatically (configured providers fallback).`;
          break;
      }
    } else if (!provider.configured) {
      reason = "skipped-not-configured";
      detail = "No credential found for this provider.";
    } else {
      // Configured but not selected — excluded by mode / explicit list.
      switch (selectionContext.kind) {
        case "all-expand":
          reason = "skipped-all-expand";
          detail = "providers=[\"all\"] was requested but only configured providers were expanded and this one was not configured.";
          break;
        case "explicit":
          reason = "skipped-not-in-mode";
          detail = `Not in the explicit providers list: [${(selectionContext as { ids: string[] }).ids.join(", ")}].`;
          break;
        case "mode":
          reason = "skipped-not-in-mode";
          detail = `Not in mode \"${(selectionContext as { name: string }).name}\".`;
          break;
        case "default-mode":
          reason = "skipped-not-in-mode";
          detail = `Not in default mode \"${(selectionContext as { name: string }).name}\".`;
          break;
        case "default-providers":
          reason = "skipped-not-in-mode";
          detail = `Not in defaultProviders list.`;
          break;
        case "auto":
          // All configured providers were selected under auto, so this branch
          // would only fire for an unconfigured provider — handled above.
          reason = "skipped-not-configured";
          detail = "No credential found for this provider.";
          break;
      }
    }

    decisions.push({ id: provider.id, label: provider.label, configured: provider.configured, reason, detail });
  }

  // Also record providers that were explicitly requested but are not in the pool
  // (unknown id or excluded before the pool was built).
  if (selectionContext.kind === "explicit") {
    for (const id of (selectionContext as { ids: string[] }).ids) {
      if (!params.availableProviders.some((p) => p.id === id) && id !== params.selfId) {
        decisions.push({
          id,
          label: id,
          configured: false,
          reason: "skipped-not-in-mode",
          detail: `Provider id \"${id}\" was explicitly requested but is not registered with the runtime.`,
        });
      }
    }
  }

  return { selected, decisions };
}
