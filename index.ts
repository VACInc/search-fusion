import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getRuntimeConfigSnapshot, type OpenClawConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { discoverProviders } from "./src/provider-discovery.js";
import {
  ALL_PROVIDER_CAPABILITIES,
  filterByAnyCapability,
  filterByCapabilities,
  hasCapability,
  resolveProviderCapabilities,
  type ProviderCapability,
} from "./src/provider-capabilities.js";
import { renderFusionSummary, runSearchFusion } from "./src/search-fusion.js";
import type { ProviderSelectionRequest, RuntimeWebSearchProvider, SearchRuntime } from "./src/types.js";

// Re-export the capability taxonomy so consumers can import directly from the
// plugin entry point without knowing internal file structure.
export {
  ALL_PROVIDER_CAPABILITIES,
  filterByAnyCapability,
  filterByCapabilities,
  hasCapability,
  resolveProviderCapabilities,
};
export type { ProviderCapability };

const SearchFusionParameters = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    intent: Type.Optional(
      Type.Union(
        [
          Type.Literal("research"),
          Type.Literal("keyword"),
          Type.Literal("answer"),
          Type.Literal("news"),
          Type.Literal("local"),
        ],
        {
          description:
            "Optional intent hint that biases provider selection without overriding explicit providers or mode. " +
            "research: prefer answer/grounding providers (Gemini, Perplexity, Tavily). " +
            "keyword: prefer fast index-based providers (Brave, DuckDuckGo). " +
            "answer: prefer answer-style providers (Gemini, Grok, Perplexity). " +
            "news: prefer freshness-optimized providers. " +
            "local: prefer providers with local/map results.",
        },
      ),
    ),
    mode: Type.Optional(
      Type.String({ description: "Optional mode name. Uses configured modes, or built-in starter modes (fast, balanced, deep) when custom modes are not set." }),
    ),
    providers: Type.Optional(
      Type.Array(
        Type.String({ description: "Provider id, or use 'all' / '*' to fan out to every configured provider." }),
      ),
    ),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to request from each provider (1-10).",
        minimum: 1,
        maximum: 10,
      }),
    ),
    maxMergedResults: Type.Optional(
      Type.Number({
        description: "Maximum merged results returned after dedupe (1-50).",
        minimum: 1,
        maximum: 50,
      }),
    ),
    country: Type.Optional(Type.String({ description: "2-letter country code for region-specific results." })),
    language: Type.Optional(Type.String({ description: "ISO 639-1 language code for results." })),
    freshness: Type.Optional(Type.String({ description: "Time filter: day, week, month, or year." })),
    date_after: Type.Optional(Type.String({ description: "Only results published after this date (YYYY-MM-DD)." })),
    date_before: Type.Optional(Type.String({ description: "Only results published before this date (YYYY-MM-DD)." })),
    search_lang: Type.Optional(Type.String({ description: "Provider-specific search language code when supported." })),
    ui_lang: Type.Optional(Type.String({ description: "Locale code for UI elements when supported." })),
    includeFailures: Type.Optional(
      Type.Boolean({ description: "Include provider failures in the human-readable summary." }),
    ),
  },
  { additionalProperties: false },
);

type SearchFusionRequest = Static<typeof SearchFusionParameters>;

type SearchFusionPluginApi = Omit<OpenClawPluginApi, "runtime"> & {
  runtime: OpenClawPluginApi["runtime"] & SearchRuntime;
  pluginConfig?: Record<string, unknown>;
  registerWebSearchProvider?: (provider: SearchFusionWebSearchProvider) => void;
};

type SearchFusionWebSearchProvider = {
  id: string;
  label: string;
  hint?: string;
  credentialLabel?: string;
  envVars?: readonly string[];
  placeholder: string;
  signupUrl: string;
  docsUrl?: string;
  autoDetectOrder?: number;
  credentialPath: string;
  getCredentialValue: (searchConfig?: Record<string, unknown>) => unknown;
  setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) => void;
  getConfiguredCredentialValue?: (config?: unknown) => unknown;
  createTool: () => {
    description: string;
    parameters: unknown;
    execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
};

