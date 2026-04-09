# ClawHub visibility check for `@vacinc/search-fusion`

This repo includes a repeatable verifier for TODO item 6:

> Verify ClawHub public visibility for `@vacinc/search-fusion` after scan/indexing finishes.

## How to re-check

From this repo:

```bash
pnpm verify:clawhub-visibility
```

or:

```bash
node scripts/verify-clawhub-visibility.mjs
```

Use strict index mode (fails if query-page payload does not contain the package):

```bash
node scripts/verify-clawhub-visibility.mjs --strict-index
```

## What the verifier checks

Required checks (must pass):
- package URL responds with HTTP 200
- package payload contains `name:"@vacinc/search-fusion"`
- package payload contains owner handle `vacinc`

Optional checks (signals):
- source repo metadata includes `VACInc/openclaw-search-fusion`
- package payload includes `scanStatus:"clean"`
- query route loads for `https://clawhub.ai/plugins?query=search-fusion`
- query-page payload includes `@vacinc/search-fusion` (index/discovery signal)

## Verification run (2026-04-09)

Command run:

```bash
node scripts/verify-clawhub-visibility.mjs
```

Result summary:
- ✅ Public package page is visible at `https://clawhub.ai/plugins/%40vacinc%2Fsearch-fusion`
- ✅ Page payload includes package name, owner handle, source repo, and `scanStatus:"clean"`
- ✅ Query route for `?query=search-fusion` loads
- ⚠️ Package did **not** appear in the query-page payload during this run (could be indexing lag, ranking, or pagination)

Conclusion:
- Public visibility is confirmed.
- Query-page discoverability should be re-checked later with `--strict-index` once indexing is expected to be fully propagated.
