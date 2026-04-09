# Search Fusion — Rerun & Audit Kit

The audit kit makes it easy to **capture**, **replay**, and **review** Search Fusion query runs reproducibly.

## Why this exists

Search results are ephemeral and provider-dependent. The audit kit gives you a durable, self-contained snapshot of any Search Fusion run so you can:

- **Review** source quality, provider health, and result caveats after the fact
- **Rerun** the same query with the same request parameters and compare results
- **Detect drift** — which URLs appeared, disappeared, or changed rank between runs
- **Debug** provider failures, auth errors, and retry behavior
- **Store** audit records in version control or a test fixture directory as regression baselines

---

## Artifacts

| File | Purpose |
|------|---------|
| `audit/types.ts` | TypeScript types for `AuditRecord`, `AuditCaveat`, `AuditProviderSummary` |
| `audit/record.ts` | `createAuditRecord()` and `parseAuditRecord()` — capture and deserialize audit records |
| `audit/review.ts` | `renderAuditReview()` and `compareAuditRecords()` — human-readable review and diff |
| `test/fixtures/example-audit.json` | A self-contained example audit record you can load and inspect |

---

## Usage

### 1. Capture a run

After calling `runSearchFusion`, wrap the payload in an audit record:

```ts
import { runSearchFusion } from "./src/search-fusion.js";
import { createAuditRecord } from "./audit/record.js";
import { renderAuditReview } from "./audit/review.js";
import fs from "node:fs";

const payload = await runSearchFusion({ runtime, config, pluginConfig, request });

const record = createAuditRecord({
  payload,
  request,
  pluginConfig,
  label: "my-query-2026-04-09",
});

// Save to disk
fs.writeFileSync("my-audit.json", JSON.stringify(record, null, 2));

// Print a human-readable review
console.log(renderAuditReview(record));
```

### 2. Load and review later

```ts
import { parseAuditRecord } from "./audit/record.js";
import { renderAuditReview } from "./audit/review.js";
import fs from "node:fs";

const record = parseAuditRecord(fs.readFileSync("my-audit.json", "utf8"));
console.log(renderAuditReview(record));
```

### 3. Rerun and compare

```ts
import { compareAuditRecords } from "./audit/review.js";

// Re-run using record.request and record.pluginConfig
const rerunPayload = await runSearchFusion({
  runtime,
  config,
  pluginConfig: record.pluginConfig,
  request: record.request,
});

const rerunRecord = createAuditRecord({
  payload: rerunPayload,
  request: record.request,
  pluginConfig: record.pluginConfig,
});

const diff = compareAuditRecords(record, rerunRecord);
console.log(diff.summary);
```

---

## Audit Record structure

```
AuditRecord {
  schemaVersion: 1
  capturedAt: ISO-8601 timestamp
  label?: optional human label
  request: { query, providers?, mode?, count?, ... }
  pluginConfig: { modes?, defaultMode?, retry?, providerConfig?, ... }
  summary: { tookMs, mergedResultCount, providersQueried, providersSucceeded, ... }
  providerSummaries[]: per-provider quality notes and caveats
  caveats[]: top-level quality issues (all-failed, high-sponsored-ratio, ...)
  payload: the full FusionSearchPayload (results, providerRuns, answers, ...)
}
```

All fields needed to replay the exact query are in `request` and `pluginConfig`.

---

## Caveat codes

| Code | Severity | Meaning |
|------|----------|---------|
| `no-providers-queried` | error | No providers were queried at all |
| `all-providers-failed` | error | Every queried provider failed |
| `some-providers-failed` | warn | At least one provider failed |
| `no-results` | warn | No merged results or answers were produced |
| `high-sponsored-ratio` | warn | ≥30% of merged results are sponsored |
| `no-cross-provider-corroboration` | info | No result was found by more than one provider |
| `provider-not-configured` | warn | A provider appears unconfigured |
| `provider-auth-error` | error | Provider returned an auth/credential error |
| `provider-run-failed` | error | Provider call failed (non-auth) |
| `provider-needed-retry` | warn | Provider succeeded but required retries |
| `provider-empty-results` | warn | Provider succeeded but returned 0 results |

---

## Example fixture

`test/fixtures/example-audit.json` contains a complete synthetic audit record
capturing a two-provider query (`brave` + `tavily`) for `"openclaw plugin sdk runtime helpers"`.

Load it with:

```ts
import { parseAuditRecord } from "./audit/record.js";
import fs from "node:fs";

const record = parseAuditRecord(
  fs.readFileSync("test/fixtures/example-audit.json", "utf8")
);
```

---

## Running the audit tests

```bash
pnpm test
```

Audit tests live in `test/audit.test.ts` and cover:

- `createAuditRecord` — payload summarization, caveat detection, flag fractions
- `parseAuditRecord` — round-trip serialization, schema version gating, fixture loading
- `renderAuditReview` — review text rendering
- `compareAuditRecords` — URL diff, provider status change detection
