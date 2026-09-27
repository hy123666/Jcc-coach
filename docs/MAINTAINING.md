# Maintaining JCC Runtime

## Read First

1. `docs/requirements/requirements-registry.json`: current requirement owners.
2. `data/runtime/jcc/harness-entrypoint-contract.json`: pipeline and verification entrypoints.
3. `.codex/skills/jcc-runtime-agent/SKILL.md`: project engineering contract.
4. The current machine contract for the component being changed.

Historical plans explain decisions but do not override current machine contracts.
Read only the relevant modules and contracts, then update code, affected tests,
the owning contract and requirement change log together when behavior changes.
No global Codex plugin or personal developer configuration is required.

## Module Map

| Area | Entry |
| --- | --- |
| Desktop lifecycle and UI | `ui/electron/main.js`, `ui/src/` |
| Runtime orchestration | `ui/electron/runtime-service.js` |
| Provider transport | `ui/electron/host-adapters.js` |
| Provider-neutral instructions | `data/runtime/jcc/host-coach-instruction-contract.json` |
| Version and data maintenance | `tools/run-jcc-version-pipeline.mjs` |
| Core identity | `data/game-knowledge/jcc/active-profile.json` |
| Ranking/Recipe identity | `data/live-rankings/jcc/active-ranking-closure.json` |
| Version maintenance guide | `docs/requirements/jcc-season-version-governance-runbook.md` |
| Native Host knowledge tools | `ui/electron/host-readonly-tool-broker.js` |

## Rules That Must Survive Changes

- SQLite owns durable user and Match state. Provider memory is not current fact authority.
- A Match pins one immutable Core/Ranking/Recipe binding. Never substitute a newer
  daily snapshot inside an existing Match.
- Use `jcc.query_knowledge` and `jcc.calculate` for Host knowledge retrieval.
- Keep complete atomic lineup facts and preserve exact variant retrieval.
- Common contains season-neutral knowledge; S18 sources and patches contain version facts.
- Ordinary board/shop observations are evidence, not independent automatic answer triggers.
- Keep permission and identity checks separate from soft answer-format guidance.
- Do not read developer credentials, change global harness settings, or ship user state.

## Daily Data

Read the active Core profile first and use its exact identity:

```powershell
$core = Get-Content data/game-knowledge/jcc/active-profile.json -Raw | ConvertFrom-Json
node tools/run-jcc-version-pipeline.mjs rankings --season $core.season_id --patch $core.patch_id --expected-core-profile-id $core.core_profile_id --write
```

The pipeline includes deterministic compilation, semantic maintenance, atomic
publication, verification and pruning. A source-date lag is not permission to
invent a newer statistics date. A failed maintenance phase must remain visible.

Core backups do not protect obsolete daily Ranking candidates. Active/pending
Core identities and live Match leases determine retention. The current runtime
retains two additional eligible full generations; compact trend history keeps
14 distinct dates. The public bundle follows the same active-plus-two eligible
generation policy, not a five-day full-snapshot policy.

## Focused Verification

```text
node tools/verify-jcc-live-ranking-active-closure.mjs
node tools/verify-jcc-runtime-rank-signal-contract.mjs
node tools/verify-jcc-live-ranking-generation-store.mjs
node tools/verify-jcc-live-ranking-recipe-sources.mjs
node tools/verify-jcc-game-knowledge-profile-store.mjs
npm --prefix ui run build
```

Select additional checks from the requirement registry for the changed modules.
Some historical tests still reference excluded S17 data or developer-only
documents; they must be migrated to isolated fixtures before certifying the
entire public-release gate. Do not restore S17 as production authority to satisfy them.
