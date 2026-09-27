---
name: jcc-runtime-agent
description: Operate the JCC Runtime Coach when Codex or another CLI agent is the host model. Use for JCC runtime session boundaries, MuMu/ADB lifecycle, Start/Stop Match behavior, AI-native coaching response flow, mode-specific context injection, and safe Node-based runtime JSON read/write.
---

# JCC Runtime Agent

Use this skill when acting as the host CLI agent for the JCC Runtime Coach.

## Where This Skill Lives

App restart boundary: reopening Electron or replacing the Runtime Daemon retires the previous Match and queued work and starts a fresh lobby provider session, even after an unclean exit. A renderer reload in the same app and daemon is not a new session. Provider-only crash recovery may resume a route only while that same app/daemon owner remains live. Every Start Match creates a new independent Match conversation.

This skill is a repo-local Codex development surface. Codex App and Codex CLI can discover it from `.codex/skills/jcc-runtime-agent/SKILL.md` when an engineer or host-model workspace is opened inside this repository.

Production JCC Runtime must not depend on the host provider having this Codex skill installed. Kimi CLI, Claude CLI, Codex CLI, and future adapters may have different skill/plugin systems or no compatible skill system at all. Runtime behavior must therefore be delivered through:

- the compact `AGENTS.md` host shim copied into the host workspace;
- per-request `INPUT_JSON` selected context;
- `runtime_context` fields such as `game_state_brief`, `game_rule_contract`, `active_rules_bundle`, `match_facts`, `context_policy`, and mode-specific evidence;
- the host adapter contract implemented by `ui/electron/host-adapters.js` and `ui/electron/runtime-service.js`.

Treat this skill as the authoring contract and engineering checklist for JCC Runtime. Treat generated context packs and per-request selected context as the production delivery mechanism.

Host input rebuilds use `host-task-contract-registry.js` and `host-request-projection.js` before resolving current evidence. Do not copy an earlier materialized request into a new turn or correction. Ranking retrieval breadth, the at-most-ten complete Agent comparison candidates, and the final display count are different boundaries. `host-evidence-materialization.js` shares repeated values by verifiable local addresses without replacing native session continuity. `ranking-status-view-model.js` derives display state from the current Active snapshot and the independent update task. Metadata-only `host-turn-trace.js` events diagnose request sizes, dispatch, validation and renderer delivery; bytes and characters are not token measurements.

Active Ranking strategy index v4 stores mature recipe facts once per tier and keeps content-addressed relation references on candidates and variants. Runtime must materialize the requested candidate before scoring, projection, variant lookup, or Host delivery. Storage normalization is valid only when full materialization has the same expanded semantic hash as the pre-normalized index; it must never make complete rosters, equipment, transitions, or lineup variants optional.

Before reviewing or changing product requirements, read `docs/requirements/requirements-registry.json` and resolve the relevant `authority_domains` entry. Only `current` entries define acceptance criteria; `historical`, `paused`, and `generated` entries are non-authoritative evidence. Requirement changes must update the owning current contract, the registry, and `docs/requirements/CHANGELOG.md` together.

Host context lifecycle is machine-owned by `data/runtime/jcc/host-context-lifecycle-contract.json`. Use the provider-native long conversation (`Codex thread` or `Kimi ACP session`); do not build a JCC transcript/session replacement. Keep one persistent lobby provider process/session until app exit or explicit New Conversation and one persistent match provider process/session per Start Match. Repeated turns reuse the live owning provider process/session; provider resume/load is only for crash recovery, not ordinary turn dispatch, static-context refresh, or gameplay memory. Start Match separates the committed match boundary from Host/watcher readiness, surfaces retryable failures as degraded, and defers canonical renderer delivery until the new match stream is initialized. Stop Answer must preserve that provider transport even when cancellation is slow or not yet targetable; keep the task cancellation handle until the provider accepts cancellation so a later Stop can target the same turn. Stop Match must preempt any unfinished match-provider bootstrap before its serialized state cleanup; Stop Match and Clean Exit must confirm watcher process-tree termination before claiming clean completion. Clean Exit invalidates an active match route; the next launch must require a new Start Match rather than resume the cleanly closed match.

Provider transport ownership includes the provider, executable command, launch arguments, version, and provider-home isolation. Switching a transport-owning setting closes the old provider-native lobby and active-match conversations and bootstraps replacements on the selected CLI Agent. Changing only the selected model or reasoning configuration on that same live CLI transport updates subsequent turns in place and must preserve the native thread/session, history, and provider-owned compaction. Old-transport warmups and late completions lose route ownership immediately. Durable user preferences remain SQLite-owned across transport replacement and must be present in the replacement lobby's first static capsule; legacy JSON mirrors cannot override them.

This skill is not a fallback product authority. It is an authoring checklist and discovery entrypoint. If it conflicts with a registered machine contract, the registered domain contract remains the behavior authority and the mismatch is a release-blocking documentation/context-delivery defect that must be repaired. Do not make production behavior depend on a host provider loading this skill.

Version ownership is strict: provider-neutral coach instructions belong to `data/runtime/jcc/host-coach-instruction-contract.json`; reusable game doctrine belongs to `data/game-knowledge/jcc/common/`; major-season mechanics, special modes, and manual-variable field descriptors belong to `data/game-knowledge/jcc/seasons/<season_id>/season-descriptor.json`; ordinary minor patches belong to the selected patch source manifest, promoted Master+ ranking overlay, and optional audited patch strategy overrides. Derive each minor-patch candidate from the prior promoted patch's complete validated entity, stage, effect, alias, and parameter tuple, and apply only explicitly declared changes before publishing a new immutable generation. Common Electron and renderer code consume the immutable active Core Profile and compiled descriptors and must not name a season-only field. Use the exceptional audited rule-override path only for a real same-season timing or mechanic change.

For a major-season replacement, resolve the machine checklist from `data/runtime/jcc/harness-entrypoint-contract.json#major_season_update` and `docs/requirements/jcc-season-version-governance-runbook.md#major-season-agent-checklist`. Replace version-owned descriptor, patch, source, and compatible Ranking inputs; compile hard-data and Ranking tags through the existing Common vocabulary; audit unmapped semantics before adding a reusable Common tag; and let descriptor declarations drive any season UI. Never copy the retired season, infer identity from generated paths, or add season-named Runtime/renderer branches.

The Strategy Evidence Framework at `data/game-knowledge/jcc/common/strategy-evidence-framework.json` is part of that Common compile contract. Each version update rebinds Core and Ranking entities to its season-neutral routes and facets and audits unmapped semantics. Add a Common route, facet, or relation only when the concept is reusable across seasons; otherwise keep the mapping in the selected Core or Ranking generation. The Runtime implementation is `data/runtime/jcc/strategy-evidence-runtime-contract.json` and must remain version-neutral.

## Version Maintenance Architecture

Runtime writer ownership is bound to one process instance identity, including PID and observed process start time. A live process that merely reused an old PID does not retain the old writer lease. Recovery may remove the lease only when the same-host owner process instance is verifiably dead or replaced; live matching, remote, malformed, ownerless, and otherwise unverifiable leases still fail closed.

Use one modular lifecycle for every version update:

`source adapter -> compile immutable candidate -> verify -> explicit promotion -> archive/prune`

- **Common** owns season-neutral knowledge under `data/game-knowledge/jcc/common/`.
- **Season** owns major-season mechanics and UI/runtime extensions in one descriptor under `data/game-knowledge/jcc/seasons/<season_id>/`.
- **Patch** owns values, provenance, explicit audited exceptions, and a candidate reference to one immutable normalized hard-data generation under `data/core-patches/jcc/generations/<hard_data_generation_id>/`.
- **Live Rankings** owns the only production big-data source: Zhangmeng/Tencent Master+ rankings and their typed strength, recipe, hero-heat, and item evidence. The pinned S18 DataTFT snapshot remains an offline, immutable production Core supplement for declared hard-data enrichment roles such as reward-rate tables, trait tracking, and champion/item/sprite expansions; it is not a Ranking authority, live Runtime retrieval source, or network-refresh target. Minor patch deltas apply on the latest promoted Core baseline.
- **Generated** owns content-addressed Core Profile artifacts and isolated candidates; never hand-edit or mutate them in place.
- Daily Ranking/Recipe retention follows active and pending Core pointers, not every Core backup retained on disk. Prune retired-Core candidate references and exclude those generations from ordinary history retention, while protecting active publication closures and live Match leases until release.
- **Runtime** owns small active pointers, captured Knowledge Snapshot identities, generation leases, and current facts; it does not compile source material.

