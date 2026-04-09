import test from "node:test";
import assert from "node:assert/strict";
import { runSearchFusion } from "../src/search-fusion.js";

function createRuntime(overrides?: {
  providers?: Array<{
    id: string;
    label: string;
    configured?: boolean;
    requiresCredential?: boolean;
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
      {
        id: "duckduckgo",
        label: "DuckDuckGo",
        configured: true,
        requiresCredential: false,
        autoDetectOrder: 100,
      },
      { id: "search-fusion", label: "Search Fusion", configured: true, autoDetectOrder: 999 },
    ];

  return {
    webSearch: {
      listProviders: () =>
        providers.map((provider) => ({
          id: provider.id,
          label: provider.label,
          autoDetectOrder: provider.autoDetectOrder,
          requiresCredential: provider.requiresCredential,
          envVars: [],
          getConfiguredCredentialValue: () =>
            provider.requiresCredential === false
              ? undefined
              : provider.configured
                ? `${provider.id}-key`
                : undefined,
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
                    metadata: { provider: "brave" },
                  },
                ],
              },
            };
          }

          if (providerId === "gemini") {
            return {
              provider: "gemini",
              result: {
                content:
                  "A grounded summary that is long enough to survive preservation checks without getting confused with the short snippet fallback.",
                citations: [
                  "https://docs.openclaw.ai/tools/web",
                  { url: "https://github.com/openclaw/openclaw", title: "GitHub" },
                ],
              },
            };
          }

          if (providerId === "duckduckgo") {
            return {
              provider: "duckduckgo",
              result: {
                results: [
                  {
                    title: "DuckDuckGo fallback docs",
                    url: "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.openclaw.ai%2Ftools%2Fweb%3Futm_source%3Dddg",
                    description: "Free-ish fallback search result",
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
                  metadata: { provider: "tavily" },
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

test("runSearchFusion merges duplicate URLs across providers and keeps provider variants", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "openclaw web docs",
      providers: ["brave", "tavily", "duckduckgo"],
    },
  });

  const mergedDocs = payload.results.find(
    (result) => result.canonicalUrl === "https://docs.openclaw.ai/tools/web",
  );

  assert.equal(payload.results.length, 2);
  assert.deepEqual(mergedDocs?.providers, ["brave", "duckduckgo", "tavily"]);
  assert.equal(mergedDocs?.bestRank, 1);
  assert.equal(mergedDocs?.variants.length, 3);
  assert.equal(mergedDocs?.rankings.length, 3);
  assert.deepEqual(mergedDocs?.flags, ["redirect-wrapper", "tracking-stripped"]);
  assert.equal(mergedDocs?.ranking.strategy, "merged-score-v1");
  assert.equal(mergedDocs?.ranking.rank, 1);
  assert.equal(mergedDocs?.ranking.scoreBreakdown.finalScore, mergedDocs?.score);
  assert.equal(mergedDocs?.ranking.tieBreakers.bestRank, mergedDocs?.bestRank);
  assert.equal(
    (mergedDocs?.variants.find((variant) => variant.providerId === "brave")?.rawItem as {
      metadata?: { provider?: string };
    })?.metadata?.provider,
    "brave",
  );
  assert.equal(payload.providersSucceeded.length, 3);
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

test("runSearchFusion honors explicit request mode", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {
      modes: {
        fast: ["brave"],
        deep: ["gemini", "tavily"],
      },
    },
    request: {
      query: "openclaw",
      mode: "deep",
    },
  });

  assert.deepEqual(payload.providersQueried, ["gemini", "tavily"]);
});

test("runSearchFusion falls back to all configured providers when no defaults or mode are set", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "openclaw",
    },
  });

  assert.deepEqual(payload.providersQueried, ["brave", "gemini", "tavily", "duckduckgo"]);
});

test("runSearchFusion includes empty ranking metadata when no providers are available", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      providers: [{ id: "search-fusion", label: "Search Fusion", configured: true, autoDetectOrder: 999 }],
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "openclaw",
    },
  });

  assert.equal(payload.results.length, 0);
  assert.equal(payload.ranking.strategy, "merged-score-v1");
  assert.deepEqual(payload.ranking.sortOrder, ["score:desc", "bestRank:asc", "providerCount:desc", "title:asc"]);
  assert.equal(payload.ranking.consideredCount, 0);
  assert.equal(payload.ranking.returnedCount, 0);
  assert.equal(payload.ranking.droppedCount, 0);
  assert.deepEqual(payload.ranking.dropped, []);
});

