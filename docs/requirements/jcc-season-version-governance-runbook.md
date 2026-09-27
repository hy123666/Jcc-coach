# JCC Season Version Governance Runbook

Status: current requirement
Owner: jcc-runtime
Last reviewed: 2026-09-06

Use this runbook for every major-season or minor-patch update. The machine
authorities are:

- `data/runtime/jcc/knowledge-profile-contract.json` for authored layers,
  immutable Core Profiles, ranking overlays, retrieval, promotion, and
  retention;
- `data/runtime/jcc/runtime-season-module-contract.json` for Runtime identity,
  major-season descriptors, patch boundaries, and match capture;
- `data/runtime/jcc/harness-entrypoint-contract.json` for the machine-readable
  cross-harness entrypoint and verification profiles.

The registered machine contracts define behavior. This runbook defines the
operator sequence and does not replace them.

## Version Boundaries

| Layer | Owns | Must not own |
| --- | --- | --- |
| Common | Season-neutral concepts, glossary, formulas, deterministic kernels, doctrine, routes, standard mechanics, choice framework, and retrieval policy under `data/game-knowledge/jcc/common/` | Season entities, patch balance, one season's mechanic, or Runtime state |
| Season | One major-season descriptor at `data/game-knowledge/jcc/seasons/<season_id>/season-descriptor.json`: mechanic enablement, inherited/replaced/disabled schedules, season-only variables, aliases, exclusions, and mode extensions | Ordinary patch balance or copied Common rules |
| Patch | One source manifest under `data/game-knowledge/jcc/seasons/<season_id>/patches/<patch_id>/`: normalized catalogs, source provenance, entity values, mechanic parameters, and explicit audited exceptions | Silent changes to Common doctrine or major-season timing |
| Rankings | One immutable, audited Master+ Ranking Overlay generation under `data/live-rankings/jcc/generations/<ranking_overlay_id>/` | Common rules, patch catalogs, active-match truth, or historical trend input to live decisions |
| Generated | Immutable Core Profile artifacts under `data/game-knowledge/jcc/generated/<core_profile_id>/`, plus an isolated candidate profile | Hand-authored doctrine or mutable in-place production files |
| Runtime | Small active pointers, request-captured Knowledge Snapshot identities, generation leases, and current match facts | Source normalization, compilation policy, or mutation of a captured profile |

Runtime-local `season_id`, `patch_id`, game mode, and package identity select
product rules. Upstream labels and framework names are provenance only. They
must not select local rules or leak into player-facing version identity.

## Descriptor And Product Contracts

Keep `data/runtime/jcc/host-coach-instruction-contract.json` provider-, season-,
patch-, and stage-neutral. Current mechanics reach the Host through the
captured Core Profile and selected context; never copy a season mechanic into
the invariant coach protocol.

`tools/jcc_active_rules_contract.mjs` compiles the effective Runtime choice
descriptors from the active Core Profile. Electron mode registration,
current-match report parsing, Cruise task routing, visible-window coaching, and
Host context-pack mode summaries consume that compiled list. They must not keep
a second static list of season modes, triggers, labels, or answer wording.

The same rule applies to setup and manual match variables. The season
descriptor's `manual_variable_fields` is the only authored declaration surface
for season-specific controls. Electron exposes compiled generic descriptors and
option groups; the renderer submits a generic `seasonVariables` object. A
legacy payload name is accepted only through an alias in the owning descriptor
and remains migration input, not a Common Runtime schema.

Every season-only choice descriptor owns its intent terms, visible choice
shape, current-match user-report contract, candidate paths, task triggers,
visible-window answer contract, Host mode context, missing-selection prompt,
and exclusions. Active choice truth remains the structured current-match user
report. OCR or visual tools may remain only where a current machine contract
registers a bounded convenience or diagnostic path; they cannot become an
undeclared product intake fallback.

An ordinary minor patch does not edit choice or manual-variable descriptors.
Balance, popularity, rankings, economy priors, and entity strength belong to
Patch or Rankings. Use the exceptional audited rule-override path only for an
actual same-season timing/mechanic change or a proven encoding defect. The
override must name every changed rule surface, old and new behavior, and
rollback evidence. Undeclared payload, overlapping declarations, generic
recursive merge, and season metadata changes fail closed. A requirement-level
exception also updates its owning machine contract, registry, and changelog in
the same change.

## Version Update Pipeline

Every update follows the same sequence:

`source adapter -> compile immutable candidate -> optional Master+ rankings -> verify -> explicit promotion -> archive/prune`

