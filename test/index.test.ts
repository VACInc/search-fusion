import test from "node:test";
import assert from "node:assert/strict";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/config-runtime";
import plugin from "../index.js";

test("plugin registers provider and both tools", async () => {
  clearRuntimeConfigSnapshot();
  const tools: Array<{ name: string; execute: (_id: string, params: Record<string, unknown>) => Promise<unknown> }> = [];
  let provider: { id: string; createTool: () => { execute: (args: Record<string, unknown>) => Promise<unknown> } } | undefined;

  const api = {
    config: {},
    pluginConfig: {
      modes: {
        fast: ["brave"],
        deep: ["brave", "gemini", "tavily"],
      },
    },
    runtime: {
      webSearch: {
        listProviders: () => [
          {
            id: "brave",
            label: "Brave",
            autoDetectOrder: 10,
            envVars: [],
            getConfiguredCredentialValue: () => "brave-key",
            getCredentialValue: () => undefined,
          },
          {
            id: "gemini",
            label: "Gemini",
            autoDetectOrder: 20,
            envVars: [],
            getConfiguredCredentialValue: () => "gemini-key",
            getCredentialValue: () => undefined,
          },
          {
            id: "tavily",
            label: "Tavily",
            autoDetectOrder: 30,
            envVars: [],
            getConfiguredCredentialValue: () => "tavily-key",
            getCredentialValue: () => undefined,
          },
          {
            id: "search-fusion",
            label: "Search Fusion",
            autoDetectOrder: 999,
            envVars: [],
            getConfiguredCredentialValue: () => "always-enabled",
            getCredentialValue: () => undefined,
          },
        ],
        search: async ({ providerId }: { providerId?: string }) => ({
          provider: providerId ?? "brave",
          result: {
            results: [{ title: `${providerId} result`, url: `https://example.com/${providerId}` }],
          },
        }),
      },
    },
    registerTool(tool: (typeof tools)[number]) {
      tools.push(tool);
    },
    registerWebSearchProvider(entry: typeof provider) {
      provider = entry;
    },
  };

  plugin.register(api as never);

  assert.equal(provider?.id, "search-fusion");
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["search_fusion", "search_fusion_providers"],
  );

  const providerListTool = tools.find((tool) => tool.name === "search_fusion_providers");
  const fusionTool = tools.find((tool) => tool.name === "search_fusion");
  assert.ok(providerListTool);
  assert.ok(fusionTool);

  const providersResult = (await providerListTool?.execute("1", {})) as {
    providers?: Array<{ id: string }>;
    data?: { providers?: Array<{ id: string }> };
    details?: { providers?: Array<{ id: string }> };
  };
  const providerIds =
    providersResult.providers?.map((item) => item.id) ??
    providersResult.data?.providers?.map((item) => item.id) ??
    providersResult.details?.providers?.map((item) => item.id);
  assert.deepEqual(providerIds, ["brave", "gemini", "tavily"]);

  const fusionResult = (await fusionTool?.execute("2", { query: "test", mode: "fast", count: 1 })) as {
    payload?: {
      provider?: string;
      providersQueried?: string[];
      evidenceTable?: {
        rowCount?: number;
        rows?: Array<{ providerEvidence?: Array<{ providerId?: string }> }>;
      };
    };
    data?: {
      payload?: {
        provider?: string;
        providersQueried?: string[];
        evidenceTable?: {
          rowCount?: number;
          rows?: Array<{ providerEvidence?: Array<{ providerId?: string }> }>;
        };
      };
    };
    details?: {
      payload?: {
        provider?: string;
        providersQueried?: string[];
        evidenceTable?: {
          rowCount?: number;
          rows?: Array<{ providerEvidence?: Array<{ providerId?: string }> }>;
        };
      };
    };
  };
  const fusionPayload = fusionResult.payload ?? fusionResult.data?.payload ?? fusionResult.details?.payload;
  assert.equal(fusionPayload?.provider, "search-fusion");
  assert.deepEqual(fusionPayload?.providersQueried, ["brave"]);
  assert.equal(fusionPayload?.evidenceTable?.rowCount, 1);
  assert.equal(fusionPayload?.evidenceTable?.rows?.[0]?.providerEvidence?.[0]?.providerId, "brave");

  const providerTool = provider?.createTool();
  const providerResult = (await providerTool?.execute({ query: "test", mode: "deep" })) as {
    provider?: string;
    providersQueried?: string[];
  };
  assert.equal(providerResult?.provider, "search-fusion");
  assert.deepEqual(providerResult?.providersQueried, ["brave", "gemini", "tavily"]);
});