test("runSearchFusion throws on unknown explicit mode", async () => {
  await assert.rejects(
    async () =>
      await runSearchFusion({
        runtime: createRuntime() as never,
        config: {},
        pluginConfig: {
          modes: {
            fast: ["brave"],
          },
        },
        request: {
          query: "openclaw",
          mode: "chaos",
        },
      }),
    /Unknown Search Fusion mode: chaos/,
  );
});

test("runSearchFusion preserves full answer content and raw payloads for answer-style providers", async () => {
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
  assert.match(payload.answers[0]?.fullContent ?? "", /preservation checks/i);
  assert.equal(payload.answers[0]?.citationDetails[1]?.title, "GitHub");
  assert.ok(payload.results.some((result) => result.providers.includes("gemini")));
  assert.ok(payload.results.some((result) => result.providers.includes("tavily")));
  assert.match(String(payload.providerRuns[0]?.rawPayload?.content ?? ""), /grounded summary/i);
});

test("runSearchFusion ranks clean result-style hits ahead of sponsored noise", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        if (providerId === "brave") {
          return {
            provider: "brave",
            result: {
              results: [
                {
                  title: "Good docs",
                  url: "https://docs.openclaw.ai/tools/web",
                  description: "Official docs",
                },
                {
                  title: "Ad result",
                  url: "https://example.com/buy-now",
                  description: "sponsored",
                  sponsored: true,
                },
              ],
            },
          };
        }
        return {
          provider: providerId ?? "tavily",
          result: {
            results: [{ title: "Other", url: `https://example.com/${providerId}` }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "quality ordering",
      providers: ["brave"],
    },
  });

  assert.equal(payload.results[0]?.canonicalUrl, "https://docs.openclaw.ai/tools/web");
  assert.deepEqual(payload.results[1]?.flags, ["sponsored"]);
});

test("runSearchFusion treats keyless providers like DuckDuckGo as configured", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      providers: [
        {
          id: "duckduckgo",
          label: "DuckDuckGo",
          configured: true,
          requiresCredential: false,
          autoDetectOrder: 100,
        },
        { id: "search-fusion", label: "Search Fusion", configured: true, autoDetectOrder: 999 },
      ],
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "free fallback",
    },
  });

  assert.deepEqual(payload.configuredProviders, ["duckduckgo"]);
  assert.deepEqual(payload.providersQueried, ["duckduckgo"]);
  assert.deepEqual(payload.providersSucceeded, ["duckduckgo"]);
});