The pipeline may run a read-only `inspect` between source normalization and
candidate compilation to report the computed identity, blockers, and artifact
budgets. Inspection never writes or promotes content.

### 1. Source Adapter

Use a bounded source adapter to collect and normalize upstream material into a
patch source package. An adapter may understand one upstream format, but its
output must use the season-neutral patch manifest and catalog schemas.

The adapter must:

- write one immutable content-addressed hard-data generation outside active Core
  and ranking paths, then atomically update only the patch candidate reference;
- preserve upstream identity as provenance while assigning explicit local
  Runtime identity;
- produce deterministic, relative paths with no build timestamp or absolute
  workspace path in content identity;
- classify entities before catalog generation so technical source rows do not
  become player-facing choices by accident;
- preserve catalog authority explicitly: supplemental sources may enrich matched
  canonical entities, but unmatched supplemental rows remain audit evidence and
  cannot become production entities unless the patch manifest grants that source
  entity authority and a registered verifier proves the exact scope;
- treat the current official catalog as entity membership and canonical naming
  authority when a supplemental database is also available. Recover renamed
  equivalents only through declared aliases, identical normalized effects, or a
  unique same-tier resource identity with the same effect-number signature. Keep
  mismatched values and unmatched supplemental rows out of production catalogs;
- preserve reward outcomes as atomic bundles, compile probabilities and reward
  tables into the immutable Core Profile, and expose them through bounded typed
  per-question retrieval instead of adding complete source tables to the static
  Host capsule;
- cache season-mechanic lineup tools during the source phase. The patch declares
  the product-supported source variables and branches, discards unsupported
  branches, and stores the retained bounded candidates once as a shared
  immutable patch companion asset. Each retained lineup remains atomic.
  Relevant augment rows contain only an objective id and support reference; the
  Core Profile carries the locator, hash, objective metadata, declared
  dimensions, and retrieval policy. Runtime loads only the matching shard on
  demand, never calls the source page during play, and never treats the tool's
  trait-count objective as Master+ strength;
- record incomplete release inputs in `activation_blockers` instead of
  weakening a verifier or copying an older season's data.
- declare its source-format-specific verifier commands and complete arguments
  in `source_adapter.verifiers`; the shared Harness and pipeline must not add a
  season-named verification profile.

Repeated source refreshes for the same patch never rewrite the directory used
by the active Core Profile. They publish
`data/core-patches/jcc/generations/<hard_data_generation_id>/`; identical bytes
reuse the same id, different bytes receive a different id, and a hash collision
fails closed.

A minor patch normally changes patch catalogs, rankings, and optional strategy
overrides only. Edit a season descriptor only when the major-season mechanic
contract changes. Edit Common only when the rule is truly season-neutral.

Build every minor patch from the prior promoted patch's complete validated
catalog and parameters, then apply only the explicitly supplied changes. Entity
membership, augment stages, effects, aliases, and numeric values therefore carry
forward by default when they did not change. The pipeline still publishes a new
immutable generation and patch fingerprint; carry-forward never means reading
the prior patch dynamically at Runtime or mutating its generation in place.

The selected patch source manifest owns the upstream identity and expected
catalog counts consumed by its adapter and verifiers. Do not add a patch-version
switch or expected-count map to shared code. A same-season minor patch may also
declare bounded `hard_data_inheritance` roles for standard-mechanic overrides or
entity-bound reward tables. The Source Adapter loads those roles from the exact
prior promoted immutable hard-data generation, rebinds them to the current
catalog, and applies the current audited balance delta. Entity catalogs are not
silently inherited through this mechanism. A major season starts a new source
adapter/manifest and omits inheritance unless it explicitly declares a
compatible same-season parent.

### 2. Compile Immutable Candidate

Compile Common, exactly one season descriptor, and exactly one patch source
into an isolated Core Profile candidate. The compiler must include the rules
bundle, decision-input catalog, augment-stage authority, and Runtime catalog
overlay in the same generated directory and hash every retained artifact.

Compilation may succeed while release inputs remain incomplete. Such a
candidate stays non-promotable and carries its blockers forward. Compilation
must never change the active pointer, mutate an existing generated directory,
or modify a source package.

Once a season is registered in `manifest.json#season_archives`, it is frozen.
`inspect` and read-only `verify` remain available for reproducibility audits,
but `source`, `compile --write`, and `promote` must reject that season before
changing the shared candidate pointer or creating, deleting, or modifying any
generated artifact. The architecture verifier snapshots candidate bytes and
the complete generated file tree to enforce this pre-write boundary.
Archived verification always runs the shared architecture and identity profile.
It additionally runs frozen Source Adapter verifiers when the archived patch
still declares them; an older archive that predates adapter declarations reports
that absence instead of weakening active-season verifier requirements.