test("plugin tools prefer the active runtime config snapshot over raw plugin config", async () => {
  clearRuntimeConfigSnapshot();
  const rawConfig = {
    tools: { web: { search: { provider: "search-fusion" } } },
    plugins: {
      entries: {
        google: {
          config: {
            webSearch: {
              apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
            },
          },
        },
      },
    },
  };
  const runtimeConfig = {
    tools: { web: { search: { provider: "search-fusion" } } },
    plugins: {
      entries: {
        google: {
          config: {
            webSearch: {
              apiKey: "runtime-gemini-key",
            },
          },
        },
      },
    },
  };

  setRuntimeConfigSnapshot(runtimeConfig as never, rawConfig as never);

  try {
    const tools: Array<{ name: string; execute: (_id: string, params: Record<string, unknown>) => Promise<unknown> }> = [];
    let provider:
      | { id: string; createTool: () => { execute: (args: Record<string, unknown>) => Promise<unknown> } }
      | undefined;
    const seen: { listProvidersConfig?: unknown; searchConfigs: unknown[] } = { searchConfigs: [] };

    const api = {
      config: rawConfig,
      pluginConfig: {},
      runtime: {
        webSearch: {
          listProviders: ({ config }: { config?: unknown } = {}) => {
            seen.listProvidersConfig = config;
            return [
              {
                id: "gemini",
                label: "Gemini",
                autoDetectOrder: 20,
                envVars: [],
                getConfiguredCredentialValue: (cfg?: any) =>
                  cfg?.plugins?.entries?.google?.config?.webSearch?.apiKey,
                getCredentialValue: () => undefined,
              },
              {
                id: "search-fusion",
                label: "Search Fusion",
                autoDetectOrder: 999,
                envVars: [],
                getConfiguredCredentialValue: () => "always-enabled",
                getCredentialValue: () => undefined,
              },
            ];
          },
          search: async ({ config, providerId }: { config?: unknown; providerId?: string }) => {
            seen.searchConfigs.push(config);
            return {
              provider: providerId ?? "gemini",
              result: {
                content: "grounded answer",
                citations: ["https://docs.openclaw.ai/tools/web"],
              },
            };
          },
        },
      },
      registerTool(tool: (typeof tools)[number]) {
        tools.push(tool);
      },
      registerWebSearchProvider(entry: typeof provider) {
        provider = entry;
      },
    };

    plugin.register(api as never);

    const providerListTool = tools.find((tool) => tool.name === "search_fusion_providers");
    const fusionTool = tools.find((tool) => tool.name === "search_fusion");
    assert.ok(providerListTool);
    assert.ok(fusionTool);
    assert.ok(provider);

    const providersResult = (await providerListTool.execute("providers", {})) as {
      details?: {
        providers?: Array<{
          id: string;
          label: string;
          configured: boolean;
          autoDetectOrder?: number;
          capabilities?: string[];
        }>;
      };
    };
    assert.equal(seen.listProvidersConfig, runtimeConfig);
    assert.equal(providersResult.details?.providers?.length, 1);
    assert.equal(providersResult.details?.providers?.[0]?.id, "gemini");
    assert.equal(providersResult.details?.providers?.[0]?.label, "Gemini");
    assert.equal(providersResult.details?.providers?.[0]?.configured, true);
    assert.equal(providersResult.details?.providers?.[0]?.autoDetectOrder, 20);
    assert.deepEqual(providersResult.details?.providers?.[0]?.capabilities, ["answer", "results"]);

    await fusionTool.execute("fusion", { query: "openclaw", providers: ["gemini"] });
    const providerTool = provider.createTool();
    await providerTool.execute({ query: "openclaw", providers: ["gemini"] });

    assert.equal(seen.searchConfigs.length, 2);
    assert.ok(seen.searchConfigs.every((config) => config === runtimeConfig));
  } finally {
    clearRuntimeConfigSnapshot();
  }
});
