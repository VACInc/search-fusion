import test from "node:test";
import assert from "node:assert/strict";
import {
  BrokerCache,
  buildCacheKey,
  resolveCacheConfig,
} from "../src/broker-cache.js";
import type { FusionSearchPayload } from "../src/types.js";
import { runSearchFusion } from "../src/search-fusion.js";

// ---------------------------------------------------------------------------
// Minimal stub payload
// ---------------------------------------------------------------------------

function stubPayload(query = "test"): FusionSearchPayload {
  return {
    query,
    provider: "search-fusion",
    tookMs: 10,
    count: 1,
    configuredProviders: ["brave"],
    providersQueried: ["brave"],
    providersSucceeded: ["brave"],
    providersFailed: [],
    providerDetails: [{ provider: "brave", ok: true, tookMs: 10, rawCount: 1, attempts: 1, configured: true }],
    providerRuns: [
      {
        provider: "brave",
        ok: true,
        tookMs: 10,
        rawCount: 1,
        attempts: 1,
        configured: true,
        results: [
          {
            title: "OpenClaw Docs",
            url: "https://docs.openclaw.ai",
            originalUrl: "https://docs.openclaw.ai",
            canonicalUrl: "https://docs.openclaw.ai",
            providerId: "brave",
            score: 0.9,
            rawRank: 1,
            sourceType: "results",
            flags: [],
          },
        ],
        retryHistory: [],
      },
    ],
    answers: [],
    results: [
      {
        title: "OpenClaw Docs",
        url: "https://docs.openclaw.ai",
        canonicalUrl: "https://docs.openclaw.ai",
        providers: ["brave"],
        providerCount: 1,
        score: 0.9,
        bestRank: 1,
        flags: [],
        rankings: [{ providerId: "brave", rawRank: 1, score: 0.9, sourceType: "results", flags: [] }],
        variants: [],
      },
    ],
    externalContent: { untrusted: true, source: "web_search", provider: "search-fusion", aggregated: true },
  };
}

const cfg = resolveCacheConfig({ ttlSeconds: 60, maxEntries: 4 });

// ---------------------------------------------------------------------------
// buildCacheKey
// ---------------------------------------------------------------------------

test("buildCacheKey produces identical keys for semantically equal requests", () => {
  const key1 = buildCacheKey({ query: "openClaw" }, ["brave", "tavily"]);
  const key2 = buildCacheKey({ query: "  openclaw  " }, ["tavily", "brave"]);
  assert.equal(key1, key2, "key should be case/order-insensitive");
});

test("buildCacheKey differs when queries differ", () => {
  const k1 = buildCacheKey({ query: "openclaw" }, ["brave"]);
  const k2 = buildCacheKey({ query: "openCLAW beta" }, ["brave"]);
  assert.notEqual(k1, k2);
});

test("buildCacheKey differs when provider sets differ", () => {
  const k1 = buildCacheKey({ query: "openclaw" }, ["brave"]);
  const k2 = buildCacheKey({ query: "openclaw" }, ["brave", "tavily"]);
  assert.notEqual(k1, k2);
});

test("buildCacheKey differs when filter params differ", () => {
  const base = { query: "openclaw" };
  const k1 = buildCacheKey(base, ["brave"]);
  const k2 = buildCacheKey({ ...base, country: "us" }, ["brave"]);
  const k3 = buildCacheKey({ ...base, count: 5 }, ["brave"]);
  const k4 = buildCacheKey({ ...base, freshness: "week" }, ["brave"]);
  assert.notEqual(k1, k2, "country should affect key");
  assert.notEqual(k1, k3, "count should affect key");
  assert.notEqual(k1, k4, "freshness should affect key");
});

// ---------------------------------------------------------------------------
// resolveCacheConfig
// ---------------------------------------------------------------------------

test("resolveCacheConfig uses sensible defaults when config is undefined", () => {
  const resolved = resolveCacheConfig(undefined);
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.ttlMs, 30_000);
  assert.equal(resolved.maxEntries, 128);
});

test("resolveCacheConfig clamps ttlSeconds to [1, 600]", () => {
  assert.equal(resolveCacheConfig({ ttlSeconds: 0 }).ttlMs, 1_000);
  assert.equal(resolveCacheConfig({ ttlSeconds: 9999 }).ttlMs, 600_000);
  assert.equal(resolveCacheConfig({ ttlSeconds: 60 }).ttlMs, 60_000);
});