Record the resulting `core_profile_id`. Verification and promotion must use
that exact identity rather than re-resolving "latest" content.

Every payload consumed indirectly by a generated catalog, including normalized
entities, aliases, stage authority, and Runtime overlays, participates in that
identity. A manifest that still points at the same path cannot hide changed
payload bytes behind an unchanged Core Profile id.

### 3. Refresh Master+ Rankings

Run the optional `rankings` phase with the candidate's explicit season, patch,
and expected Core Profile id. The target resolver obtains mode, catalogs,
hard-data fingerprints, and publication scope from that compiled profile. It
must never complete a candidate identity from the prior active season.

Tencent supplies the latest available `stat_date`; it does not need to expose
the local minor-patch label. The pipeline binds that date to the internally
compiled patch and validates all returned entities against its catalogs. A
candidate refresh publishes one immutable Ranking Overlay plus
`candidates/<core_profile_id>.json` and leaves the active ranking pointer
unchanged. If the new-season ranking dataset has not appeared yet, skip this
phase or let it fail without changing active data. The Core Profile can still be
verified and promoted when all true activation blockers are clear; Runtime then
reports rankings unavailable and must not fall back to the prior season.

### 4. Verify

Run the `version_update` profile registered in
`data/runtime/jcc/harness-entrypoint-contract.json`. For a concrete patch, run
the same command with `--season` and `--patch`; the pipeline then adds the
verifiers declared by that patch's Source Adapter. Public architecture checks
stay global, while source-document parsing and normalization checks stay with
the adapter that understands that format. At minimum, verification must prove:

- source tuple and local/upstream identity separation;
- schema validity, path containment, deterministic hashes, and artifact budgets;
- Common season neutrality and explicit standard-mechanic inheritance;
- decision-input catalog, stage authority, aliases, and Runtime overlay identity;
- any published candidate Ranking Overlay has an exact compatible season,
  patch, Core Profile, hard-data fingerprint, and catalog fingerprint;
- season-aware Runtime, renderer, context-pack, and new-match behavior;
- crash recovery restores the persisted Match Profile before Host recovery, and
  match child tools fail closed without the exact snapshot and expected id;
- promotion races cannot make Cruise, combat, economy, lifecycle, Host context,
  OCR, or structured cards combine two Core Profiles;
- no production reader falls back to retired rule files, graph assets, or a
  mutable shared catalog;
- candidate and active generations remain unchanged after a failed check.

Do not clear `activation_blockers` manually. The deterministic data-update or
release pipeline may remove a blocker only after its owning verifier passes.

### 5. Explicit Promotion

Promotion is a separate, explicit operation after verification. It consumes
the isolated registered candidate profile and must name the expected
`core_profile_id`, season, and patch. Reject missing identity fields, a
mismatched hash, or any non-empty `activation_blockers`. If a Ranking Overlay
candidate exists, reject an incompatible identity; if none exists, promote the
Core Profile with ranking status explicitly unavailable.

The pipeline first writes an immutable promotion snapshot of the candidate,
recompiles the requested source tuple against the expected id before and after
all registered checks, and rejects any mutable candidate drift. The low-level
pointer writer is not a public release CLI and cannot bypass this pipeline.

Core Profile and Ranking Overlay use separate immutable lifecycles. Core
promotion does not reserve, activate, or roll back a Ranking Overlay. When no
compatible Ranking Overlay exists, Core promotion finishes with rankings
explicitly unavailable. A verified compatible Ranking Overlay is published by
the separate `rankings` phase; a ranking failure preserves the prior compatible
ranking pointer when one exists, otherwise leaves rankings unavailable, and
never rolls back a valid Core promotion. Publish by replacing only small
pointers to immutable generations. Never copy candidate files over an active
generation. A failed promotion leaves the last-known-good authority intact.
Promotion stops after that commit; archive and pruning are explicit later
phases so a cleanup failure cannot misreport an already committed release as a
failed promotion.

Promotion applies to new matches only. Start Match captures one Core Profile,
passes that exact identity to every watcher, card, OCR, Host, and decision
consumer, and leases the generation until clean retirement. Start Match also
captures one exact compatible Ranking Overlay or an explicit unavailable
identity. Both identities stay fixed for the entire Match; a later ranking
refresh affects only the lobby and the next Match. A live match never combines
assets from two profiles or ranking generations.

