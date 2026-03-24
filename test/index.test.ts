import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.js";

test("plugin registers provider and both tools", async () => {
  const tools: Array<{ name: string; execute: (_id: string, params: Record<string, unknown>) => Promise<unknown> }> = [];
  let provider: { id: string; createTool: () => { execute: (args: Record<string, unknown>) => Promise<unknown> } } | undefined;

  const api = {
    config: {},
    pluginConfig: { defaultProviders: ["brave", "gemini", "tavily"] },
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
    data?: { providers?: Array<{ id: string }> };
    details?: { providers?: Array<{ id: string }> };
  };
  const providerIds =
    providersResult.data?.providers?.map((item) => item.id) ??
    providersResult.details?.providers?.map((item) => item.id);
  assert.deepEqual(providerIds, ["brave", "gemini", "tavily"]);

  const fusionResult = (await fusionTool?.execute("2", { query: "test", count: 1 })) as {
    data?: { payload?: { provider?: string; providersQueried?: string[] } };
    details?: { payload?: { provider?: string; providersQueried?: string[] } };
  };
  const fusionPayload = fusionResult.data?.payload ?? fusionResult.details?.payload;
  assert.equal(fusionPayload?.provider, "search-fusion");
  assert.deepEqual(fusionPayload?.providersQueried, ["brave", "gemini", "tavily"]);

  const providerTool = provider?.createTool();
  const providerResult = (await providerTool?.execute({ query: "test" })) as {
    provider?: string;
  };
  assert.equal(providerResult?.provider, "search-fusion");
});