The Source Adapter writes only to guarded staging, then publishes immutable content-addressed hard data and updates the patch candidate reference under the same lifecycle lock used by pruning; it never rewrites bytes used by the active Core Profile. The lock owner document is written in a temporary sibling directory before that complete directory is atomically renamed to the canonical lease path. The lock may recover only when a same-host owner process is verifiably dead and must never preempt a live, remote, malformed, or ownerless lease. Direct monolithic hard-data builders and collectors are retired; writable source work must enter through the registered patch adapter and reject active or `generations/<hash>` targets before any delete or write. Compile Common plus exactly one Season and one Patch into a candidate Core Profile that also contains the decision-input catalog, augment-stage authority, and Runtime catalog overlay. Carry true incomplete release inputs as `activation_blockers`. Run `rankings` against the explicit current Core Profile, season, patch, and catalog identity to publish the immutable Zhangmeng/Tencent Master+ Ranking Overlay; `intelligence` is only a compatibility alias. The pinned S18 DataTFT snapshot remains an offline Core supplement for its declared hard-data roles, is never a daily Ranking publication, Runtime retrieval source, or network refresh target, and is inherited before an explicit minor-patch delta is applied. Missing compatible Master+ rankings reports an unavailable ranking capability without blocking Core release or using a foreign version. Verify and promote the exact Core candidate separately. Start Match captures one compatible Ranking Overlay or explicit unavailable identity and one exact-Core active recipe generation or explicit unavailable identity, and fixes them with the Core snapshot for the full Match. Archive and prune preserve active, previous last-known-good, candidate, leased Core generations, active recipe generations, and the offline S18 supplement.

A catalog's declared primary source owns production entity membership. Supplemental sources may enrich a matched canonical entity with audited aliases, availability, categories, or lifecycle metadata, but unmatched supplemental rows remain audit-only unless the patch manifest explicitly grants that source entity authority and a registered verifier proves the bounded scope.

Stable equipment player aliases belong to a Common data document; champion and other version-owned player aliases belong to the selected patch. Core compilation binds both against the exact current catalogs, publishes one compiled alias gateway, and keeps unbound Common entries inactive. Patch aliases fail compilation when they do not bind uniquely. Aliases may drive typed search and language resolution, but canonical entity ids and names remain the only persisted facts. Never restore hardcoded player-name tables in Runtime JavaScript.

When one canonical champion has source-specific aliases or season forms, the patch manifest owns the audited source-id mapping. Compilation keeps one canonical champion, preserves the matched form and trait as typed variant metadata, and exposes the same mapping to Runtime sensing, national rosters, winning recipes, and popular recipes. Never count those forms as separate champions or drop an atomic roster because a source used the form-specific id.

For differently named rows, deterministic enrichment may use only a declared alias, identical normalized effect content, or a unique same-tier resource identity with the same effect-number signature. Record the match kind and keep changed-number or ambiguous rows audit-only. Preserve every reward inside one selected probability outcome as one atomic bundle, and expose compiled reward/mechanic tables through bounded typed retrieval rather than the static capsule.

Treat supplemental lineup tools for a season mechanic as patch companion hard data rather than ranking evidence. The patch contract must declare which source variables and branches the product supports; the Source Adapter discards undeclared branches and retains only the bounded candidate population needed by that policy. Normalization preserves each retained candidate as one atomic roster and publishes one small immutable descriptor plus bounded hash-addressed shards over the declared dimensions. Source candidate-row and repeated unit-slot counts are diagnostics, not distinct final-recommendation or champion counts. Relevant augment entities carry only an objective id and support reference. Compile only the descriptor identity and hash, objective metadata, supported dimensions, shard manifest, and retrieval policy into the Core Profile. Runtime validates and loads at most one bounded matching shard for a relevant request, never fetches the source website during a match, never splices two source rosters, and never presents the tool's objective score as Master+ lineup strength.

Use `data/runtime/jcc/harness-entrypoint-contract.json` as the machine-readable cross-harness entry for the versioning contract, pipeline, and verification profiles. Provider-specific harnesses must not maintain a separate release sequence or waive blockers.

Production retrieval is typed first. Typed and reverse indexes own entity identity, legality, exact constraints, role semantics, formulas, and complete Master+ candidate evaluation. MiniSearch is a bounded lexical/fuzzy supplement for validated entity discovery, explanations, playbooks, transitions, and scoped Wiki text; it must not alter typed conditions, strength, or hard facts. Heavyweight DAG, GraphRAG, vector-store, knowledge-graph, and model-driven graph frameworks are not Runtime dependencies because they would introduce a second relation authority and a larger, less deterministic lifecycle without improving these closed typed queries. Offline analysis remains separate from production artifacts and gates.

Keep the lightweight controlled semantic feature layer inside the four existing owners. Common defines a closed season-neutral vocabulary and interpretation domains. Core compiles deterministic hard-data features from the selected immutable source generation. The existing daily Ranking refresh compiles lightweight lineup-recipe features into its exact Core-bound overlay. Runtime maps only verified current-Match typed facts to temporary feature values in bounded memory and discards those mappings with the Match. This is not a fifth data pipeline, GraphRAG, vector or embedding authority, LoRA, fine-tuning, or a learned feature store. Semantic features may annotate and explain existing evidence, but they cannot override typed facts, legality, provenance, atomic variants, Master+ metrics, or the registered meta/augment/item/tempo/board weights, and they cannot become a sixth score component.

The Common Cruise vocabulary is `data/game-knowledge/jcc/common/cruise-decision-framework.json`; Runtime orchestration is owned by `data/runtime/jcc/cruise-strategy-semantics-contract.json`. For Cruise and direct strategy questions, resolve one current-Match snapshot, map verified facts and Match-pinned Core effects to Common features, call only relevant existing deterministic domain evaluators, normalize equivalent actions, and resolve mutually exclusive actions with stable typed reasons. Attach one bounded integrated evidence packet to the existing answer owner. Opening-injected Common doctrine remains required for non-numeric judgement; neither layer is a global score, a replacement strategy engine, or permission for supporting evaluators to emit separate answers.

All direct questions, no-big-data turns, structured-card advice, lineup cards, and proactive Cruise decisions also pass through the shared Strategy Evidence Kernel. Runtime supplies one immutable evidence snapshot, multi-route plan, facet coverage receipt, and bounded first evidence packet. The Host Agent understands the question, refines its internal plan, weighs tradeoffs, and answers inside the same logical provider turn. When the provider supports registered custom tools, expose visible snapshot-bound read-only `jcc.query_knowledge` and `jcc.calculate`; otherwise prefetch the complete critical packet and reconcile satisfied receipts against evidence actually present in the turn payload. Codex must retry bootstrap without `dynamicTools` only when the installed app-server explicitly rejects that field, then record `prefetch_complete` for that live session. Do not substitute repository file browsing or a separate planning-model turn. Normal turns target zero to two tool calls; only complex multi-domain questions may use up to six total calls. Ordinary turns use a 1 MiB soft target and 2 MiB absolute current-turn ceiling; fixed strategic turns use a 4 MiB soft target and 8 MiB absolute ceiling. Three expansion cycles are guidance because providers do not expose a portable cycle counter. The complete serialized current-turn prompt, tool arguments, and results share the owning turn's byte budget, separate from the static capsule, and native-tool turns reserve at least 32 KiB before dispatch. Every call binds to the exact provider thread/turn and immutable Match/Core/task/card/action identity; stale or cancelled calls fail closed. Normal persistence may advance the same response-task revision without invalidating its owner, but task replacement, choice report/revision changes, and decision-action changes invalidate old tools. Tools cannot widen source policy, mutate Match facts, or create a sibling answer.