An abnormal daemon restart restores the persisted Match's immutable Profile and
lease before recovering its provider route. Match-scoped child tools receive
the serialized snapshot, exact artifact paths, and expected Core Profile id;
they never infer version identity from the latest active pointer or from the
match-session id alone.

### 6. Archive And Prune

After successful promotion:

1. Write or refresh the retired season's deterministic archive manifest when a
   major season changes. `archive --write` uses only the controlled
   `seasons/<season_id>/archive-manifest.json` path and then atomically registers
   that relative path under the root game-knowledge manifest's
   `season_archives`; an already identical registration is idempotent. A custom
   output is preview-only and cannot escape registration during a write.
2. Archive compact ranking diagnostics only after the replacement generation
   is active.
3. Prune through the registered retention phase, never by deleting directories
   manually.
4. For developer-only retired Runtime cleanup, pass the retired `--season-id`
   explicitly. The cleanup must resolve that season through the registered
   archive manifest and reject active or candidate seasons. Run the DB reset
   first; local-artifact prune requires its receipt for the same season and
   unchanged archive identity.

Retention must preserve:

- the active Core Profile and Ranking Overlay;
- the previous last-known-good generations;
- the active and pending Core candidates and their Ranking/Recipe candidates;
- every generation with an active or unresolved owner lease;
- every Core Profile listed by every archive registered in the root manifest's
  `season_archives` map, regardless of the bounded previous-generation limit;
- the configured bounded rollback/history allowance.

After Core Profile retention is resolved, the same `prune` phase removes only
hard-data generations that are no longer referenced by any retained Core
bundle or registered patch source manifest. A same-patch refresh therefore
cannot delete or mutate hard data still leased by a running Match.

Retaining a previous or archived Core does not retain its daily Ranking or
Recipe candidates. Only active/pending Core identities qualify for ordinary
Ranking/Recipe history retention. Exact active closure references and live
Match leases remain protected independently; retired-Core daily generations
are removed after those references are released.

A failed watcher or provider shutdown keeps its lease. Historical ranking
signals and trend summaries are for diagnostics, rollback analysis, and
explicit lobby review only; they never enter active-match retrieval or
ordering.

## Major Season Agent Checklist

This is the first execution surface for a Host Agent that is asked to replace
one major season with another. Resolve the concrete paths from
`data/runtime/jcc/harness-entrypoint-contract.json#major_season_update`; do not
discover the process by searching generated bundles or copying the prior
season's implementation.

1. Register one new major-season descriptor and one initial patch source
   manifest. The descriptor owns only season mechanics, standard-mechanic
   inheritance or replacement, season variables, aliases, exclusions, and mode
   extensions. The patch owns source identity, catalogs, values, effects, and
   explicit verified exceptions.
2. Keep Common unchanged by default. Normalize the new hard data, compile its
   tags and typed relations against the existing Common vocabulary, and audit
   every unmapped semantic. Extend Common only when the missing concept is
   genuinely reusable across seasons; otherwise keep it in the descriptor or
   patch.
3. Rebuild the complete Core candidate: rules bundle, semantic feature index,
   decision-input catalog, augment-stage authority, Runtime catalog overlay,
   aliases, formulas, and reverse indexes. A prior season's compiled artifact
   is never an input fallback.
4. Treat UI as descriptor-driven. A season with no manual fields produces no
   season-variable controls. Add shared renderer code only for a new reusable
   control shape declared by the descriptor; never add a season-named branch.
5. Run rankings against the exact new Core identity. Missing compatible
   Tencent Master+ data is an explicit unavailable capability, not permission
   to bind the retired season's overlay or block an otherwise valid Core.
6. Execute the registered phases and the `version_update` verifier profile:

   ```text
   node tools/run-jcc-version-pipeline.mjs source  --season <season_id> --patch <patch_id> --write
   node tools/run-jcc-version-pipeline.mjs inspect --season <season_id> --patch <patch_id>
   node tools/run-jcc-version-pipeline.mjs compile --season <season_id> --patch <patch_id> --expected-core-profile-id <id> --write
   node tools/run-jcc-version-pipeline.mjs rankings --season <season_id> --patch <patch_id> --expected-core-profile-id <id> --write
   node tools/run-jcc-version-pipeline.mjs verify  --season <season_id> --patch <patch_id> --expected-core-profile-id <id>
   node tools/run-jcc-version-pipeline.mjs promote --season <season_id> --patch <patch_id> --expected-core-profile-id <id> --write
   ```

   The ranking command may report unavailable and be omitted from promotion;
   true activation blockers may not.
