import test from "node:test";
import assert from "node:assert/strict";
import { discoverProviders, resolveSelectedProviders } from "../src/provider-discovery.js";

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

test("resolveSelectedProviders provides built-in starter modes when custom modes are absent", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    requestMode: "balanced",
    config: {},
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["brave", "gemini"]);
});

test("resolveSelectedProviders lets defaultMode target built-in starter modes", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    config: {
      defaultMode: "fast",
    },
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["brave"]);
});

test("resolveSelectedProviders treats custom modes as authoritative", () => {
  assert.throws(
    () =>
      resolveSelectedProviders({
        availableProviders: getDiscovered(),
        requestMode: "balanced",
        config: {
          modes: {
            custom: ["gemini"],
          },
        },
      }),
    /Unknown Search Fusion mode: balanced/,
  );
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