Augment choice is its own season-neutral three-candidate decision evaluator. It consumes Match-pinned Core augment profiles, current facts, canonical target authority, and an optional deduplicated Ranking association prior. The association baseline must exclude the lineup score's existing `augment_fit`, so compatibility is counted once. Emit `top4_objective_fit` and `first_objective_fit` as decision-fit evidence rather than placement probabilities. The Host remains the final explanation owner and may change evaluator order only for a typed newer or omitted current fact. Never restore a shared season taxonomy or entity-name scorer branch; new-season semantics enter through the Common vocabulary extension policy and that season's Core compilation.

For transition advice, use the Zhangmeng/Tencent published transition chain attached to the selected atomic lineup parent whenever one exists. Local Runtime adaptation is restricted to validating legality against the captured Core Profile, filling only explicit missing population slots within the current verified level, making one role-compatible temporary main-carry or primary-tank substitution, preserving continuity for proven-owned equipment, and rearranging the trusted current self board. Keep source parent and provenance explicit. A locally completed or substituted transition is current-Match adaptation evidence, never Master+ strength or a newly published recipe. Do not splice parent or sibling variants, enumerate alternatives into a reusable candidate set, or build an all-combinations lineup library.

Windows desktop-entry and installer behavior is owned by `data/runtime/jcc/windows-distribution-contract.json`. Keep the repository shortcut and public installer shortcut separate: local development may use the hidden Node launcher, while a player installation must target only the installed executable, create desktop and Start Menu entries, expose a visible cold-start window, recover a hidden owning BrowserWindow through the user-scoped local activation channel with native single-instance activation as the bounded fallback, preserve single-instance focus, and pass the packaged install/uninstall smoke gate. A background process with no visible window is not a successful launch. Do not treat an Electron-builder configuration file by itself as proof that the public package is ready.

## Core Rule

The runtime is not a standalone model service. The current CLI agent is the host model. Backend tools collect facts and generate compact context; the host model produces final AI-native coaching text.

This contract is CLI-agent neutral. Codex CLI is the first supported host adapter, but Claude CLI, Kimi CLI, or another CLI agent must follow the same session boundaries, selected-context flow, response-task cancellation behavior, and Node JSON backfill rules. Do not change runtime semantics just because the adapter changes.

Use generic "host CLI agent" language for product behavior. Use "Codex" only when describing the current Codex adapter implementation or Codex-specific troubleshooting. Do not use Codex session resume as a runtime memory mechanism.

JCC Runtime Daemon owns runtime state. Electron UI calls `ui/electron/runtime-daemon-client.js`, which talks to the independent daemon process in `ui/electron/runtime-daemon-server.js`. The core daemon class lives in `ui/electron/runtime-daemon.js`. The daemon keeps durable/lightweight state in `app.sqlite` through `ui/electron/runtime-state-store.js`, provides the already-open writer used by runtime-service semantic events, marks selected legacy JSON as coalesced non-blocking compatibility mirrors/debug exports, exposes HTTP/SSE/WebSocket transport with a local token, and delegates AI-native wording to thin host CLI adapters. Do not reopen SQLite once per observed semantic event from runtime-service.

Do not show backend scorer drafts as final advice. Treat them as structured evidence for a host-model answer.

Do not ask the host model to "remember" this repo-local skill. Bootstrap its distilled static coach protocol, common rules, active version data, rankings, and scoped Wiki once into the owning persistent provider session. If the static fingerprint changes while that session is alive, replace the static capsule once in the same session; do not open or resume another session. The provider owns transcript history and native context compaction. JCC must not replay prior chat messages or synthesize a replacement conversation history. Every later turn carries only the current facts, active mode, current user intent, current checkpoint state, and missing-information state needed for that answer; it must not resend the full static bundle. Host conversation memory supplies continuity, while SQLite remains the source of truth for mutable match state.

Keep the implementation split into Runtime-only request metadata, one versioned static provider-session capsule, and a bounded current-turn delta. Production selects pending request events in process and keeps the complete provider payload only in memory for the active turn. Persist only metadata references in SQLite, queues, and lifecycle state; recursively replace every nested `host_request` before canonical persistence, and never serialize full hard data, raw daily rankings, or complete request events through a helper process or diagnostic stdout. Keep the static capsule as a compact knowledge map with an approximately 50K-token allowance and a 256KB absolute serialized ceiling; it may include up to 12 approved personal strategy rules, eight scoped Wiki summaries, and 12 current-day Master+ lineup families. Include one combined full-source fingerprint so source drift refreshes the capsule without copying full source payloads. Fetch exact entities and current-day Master+ ranking evidence through typed indexes. Deterministic game math follows the same boundary: Common owns the normal round schedule, player damage, economy, progression, star-up, shop odds, shared-pool sizes, single-hit damage rules, formulas, and evaluator contracts under `data/game-knowledge/jcc/common/`. The captured Core Profile supplies champion values, item/augment/trait modifiers, caps, season-mechanic effects, and only explicit verified exceptions to Common; a compiled copy of a Common table is not a second authored authority. `ui/electron/decision-math-service.js` may attach one bounded `decision_math_context` for numeric/stat/probability requests or typed current-Core entity, lineup, transition, item, and augment strategy evidence; unresolved conditional effects remain explicit and bounded theorycraft is never presented as an exact combat simulation or ranking strength. User rank preferences may change coaching style, but never select Platinum-Diamond or all-tier ranking data. Use a 1 MiB relevance-first soft target and 2 MiB absolute in-memory ceiling for ordinary turns, and a 4 MiB soft target with 8 MiB absolute ceiling for fixed strategic turns. The static capsule remains separately capped at 256KB. Build smaller packets when enough, reduce only when a complete turn would exceed its soft target, fail closed above the applicable absolute ceiling, and never persist the complete turn. Successful diagnostics remain independently capped at 64KB and are default-off; enabled fault evidence is compact, asynchronous, retained for at most seven days, and cannot gate or delay canonical delivery. Environment and user configuration may lower these absolute byte ceilings but must never raise them.

The Cruise `hard_data_query` entry is an explicit UI evidence capability, not a phrase classifier. It is valid only with `origin_action_id=cruise_no_big_data` and `evidence_policy_id=active_core_profile_only`; manually typing the same visible prefix is an ordinary question. On a valid turn, bypass daily ranking, Meta Map strength, winning-lineup recipe, hero-item ranking, strategy Wiki, cached strategy packet, and rank-derived proactive inputs before retrieval. Build one captured-Core-Profile decision snapshot, run every requested domain evaluator, and let the Host explain only the returned result, assumptions, defaults, missing fields, unresolved effects, and source audit. This isolates decision sources even though a persistent provider may remember earlier ordinary ranking turns. Ordinary Cruise strategy questions use the same typed current-Core entity, lineup, transition, item, and augment retrieval and may additionally receive compatible ranking evidence. A compact catalog name map never substitutes for or disproves exact current-Core details. Equipment, augment, and lineup adapters share policy, identity, missing-input, and provenance infrastructure but keep separate candidate legality and objectives. Item theorycraft defaults to normal completed items; special categories require explicit request or confirmed ownership. A specific unresolved target entity is critical, but an explicitly delegated open lineup or core choice uses bounded deterministic current-Core selection instead of requiring the user to name a carry or tank. Clarify first only when at least three other material fields remain missing and no delegated default can answer safely; fewer missing fields use declared defaults with disclosure. Descriptor-owned season-mechanic effects are included only when confirmed; otherwise omit them and disclose the omission.

The Cruise `查热门阵容` entry is a second explicit UI-only capability with `request_kind=popular_recipe_query`, `origin_action_id=cruise_popular_recipe_query`, and `evidence_policy_id=popular_recipe_catalog_only`. It queries only the immutable popular-recipe generation captured by Start Match. It must not read current-match facts, Master+ strength, winning recipes, hero/item rankings, Wiki, hard-data theorycraft, provider memory as evidence, or any Cruise score. Return source templates and always state that they are not strength recommendations. Winning recipes, official popular recipes, and national Master+ atomic rosters reuse one non-conflicting exact-refresh auxiliary-unit registry. Keep explicit non-champion source rows such as pets and summons as typed `auxiliary_units`; do not resolve them as champions or count them toward champion population unless the source explicitly declares that behavior. Keep an explicitly source-typed hero missing from the current Core Catalog as a population-occupying `external_roster_unit`; it cannot enter typed champion matching, role inference, hero indexes, or strength until mapped. Missing supplementary augment or item references must not discard the atomic roster.

