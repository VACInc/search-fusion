import test from "node:test";
import assert from "node:assert/strict";
import {
  computeFilterDiagnostics,
  renderFilterDiagnostics,
  type FilterDiagnosticEntry,
} from "../src/filter-diagnostics.js";
import { runSearchFusion } from "../src/search-fusion.js";

// ---------------------------------------------------------------------------
// Unit tests: computeFilterDiagnostics
// ---------------------------------------------------------------------------

test("computeFilterDiagnostics returns undefined for unknown providers", () => {
  const result = computeFilterDiagnostics({
    providerId: "totally-unknown-provider",
    sentArgs: { country: "US", freshness: "week" },
  });
  assert.equal(result, undefined);
});

test("computeFilterDiagnostics returns filtersFullyApplied=true when no filter args sent", () => {
  const result = computeFilterDiagnostics({
    providerId: "brave",
    sentArgs: {},
  });
  assert.ok(result);
  assert.equal(result.filtersFullyApplied, true);
  assert.deepEqual(result.issues, []);
});

test("computeFilterDiagnostics returns no issues for brave (all filters supported)", () => {
  const result = computeFilterDiagnostics({
    providerId: "brave",
    sentArgs: {
      country: "US",
      language: "en",
      freshness: "week",
      date_after: "2024-01-01",
      date_before: "2024-12-31",
      search_lang: "en",
      ui_lang: "en",
    },
  });
  assert.ok(result);
  assert.equal(result.filtersFullyApplied, true);
  assert.deepEqual(result.issues, []);
});

test("computeFilterDiagnostics reports unsupported date filters for tavily", () => {
  const result = computeFilterDiagnostics({
    providerId: "tavily",
    sentArgs: {
      date_after: "2024-01-01",
      date_before: "2024-12-31",
    },
  });
  assert.ok(result);
  assert.equal(result.filtersFullyApplied, false);
  assert.equal(result.issues.length, 2);
  const argNames = result.issues.map((i: FilterDiagnosticEntry) => i.arg).sort();
  assert.deepEqual(argNames, ["date_after", "date_before"]);
  assert.ok(result.issues.every((i: FilterDiagnosticEntry) => i.level === "unsupported"));
});

test("computeFilterDiagnostics reports ignored filters for gemini", () => {
  const result = computeFilterDiagnostics({
    providerId: "gemini",
    sentArgs: {
      country: "US",
      language: "fr",
      freshness: "day",
    },
  });
  assert.ok(result);
  assert.equal(result.filtersFullyApplied, false);
  assert.equal(result.issues.length, 3);
  assert.ok(result.issues.every((i: FilterDiagnosticEntry) => i.level === "ignored"));
});

test("computeFilterDiagnostics reports degraded freshness for tavily", () => {
  const result = computeFilterDiagnostics({
    providerId: "tavily",
    sentArgs: { freshness: "day" },
  });
  assert.ok(result);
  assert.equal(result.filtersFullyApplied, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.level, "degraded");
  assert.equal(result.issues[0]?.arg, "freshness");
});

test("computeFilterDiagnostics only reports issues for args that were actually sent", () => {
  // tavily has many unsupported/ignored args but we only send freshness
  const result = computeFilterDiagnostics({
    providerId: "tavily",
    sentArgs: { freshness: "month" },
  });
  assert.ok(result);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.arg, "freshness");
});

test("computeFilterDiagnostics preserves sentValue in issues", () => {
  const result = computeFilterDiagnostics({
    providerId: "tavily",
    sentArgs: { date_after: "2025-01-01" },
  });
  assert.ok(result);
  assert.equal(result.issues[0]?.sentValue, "2025-01-01");
});

// ---------------------------------------------------------------------------
// Unit tests: renderFilterDiagnostics
// ---------------------------------------------------------------------------

test("renderFilterDiagnostics returns empty string when filtersFullyApplied", () => {
  const result = computeFilterDiagnostics({ providerId: "brave", sentArgs: { country: "US" } });
  assert.ok(result);
  assert.equal(renderFilterDiagnostics(result), "");
});