type ProviderListRequest = Static<typeof ProviderListParameters>;

type AgentToolJsonResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

function asJsonResult(payload: unknown): AgentToolJsonResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function resolveRuntimeConfigSnapshot(fallback: OpenClawConfig): OpenClawConfig {
  return getRuntimeConfigSnapshot() ?? fallback;
}

const ProviderListParameters = Type.Object(
  {
    onlyConfigured: Type.Optional(
      Type.Boolean({ description: "Return only providers with a configured credential." }),
    ),
  },
  { additionalProperties: false },
);

function createSearchFusionProvider(api: SearchFusionPluginApi): SearchFusionWebSearchProvider {
  return {
    id: "search-fusion",
    label: "Search Fusion",
    hint: "Fan out across configured web search providers in parallel and merge the results.",
    credentialLabel: "No credential required",
    envVars: [],
    placeholder: "",
    signupUrl: "https://github.com/VACInc/openclaw-search-fusion",
    docsUrl: "https://github.com/VACInc/openclaw-search-fusion#readme",
    autoDetectOrder: 999,
    credentialPath: "plugins.entries.search-fusion.config.__unused",
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    getConfiguredCredentialValue: () => "always-enabled",
    createTool: () => ({
      description:
        "Search across multiple configured web search providers in parallel, merge duplicate URLs, and preserve provider attribution.",
      parameters: SearchFusionParameters,
      execute: async (args) =>
        await runSearchFusion({
          runtime: api.runtime,
          config: resolveRuntimeConfigSnapshot(api.config),
          pluginConfig: api.pluginConfig,
          request: args as ProviderSelectionRequest,
        }),
    }),
  };
}

const plugin = {
  id: "search-fusion",
  name: "Search Fusion",
  description: "Federated web search fusion for OpenClaw.",
  register(api: OpenClawPluginApi) {
    const searchApi = api as SearchFusionPluginApi;
    searchApi.registerWebSearchProvider?.(createSearchFusionProvider(searchApi));

    api.registerTool({
      name: "search_fusion",
      label: "Search Fusion",
      description:
        "Search across multiple configured web search providers in parallel, merge duplicate URLs, and preserve provider attribution.",
      parameters: SearchFusionParameters,
      async execute(_id: string, params: SearchFusionRequest) {
        const payload = await runSearchFusion({
          runtime: searchApi.runtime,
          config: resolveRuntimeConfigSnapshot(searchApi.config),
          pluginConfig: searchApi.pluginConfig,
          request: params as SearchFusionRequest,
        });

        return asJsonResult({
          summary: renderFusionSummary(payload, Boolean((params as { includeFailures?: boolean }).includeFailures)),
          payload,
        });
      },
    });

    api.registerTool({
      name: "search_fusion_providers",
      label: "Search Fusion Providers",
      description: "List the web search providers visible to Search Fusion and whether they appear configured.",
      parameters: ProviderListParameters,
      async execute(_id: string, params: ProviderListRequest) {
        const runtimeConfig = resolveRuntimeConfigSnapshot(searchApi.config);
        const providers = discoverProviders({
          providers: searchApi.runtime.webSearch.listProviders({
            config: runtimeConfig,
          }) as RuntimeWebSearchProvider[],
          config: runtimeConfig,
          selfId: "search-fusion",
        });
        const visibleProviders = params.onlyConfigured
          ? providers.filter((provider) => provider.configured)
          : providers;
        const lines = visibleProviders.map(
          (provider) =>
            `- ${provider.id}: ${provider.label}${provider.configured ? " [configured]" : " [not configured]"}${(provider.capabilities ?? []).length > 0 ? ` [${(provider.capabilities ?? []).join(", ")}]` : ""}${provider.hint ? ` — ${provider.hint}` : ""}`,
        );

        return asJsonResult({
          summary: lines.length > 0 ? lines.join("\n") : "No runtime web search providers discovered.",
          providers: visibleProviders,
        });
      },
    });
  },
};

export default plugin;
