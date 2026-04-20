# AGENTS.md

Search Fusion repo rules.

## ClawHub package identity

Canonical package:
- `@vacinc/search-fusion`

Keep install and publish guidance aligned to that package name.

## Tests are mandatory

If behavior changes, tests should change too.

Always keep tests up to date for:
- provider discovery and selection
- mode/default routing
- intent routing
- ranking / normalization behavior
- provider capability registry changes
- audit payload changes

Minimum verification after meaningful code or config-surface changes:
- `npm test`
- `npx tsc --noEmit`

If docs, metadata, or publish behavior changes, verify the affected files directly after editing.

## Docs and publish hygiene

When install behavior or ClawHub metadata changes:
- update `README.md`
- update `package.json` metadata if needed
- make sure ClawHub-required OpenClaw metadata stays present
- confirm install guidance is still correct

## General

Prefer simple, explicit behavior over clever indirection.
Do not leave publishing or install semantics ambiguous.