test("runSearchFusion retries transient failures with the default policy", async () => {
  let attempts = 0;
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        attempts += 1;
        if (providerId === "brave" && attempts < 3) {
          throw new Error("temporary upstream failure");
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
    pluginConfig: {
      retry: {
        backoffMs: 0,
      },
    },
    request: {
      query: "retry default",
      providers: ["brave"],
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(payload.providersSucceeded, ["brave"]);
  assert.equal(payload.providerRuns[0]?.attempts, 3);
  assert.equal(payload.providerRuns[0]?.retryHistory.length, 2);
});

test("runSearchFusion honors per-provider retry overrides", async () => {
  const counts = new Map<string, number>();
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        const key = providerId ?? "unknown";
        const current = (counts.get(key) ?? 0) + 1;
        counts.set(key, current);

        if (key === "brave" && current <= 2) {
          throw new Error("temporary brave failure");
        }
        if (key === "gemini" && current <= 3) {
          throw new Error("temporary gemini failure");
        }

        return {
          provider: key,
          result: {
            results: [{ title: `${key} ok`, url: `https://example.com/${key}` }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: {
        maxAttempts: 2,
        backoffMs: 0,
      },
      providerConfig: {
        gemini: {
          retry: {
            maxAttempts: 4,
            backoffMs: 0,
          },
        },
      },
    },
    request: {
      query: "retry override",
      providers: ["brave", "gemini"],
    },
  });

  assert.equal(counts.get("brave"), 2);
  assert.equal(counts.get("gemini"), 4);
  assert.deepEqual(payload.providersSucceeded, ["gemini"]);
  assert.deepEqual(payload.providersFailed, [{ provider: "brave", error: "temporary brave failure" }]);
  assert.equal(payload.providerRuns.find((run) => run.provider === "brave")?.attempts, 2);
  assert.equal(payload.providerRuns.find((run) => run.provider === "gemini")?.attempts, 4);
});

test("runSearchFusion passes providerConfig count overrides when request count is absent", async () => {
  let seenCount: unknown;
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId, args }) => {
        seenCount = args.count;
        return {
          provider: providerId ?? "gemini",
          result: {
            results: [{ title: "ok", url: `https://example.com/${providerId}` }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      countPerProvider: 5,
      providerConfig: {
        gemini: {
          count: 2,
        },
      },
    },
    request: {
      query: "provider count override",
      providers: ["gemini"],
    },
  });

  assert.equal(seenCount, 2);
  assert.deepEqual(payload.providersSucceeded, ["gemini"]);
});

test("runSearchFusion passes providerConfig timeout overrides", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        if (providerId === "gemini") {
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
        return {
          provider: providerId ?? "gemini",
          result: {
            results: [{ title: "ok", url: `https://example.com/${providerId}` }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      providerTimeoutMs: 1000,
      retry: {
        maxAttempts: 1,
      },
      providerConfig: {
        gemini: {
          timeoutMs: 2000,
        },
      },
    },
    request: {
      query: "provider timeout override",
      providers: ["gemini"],
    },
  });

  assert.deepEqual(payload.providersSucceeded, ["gemini"]);
});

test("runSearchFusion still honors legacy providerRetries overrides", async () => {
  let attempts = 0;
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        attempts += 1;
        if (attempts < 4) {
          throw new Error("temporary gemini failure");
        }
        return {
          provider: providerId ?? "gemini",
          result: {
            results: [{ title: "ok", url: `https://example.com/${providerId}` }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: {
        maxAttempts: 2,
        backoffMs: 0,
      },
      providerRetries: {
        gemini: {
          maxAttempts: 4,
          backoffMs: 0,
        },
      },
    },
    request: {
      query: "legacy retry override",
      providers: ["gemini"],
    },
  });

  assert.equal(attempts, 4);
  assert.deepEqual(payload.providersSucceeded, ["gemini"]);
  assert.equal(payload.providerRuns[0]?.attempts, 4);
});

test("runSearchFusion does not retry non-retriable auth errors", async () => {
  let attempts = 0;
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async () => {
        attempts += 1;
        throw new Error("401 Unauthorized: invalid API key");
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: {
        maxAttempts: 5,
        backoffMs: 0,
      },
    },
    request: {
      query: "auth failure",
      providers: ["gemini"],
    },
  });

  assert.equal(attempts, 1);
  assert.equal(payload.providerRuns[0]?.attempts, 1);
  assert.deepEqual(payload.providersFailed, [{ provider: "gemini", error: "401 Unauthorized: invalid API key" }]);
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
    pluginConfig: {
      retry: {
        maxAttempts: 1,
      },
    },
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
    pluginConfig: {
      providerTimeoutMs: 1000,
      retry: {
        maxAttempts: 1,
      },
    },
    request: {
      query: "timeout",
      providers: ["brave", "gemini"],
    },
  });

  assert.deepEqual(payload.providersSucceeded, ["brave"]);
  assert.equal(payload.providersFailed.length, 1);
  assert.match(payload.providersFailed[0]?.error ?? "", /timed out/i);
});

test("runSearchFusion honors request maxMergedResults without losing provider payloads", async () => {
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
  assert.equal(payload.providerRuns.length, 3);
  assert.ok(payload.providerRuns.every((run) => (run.ok ? Boolean(run.rawPayload) : true)));

  assert.equal(payload.ranking.strategy, "merged-score-v1");
  assert.deepEqual(payload.ranking.sortOrder, ["score:desc", "bestRank:asc", "providerCount:desc", "title:asc"]);
  assert.equal(payload.ranking.consideredCount, 3);
  assert.equal(payload.ranking.returnedCount, 2);
  assert.equal(payload.ranking.droppedCount, 1);
  assert.equal(payload.ranking.dropped[0]?.rank, 3);
  assert.equal(payload.ranking.dropped[0]?.reason, "maxMergedResults");
  assert.equal(payload.ranking.dropped[0]?.title, "GitHub");
  assert.equal(payload.ranking.dropped[0]?.url, "https://github.com/openclaw/openclaw");
  assert.equal(payload.ranking.dropped[0]?.canonicalUrl, "https://github.com/openclaw/openclaw");
  assert.equal(payload.ranking.dropped[0]?.bestRank, 2);
  assert.equal(payload.ranking.dropped[0]?.providerCount, 1);
  assert.ok(Math.abs((payload.ranking.dropped[0]?.score ?? 0) - 0.9724) < 0.0001);
  assert.deepEqual(
    payload.results.map((result) => result.ranking.rank),
    [1, 2],
  );
  assert.ok(payload.results.every((result) => result.ranking.scoreBreakdown.finalScore === result.score));
});
