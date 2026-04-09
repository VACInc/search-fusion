import test from "node:test";
import assert from "node:assert/strict";
import { discoverProviders, resolveSelectedProviders, resolveSelectedProvidersWithReasons } from "../src/provider-discovery.js";

const providers = [
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
    getConfiguredCredentialValue: () => undefined,
    getCredentialValue: () => undefined,
  },
  {
    id: "gemini",
    label: "Gemini",
    autoDetectOrder: 30,
    envVars: [],
    getConfiguredCredentialValue: () => "gemini-key",
    getCredentialValue: () => undefined,
  },
  {
    id: "duckduckgo",
    label: "DuckDuckGo",
    autoDetectOrder: 100,
    requiresCredential: false,
    envVars: [],
    getConfiguredCredentialValue: () => undefined,
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
] as const;

function getDiscovered() {
  return discoverProviders({
    providers: [...providers],
    config: {},
    selfId: "search-fusion",
  });
}

test("discoverProviders excludes self and marks configured providers", () => {
  const discovered = getDiscovered();

  assert.deepEqual(
    discovered.map((provider) => ({ id: provider.id, configured: provider.configured })),
    [
      { id: "brave", configured: true },
      { id: "tavily", configured: false },
      { id: "gemini", configured: true },
      { id: "duckduckgo", configured: true },
    ],
  );
});

test("resolveSelectedProviders falls back to configured providers by default", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    config: {},
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["brave", "gemini", "duckduckgo"]);
});

test("resolveSelectedProviders keeps keyless providers in the default pool", () => {
  const selected = resolveSelectedProviders({
    availableProviders: [
      {
        id: "duckduckgo",
        label: "DuckDuckGo",
        autoDetectOrder: 100,
        configured: true,
      },
      {
        id: "tavily",
        label: "Tavily",
        autoDetectOrder: 20,
        configured: false,
      },
    ],
    config: {},
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["duckduckgo"]);
});

test("resolveSelectedProviders honors explicit all and exclusions", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    requestProviders: ["all"],
    config: { excludeProviders: ["brave"] },
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["gemini", "duckduckgo"]);
});

test("resolveSelectedProviders honors explicit mode", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    requestMode: "deep",
    config: {
      modes: {
        fast: ["brave"],
        deep: ["tavily", "gemini"],
      },
    },
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["tavily", "gemini"]);
});

test("resolveSelectedProviders honors defaultMode before legacy defaultProviders", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    config: {
      defaultMode: "balanced",
      modes: {
        balanced: ["brave", "tavily"],
      },
      defaultProviders: ["gemini"],
    },
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["brave", "tavily"]);
});

test("resolveSelectedProviders throws on unknown explicit mode", () => {
  assert.throws(
    () =>
      resolveSelectedProviders({
        availableProviders: getDiscovered(),
        requestMode: "chaos",
        config: {
          modes: {
            fast: ["brave"],
          },
        },
      }),
    /Unknown Search Fusion mode: chaos/,
  );
});

// ── resolveSelectedProvidersWithReasons ──────────────────────────────────────

test("resolveSelectedProvidersWithReasons marks self as skipped-is-self", () => {
  const { decisions } = resolveSelectedProvidersWithReasons({
    availableProviders: getDiscovered(),
    selfId: "search-fusion",
    config: {},
  });
  const self = decisions.find((d) => d.id === "search-fusion");
  assert.equal(self?.reason, "skipped-is-self");
});

test("resolveSelectedProvidersWithReasons marks auto-selected configured providers as ran", () => {
  const { selected, decisions } = resolveSelectedProvidersWithReasons({
    availableProviders: getDiscovered(),
    selfId: "search-fusion",
    config: {},
  });
  const selectedIds = new Set(selected.map((p) => p.id));
  for (const decision of decisions.filter((d) => d.id !== "search-fusion")) {
    if (selectedIds.has(decision.id)) {
      assert.equal(decision.reason, "ran", `${decision.id} should be "ran"`);
    } else {
      assert.equal(decision.reason, "skipped-not-configured", `${decision.id} should be "skipped-not-configured"`);
    }
  }
});

test("resolveSelectedProvidersWithReasons marks excluded providers as skipped-excluded", () => {
  const { decisions } = resolveSelectedProvidersWithReasons({
    availableProviders: getDiscovered(),
    selfId: "search-fusion",
    config: { excludeProviders: ["brave"] },
  });
  const brave = decisions.find((d) => d.id === "brave");
  assert.equal(brave?.reason, "skipped-excluded");
});

test("resolveSelectedProvidersWithReasons marks out-of-mode providers as skipped-not-in-mode", () => {
  const { decisions } = resolveSelectedProvidersWithReasons({
    availableProviders: getDiscovered(),
    selfId: "search-fusion",
    requestMode: "fast",
    config: {
      modes: {
        fast: ["brave"],
        deep: ["tavily", "gemini"],
      },
    },
  });
  const gemini = decisions.find((d) => d.id === "gemini");
  const duckduckgo = decisions.find((d) => d.id === "duckduckgo");
  assert.equal(gemini?.reason, "skipped-not-in-mode");
  assert.equal(duckduckgo?.reason, "skipped-not-in-mode");
  const brave = decisions.find((d) => d.id === "brave");
  assert.equal(brave?.reason, "ran");
  assert.match(brave?.detail ?? "", /mode/);
});

test("resolveSelectedProvidersWithReasons marks explicit-list non-members as skipped-not-in-mode", () => {
  const { decisions } = resolveSelectedProvidersWithReasons({
    availableProviders: getDiscovered(),
    selfId: "search-fusion",
    requestProviders: ["brave"],
    config: {},
  });
  // tavily is unconfigured and not requested, so it gets skipped-not-configured
  const tavily = decisions.find((d) => d.id === "tavily");
  assert.equal(tavily?.reason, "skipped-not-configured");
  // gemini IS configured but was not in the explicit list, so it gets skipped-not-in-mode
  const gemini = decisions.find((d) => d.id === "gemini");
  assert.equal(gemini?.reason, "skipped-not-in-mode");
  const brave = decisions.find((d) => d.id === "brave");
  assert.equal(brave?.reason, "ran");
});

test("resolveSelectedProvidersWithReasons includes unknown requested provider ids", () => {
  const { decisions } = resolveSelectedProvidersWithReasons({
    availableProviders: getDiscovered(),
    selfId: "search-fusion",
    requestProviders: ["brave", "nonexistent-provider"],
    config: {},
  });
  const ghost = decisions.find((d) => d.id === "nonexistent-provider");
  assert.ok(ghost, "should have a decision for the unknown provider");
  assert.equal(ghost?.reason, "skipped-not-in-mode");
  assert.match(ghost?.detail ?? "", /not registered/);
});

test("resolveSelectedProvidersWithReasons covers every discovered provider in the decisions array", () => {
  const discovered = getDiscovered();
  const { decisions } = resolveSelectedProvidersWithReasons({
    availableProviders: discovered,
    selfId: "search-fusion",
    config: {},
  });
  for (const provider of discovered) {
    assert.ok(
      decisions.some((d) => d.id === provider.id),
      `${provider.id} must have a routing decision`,
    );
  }
  // self must also appear
  assert.ok(decisions.some((d) => d.id === "search-fusion"));
});
