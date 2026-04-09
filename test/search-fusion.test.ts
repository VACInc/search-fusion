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
  assert.equal(mergedDocs?.bestSourceTier, "high");
  assert.deepEqual(mergedDocs?.flags, ["redirect-wrapper", "tracking-stripped"]);
  assert.equal(
    (mergedDocs?.variants.find((variant) => variant.providerId === "brave")?.rawItem as {
      metadata?: { provider?: string };
    })?.metadata?.provider,
    "brave",
  );

  assert.equal(payload.evidenceTable.version, 1);
  assert.equal(payload.evidenceTable.rowCount, payload.results.length);
  assert.deepEqual(payload.evidenceTable.columns.map((column) => column.key), [
    "rank",
    "title",
    "url",
    "providers",
    "providerCount",
    "bestRank",
    "score",
    "answerCitationCount",
    "flags",
  ]);
  const evidenceDocs = payload.evidenceTable.rows.find(
    (row) => row.canonicalUrl === "https://docs.openclaw.ai/tools/web",
  );
  assert.equal(evidenceDocs?.rank, 1);
  assert.deepEqual(evidenceDocs?.providers, ["brave", "duckduckgo", "tavily"]);
  assert.equal(evidenceDocs?.providerEvidence.length, 3);
  assert.equal(evidenceDocs?.answerCitationSupport.count, 0);

  assert.equal(payload.providersSucceeded.length, 3);
});


test("runSearchFusion keeps missing-url junk as non-merged provenance", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => ({
        provider: providerId ?? "brave",
        result: {
          results: [
            {
              title: "Knowledge panel",
              description: "No URL attached",
              kind: "infobox",
            },
            {
              title: "OpenClaw docs",
              url: "https://docs.openclaw.ai/tools/web",
              description: "Official docs",
            },
          ],
        },
      }),
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "openclaw web docs",
      providers: ["brave"],
    },
  });

  assert.deepEqual(payload.providersSucceeded, ["brave"]);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.discardedResults.length, 1);
  assert.equal(payload.discardedResults[0]?.reason, "missing-url");
  assert.equal(payload.providerRuns[0]?.discardedResults.length, 1);
  assert.equal(payload.providerDetails[0]?.discardedCount, 1);
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

test("runSearchFusion provides built-in starter modes when custom modes are absent", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "openclaw",
      mode: "balanced",
    },
  });

  assert.deepEqual(payload.providersQueried, ["brave", "gemini"]);
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

test("runSearchFusion treats custom modes as authoritative", async () => {
  await assert.rejects(
    async () =>
      await runSearchFusion({
        runtime: createRuntime() as never,
        config: {},
        pluginConfig: {
          modes: {
            custom: ["brave"],
          },
        },
        request: {
          query: "openclaw",
          mode: "balanced",
        },
      }),
    /Unknown Search Fusion mode: balanced/,
  );
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

  const docsEvidence = payload.evidenceTable.rows.find(
    (row) => row.canonicalUrl === "https://docs.openclaw.ai/tools/web",
  );
  const githubEvidence = payload.evidenceTable.rows.find(
    (row) => row.canonicalUrl === "https://github.com/openclaw/openclaw",
  );
  assert.equal(docsEvidence?.answerCitationSupport.count, 1);
  assert.deepEqual(docsEvidence?.answerCitationSupport.providers, ["gemini"]);
  assert.equal(githubEvidence?.answerCitationSupport.count, 1);
  assert.deepEqual(githubEvidence?.providerEvidence.map((entry) => entry.sourceType), ["citations"]);
});

test("runSearchFusion evidenceTable tracks citation counts and unique providers", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      providers: [
        { id: "gemini", label: "Gemini", configured: true, autoDetectOrder: 20 },
        { id: "kimi", label: "Kimi", configured: true, autoDetectOrder: 25 },
        { id: "search-fusion", label: "Search Fusion", configured: true, autoDetectOrder: 999 },
      ],
      search: async ({ providerId }) => {
        if (providerId === "gemini") {
          return {
            provider: "gemini",
            result: {
              content: "Gemini synthesis",
              citations: [
                "https://docs.openclaw.ai/tools/web",
                "https://docs.openclaw.ai/tools/web?utm_source=gemini",
              ],
            },
          };
        }

        return {
          provider: providerId ?? "kimi",
          result: {
            content: "Kimi synthesis",
            citations: ["https://docs.openclaw.ai/tools/web"],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "citation corroboration",
      providers: ["gemini", "kimi"],
    },
  });

  const docsEvidence = payload.evidenceTable.rows.find(
    (row) => row.canonicalUrl === "https://docs.openclaw.ai/tools/web",
  );

  assert.equal(docsEvidence?.answerCitationSupport.count, 3);
  assert.equal(docsEvidence?.answerCitationSupport.providerCount, 2);
  assert.deepEqual(docsEvidence?.answerCitationSupport.providers, ["gemini", "kimi"]);
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
  assert.equal(payload.results[0]?.bestSourceTier, "high");
  assert.deepEqual(payload.results[1]?.flags, ["sponsored"]);
  assert.equal(payload.results[1]?.bestSourceTier, "suppressed");
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

test("runSearchFusion applies provider weight multipliers to ranking scores", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => ({
        provider: providerId ?? "brave",
        result: {
          results: [
            {
              title: providerId === "brave" ? "Alpha source" : "Zulu source",
              url: providerId === "brave" ? "https://example.com/alpha" : "https://example.com/zulu",
              description: `${providerId} result`,
            },
          ],
        },
      }),
    }) as never,
    config: {},
    pluginConfig: {
      providerConfig: {
        brave: {
          weight: 0.5,
        },
        gemini: {
          weight: 1.5,
        },
      },
    },
    request: {
      query: "provider weighting",
      providers: ["brave", "gemini"],
    },
  });

  const braveRun = payload.providerRuns.find((run) => run.provider === "brave");
  const geminiRun = payload.providerRuns.find((run) => run.provider === "gemini");

  assert.equal(braveRun?.results[0]?.score, 0.54);
  assert.equal(geminiRun?.results[0]?.score, 1.62);
  assert.equal(payload.results[0]?.canonicalUrl, "https://example.com/zulu");
});