Compile equipment requirements without season or lineup special cases. Keep source-row required items on their atomic final variant and promote them to group requirements only when every final variant agrees on the same item, role, and holder. Treat an external-holder emblem as formation-required only when its granted trait resolves uniquely through the active hard-data trait catalog; missing or ambiguous grants fail closed.

The runtime may use parallel deterministic workers for sensing, normalization, lookup, scoring, and aggregation. Those workers are not separate visible coaches. Merge worker outputs through the Runtime Orchestrator and let the host CLI model produce the one final user-facing answer.

One user interaction has one strategy-answer owner. A direct chat message is
answered by its direct `response_task`; semantic events derived from that same
message update selected context and must not enqueue sibling Host CLI answers.
Keep provisional `latest_user_intent` separate from durable `target_plan`.
If a direct user or structured-card answer owns the Host lane while a lineup-
convergence checkpoint is pending, rebuild that agenda from the latest
verifiable stage and fold only its still-material action into the same answer.
Successful delivery closes the absorbed checkpoint; failed or cancelled
delivery keeps it retryable. Never replay an older stage, and never reopen one
from its historical stage while the current stage is missing.
`target_plan_changed` is context-only; later stage, choice, equipment-fit,
economy, HP, or strategy-fit events may use it to decide whether proactive
coaching is warranted.

Ordinary chat never writes choice candidates, final selections, equipment, or
match variables, even when it says "I chose" or names a pending active-season
mechanic. Such chat remains direct Host conversation and may update provisional
intent. The explicit Cruise Quick Record control is a separate
`match_fact_capture` request kind. Its Host turn proposes only closed-schema
fact operations; Runtime independently resolves active-catalog names, stages,
equipment categories, holders, and descriptor variables before one sparse
current-match update. Its Agent response is a factual receipt generated from
what actually persisted, never strategy advice or a target-plan assertion.
Quick Record keeps its own 128 KiB target and absolute request ceiling even
though ordinary coaching turns may use 1 MiB / 2 MiB and fixed strategic
coaching turns may use 4 MiB / 8 MiB. Repeated inventory facts are aggregated and
this write-only path never inherits unused strategy evidence capacity.
Visible text alone cannot activate this authority. Structured cards remain the
normal direct editing surface.
Manual match-variable confirmation may show an operational status immediately,
but it is a context-only fact update and must not open a separate Host task.
The next user-owned advice or fixed strategic checkpoint absorbs the
still-material opening-variable judgment. Before confirmation, keep any advice
focused on ranking the three augments and refresh decision; begin candidate
lineup directions only after the first augment is confirmed. Recent lineup intent may
inform later strategy-fit, economy, equipment, and stage decisions as
`provisional_user_intent`, but it must not silently become a durable target.
At every registered augment checkpoint, preselection advice is incomplete until
it contains the exact three reported candidates once each in best-to-worst
order and one explicit keep/refresh action. Missing, duplicate, or out-of-report
ranking entries are invalid. Missing
augment or descriptor-owned season choices block only a request that asks which
option to take in that exact active choice window; other user-owned actions in
any stage answer first and mention the missing choice afterward when useful.

An explicit structured-card advice action owns one `structured_card_action`
response task in the card's registered backend mode. Final confirmation is a
state-only action and must not open a Host response task.
It is a user-owned card interaction, not automatic cruise advice: choice-window
reservation, automatic stage expiry, and a punctuation-only status ping must
not cancel or replace it. Keep unconfirmed tier, stage, candidates, target note,
and selected option for the current match across temporary mode changes. Reset
that draft only when the canonical match boundary changes. Return to cruise
only after the card response reaches terminal delivery and the renderer ACKs it.
Normal canonical persistence may advance the same task revision while task id,
match, mode, origin, event key, and accepting status remain unchanged. Treat
that as the same owner and keep the Host result; only cancellation, replacement,
match mismatch, or terminal status detaches it.
Candidate-bearing saves and advice require the current canonical report binding;
stale cards cannot overwrite newer candidate sets. Final confirmation may
rebase only inside the same match, stage, and choice kind when slot plus ref or
exact name still matches the current canonical set. Fact-only equipment writes
ignore stale surrounding card bindings. Show final-confirm success only after
persistence succeeds. Reconfirming the same exact choice is idempotent, and the
semantic observer must not create a sibling answer for that confirmation.
Scope each card revision to the active match, backend mode, choice kind, and
stage. A later checkpoint in the same mode starts with a fresh r0 binding;
reopening the same checkpoint preserves its draft and current revision. Promote
the owning card's exact report into the Host request as
`current_match_user_report` choices. Never let an older observed/game-state
fallback candidate set replace the card candidates that own the answer.
Store reports by that exact scope. Concurrent identical submissions share one
idempotent report identity; a stale submission with different candidates still
fails closed.

Continuous observation and visible coaching are separate layers. Raw shop,
gold, board/bench, item, or snapshot changes update canonical facts and
immutable latest decision snapshots only; they must not directly occupy the
Host response lane. A local deterministic scorer may derive a typed decision
delta such as interest/lock, key-unit progression, item posture, economy timing,
HP pressure, or commit/pivot. Only a materially changed derived decision with an
explicit priority, cooldown, stage/choice gate, expiry rule, and audit evidence
may enter the decision agenda and trigger one proactive Host answer. Normal
proactive cadence is at most one visible answer per one to two rounds unless a
higher-priority registered decision supersedes it. Choice windows remain owned
by their explicit current-match user-report workflows. Never infer a win/loss
streak when the runtime has no structured streak fact or explicit user plan.
Each admitted proactive semantic event owns one `runtime_event_followup`
request. Scorer tasks are supporting evidence and must not become sibling
answers or substitute for the event focus.
Without a durable target, Cruise proactively advances a lineup-convergence
agenda: stage 2 offers two or three evidence-backed candidates; after 3-2 it
narrows to a primary and backup with carry, tank, and roll level; 3-5 through
3-7 recommends relative convergence or explains why the next major choice is
still worth waiting for; after 4-2 it gives commit/pivot execution. This does
not require the player to press a shortcut. Season mechanics enter only through
the compiled major-season descriptor.
With a durable target, Cruise does not reopen generic candidate discovery, but
from 4-2 onward it still owns an automatic target-execution checkpoint: validate
continue versus exit conditions and state the immediate roll, level, economy,
item, or transition action. The lineup-direction shortcut is only an explicit
on-demand re-evaluation.
Keep the proactive trigger inventory and every semantic category allowed to
reserve or open the Host answer lane, including priority and cooldown, in
`data/runtime/jcc/runtime-ui-mode-contract.json`; do not maintain a second
runtime-only admission list. Fail closed for unregistered categories. Apply
cooldown per decision trigger, with a small
global anti-noise interval, so one shop/economy action family does not suppress
a different urgent action. Defer a choice-window decision at most to the
immediate post-choice stage, let later advice consume the confirmed-choice context, and
suppress/recompute proactive answers by decision relevance rather than by any
whole-live-state change. Ordinary unrelated churn must not cancel stable
economy, tempo, lineup-direction, or equipment advice while that advice's own
action fingerprint remains unchanged. A newer same-family
decision, an exact shop/bench change, or a choice/major-stage boundary makes the
older action stale. Exact shop/bench freshness fails closed when its required
material fingerprint is absent, and every non-durable proactive answer fails
closed when the current stage is unavailable. Scorer-driven proactive events
must use the same registered decision-trigger fingerprint domain at admission
and delivery. A registered decision-stable category may survive at most one
ordinary round.

