# AGENTS.md

Search Fusion repo rules.

## ClawHub package identity constraints

Canonical package:
- `@vacinc/search-fusion`

Important platform constraint:
- ClawHub ties the runtime plugin id (`search-fusion`) to a single package identity.
- Attempting to publish a second package with the same plugin id fails with: `Plugin id "search-fusion" is already claimed by another package`.
- Attempting to override the published package name without changing `package.json.name` also fails.

Practical meaning:
- You cannot publish both `@vacinc/search-fusion` and `search-fusion` as separate ClawHub code-plugin packages while keeping the same runtime plugin id.
- If VAC wants both install spellings in the future, that requires ClawHub alias support or a platform change, not just repo changes.
- Treat `@vacinc/search-fusion` as the only real ClawHub package unless the registry behavior changes.

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

When install behavior, package identity, or ClawHub metadata changes:
- update `README.md`
- update `package.json` metadata if needed
- make sure ClawHub-required OpenClaw metadata stays present
- confirm install guidance is still correct

## General

Prefer simple, explicit behavior over clever indirection.
Do not leave publishing or install semantics ambiguous.
