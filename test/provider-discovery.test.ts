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
    id: "search-fusion",
    label: "Search Fusion",
    autoDetectOrder: 999,
    envVars: [],
    getConfiguredCredentialValue: () => "always-enabled",
    getCredentialValue: () => undefined,
  },
] as const;

test("discoverProviders excludes self and marks configured providers", () => {
  const discovered = discoverProviders({
    providers: [...providers],
    config: {},
    selfId: "search-fusion",
  });

  assert.deepEqual(
    discovered.map((provider) => ({ id: provider.id, configured: provider.configured })),
    [
      { id: "brave", configured: true },
      { id: "tavily", configured: false },
    ],
  );
});

test("resolveSelectedProviders prefers configured providers by default", () => {
  const discovered = discoverProviders({
    providers: [...providers],
    config: {},
    selfId: "search-fusion",
  });

  const selected = resolveSelectedProviders({
    availableProviders: discovered,
    config: {},
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["brave"]);
});

test("resolveSelectedProviders honors explicit all and exclusions", () => {
  const discovered = discoverProviders({
    providers: [...providers],
    config: {},
    selfId: "search-fusion",
  });

  const selected = resolveSelectedProviders({
    availableProviders: discovered,
    requestProviders: ["all"],
    config: { excludeProviders: ["brave"] },
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["tavily"]);
});