The runtime may also use optional CLI-native specialist subagents for complex or background AI-native analysis. Use them for cruise strategy forks, multi-opponent lobby analysis, postgame review, and strategy memory conflict checks. They inherit the host CLI model by default unless the user explicitly configures otherwise. Specialist subagents must return compact structured analysis packets to the Runtime Orchestrator; they must not write final user-visible coaching text.

## Session Boundaries

- `device_connection`: MuMu / ADB connection. It may stay alive across games. Stop Match must not disconnect it.
- `daily_session`: daily chat, postgame review, user strategy memory, and settings share one persistent lobby provider process/session. It lasts until app exit or the user explicitly clicks New Conversation. New Conversation closes only that lobby native conversation and bootstraps a new one; it does not clear durable preferences, Wiki, review records, MuMu, or an active match.
- `match_session`: one game. Start Match first requires a new canonical `match_session_id`; only then may it close the prior match provider route and clear match-scoped state. Exactly one SQLite match-session row may remain active. It starts one persistent match provider process/session, injects the static capsule once, and waits for that bootstrap readiness before returning. A provider bootstrap failure remains attached to the new match as retryable readiness and must never restore the old match. Match-scoped state includes `live_state`, `advice_task`, manual match variables, match context, user-confirmed equipment, user-confirmed scouting notes, current watcher events, response/decision snapshots, visual/HUD work, latest match mirrors, and match-owned queue rows. Before Start supersession or Stop reset clears those fields, build one compact structured postgame summary and persist it in the closed SQLite session payload. Retain at most 20 such summaries for lobby review; never retain raw screenshots, full live-state dumps, full Host request bodies, or unbounded diagnostics as review memory.
- `response_task`: one model answer inside the owning lobby or match provider session. The input-box square Stop cancels only this response. It does not close provider sessions, change the active mode, clear live state, stop MuMu, or end the match.

Start Match means new game session. It is not MuMu reconnect.

Stop Match means immediately preempt any unfinished match-provider bootstrap, end the current match session, close its match provider process/session, and return to the existing lobby provider process/session. It is not device disconnect.

Exit means close all lobby, match, provider, watcher, OCR, daemon-owned child, and app runtime resources.

## Context Injection

Use short generated context packs instead of loading all project docs.

JCC Runtime owns the world state. The host CLI adapter keeps the owning lobby or match provider process/session alive and streams each new turn through the provider-native conversation. The provider retains chat history and performs its own context compaction. JCC sends no prior-turn transcript replay. The session may retain the static context capsule injected at bootstrap, but it is never the authority for mutable daily or match facts. If a changing fact matters for an answer, the Runtime Orchestrator includes that current fact or a compact state summary in the current turn delta.

Static common host instructions, common game doctrine, active major-season rules, active minor-patch hard data, daily rankings, strategy wiki, economy doctrine, and season catalog context may be bootstrapped once per provider-session fingerprint. A changed fingerprint is a versioned in-session static-context update when the owning process/session is still alive, not a new session and not a resume operation. Dynamic current facts are still sent every turn: response identity, mode, current_turn_contract, live_state summary, match variables, confirmed choices, current user message/intent, semantic event focus, missing facts, and cancellation state. JCC Runtime SQLite remains the authority; provider memory is only a cache and must not be used to recover or overwrite runtime-owned facts.

Minimum host request contract:

- `host_session_kind`, `active_mode`, `match_session_id`, and `response_task` identity.
- Current resolved live facts needed for the answer, especially `phase.stage_round`, `economy.hp`, `economy.gold`, `economy.level`, `economy.xp`, board/shop/bench summaries, and item facts when available.
- Current match variables and user-confirmed choices. Observed choices are not final selections.
- Latest user intent, with newer match-session statements overriding older conflicting direction.
- A `capsule_ref` to the already-loaded common/season/hard-data/ranking/Wiki context plus the compact current `game_state_brief` and current-turn authority fields. Do not resend the full `active_rules_bundle` or old conversation transcript.
- Any missing critical facts the model should ask about instead of guessing.
- Compact hard-data, big-data, strategy wiki, itemization, or catalog evidence only when the mode or message needs it.

Electron runtime state paths and JSON IO are centralized in `ui/electron/runtime-state-store.js`. Treat `JCC_RUNTIME_DATA_DIR` as the runtime data-root override. `.jcc-runtime-data/app.sqlite` is the default canonical durable runtime store; legacy `.omx` JSON files are compatibility mirrors, debug exports, or one-time migration sources only. Do not scatter `.omx/state` path construction into host adapters, response-task code, or mode handlers.

Runtime state store schema `jcc-runtime-state-store-v5` records migrations, daemon-managed queue lifecycle, queue inspection, structured logs, and strategy wiki state in SQLite. Queue work must support claim / complete / fail / retry / stale-lock recovery through the daemon instead of ad hoc JSON files. Strategy wiki work must keep immutable `wiki_source_events`, draft/published/stale `wiki_pages`, and `wiki_curation_runs`. Durable-state JSON mirrors must be written through `writeLegacyJsonMirror` so they carry the explicit `app.sqlite` canonical-store marker.

Do not recreate `app.sqlite` on every launch: it is the durable home for user preferences, Wiki, review records, session boundaries, and canonical runtime facts. Bound only disposable diagnostics and terminal queue history. Startup, Start Match, Stop Match, and clean exit enforce retention; Stop Match and clean exit truncate-checkpoint the WAL. Wiki pages are durable, while a Wiki curation request uses one canonical run id end to end; unfinished runs expire after 24 hours and terminal runs plus unreferenced source inputs rotate under the machine contract. Run `node tools/maintain-jcc-runtime-db.mjs --vacuum` only while JCC Runtime is stopped; the tool must reject an active daemon writer lease. Run `node tools/prune-jcc-runtime-local-artifacts.mjs --apply` to remove allowlisted long-replay and temporary verification artifacts without touching canonical state, current watch files, provider sessions, or rankings. Once a season has a valid registered archive and is neither active nor a candidate, `node tools/maintain-jcc-runtime-db.mjs --reset-retired-version-runtime --season-id <season_id> --vacuum` followed by `node tools/prune-jcc-runtime-local-artifacts.mjs --retired-version --season-id <season_id> --apply` is the explicit full prior-season cleanup. The first command writes the same-season DB reset receipt required by the second. That path deletes prior Match/review summaries, transient Wiki curation inputs, compatibility match mirrors, monitors, calibration captures, and generated reports while preserving published Wiki, preferences and memory, the daily session, provider-native history, Core Profiles, rankings, source archives, plans, and dependencies.

Run on runtime startup:

```bash
node tools/build-jcc-host-agent-context-pack.mjs --scope startup
```

This checks hard data, catalog, live rankings status, user memory entry points, and available tools. It must not auto-scan MuMu ports.

Run after Start Match:

```bash
node tools/build-jcc-host-agent-context-pack.mjs --scope match --match-session-id <id>
```

This injects current-match rules, watcher commands, cruise mode, and pollution guards.

Run when a focused mode becomes active:

```bash
node tools/build-jcc-host-agent-context-pack.mjs --scope mode --mode <mode_id> --match-session-id <id>
```

Mode-specific context is lazy. Mode packs are loaded only when that mode becomes active, so the host model does not carry every mode's details at once.

Runtime evidence inside a host request is also policy-gated. Always include only tiny session facts such as `host_session_kind`, `active_mode`, device status, match status, and host CLI settings. Attach heavier strategy evidence only when the mode or user message needs it:

- Attach `user_preferences` for cruise, any active compiled choice mode, item choice, lineup/self-board placement, postgame review, user preferences, strategy wiki, or any strategy-intent user message.
- Attach live ranking / daily big-data summaries for cruise, any active compiled choice mode, item choice, lineup/self-board placement, postgame review, or any strategy-intent user message.
- Attach `season_catalog` for cruise, any active compiled choice mode, item choice, lineup/self-board placement, postgame review, or any user message about lineups, members, champions, costs, traits, reroll comps, carries, tanks, or current-season strategy.
- Attach `itemization_context` for item choice mode or user messages about equipment, components, completed items, artifacts, radiant items, anvils, perfect items, main-carry items, sub-carry items, or whether to craft now. Build it with:

