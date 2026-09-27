# Compatibility Authority Audit

Date: 2026-09-06

## Scope

Audited `tools/compat`, `tools/migration`, legacy Ranking wrappers and their
callers under `tools`, `docs`, and `.codex`. Existing uncommitted changes in
runtime-service, host adapters, product-gate code, and renderer files were
left untouched.

## Changes

- Moved the still-necessary legacy `ensure` behavior to
  `tools/migration/migrate-jcc-current-ranking-generation.mjs`.
- Deleted the unused `tools/publish-jcc-current-ranking-generation.mjs`; no
  caller was found and its behavior could publish the legacy `current/` shape.
- Kept a migration-only fail-closed guard: after
  `active-ranking-closure.json` exists, migration is rejected and the full
  refresh pipeline remains authoritative.
- Added explicit classification documentation for `source_identity`,
  `migration_input`, `compatibility_adapter`, and `retired_authority`.

## Authority Findings

`source_identity` is provenance and association metadata. `migration_input`
is legacy evidence. `compatibility_adapter` may translate shape but cannot
create canonical game meaning. `retired_authority` is rejection or historical
evidence only. Tencent/raw family IDs remain opaque raw-row keys and cannot
select canonical traits or other game semantics.

## Generation Protection

No files under `data/live-rankings/jcc` were deleted or rewritten. Active,
leased, candidate, and historical generations remain protected by the existing
generation-store and pruning contracts. Historical references are retained.

## Global Scan Evidence

- Before cleanup, both legacy script names were defined only in their own
  files; no production caller was found.
- After cleanup, the deleted publisher name has no live code/config caller.
- The old `ensure` filename remains only in historical changelog evidence, not
  an executable caller. The executable migration entry has the explicit
  `tools/migration/` namespace.
- Main Ranking refresh callers continue to resolve through
  `tools/update-jcc-live-rankings.mjs`, `tools/run-jcc-version-pipeline.mjs`,
  and the Active Ranking closure.

## Required Mainline Follow-up

No mainline file was changed here. The mainline owner should separately remove
any future references to legacy `current/` publication if a new caller is
introduced; it must enter through the registered candidate/verify/promote and
Active-closure pipeline instead.
