import { Type, type Static } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk";
import { discoverProviders } from "./src/provider-discovery.js";
import { renderBrokerSummary, runSearchBroker } from "./src/search-broker.js";
import type { ProviderSelectionRequest, SearchRuntime } from "./src/types.js";

const SearchBrokerParameters = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
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

type SearchBrokerRequest = Static<typeof SearchBrokerParameters>;

type SearchBrokerPluginApi = Omit<OpenClawPluginApi, "runtime"> & {
  runtime: OpenClawPluginApi["runtime"] & SearchRuntime;
  pluginConfig?: Record<string, unknown>;
  registerWebSearchProvider?: (provider: SearchBrokerWebSearchProvider) => void;
};

type SearchBrokerWebSearchProvider = {
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

const ProviderListParameters = Type.Object(
  {
    onlyConfigured: Type.Optional(
      Type.Boolean({ description: "Return only providers with a configured credential." }),
    ),
  },
  { additionalProperties: false },
);

function createSearchBrokerProvider(api: SearchBrokerPluginApi): SearchBrokerWebSearchProvider {
  return {
    id: "search-broker",
    label: "Search Broker",
    hint: "Fan out across configured web search providers in parallel and merge the results.",
    credentialLabel: "No credential required",
    envVars: [],
    placeholder: "",
    signupUrl: "https://github.com/VACInc/openclaw-search-broker",
    docsUrl: "https://github.com/VACInc/openclaw-search-broker#readme",
    autoDetectOrder: 999,
    credentialPath: "plugins.entries.search-broker.config.__unused",
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    getConfiguredCredentialValue: () => "always-enabled",
    createTool: () => ({
      description:
        "Search across multiple configured web search providers in parallel, merge duplicate URLs, and preserve provider attribution.",
      parameters: SearchBrokerParameters,
      execute: async (args) =>
        await runSearchBroker({
          runtime: api.runtime,
          config: api.config,
          pluginConfig: api.pluginConfig,
          request: args as ProviderSelectionRequest,
        }),
    }),
  };
}

const plugin = {
  id: "search-broker",
  name: "Search Broker",
  description: "Federated web search broker for OpenClaw.",
  register(api: OpenClawPluginApi) {
    const searchApi = api as SearchBrokerPluginApi;
    searchApi.registerWebSearchProvider?.(createSearchBrokerProvider(searchApi));

    api.registerTool({
      name: "search_broker",
      label: "Search Broker",
      description:
        "Search across multiple configured web search providers in parallel, merge duplicate URLs, and preserve provider attribution.",
      parameters: SearchBrokerParameters,
      async execute(_id: string, params: SearchBrokerRequest) {
        const payload = await runSearchBroker({
          runtime: searchApi.runtime,
          config: searchApi.config,
          pluginConfig: searchApi.pluginConfig,
          request: params as SearchBrokerRequest,
        });

        return jsonResult({
          summary: renderBrokerSummary(payload, Boolean((params as { includeFailures?: boolean }).includeFailures)),
          payload,
        });
      },
    });

    api.registerTool({
      name: "search_broker_providers",
      label: "Search Broker Providers",
      description: "List the web search providers visible to Search Broker and whether they appear configured.",
      parameters: ProviderListParameters,
      async execute(_id: string, params: ProviderListRequest) {
        const providers = discoverProviders({
          providers: searchApi.runtime.webSearch.listProviders({ config: searchApi.config }),
          config: searchApi.config,
          selfId: "search-broker",
        });
        const visibleProviders = params.onlyConfigured
          ? providers.filter((provider) => provider.configured)
          : providers;
        const lines = visibleProviders.map(
          (provider) =>
            `- ${provider.id}: ${provider.label}${provider.configured ? " [configured]" : " [not configured]"}${provider.hint ? ` — ${provider.hint}` : ""}`,
        );

        return jsonResult({
          summary: lines.length > 0 ? lines.join("\n") : "No runtime web search providers discovered.",
          providers: visibleProviders,
        });
      },
    });
  },
};

export default plugin;
