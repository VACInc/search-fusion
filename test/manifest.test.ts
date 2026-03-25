import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const manifestPath = path.resolve(import.meta.dirname, "..", "openclaw.plugin.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
  uiHints?: Record<string, unknown>;
  configSchema?: { properties?: Record<string, unknown> };
};

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