test("resolveCacheConfig clamps maxEntries to [1, 1024]", () => {
  assert.equal(resolveCacheConfig({ maxEntries: 0 }).maxEntries, 1);
  assert.equal(resolveCacheConfig({ maxEntries: 2000 }).maxEntries, 1024);
  assert.equal(resolveCacheConfig({ maxEntries: 50 }).maxEntries, 50);
});

test("resolveCacheConfig respects enabled: false", () => {
  assert.equal(resolveCacheConfig({ enabled: false }).enabled, false);
});

// ---------------------------------------------------------------------------
// BrokerCache basic behaviour
// ---------------------------------------------------------------------------

test("BrokerCache: miss on empty cache", () => {
  const cache = new BrokerCache();
  assert.equal(cache.get("any-key"), undefined);
  assert.equal(cache.stats().misses, 1);
  assert.equal(cache.stats().hits, 0);
});

test("BrokerCache: set and get within TTL", () => {
  const cache = new BrokerCache();
  const payload = stubPayload();
  cache.set("k1", payload, cfg);
  const result = cache.get("k1");
  assert.ok(result, "should get the stored payload");
  assert.equal(result?.query, "test");
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.stats().misses, 0);
});

test("BrokerCache: expired entry is evicted on get", () => {
  const cache = new BrokerCache();
  const payload = stubPayload();
  // Store with an immediate expiry by patching the internal entry.
  cache.set("k-exp", payload, resolveCacheConfig({ ttlSeconds: 600 }));
  // Force expiry by manipulating internal state via a subclass-style approach:
  // Re-insert with ttlMs = 0 which sets expiresAt = now, meaning already past.
  cache.set("k-exp", payload, resolveCacheConfig({ ttlSeconds: 1 }));
  // We need to wait 1 s or manipulate time. Use purgeExpired approach:
  // Directly verify that after TTL=1 the entry still exists, then test via
  // real elapsed time would be too slow. Instead test the eviction path by
  // checking that a very-short-TTL config + real wait works.
  // For unit speed, we test via purgeExpired with an obviously expired entry:
  const shortCfg = { enabled: true, ttlMs: 1, maxEntries: 128 };
  const cache2 = new BrokerCache();
  cache2.set("k2", payload, shortCfg);
  // Spin until the 1 ms TTL expires (should be essentially instant).
  const deadline = Date.now() + 200;
  while (Date.now() < deadline) {
    /* busy-wait briefly */
  }
  assert.equal(cache2.get("k2"), undefined, "expired entry should be a miss");
  assert.equal(cache2.stats().evictions, 1);
});

test("BrokerCache: purgeExpired removes stale entries", () => {
  const cache = new BrokerCache();
  const shortCfg = { enabled: true, ttlMs: 1, maxEntries: 128 };
  cache.set("a", stubPayload("a"), shortCfg);
  cache.set("b", stubPayload("b"), shortCfg);
  cache.set("c", stubPayload("c"), cfg); // long TTL, should survive

  const deadline = Date.now() + 200;
  while (Date.now() < deadline) {
    /* spin */
  }

  const purged = cache.purgeExpired();
  assert.equal(purged, 2, "a and b should be purged");
  assert.equal(cache.size, 1, "c should remain");
  assert.ok(cache.get("c"), "c should still be retrievable");
});

test("BrokerCache: clear removes all entries", () => {
  const cache = new BrokerCache();
  cache.set("x", stubPayload("x"), cfg);
  cache.set("y", stubPayload("y"), cfg);
  assert.equal(cache.size, 2);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get("x"), undefined);
});

test("BrokerCache: maxEntries evicts oldest on overflow", () => {
  const tinyConfig = resolveCacheConfig({ ttlSeconds: 60, maxEntries: 3 });
  const cache = new BrokerCache();
  cache.set("k1", stubPayload("q1"), tinyConfig);
  cache.set("k2", stubPayload("q2"), tinyConfig);
  cache.set("k3", stubPayload("q3"), tinyConfig);
  assert.equal(cache.size, 3);

  // Adding a fourth entry should evict k1 (the oldest).
  cache.set("k4", stubPayload("q4"), tinyConfig);
  assert.equal(cache.size, 3, "size must not exceed maxEntries");
  assert.equal(cache.get("k1"), undefined, "oldest entry should be evicted");
  assert.ok(cache.get("k4"), "newest entry should be present");
});