test("renderFilterDiagnostics includes level, arg, value, and message in output", () => {
  const result = computeFilterDiagnostics({
    providerId: "tavily",
    sentArgs: { date_after: "2024-01-01", country: "US" },
  });
  assert.ok(result);
  const rendered = renderFilterDiagnostics(result);
  assert.match(rendered, /\[unsupported\]/);
  assert.match(rendered, /date_after/);
  assert.match(rendered, /2024-01-01/);
  assert.match(rendered, /\[ignored\]/);
  assert.match(rendered, /country/);
});

// ---------------------------------------------------------------------------
// Integration: filterDiagnostics surfaced in FusionSearchPayload
// ---------------------------------------------------------------------------

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
      { id: "tavily", label: "Tavily", configured: true, autoDetectOrder: 20 },
      { id: "gemini", label: "Gemini", configured: true, autoDetectOrder: 30 },
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
        (async ({ providerId }) => ({
          provider: providerId ?? "brave",
          result: {
            results: [{ title: `${providerId} result`, url: `https://example.com/${providerId}` }],
          },
        })),
    },
  };
}

test("filterDiagnostics is attached to providerDetails and providerRuns for known providers", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "test",
      providers: ["brave", "tavily"],
      date_after: "2024-01-01",
    },
  });

  const braveDetail = payload.providerDetails.find((d) => d.provider === "brave");
  const tavilyDetail = payload.providerDetails.find((d) => d.provider === "tavily");

  // brave supports date_after — no issues
  assert.ok(braveDetail?.filterDiagnostics);
  assert.equal(braveDetail?.filterDiagnostics?.filtersFullyApplied, true);
  assert.deepEqual(braveDetail?.filterDiagnostics?.issues, []);

  // tavily does not support date_after — should have an issue
  assert.ok(tavilyDetail?.filterDiagnostics);
  assert.equal(tavilyDetail?.filterDiagnostics?.filtersFullyApplied, false);
  assert.equal(tavilyDetail?.filterDiagnostics?.issues.length, 1);
  assert.equal(tavilyDetail?.filterDiagnostics?.issues[0]?.arg, "date_after");
  assert.equal(tavilyDetail?.filterDiagnostics?.issues[0]?.level, "unsupported");
});

test("filterDiagnostics is absent for unknown providers", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      providers: [
        { id: "unknownprovider", label: "Unknown", configured: true, autoDetectOrder: 1 },
        { id: "search-fusion", label: "Search Fusion", configured: true, autoDetectOrder: 999 },
      ],
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "test",
      providers: ["unknownprovider"],
      freshness: "week",
    },
  });

  const detail = payload.providerDetails.find((d) => d.provider === "unknownprovider");
  assert.ok(detail);
  assert.equal(detail?.filterDiagnostics, undefined);
});

test("filterDiagnostics is consistent between providerDetails and providerRuns", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "test",
      providers: ["tavily"],
      date_after: "2024-01-01",
      country: "US",
    },
  });

  const detailDiag = payload.providerDetails.find((d) => d.provider === "tavily")?.filterDiagnostics;
  const runDiag = payload.providerRuns.find((r) => r.provider === "tavily")?.filterDiagnostics;

  assert.deepEqual(detailDiag, runDiag);
});

test("filterDiagnostics shows no issues when no filter args are requested", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "test query",
      providers: ["gemini", "tavily"],
      // no filter args
    },
  });

  for (const detail of payload.providerDetails) {
    if (!detail.filterDiagnostics) continue; // unknown provider
    assert.equal(
      detail.filterDiagnostics.filtersFullyApplied,
      true,
      `Expected ${detail.provider} to show filtersFullyApplied=true when no filters sent`,
    );
  }
});

test("renderFusionSummary includes filter diagnostic warnings for non-supported filters", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "test",
      providers: ["gemini"],
      freshness: "day",
      date_after: "2024-01-01",
    },
  });

  // import renderFusionSummary to check output — re-use existing export
  const { renderFusionSummary } = await import("../src/search-fusion.js");
  const summary = renderFusionSummary(payload, true);

  assert.match(summary, /gemini/i);
  assert.match(summary, /\[ignored\]/);
  assert.match(summary, /freshness/);
  assert.match(summary, /date_after/);
});
