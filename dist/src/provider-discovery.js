import { resolveProviderCapabilities } from "./provider-capabilities.js";
function asSearchConfig(config) {
    const maybe = config?.tools?.web
        ?.search;
    return maybe && typeof maybe === "object" && !Array.isArray(maybe) ? maybe : undefined;
}
function hasValue(value) {
    if (value == null)
        return false;
    if (typeof value === "string")
        return value.trim().length > 0;
    if (typeof value === "number" || typeof value === "boolean")
        return true;
    if (Array.isArray(value))
        return value.length > 0;
    if (typeof value === "object")
        return Object.keys(value).length > 0;
    return false;
}
function normalizeName(value) {
    const normalized = value?.trim().toLowerCase();
    return normalized ? normalized : undefined;
}
function normalizeIdList(values) {
    if (!Array.isArray(values))
        return [];
    return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}
function normalizeModes(modes) {
    const entries = Object.entries(modes ?? {});
    return new Map(entries
        .map(([name, providers]) => [normalizeName(name), normalizeIdList(providers)])
        .filter((entry) => Boolean(entry[0])));
}
function normalizeIntent(value) {
    const normalized = normalizeName(value);
    const valid = ["research", "keyword", "answer", "news", "local"];
    return valid.includes(normalized) ? normalized : undefined;
}
function buildStarterModes(providers) {
    const providerIds = providers.map((provider) => provider.id);
    const starterEntries = [
        ["fast", providerIds.slice(0, 1)],
        ["balanced", providerIds.slice(0, 2)],
        ["deep", providerIds],
    ];
    return new Map(starterEntries.filter((entry) => entry[1].length > 0));
}
function resolveModes(params) {
    const customModes = normalizeModes(params.configModes);
    if (customModes.size > 0) {
        return customModes;
    }
    const pool = params.configuredProviders.length > 0
        ? params.configuredProviders
        : params.availableProviders;
    return buildStarterModes(pool);
}
function resolveModeProviders(params) {
    const providerIds = params.modes.get(params.mode);
    if (!providerIds)
        return undefined;
    return providerIds
        .map((id) => params.byId.get(id))
        .filter((provider) => Boolean(provider));
}
function resolveIntentProviders(params) {
    const ids = params.intentMap[params.intent];
    if (!ids || ids.length === 0)
        return undefined;
    const normalized = normalizeIdList(ids);
    const providers = normalized
        .map((id) => params.byId.get(id))
        .filter((provider) => Boolean(provider));
    return providers.length > 0 ? providers : undefined;
}
export function isProviderConfigured(provider, config) {
    if (provider.requiresCredential === false) {
        return true;
    }
    try {
        if (hasValue(provider.getConfiguredCredentialValue?.(config))) {
            return true;
        }
    }
    catch {
        // ignore provider accessor errors
    }
    try {
        if (hasValue(provider.getCredentialValue?.(asSearchConfig(config)))) {
            return true;
        }
    }
    catch {
        // ignore provider accessor errors
    }
    for (const envVar of provider.envVars ?? []) {
        if (hasValue(process.env[envVar])) {
            return true;
        }
    }
    return false;
}
export function discoverProviders(params) {
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
        if (orderA !== orderB)
            return orderA - orderB;
        return a.id.localeCompare(b.id);
    });
}
export function resolveSelectedProviders(params) {
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
    // 1. Explicit provider list (including "all" / "*")
    const expandAll = requested.includes("all") || requested.includes("*");
    if (expandAll) {
        return configured.length > 0 ? configured : available;
    }
    if (requested.length > 0) {
        return requested.map((id) => byId.get(id)).filter((provider) => Boolean(provider));
    }
    // 2. Explicit mode
    if (requestMode) {
        const selectedForMode = resolveModeProviders({ mode: requestMode, modes, byId });
        if (!selectedForMode) {
            throw new Error(`Unknown Search Fusion mode: ${params.requestMode}`);
        }
        if (selectedForMode.length === 0) {
            throw new Error(`Search Fusion mode "${params.requestMode}" resolved to no available providers.`);
        }
        return selectedForMode;
    }
    // 3. Intent hint → intentProviders map
    const intent = normalizeIntent(typeof params.requestIntent === "string" ? params.requestIntent : undefined);
    if (intent && params.config.intentProviders) {
        const selectedForIntent = resolveIntentProviders({
            intent,
            intentMap: params.config.intentProviders,
            byId,
        });
        if (selectedForIntent && selectedForIntent.length > 0) {
            return selectedForIntent;
        }
    }
    // 4. Configured defaultMode
    const defaultMode = normalizeName(params.config.defaultMode);
    if (defaultMode) {
        const selectedForDefaultMode = resolveModeProviders({ mode: defaultMode, modes, byId });
        if (selectedForDefaultMode && selectedForDefaultMode.length > 0) {
            return selectedForDefaultMode;
        }
    }
    // 5. Legacy defaultProviders
    const defaults = normalizeIdList(params.config.defaultProviders)
        .map((id) => byId.get(id))
        .filter((provider) => Boolean(provider));
    if (defaults.length > 0) {
        return defaults;
    }
    // 6. All configured providers
    return configured.length > 0 ? configured : available;
}
