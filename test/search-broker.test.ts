import test from "node:test";
import assert from "node:assert/strict";
import { runSearchBroker } from "../src/search-broker.js";

test("runSearchBroker merges duplicate URLs across providers", async () => {
  const runtime = {
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
          id: "tavily",
          label: "Tavily",
          autoDetectOrder: 20,
          envVars: [],
          getConfiguredCredentialValue: () => "tvly-key",
          getCredentialValue: () => undefined,
        },
        {
          id: "search-broker",
          label: "Search Broker",
          autoDetectOrder: 999,
          envVars: [],
          getConfiguredCredentialValue: () => "always-enabled",
          getCredentialValue: () => undefined,
        },
      ],
      search: async ({ providerId }: { providerId?: string }) => {
        if (providerId === "brave") {
          return {
            provider: "brave",
            result: {
              results: [
                {
                  title: "OpenClaw Docs",
                  url: "https://docs.openclaw.ai/tools/web?utm_source=brave",
                  description: "Provider one",
                },
              ],
            },
          };
        }

        return {
          provider: "tavily",
          result: {
            results: [
              {
                title: "OpenClaw Web Docs",
                url: "https://docs.openclaw.ai/tools/web",
                description: "Provider two has a longer snippet",
              },
            ],
          },
        };
      },
    },
  };

  const payload = await runSearchBroker({
    runtime: runtime as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "openclaw web docs",
    },
  });

  assert.equal(payload.results.length, 1);
  assert.deepEqual(payload.results[0]?.providers, ["brave", "tavily"]);
  assert.equal(payload.providersSucceeded.length, 2);
});