```bash
node tools/build-jcc-itemization-context.mjs --champion <name>
```

If no holder/carry is known, use `--summary-only` and ask for the intended holder or use current live_state holders. Itemization context is candidate evidence, not an automatic craft command.
- Do not attach ranking summaries for ordinary greetings, Stop response, Start/Stop Match plumbing, window actions, or pure connection/setup actions.
- Every host request should carry a compact `runtime_context.context_policy` explaining whether strategy context was attached and why.
- Ranking ids such as `83110103_6` are backend-only signals. If ranking context has `display_name` / `trait_name`, use those names in final answers and do not expose raw ids to the user.
- Current-season champion names are not optional. For lineup/member/champion questions, use `season_catalog.champion_names` and `season_catalog.champions_by_cost` as the allowed set. Do not fill gaps from general League/TFT memory. If a name is absent, say it is absent from the current season catalog or ask for clarification.
- For item questions, answer the action, not just the item name. Use `slam_now`, `wait_component`, `temporary_holder`, `hold_for_artifact_or_choice`, or `do_not_craft_yet` when possible. Live HP, streak, stage, board strength, holder quality, remover/reforger access, selected augments, traits, encounter/god/observer variables, lobby tempo, HP pressure, and user-confirmed scouting notes override daily big-data item priors. Do not infer opponent board, power, or positioning facts.
- Current-day hero item packages are daily ranking priors. Keep the literal highest observed top-one package separate from the most-used package, preserve artifact/radiant tags, and never phrase either as an unconditional perfect three-item truth.
- `champion_item_fit` can shortlist completed, artifact, radiant, support, emblem, and special item candidates for a main carry or sub carry. It is a hard-data candidate ranking; current game state still reranks it.

When the mode needs parallel backend work, build the deterministic worker plan:

```bash
node tools/build-jcc-runtime-worker-plan.mjs --mode <mode_id> --match-session-id <id>
```

Use the worker plan to understand which facts can be computed in parallel. Do not spawn multiple hot-path LLM subagents for every shop tick, augment reroll, item choice, or user interjection.

If the worker plan contains an `optional_specialist_agents` group, the host CLI agent may dispatch those specialists in parallel while it continues non-overlapping orchestration work. Treat their outputs as `jcc-runtime-specialist-analysis-packet-v1` evidence, merge them into `orchestrator_context.specialist_packets`, and then produce one final answer from the main host model.

Never use specialist subagents for:

- first augment reroll response
- ordinary shop hold/sell tips
- item choice short answer
- immediate user interjection recompute
- any path that requires sub-second output

## Mode Context IDs

Use the common mode IDs below. Append season-only mode IDs from the active
compiled season descriptor; do not add them to this common list.

- `daily_chat`
- `postgame_review`
- `user_preferences`
- `strategy_wiki`
- `cruise`
- `augment_choice`
- `item_choice`
- `lineup_card`
- `refresh_self_state`
- `manual_match_variables`

Mode packs may contain different instructions, but they are context packs, not separate skills.

## Runtime Tool Rules

- Read and write runtime JSON with Node tools. Do not use PowerShell `Set-Content` or ad hoc shell redirects for host response JSON.
- Route Electron runtime actions through the daemon client/server pair. Do not call runtime-service directly from Electron IPC, and do not let host CLI sessions own daily/match/live_state memory.
- Use the per-daemon local token for daemon state/events/actions/queue lifecycle/logs/shutdown calls. Prefer WebSocket events with SSE fallback. Electron should not shut down a reused daemon process that it did not start.
- Use `tools/write-jcc-host-agent-json.mjs` for JSON backfill.
- Use `tools/start-jcc-new-match-session.mjs` for Start Match.
- Use `tools/discover-jcc-mumu-adb-target.mjs` only when the user clicks Connect/Re-scan MuMu in settings. Do not run it on every startup.
- Keep screenshots transient. Default output is structured JSON only.
- MuMu bridge is authoritative for units/shop/phase when available. Structured sources, HUD ROI OCR, diagnostic-only owned-augment text-panel inspection, and current-match user-reported choice candidates are the product sensing boundary; host multimodal vision is fallback evidence for missing or ambiguous current-frame facts outside active choice-candidate intake, not the default truth source.
- Opponent board/power/positioning modes are intentionally not product paths. MuMu does not expose reliable opponent unit identity for those workflows, so runtime must not create opponent board facts or counter-positioning advice from current-view data.
- Own-board promotion requires the self-view anchor: S=1 plus a fresh non-empty 4354 shop, then fresh 4353 own-unit candidates. S=2 is observing/non-self current view and must not update own board, own bench, or own equipped items. It suppresses new current-view-dependent advice, but it must not cancel an already-owned answer generated from the last trusted self snapshot. Missing stage blocks creation of new non-durable proactive tasks; if an existing task temporarily cannot verify the current stage, keep its owner and defer delivery instead of deleting it.
- Use field-level equipment precedence: trusted 4357 left-item-rail facts and trusted 4356-to-4353 holder assignments first; current-match explicit user confirmation second; visual/icon candidates last and conditional only. Keep user-confirmed facts provenance-distinct from MuMu hard facts and clear them at the next match boundary. When a recent material equipment-dependent decision lacks reliable facts, runtime may ask one contextual, cooldowned confirmation question in cruise and accept the answer through the existing text/voice composer. Recording the confirmation creates no derived sibling answer; the reply's direct task remains the sole answer owner and may immediately decide slam, wait, holder, or the next missing fact. Do not add a permanent equipment-report mode. Never start item icon matching from periodic HUD/background sensing; allow one bounded fallback only for an explicit user refresh/equipment request or explicit conflict check.
- Resolve `item_bench` and `equipped_items` independently and use the highest currently reliable field immediately. Never block an item decision waiting for MuMu recovery or visual/icon candidates after current-match user confirmation supplies the needed field. Ask only for the specific missing field when it can materially change the next action.
- Choice candidate intake is current-match user report only; candidate truth
  remains user-confirmed even when augment mode uses the optional renderer draft
  convenience described below. Augment choice,
  active season-only choice modes, and item/anvil choice do not use automatic
  OCR or host multimodal fallback for candidate names in active product flows.
  Augment mode may expose one explicit Quick OCR action after stage and tier are
  selected. Each uniquely catalog-validated row may fill only its physical
  renderer slot; unresolved rows remain unchanged or empty and the UI reports
  the recognized count. It writes no canonical choice facts, opens no Host answer, never
  auto-sends, and is not available to active-season or item choice cards. The UI opens
  one structured card instead of pre-filling chat. Raw technical source rows
  must pass source-kind classification and active-season exclusions before they
  can become player-facing choices; rewards and reward subchoices cannot leak
  into the augment catalog. Empty augment dropdowns list only exact-stage and
  tier candidates from the versioned availability index; unknown-stage true
  augments remain explicit-search evidence and never enter stage dropdowns;
  explicit typing searches the full current-season catalog and labels known
  cross-stage or unknown-stage evidence. Refresh edits only changed slots and
  never auto-sends. Final confirmation does not require advice first: the same
  click saves dirty candidates without a model answer and then confirms the
  exact selection without opening a Host task. Later advice reads that choice
  from canonical match state. Shared component,
  completed-item, radiant-item, support-item, artifact, emblem, and special-item token edits persist as
  no-model facts across all structured choice cards, preserve duplicate owned
  copies, and remove one copy at a time. Item candidate pools remain category-
  pure for component, standard completed, artifact, and radiant choices. Each equipment category uses one
  full-width catalog-backed dropdown row. Whole-snapshot equipment confirmation
  is fact-only after daemon-owned equipment hydration, needs no surrounding
  choice-set binding, and refreshes current match/stage scope even when its
  contents are unchanged. An unhydrated renderer default must never be submitted
  as explicit empty inventory; only whole-equipment or
  whole-card advice may open the Host answer lane. Own item facts prefer MuMu structured
  sources: 4357 for the left item rail and trusted 4356-to-4353 coordinate
  assignment under the S=1 plus fresh 4354 shop anchor. Current-match explicit
  user confirmation is the next reliable context layer. Icon matching and host
  multimodal vision are fallback/validation evidence, not the hot-path truth
  source.