7. Start one fresh Match and verify the captured Core identity, descriptor
   modes, season-variable rendering, semantic tags, deterministic evaluators,
   and Host context. Then archive the retired season and prune only through the
   registered lifecycle phases.

These steps intentionally separate reusable Common logic from replaceable
season, patch, Ranking, and Runtime-Match data. A new Host Agent should be able
to perform the update by changing version-owned inputs and running the shared
pipeline, not by rewriting Runtime or reconstructing project history.

## Current Activation Status

Every release reads activation blockers and known limitations from the selected
patch manifest and compiled candidate; this runbook never duplicates a static
season-specific blocker list. The current S18.1 manifest has no activation
blocker and has a registered MuMu Runtime mapping receipt. Its unresolved
shop-only entity remains an explicit bounded limitation. Missing compatible
S18 Master+ rankings are a nonblocking unavailable capability until Tencent
publishes data. Augment stages use the compiled current-patch authority; any
truly unknown stage remains search-only and never inherits another season's
stage evidence.

## Cross-Harness Entry

`data/runtime/jcc/harness-entrypoint-contract.json` is the stable machine entry
for Codex, Claude, Kimi, CI, and local operator harnesses. Consumers resolve the
versioning contract, pipeline, and named verification profile from this file
instead of maintaining provider-specific command lists.

The cross-harness contract does not become gameplay authority. It routes every
harness to the same pipeline and current requirements registry. A harness may
add presentation or process transport, but it must not skip phases, waive
blockers, infer an active version from directory names, or promote by editing a
pointer directly.

## Architecture References

The pipeline deliberately adopts proven boundaries without importing another
platform as a Runtime dependency:

- DataHub metadata ingestion inspires one registered Source Adapter per source
  shape, normalized output contracts, generated build artifacts, and a small
  core independent of optional connectors:
  `https://github.com/datahub-project/datahub/blob/master/metadata-ingestion/developing.md`.
- DVC inspires explicit, independently invocable pipeline phases and
  reproducible inputs/outputs:
  `https://dvc.org/doc/command-reference/`.
- Nix inspires immutable, content-addressed generations and rollback by moving
  a small profile pointer instead of mutating the active generation:
  `https://nixos.org/guides/how-nix-works/`.
- TUF inspires hash/length verification, explicit trusted metadata, rollback
  protection, and fail-closed publication:
  `https://github.com/theupdateframework/specification/blob/master/tuf-spec.md`.

JCC does not install DataHub, DVC, Nix, TUF, a workflow orchestrator, GraphRAG,
or a vector database. The data set and release topology are small enough for
the repository's typed compiler and Node pipeline; importing those systems
would add a second control plane without replacing JCC's game-specific schemas,
Runtime leases, or exact match-session boundary. Re-evaluate a framework only
if independent source adapters, remote workers, or cross-machine artifact
distribution outgrow this single-repository pipeline.

## Retrieval Architecture

Runtime retrieval is typed first:

- typed and reverse indexes own ids, aliases, stage/tier/category legality,
  trait breakpoints, boolean constraints, role semantics, complete Master+
  candidate-pool evaluation, national strength, atomic lineup variants, and
  season-specific trait-diversity roster lookup by the patch-declared supported input dimensions;
- deterministic formulas and current facts own calculation and match truth;
- MiniSearch supplies bounded lexical and fuzzy discovery for entity candidates,
  explanations, transitions, playbooks, and scoped Wiki text.

MiniSearch output is supplemental. Runtime validates any fuzzy entity against
typed identity and never lets lexical score alter a breakpoint, role, candidate
identity, lineup-strength order, or current-patch fact.

Heavyweight DAG, knowledge-graph, GraphRAG, vector-store, and model-driven graph
frameworks are not production Runtime dependencies. The product needs
deterministic typed joins, reverse indexes, explicit provenance, bounded
MiniSearch fallback, and immutable publication. A graph framework would add a
second relation authority, extra build/runtime lifecycle, nondeterministic or
model-dependent retrieval, and a larger failure surface without improving the
closed typed queries used during a live match. Offline analysis may use such
tools, but generated graph assets cannot become a promotion gate or Runtime
fallback.

## Failure And Rollback

Fail closed on an incomplete descriptor, source mismatch, path escape, hash
drift, unresolved collision, blocker, ranking incompatibility, or missing match
snapshot. Do not fall back to another season, an environment-selected patch
directory, retired rule fixtures, or provider memory.

Rollback restores a previously promoted immutable pointer pair. It does not
rewrite current files to resemble an older version. Keep historical source
packages, season descriptors, archive manifests, compact ranking diagnostics,
and match snapshot identities addressable so prior decisions remain
explainable.
