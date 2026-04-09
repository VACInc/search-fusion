import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const manifestPath = path.resolve(import.meta.dirname, "..", "openclaw.plugin.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
  uiHints?: Record<string, unknown>;
  configSchema?: { properties?: Record<string, unknown> };
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

test("manifest advertises webSearch participation for runtime provider discovery", () => {
  const uiHintKeys = Object.keys(manifest.uiHints ?? {});
  const schemaProperties = Object.keys(manifest.configSchema?.properties ?? {});

  assert.equal(
    uiHintKeys.some((key) => key === "webSearch" || key.startsWith("webSearch.")) ||
      schemaProperties.includes("webSearch"),
    true,
    "search-fusion must advertise webSearch capability in openclaw.plugin.json so generic web_search can discover the provider",
  );
});

test("manifest exposes providerConfig weight overrides", () => {
  const schemaProperties = manifest.configSchema?.properties ?? {};
  const providerConfig = asObject(schemaProperties.providerConfig);
  const providerConfigEntry = asObject(providerConfig?.additionalProperties);
  const providerProperties = asObject(providerConfigEntry?.properties);
  const weightSchema = asObject(providerProperties?.weight);

  assert.equal(weightSchema?.type, "number");
  assert.equal(weightSchema?.minimum, 0.1);
  assert.equal(weightSchema?.maximum, 5);
});