- HUD self-state text sensing is another narrow latency-sensitive exception:
  `tools/run-jcc-self-state-roi-ocr.mjs` captures one frame, runs ROI crop-task
  scripts, sends crops to the resident OCR worker, and aggregates only visible
  phase/economy HUD fields (`phase.stage_round`, `economy.hp`, `economy.gold`,
  `economy.level`, `economy.xp`). ROI scripts must not perform OCR; the
  aggregator must not write board, bench, shop, augments, items, selected
  choices, or equipped-item facts.
- HUD numeric authority is field-level only after the captured full-HUD frame
  proves its layout by recognizing `phase.stage_round` in that same frame.
  Reject isolated numbers from loading, roster, reward, or transition screens;
  never combine them with a later stage-only observation. Reject missing values
  before numeric coercion, persist bounded diagnostics when a requested field
  has no OCR task or accepted result, and still promote valid sibling fields
  from an anchored frame. Active-match HUD
  HP less than or equal to zero is missing unless separate explicit elimination
  or match-ended evidence exists. Hydration and failed-refresh paths remove
  historical false-zero authority while preserving valid gold, level, and XP.
- HUD ROI, diagnostic-only owned-augment text-panel inspection, and the augment-only
  explicit renderer-draft OCR convenience share one daemon-owned RapidOCR
  worker and one priority-aware serialized queue. Entering augment mode reserves
  that queue before asynchronous mode setup and blocks admission of new periodic
  or stage-only HUD OCR work until mode exit; an already in-flight job may finish.
  Augment Quick OCR is active only as a
  non-authoritative renderer draft, never as canonical choice intake. OCR
  runners for season-only choice modes and item/anvil panels may remain only as
  compatibility/calibration tools, never as active product intake. Concurrent
  Start Match is the formal shared-worker prewarm entrypoint. Worker startup
  and one Quick OCR click use separate budgets: an unfinished prewarm returns
  promptly, and one foreground hot attempt has a bounded end-to-end budget,
  uses a unique transport request identity, and runs ahead of queued background
  HUD work. Concurrent
  prewarm must be idempotent; startup timeout, window close, and daemon
  shutdown must reap the full worker process tree.
  Augment Quick OCR sends the current full frame plus the normalized panel ROI
  to that resident worker so crop and recognition occur in memory. It must not
  start a separate cold Python/Pillow crop process on every click.
  Match OCR names against the active generated decision-input catalog rather
  than the legacy MuMu visual overlay. Bind the catalog to one deterministic
  source fingerprint over the exact active hard-data manifest and every
  normalized catalog input, alias gateway, stage authority, and common/major-
  season choice rule in addition to season and patch. Any same-version source
  drift must fail closed before dropdown, search, save, confirmation, or OCR
  consumes the catalog. Keep one privacy-redacted real-
  frame fixture in the product gate so production ROI geometry and resident-
  worker recognition cannot silently regress. Discard a late OCR result if the
  player changed stage, tier, or any candidate while the request was running.
  A new match may retire an older match's in-flight renderer OCR lock, but an
  old-match completion must never populate the new match.
- Runtime frame capture defaults to selected-device ADB-first `auto`; discovered
  MuMuShell is only an empty-frame fallback. Never require an Android-version-
  specific MuMuShell path on the product hot path.
- Keep background sensing strict single-flight. A stale/timeout notice does not
  authorize another run while the old child tree remains alive. Bound nested
  sensing run bundles by count and age, and tree-kill timed-out subprocesses.
- Decode exactly one unambiguous host coach object with canonical `final_text`.
  Quarantine provider transport text outside the coach response, reject identity
  conflicts, and deliver each response identity at most once.
- Stage and audit live-ranking candidates before activation. Developer refresh
  follows the latest compiled Core Profile candidate by default; Runtime
  bootstrap explicitly maintains the active profile. A candidate refresh writes
  an immutable generation plus `candidates/<core_profile_id>.json` and never
  changes the active ranking pointer. Failed updates keep the last-known-good
  active snapshot and never pre-rotate it to `previous`. Missing compatible
  rankings are reported as unavailable without exposing an older season's date.
- Ranking refresh also compiles `data/live-rankings/jcc/current/lineup-strategy-index.json`
  from current Master+ national strength anchors, exact atomic rosters from
  `trait_group.minor_traits_datas[].hero_list`, recipe enrichment, current hero
  popularity/item-package evidence, and active hard-data catalogs.
  The deterministic current-day Master+ gradient uses top-four rate, top-one
  rate and average rank. An explicitly authoritative current-day sample count
  controls Bayesian shrinkage and confidence only and has zero direct strength
  weight. Appearance rate remains separate heat/contest evidence. Winning and
  popular recipe metrics are discarded and never enter strength, confidence,
  order, scorer, maintenance, or Host evidence.
  After a complete immutable candidate is prepared, Runtime may open one new
  ephemeral maintenance Host session for semantically new or changed lineups.
  It receives bounded Common principles plus the exact target Core identity
  and may emit only closed burden/flexibility/style/condition annotations. It
  has no authority over score, order, membership, metrics, stages, entities, or
  publication, is never reused as a Lobby or Match session, and degrades to the
  complete deterministic candidate on failure.
  Start Match consumes the compiled current-day score through the normal meta
  component. History remains partitioned by complete immutable binding;
  Runtime never reads history files, although refresh may compile a bounded
  same-binding zero-weight trend summary into the promoted typed index.
  Master+ `main_trait_strength` owns statistics and the matching `trait_group`
  owns each atomic roster. `lineup_group_list` is the primary recipe source;
  the patch-manifest allowlisted official curated popular-lineup JSON is the
  secondary recipe source. Recipes may enrich roles, items, transitions,
  augments, lineup codes, and playbook text only. They cannot create a ranked
  candidate, change roster membership, or inherit strength. Player/smart lineup
  endpoints and player/UGC rows are never fetched or associated. Hero rows
  supply popularity, likely contest pressure, and item preferences, with the
  highest-top-one package before the most-popular package.
- The refresh script, not a Host model or live-match Agent task,
  deterministically resolves cross-source recipe links, main carries, items,
  associated augments, transitions, templates, evidence quality, and
  augment/champion/item/trait reverse indexes. Runtime annotates the complete
  lightweight eligible Master+ pool through typed current-day lookup, then
  reconciles every result with stage, HP, economy,
  board, confirmed choices, equipment, and user intent. Do not parse the raw
  ranking snapshots or perform live cross-source joins. Treat target role as
  retrieval identity: a main-carry request must match the recipe main carry,
  while a member-only occurrence is contextual. Use the registered lineup-fit
  profiles exactly once: stage 2 meta/augment/item/tempo/board = 56/20/14/7/3, stage 3 =
  47/23/14/10/6, and stage 4+ = 40/22/13/13/12. Keep all lineup costs in one
  universal index, then apply the season-neutral candidate readiness pass. Typed
  lookup lanes are coverage annotations, not a preceding business rank. Shop is
  unowned opportunity evidence and contributes zero to board fit; board fit uses
  only owned board/bench role, copy, star, and core-coverage commitment. It
  may label a line observation-only, conditional start, future target,
  build-toward, or formed-core continuation, but it is not a sixth weight and
  never writes a durable target. A temporary stage-2 low-cost pair stays
  provisional; an established durable core needs explicit exit evidence before
  an unrelated higher-cost meta line can replace it. Keep national strength,
  winning-lineup recipe, and hero market/item evidence provenance-distinct.
  Host-visible strength statistics are limited to national Master+ top-four,
  top-one, and appearance rates. Winning-lineup metrics stay offline and never
  enter the Host decision payload.
- Compile natural-language lineup requests into validated season-neutral typed
  intent before retrieval. Support two through six trait constraints with exact
  breakpoints, precedence-preserving AND/OR/NOT, independent question groups, and main-carry,
  primary-tank, or member roles. Search the complete promoted Master+ typed
  index; the static Meta Map is orientation context, never a whitelist or
  shortlist. Evaluate each query group against one atomic published final
  variant. Conditions split across variants cannot form an exact match, and a
  no-exact result must be labeled `partial_downgrade` with the missing coverage.