test("runSearchFusion clamps provider weight overrides to a safe range", async () => {
  const runtime = createRuntime({
    search: async ({ providerId }) => ({
      provider: providerId ?? "brave",
      result: {
        results: [{ title: "Seed result", url: `https://example.com/${providerId ?? "brave"}` }],
      },
    }),
  }) as never;

  const highWeightPayload = await runSearchFusion({
    runtime,
    config: {},
    pluginConfig: {
      providerConfig: {
        brave: {
          weight: 100,
        },
      },
    },
    request: {
      query: "high provider weight",
      providers: ["brave"],
    },
  });

  const lowWeightPayload = await runSearchFusion({
    runtime,
    config: {},
    pluginConfig: {
      providerConfig: {
        brave: {
          weight: 0,
        },
      },
    },
    request: {
      query: "low provider weight",
      providers: ["brave"],
    },
  });

  assert.equal(highWeightPayload.providerRuns[0]?.results[0]?.score, 5.4);
  assert.equal(lowWeightPayload.providerRuns[0]?.results[0]?.score, 0.108);
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


test("runSearchFusion isolates unexpected provider pipeline crashes", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => ({
        provider: providerId ?? "unknown",
        result: {
          results: [{ title: `${providerId} ok`, url: `https://example.com/${providerId}` }],
        },
      }),
    }) as never,
    config: {},
    pluginConfig: {
      retry: {
        maxAttempts: 1,
      },
      providerConfig: new Proxy({}, {
        get: (_target, prop) => {
          if (prop === "gemini") {
            throw new Error("gemini pipeline blew up");
          }
          return undefined;
        },
      }),
    },
    request: {
      query: "pipeline isolation",
      providers: ["brave", "gemini", "tavily"],
    },
  });

  assert.deepEqual(payload.providersSucceeded, ["brave", "tavily"]);
  assert.deepEqual(payload.providersFailed, [{ provider: "gemini", error: "gemini pipeline blew up" }]);
  assert.equal(payload.providerRuns.find((run) => run.provider === "gemini")?.ok, false);
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
});

test("runSearchFusion routes by intent hint when intentProviders is configured", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {
      intentProviders: {
        research: ["gemini", "tavily"],
        keyword: ["brave"],
      },
    },
    request: {
      query: "deep dive into openclaw plugin sdk",
      intent: "research",
    },
  });

  assert.deepEqual(payload.providersQueried, ["gemini", "tavily"]);
});

test("runSearchFusion intent does not override explicit providers", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {
      intentProviders: {
        keyword: ["brave"],
      },
    },
    request: {
      query: "explicit override test",
      providers: ["tavily"],
      intent: "keyword",
    },
  });

  assert.deepEqual(payload.providersQueried, ["tavily"]);
});

test("runSearchFusion intent does not override explicit mode", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {
      modes: {
        deep: ["gemini", "tavily"],
      },
      intentProviders: {
        keyword: ["brave"],
      },
    },
    request: {
      query: "mode wins over intent",
      mode: "deep",
      intent: "keyword",
    },
  });

  assert.deepEqual(payload.providersQueried, ["gemini", "tavily"]);
});

test("runSearchFusion falls through to defaults when intent maps to no available providers", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {
      intentProviders: {
        answer: ["perplexity"],
      },
      defaultProviders: ["brave"],
    },
    request: {
      query: "fallthrough when intent providers unavailable",
      intent: "answer",
    },
  });

  assert.deepEqual(payload.providersQueried, ["brave"]);
});

test("runSearchFusion sourceTierMode strict suppresses citation-first noise vs off", async () => {
  const sharedRuntime = createRuntime({
    search: async ({ providerId }) => {
      if (providerId === "gemini") {
        return {
          provider: "gemini",
          result: {
            results: [
              {
                title: "Official docs",
                url: "https://docs.openclaw.ai/tools/web",
                score: 0.3,
              },
            ],
            citations: [
              {
                title: "Citation-heavy blog",
                url: "https://example.com/citation-blog",
                score: 2,
              },
            ],
          },
        };
      }

      return {
        provider: providerId ?? "gemini",
        result: {
          results: [{ title: "Other", url: `https://example.com/${providerId}` }],
        },
      };
    },
  }) as never;

  const offPayload = await runSearchFusion({
    runtime: sharedRuntime,
    config: {},
    pluginConfig: {
      sourceTierMode: "off",
    },
    request: {
      query: "source tier off",
      providers: ["gemini"],
    },
  });

  const strictPayload = await runSearchFusion({
    runtime: sharedRuntime,
    config: {},
    pluginConfig: {
      sourceTierMode: "strict",
    },
    request: {
      query: "source tier strict",
      providers: ["gemini"],
    },
  });

  assert.equal(offPayload.results[0]?.canonicalUrl, "https://example.com/citation-blog");
  assert.equal(strictPayload.results[0]?.canonicalUrl, "https://docs.openclaw.ai/tools/web");
  assert.equal(strictPayload.results[1]?.bestSourceTier, "low");
});
