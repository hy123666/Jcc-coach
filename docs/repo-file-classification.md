# Repository File Classification

Use these classes to decide where a change belongs and whether a file may be a
production authority. The current requirements registry and its registered
machine contracts override this navigation guide.

## Requirements And Entrypoints

Purpose: authority discovery, operator guidance, and host-workspace bootstrap.

Includes:

- `docs/requirements/requirements-registry.json`: requirement classification
  and domain ownership;
- `docs/requirements/*.md`: registered current guidance or explicitly
  classified history;
- `AGENTS.md` and `.codex/skills/jcc-runtime-agent/SKILL.md`: engineering and
  host entrypoints.

Entrypoints are not fallback product authorities. Production behavior must be
represented in registered machine contracts and delivered Runtime context.

## Common Knowledge

Purpose: authored, season-neutral game knowledge.

Includes `data/game-knowledge/jcc/common/` concepts, glossary, formulas,
deterministic calculation contracts, doctrine, routes, standard mechanics,
choice framework, and retrieval policy.

Common must not contain one season's entities, mechanic names, manual fields,
or patch balance. A generated copy of Common data is not a second authored
authority.

## Season Modules

Purpose: one major season's mechanic contract.

Includes:

- `data/game-knowledge/jcc/seasons/<season_id>/season-descriptor.json`;
- season-owned archive manifests;
- season-only mechanic enablement, schedule inheritance or replacement,
  variables, aliases, exclusions, and mode extensions.

Do not create a season directory for an ordinary balance patch. Retired season
modules remain addressable for rollback and historical match explanation.

## Patch Sources

Purpose: normalized, versioned entity and balance data plus source provenance.

Includes:

- `data/game-knowledge/jcc/seasons/<season_id>/patches/<patch_id>/` source
  manifests and source documentation;
- `data/core-patches/jcc/<package_id>/` normalized catalogs, deterministic flat
  indexes, recipes, manifests, and Runtime lookup budgets;
- bounded source adapters under `tools/`.

Patch packages are builder-owned inputs. They do not own Common doctrine,
major-season timing, active pointers, or current match state. Upstream package
names remain provenance and do not define Runtime season identity.

## Ranking Overlays

Purpose: audited current-day Master+ strategy evidence.

Includes:

- `data/live-rankings/jcc/generations/<ranking_overlay_id>/` immutable
  generations;
- `data/live-rankings/jcc/active-generation.json` as the small active pointer;
- compact bounded history used for diagnostics and rollback analysis.

Each generation contains its manifest, audit, rank signal, typed lineup strategy
index, and reverse indexes. Runtime reads the promoted typed index; it does not
parse raw snapshots or use historical trends during a live decision.

## Generated Knowledge

Purpose: immutable compiler output and isolated release candidates.

Includes:

- `data/game-knowledge/jcc/generated/<core_profile_id>/` Core Profile artifacts;
- `data/game-knowledge/jcc/candidates/` unpromoted candidate metadata;
- `data/game-knowledge/jcc/active-profile.json` as the small active pointer.

Generated profiles compose Common, one Season, and one Patch. They include the
rules bundle, decision-input catalog, augment-stage authority, and Runtime
catalog overlay under one content identity. Do not hand-edit generated files or
mutate an active generation in place.

## Mainline Runtime

Purpose: the MuMu desktop Runtime and host-agent transport.

Includes:

- `ui/electron/`, `ui/src/`, and Runtime-facing `tools/`;
- `data/runtime/jcc/` machine contracts, compact compatibility fixtures, and
  Runtime policy data;
- `.jcc-runtime-data/app.sqlite` and bounded Runtime-local state when the app is
  running.

Runtime captures immutable profile/ranking identities and owns current facts,
sessions, tasks, leases, and delivery. It must not normalize upstream sources,
rewrite generated knowledge, infer a version from package names, or depend on a
host provider loading the repo-local skill.

Legacy ROI/OCR/icon tools are outside the active product path unless a current
machine contract explicitly registers a narrow use. Compatibility or calibration
tools must not promote choice truth or become release fallbacks.

## Retrieval Support

Typed indexes and deterministic reverse indexes are the production authority
for exact entity identity, legality, constraints, relations, formulas, and
ranking candidates. `ui/electron/semantic-evidence-router.js` uses MiniSearch
only as a bounded lexical/fuzzy supplement for explanations and candidate
discovery; typed validation remains mandatory.

Heavyweight DAG, GraphRAG, knowledge-graph, vector-store, and model-driven graph
frameworks are not Runtime dependencies. Offline research may generate local
analysis, but graph output must not enter active profiles, promotion gates,
Runtime fallbacks, or committed production lookup assets.

## APK Companion Track

Purpose: future phone or non-MuMu companion path.

Includes `android-companion/` source and assets only.

Status: paused. It is not required by the MuMu desktop Runtime and cannot
validate mainline acceptance unless the registered requirements explicitly
resume it.

Ignored build output:

- `android-companion/.gradle/`
- `android-companion/build/`
- `android-companion/app/build/`
- `android-companion/app/.cxx/`
- `android-companion/local.properties`

## Historical And Diagnostic Material

Purpose: migration evidence, rollback explanation, and bounded debugging.

Historical rule fixtures, compact ranking trends, archive manifests, and
explicit diagnostics cannot override current machine contracts or enter live
retrieval by default. Keep only material required by a registered retention,
rollback, or verifier contract.

## Local Scratch And Caches

Purpose: local-only working state.

Ignored:

- `.omx/state/`, `.omx/logs/`, `.omx/notepad.md`, `.omx/tmux-hook.json`
- `.venv-ocr/`
- `tmp-*.js`
- `tools/__pycache__/`
- `*.pyc`
- local graph-builder checkouts under `tools/graph-builders/`