- Treat next-three and next-five as display pagination only. Keep a strict-budget
  cursor that stores only query identity, ordered ids, shown ids, and bounded
  idempotence state. Treat ordinary OR as one any-branch query and expand alternatives only for
  explicit compare-each language. Unknown explicit entities, illegal
  breakpoints, and resolver faults fail closed rather than disappearing into a
  Meta fallback. Use a lightweight cursor keyed by typed-query identity plus the complete promoted Master+ data
  fingerprint, with ordered candidate ids, finite scores, typed match reasons,
  shown ids, and bounded idempotence state. Exclude shown candidates, invalidate
  on query or data-fingerprint changes, report exhaustion, and never store a
  complete lineup strategy package in the cursor. The daily route may retain
  its cursor until explicit New Conversation clears the retired lobby
  generation. During a Start Match-owned match, every material stage, target,
  choice, economy, board/bench, shop, or equipment change reranks the complete
  pool under the existing stage weights; never rerank only a prior page, Meta
  Map family list, or hydrated winner package.
- For each selected lineup candidate, pass one complete `canonical_variant` as
  the atomic published roster baseline. Cross-variant core-unit frequency is
  supporting evidence only and cannot be composed with that roster, another
  variant, or another candidate. Any current-match change must identify an
  explicit one-for-one substitution. Craftability is similarly exact: attach
  current-patch official `component_recipe_contexts`, and never infer an
  unlisted emblem from a desired trait or lineup.
- Runtime must fail closed if
  the promoted audit, stat date, runtime season/patch, package, or upstream
  identity disagree. Automatic pruning runs after every successful audited
  refresh; it writes the replacement trend summary atomically before deleting
  compact signals older than the latest 14 distinct dates. Historical signals
  and trends are diagnostic/rollback/lobby-review evidence only and must never
  enter active-match retrieval, ordering, Host context, or Coach decisions.
- `lineup_card` is a non-visual mode for generating the pinned lineup card.
  It should use selected current-season hard data, daily big-data candidates,
  current match variables, live_state, and user intent, then return
  `pinned_result` with schema `jcc-internal-lineup-plan-v1`. The host supplies
  deterministic renderer parameters only: slot, title, summary, current-season
  units with row/col, optional items/star/notes, loadouts, and moves. The
  runtime renderer materializes the 4x7 board.
- A season-only choice mode follows its compiled current-match report contract.
  The owning descriptor defines the visible choice shape and exclusions; an
  adjacent reward or source row is not product intake unless that descriptor
  registers it explicitly.
- Legacy icon matcher paths remain fallback/debug only and must not silently
  populate current choice state.
- Season data is swappable. Hard data, catalog overlays, visual references, rankings, and special mechanisms belong to the selected Season/Patch inputs; session, mode, context, and output lifecycles remain Runtime-invariant.
- Active game rules are compiled from Common knowledge plus one major-season descriptor and one patch source into an immutable Core Profile that also owns the decision-input catalog, augment-stage authority, and Runtime catalog overlay. Production reads that profile through `active-profile.json`; retired `base-game-rules.json`, `normal-rules.json`, and `special-rules.json` files are historical fixtures only. Start Match captures this profile exactly once and leases its generation until clean retirement; promotion and pruning preserve active, previous last-known-good, candidate, and leased generations. Host requests receive a compact `active_rules_bundle`; do not bake a season-only mechanic into Common Runtime code.
- Treat `season_id` as the major-season/set id and `active_patch_id` as the ordinary balance-version id. Patch labels belong to hard data, patch metadata, strategy Wiki patch pages, and balance notes unless a patch truly changes rule timing. Do not create a major-season rule directory for an ordinary balance patch.
- Keep match artifacts compact. Full live_state, full estimator context, raw logcat, and raw frames are debug-only explicit retention paths, not product defaults.

## Host Adapter Expectations

Host adapters are thin model transports. They should not own gameplay state, durable memory, OCR/vision orchestration, strategy wiki persistence, or tool loops outside the request they are answering.

Required adapter behavior:

- Accept selected context from runtime and send it to the provider without silently replacing it with provider-global memory.
- Return the exact response JSON shape requested by the runtime prompt.
- Support cancellation at `response_task` granularity when the provider exposes cancellation.
- Keep provider-specific config isolated from user/global skill systems unless explicitly intended by runtime.
- Use provider visual transport only for the image attachments passed by runtime. If a provider cannot handle images for the current request, report that as capability/missing-evidence instead of hallucinating visual facts.

Provider examples:

- Codex CLI may use a clean runtime `CODEX_HOME` with hooks/plugins disabled, while still receiving JCC-selected context from runtime.
- Kimi CLI does not need Codex skills installed. It should receive the same selected context and, when supported, image attachments through its own adapter transport.
- A future provider can be added if it can honor the same selected-context, response JSON, cancellation, and evidence-boundary contracts.

## Production Runtime Dependency

The Electron runtime does not need to "install" or "invoke" this skill at runtime. It needs the rules in this skill to be represented in generated context packs, host prompts, verifiers, and the host workspace shim.

When changing this skill, also check whether the same semantic contract needs to be reflected in:

- `AGENTS.md` host CLI shim;
- `tools/build-jcc-host-agent-context-pack.mjs`;
- host request construction in `ui/electron/runtime-service.js`;
- adapter capability handling in `ui/electron/host-adapters.js`;
- verifier scripts under `tools/verify-*.mjs`;
- Common/Season/Patch source data under `data/game-knowledge/jcc/` and the owning Runtime machine contracts under `data/runtime/jcc/`.

If a rule only lives in this skill and not in selected context or host prompt construction, production Kimi/Codex host calls may not see it. That is a bug in runtime context delivery, not a model-memory problem.

## Strategy Wiki Curation

Use the strategy wiki only as a curated, evidence-backed memory layer. It is not
hard data, not daily big data, and not current-match live_state.

The wiki has three strategy categories:

- `patch_meta_strategy`: current large-season small-patch meta notes. These are
  scoped by `season_id + patch_id` and should go stale when the patch changes or
  recent reviews contradict them.
- `season_mechanic_strategy`: current large-season mechanics and set-specific
  strategy notes, such as descriptor-owned choice or shop-extension patterns. These are scoped
  by `season_id`.
- `universal_gameplay_strategy`: general gameplay principles such as
  lose-streak, HP tolerance, economy, pre-leveling, and tempo-vs-greed. These
  must avoid champion/augment-specific strength claims.

One-click wiki curation is a host-model task, but the runtime owns persistence:

```bash
node tools/build-jcc-wiki-curation-request.mjs
```

That tool records immutable `wiki_source_events` in `app.sqlite` and emits a
host-model request. The host model must return JSON with
`schema=jcc-wiki-curation-host-response-v1` and
`generated_by=current_cli_agent_main_model`. Runtime validation then writes
draft `wiki_pages`; publishing requires runtime/user approval.

Do not let stale patch pages pollute active personal strategy. Do not copy
previous-match concrete board/shop/economy facts into current match state. Do
not write wiki pages without `source_event_ids`.

## Knowledge Aggregation and Typed Relations

Use existing parser, adapter, alias, tag, Core Profile, Ranking generation, Strategy Wiki, and Match state as the data owners. Compile deterministic typed relations and expose them through the existing snapshot-bound `jcc.query_knowledge` broker; do not add GBrain, Neo4j, vectors, or a parallel relation authority. Tags are attributes, not user-facing canonical identities. Relation results must carry snapshot, source domain, provenance, validity, and conditions. Receipts suppress proactive replay but never prevent an explicit precise re-fetch after compaction or session recovery. Unclassified legacy Wiki pages are excluded from default strategy retrieval.

## Output Style

Produce short, actionable coach answers:

1. What to do.
2. Why now.
3. Evidence used.
4. Uncertainty or what the user should confirm.

For board or lineup advice, output structured positions for the renderer. Do not hand-format the board unless explicitly asked for plain text.