test("BrokerCache: re-setting an existing key updates without triggering eviction", () => {
  const tinyConfig = resolveCacheConfig({ ttlSeconds: 60, maxEntries: 2 });
  const cache = new BrokerCache();
  cache.set("k1", stubPayload("q1"), tinyConfig);
  cache.set("k2", stubPayload("q2"), tinyConfig);
  // Re-set k1 — should not evict k2.
  cache.set("k1", stubPayload("q1-updated"), tinyConfig);
  assert.equal(cache.size, 2);
  assert.ok(cache.get("k2"), "k2 should still be present");
  assert.equal(cache.get("k1")?.query, "q1-updated", "k1 should be updated");
});

test("BrokerCache: stats track hits, misses and evictions correctly", () => {
  const cache = new BrokerCache();
  cache.get("miss1");
  cache.get("miss2");
  cache.set("hit1", stubPayload(), cfg);
  cache.get("hit1");
  cache.get("miss3");

  const stats = cache.stats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 3);
  assert.equal(stats.size, 1);
});

// ---------------------------------------------------------------------------
// Integration: runSearchFusion honours cache config
// ---------------------------------------------------------------------------

function createRuntime(callCount: { n: number }) {
  return {
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
          id: "search-fusion",
          label: "Search Fusion",
          autoDetectOrder: 999,
          envVars: [],
          getConfiguredCredentialValue: () => "always-enabled",
          getCredentialValue: () => undefined,
        },
      ],
      search: async ({ providerId }: { providerId?: string }) => {
        callCount.n += 1;
        return {
          provider: providerId ?? "brave",
          result: {
            results: [{ title: "Result", url: `https://example.com/${callCount.n}` }],
          },
        };
      },
    },
  };
}

test("runSearchFusion serves identical request from cache on second call", async () => {
  const calls = { n: 0 };
  const runtime = createRuntime(calls);
  const sharedPluginConfig = {
    cache: { ttlSeconds: 60 },
  };

  const r1 = await runSearchFusion({
    runtime: runtime as never,
    config: {},
    pluginConfig: sharedPluginConfig,
    request: { query: "cache-integration-test", providers: ["brave"] },
  });

  const callsAfterFirst = calls.n;
  assert.equal(r1.cached, undefined, "first call should not be marked cached");

  const r2 = await runSearchFusion({
    runtime: runtime as never,
    config: {},
    pluginConfig: sharedPluginConfig,
    request: { query: "cache-integration-test", providers: ["brave"] },
  });

  assert.equal(calls.n, callsAfterFirst, "provider should not be called again for identical request");
  assert.equal(r2.cached, true, "second call should be marked as cached");
  assert.equal(r2.query, r1.query);
  assert.equal(r2.count, r1.count);
});

test("runSearchFusion bypasses cache when cache.enabled is false", async () => {
  const calls = { n: 0 };
  const runtime = createRuntime(calls);
  const disabledCacheConfig = { cache: { enabled: false } };

  await runSearchFusion({
    runtime: runtime as never,
    config: {},
    pluginConfig: disabledCacheConfig,
    request: { query: "no-cache-query", providers: ["brave"] },
  });
  const afterFirst = calls.n;

  await runSearchFusion({
    runtime: runtime as never,
    config: {},
    pluginConfig: disabledCacheConfig,
    request: { query: "no-cache-query", providers: ["brave"] },
  });

  assert.ok(calls.n > afterFirst, "provider should be called again when cache is disabled");
});

test("runSearchFusion does not cache a result when all providers failed", async () => {
  const calls = { n: 0 };
  const failRuntime = {
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
          id: "search-fusion",
          label: "Search Fusion",
          autoDetectOrder: 999,
          envVars: [],
          getConfiguredCredentialValue: () => "always-enabled",
          getCredentialValue: () => undefined,
        },
      ],
      search: async () => {
        calls.n += 1;
        throw new Error("all-fail");
      },
    },
  };

  const cfg2 = { cache: { ttlSeconds: 60 }, retry: { maxAttempts: 1 } };

  await runSearchFusion({
    runtime: failRuntime as never,
    config: {},
    pluginConfig: cfg2,
    request: { query: "failure-no-cache", providers: ["brave"] },
  });
  const afterFirst = calls.n;

  // Second call should still hit the provider (not a cached failure).
  await runSearchFusion({
    runtime: failRuntime as never,
    config: {},
    pluginConfig: cfg2,
    request: { query: "failure-no-cache", providers: ["brave"] },
  });

  assert.ok(calls.n > afterFirst, "failed result must not be cached");
});
