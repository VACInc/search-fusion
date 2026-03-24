import test from "node:test";
import assert from "node:assert/strict";
import { runSearchFusion } from "../src/search-fusion.js";

function createRuntime(overrides?: {
  providers?: Array<{
    id: string;
    label: string;
    configured?: boolean;
    autoDetectOrder?: number;
  }>;
  search?: (params: { providerId?: string; args: Record<string, unknown> }) => Promise<{
    provider: string;
    result: Record<string, unknown>;
  }>;
}) {
  const providers =
    overrides?.providers ??
    [
      { id: "brave", label: "Brave", configured: true, autoDetectOrder: 10 },
      { id: "gemini", label: "Gemini", configured: true, autoDetectOrder: 20 },
      { id: "tavily", label: "Tavily", configured: true, autoDetectOrder: 30 },
      { id: "search-fusion", label: "Search Fusion", configured: true, autoDetectOrder: 999 },
    ];

  return {
    webSearch: {
      listProviders: () =>
        providers.map((provider) => ({
          id: provider.id,
          label: provider.label,
          autoDetectOrder: provider.autoDetectOrder,
          envVars: [],
          getConfiguredCredentialValue: () => (provider.configured ? `${provider.id}-key` : undefined),
          getCredentialValue: () => undefined,
        })),
      search:
        overrides?.search ??
        (async ({ providerId }) => {
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

          if (providerId === "gemini") {
            return {
              provider: "gemini",
              result: {
                content: "A grounded summary.",
                citations: [
                  "https://docs.openclaw.ai/tools/web",
                  { url: "https://github.com/openclaw/openclaw", title: "GitHub" },
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
                {
                  title: "Plugin SDK",
                  url: "https://docs.openclaw.ai/plugins/sdk",
                  description: "Plugin docs",
                },
              ],
            },
          };
        }),
    },
  };
}

test("runSearchFusion merges duplicate URLs across providers", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "openclaw web docs",
      providers: ["brave", "tavily"],
    },
  });

  const mergedDocs = payload.results.find(
    (result) => result.canonicalUrl === "https://docs.openclaw.ai/tools/web",
  );

  assert.equal(payload.results.length, 2);
  assert.deepEqual(mergedDocs?.providers, ["brave", "tavily"]);
  assert.equal(payload.providersSucceeded.length, 2);
});

test("runSearchFusion uses configured default providers and excludes itself", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {
      defaultProviders: ["brave", "gemini", "search-fusion"],
    },
    request: {
      query: "openclaw",
    },
  });

  assert.deepEqual(payload.providersQueried, ["brave", "gemini"]);
  assert.equal(payload.provider, "search-fusion");
});

test("runSearchFusion carries answer-style providers as digests and merged citation hits", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "openclaw grounding",
      providers: ["gemini", "tavily"],
    },
  });

  assert.equal(payload.answers.length, 1);
  assert.equal(payload.answers[0]?.providerId, "gemini");
  assert.match(payload.answers[0]?.summary ?? "", /grounded summary/i);
  assert.ok(payload.results.some((result) => result.providers.includes("gemini")));
  assert.ok(payload.results.some((result) => result.providers.includes("tavily")));
});

test("runSearchFusion tolerates provider failures and reports them", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        if (providerId === "gemini") {
          throw new Error("Gemini exploded");
        }
        return {
          provider: providerId ?? "brave",
          result: {
            results: [
              {
                title: `${providerId} result`,
                url: `https://example.com/${providerId}`,
                description: `from ${providerId}`,
              },
            ],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "partial failure",
      providers: ["brave", "gemini", "tavily"],
    },
  });

  assert.deepEqual(payload.providersSucceeded, ["brave", "tavily"]);
  assert.deepEqual(payload.providersFailed, [{ provider: "gemini", error: "Gemini exploded" }]);
  assert.equal(payload.results.length, 2);
});

test("runSearchFusion enforces per-provider timeouts", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        if (providerId === "gemini") {
          await new Promise((resolve) => setTimeout(resolve, 1100));
          return {
            provider: "gemini",
            result: {
              results: [{ title: "late", url: "https://example.com/late" }],
            },
          };
        }
        return {
          provider: providerId ?? "brave",
          result: {
            results: [{ title: "ok", url: `https://example.com/${providerId}` }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: { providerTimeoutMs: 1000 },
    request: {
      query: "timeout",
      providers: ["brave", "gemini"],
    },
  });

  assert.deepEqual(payload.providersSucceeded, ["brave"]);
  assert.equal(payload.providersFailed.length, 1);
  assert.match(payload.providersFailed[0]?.error ?? "", /timed out/i);
});

test("runSearchFusion honors request maxMergedResults", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: { maxMergedResults: 10 },
    request: {
      query: "openclaw",
      providers: ["brave", "gemini", "tavily"],
      maxMergedResults: 2,
    },
  });

  assert.equal(payload.results.length, 2);
});
