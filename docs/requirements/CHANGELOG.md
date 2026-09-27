# JCC Requirements Decision Log

This is the append-only decision ledger for product requirement changes. The
machine authority remains `requirements-registry.json`; this log explains why
its current classifications and contracts changed.

## 2026-09-27 - Separate card navigation from Cruise answer ownership

- Opening a card or persisting a fact does not reserve the Host answer lane. Registered checkpoints remain eligible while the card stays open.
- Real user/card tasks keep priority. Completed automatic responses pass normal freshness and actual render/ACK handling without a mode-based deadlock. Drafts and current tab remain unchanged.
- Apply the same implementation to development and installed builds; validate source parity and a fresh renderer before releasing the installer.

## 2026-09-24 - Retire Ranking references independently from Core backups

- Only active and pending Core profiles retain daily Ranking/Recipe candidate pointers and qualify for bounded previous-generation retention. Previous or archived Core storage is not a daily-data retention root.
- Preserve active closures and live Match generation leases independently. Remove retired-Core daily generations after lease release, including when history capacity remains unused.
- Keep compact trend history unchanged; this repair does not rebind a running Match to a new Core or Ranking.

## 2026-09-23 - Diversify Ranking direction presentation

- Keep every Master+ atomic candidate and its independent current-day strength band. Group close rosters only for user-facing direction coverage, using the published primary Core trait, roster overlap, and carry rather than upstream family ids.
- Generic lobby recommendations show five distinct S/A directions when available, with at most two from one family. All five bands remain searchable; lower bands are not generic default recommendations.
- Preserve the five-factor Match score, full-pool eligibility, five complete initial comparison candidates, and exact variant retrieval. At 3-3 ordinary confirmed augments, items, or owned units can justify one replacement direction without overriding a confirmed user target.
- Keep the band directory lightweight and bound presentation grouping to the current Active Ranking snapshot, so daily publication automatically recomputes coverage without changing the Ranking compiler or source metrics.

## 2026-09-18 - Confirmed equipment and explicit Core roster tools

- Preserve confirmed equipment in the final Host turn projection, including names, multiplicity, unknown holders and explicit empty sections. Remove the twelve-item cutoff from reliable equipment evidence.
- Preserve the durable selected-augment collection through the intermediate summary as well as the existing choice-confirmation history.
- Expose the existing Core roster solver through typed jcc.calculate arguments in all coaching modes. Provider-neutral tool transport preserves source/snapshot guards; explicit operations bypass natural-language intent routing.
- The solver provides bounded theoretical rosters and trait coverage, not meta strength, optimality or automatic emblem-holder legality. Host instructions require checking these limits.

## 2026-09-18 - Recover genuinely empty successful coach turns

- The observed lobby failure completed with HTTP 200 and no assistant message or tool call after a successful bootstrap. Retain the missing-final guard; do not turn commentary into advice.
- The shared lobby/Match runner permits one same-session continuation only for this empty-success case, guarded by task and route ownership and remaining answer budget. No static context replay, format correction, model switch or unbounded retries.
- Mock app-server tests cover lobby and Match recovery, one bootstrap, unchanged schema/session, and phase/error/cancellation exclusions. UI explains a missing final answer rather than displaying only its internal code.

## 2026-09-18 - Fresh app sessions retire previous gameplay

- App launch identity is distinct from renderer reload and daemon identity. Reopening Electron or replacing the daemon starts a fresh lobby conversation even after an unclean exit; every Start Match still owns a new independent Match conversation.
- Bootstrap retires the previous watcher/provider resources, commits a fenced SQLite boundary before lobby warmup, cancels old Match queues, clears scoped facts and releases generation leases. SQLite reconciliation cannot restore the retired Match. Late old callbacks fail ownership checks.
- Preferences and bounded postgame summaries survive. Same-app renderer reload and same-live-app provider transport recovery retain their existing ownership; cleanup failure is not reported as ready.
- Daemon client ready/exit callbacks are bound to the process that registered them; an old process cannot overwrite replacement ownership or prevent its later shutdown.
- Verification: app-session-boundary integration, host-session lifecycle disposition, Match Core binding and daemon client contracts.

## 2026-09-17 - Clarify red-tree armor and retain maintenance failures

- Follow-up runtime fix: persist changed ADB health results from getState through the daemon's canonical writer; unchanged reads stay read-only. Unready Match sessions cannot trigger automatic advice through observation, polling, or the common advice gate. Renderer observation uses the same readiness boundary.

- The subsequent user clarification sets one/two-star armor ignore to 15% + 30% AP, superseding the ambiguous 20+25 announcement. Unconfirmed high-star fields remain historical, not extrapolated.
- Codex CLI failures prefer structured error/turn.failed events over unrelated stderr warnings; only error messages are retained, never ordinary answer content. Maintenance failure classification consumes the selected diagnostic rather than appending warnings again.
- Both update entrypoints retain failed/degraded maintenance workspaces after deterministic publication. Only ready/not-required semantic completion permits cleanup; publication success alone is not semantic completion.

## 2026-09-17 - Apply the user-supplied 18.2a balance delta

- Restore Common level 8-to-9 and 9-to-10 XP to 68, cumulative totals to 198/266, and matching purchase/formula references. Existing Match snapshots retain their pinned rules.
- Apply the complete explicit 18.2a hero, trait, bounty and nature-sprite changes through the registered source adapter and immutable Core pipeline. Retain unspecified star values and all champion-form population/trait contribution rules.
- Preserve the source release as 18.2a without inventing a new upstream version. Keep the fresh Ranking publication's actual statistical date and bind it to the new Core and recipe generation.
- Preserve both announced red-tree armor changes as unresolved evidence where the old source does not uniquely identify the formula; do not fabricate a combined current formula. Verify overlay object preconditions independent of JSON key order while retaining exact values and array order.
- Compact Host entity details retain declared balance overrides, availability and offer conditions. Full-detail retrieval and entity-prefetch must agree on patched or disabled facts. Ranking gate checks use domain capability status rather than treating a disclosed recipe source-date lag as total data failure.
- Bound hard-data itemization helpers use the supplied Core artifacts without first loading global Active Ranking data. Identity checks remain mandatory. The no-big-data transport fixture explicitly declares its native session capability.

## 2026-09-17 - Verify selected ADB connectivity

- Connected UI state requires a successful selected-device check within 30 seconds. Legacy or stale connection records are unverified, not proof that MuMu is currently online.
- State refresh probes only the selected serial, coalesces concurrent probes, and waits at most two seconds with a ten-second check interval. It does not scan ports or select another device. Explicit discovery retains its independent action.
- Watcher metadata may supply a target but may not overwrite current connection health with historical success. ADB connectivity remains separate from receiving current Match game facts.

## 2026-09-17 - Remove watcher cold-start knowledge loading

- The structured watcher supervisor resolves storage paths without loading or validating Core/Ranking artifacts. Production uses the Match-pinned catalog overlay already supplied by Runtime; standalone Active overlay lookup occurs only after the initial discovering receipt.
- Regression forbids synchronous knowledge-artifact reads during supervisor startup. A successful lobby or Host bootstrap does not establish watcher readiness; watcher failure must be reported separately.
- Start Match failure is posted to the still-visible lobby when Match readiness is false. Rejected IPC or reconcile preparation releases the pending flag and shows failure; duplicate starts are ignored while one is pending.

## 2026-09-17 - Audit assembled Host instructions

- Inspect production-assembled bootstrap, per-turn prompts and tool descriptions before trimming. Retain the shared tool-visible knowledge instructions for recovery; do not remove Common or atomic game evidence.
- Replace four repeated per-turn workflow paragraphs with one reminder. Let checkpoint Action Brief and confirmed target authority own the agenda rather than a second generic stage/count rule.
- Treat validated entity identities and structured constraints as evidence, not a replacement for model interpretation of the user's intent. No prefetch path or retrieval restriction is added.
- The six diagnostic cases saved 1,084 bytes per turn at the prefix boundary. This is an input-size result, not a measured Provider latency improvement.

## 2026-09-17 - Clarify evidence delivery and recovery

- Tool contract v7 separates remaining candidate pages from partial payloads, and cache reuse from already visible model evidence. Explicit recovery remains available without strategy-content validation.
- Shared Host instructions distinguish same-document references, external variant lookups and request-time ledgers. Source cache receipts never replace explicitly requested lost facts.
- Verify tool-result visibility at the model boundary, not only the complete CLI event; timing experiments alone cannot establish why a model repeats a query.
- Pin Codex jcc tools to direct-model-only namespace exposure on fresh and resumed threads. Astra's model-owned Code Mode overrides feature-disable flags; its exec wrapper truncated large native results even when the dynamicToolCall completion event was complete.
- Preserve upstream unavailable/partial statuses, require complete delivery before reuse, bind recoverable broker pages to query selectors, and prevent cancelled calls from committing delivery receipts.
- Kimi persistent sessions use an isolated MCP transport for the same two readonly tools. Advertise native capability only after the actual handshake and discovery; bind calls to the active turn and revoke them on cancel or close. Keep short maintenance calls and unsupported providers on their explicit prefetch path.
- Stock Kimi ACP builtin schemas remain visible but cannot execute under the isolated JCC permission policy. Validate actual installed-CLI calls and model-bound payloads separately from protocol fixtures; paginate complete results below its text truncation threshold.
- Preserve native history on transient Kimi resume failure while clearing executable configuration; serialize replacement ownership before old-session cleanup and make successful session cleanup idempotent.

## 2026-09-16 - Make semantic evidence and tool capability AI-native

- Distinguish native final-answer items from commentary using Provider phase and completion state; failed turns with only commentary cannot report successful delivery. Preserve completed final answers and successful legacy responses without format-correction turns.
- Tool contract v6 makes repeated recovery of already sufficient same-turn evidence explicit through recovery_reason; genuine compaction, recovery and self-reported evidence loss still permit full redelivery. Keep exact variants and incomplete evidence accessible. Remove duplicate per-turn execution instructions.

- Resolve current Core entities before natural-language intent classification so paraphrases receive bounded authoritative facts without keyword gates.
- Treat `jcc.query_knowledge` and `jcc.calculate` as the only normal model-visible knowledge tools, and record a verifiable capability receipt for every live Lobby and Match session.
- Use explicit bounded prefetch only when native capability is unavailable; preserve snapshot, source, permission, and lifecycle hard boundaries without adding strategy output schemas or correction turns.
- Correct Codex registration verification against the installed app-server protocol: successful fresh thread/start accepts the supplied dynamicTools without requiring a nonexistent response echo. Unknown resumed sessions still require replacement and full initialization. Tool contract v5 invalidates old transport identities.
- Keep accepted registration, observed tool execution, and failed-session diagnostics distinct. Bind persisted receipts to the exact route and Provider session.

## 2026-09-16 - Close lifecycle, evidence, and equipment handoff gaps

- Treat a replacement native thread as uninitialized even when the previous thread's static context fingerprint is unchanged. Keep cancellation ownership until native settlement, and signal shutdown before serialized cleanup.
- Separate historical Match metadata from active boundary ownership. Require a matching watcher process instance before terminating a persisted PID.
- Give independent equipment choice windows distinct identities while retaining same-window revision and confirmation protection.
- Apply registered fit scoring before the bounded Agent working set on native and prefetch paths. Preserve every active confirmed augment in mechanical scoring and effect consumers.
- Resolve Ranking relationship follow-ups against the same captured authorized Core/Ranking index used by the parent evidence.
- Preserve item copy counts, field-level confirmed-empty inventory, and publishable unknown-equipment lineup cards across backend and renderer. Keep strategy-text delivery soft and never add a Provider correction round for these repairs.
- Verify concrete cross-layer failure scenarios rather than raising timeout budgets or checking only individual helpers.

## 2026-09-16 - Align native tools, checkpoint lifecycle, and lineup delivery

- Make `jcc.query_knowledge` and `jcc.calculate` the only model-visible knowledge tools while preserving Runtime-owned OCR, ADB, watcher, daemon, process-runner, screenshot, and provider-transport paths. Native capability is session-bound; unsupported or unknown sessions use bounded internal prefetch without exposing `exec` to the model.
- Keep the registered 2-2/2-7/3-3/3-5/3-7/4-3/4-5 cadence. Future 3-2 probability previews remain content obligations and cannot reserve or preempt a current choice window; there is no standalone 4-7 checkpoint.
- Keep the Provider `lineup_handoff` as the only live card protocol while retaining internal `pinned_result` as the Renderer materialization payload. Positioning intent is model-provided; exact board coordinates remain Runtime/Renderer-owned, and card degradation never discards readable strategy text.
- Preserve the existing 5/10 candidate working-set contract while requiring at least three distinct valid candidates in a visible 2-2 answer whenever the source pool supports three. Active stage weights and shop-versus-owned semantics remain evidence supplied to the Agent, not a second business score.
- Required verification covers native-tool mode fallback, all relevant UI/mode paths, checkpoint absorption, variant-specific evidence, card degradation, and Runtime process/OCR/ADB preservation.
- Preserve `jcc.calculate` as `jcc-calculate-tool-result-v1` through the shared result normalizer; deterministic calculations must not be mislabeled as knowledge-query results.

## 2026-09-13 - Give Runtime Daemon cold starts a five-minute final guard

- Replace the Electron Runtime Daemon client's obsolete 30-second startup cutoff with a 300000ms final abnormal-start guard. A ready Daemon still returns immediately, and deterministic process exit, writer-lease conflict, or startup contract errors still fail immediately.
- Keep readiness strict: the Daemon publishes ready only after module loading, canonical SQLite restoration, and Active Ranking reconciliation rather than exposing an incompletely initialized endpoint.
- Exercise both a cold start and a replacement restart in the Daemon client verifier, retain the environment override, and give the corresponding deterministic product-gate check the same explicit five-minute process budget.

## 2026-09-13 - Normalize Ranking recipe storage without losing variant evidence

- Store each immutable winning or popular recipe payload once per Master+ tier, intern repeated relation fields and values, and store relation-specific candidate differences in a content-addressed relation catalog.
- Keep candidate and atomic-variant relation ids in the persisted index, then materialize the complete legacy-equivalent recipe evidence only for the candidate requested by Runtime.
- Gate every new Active Ranking publication on dangling-reference checks, relation counts, and a full expanded semantic hash comparison. Existing v3 generations remain readable for pinned older matches, while new publications require v4.
- Preserve Host behavior: complete atomic rosters and requested variants remain available, mature recipe delivery remains bounded at the existing projection boundary, and normalized storage references never enter Provider context.

## 2026-09-12 - Align Strategy Evidence prefetch with Host turn budgets

- Stop applying the Strategy Evidence Kernel's standalone 128 KiB default to production Host turns. Prefetch-complete sessions use the owning ordinary or strategic turn ceiling, while final Host materialization still shares repeated evidence by local address and enforces the existing 1/4 MiB soft targets and 2/8 MiB absolute ceilings.
- Prevent a complete Core-only multi-domain decision packet from being mislabeled `prefetch_budget_exceeded` after its lineup and item evidence were already deterministically prepared for the same turn.

## 2026-09-12 - Close daily Ranking retention and cache-recovery verification

- Run bounded generation pruning after a successful daily Ranking publication in both the version pipeline and the Runtime `更新今日数据` path; retain two finalized previous versions by default.
- Do not count a prepared Ranking generation without completed semantic maintenance as a Previous rollback version. Order finalized previous versions by their generated timestamp rather than an arbitrary content hash.
- Keep publication authoritative when post-publication cleanup fails: expose a degraded cleanup diagnostic without rolling back or misreporting the already committed Active closure.
- Verify cache recovery by comparing the restored facts while requiring the recovered envelope to expose `delivery.cache_hit=true`; cache metadata is intentionally different from the first retrieval.
- Keep `fact_capture` required only for the sealed match fact-write task. Strategy text, lineup explanation, headings, and optional quality fields remain soft and cannot trigger a Provider correction loop.
- Align decision-quality gates with AI-native delivery: an invalid or incomplete augment action is not executable, but its independently readable coaching text remains deliverable and never triggers a format retry.
- Make stage-authority verification establish freshness at the scenario boundary, so larger current Ranking data cannot consume the test's HUD TTL and create a false stale-stage failure.
- Keep decision-input category verification order-independent and keep structured-card verification aligned with the state-only final-confirm contract.

## 2026-09-11 - Align the user-confirmed Common progression baseline with 18.2

- Update the Common standard progression curve to 56 XP for level 7 to 8 and 64 XP for both level 8 to 9 and level 9 to 10, with cumulative totals 130, 194, and 258.
- Keep the Common formula table and progression verifier expectations identical to that baseline.
- Keep S18-specific reward tables, entities, and mechanics in the selected patch hard data; this Common update does not move version-owned content into Common.

## 2026-09-11 - Make minor-patch inheritance and source validation manifest-driven

- Move upstream catalog counts and identity out of per-version verifier branches and into each patch source manifest.
- Let a minor patch inherit only declared mechanic-parameter and reward-table roles from the exact prior promoted same-season hard-data generation before applying its audited delta.
- Apply 18.2 Witch reward additions and replacements directly to atomic structured reward outcomes; retain unpublished rebalanced probabilities as unknown rather than inventing values.
- Preserve official per-star champion skill descriptions and values through Runtime query projection instead of reducing every champion to a one-star summary.

## 2026-09-11 - Keep one canonical lineup scorer and expose query reuse

- Keep context-aware lineup scoring in the existing Runtime strategy-fit pipeline, where the complete eligible Master+ pool is scored before display truncation. Remove the later tool-page scorer that duplicated weights and could reorder an already truncated page.
- Expose `delivery.cache_hit` and `delivery.reused_result` through one normalized read-only result so the Host can reuse prior evidence without repeating a query, while `recover=true` still returns the full cached result after compaction.
- Reuse bounded Runtime events and Host-turn traces for query and provider timing; do not add a second default-on diagnostic writer.
- Align the Runtime Agent skill with the registered stage weights and verify lobby retrieval, active Ranking projection, fixed checkpoints, structured choice modes, and full player-journey delivery.

## 2026-09-11 - Deduplicate current-turn facts and isolate sensing diagnostics

- Give manual match-variable turns a 16 KiB optimization target so small structured-fact growth does not trigger premature reduction; keep the existing 2 MiB ordinary and 8 MiB strategic safety ceilings unchanged.
- Make the normalized live-state projection the owner of current HUD stage and economy facts. Do not repeat the same snapshot under Match facts when it is already present.
- Keep raw ADB transport, ROI coordinates, screenshot references, watcher output, source commands, and parser counters in bounded Runtime diagnostics. Host turns receive normalized facts and compact source-health status only.
- Verify these rules at the shared turn-delta boundary so lobby, Cruise, choice modes, lineup cards, and other Host paths inherit the same behavior.
- Complete the final-choice confirmation change: persist the exact choice without opening a Host task, remove the retired confirmation-follow-up and orphan-recovery paths, and let later explicit advice or fixed checkpoints consume the canonical choice.

## 2026-09-11 - Remove Host bootstrap stalls and compact Ranking search delivery

- Bootstrap persistent Codex Host sessions with low reasoning and static context only; normal lobby and Match turns keep the user's selected reasoning effort and receive their own current-turn delta.
- Keep the selected canonical Ranking roster, roles, strength, equipment, transitions, formation and conditions in one comparison projection. Replace repeated semantic relations, formation data, sibling population variants and recipe alternatives with local aliases or exact follow-up indexes.
- Preserve large native Ranking results through both Codex transport layers: the Runtime-owned tool output limit remains in place, and `functions.exec` Ranking calls request a 65536-token outer result window.
- Keep Provider reasoning internal before required evidence retrieval: the bound tool call is the first assistant action, followed by one final response object instead of an interim plan or provisional JSON answer.
- Verify five current Master+ candidates remain complete below 100 KiB and that duplicate normalized queries still reuse the first snapshot-bound result.

## 2026-09-09 - Preserve Provider evidence and close query lifecycles

- Verify real Codex model-bound HTTP content: default truncation removed the middle of a 198024-byte tool result despite complete rollout storage. Runtime now sets a 262144-token tool-output limit covering the existing 1 MiB broker ceiling; logical-turn budgets remain unchanged.
- Separate explicit lineup constraints from background, retrieve the full compatible pool, and continue complete candidate pages without inheriting previous-route filters.
- Pin eligible Wiki revisions in SQLite at Match start and restore the same reference after recovery. Preserve explicit scope through curation.
- Compile dated observations into immutable same-binding trends; label anchor trends separately from atomic-roster statistics, and explicitly report absent series in older generations.
- Page relations beyond 100 rather than silently dropping them. Register wire/model visibility and Match Wiki recovery verifiers.
- These changes do not promote a Ranking generation, restart the running Runtime, or declare latency/UI acceptance complete.

## 2026-09-09 - Share readonly evidence and resolve variant intent

- Apply lossless same-result object sharing to all native readonly tool outputs before budget reduction; extend prefetch sharing to calculation contexts.
- Resolve natural-language variant intent through candidate-bound variant indexes and exact retrieval, not literal phrases or broad fallback search.
- Permit snapshot-local exact-argument reuse for deterministic lookups without blocking explicit re-fetch or bypassing freshness checks.
- Align the readonly contract with the existing native Runtime limits of 12 total and 10 per-tool calls. These are ceilings, not a desired query count.
- Register broker sharing and native Ranking integration verifiers. This does not declare the latency target or full UI acceptance complete.

## 2026-09-08 - Classify the knowledge aggregation execution plan

- Register the approved September 7 upgrade plan as current supporting requirements.
- Keep machine contracts authoritative and retain incomplete live acceptance status.
- This classification does not change production behavior or declare the plan complete.
- Classify the September 8 strategic-response review as generated verification evidence, not product authority.

## 2026-09-03 - Bind Runtime writer leases to process instances

- Changed the SQLite writer lease from PID-only liveness to a process-instance
  identity containing PID and observed process start time.
- Recover a stale writer lease when Windows has reused the old PID for an
  unrelated newer process, while continuing to fail closed for a live matching,
  remote, malformed, or unverifiable owner.
- Reused the same writer identity rule in offline database maintenance and local
  artifact pruning so recovery behavior cannot diverge by entry point.

Tested: writer-lease identity regression, daemon event-stream lifecycle,
database maintenance guard, local artifact prune guard, and desktop restart.

## 2026-09-02 - Allow full daily semantic maintenance to finish at current scale

- Raised the default end-to-end Ranking semantic-maintenance deadline from 25
  minutes to 60 minutes while preserving the bounded per-Host-call timeout.
- Kept the update resumable and fail-closed: an incomplete maintenance run
  preserves the previous Active closure, checkpoints completed batches, and
  continues the same input on the next update instead of partially publishing.
- Added a publication regression assertion so future changes cannot silently
  restore the undersized total deadline.

Tested: Ranking maintenance publication and Runtime session verification.

## 2026-09-02 - Make final-lineup confirmation explicit without narrowing its source

- Added the Cruise `确认最终阵容：` prefill action as an explicit final-target
  intent instead of inferring confirmation from every lineup-related question.
- Preserved three valid target sources: an existing Ranking candidate, a lineup
  established through chat, or a user-custom lineup stated in natural language.
- Required non-candidate final targets to carry explicit source and identity plus
  a complete roster and final-card strategy fields; current partial boards and
  merged candidates remain invalid final cards.
- Bound the UI action to the mode-level Runtime contract and added a regression
  test that rejects reading it from unrelated renderer metadata.

Tested: Final-lineup UI intent, direct Host request binding, lineup-card
publication contract, TypeScript compilation, and production UI build.

## 2026-09-01 - Separate Ranking source identity from lineup semantics

- Demoted Tencent raw family ids to opaque source-row keys used only for fetch
  association, history, deduplication, and audit. Current-Core roster semantics
  now own trait names, canonical identity, search, matching, and Host context.
- Added deterministic atomic-variant comparison for population, unit additions,
  removals and replacements, special trait states, samples, and result deltas.
- Added bounded 1-day, 3-day, and 7-day discovery signals without allowing
  trends to rewrite the official current-day strength score or metrics.
- Separated Ranking, winning-recipe, and popular-recipe dates. Recent source lag
  remains structural evidence, stale data requires strict matching, and expired
  or incompatible recipes cannot pair automatically.
- Made 2-5 a recovery-only point for incomplete 2-2 exploration, so a complete
  2-2 answer produces no new Host task, spinner, reranking, or repeated advice.
- Replaced narrow augment-effect regex extraction with a Common typed parser for
  trigger conditions, targets, numeric rewards, duration, stacks, caps,
  repetition, probability, and auditable unmapped semantics.

Constraint: Tencent data domains update asynchronously and raw family ids have
repeatedly produced incorrect player-visible trait semantics.
Rejected: Keep repairing raw-family bindings manually | source identifiers are
not a stable semantic authority and previously polluted complete lineups.
Confidence: high
Scope-risk: broad
Directive: Preserve canonical roster identity, atomic variant evidence, source
freshness, and complete candidates through every future compiler and Runtime
compaction path.
Tested: Targeted canonical identity, variant, trend, recipe freshness, semantic
maintenance, augment parsing, checkpoint recovery, strategic candidate, Active
closure, Runtime integration, and player-journey contracts.
Not-tested: Every live Tencent publication delay and full MuMu match trajectory.

## 2026-08-31 - Make fixed Cruise strategy obligations durable and complete

- Replaced competing automatic tempo, shop, economy, survival, and equipment
  answer lanes with one persistent fixed-checkpoint strategy obligation queue.
- Required later checkpoints in the same strategy block to absorb unresolved
  earlier obligations while preserving every required decision and complete
  atomic lineup roster.
- Preserved a bounded full Master+ candidate working set through scoring,
  Host-context compaction, response validation, and final-lineup delivery.
- Raised ordinary and strategic current-turn evidence to a 1 MiB soft target
  and 2 MiB absolute ceiling; diagnostics and duplicate prose compact before
  complete candidate identity or roster evidence.
- Added exact candidate-bound final-lineup validation, durable publication
  closure recovery, semantic-maintenance recovery, and field-quality guards for
  late-game board, bench, HP, item, augment, and reward evidence.

Constraint: Fixed strategic checkpoints must remain visible after delayed
augment confirmations, user questions, provider latency, or Runtime restart,
without allowing obsolete automatic events to consume the Host answer lane.
Rejected: Keeping old automatic event answers at lower priority | they still
competed for ownership and repeatedly displaced the strategic answer contract.
Confidence: high
Scope-risk: broad
Directive: Add future Cruise behavior as a strategy block/checkpoint obligation
or explicit user action; do not restore independent automatic Host-answer lanes.
Tested: Targeted queue, checkpoint, candidate, response, lineup-card, hard-data,
publication, Runtime status, typecheck, build, and performance-budget gates.
Not-tested: Every live MuMu frame pattern across a complete production match.

## 2026-08-25 - Compile formation difficulty beside, not inside, strength

- Added the Common formation-difficulty framework shared by lineup construction,
  transition planning, direct questions, and proactive Cruise.
- Added an additive Ranking formation profile containing target population,
  high-cost dependency, trait breakpoints, transition support, hero heat, and
  explicit-requirement coverage with unknown states for unsupported claims.
- Passed the profile through Runtime strategy evidence and lineup lifecycle
  context without modifying the current-day national strength score.

Constraint: A lineup can be very strong after completion while remaining hard to
make, and ranking appearance/use rate is contest evidence rather than a direct
formation probability.
Rejected: Subtracting formation burden from national strength or inferring
mandatory stars, augments, items, or emblems from popularity alone | that would
turn partial evidence into false hard requirements.
Confidence: high
Scope-risk: moderate
Directive: Keep Common dimensions season-neutral; let Core, Ranking, and Runtime
bind version and current-match facts through the existing pipelines.
Tested: Common JSON validation, ranking artifact verification, Runtime strategy
projection verification, full repository verification, and build checks.
Not-tested: Live in-game recommendation quality for every archetype.

## 2026-08-25 - Publish national Master+ strength independently of winning recipes

- Kept the national Master+ trait, hero, item, and hero-equipment evidence as
  the authoritative daily strength overlay when its own identity and catalog
  coverage pass.
- Made the winning-lineup endpoint an optional recipe-enrichment capability:
  missing, stale, or below-minimum winning coverage is recorded as a warning
  and cannot block valid national strength publication.
- Refreshed the official popular-recipe generation independently; its recipes
  can enrich role, item, augment, transition, and playbook evidence but cannot
  supply strength metrics or alter the national atomic roster.

Constraint: The national Master+ feed and recipe feeds have independent
freshness and availability, and the current daily ranking must remain useful
when winning recipes have not yet refreshed.
Rejected: Blocking the complete overlay on a missing winning recipe feed |
that incorrectly couples two independent capabilities and hides valid data.
Confidence: high
Scope-risk: moderate
Directive: Preserve separate source capabilities and never let recipe metrics
inherit or replace national Master+ strength authority.
Tested: Live Master+ refresh, active generation verification, strategy-index
verification, sync contract verification, and exact popular recipe inspection.
Not-tested: Match-time coaching quality against a live game state.

## 2026-08-25 - Separate Core-only lobby theory and equipment override evidence

- Added a typed lobby `daily_core_theory_query` action for the reversible
  `别吃大数据` entry. It uses the active Common/Core profile only and never
  attaches rankings, Wiki, or current-match facts.
- Kept popular-recipe lookup, quick record, and equipment-specific shortcuts
  scoped to their existing product surfaces; no extra lobby buttons were added.
- Compiled equipment stat overrides as typed conflict evidence and made the
  DecisionMath item optimizer clamp overridden metrics while reporting wasted
  effects and preserved effects.

Constraint: Theory questions need current-season knowledge without turning the
lobby into a ranking or live-match route; equipment recommendations must expose
semantic effect conflicts instead of treating every numeric stat as additive.
Rejected: A generic text prefix, a lobby popular-recipe button, and a separate
equipment-conflict UI | those bypass typed source policy or duplicate natural
language retrieval.
Confidence: high
Scope-risk: moderate
Directive: Keep Common vocabulary season-neutral; bind entity aliases and
override values through the active Core generation.
Tested: Targeted UI-contract, DecisionMath, syntax, build, and diff checks.
Not-tested: Live host response quality and real in-game equipment assignment.

## 2026-08-25 - Preserve complete theorycraft evidence and native follow-ups

- Raised only the serialized current-turn evidence/tool budget from 256KB to
  512KB. The static provider capsule remains capped at 256KB and diagnostics
  retain their existing independent limits.
- Made active-Core theorycraft itemization follow the deterministic selected
  carry, so theoretical completed-item and explicitly requested artifact
  evidence is available even when the turn has no current owned components.
- Required theorycraft responses to enumerate the complete atomic roster,
  occupied population, population costs, concrete roles, and requested
  theory item/artifact candidates instead of emitting placeholder slots.
- Declared that the provider-native live conversation resolves follow-up
  intent and unfinished requested fields, while the current Runtime turn
  remains the authority for current gameplay facts. Runtime does not replay or
  persist a transcript replacement.

Constraint: Complex theorycraft turns combine lineup, transitions, roles,
items, artifacts, augments, and Core entity evidence; truncating one domain
silently produces an incomplete answer.
Rejected: Raising the static capsule budget or adding a Runtime-owned transcript
| those increase persistent context and duplicate Provider history.
Confidence: high
Scope-risk: moderate
Directive: Keep current-turn evidence bounded and typed; do not convert this
budget change into a global catalog injection or a second model-planning turn.
Tested: Targeted DecisionMath, host budget, syntax, requirements, and strategy
evidence verification.
Not-tested: Live provider response quality and a real in-game observation.

## 2026-08-24 - Unify strategy evidence planning and read-only retrieval

- Added one season-neutral Strategy Evidence Framework for rules, entity,
  lineup, transition, item, augment, economy, current-Match, and ranking routes.
- Made every strategy answer carry one immutable evidence snapshot, multi-route
  plan, facet coverage receipt, and source policy before the Host answers.
- Exposed `jcc.query_knowledge` and `jcc.calculate` as snapshot-bound read-only
  Codex tools. Providers without registered custom tools receive the same
  policy through a prefetch-complete packet.
- Reused the existing Common, Core, Ranking, Match, DecisionMath, semantic-tag,
  card, and Cruise owners. The kernel does not add a graph/vector authority,
  a second transcript, a new scoring component, or a separate planning model.
- Applied one adaptive tool budget: ordinary turns target zero to two calls;
  complex multi-domain questions may use up to six total calls, all within the
  existing 256KB in-memory current-turn ceiling. Three expansion cycles are
  guidance because providers do not expose one portable cycle counter.
- Bound tool dispatch and deterministic calculations to the exact provider
  thread/turn, Match, Core, response/card revision, and action fingerprint.
  Stale, cancelled, cross-Match, and late-returning calls now fail closed.
- Preserved normal revision advances for the same response-task owner while
  invalidating replaced tasks, changed choice reports/revisions, and
  superseded decision-action fingerprints.
- Reused the canonical response-owner identity (`mode`, Match, origin, event
  key, minimum revision, and accepting status) and made freshness checks
  mandatory before and after every tool, including empty knowledge queries.
- Counted the complete serialized current-turn prompt in the shared 256KB
  tool ledger and reserved 32KiB before native-tool dispatch, so coverage
  cannot advertise a tool path that has no usable argument/result capacity.
- Added keyed evidence prefetch for every provider. A no-tool session can no
  longer report a facet as satisfied unless its evidence is actually present
  in the bounded turn payload; budget reduction updates the receipt with it.
- Made semantic retrieval consume every material Common route in one query.
  The previous single route remains only a compatibility annotation and can no
  longer crowd transition, item, or augment evidence out of a composite turn.
- Added automatic Codex bootstrap fallback when an installed app-server
  rejects `dynamicTools`; that live session is explicitly marked
  `prefetch_complete` instead of pretending tools exist.

Constraint: The Agent must understand and plan inside the same logical Host
turn while Runtime remains the authority for sources, identities, budgets,
coverage, and immutable Match facts.
Rejected: Inject complete catalogs every turn, let the Host browse repository
files, or call a second model only to plan | these duplicate authority, increase
latency, and still do not prove evidence coverage.
Confidence: high
Scope-risk: broad
Directive: New strategy surfaces must register their route/facet obligations in
Common and pass through the shared kernel; version updates rebind Core and
Ranking evidence without adding season-named Runtime branches.
Tested: Common compilation, multi-route no-big-data regression, provider tool
registration and fallback, source-policy isolation, context budgets, and
requirements authority.
Not-tested: Full product gate and unrelated Electron journeys.

## 2026-08-24 - Retrieve current-Core game knowledge for every strategy turn

- Repaired the Match Host evidence path so ordinary Cruise questions and the
  explicit no-big-data action both retrieve bounded current-Core details rather
  than treating the static champion-name meta map as complete evidence.
- Added deterministic open-lineup core selection for users who delegate the
  carry and tank choice. A 95 request now returns one legal atomic 9-population
  roster, bounded alternatives, activated trait breakpoints, skill summaries,
  and requested 6/8-population transitions without Master+ strength claims.
- Composed lineup, transition, itemization, and augment evaluators for one
  multi-part question. The first matching domain no longer suppresses the
  remaining requested evidence.
- Added exact current-Core entity retrieval for direct champion, trait, item,
  and augment questions, including compiled aliases such as `小鸡`.
- Instructed the Host to use executable deterministic evidence and prohibited
  the false fallback statement that only champion names were supplied.

Constraint: The static provider capsule remains bounded and must not inline the
1.3MB decision catalog or raw 2.6MB Core bundle.
Rejected: Put every hero and effect into every Host turn, or require a user to
preselect a carry before open theorycraft | both would either waste context or
defeat the requested coaching workflow.
Confidence: high
Scope-risk: moderate
Directive: New strategy routes must retrieve exact current-Core evidence by
typed intent and compose all requested deterministic domains under one answer
owner; never use the season name list as proof that entity detail was supplied.
Tested: Open 95 auto-selection, legal trait coverage, high-cost preference,
skill detail, 6/8 transitions, item/augment composition, alias entity lookup,
ordinary Cruise integration, explicit no-big-data isolation, and syntax.
Not-tested: Full product gate and unrelated Electron journeys.

## 2026-08-24 - Use compiled aliases across structured cards

- Propagated Common equipment aliases and current-patch champion aliases into
  every catalog-backed structured-card combobox instead of limiting them to
  natural-language parsing and backend catalog lookup.
- Made the target card's equipped-holder editor stack the hero and three item
  slots vertically, removing the forced wide row and horizontal scrolling.
- Kept canonical persistence unchanged: selecting `小鸡` stores
  `深红锋喙鸟`, and selecting `攻速` stores `反曲之弓`.

Constraint: Card search must use the same active Core alias gateway as Runtime
parsing without allowing an alias to establish entity membership.
Rejected: Add component-specific alias tables or persist the typed alias |
either approach would drift across modes and pollute canonical Match facts.
Confidence: high
Scope-risk: narrow
Directive: New catalog-backed card inputs must use the shared combobox and
carry compiled `search_terms`; do not introduce local alias branches.
Tested: Targeted backend option, UI contract, browser layout, browser alias
search, active alias compiler, and requirements-authority verifiers.
Not-tested: Full product gate and unrelated journey suites.

## 2026-08-24 - Compile player aliases through Common and patch ownership

- Moved stable component, completed, radiant, artifact, support, and tool
  player aliases into a Common data document. Common support aliases remain
  inactive when the selected Core does not contain those entities.
- Added S18 champion player aliases as patch-owned input keyed by canonical
  champion id and name. Patch aliases must bind uniquely during every Core
  compile; they cannot leak into another season.
- Replaced the JavaScript `SPEECH_ALIAS_SEEDS` table with one compiled alias
  gateway consumed by typed equipment search, Quick Record, direct
  user-confirmed equipment parsing, deterministic calculations, Host season
  context, and Tencent ranking entity lookup.
- Added existing-radiant-only alias generation such as `光明羊刀`, while
  keeping `攻速` scoped to equipment search and preserving canonical ids and
  names in Match facts.
- Added context gates so bare attribute questions cannot become Quick Record
  equipment facts, and boundary-aware mention matching so short aliases such
  as `龙` and `js` do not become unrestricted substring classifiers.
- Made declared item category part of alias binding authority. Wrong-category
  Common entries remain inactive, and radiant aliases bind only to actual
  radiant items.

Constraint: S18 has no current support-equipment entities, but their stable
player aliases should remain reusable without manufacturing S18 catalog rows.
Rejected: Add missing support items or keep aliases in Runtime JavaScript |
aliases cannot establish entity membership and name branches would pollute
future seasons.
Confidence: high
Scope-risk: moderate
Directive: Future major-season work must update patch champion aliases, reuse
Common equipment aliases, and rerun the compiled alias audit before promotion.
Tested: Alias compiler determinism, kind/category isolation, radiant binding,
canonical Quick Record persistence, attribute-context and short-alias negative
regressions, absent-support inactivity, compiler architecture checks, and one
read-only adversarial review with every finding resolved.
Not-tested: Full product gate and unrelated Electron/journey suites.

## 2026-08-24 - Integrate Cruise decisions through shared Common semantics

- Added a season-neutral Common Cruise vocabulary that preserves the existing
  opening doctrine while giving current-Match facts, Core tags, active effects,
  and specialized evaluator outputs one shared language. Runtime, not Common,
  owns action orchestration and answer-lane behavior.
- Added a bounded Runtime orchestrator that binds evidence to one Match/Core
  snapshot, filters foreign-Match facts, resolves confirmed augments, equipped
  items, and active traits through the captured Core, merges equivalent
  actions, and records deterministic suppression for incompatible actions.
- Kept exact formulas and route-local evaluators independent. The integrated
  layer emits evidence only, creates no global or sixth lineup score, performs
  no per-evaluator model calls, and attaches one packet to the existing Host
  answer owner.
- Added an explicit cross-Harness major-season checklist. A new Host Agent can
  now locate descriptor, patch, semantic rebuild, Ranking, descriptor-driven
  UI, verification, promotion, archive, and prune responsibilities directly
  from the machine entrypoint without copying a retired season.
- Registered the new Common document, Runtime implementation, focused verifier,
  version-renderer checks, requirements authority, and entrypoint guidance.

Constraint: Preserve current S18 behavior and Common coaching experience while
making reusable semantics and Runtime orchestration discoverable for future seasons.
Rejected: One universal strategy score or one model call per domain evaluator |
both would double-count evidence, add latency, and weaken typed authority.
Confidence: high
Scope-risk: moderate
Directive: New seasons compile their entities and Ranking recipes through the
Common vocabulary; extend Common only for genuinely reusable concepts, and
keep season UI descriptor-driven.
Tested: Focused orchestrator behavior, syntax, semantic feature/compiler
integration, Cruise ownership and freshness contracts, season-aware renderer
contracts, Common neutrality, and requirements authority.
Not-tested: Full product gate and unrelated legacy journey/electron suites.

## 2026-08-24 - Keep version-owned strategy assets out of Runtime contracts

- Moved archived S17 patch strategy and balance assets into
  `data/game-knowledge/jcc/seasons/s17/patches/`; the Runtime contract tree no
  longer owns season content.
- Updated active and Match-captured patch strategy resolution to use the
  selected season's game-knowledge patch directory.
- Updated season archive generation and verification so future archives retain
  patch assets in their owning version module and fail if season content
  reappears under `data/runtime/jcc/seasons/`.

## 2026-08-24 - Make augment choice season-neutral and remove S17 production residue

- Replaced the shared S17 augment taxonomy and name-specific formula branches
  with deterministic Core-compiled augment profiles over the closed Common
  semantic vocabulary. Unknown profile membership now fails closed.
- Added a source-preserving semantic category fallback for augments missing an
  upstream top-level category, so every active augment remains filterable and
  auditable without introducing entity-name scorer branches.
- Added an explicit S18 patch item-usage taxonomy to the hard-data Source
  Adapter. UI and Host now consume the same immutable compiled facets; raw
  stats and incidental effect text can no longer invent holder roles.
- Made trait-name and champion-name references compile into locked commitment
  features, preventing trait and exclusive augments from receiving the
  universal-flexibility bonus.
- Added a separate Runtime three-candidate augment evaluator with current-fact
  realization, risk, top-four objective fit, first-place objective fit, stable
  tie-breaking, target-authority precedence, and Core-only degradation when
  compatible Master+ rankings are unavailable.
- Kept the registered five-component lineup score unchanged. Daily lineup
  association enters augment choice once from a normalized meta/board/item/tempo
  baseline that explicitly excludes `augment_fit`, and duplicate source
  associations count once per atomic lineup.
- Removed the old S17 taxonomy builders/verifiers, S17-only resource modifiers,
  production MuMu decrypted-config catalogs, S17-specific choice ROI tools, and
  current companion catalog contamination. The companion now compiles from the
  active immutable S18 Runtime Catalog; S17 descriptor/archive evidence remains
  read-only and auditable.
- Retired the monolithic S17 hard-data builder and its direct collector. The
  stable hard-data verifier now validates any registered immutable generation
  from its content manifest, while writable version input is owned only by the
  patch manifest's Source Adapter.
- Repaired the S17 archive boundary: its source manifest no longer resolves the
  mutable current-season MuMu overlay, and archive isolation verifies the frozen
  compiled Core bundle instead of rebuilding retired production input.
- Front-loaded the active choice contract into every compact Host rules brief,
  including the exact three-candidate and keep/refresh obligations, so provider
  turns do not depend on replaying the full static rules capsule.
- Bound companion asset generation and verification to the exact immutable
  Runtime Catalog selected by `active-profile.json`; the mutable compatibility
  mirror remains a non-authoritative debug/export surface.
- Repaired the two current OCR authority documents so they describe only
  augment, item, and active-descriptor choice intake. Removed the unreferenced
  MuMu config decryption script whose default output targeted the retired
  production decrypted-config directory.
- Removed the remaining retired-season variable requirements from current
  Runtime runbooks and added them to the season-neutrality negative guard.
- Repaired the ranking-unavailable explicit-candidate path and added a direct
  regression case, so Core-only augment evaluation degrades instead of throwing.

Constraint: The active S18 Core must remain usable without current Master+
ranking data, and full repository validation was explicitly out of scope.
Rejected: Keep a global augment taxonomy or feed the five-component lineup score
back into augment choice | both create version residue and double-count fit.
Confidence: high
Scope-risk: broad
Directive: New augment semantics extend Common only when the existing closed
vocabulary cannot represent them; entity values and tags still compile through
the selected season Core, never through Runtime name checks.
Tested: Targeted semantic compilation, S18 augment evaluator, Runtime association
integration, scorer, S18 catalog/companion generation, source isolation, resource
policy, choice/UI contracts, mainline absence guards, and requirements authority.
Not-tested: Full product gate and unrelated legacy journey/electron suites.

## 2026-08-23 - Canonicalize S18 source aliases and Grand Elementalist forms

- Added one patch-owned source-entity mapping shared by Core compilation,
  MuMu validation, national roster compatibility, winning recipes, and popular
  recipes. Tencent ids `14514` and `15460` now resolve to canonical Morgana and
  Gnar without creating additional champion entities.
- Modeled ids `15461` through `15469` as the nine S18 Grand Elementalist Lux
  forms. Every form resolves to canonical Lux while retaining its selected
  trait and order as typed variant evidence; the official champion count stays
  65.
- Recorded the Grand Elementalist +2 selected-trait contribution and shop-form
  conversion behavior in the S18 major-season descriptor.
- Reclassified the observed shop id `15468` as Wild Soul Lux. The live mapping
  receipt now resolves all 73 observed raw ids and no longer needs a shop-only
  exception.
- Confirmed that recipe `4793`'s seven visible augments all resolve independently.
  Extra source id `20775` is an eighth hidden stale reference, so normalization
  excludes it from candidates while retaining a bounded audit record.

Constraint: Source-specific hero forms must remain usable across all ranking
recipe sources without changing canonical catalog membership.
Rejected: Treat Lux forms as separate champions, leave them as external roster
slots, or guess `20775` as one of the seven visible augments | each would corrupt
identity, trait semantics, or recommendation evidence.
Confidence: high
Scope-risk: moderate
Directive: Future season forms belong in the patch source mapping and major-
season descriptor; all recipe adapters must consume the compiled mapping.
Tested: Deterministic S18 staging, recipe normalization, all 31 current Tencent
popular recipes with zero quarantined rows, MuMu mapping receipt, and adversarial
mapping checks.
Not-tested: Full product gate and publishable S18 Master+ strength overlay.

## 2026-08-23 - Preserve recipe auxiliaries and isolate popular-template queries

- Split explicit non-champion recipe rows such as pets and summons from the
  champion roster instead of rejecting them against the champion catalog.
  Final and transition recipes now retain these rows as typed auxiliary units;
  they do not consume champion population unless the source explicitly says so.
- Retained rows that Tencent explicitly types as heroes but the current Core
  Catalog cannot yet map as population-occupying `external_roster_unit` slots.
  These rows preserve the atomic source roster without being falsely treated as
  canonical champions or strength evidence. Missing supplementary augment or
  item references now degrade only that field instead of discarding the roster.
- Added an immutable active recipe-generation pointer independent from the
  Master+ Ranking Overlay. Start Match captures that exact generation or an
  explicit unavailable identity, and pruning preserves the active generation.
- Added the final Cruise shortcut `查热门阵容`. It is a typed UI-only action
  that queries captured official popular templates without live state,
  national strength, winning recipes, hero rankings, Wiki, hard-data
  theorycraft, or Cruise scoring. Every answer must disclose the absence of
  strength authority.
- Kept recipe templates atomic and retained main-carry, primary-tank,
  equipment, position, transition, lineup-code, gameplay, and auxiliary-unit
  evidence without allowing any of it to become a ranked roster or strength
  source.
- Unified auxiliary classification across official popular recipes, winning
  recipes, and national Master+ atomic rosters. A non-conflicting source id can
  retain its typed pet, summon, or external-slot identity across those inputs,
  while remaining excluded from champion matching, role inference, hero
  indexes, and strength. Recorded augment source id `20775` from recipe `4793`
  as unresolved because it is absent from the current official augment catalog;
  the pipeline preserves the reference without guessing a name.

Constraint: Current S18 Master+ strength can remain unavailable while official
popular templates are already published.
Rejected: Drop source-typed roster slots, treat pets or unresolved external
slots as catalog champions, or use popular templates as a temporary ranking
fallback | each loses valid recipe structure or creates false identity or a
second strength authority.
Confidence: high
Scope-risk: moderate
Directive: Future recipe adapters must classify unit type before champion
resolution and must preserve the explicit popular-query evidence boundary.
Tested: Recipe normalization/publication/pruning, winning and national-roster
auxiliary reuse, all 31 current official popular templates, active recipe identity,
Start Match snapshot isolation, typed popular-query isolation, renderer action
contract, UI TypeScript/Vite build, and requirements authority.
Not-tested: Full product gate and a publishable S18 Master+ Ranking Overlay.

## 2026-08-23 - Separate national roster authority from recipe enrichment

- Made Master+ `main_trait_strength` the only lineup-statistics authority and
  matching `trait_group.minor_traits_datas[].hero_list` the only ranked atomic
  roster authority.
- Kept `lineup_group_list` as the primary recipe source and added one
  patch-manifest allowlisted official Tencent curated popular-lineup JSON as
  the secondary recipe source. Player/smart endpoints and player/UGC rows are
  excluded from fetch, normalization, association, and Runtime use.
- Restricted exact/compatible recipes to roles, items, transitions, augments,
  positions, lineup codes, and playbook enrichment. Analogous recipes may
  provide only bounded role hints. No recipe can add, remove, replace, merge,
  or lend strength to national roster members.
- Discarded winning/popular recipe metrics before compilation. Metamorphic
  verification now requires arbitrary recipe-stat changes to leave candidate
  membership, order, confidence, semantic features, and Runtime evidence
  unchanged.
- Added a content-addressed recipe cache and explicit degraded state: official
  popular recipes may be cached for the exact Core Profile when Master+
  strength is unavailable, but this does not publish a Ranking Overlay, run
  semantic maintenance, or make ranking recommendations available.
- Retired the stale S17/all-tier toolbox discovery contract and its smart-lineup
  verifier because it had no production consumer and could reintroduce foreign
  or player recommendation data.

Constraint: Current S18 Master+ strength and winning recipe endpoints may be
temporarily empty while official curated popular recipes are already available.
Rejected: Promote popular recipes as strength, use recipe statistics as
fallback confidence, or call smart/player recommendation endpoints | all three
create a second and incompatible ranking authority.
Confidence: high
Scope-risk: moderate
Directive: Future season manifests must explicitly declare all ranking source
roles; recipes remain enrichment-only and an unavailable national source must
preserve the last-known-good active pointer.
Tested: Targeted source-adapter fixtures, national-roster strategy compilation,
recipe-metric invariance, JSON/schema checks, Runtime degraded-state tests, and
one live S18.1 refresh that cached only official popular recipes while leaving
the unavailable Master+ Ranking Overlay pointer unchanged.
Not-tested: Full product gate, live Match behavior, and a newly publishable S18
Master+ Overlay were intentionally outside this targeted change.

## 2026-08-23 - Bound semantic features and transition adaptation

- Assigned the lightweight controlled semantic feature layer to four existing
  owners: Common defines the closed season-neutral vocabulary, Core compiles
  deterministic hard-data features, the daily Ranking refresh compiles lineup-
  recipe features, and Runtime maps verified current-Match facts to temporary
  values that expire with the Match.
- Kept typed facts, entity legality, source provenance, atomic variants,
  Master+ metrics, and the existing meta/augment/item/tempo/board score
  authoritative. Semantic features have no independent weight and cannot
  become a sixth component.
- Required transition advice to prefer the Zhangmeng/Tencent published chain
  attached to the selected atomic parent. Local work is limited to legality
  validation, bounded missing-population completion, one role-compatible
  temporary carry or tank replacement, proven-owned equipment continuity, and
  trusted self-board reordering.
- Prohibited presenting a locally completed transition as Master+ strength or
  a published recipe, splicing parent or sibling variants, and generating or
  persisting a full-combination lineup library.

Constraint: The feature layer must improve bounded interpretation without
creating another data lifecycle or weakening deterministic evidence authority.
Rejected: Add a fifth pipeline, GraphRAG, vector retrieval authority, LoRA, or
a generated lineup-combination corpus | each creates a second semantic or
strength authority outside the existing immutable contracts.
Confidence: high
Scope-risk: narrow
Directive: Extend only the Common closed vocabulary and its owning Core,
Ranking, or current-Match mapping; keep every new feature zero-weight unless it
is explicitly mapped into one of the five registered typed score components.
Tested: Controlled semantic compilation and routing, Ranking transition
compilation, request-local transition adaptation, Ranking retrieval/runtime,
Core compiler and Profile Store identity, Match Core/Ranking binding, Host
context budgets, Runtime mode/orchestrator contracts, S18.1 version-pipeline
verification, and requirements authority.
Not-tested: The full product-wide gate and a real newly published S18 Master+
Ranking Overlay were not run; current S18 rankings remain explicitly
unavailable until Tencent publishes compatible data.

## 2026-08-23 - Compile current-day strength and bounded semantic maintenance

- Replaced ad hoc lineup strength handling with one deterministic Master+
  current-day gradient over top-four rate, top-one rate and average rank. An
  explicitly authoritative current-day sample count controls Bayesian
  shrinkage and confidence only, with zero direct strength weight. Appearance remains a
  separate heat/contest signal; winning-lineup metrics and samples remain
  recipe evidence.
- Partitioned retained ranking signals by the complete season, patch, Core,
  catalog, hard-data, tier, API and ranking-set binding. A bounded trend summary
  may be compiled into the next current-day index with zero score weight, while
  Runtime remains unable to read history or latest-diff files directly.
- Added a one-shot ephemeral ranking-maintenance Host turn for only semantic
  additions and changes. Its closed output can annotate formation burden,
  flexibility, style and conditions, but cannot alter metrics, scores, order,
  membership, entity truth, stages or publication.
- Added prepare, verify, compare-and-swap and atomic finalization around the
  maintenance turn. Host failure publishes the complete deterministic result
  with an explicit degraded semantic receipt.
- Wired the compiled current-day score and bounded annotations into typed
  Runtime retrieval, so Start Match uses the cleaned ranking result through the
  existing stage-specific meta component.

Constraint: Prior-day data must never dilute or reorder the authoritative
current-day snapshot because minor-patch behavior may have changed.
Rejected: Blend multi-day metrics into strength, let the model assign scores,
or persist a reusable maintenance conversation | each weakens current-day
authority or leaks maintenance state into player sessions.
Confidence: high
Scope-risk: moderate
Directive: Keep history weight at zero, bind it by full immutable identity, and
keep semantic maintenance annotation-only for every future season.
Tested: Targeted strength, history binding, semantic maintenance, ephemeral
session, publication ordering, typed retrieval, Start Match integration,
generation, promotion, and requirement-authority verifiers.
Not-tested: No external Tencent refresh was run because current S18 ranking data
may still be unavailable; network adapter behavior remains covered by contract
fixtures.

## 2026-08-23 - Complete DataTFT production retirement and bind Tencent rankings

- Deleted the complete DataTFT Daily Intelligence implementation, Runtime/UI
  readers, update task, browser transport, source health state, and local
  generations. No production file contains a DataTFT or Scrapling network URL.
- Deleted retired S17 live-ranking pointers, compatibility mirrors,
  generations, and history. S18 now reports rankings unavailable until a
  compatible Tencent/JCC Master+ generation is published.
- Made Tencent/JCC Master+ the sole production ranking adapter. A normal
  refresh targets the active Core Profile; the version pipeline uses an
  explicit candidate lane. Transport/unavailable errors degrade cleanly, while
  adapter, schema, identity, validation, and storage defects fail visibly.
- Bound every immutable Ranking Overlay to Core Profile, season, patch, catalog
  fingerprint, and hard-data-manifest fingerprint. Start Match captures one
  exact generation or explicit unavailable identity; later refreshes affect
  only the lobby and the next Match.
- Added Ranking Overlay leases and pruning alongside Core leases. Active,
  candidate, Match-leased, and bounded previous generations are protected.
- Kept evidence layers separate during deterministic cleaning: national
  Master+ trait rankings own strength and user-visible top-four/top-one/use
  rates; winning-lineup rows supply atomic recipes, roles, equipment and
  transitions; hero/item rows supply heat, contest and item preference.

Constraint: DataTFT blocks unattended extraction and cannot be a reliable
player-operated daily source.
Rejected: Retry around source blocking, ship another crawler, or retain
DataTFT as a hidden fallback | each would recreate an unreliable second
production authority.
Confidence: high
Scope-risk: broad
Directive: Future major and minor versions must run Tencent rankings through
the explicit Core-bound `rankings` phase; never infer a version from ranking
rows and never reactivate archived DataTFT network code.
Tested: The deterministic core product gate passed all 144 registered checks;
the UI TypeScript/Vite production build, Tencent source retirement guard,
immutable generation store, exact Match binding under A-to-B promotion,
lease-aware pruning, requirements authority, syntax checks, and diff hygiene
also passed.
Not-tested: No external Tencent request was made because current S18 ranking
data is not yet available and this task intentionally avoided network traffic.

## 2026-08-22 - Restore Master+ rankings as the only production big-data source

- Removed Daily Intelligence and DataTFT network extraction from current
  authority paths and the Runtime product-gate verifier registration.
- Restored Zhangmeng/Tencent Master+ live-rankings as the sole production
  big-data authority; `intelligence` remains only a compatibility alias for
  `rankings`.
- Preserved the S18 DataTFT material as an offline-frozen Core supplement and
  historical source evidence. Runtime and update networking must never access
  DataTFT, refresh it, or treat it as ranking evidence.

Constraint: Production updates must use the existing Master+ live-rankings
source and must not introduce a DataTFT network dependency.
Rejected: Keep DataTFT Daily Intelligence as a primary or auxiliary live
module | It creates a second production authority and violates the offline
S18 source boundary.
Confidence: high
Scope-risk: moderate
Directive: Future changes must update the Master+ ranking contracts and keep
the S18 DataTFT snapshot evidence-only.
Tested: JSON parsing and requirements-authority verification.
Not-tested: Runtime/UI implementation behavior was intentionally not changed.

## 2026-08-22 - Fail closed on source blocking and publish typed evidence

- Confirmed that DataTFT's own page request can return business code `42000`
  for the current source session or outbound IP. Added a persistent bounded
  circuit so Runtime does not keep retrying during cooldown.
- Kept the S18 Core Profile usable while Daily Intelligence is explicitly
  unavailable. Tencent remains auxiliary and cannot replace or manufacture the
  missing primary composite.
- Required all four domain generations to publish closed typed artifacts for
  unit heat/reroll/item recommendations, item category strength/holders,
  lineup statistics/burden/flexibility/heat/variants/playbooks/transitions,
  and typed tip lifecycle/resolution evidence.
- Switched Runtime evidence retrieval to typed artifacts first. Complete raw
  records remain only for discovery, provenance, and compatibility.
- Canonicalized the UI/Daemon action as `updateDailyIntelligence`; the old
  `updateRankings` name remains only as a compatibility alias. Error and queue
  persistence retain stable codes and bounded metadata, never source-returned
  IP, did, Cookie, stderr, or response bodies.

Constraint: The source is currently unavailable from this outbound IP, so no
real S18 Daily Intelligence composite can be published in this change.
Rejected: Retry around the block, add another crawler runtime, publish an empty
primary snapshot, or substitute Tencent/S17 evidence.
Confidence: high
Scope-risk: moderate
Directive: Repair only the source Adapter when the upstream contract changes;
do not weaken the source circuit, typed artifact gate, or version binding.
Tested: Offline four-domain publication, typed-first retrieval, source-circuit
cooldown, sensitive diagnostic redaction, canonical update action, Match-fixed
unavailable identity, Runtime migration, UI build, and focused architecture
verifiers. No post-block DataTFT or Tencent request was made.

## 2026-08-22 - Close Daily Intelligence publication races

- Made the active-pointer publish phase non-cancellable once commit begins;
  cancellation remains available during acquisition, semantic work, and apply.
- Bound every prepared task to the exact baseline composite and source
  identities it compared. A later same-version publication cannot silently
  replace unchanged generations during apply.
- Required explicit pagination evidence for every production DataTFT domain;
  a nonempty first page is not proof of completeness.
- Restricted automatic writer recovery to a verifiably dead same-host PID.
  Remote, malformed, and ownerless writer leases now fail closed.
- Required Start Match to hold the Daily writer lease while capturing the
  active composite and registering its first Match generation lease.
- Made clean window/Daemon shutdown wait for an active update to settle. A
  publish commit already in progress now finishes publication and Runtime
  finalization before Host sessions are closed.
- Made writer-lease creation atomic: the complete owner is written in a
  temporary sibling directory before the canonical lease path becomes visible.

Constraint: Daily publication, Match snapshot capture, cancellation, and
retention may execute concurrently without creating a mixed or pruned snapshot.
Rejected: Treat same-binding generations, elapsed lease time, or a nonempty
first page as sufficient identity/liveness/completeness proof.
Confidence: high
Scope-risk: moderate
Directive: Keep active-pointer commit short and non-cancellable; never add a
new generation reader that bypasses the writer-to-reader lease handoff.
Tested: Interleaved same-binding updates, missing pagination evidence across all
four domains, remote/ownerless leases, publish cancellation, and Match capture
ordering, plus the complete targeted Daily Intelligence verifier suite.

## 2026-08-22 - Lease Match-fixed Daily Intelligence generations

- Added a Runtime-owned Daily Intelligence generation lease alongside the
  existing Core Profile lease. One available Match snapshot protects all four
  captured domain generations until watcher and Host ownership retire cleanly.
- Required Daily pruning to reread the closed lease document while holding its
  writer lock. A preserve list captured when an update starts is not retention
  authority because a Match can start before publication finishes.
- Kept retention outside the publication commit: active-pointer activation is
  the commit, and a later pruning failure is reported separately without
  changing a successful update into a failure.

Constraint: A Match must keep reading its exact Knowledge Snapshot while a
daily update or retention pass runs concurrently.
Rejected: Protect only generations visible when update preparation begins | a
new Match can lease the previous composite after that snapshot is taken.
Confidence: high
Scope-risk: moderate
Directive: Every future Daily generation consumer must join the same closed
lease lifecycle; do not add ad hoc preserve arguments as a substitute.
Tested: Closed lease schema, malformed and released leases, active lease
retention, dependency invalidation, Core drift, and post-commit prune failure.

## 2026-08-22 - Reuse bundled Chromium for DataTFT source transport

- Kept DataTFT extraction on its signed JSON API, but moved network delivery
  through one isolated session owned by the Electron Chromium already shipped
  with Runtime. Static HTTP clients currently receive DataTFT business code
  `42000`.
- Rejected a new Scrapling/Python production dependency after both its static
  and browser experiments failed to provide capabilities beyond the existing
  Chromium session. The experimental environment and code were removed.
- Bounded the helper to six allowlisted API paths, a fixed signed-header set,
  128KiB request bodies, and 24MiB responses. Bootstrap failures, timeouts, and
  cancellation terminate the complete helper process tree.
- Treat DataTFT business rejection as primary-source failure: no empty snapshot
  is published, Tencent cannot replace the primary source, and the previous
  active composite remains unchanged.

Constraint: Daily updates must not add a second browser runtime or silently
publish incomplete primary data.
Rejected: Keep Scrapling as a permanent fallback | it added roughly 260MiB and
did not bypass the observed DataTFT rejection.
Confidence: high
Scope-risk: narrow
Directive: Replace only the source transport if DataTFT changes access rules;
do not alter source authority, version binding, cleaning, or publication.
Tested: Project-local dependency removal, source transport syntax, allowlists,
fixture API expansion, and active-pointer preservation on failed live prepare.

## 2026-08-22 - Make Daily Intelligence the optional version intelligence stage

- Added `intelligence` as the season-neutral optional phase in the generic
  version pipeline. The former `rankings` name remains only as a compatibility
  alias and no longer defines the architecture.
- Bound every update explicitly to the current Core Profile, season, patch, and
  catalog fingerprint. DataTFT owns primary values for units, items, lineups,
  and tips; Tencent is auxiliary corroboration or annotation only, is never
  averaged into primary values, and cannot block publication.
- Kept semantic enrichment in one bounded isolated maintenance provider
  session. The prepare result carries the maintenance knowledge capsule and
  changed batches into the existing closed `prepare -> apply -> publish`
  lifecycle.
- Defined unavailable Daily Intelligence as a nonblocking degraded capability.
  Missing or invalid current-version primary data preserves the prior active
  pointer and does not block an otherwise valid Core release.
- Made immutable per-domain generations, the immutable four-domain composite,
  and its atomic active pointer the publication authority. Start Match captures
  one compatible composite or explicit unavailable identity and fixes it with
  the Core/Season/Patch snapshot for the entire Match.
- Registered the Daily Intelligence core and receipt contracts under the
  season/version authority domain and exposed the focused source, store,
  update, Runtime, and governance verifiers through the Harness version-update
  profile.

Constraint: Daily Intelligence must remain optional and season-neutral while
preserving exact version identity and coherent Match evidence.
Rejected: Keep Tencent rankings as the primary pipeline stage or let a live
Match advance to a newer composite | both preserve split authority or permit
mixed-version decisions.
Confidence: high
Scope-risk: moderate
Directive: Add future intelligence sources as explicitly classified primary or
auxiliary inputs under the same immutable composite and exact binding contract.
Tested: Targeted Daily Intelligence governance, core/store, source, update,
Runtime binding, JSON parsing, and requirements-authority verification.

## 2026-08-22 - Narrow trait-diversity support to the playable default policy

- Replaced the 11 emblem-support branches with one no-emblem branch for
  populations 4 through 10. Emblem combinations remain a player-managed input
  and are not cached or searched by this companion asset.
- Applied the tracker UI's default requirement of one high-cost tank role and
  one high-cost carry role. Population 4 has no cached solution satisfying both,
  so only its two maximum-trait, maximum-high-cost degraded fallbacks remain.
- Reduced Runtime-selectable atomic rosters from 3,080 internal cache rows to 43
  bounded candidates across seven population shards. Population 8 retains four
  10-trait primary options and one easier 9-trait fallback.
- Ranked equal-objective candidates by current-patch 4/5-cost unit count, then
  compiled common-unit evidence and 4-to-10 population transition plans.
- Limited the companion asset to `拼盘天梯` and `终身黄铜 I/II`; `并肩作战 I`
  remains a normal augment and no longer opens this roster-search path.

Constraint: The source tracker is an objective solver, not lineup-strength
evidence. National Master+ data may only rerank objective-eligible rosters.
Rejected: Cache every emblem branch or expose all search-cache rows | both add
large irrelevant state and misrepresent internal search candidates as choices.
Confidence: high
Scope-risk: moderate
Directive: Keep future companion data bounded to declared product variables and
derive accessibility fallbacks and population transitions offline.
Tested: Source filtering, deterministic staging, high-cost ordering, atomic
rosters, common-unit summaries, and transition metadata.

## 2026-08-22 - Correct trait-diversity source semantics and shard Runtime loading

- Corrected the DataTFT tracker terminology: its 3,080 rows are upstream
  precomputed search candidates across 11 emblem-support conditions, seven
  population buckets, and 40 cached rows per bucket. They are not 3,080
  distinct final recommendations.
- Corrected the 21,560 value to `unit_slot_occurrences`. It counts repeated
  champion slots across those candidate rows; 61 distinct champions occur in
  the tracker snapshot while the authoritative S18 catalog contains 65.
- Replaced the 9.53MB monolithic normalized support file with one approximately
  68KB immutable descriptor and 77 hash-addressed shards. Runtime validates and
  reads at most one relevant population/emblem shard, currently 35KB to 93KB,
  for a related request.
- Preserved each source candidate row as one atomic roster. Runtime may rank or
  filter complete rows but may not splice champions from different rows.

Constraint: Source reproducibility requires retaining the full upstream cache,
while real-time requests must not parse or carry the entire cache.
Rejected: Treat source-cache rows as final recommendations or load one expanded
multi-megabyte normalized document | both misstate the data and waste the
Runtime hot-path budget.
Confidence: high
Scope-risk: moderate
Directive: Future companion optimizers must distinguish source candidates,
repeated slot occurrences, unique entities, and user-visible selected results.
Tested: Source snapshot semantics, deterministic sharded staging, compiler
reference isolation, and bounded Cruise shard retrieval.

## 2026-08-22 - Add shared atomic trait-diversity roster support

- Cached the complete DataTFT S18 trait-tracker source during the patch source
  phase and preserved its precomputed candidate rows as atomic rosters in an
  immutable S18.1 companion hard-data dataset.
- Bound `拼盘天梯`, `终身黄铜 I`, `终身黄铜 II`, and `并肩作战 I` to shared
  objective definitions by reference. Complete roster lists are not copied into
  augment entities, the Core Profile bundle, the static Host capsule, queues, or
  SQLite.
- Added typed, hash-validated Runtime retrieval that selects the relevant
  population and owned-emblem branch only when a related question is asked.
  Runtime never calls DataTFT during a match.
- Kept evidence authority separated: the tracker maximizes the augment's trait
  objective, while national Master+ rankings remain the only lineup-strength
  authority and may rerank eligible results afterward.

Constraint: The player needs the full upstream solution space available without
making mode switches, match startup, or ordinary Host turns carry megabytes of
duplicate roster data.
Rejected: Inline every roster into each augment or fetch the tracker live during
play | both create duplicate state, latency, and upstream availability risk.
Confidence: high
Scope-risk: moderate
Directive: Future season-mechanic optimizers use the same shared companion-asset
pattern and must not become ranking evidence unless their source is Master+.
Tested: Source parser and snapshot verifier, deterministic hard-data staging,
compiler reference isolation, and Cruise on-demand population/emblem retrieval.

## 2026-08-22 - Promote standard progression, player damage, and augment-tier probabilities to Common

- Kept the verified Common XP curve: 7 to 8 requires 60 XP, 8 to 9 requires
  68 XP, and 9 to 10 requires 68 XP. The conflicting DataTFT XP values are
  retained only as supplemental audit evidence and cannot override Runtime math.
- Updated Common PVP player-damage bases to stages 2 through 8 values
  2/6/7/10/12/17/150 plus surviving-unit damage 1 through 8.
- Moved the 18 augment-tier sequence rows into Common and registered the first
  augment tier as a uniform one-third distribution across silver, gold, and
  prismatic. The player-facing rounded value is 33% for each tier.
- S18 compilation now reads progression, player damage, shop tables, pool sizes,
  and augment-tier probabilities from Common. DataTFT rate data compares these
  fields and continues to supply S18 reward tables, but cannot silently replace
  Common values.

Constraint: The developer confirmed the XP source error, the current player-
damage table, and the season-neutral ownership of these mechanics.
Rejected: Keep S18 patch overrides for standard mechanics | it would duplicate
Common authority and allow a supplemental page error to alter deterministic math.
Confidence: high
Scope-risk: moderate
Directive: Standard-mechanic source conflicts remain auditable; only an explicit
major-season exception may override Common in a compiled profile.
Tested: Common baseline, formula evaluator, deterministic S18 staging, source
comparison, compiler, typed probability retrieval, and requirements authority.

## 2026-08-22 - Retract mistaken supplemental augment admissions

- Superseded the same-day patch-exception decision. The seven DataTFT-only rows
  `战时补给：女神之泪`, `星界恩典I`, `集中火力`, `意外之礼`, `意外之礼+`,
  `神力天铸`, and `绝境反击` are absent from the current official catalog and
  remain excluded from production.
- `锻造挚友` at 4-2 and `新纪元+` at 3-2 are ordinary matched S18 hard-data
  facts from the pinned supplemental source, not patch exceptions.
- Removed the source-adapter path that admitted supplemental-only augments. The
  production catalog returns to the official 260 entities; DataTFT enriches only
  deterministically matched official entities.
- Minor patches inherit the prior promoted patch's complete validated entity,
  stage, effect, alias, and parameter tuple. A later S18 patch changes only the
  fields explicitly supplied by the developer or an authoritative source.

Constraint: The developer corrected the seven names after checking the latest
official data and clarified that unchanged stage facts persist across minor
patches.
Rejected: Keep a general patch-exception admission file | it would turn normal
version facts into special cases and permit supplemental-only entities to bypass
the official membership authority.
Confidence: high
Scope-risk: narrow
Directive: Derive a minor-patch candidate from the previous validated tuple,
apply explicit deltas, and never require unchanged augment stages to be restated.
Tested: targeted S18 source staging, exact official catalog membership, ordinary
DataTFT stage enrichment, unmatched-row exclusion, and immutable compilation.

## 2026-08-22 - Register confirmed S18.1 augment stage exceptions

- Added a patch-scoped, developer-confirmed exception list for nine augments
  whose current stage or membership was missing from the official API and
  supplemental-source match.
- `锻造挚友` is fixed at 4-2 and `新纪元+` at 3-2.
- Seven confirmed missing entities are admitted only by exact DataTFT source id,
  name, tier, and declared rounds: `战时补给：女神之泪`, `星界恩典I`,
  `集中火力`, `意外之礼`, `意外之礼+`, `神力天铸`, and `绝境反击`.
- The unrelated `白银命运`, lower-value `新纪元`, and `挑个好伙计！`
  rows remain excluded. The exception mechanism does not grant DataTFT general
  entity authority.

Constraint: The developer confirmed these current-patch stages after comparing
the live S18 behavior; only the listed rows may bypass a missing official API
entry.
Rejected: Admit every remaining DataTFT-only augment | it would reintroduce
stale or semantically different rows without bounded evidence.
Confidence: high
Scope-risk: narrow
Directive: Future additions require an explicit patch exception entry with
canonical name, source id, tier, rounds, and a verifier assertion.
Tested: deterministic staging, exact nine-entry exception application, seven
bounded admissions, three continued exclusions, and stage-authority generation.

## 2026-08-22 - Correct S18 augment authority and add typed reward retrieval

- Superseded the 2026-08-21 assumption that the stale 186-row Markdown export
  was the complete official catalog. The current Mode 18 official endpoint is
  authoritative and contains 260 rows; all 260 now remain in the canonical
  patch catalog.
- DataTFT remains supplemental. Of its 256 rows, 246 source rows map to 245
  official entities; the duplicate name "光明无赖" is retained as an audited
  alias of official "交给运气" rather than becoming a second augment.
- Differently named rows may match only by declared alias, identical normalized
  effect, or unique same-tier resource identity plus the same effect-number
  signature. Ten remaining DataTFT rows have no current official equivalent or
  materially different values and remain audit-only.
- Added S18 mechanic probabilities and reward tables, including entity rewards,
  four orb tables, and atomic multi-item outcomes, to the immutable Core Profile
  compilation path. Runtime retrieves only the table relevant to the current
  question and never places the complete source dataset in every Host turn.

Constraint: Current official entity membership and naming stay authoritative;
supplemental sources provide stages, categories, aliases, mechanics, and reward
details only after deterministic matching.
Rejected: Publish all DataTFT rows as independent augments | duplicate and
stale/test rows would leak into the player-facing catalog.
Confidence: high
Scope-risk: moderate
Directive: Refresh the official current catalog before evaluating supplemental
coverage; never infer entity deletion from a stale exported document count.
Tested: official 260-row snapshot, DataTFT rate schema, deterministic S18
staging, renamed-equivalent recovery, changed-number rejection, atomic reward
bundles, and bounded typed hard-data query selection.

## 2026-08-21 - Official S18 augment membership is authoritative

- Fixed the S18 augment catalog at the 186 official Mode 18 level 1-3 rows
  (50 silver, 80 gold, 56 prismatic).
- DataTFT continues to enrich the 177 matched official augments with stage,
  category, and alias metadata, but its 79 unmatched rows are excluded from
  normalized catalogs, stage indexes, semantic lookup, and Runtime UI choices.
- Generalized the source-authority contract so supplemental rows cannot silently
  create production entities without an explicit manifest grant and verifier.

## 2026-08-21 - Close immutable hard-data write and pruning bypasses

- Source adapters may write only to guarded staging directories; legacy
  builders fail before mutation when aimed at active or content-addressed
  generations.
- Hard-data publication, patch-candidate pointer replacement, and pruning now
  share one lifecycle lock.
- Compiler validation rejects a `hard_data_candidate` whose generation differs
  from its generation-owned source artifacts.
- Runtime generation acceptance verifies the package manifest, content
  manifest, and every declared artifact hash.

## 2026-08-21 - Make patch hard data immutable and content-addressed

- Source adapters now publish normalized patch hard data under
  `data/core-patches/jcc/generations/<hard_data_generation_id>/` and atomically
  update only the patch candidate reference. A same-patch refresh cannot mutate
  bytes used by the active Core Profile.
- The generic `prune` phase now resolves Core retention first, then deletes only
  hard-data generations unreferenced by retained Core bundles or registered
  patch manifests.
- DataTFT nature-sprite stage metadata is bounded to the actual S18 lifecycle
  through `8-1`; longer source ranges remain provenance-only audit data.
- Official nature-sprite and augment names remain canonical. A differently
  named supplemental row is merged only through a declared source-family alias
  or one unique exact full-lifecycle content match; its source name remains an
  alias and its stage metadata remains supplemental evidence.

Constraint: Runtime and active matches must remain byte-stable while a source
refresh for the same patch is being built.
Rejected: Rewrite `data/core-patches/jcc/jcc-s18-s18_1` in place | that creates
a window where an already-promoted Core Profile reads different source bytes.
Confidence: high
Scope-risk: moderate
Directive: Future Source Adapters must publish through the generic hard-data
store and register their source-specific verifiers in the patch manifest.
Tested: deterministic staging, official-name canonicalization, stage cap,
idempotent generation publication, collision rejection, reference-aware prune,
and the generic version gate.

## 2026-08-21 - Add audited S18 supplemental hard-data authority

- Added a pinned DataTFT S18 database snapshot as a supplemental patch source,
  while retaining the user-provided official documents as primary authority for
  matched hero, trait, equipment, augment, and nature-sprite values.
- Audited 65 heroes and 36 traits with complete name coverage. Item and augment
  differences are retained in a generated source audit rather than silently
  overwriting official rows.
- Added exact augment stages and six source-defined categories to the compiled
  decision-input catalog. The common Augment card now renders catalog labels as
  multi-select checkboxes and composes category, stage, and tier filters with OR
  semantics across selected categories.
- Canonicalized nature-sprite page variants into one entity with base, upgrade,
  optional prismatic, category, requirements, round ranges, and stage groups.
  The mechanic remains a shop extension and does not become a manual variable
  or a structured choice Mode.
- Adversarial review locked source precedence at field level: matched
  nature-sprite base, upgrade, and prismatic effects and costs now come only
  from ordered official variants. DataTFT disagreements are retained in the
  supplemental conflict audit, and stage groups are derived from every legal
  round through `8-1`.
- Narrowed MuMu runtime-ID receipt identity from the entire Runtime catalog to
  the champion mapping only. Unrelated augment or item metadata changes no
  longer invalidate already verified hero-ID evidence.
- Hardened live MuMu mapping evidence so every relevant event must carry one
  shared nonempty match-session id and a valid observation timestamp before it
  can contribute to command counts or ID coverage.
- Preserved the existing August 21 mapping receipt through an explicit legacy
  producer attestation: the sole watcher event factory had guaranteed a
  nonempty match id and ISO timestamp since commit `177f9b18`, before capture.
  The receipt discloses that raw events were not replayed; all future receipts
  require the new per-event validation path.
- Advanced the Core Profile compiler revision so category metadata changes
  cannot collide with an older immutable generation.

Constraint: The supplemental site is not the official balance authority and is
consumed only as a pinned, hashed, verified build input.
Rejected: Read the live site from Runtime or replace official rows wholesale |
that would make active matches network-dependent and erase source conflicts.
Confidence: high
Scope-risk: moderate
Directive: Refresh the snapshot through its sync tool, inspect the generated
conflict audit, then run the generic source/inspect/compile/verify/promote
pipeline; Common UI must never hardcode these category names.
Tested: source decryption and counts, deterministic S18 staging, exact-stage and
category filtering, complete nature-sprite round grouping, official-value
preservation, Quick OCR legality, canonical nature-sprite upgrades, missing
MuMu session/timestamp rejection, UI typecheck/build, and full version gate.

## 2026-08-21 - Validate S18 MuMu identity mapping from bounded live evidence

- Hardened the live mapping receipt as recomputable evidence rather than a
  trusted aggregate: command counts, timestamps, match identity, raw-id
  uniqueness, canonical/star mappings, coverage totals, and the exact
  acceptance-rule set now fail closed on drift. Invalid MuMu prefixes and
  non-integer ids are rejected before catalog decoration.
- Added every itemization index consumed by the active Runtime
  (`component_to_item_candidates`, `item_wait_cost`, `item_conflicts`, and
  `item_holders`) to the season-neutral S18 compiler output. Required
  itemization reads no longer silently degrade missing package assets to empty
  evidence.
- Added the real active hard-data package, itemization consumer, and
  season-isolation checks to the version promotion profile. The hard-data
  verifier now validates content-addressed modern packages from their manifest
  while retaining the archived S17 verifier path for historical audit.
- Separated the local S18 package identity from the upstream S19 source
  namespace in the compiled Core Profile, aligned the optional-ranking policy
  across current contracts, and replaced shared Runtime S17 wording with a
  descriptor-driven season-neutral rule.
- Replaced the provisional S18 MuMu mapping blocker with a registered,
  season-neutral verifier and a compact receipt derived from one complete live
  match. Raw match events remain transient and are not copied into a Core
  Profile.
- The live sample covered 73 raw ids: 72 resolved against the S18 catalog, 32
  canonical champions agreed across multiple MuMu sources, and 10 champions
  agreed across multiple star levels.
- One id, `15468`, appeared only in the Riftbeast takeover shop and is absent
  from the official champion catalog. It remains an explicit S18.1 limitation;
  unknown board or bench ids still fail activation.
- Consolidated hero-id normalization into one shared parser and corrected the
  prior error that labeled a two-star MuMu id as three-star.
- Extended the season Source Adapter to compile the Runtime decision indexes
  consumed by Cruise and deterministic combat context from normalized S18
  champions, traits, items, and augments. The active package no longer depends
  on S17 decision indexes or silently omits them.
- Runtime ranking status and update completion now fail closed when no Ranking
  Overlay matches the active Core Profile. S18 remains fully usable from
  Common, Core hard data, deterministic indexes, and live facts while Master+
  rankings are unavailable.
- Registered live mapping captures and temporary MuMu inspection APKs as
  allowlisted disposable artifacts after their bounded receipt is generated.

Constraint: A complete official catalog cannot assign an invented champion
identity to an undocumented shop-only payload.
Rejected: Keep all S18 runtime mapping blocked by one shop-only unknown | live
evidence proves normal shop, board, bench, and star-prefix mapping independently.
Confidence: high
Scope-risk: moderate
Directive: Future patch exceptions must be explicit shop-only ids backed by a
new bounded receipt; never allow unresolved own-board or bench ids.
Tested: shared hero-id normalization, live receipt generation and replay,
MuMu watcher regression, deterministic S18 source staging, Runtime decision
index consumers, ranking-unavailable isolation, active Runtime knowledge
integration, local artifact pruning, and complete version gates.

## 2026-08-21 - Make Master+ rankings a version-targeted optional release phase

- Added `rankings` as a first-class generic version-pipeline phase. It resolves
  season, patch, mode, catalogs, and Core Profile identity from the exact
  compiled candidate instead of the prior active season.
- Candidate ranking refresh now publishes one verified immutable generation and
  `candidates/<core_profile_id>.json` without replacing the production ranking
  pointer. Promotion activates it only with the matching Core Profile.
- Missing new-season rankings no longer block otherwise valid hard data.
  Runtime exposes rankings as unavailable, clears stale foreign-season dates,
  and continues with Common, Core hard data, deterministic math, and live facts.
- Minor-patch labels remain internal release identity. Tencent only needs to
  supply the latest available `stat_date`; catalog compatibility proves the
  dataset belongs to the selected compiled profile.
- Ranking completeness thresholds now derive from the selected Core Profile
  catalogs; S17 entity counts can no longer reject a valid S18 dataset.
- Added positive payload identity auditing for endpoints without a version
  parameter. Foreign-season hero, lineup, and carry ids now reject publication
  before local S18 labels or fingerprints can be attached.

Constraint: A new major season may be playable before Tencent publishes its
Master+ ranking dataset, but old-season rankings must never be presented as a
fallback.
Rejected: Infer season or patch from ranking rows | the upstream API does not
authoritatively expose the local minor-patch identity and can lag a release.
Confidence: high
Scope-risk: moderate
Directive: Future major-version updates must run the generic pipeline with an
explicit candidate identity; do not add season-named ranking scripts.
Tested: ranking target resolution, candidate/active publication isolation,
explicit generation activation, Runtime candidate-ready status, version
pipeline architecture, requirements authority.

## 2026-08-21 - Bind retired cleanup to archived season identity

- Destructive retired Runtime cleanup now requires an explicit `--season-id`, a
  valid registered archive manifest, and a season that is neither active nor a
  Core Profile candidate.
- Successful DB reset writes an archive-bound receipt. Local artifact pruning
  requires that receipt for the same season and unchanged archive identity.
- Added isolated rejection coverage for unarchived, active, and candidate
  seasons plus the valid archived-season reset and prune path.

## 2026-08-21 - Runtime retention closes old-match and Wiki work accumulation

- SQLite retention now runs at daemon startup, Start Match, Stop Match, and clean shutdown; diagnostics are bounded by row and byte budgets, including a global terminal-queue ceiling.
- Wiki curation now carries one canonical `run_id` from request creation through response application. Abandoned runs expire after 24 hours, terminal runs rotate, and unreferenced source inputs are pruned without deleting source evidence used by Wiki pages.
- The explicit retired-version reset and local-artifact prune remain the season-archive cleanup path; durable user preferences, provider sessions, published Wiki, Core Profiles, rankings, and source archives remain preserved.

## 2026-08-21 - Separate retired-version garbage from durable user knowledge

- Added a developer-only retired-version cleanup that deletes old Match
  sessions, queues, events, logs, transient Wiki curation inputs, compatibility
  match mirrors, monitor snapshots, OCR calibration captures, and generated
  verification reports.
- Preserved canonical SQLite, user preferences and memory, published Wiki,
  the daily session, provider-native conversation history, Core Profiles,
  ranking generations protected by retention, source archives, plans, and
  runtime dependencies.
- Added cleanup-boundary verifiers and kept normal runtime retention separate
  from the explicit season-retirement reset.

Constraint: S17 raw operational evidence is not valid S18 knowledge or review
memory, but user-authored durable state must survive the cleanup.
Rejected: Delete all `.jcc-runtime-data` or all `.omx` content | that would
destroy canonical preferences, provider conversations, build dependencies, and
source evidence together with disposable diagnostics.
Confidence: high
Scope-risk: moderate
Directive: Future season cleanup must use the allowlisted dry-run-first tools;
never identify garbage only by file extension, age, or directory size.
Tested: local artifact prune boundary, retired-version SQLite reset, runtime DB
maintenance, and requirements authority.

## 2026-08-21 - Close live-match Core Profile race conditions

- Rebound crash-recovered matches to their persisted immutable Core Profile
  before Host transport recovery and reasserted the generation lease.
- Required match context-pack and worker-plan children to receive the exact
  snapshot, artifact paths, and expected Profile id instead of resolving the
  latest active pointer.
- Removed daemon-startup Profile caching from Cruise combat and lineup
  lifecycle helpers; supporting contexts now share the Profile captured for
  the current Match.
- Added A-to-B promotion-race verifiers to the standard `version_update`
  profile, including Quick OCR catalog pinning.

Constraint: One live Match must remain one immutable version even across
promotion, context rebuild, mode changes, and abnormal daemon restart.
Rejected: Use match-session id as an indirect version lookup | it does not
identify or validate the immutable artifacts and permits mixed generations.
Confidence: high
Scope-risk: moderate
Directive: Every new match-scoped consumer receives the captured Profile
context explicitly; no helper may independently resolve `active-profile.json`.
Tested: match Core Profile binding, Cruise Profile binding, explicit augment OCR
draft, context pack, worker plan, Start Match isolation, and requirements
authority.

## 2026-08-21 - Freeze archived seasons before candidate publication

- Added an archive-registry guard before writable Core Profile compilation.
- Kept archived-season `inspect` and shared read-only `verify` available for
  audit. Frozen adapter verifiers run when retained; older archives report their
  absence without weakening active-season verifier requirements.
- Added a byte-level regression that snapshots the candidate and every file in
  the generated tree, attempts archived `compile --write`, and proves no path,
  byte count, or SHA-256 changed.

Constraint: Archive registration is a write boundary, not only a promotion
blocker.
Rejected: Allow archived compilation to overwrite the shared candidate while
relying on promotion to fail later | it mutates release state and generation
retention inputs for a frozen season.
Confidence: high
Scope-risk: narrow
Directive: New writable pipeline phases must check archive registration before
opening or creating any candidate or generated artifact.
Tested: version-pipeline architecture verifier and requirements authority.

## 2026-08-21 - Retire legacy rule-injection verification

- Replaced the season-isolation verifier's temporary `normal-rules` and
  `special-rules` injection path with direct S17/S18 Core Profile compilation.
- The release gate now verifies identical Common content, isolated season
  descriptors, separate active/candidate pointers, activation blockers, and
  Start Match artifact pinning.
- Removed the last S18-specific calculation disclosure from Common Host policy;
  optional season inputs and missing-value disclosures now come only from the
  captured season descriptor.

Constraint: Production has no legacy rule-file fallback, so release tests must
exercise the same immutable Profile boundary as Runtime.
Rejected: Reintroduce a test-only compatibility path into `loadActiveRulesBundle`
| it would preserve an obsolete authority model and could later leak into
production.
Confidence: high
Scope-risk: narrow
Directive: New season-isolation tests compile registered descriptors and patch
sources; do not synthesize production Runtime paths from retired rule files.
Tested: `verify-jcc-season-version-isolation`, Core Profile compiler, and
requirements authority.

- Updated the current product-readiness guide to point at Common doctrine and
  immutable Core Profiles instead of the retired `base-game-rules.json`
  source format.
- Recorded the external architecture lineage and the no-dependency decision in
  the version-governance runbook so future Harness agents do not reintroduce a
  second pipeline or relation authority without a concrete scaling trigger.
- Adversarial review found that augment Quick OCR and structured decision-card
  validation could still resolve the latest active decision catalog during an
  older live match. Catalog caching is now keyed by immutable artifact path,
  active matches resolve the path and expected identity from their Start Match
  snapshot, and Quick OCR receives that path explicitly.

## 2026-08-21 - Bind verification, identity, and match consumers to one Core Profile

- Made the version pipeline freeze one candidate snapshot and bind pre-check,
  registered verification, post-check, and pointer commit to the same expected
  Core Profile id.
- Removed the standalone promotion CLI and removed implicit pruning from the
  low-level pointer commit; archive and prune remain explicit lifecycle phases.
- Added every indirectly consumed normalized catalog payload to Core Profile
  identity, so same-path source mutation necessarily changes the generation id.
- Captured the compact Core Profile reference and immutable artifact paths at
  Start Match, and made Cruise, itemization, and DecisionMath consumers use the
  captured generation rather than rediscovering the latest active pointer.
- Moved optional season-mechanic calculation defaults and disclosures into the
  season descriptor, eliminating the shared Runtime's S18 branch.
- Made season archive registration atomic and made pruning protect every Core
  Profile referenced by the archive registry.

Constraint: A live match and a release transaction must each observe exactly
one immutable generation even when another update occurs concurrently.
Rejected: Verify the mutable candidate and reopen it during commit | that permits
time-of-check/time-of-use replacement and mixed-generation answers.
Confidence: high
Scope-risk: moderate
Directive: Future adapters add payloads through the compiler's consumed-payload
identity set; never add a second release CLI or a Runtime consumer that resolves
`active-profile.json` independently during an active match.
Tested: version-pipeline architecture, compiler mutation identity, profile store,
season archive, itemization, hard-data query, Runtime knowledge integration,
S18 patch verifier profile, requirements authority, and blocked promotion with
byte-identical active pointer.

## 2026-08-21 - Make source verification patch-owned

- Kept architecture, compiler, profile-store, archive, identity, neutrality,
  and requirements checks in the shared `version_update` profile.
- Moved source-format verification commands and arguments into each patch's
  `source_adapter.verifiers` declaration.
- Made `verify --season <id> --patch <id>` and promotion execute both layers,
  including the architecture guard that was previously skipped by the wrapper.

Constraint: Future seasons may use different upstream formats without adding
season branches or named verifier profiles to the shared Harness.
Rejected: Keep `s18_source_adapter` in the global Harness contract | that would
force every future season to edit public orchestration for private source details.
Confidence: high
Scope-risk: narrow
Directive: A new patch adapter must be self-verifying; never waive or manually
reproduce its verifier arguments in provider-specific scripts.
Tested: `run-jcc-version-pipeline verify --season s18 --patch s18_1`,
`verify-jcc-version-pipeline-architecture`, and `verify-jcc-requirements-authority`.

## 2026-08-21 - Complete holder facts and Core-Profile-only domain solvers

- Unified Current Turn Delta sizing at one 256KB in-memory ceiling while keeping
  successful diagnostics at 64KB and all complete Host payloads out of SQLite.
- Required an independent Cruise no-big-data action; generic chat cannot supply
  its evidence capability fields.
- Added one common target/variable-panel holder editor backed by the same
  canonical `user_confirmed_equipment.equipped_items` revision as Quick Record.
- Made equipped and inventory locations mutually exclusive for the same proven
  physical copy, while preserving duplicate owned copies.
- Added executable Core-Profile-only augment and lineup evaluators alongside
  the item optimizer; all three expose assumptions, unresolved effects, source
  audit, and must not claim ranking strength or exact combat simulation.
- Preserved official parent equipment categories and optional artifact subtype
  provenance without making a missing subtype block normal artifact use.
- Adversarial review additionally removed raw public-action messages from
  daemon queues, runtime events, canonical state, SQLite, WAL, and SHM while
  preserving the active in-memory turn; made Host request references
  idempotent; fixed sparse holder-slot hydration; prevented incidental emblem
  text from hijacking lineup queries; and excluded reward containers,
  selectors, and technical rows from player-equippable catalogs.

Constraint: The official equipment page publishes the parent categories but
does not publish an Ornn-or-other artifact subtype taxonomy for every artifact.
Rejected: Persist holder state only in provider conversation | match facts must
remain canonical, editable, and shared by Quick Record and structured UI.
Confidence: high
Scope-risk: moderate
Directive: Future season catalogs may add artifact subtypes, but Runtime must
consume the normalized optional field rather than hard-code a season list.
Tested: `verify-jcc-equipment-data-entry`, `verify-jcc-hard-data`,
`verify-jcc-decision-input-catalog`, `verify-jcc-match-fact-capture`,
`verify-jcc-user-confirmed-equipment-context`,
`verify-jcc-decision-math-service`,
`verify-jcc-itemization-decision-context`,
`verify-jcc-cruise-hard-data-query`,
`verify-jcc-canonical-host-request-persistence`,
`verify-jcc-public-action-message-persistence`,
`verify-jcc-host-context-storage-budget`,
`verify-jcc-choice-composer-prefill-ui`, `verify-jcc-decision-input-ui`,
`verify-jcc-structured-card-backend-actions-blackbox`,
`verify-jcc-pinned-card-browser`, `verify-jcc-runtime-daemon`,
`verify-jcc-daemon-control-lane-contract`, `verify-jcc-requirements-authority`,
and the UI production build.

## 2026-08-20 - Add an explicit Core-Profile-only theorycraft capability

- Added a Cruise composer action that creates a typed `hard_data_query` with a
  separate `active_core_profile_only` evidence capability; copied or manually
  typed visible text cannot activate it.
- Forbidden daily rankings, Meta Map strength, winning-lineup strategy
  packages, hero-item ranking signals, strategy Wiki, cached ranking state, and
  rank-derived Cruise obligations from retrieval and scoring for that turn.
- Added a Common decision-input and optimizer lifecycle while keeping item,
  augment, and lineup candidate legality and objective semantics in separate
  domain adapters.
- Added deterministic item-loadout theorycraft with normal completed items as
  the default pool, explicit-only special categories, missing-input thresholds,
  multiple objectives, unresolved-effect disclosure, and source provenance.
- Preserved artifact source subtypes when upstream data supplies them, while
  keeping subtype-less artifacts usable and allowing the Runtime UI to present
  one merged artifact row.
- Replaced the single 128KB absolute Turn limit with a 192KB compaction target
  and 256KB absolute in-memory ceiling, so a complete atomic strategy package
  or deterministic theorycraft result is not forced through an unsafe final
  truncation while ordinary requests remain targeted at the smaller budget.

Constraint: The live provider session may have seen ranking context on earlier
ordinary turns, so the enforceable promise is that ranking-derived evidence
does not participate in this turn's retrieval, calculation, scoring, or payload.
Rejected: Infer "do not use big data" from natural-language text | visible text
must not grant an evidence capability or silently alter product behavior.
Confidence: high
Scope-risk: moderate
Directive: Future augment and lineup theorycraft adapters must consume the same
closed evidence policy and source audit, but must not reuse the item optimizer's
domain scoring formula.
Tested: `verify-jcc-cruise-hard-data-query`,
`verify-jcc-decision-math-service`, `verify-jcc-itemization-decision-context`,
`verify-jcc-choice-composer-prefill-ui`,
`verify-jcc-canonical-host-request-persistence`,
`verify-jcc-host-context-storage-budget`,
`verify-jcc-host-request-runtime-context`,
`verify-jcc-electron-host-request-smoke`,
`verify-jcc-runtime-ui-mode-contract`, UI TypeScript/Vite build,
requirements-authority verification, syntax checks, and `git diff --check`.

## 2026-08-20 - Promote the standard game baseline into Common authority

- Added the all-season baseline for objective, rounds, PVP/PVE, player damage,
  economy, XP and levels, star-up, shop odds, shared-pool sizes, single-hit
  damage, carousel checkpoints, and player terminology.
- Corrected deterministic execution so true damage still applies explicit
  durability, stage-five PVP base damage is 6, and a five-round streak grants
  2 gold while six or more grants 3.
- Replaced the S18 package's S17 carried-forward shop/pool declaration with a
  fingerprinted resolved copy of the Common standard; only explicit verified
  season exceptions may replace it.
- Registered standard carousels as advisory stage checkpoints without adding a
  card, manual variable, or Runtime Mode.
- Downgraded missing official S18 augment-stage authority from a release blocker
  to a known limitation because catalog search, manual recording, and analysis
  remain functional; unknown-stage entries still do not become fake official
  stage evidence.

Constraint: These rules are the current user-confirmed standard across seasons;
season packages still own entities, balance values, unique mechanics, and
explicit exceptions.
Rejected: Keep shop odds, pool sizes, economy, and progression authored inside
each season package | that duplicates authority and invites silent drift.
Confidence: high
Scope-risk: moderate
Directive: Change Common only when the standard game changes; otherwise compile
it into each Core Profile and keep season-specific data separate.
Tested: Common baseline verifier, formula evaluator fixtures, deterministic S18
staging, game-knowledge compiler, DecisionMathService, and season neutrality.

## 2026-08-20 - Separate Common game math from version parameters

- Moved formula definitions and evaluator input contracts into the season-neutral
  Common knowledge layer instead of selecting them from the active S17 package.
- Added a bounded `DecisionMathService` that composes active-profile champion,
  item, augment, trait, shop/pool, and season-mechanic values before executing a
  registered Common formula.
- Added S18 version parameters for standard merge rules, shop odds, pool sizes,
  and combat baselines with explicit carried-forward provenance.
- Completed the Common concept loop for match objective, rounds, units, star
  upgrades, traits, lineups, combat, and the shared unit pool.
- Kept S18 `manual_variable_fields` empty and made the generic panel present an
  explicit target-only field instead of claiming S18 has manual variables or
  silently promoting a temporary preference into a durable target.
- Hardened the calculator after adversarial review: explicit unresolved
  entities fail closed, only compiled unconditional effects alter static
  values, trait prose remains conditional, depleted-target shop estimates need
  a total pool value, and every result carries the captured Core Profile source
  identity.
- Trimmed target text at the Runtime persistence boundary so whitespace cannot
  create a high-confidence durable target plan.

Constraint: S18 is a candidate Core Profile until its release blockers clear,
but its data and mechanics must be testable without making S17 own Common math.
Rejected: Copy the S17 formula package into S18 | that would fork universal
algorithms and repeat the version-coupling defect.
Confidence: high
Scope-risk: moderate
Directive: New seasons provide values and mechanic modifiers; they do not fork
Common calculation kernels or create season-specific calculator branches.
Tested: Formula evaluator, DecisionMathService adversarial fixtures,
deterministic S18 staging, season-variable renderer contract, UI build, and
requirements authority.

## 2026-08-20 - Keep one final S17 hard-data archive

- Removed the superseded pre-final S17 hard-data snapshot and its historical
  requirements entry.
- Kept `17.17.8` as the sole frozen S17 hard-data package used for reproducible
  rollback and archive verification.
- Regenerated the S17 archive manifest so no deleted package path remains a
  retention obligation.

Constraint: S17 is frozen and does not need two full hard-data snapshots in the
working tree.
Rejected: Retain the older snapshot as duplicate rollback evidence | the final
S17 package already supplies the required reproducible archive boundary.
Confidence: high
Scope-risk: narrow
Directive: Do not reintroduce pre-final S17 packages into active or archived
Runtime inputs without a new explicit retention requirement.
Tested: Season archive rebuild and verifier, requirements authority, mainline
path verifier, and repository-wide deleted-path search.

## 2026-08-19 - Retire permanent Runtime telemetry artifacts

- Deleted the proxy evidence generator, telemetry ingest/export/install chain,
  permanent integration acceptance verifiers, legacy readiness wrapper, and
  both hard-data packages' proxy Runtime fixtures.
- Removed permanent telemetry and hot-shard labels from product/backend gate
  composition while preserving ranking-query Runtime integration, real live-
  state evidence, the live acceptance soak, sensing retention, match/session
  retention, bounded diagnostics, and postgame review.
- Made the supported boundary explicit: fault diagnostics are default-off,
  bounded, asynchronous, and retained for at most seven days; review retains
  at most 20 compact structured postgame summaries.
- Retired the stale permanent real-evidence verifier, renamed the remaining
  bounded flat lookup budget, and removed every `indexes/hot` acceptance
  reference. Current acceptance uses deterministic fixtures and the bounded
  live acceptance soak instead of a machine-local evidence directory.
- Made `hard-data-manifest.json` a deterministic content manifest by removing
  build timestamps and absolute output paths, and added retirement checks for
  every retained hard-data package rather than only the active package.

Constraint: Runtime acceptance must prove current product behavior without a
permanent telemetry artifact intake or proxy evidence installation workflow.
Rejected: Keep the obsolete tools as optional diagnostics | their manifests,
fixtures, and gate references continued to advertise a retired product path.
Confidence: high
Scope-risk: moderate
Directive: Add fault evidence only through the bounded diagnostic path, and do
not restore permanent telemetry bundles as a release prerequisite.
Tested: Node syntax checks, requirements authority, mainline path retirement,
targeted retained gates, bootstrap, and deterministic product readiness.

## 2026-08-19 - Remove the retired graph architecture completely

- Deleted the former season knowledge-graph assets, builders, local tool
  checkouts, generated review packets, and the zero-consumer retirement check.
- Removed all Runtime product-gate, readiness, cleanup, repository
  classification, and requirements-registry entrypoints that could make the
  retired architecture appear active.
- Reworded remaining active contracts and package documentation around the
  production architecture: typed indexes, reverse indexes, deterministic
  relations, MiniSearch fallback, and an orchestrated build pipeline.
- Kept this decision-log entry as the only architectural lineage: graph-based
  retrieval is retired and must not be rebuilt without a new current
  requirement and measured evidence that the production retrieval stack is
  insufficient.

Constraint: Future agents must see one unambiguous retrieval architecture and
must not infer from stale tools or generated artifacts that graph construction
is still planned.
Rejected: Keep the old assets plus a zero-consumer verifier | the retained
surface still advertises the obsolete design and consumes more than a gigabyte
of local disk.
Confidence: high
Scope-risk: narrow
Directive: Use typed indexes and reverse relation indexes for exact data,
MiniSearch for bounded lexical-semantic fallback, and never add a graph layer
without an explicit requirements change.
Tested: Repository-wide retired-term audit, requirements authority, Runtime
readiness, deterministic core product gate, and Git diff integrity.

## 2026-08-19 - Lease immutable knowledge and bound canonical Host state

- Added the Runtime catalog overlay to the immutable Core Profile so watcher,
  structured-card, OCR, and Host consumers use the same compiled identity.
- Made Start Match capture one validated Core Profile snapshot and lease that
  generation until clean match retirement; pruning now protects active,
  previous last-known-good, candidate, and leased generations.
- Required recursive canonical sanitization so nested visual, lifecycle, retry,
  or detached-result objects cannot persist a complete Host request.
- Made the 256KB static capsule, 128KB turn delta, and diagnostic limits true
  absolute ceilings that environment configuration may lower but never raise.

Constraint: A live match and one Host turn must remain readable and coherent
while knowledge or ranking publication proceeds concurrently.
Rejected: Protect only the active pointer | a running match may legitimately
own an older generation after promotion.
Rejected: Compact only the top-level response task | nested request payloads
can still reproduce the original multi-megabyte persistence failure.
Confidence: high
Scope-risk: broad
Directive: Every new canonical state field that can contain task data must pass
through the recursive persistence sanitizer, and every generation cleanup must
honor active match leases.
Tested: Profile compiler/store, Start Match isolation, canonical persistence,
Host context budgets, daemon transition integrity, retrieval integration, and
the deterministic Runtime product gate.

## 2026-08-19 - Publish decision inputs inside the atomic Core Profile

- Made the decision-input catalog and augment-stage authority immutable
  artifacts in the same Core Profile directory as the compiled rules bundle.
- Required candidate compilation to finish all three artifacts before the one
  active-profile pointer may be promoted; a failed candidate cannot mix new
  season rules with an old card or OCR catalog.
- Moved the authored S17.8 augment-stage authority under its patch knowledge
  source and removed the shared mutable decision-input catalog.
- Made Runtime, structured cards, Quick OCR, and fact capture resolve the same
  profile-owned catalog identity, while compatibility tools require either the
  active profile or an explicit catalog path.
- Added bounded Core generation retention: protect active and candidate
  generations, retain two previous generations, and prune the rest after a
  successful promotion.

Constraint: Start Match must capture one coherent Core identity for rules,
entities, choice legality, aliases, and card/OCR validation.
Rejected: Publish a Core pointer and a separate mutable catalog pointer | two
independent switches permit mixed-version reads and cannot be made atomic.
Confidence: high
Scope-risk: moderate
Directive: Every future season or patch must declare its stage-authority input
in the patch source manifest; production code must not restore a shared
decision-input catalog fallback.
Tested: compiler determinism, candidate/profile publication, S18-like identity,
decision catalog coverage, structured-card OCR draft, match fact capture,
season-aware modes, and Host storage budgets.

## 2026-08-19 - Gate compiled knowledge publication and request snapshots

- Added the Core Profile compiler and profile-store publication verifiers to
  the deterministic Runtime product gate.
- Added immutable Ranking Overlay generation publication, lease, and
  last-known-good verification to the same gate.
- Added semantic evidence routing and request-captured Knowledge Snapshot
  verification so bounded lexical fallback cannot weaken typed authority or mix
  Core Profile and Ranking Overlay identities within one Host turn.
- Registered the corresponding implementation and verifier paths under the
  current season/version knowledge authority domain; ranking generation remains
  registered under the current live-rankings authority domain.

Constraint: Release acceptance must exercise the same compiler, publication,
semantic routing, and snapshot verifiers named by current requirements
authority.
Rejected: Keep the new verifiers as standalone developer scripts | they would
not protect the product gate or prove registry-to-gate consistency.
Confidence: high
Scope-risk: narrow
Directive: Every new current knowledge verifier must be registered under its
owning authority domain and included in the Runtime product gate.
Tested: targeted verifier execution, requirements authority, and product-gate
profile enumeration.

## 2026-08-19 - Compile game knowledge into immutable core and ranking layers

- Split runtime knowledge identity into an immutable Core Profile and a
  separately refreshable, core-compatible Master+ Ranking Overlay.
- Required every Host turn to capture one Knowledge Snapshot before retrieval,
  so rules, catalogs, derived tables, and ranking candidates cannot mix across
  generations while the answer is running.
- Moved the standard `2-1`, `3-2`, and `4-2` augment schedule into a named
  season-neutral template. A season explicitly inherits, replaces, or disables
  that template and owns only its mechanic-specific extensions.
- Kept exact entity resolution, typed AND/OR/NOT predicates, role constraints,
  complete-pool Master+ evaluation, atomic variants, and stage scoring as hard
  authority. MiniSearch is a bounded lexical fallback for explanations,
  conditions, aliases, and Wiki evidence only.
- Required ranking refresh to validate a complete candidate before publication,
  publish immutable generations through an atomic pointer and lease, and retain
  last-known-good data on every failure.
- Required additive shadow compilation and zero-reader verification before
  deleting legacy normal/special rule entries, graphs, or duplicate generated
  semantic assets.

Constraint: Core season and patch knowledge changes only at a Match boundary,
while current-day ranking evidence may update between turns; an in-flight turn
must retain both captured identities.
Rejected: One monolithic mutable knowledge directory | it cannot satisfy both
activation cadences and allows mixed-generation reads.
Rejected: MiniSearch or a vector store as ranking authority | fuzzy retrieval
cannot enforce legal breakpoints, role identity, source authority, or full-pool
business scoring.
Confidence: high
Scope-risk: broad
Directive: New knowledge sources must declare whether they belong to the Core
Profile, Ranking Overlay, or per-turn dynamic facts; they may not add another
mutable global cache lifetime.
Tested: Start Match path authorization and current ranking candidate validation.
Not-tested: full Core Profile cutover, immutable overlay publication, legacy
asset retirement, and desktop smoke remain part of the active implementation.

## 2026-08-18 - Make lineup search typed, complete, and cursor-bounded

- Required natural-language lineup requests to compile into validated typed
  intent before retrieval, including two through six trait constraints, exact
  breakpoints, AND/OR/NOT logic, independent groups, and carry/tank/member role
  semantics.
- Made the complete promoted Master+ typed index the search pool. The static
  Meta Map is orientation context only and cannot whitelist or shortlist query
  candidates.
- Required atomic evaluation against one published final variant. Conditions
  split across variants cannot become exact, and no-exact results must report an
  explicit `partial_downgrade` instead of overstating partial coverage.
- Defined next-three and next-five as presentation pagination only. Daily-route
  continuation uses a strict-budget cursor keyed by typed-query identity plus
  the Master+ fingerprint, excludes shown ids, is idempotent and exhaustible,
  invalidates on condition/data changes, and never stores complete strategy
  packages. Explicit New Conversation clears the retired lobby cursor.
- Required every material state change in a Start Match-owned match to rerank
  the complete lightweight pool under the existing stage weights. A prior page,
  Meta Map list, or hydrated winner is never the next search pool.
- Kept player-visible strength statistics limited to national Master+ top-four,
  top-one, and appearance rates, while preserving one atomic published variant
  as the evidence baseline for selected candidates.
- Registered the query-intent, atomic retrieval, and pagination verifiers under
  the live rankings authority domain.

Constraint: Natural-language convenience and pagination must not silently shrink
the evidence pool, merge published variants, or persist full strategy payloads.
Rejected: Query only the static Meta Map or reuse the previous displayed page as
the next ranking pool | both can hide valid Master+ candidates and bypass the
registered stage score.
Confidence: high
Scope-risk: moderate
Directive: New lineup query syntax must compile into the same typed intent and
must not introduce a second ranking layer or another cursor payload format.
Tested: ranking query intent, atomic retrieval, pagination, JSON parsing, and
requirements authority.

### Adversarial closure

- Pure negative requests now inherit an earlier query only when the excluded
  entity actually belongs to that query or the user explicitly continues,
  corrects, or targets a prior group.
- Unknown role-bound champions and unknown traits without numeric breakpoints
  now remain unresolved typed mentions; they cannot disappear into a generic
  Meta fallback.
- The promoted strategy index now carries a deterministic complete-content
  fingerprint. Cursor identity also verifies current compact candidate content,
  so lifecycle, equipment, transition, augment, or other recipe-only changes
  invalidate an old page explicitly.
- Only the primary selected candidate hydrates its complete winning-lineup
  group. Secondary candidates retain their lightweight atomic summaries until
  they become primary.
- The full 52-lineup Master+ pre-hydration pool now remains under a 512KB
  serialized working-set budget. Complete variant, transition, item, augment,
  positioning, and season-extension detail stays in the candidate-id cache;
  compact lane audit drops zero-signal lanes and repeated ranking-quality data.

Tested: pure-NOT replacement and correction, unknown main-carry and trait
clarification, recipe-only cursor invalidation, current 52-lineup Master+ index,
complete-primary/atomic-secondary hydration, 416,875-byte full-pool selection,
and request/storage byte budgets.
Not-tested: Runtime-service integration, which is owned by a separate task.

## 2026-08-18 - Use one lineup score and keep recipe metrics offline

- Removed weighted reciprocal-rank fusion from active-match lineup ordering.
  Typed indexes now annotate the complete lightweight eligible Master+ pool;
  explicit role constraints apply first, and the registered stage-specific
  meta/augment/item/tempo/board score runs exactly once before truncation.
- Added board-commitment confidence from owned board and bench role, copies,
  stars, and core coverage. Shop cards remain immediate opportunities and no
  longer count as owned board fit.
- Limited Host-visible lineup strength statistics to national Master+ top-four,
  top-one, and appearance rates. Winning-lineup metrics remain offline while
  their complete gameplay templates still hydrate the final winners.
- Made mode switching a bounded last-click-wins control mutation. It no longer
  builds context, starts visual sensing, or cancels an answer owner.

Constraint: retrieval must not discard the eventual stage-score winner or make
one fact influence lineup ordering twice.
Rejected: enlarge the old RRF shortlist | it preserves two business rankings
and still permits recall inversion.
Confidence: high
Scope-risk: moderate
Directive: new lineup evidence channels annotate coverage or map into one of
the five registered components; they do not add a hidden ranking layer.
Tested: target-aware retrieval, lineup decision quality, mode control lane, HUD
OCR dispatch, requirements authority, and UI build.

## 2026-08-18 - Separate live-match attachment from HUD field readiness

- Fixed HUD resident-worker dispatch so each ROI request receives the active
  match options instead of failing on an undefined closure variable.
- A fresh same-match MuMu watcher stream with a positive revision, explicit
  4354 self-shop anchor, and non-empty shop now proves that Runtime is attached
  to the live match even while stage/economy OCR is still pending.
- Kept authority boundaries unchanged: this connection evidence does not
  promote HUD numbers, S=2 board candidates, equipment, or choice facts.

Constraint: one failed or delayed HUD read must not make a healthy current-match
structured stream appear as “waiting to enter match”.
Rejected: treat any watcher output as a live match | lobby payloads and empty
shells do not provide a current-game anchor.
Confidence: high
Scope-risk: narrow
Directive: match attachment and per-field sensing readiness remain separate
states; never make one subsystem's field failure erase another source's valid
session-scoped attachment evidence.
Tested: targeted HUD ROI dispatch and Start Match attachment regressions.

## 2026-08-18 - Make Match Session the owner of all live-match state

- Added one shared match-scope reset used by Start Match, Stop Match, clean Exit,
  and bootstrap cleanup. It clears prior match context, variables, decision and
  response state, event/advice history, triggers, visual/HUD state, and in-memory
  match caches while preserving MuMu, lobby, preferences, Wiki, and rankings.
- Match queue rows now carry explicit session scope. Closing or superseding a
  match cancels its pending, retry, running, and requested work; old unscoped
  nonterminal rows also receive a bounded expiry instead of living forever.
- SQLite match-session rows now leave `active` on Stop Match and supersession.
  Impossible historical active rows are reconciled, and closed-session metadata
  is bounded independently of active game state.
- Match-only latest mirrors are removed at the boundary, so a new game cannot
  hydrate previous variables, Host request/response summaries, lifecycle state,
  or match/mode context packs.
- Pending Provider bootstrap transports now share one awaited close operation;
  Start Match starts no replacement watcher or Host provider until both prior
  owner process trees confirm exit.
- Stop Match now reports watcher/provider termination failures in the lobby
  instead of replacing them with a success message.
- Start supersession and Stop Match build a compact structured review summary
  before transient reset, store it in the closed SQLite session payload, and
  retain only the latest 20 summaries without screenshots, full live state, or
  complete Host payloads.

Constraint: device connection, lobby provider history, durable preferences,
Wiki, review records, hard data, and current rankings must survive game changes.
Rejected: clean stale state only at daemon startup | it leaves the stopped game
resident in every read and allows old nonterminal tasks to accumulate.
Confidence: high
Scope-risk: moderate
Directive: every new live-match field, cache, queue, or process handle must name
its match owner and participate in the shared match-boundary reset.
Tested: scoped queue retirement, stale nonterminal expiry, persisted session
closure, Stop Match state reset, daemon lifecycle, and requirements authority.

## 2026-08-17 - Bound Renderer reads, Provider timing, and Quick Record evidence

- Read-only Renderer actions now return a bounded UI projection and do not
  rewrite canonical SQLite state or append routine hydration/action diagnostics.
- Read-only polling cannot age out a live response owner; stale task repair now
  runs at daemon startup, while Start Match resets match-scoped event history
  and the prior decision snapshot.
- Daemon startup and real mutations persist canonical hydration repairs across
  `ui_runtime_state`, standalone `response_task`, and the compatibility mirror.
  Read-only calls may show a repaired projection but never write that repair.
- Host answer timeout now starts at native Codex `turn/start` acceptance or
  Kimi `session/prompt` dispatch. Queue and session preparation use a separate
  bounded start budget.
- Quick Record sends a query-scoped catalog shortlist, mechanically recovers
  unambiguous missing operation keys, and still validates proposed facts against
  the complete active catalog before one atomic sparse update.
- Quick Record shares the structured-card mutation lane so a late receipt cannot
  overwrite a newer card fact. Explicitly unsupported operation names never use
  missing-key inference as a bypass.
- Strength, lineup, and later-augment questions no longer require a current
  three-option report. Only an exact current choice-window question is blocked
  by missing candidates.
- Editable UI presets use player-facing wording, and the composer exposes about
  two-and-a-half lines by default.
- Persistent-turn benchmarks distinguish compact ordinary turns from a complete
  primary strategy package. The latter may exceed the 6K-token optimization
  target only to preserve its atomic published variants and transition chains,
  and remains subject to the 128KB production hard ceiling.

## 2026-08-17 - Add one explicit natural-language current-match fact channel

- Added a Cruise `快速记录` prefill whose hidden `match_fact_capture` request
  kind is the only natural-language path allowed to update canonical match
  facts. Ordinary chat remains unable to write choices, equipment, or season
  variables even when its wording is identical.
- Split interpretation from authority: the Host proposes closed-schema
  operations, while Runtime resolves current-season names, stage legality,
  equipment categories, holders, quantities, and descriptor variables before
  one sparse match-context update.
- The visible Agent response is rebuilt from facts that actually persisted and
  lists unresolved fragments instead of guessing. The path cannot infer or
  update a target lineup and cannot produce strategy advice.
- Current choice cards now expose a fact-captured final selection independently
  of candidate drafts. Dirty drafts remain renderer-owned.
- Kept alias handling season-neutral. A new major-season hard-data refresh must
  generate an alias ambiguity/missing review report; player slang additions are
  supplied only where deterministic generation is insufficient.
- Hardened the channel after adversarial review: exact match/task ownership is
  fenced at the canonical commit point; Host strategy fields are discarded;
  descriptor-owned rewards are checked against their parent choice and stage;
  mandatory capture evidence survives 128KB compaction; equipment receipts use
  actual quantities; and stale asynchronous hydration cannot overwrite a newer
  local equipment edit.

Constraint: the interaction must reduce in-game manual editing without making
ordinary conversational text a canonical data source.
Rejected: authorize writes by matching visible prompt text | any ordinary chat
could accidentally mutate the match.
Confidence: high
Scope-risk: moderate
Directive: never add a new fact kind without a catalog/descriptor validator and
never let Host output write arbitrary Runtime paths.
Tested: focused fact normalizer/resolver, UI wiring, contract authority, and
renderer build.

## 2026-08-17 - Preserve complete lineup recipes and equipment requirements

- Kept every top-level winning-lineup row as an atomic final variant and every
  nested published row as that variant's transition chain. Population no longer
  classifies a row as final or transitional.
- Expanded the in-memory current-turn delta ceiling from 64KB to 128KB so one
  primary lineup can retain all final variants, transitions, positioning,
  equipment priority, transfer data, and season extensions. SQLite, queues,
  and diagnostics still persist references only; successful diagnostics remain
  independently capped at 64KB.
- Added role equipment precedence for main carry and primary tank: explicit
  upstream required item, formation-required emblem, published recipe items,
  hero-ranking core items, highest-top-one package, then most-popular package.
- A formation-required emblem now records the exact holder, granted trait, and
  that the holder becomes an external member of the trait. Unanimous ordinary
  items remain core consensus and are not mislabeled as mandatory.
- Variant-specific required items remain attached to their source variant and
  become group requirements only with full final-variant consensus. Emblem
  grants must resolve uniquely through the active trait catalog; unresolved or
  ambiguous names fail closed instead of manufacturing a formation condition.
- Enabled successful Host diagnostics now use a dedicated compact schema and a
  real 64KB serialization limit; complete answers and requests remain canonical
  in memory/provider state rather than diagnostic artifacts.

Constraint: S18 and later refreshes must derive the same semantics from source
location, active hard-data traits, and official item metadata without S17 IDs.
Rejected: Treat every item shared by all variants as mandatory | Stable core
equipment is not automatically a hard formation condition.
Confidence: high
Scope-risk: moderate
Directive: Never mix sibling variants into one roster, and never claim an item
is required without explicit upstream evidence or an external-holder formation
emblem proven by the current patch catalogs.
Tested: targeted strategy-index, runtime retrieval, context-budget, itemization,
Host-contract, and requirements-authority verifiers.
Not-tested: a complete live match after this evidence-package change.

## 2026-08-17 - Keep prompt presets editable and lineup recipes atomic

- Changed every ordinary match-mode prompt preset to fill and focus the shared
  composer without sending. The player may edit or add conditions, then uses
  the normal Send action; explicitly declared operational and structured-card
  controls retain their own immediate semantics.
- Increased the match composer to show roughly two and a half lines on desktop
  and compact layouts so a player can see that a preset contains more text.
- Replaced cross-variant unit synthesis in Host evidence with one complete
  canonical winning-lineup variant per selected candidate. Cross-variant core
  frequency remains non-composable evidence, and live adjustments require an
  explicit one-for-one substitution.
- Expanded component completion indexes to include every official current-patch
  recipe, including craftable emblems, rather than only standard completed
  items. Craft recommendations now require an exact recipe row in the bounded
  current-turn context; desired traits cannot invent an emblem.

Constraint: Preserve fast bounded current-turn evidence and season-neutral
Runtime behavior while preventing semantically invalid roster and recipe joins.
Rejected: Let the model assemble a roster from core-unit unions | A union is
frequency evidence across variants, not a legal board.
Rejected: Infer emblem recipes from desired traits | Craftability is exact
patch hard data, not strategic analogy.
Confidence: high
Scope-risk: moderate
Directive: New prompt presets default to editable explicit-send behavior, new
lineup evidence must preserve an atomic roster, and every craft claim needs an
exact active-patch recipe reference.
Tested: targeted UI preset/composer checks, lineup evidence adversarial checks,
item recipe checks, Host contract validation, UI build, and requirements
authority.
Not-tested: a complete live MuMu match after these changes.

## 2026-08-17 - Make lineup convergence role-aware and choice gaps nonblocking

- Added explicit stage-adaptive lineup-fit profiles. Stage 2 uses Master+ meta,
  augment, item, tempo, and board weights 45/20/15/10/10; stage 3 uses
  37/23/15/10/15; stage 4 and later use 35/23/13/13/16. Every profile totals
  one and user role remains a constraint rather than a hidden sixth weight.
- Added one season-neutral candidate-readiness pass over the universal lineup
  index instead of fee-specific candidate pools. It distinguishes observation,
  conditional start, future target, build-toward, and formed-core continuation.
  A temporary stage-2 low-cost pair remains provisional, while an established
  durable core requires explicit exit evidence before an unrelated higher-cost
  meta line may replace it.
- Made explicit target role a retrieval constraint. A request to build around a
  champion as main carry now requires a compiled main-carry match; a lineup that
  merely contains that champion remains contextual evidence.
- Preserved national Master+ strength, winning-lineup recipe evidence, and hero
  market/item evidence as separate authorities in compact Host evidence. A
  recipe without a national anchor now contributes zero Meta strength; its
  rates and sample count remain only under `recipe_evidence`.
- Required every augment preselection response at every registered augment
  checkpoint to include the exact three reported candidates once each in
  best-to-worst order plus one machine-valid keep/refresh action.
- Classified missing choices by the current task. Only an explicit question
  about the exact active choice may block on candidate facts; lineup, economy,
  item, target, and other user-owned actions answer first in every stage and
  attach missing choices as conditional uncertainty or a structured-card
  reminder.
- Changed the Cruise lineup-direction shortcut to descriptor-owned prefill so
  the player may add an optional target before sending.

Constraint: Common Runtime behavior must remain season-neutral for the S18
transition; season checkpoints come only from the active compiled descriptor.
Rejected: Add more S17-specific prompt clauses | They would repeat the same
priority bug in the next major season.
Rejected: Let a high-stat member-only lineup satisfy a main-carry request | It
confuses lineup membership with the user's requested role.
Confidence: high
Scope-risk: moderate
Directive: New choice mechanics inherit dependency classification through their
descriptor, and new ranking evidence must preserve role, source provenance, and
season-neutral stage readiness without adding fee-specific candidate pools.
Tested: targeted role retrieval, exact stage weights, candidate readiness,
missing-choice dependency, augment response validation, opening-choice
integration, descriptor UI, and requirements authority.
Not-tested: a complete live MuMu match after this decision-quality change.

## 2026-08-16 - Bound Host context and query current-day strategy evidence in process

- Split Host request identity into Runtime metadata, a once-per-session static
  capsule, and a current-turn decision delta capped at 64KB.
- Gave the once-per-session static knowledge map an approximately 50K-token
  allowance with a 256KB absolute serialized ceiling, retained complete source
  drift through one combined fingerprint, and bounded user strategy, Wiki,
  season, taxonomy, and current-day meta summaries independently. The capsule
  carries up to 12 personal strategy rules, eight scoped Wiki summaries, and
  12 current-day Master+ lineup families; exact records remain in typed indexes.
- Standardized all ranking refresh, Meta Map, and live-match retrieval on the
  Master+ national dataset regardless of user rank preference. Winning-lineup
  recipes remain template evidence for carries, transitions, items, augments,
  positions, and variants, but never replace the Master+ national strength
  anchor. Platinum-Diamond and all-tier datasets are no longer downloaded or
  used by Runtime.
- Replaced the production pending-response child-process round trip with an
  in-process request selector, and persisted metadata-only request references.
- Made successful Host diagnostics default-off and asynchronous; enabled fault
  evidence is bounded, retains seven days, and cannot delay canonical delivery.
- Unified current-day strategy lookup across direct and proactive turns with
  target, canonical augment, board, equipment, intent, shop, meta, and soft
  tempo lanes. Item and season-mechanic choices cannot pollute augment lookup.
- Required semantic admission, Host context, freshness, and delivery to share
  one resolved decision-snapshot identity and registered fingerprint domains.

Constraint: Keep the Provider's native long conversation and enough static game
methodology for expert reasoning without repeating full hard data or rankings.
Rejected: Copy complete request events through a Node child process and stdout |
It multiplied 10MB-class objects, blocked Electron/SQLite work, and could hide
already-completed Host answers behind diagnostic I/O.
Rejected: Increase request-size and latency thresholds | The duplicated layers
were unnecessary and masked the architectural fault.
Confidence: high
Scope-risk: moderate
Directive: New evidence sources must join the typed query/fingerprint contract;
they may not be appended wholesale to every Host request or diagnostic file.
Tested: targeted storage budget, current-day retrieval, Host request benchmark,
response delivery, UI build, syntax, and adversarial review.
Not-tested: a complete live MuMu match after this context-boundary change.

## 2026-08-16 - Preserve response ownership and merge opening judgment into 2-1

- Changed response completion ownership from exact revision equality to stable
  owner identity. Normal daemon persistence may advance the same task revision
  without discarding a completed Host answer; cancellation, replacement,
  match mismatch, or terminal status still rejects late output.
- Made manual match-variable confirmation context-only. It no longer creates a
  separate opening Host turn that can occupy the answer lane before 2-1.
- Required the first user-owned 2-1 augment answer to absorb the confirmed
  opening variables. Before final selection, it ranks the three augments and
  refresh decision without prematurely prescribing lineup candidates.
- Replaced the augment card's choice-only and whole-card advice variants with
  one `获取建议` action. The request reads all reliable canonical context,
  including shared equipment when available, while keeping the output focused
  on the current augment choice.

Constraint: Equipment may be missing during a timed choice window and cannot
be a prerequisite for advice.
Rejected: Keep a separate variable-triggered opening judgment | It duplicates
answer ownership and can delay the first explicit augment request.
Rejected: Invalidate Host output on every revision change | Revisions also
advance for ordinary canonical persistence that does not replace the owner.
Confidence: high
Scope-risk: moderate
Directive: Future task freshness checks must compare semantic owner identity,
not use revision equality as a proxy for cancellation or replacement.
Tested: targeted opening/choice integration, decision-input UI contract,
live-context authority regression, requirements authority, syntax, and
adversarial review.
Not-tested: full product gate and a complete live match.

## 2026-08-16 - Reject loading-screen numbers before opening advice

- Required a same-frame `phase.stage_round` HUD anchor before a full self-state
  OCR result may promote HP, gold, level, or XP. Isolated loading, roster,
  reward, and transition-screen numbers remain diagnostic-only.
- Prevented stage-only OCR from legitimizing an economy value rejected from an
  earlier unanchored frame.
- Kept the deterministic opening Coach response pending until the current match
  has a reliable stage, so a startup fragment such as `51金币` cannot become a
  visible opening judgment.

Constraint: HUD fields remain independently promotable after the frame is
proven to be the in-game HUD; one missing sibling must not discard valid fields.
Rejected: Raise the gold confidence threshold or special-case `51` | The live
failure was a high-confidence read of the wrong screen, not weak digit OCR.
Confidence: high
Scope-risk: narrow
Directive: New HUD numeric ROIs must share the same frame-layout authority gate
before entering current-match facts or user-visible advice.
Tested: verify-jcc-self-state-roi-ocr.mjs with the retained loading-screen
regression shape; full Start Match symptom regression; runtime event, Host
context, sensing-map, requirements-authority, syntax, and diff verification;
adversarial code review with zero remaining findings.
Not-tested: live restart during the user's currently active match.

## 2026-08-15 - Preserve one answer lane and reserve foreground augment OCR

- Direct user and structured-card answers now absorb a pending lineup-
  convergence checkpoint from the latest verifiable stage instead of racing a
  second Cruise answer. Successful delivery closes only the absorbed lineup
  checkpoint; failed or cancelled answers keep it retryable, and missing stage
  never reopens an older checkpoint by its historical stage.
- Entering augment mode now publishes its foreground OCR reservation before
  asynchronous context setup. New periodic and stage-only HUD OCR jobs are not
  admitted until mode exit; an already-running job may finish, then Quick OCR
  runs ahead of queued background work.
- Every Quick OCR attempt now has a unique worker transport request identity,
  preventing a late response from a timed-out attempt from satisfying a retry.
- Punctuation-only status observations are classified before daemon-level Host
  cancellation, so checking a running answer cannot cancel it.

Constraint: Keep one provider-native match conversation and one visible answer
owner while preserving a single shared OCR worker.
Rejected: Run Cruise and direct questions as concurrent Host turns, or kill an
already-running HUD OCR process when augment mode opens | Both approaches can
mutate the same provider/worker state out of order.
Confidence: high
Scope-risk: moderate
Directive: New proactive families must declare whether direct user answers may
absorb them; new foreground OCR consumers must reserve the shared queue without
inventing another worker.
Tested: targeted lineup convergence, direct absorption, explicit augment draft,
response-task delivery, and resident OCR worker lifecycle verifiers.
Not-tested: full product gate or a live MuMu match.

## 2026-08-14 - Make current-day composite ranking evidence the live authority

- Upgraded the promoted lineup strategy artifact to
  `jcc-live-ranking-strategy-index-v2`. The deterministic refresh compiler now
  treats the selected tier's national trait ranking as lineup-strength
  authority, matches winning-lineup gameplay recipes by complete trait-family
  sets and exact breakpoints, and keeps recipe metrics separate from national
  strength metrics.
- Added current hero popularity and per-hero item-package evidence, preserving
  separate highest-top-one and most-used packages plus artifact/radiant tags.
  Hero ranking remains a market-pressure and item-preference prior, not the
  primary lineup-strength source or a live opponent count.
- Added augment, champion, item, and trait reverse indexes. Runtime consumes
  them as an internal bounded lookup and sends only compact matched evidence to
  the Host; confirmed augment associations remain non-causal priors.
- Historical compact signals remain retained for refresh diagnosis, rollback,
  and explicit lobby review, but are now contractually and mechanically
  excluded from active-match retrieval, ordering, Host context, and Coach
  decisions. Every live answer uses only the audited promoted current-day tuple.
- Registered the upstream `battle_type` and winning-lineup endpoint version as
  machine source identity. Refresh verification and runtime attachment both
  fail closed when either value is missing or drifts across the contract,
  rank-signal, and strategy index.
- Kept major-season fields opaque in the common compiler. S18 and later season
  descriptors may interpret their own extension payloads without adding S17
  names or mechanics to the common matching code.

Constraint: Active-match latency must not grow with raw ranking size or retained
history.
Rejected: Parse or join raw ranking sources during Start Match, use an extra
Agent turn to build daily associations, or blend historical trends into live
recommendations | These approaches increase latency and blur evidence authority.
Confidence: high
Scope-risk: moderate
Directive: Extend source adapters and the active major-season descriptor when
upstream data changes; preserve the common strength/recipe/hero evidence roles.
Tested: fresh audited production refresh for stat date 20260813, deterministic strategy compilation, exact/compatible/analogous matching,
breakpoint and tier isolation, direct hero/item retrieval, augment reverse-index
retrieval, compact Host evidence, identity fail-closed behavior, and historical
exclusion from live context.
Not-tested: fresh production ranking promotion against the next major-season
upstream payload.

## 2026-08-14 - Compile lineup strategy evidence during ranking refresh

- Added the season-neutral `lineup-strategy-index-v1` offline artifact. It
  deterministically links 掌盟 lineup groups to explicit main carries, published
  main-carry item packages, core units, lineup-associated augment references,
  transition variants, variant metrics, and self-board position templates.
- Runtime target retrieval now searches the full promoted tier index, including
  main carry, core unit, augment, and item evidence, while sending only compact
  matched candidates to the Host. These fields remain priors and cannot replace
  current live state or become independent augment/item win rates.
- Ranking refresh archives a compact signal only after successful promotion and
  prunes history to the latest 14 distinct stat dates. Same-date refreshes are
  idempotent and raw snapshots are not copied into history.
- Runtime route references resolve the active hard-data manifest instead of a
  stale patch directory, and Master+ (`tier_part=0`) is the default ranking
  partition when the user has not selected another supported partition.
- Runtime now fails closed unless the promoted audit passes and the manifest,
  rank signal, strategy index, runtime season/patch tuple, package, and upstream
  data identity all agree. The daily update script performs the joins and
  automatic 14-date history pruning; no additional Host-model analysis turn is
  added to Start Match or the live decision path.

Constraint: The match hot path must stay low-latency and major-season portable.
Rejected: Reparse raw ranking payloads or ask the Host to infer lineup structure
from a large daily snapshot during a match | It repeats work and increases
latency while weakening provenance.
Confidence: high
Scope-risk: moderate
Directive: Future season modules may interpret opaque season extensions, but
common ranking/index code must remain season-neutral.
Tested: ranking refresh contract, strategy index, promotion rollback, history
retention, identity fail-closed behavior, target/augment/item/transition-aware
retrieval, runtime compact turn evidence, syntax, and requirements authority.
Not-tested: a fresh network ranking download against a future patch endpoint.

## 2026-08-14 - Add evidence quality and conditional coaching to the common harness

- Added a season-neutral ranking quality profile that separates stable broad
  evidence, promising low-sample evidence, high-ceiling low-stability lines, and
  insufficient samples. Candidate relevance remains primary; quality explains
  how strongly a ranking line should influence the answer.
- Expanded own-board readiness with a decision gap, next-level value,
  immediate-upgrade evidence, and estimate confidence. The estimator remains a
  bounded own-state proxy and does not become a combat simulator or use opponent
  board sensing.
- Added a bounded conditional decision shape for strategic Coach answers:
  current line and reason, no more than two material branches, and one immediate
  action. These are evidence-driven overrides around priors, not fixed timing
  commands or season-specific rules.

Constraint: Active-match latency and season portability require synchronous compact evidence; no new model call or S17-specific common rule is introduced.
Rejected: Treat top-one rate, cost-curve timing, or board score as a universal command | Each can be misleading without sample size, stability, current fit, or live exceptions.
Confidence: high
Scope-risk: moderate
Directive: Future game knowledge must enter as typed evidence, priors, and adversarial counterexamples; do not add champion or major-season names to common harness files.
Tested: target-aware ranking retrieval and quality compaction; 14 lifecycle and adversarial scenarios; cruise scorer; proactive convergence; combat-cap estimator; economy context; host instruction contract; persistent-session mode-size benchmark; requirements authority; syntax, JSON, and diff-check.
Not-tested: real provider wording and a live MuMu match after this harness refinement.

## 2026-08-14 - Make lineup lifecycle timing conditional instead of absolute

- Reclassified cost-curve timings such as level-four one-cost reroll, level-
  seven three-cost search, level-eight four-cost search, and natural-XP waits
  as default priors rather than universal commands.
- Added current-match override evidence for contested pools, explicit timing
  urgency, next-level board spikes, required higher-cost support units, lethal
  pressure, board readiness, and immediate roll marginal gain.
- Split lifecycle output into preferred, conditional, discouraged, and truly
  forbidden actions. Common game doctrine no longer promotes scenario-specific
  mistakes into global prohibitions.
- Added expert benchmark cases proving that a mixed three-cost structure may
  level to eight for a required four-cost support and that a two-XP gap may
  still justify buying XP when the timing race or board spike is material.

Constraint: The harness must reconcile common expertise with current patch data, rank-bracket tempo, confirmed choices, active-season variables, equipment, board state, economy, HP, and user direction.
Rejected: Encode high-tier operating heuristics as unconditional level/roll rules | Real matches contain mixed cost curves, contest races, special mechanics, and survival exceptions that invalidate a fixed script.
Confidence: high
Scope-risk: moderate
Directive: Add new game knowledge as a prior plus explicit override evidence and counterexample tests; do not add champion names or active-season mechanics to common lifecycle code.
Tested: verify-jcc-lineup-lifecycle-harness.mjs; verify-jcc-cruise-strategy-scorer.mjs; verify-jcc-combat-cap-estimator-context.mjs; verify-jcc-economy-management-context.mjs; verify-jcc-proactive-lineup-convergence.mjs; verify-jcc-requirements-authority.mjs.
Not-tested: Live provider wording and a real MuMu match after this conditional-policy refinement.

## 2026-08-14 - Add season-neutral lineup lifecycle and board-readiness guardrails

- Added a common cost-curve lifecycle contract for one-cost and two-cost reroll,
  three-cost carry, four-cost carry, legendary-cap, emblem-conditioned, and
  early-high-cost pivot archetypes. The contract describes decision guardrails,
  not fixed S17 units or traits.
- Added a bounded own-board readiness estimate covering population coverage,
  frontline readiness, damage/carry readiness, core two-star progress, item
  completion, target coverage, loss buffer, and XP overbuy alignment. It is not
  a battle simulator and does not use opponent-board sensing.
- Wired the same lifecycle object into Host-independent proactive scoring,
  leveling/economy context, and combat-cap context so Cruise and direct Host
  answers cannot use different cost-curve evidence. Daily rankings remain
  candidate priors and live state remains authoritative.
- Added an offline benchmark fixture covering reroll levels, recovery floor,
  contested four-cost timing, legendary loss buffer, emblem conditions, and XP
  purchase alignment. Postgame decision/outcome evidence remains review-only;
  it does not open live-match tasks or mutate current-match truth.

Constraint: The common harness must remain season-neutral because major-season mechanics are descriptor-owned and S18 must replace or omit S17-only fields without common-code edits.
Rejected: Full combat simulation and live self-training | They add latency and unreliable assumptions to an active match; use bounded own-state estimates and user-approved postgame review instead.
Confidence: high
Scope-risk: moderate
Directive: Future patch tuning belongs in the active patch strategy/data tuple; do not add champion or S17 mechanic names to the common lifecycle module.
Tested: verify-jcc-lineup-lifecycle-harness.mjs; verify-jcc-combat-cap-estimator-context.mjs; verify-jcc-cruise-strategy-scorer.mjs; node syntax checks; requirements authority verifier.
Not-tested: A live provider model response and real MuMu device attachment.

## 2026-08-12 - Make live coaching deliverable and add non-authoritative augment OCR drafts

- Narrowed the stage/rule conflict gate so it still rejects answers that defer
  the current decision until a current or past checkpoint, while allowing an
  immediate action followed by conditional future planning.
- Made persistent Codex/Kimi turns cancellable from the moment they enter the
  native-session queue, without closing the provider session or sending a
  cancelled queued turn later.
- Based Host-running timeout on the time the runtime actually starts waiting
  for the provider response instead of an earlier preparation timestamp.
- Made the Cruise augment-fit action adaptive to durable target, provisional
  intent, or no target, and expanded confirmed-choice follow-ups to cover
  data-backed candidate lines, later choice priorities, equipment direction,
  and economy checkpoints.
- Made HP-pressure coaching target- and cost-curve-aware; HP alone can no longer
  justify a fixed level or spend amount.
- Added a user-triggered Quick OCR action to the common augment card. It fills
  only a complete current-stage/tier renderer draft, never writes canonical
  choice facts, never opens a Host answer, and never applies to S17 star-god or
  item-choice cards.
- Kept S17 star-god mechanics entirely descriptor-owned so a future S18 module
  can omit or replace them without common-code conditionals.

## 2026-08-10 - Keep missing HUD facts missing and make card ownership exact

- Traced the active-match `HP=0` incident to a missing HP crop/result being
  passed through JavaScript numeric coercion, where `Number(null)` became zero;
  it was not evidence that OCR had explicitly recognized a zero life total.
- Made HUD authority field-level: missing requested fields now retain bounded
  crop/layout diagnostics, valid sibling facts still promote, and active-match
  non-positive HP is rejected unless separate elimination evidence exists.
- Added hydration and failed-refresh cleanup for historical false-zero HUD
  authority while preserving valid gold, level, and XP.
- Made candidate-bearing structured-card submissions require the current
  canonical report revision. Only exact final confirmation may rebase within
  the same match/stage/choice kind, and only while slot plus candidate identity
  still matches the current set.
- Kept fact-only equipment confirmation independent of stale card bindings,
  required a concrete response-task id before promising final-confirm advice,
  and suppressed the semantic observer's duplicate confirmation answer.
- Made a persisted final choice with no response-task owner explicitly
  recoverable: the card stays open, and exact reconfirmation creates the one
  missing follow-up without duplicating the choice fact.
- Rejected whitespace-only numeric values before generic runtime/scorer
  coercion while preserving real numeric zero for gold and XP.

Verified with the HUD ROI/aggregator regressions, structured-card backend
blackbox, decision-input UI, proactive decision, runtime contract, build, and
product-gate checks.

## 2026-08-10 - Separate equipment facts from advice and make Cruise delivery decision-scoped

- Added an explicit whole-snapshot equipment confirmation that writes current-match facts without opening a Host task. Whole-equipment advice remains a separate user-owned action.
- Made whole-snapshot equipment confirmation independent of choice-set bindings and made identical-content reconfirmation refresh the active match/stage scope.
- Gated whole-snapshot confirmation on daemon-owned equipment hydration so an uninitialized empty renderer draft cannot erase known equipment facts.
- Made Host artifact filenames Windows-safe for structured-card task IDs while preserving the original task identity inside JSON payloads.
- Kept failed structured-card deliveries in their active mode for retry; only successful delivery returns the temporary mode to Cruise.
- Replaced whole-live-state expiry for every proactive answer with contract-owned freshness classes. Stable economy, tempo, lineup-direction, HP, and equipment decisions may survive one ordinary round; shop and bench actions remain exact-state strict; newer same-family decisions and choice/major-stage boundaries supersede old advice.
- Added per-decision action fingerprints so stable advice survives unrelated churn but is suppressed when its own action changes; exact shop/bench advice now fails closed when its required fingerprint is unavailable.
- Made the Cruise lineup quick action target-authority aware. It validates durable targets, treats provisional intent as a preference, and discovers candidate directions when the user has not declared a target.

Verified with focused structured-card, response-task, proactive decision, UI contract, build, and product-gate checks.

## 2026-08-06 - Preserve native conversations across model changes

- Split provider transport identity from mutable turn configuration. Changing
  Codex/Kimi, executable path, launch arguments, version, or provider home
  replaces the owning conversations; changing only model or reasoning keeps
  the same lobby and match thread/session.
- Codex now applies model and effort on each `turn/start`. Kimi applies model
  and thinking through advertised ACP `session/set_config_option` options.
  Neither path uses resume/load for an ordinary configuration change.
- Removed model from the static context fingerprint because hard data, rules,
  rankings, Wiki, and user preferences do not change when only the model does.
- Removed the unsupported standalone Challenger/王者 preference. The current
  ranking source exposes only `master_plus`, `platinum_to_diamond`, and
  `all_tiers`; historical `challenger` values normalize to `master` before
  selected-context construction.
- Made close-window cleanup attempt Host-session and OCR-worker termination
  even when watcher termination fails. The result remains degraded and is not
  marked as a clean shutdown, but unrelated owned processes are not abandoned.

Verified with:

```text
node tools\verify-jcc-host-session-lifecycle-contract.mjs
node tools\verify-jcc-host-selected-context-contract.mjs
node tools\verify-jcc-user-settings-review-runtime.mjs
node tools\verify-jcc-requirements-authority.mjs
npm.cmd --prefix ui run build
```

## 2026-08-06 - Make Start Match readiness and opening delivery truthful

- Separated canonical match creation from watcher and Host-session readiness.
  A retryable degraded start keeps the new match boundary but can no longer be
  presented as fully ready.
- Deferred canonical renderer delivery while Start Match replaces the message
  stream, then reconciled once after initialization so opening economy advice
  cannot be acknowledged and erased by the startup UI reset.
- Made SQLite-hydrated user preferences, user strategy memory, published
  strategy Wiki, rules, hard data, and rankings explicit first-bootstrap test
  obligations. Later turns continue to carry dynamic facts only.
- Made watcher shutdown bounded and acknowledged before Stop Match or clean
  exit reports clean completion.

Verified with:

```text
node tools\verify-jcc-host-session-lifecycle-contract.mjs
node tools\verify-jcc-ui-runtime-bridge.mjs
node tools\verify-jcc-start-match-symptom-regression.mjs
node tools\verify-jcc-single-writer-canonical-state-contract.mjs
node tools\verify-jcc-requirements-authority.mjs
npm.cmd --prefix ui run build
```

## 2026-07-31 - Establish the Windows desktop entry and installer shortcut contract

- Added a reproducible JCC Runtime PNG/ICO identity and an idempotent hidden
  developer launcher so repository testing has a real one-click desktop entry.
- Made Electron single-instance on Windows: repeated launches focus the owning
  window rather than creating another Runtime, daemon, watcher, OCR worker, or
  Host session.
- Required the future NSIS installer to create desktop and Start Menu shortcuts
  that target the installed executable. Development Node/Vite/VBScript launchers
  are forbidden in player installations.
- Added an install/remove round-trip verifier and kept public release blocked
  until a clean-machine packaged install/uninstall smoke test passes.

## 2026-07-30 - Close sensing and response-ownership audit gaps

- Reaffirmed the production sensing boundary: only HUD stage, HP, gold, level,
  and XP plus explicit owned-augment text-panel recovery use scoped OCR. Active
  choice candidates are structured current-match user reports; item icon
  matching is explicit-request/conflict-check evidence only and never periodic.
- Made `cancelling` a protected canonical response-task state until the same
  provider turn explicitly settles. Ownerless observe snapshots can no longer
  erase the retained Stop Answer handle.
- Expanded the manual-choice gate beyond a small preset phrase list. Choice-
  shaped free text without a fresh current reported candidate set now fails
  closed, while unrelated tactical chat remains available.
- Kept the compact self-state strip as a sensing-health indicator instead of a
  persistent duplicate HUD. Exact values remain available through explicit
  refresh results and answer evidence.

## 2026-07-30 - Separate Star-God advice facts from revealed final rewards

- Allowed Star-God advice while one or both candidate rewards are still
  unrevealed. This covers Thresh's random reward without forcing the player to
  fabricate a value before asking which Star-God to choose.
- Kept final confirmation strict only for the selected Star-God: the selected
  option must record its actual revealed reward, while unselected rewards may
  remain blank.
- Made repeated submission of the same final selection idempotent. A renderer
  retry or double click keeps the first canonical confirmation and its one
  semantic follow-up instead of appending another fact or opening another Host
  answer.
- Made the timing distinction descriptor-owned through
  `advice_optional_fields` and `final_selection_required_fields`, so future
  season mechanics with post-choice reveals can reuse the same common card.

## 2026-07-29 - Synchronize approved UI and runtime mode decisions

- Split equipment choice truth into mutually exclusive component, standard
  completed, radiant, artifact, emblem, and internal special categories.
  Normal forge cards no longer inherit radiant, artifact, emblem, or special
  candidates; radiant choices have an explicit card kind.
- Made shared equipment inventory quantity-aware: duplicate copies are retained
  end to end, each visible token removes one copy, and radiant owned equipment
  is a first-class inherited category across every structured card.
- Added role facets to standard completed, artifact, and radiant candidate
  cards while preserving unfiltered typed search inside the selected legal
  category. Star-god reward fields now reject any non-`god_reward` entity.
- Classified raw `buff.json` rows before normalization instead of treating every
  technical asset as a player-facing augment. S17 star-god reward wrappers and
  Aurelion Sol reward subchoices are excluded at build time and by the active
  season descriptor, so they cannot appear in gold augment search or delivery.
- Made augment availability two-scope by contract: empty dropdowns contain only
  exact-stage/tier legal candidates, while explicit typing may discover labeled
  cross-stage or unresolved true augments. Unknown-stage rows remain searchable
  evidence but never pollute 2-1, 3-2, or 4-2 browse lists.
- Rebuilt the S17 stage index and audited every unresolved augment row. Promoted
  `厨神阿福` to all three verified gold checkpoints and kept the remaining 44
  unresolved true augments out of strict stage dropdowns pending authority.
- Changed shared equipment editing to one full-width row per category. Every
  component, completed-item, artifact, and emblem field now opens a catalog
  dropdown; completed-item and artifact facets narrow browsing while typed
  search still spans the full category. State remains inherited across modes.
- Verified the descriptor-owned S17 `星神` rail entry and two-choice card in the
  browser, including stage tabs, reward filtering, Thresh's cross-god reward
  scope, final confirmation, and shared equipment rows.
- Promoted structured user card reports to the current choice-input contract:
  augment, active-season god, and item/anvil/forge cards are reported by the
  player as current-match structured text, not populated by OCR or host vision.
- Made card refresh local-edit only. Refresh controls prefill the refreshed
  report prefix and wait for the player to send; they do not auto-send or start
  a sensing path.
- Made card shape fully descriptor-driven: stage tabs, candidate count,
  required reward fields, search groups, and candidate labels come from the
  common choice contract or the active major-season descriptor. Common React
  and Electron surfaces no longer embed S17 stages or mechanic labels, and an
  item/forge card without fixed checkpoints binds to the daemon's current
  authoritative stage.
- Made final card confirmation the state boundary for augment, god, and item
  choices. Pending reported cards are candidate evidence only, and confirmation
  owns at most one strategy follow-up.
- Added round and rank-tier selector ownership. Round writes current-match
  phase context; rank tier writes user settings. Both are status-only controls.
- Kept S17 star-god as a season descriptor mode and declared no-descriptor
  seasons, including S18 if undeclared, hidden/fail-closed for that mode.
- Unified shared equipment context across item mode and proactive item advice:
  resolve item bench and equipped items per field from MuMu structured facts,
  current-match user confirmation, then fallback candidates.
- Narrowed item mode to item/anvil/forge choice cards plus item-dependent
  advice. It is not a general inventory scanner, opponent item path, or
  hero/item reward three-choice sensing path.
- Required ceiling-lineup and data quick actions to prefill from active-season
  catalog, hard data, daily big data, confirmed choices, live facts, shared
  equipment, and missing-condition language.
- Recorded opening economy short advice as canonical response-task delivery
  with exactly-once UI acknowledgment and no sibling Host answer.
- Reaffirmed `lineup_card` strict output as `jcc-internal-lineup-plan-v1` with
  renderer-safe 4x7 coordinates, current-season units, loadouts, and moves.
- Added a 300-second deep strategy timeout policy for lineup, postgame, and
  explicitly deep analysis requests while preserving the normal one-answer
  delivery contract.
- Restated version layering: common UI/runtime stay season-neutral, major-season
  mechanics live in selected season descriptors, and ordinary minor patches
  update hard-data/ranking/strategy tuples.
- Replaced the generated decision-input catalog's concrete promoted package
  path with the logical `active_hard_data_manifest` source reference. Explicit
  candidate builds retain an operation-scoped candidate reference, while the
  active artifact cannot freeze a package id that will drift on promotion.
- Verified that structured choice cards visually replace, rather than overlap,
  the generic pinned card; shared variable drafts remain mounted and survive a
  temporary mode switch. The augment card occupies about half the compact
  viewport, keeps its body scrollable, and leaves the composer stable.

Verification:

```powershell
node tools\verify-jcc-runtime-ui-mode-contract.mjs
node tools\verify-jcc-runtime-mode-sensing-map.mjs
node tools\verify-jcc-season-aware-renderer-modes.mjs
node tools\verify-jcc-choice-composer-prefill-ui.mjs
node tools\verify-jcc-lineup-card-response-contract.mjs
node tools\verify-jcc-response-task-delivery-contract.mjs
node tools\verify-jcc-decision-input-ui.mjs
node tools\verify-jcc-structured-card-backend-actions-blackbox.mjs
node tools\verify-jcc-common-season-neutrality.mjs
node tools\verify-jcc-runtime-mainline-paths.mjs
node tools\verify-jcc-pinned-card-browser.mjs
node tools\verify-jcc-requirements-authority.mjs
```

## 2026-08-09 - Preserve structured-card answer ownership and match drafts

- Classified explicit candidate advice, whole-card advice, equipment advice,
  and final confirmation as user-owned `structured_card_action` tasks in the
  card's registered backend mode. Choice-window reservation and automatic
  cross-stage proactive expiry no longer cancel these tasks.
- Required explicit card event categories and event types to pass the canonical
  semantic admission policy before opening the Host lane. After exactly-once
  renderer delivery is acknowledged, the temporary choice mode returns to
  Cruise.
- Made punctuation-only status checks observe the existing in-flight response
  task instead of preempting it and opening a generic direct-chat task. This
  prevents a waiting `?` from replacing the submitted candidate request.
- Promoted unconfirmed structured-card drafts to current-match renderer state.
  Tier, stage, candidates, target note, and selected option now survive a
  temporary mode change; canonical submitted reports rehydrate them when no
  newer dirty draft exists. Drafts reset at the match-session boundary.
- Suppressed player-visible failure spam from non-durable automatic runtime
  events while preserving one visible failure for direct and structured-card
  owners and retaining canonical failure diagnostics.

Verification:

```powershell
node tools\verify-jcc-structured-card-backend-actions-blackbox.mjs
node tools\verify-jcc-decision-input-ui.mjs
node tools\verify-jcc-response-task-delivery-contract.mjs
node tools\verify-jcc-requirements-authority.mjs
cd ui; npm.cmd run build
```

## 2026-08-06 - Gate native lobby readiness and rank-scope ranking evidence

- Made startup and crash recovery establish one writable provider-native lobby
  session before a user turn can enter it. An immediate message waits on the
  single in-flight warmup; a missing Codex rollout is resumed once, replaced by
  one fresh thread, and the original user turn is delivered exactly once.
- Kept provider identity part of session ownership. Switching CLI provider,
  model, command, or reasoning setting closes the old provider routes and
  bootstraps the selected provider before later lobby or match turns. Warmups
  are isolated by route plus provider identity, and ordinary or auxiliary turns
  re-check that ownership before recovery or commit, so a late old-provider
  result cannot block, close, or overwrite the replacement session.
- Made SQLite-hydrated user preferences authoritative for the first lobby
  bootstrap. Compatibility JSON mirrors no longer overwrite the saved rank or
  alter the static capsule after restart, provider switch, New Conversation,
  or Start Match.
- Promoted the saved rank preference from advisory text to deterministic live
  ranking retrieval scope. `master` and `challenger` select `master_plus`;
  `emerald` and `diamond` select `platinum_to_diamond`. The provider capsule,
  selected ranking candidates, and cruise strategy-fit context use the same
  scope and never silently fall back to another segment or all-tier evidence.

Verification:

```powershell
node tools\verify-jcc-host-session-lifecycle-contract.mjs
node tools\verify-jcc-host-selected-context-contract.mjs
node tools\verify-jcc-host-request-runtime-context.mjs
node tools\verify-jcc-requirements-authority.mjs
```

## 2026-07-28 - Make proactive work immediately targetable

- Routed runtime semantic-event persistence through the daemon's already-open
  SQLite writer instead of opening and closing a second service-side connection
  for each event.
- Automatic coaching now publishes a minimal canonical `preparing` task before
  assembling its agenda, state fingerprint, and pipeline arguments. Manual
  questions and Stop Answer can target that task immediately.
- Made legacy JSON mirrors coalesced, best-effort compatibility output so they
  cannot block canonical SQLite action completion.
- Made an accepted Stop Answer cancellation settle automatically when the
  native Codex turn or Kimi ACP prompt finishes cancelling. The canonical task
  becomes `cancelled` and releases the Host answer lane without requiring a
  second Stop click, while the owning provider session stays alive.
- Choice-window preemption permanently retires stale pre-choice advice. A later
  confirmed choice owns the new semantic follow-up; the old cross-stage answer
  is not retried.
- Added release-gate coverage for immutable Host request/task identity,
  user-report composer prefill without auto-send, structured MuMu item-source
  health, and exactly-once coach delivery.
- Made browser and runtime verifiers follow production cleanup boundaries:
  shutdown active runtime services, detach writers, terminate owned Chrome and
  Vite process trees, wait for exit, and retry Windows temporary-directory
  cleanup instead of leaving child processes or producing cleanup-only red
  gates.

Verification:

```powershell
node tools\verify-jcc-runtime-event-pipeline-preemption.mjs
node tools\verify-jcc-runtime-daemon.mjs
node tools\verify-jcc-response-task-delivery-contract.mjs
node tools\verify-jcc-host-session-lifecycle-contract.mjs
node tools\verify-jcc-cruise-state-materialization.mjs
node tools\verify-jcc-pinned-card-browser.mjs
node tools\verify-jcc-host-request-task-identity.mjs
node tools\verify-jcc-choice-composer-prefill-ui.mjs
node tools\verify-jcc-mumu-item-source-health-context.mjs
```

## 2026-07-28 - Close canonical sensing, cancellation, and proactive cadence gaps

- Prevented legacy JSON compatibility/debug mirrors from hydrating or replacing
  daemon SQLite canonical state, including when SQLite starts empty.
- Kept a provider-accepted but unsettled Stop Answer task in canonical
  `cancelling` state with its original task identity so repeated Stop actions
  target the same native turn without closing the owning provider session.
- Narrowed self-state refresh to HUD phase/economy ROI facts plus reads of
  already-canonical structured equipment. Periodic/background refresh cannot
  start item icon matching or host multimodal sensing.
- Made item decision admission consume the highest reliable resolved equipment
  field rather than requiring both structured and user-confirmed inventories.
- Defined cooldown precedence once: a registered decision trigger uses its
  trigger cooldown; semantic-category cooldown is fallback only; the global
  one-to-two-round cadence remains an additional anti-noise gate.
- Added executable descriptor-variable save -> SQLite hydrate -> Host-context
  roundtrip coverage and a 2-2/2-3/2-5/3-1 proactive cruise simulation covering
  raw fact silence, actionable agendas, choice/danger exceptions, and stale
  cross-stage expiry.
- Added one cross-path delivery regression proving that initial canonical
  delivery followed by event-stream replay and watchdog reconciliation renders
  and ACKs the same completed response exactly once.
- Kept the real-browser lineup-card script as manual visual acceptance because
  it depends on local Chrome, Vite startup, fonts, viewport, and timing. Core
  release checks continue to prove card structure, publishability, renderer
  routing, and exact canonical ACK behavior deterministically.

Verification:

```powershell
node tools\verify-jcc-runtime-daemon.mjs
node tools\verify-jcc-host-session-lifecycle-contract.mjs
node tools\verify-jcc-response-task-delivery-contract.mjs
node tools\verify-jcc-season-variable-canonical-roundtrip.mjs
node tools\verify-jcc-proactive-coach-multiround.mjs
node tools\verify-jcc-requirements-authority.mjs
```

## 2026-07-28 - Make season setup and decision surfaces descriptor-owned

- Moved S17 manual setup fields, labels, option sources, cardinality, summary
  roles, and legacy payload aliases into the S17 major-season descriptor.
- Made Electron persistence and match-context projection accept a generic
  `seasonVariables` object compiled from the active season. Common runtime and
  renderer code no longer own S17 setup field names.
- Kept active choice intake user-reported and made worker, pipeline, scorer,
  checkpoint, and Host context routing consume active compiled descriptors
  instead of retaining common S17 branches.
- Added a common-season-neutrality release gate and synthetic future-season
  coverage. A season without S17 descriptors must not render, persist, route,
  or validate S17 mechanics, even if stale option data exists.
- Kept ordinary minor-patch updates on the hard-data/ranking/strategy promotion
  tuple. These descriptor changes are required only when a major season adds,
  removes, or changes a real mechanic or setup field.

Verification:

```powershell
node tools\verify-jcc-season-version-isolation.mjs
node tools\verify-jcc-season-aware-renderer-modes.mjs
node tools\verify-jcc-common-season-neutrality.mjs
node tools\verify-jcc-requirements-authority.mjs
```

## 2026-07-28 - Close canonical session and choice-delivery boundary gaps

- Required Start Match to commit the new canonical match boundary before the
  previous match provider route is cancelled or closed. Late completions from
  the old route cannot reclaim the new match.
- Made live Host provider-session descriptors canonical SQLite state. Warmup,
  bootstrap, turn completion, and failure changes persist through the daemon
  without borrowing response-task ownership.
- Preserved `origin: user` through direct-chat and strategy-Wiki response-task
  transitions so operational events cannot silently downgrade a user-owned
  answer into an automatic task.
- Moved the S17 star-god renderer mode out of the common UI mode contract and
  into the S17 major-season module. The renderer now consumes active-season
  mode definitions supplied by runtime, so a future season does not inherit S17
  controls or vocabulary.
- Removed the obsolete augment-reroll Host multimodal follow-up from the
  production pipeline. Refresh now prefills the current-match report prefix and
  waits for the user to edit and send; it does not reserve a second answer task.
- Corrected the major-season governance runbook: active choice descriptors own
  user-report, UI, stage, and Host-context contracts. Choice OCR tools may remain
  only for compatibility/calibration and are not product intake or warmup paths.

Verification:

```powershell
node tools\verify-jcc-single-writer-canonical-state-contract.mjs
node tools\verify-jcc-host-session-lifecycle-contract.mjs
node tools\verify-jcc-response-task-delivery-contract.mjs
node tools\verify-jcc-runtime-ui-mode-contract.mjs
node tools\verify-jcc-season-aware-renderer-modes.mjs
node tools\verify-jcc-augment-reroll-choice-state.mjs
node tools\verify-jcc-requirements-authority.mjs
```

## 2026-07-26 - Make provider-native conversations the only chat lifecycle

- Declared Codex `thread` and Kimi ACP `session` as the conversation/history
  mechanisms; JCC Runtime does not implement a parallel transcript or context
  compaction system.
- Kept one lobby native conversation until app exit or explicit New
  Conversation, and one match native conversation per Start Match.
- Defined explicit New Conversation as a lobby-only session reset that
  preserves durable preferences, strategy Wiki, review records, MuMu, and an
  active match.
- Removed prior-turn message replay from ordinary Host deltas. The provider
  retains dialogue history; each turn receives only current SQLite-owned facts
  and a reference to the static capsule loaded at native-session bootstrap.
- Made Stop Answer preserve the current mode while interrupting only the active
  native provider turn.
- Made Stop Answer transport-preserving when cancellation is slow or the
  provider has not exposed a targetable turn/prompt yet; runtime reports the
  pending/failure state instead of killing the native process and forcing the
  next ordinary message through resume/load.
- Made clean Exit invalidate the active match route. The next app launch must
  require a new Start Match and cannot treat the deliberately closed match as
  crash recovery.
- Defined missing-session recovery: after one crash-only native resume/load
  attempt reports that the saved thread/session is gone, runtime bootstraps one
  fresh provider-native conversation for the still-active owner and includes
  the current turn without replaying prior chat history.
- Made Start Match transactional at the match boundary: generation of the new
  canonical match id must succeed before the previous provider route closes,
  and the command waits for the new native session's initial static bootstrap
  result before reporting readiness. Provider bootstrap failure stays on the
  new match as retryable readiness rather than restoring stale match state.
- Added symmetric missing-session fallback verification for both Codex threads
  and Kimi ACP sessions.
- Preserved an in-flight Stop Answer cancellation handle when Codex has not yet
  exposed a turn id. The first Stop reports not-yet-targetable without closing
  the native thread; a later retry can interrupt that same turn once targetable.

## 2026-07-26 - Scope persistent-session Wiki context by version ownership

- Restricted Host session Wiki injection to global universal pages, the active
  major season's mechanic pages, and the active minor patch's meta pages.
- Minor-patch retirement now marks only superseded `patch_meta_strategy` pages
  stale; it cannot invalidate reusable base-game or major-season knowledge.
- Kept SQLite plus the active season/patch tuple authoritative over provider
  session memory.

## 2026-07-26 - Host context lifecycle and provider session reuse

- Added `data/runtime/jcc/host-context-lifecycle-contract.json` as the machine
  authority for host CLI provider session lifetime and selected-context
  injection.
- Added the dedicated `host_context_session_lifecycle` authority domain so
  future delivery changes cannot hide lifecycle regressions inside the broader
  response-task contract.
- Defined one persistent lobby provider process/session per app opening and
  one persistent match provider process/session per Start Match.
- Required repeated turns to reuse the live owning provider process/session and
  limited provider session resume to crash/recovery paths only.
- Added an optional real-provider two-turn smoke that proves one provider
  session id, one OS process, and cross-turn context retention without resend.
- Clarified Stop Answer, Stop Match, Start Match, and Exit boundaries: Stop
  Answer interrupts only the current `response_task`; Stop Match closes the
  match provider process/session and returns to the existing lobby; Exit closes
  all runtime-owned provider and child processes.
- Required static common, major-season, minor-patch hard-data, daily-ranking,
  strategy-wiki, and economy context to be injected once per provider-session
  fingerprint, while dynamic current facts are supplied per turn.
- Clarified that a changed static fingerprint is replaced once inside the same
  live owning provider session. It must not create or resume a provider session;
  provider resume remains crash/recovery only.
- Reaffirmed that `.jcc-runtime-data/app.sqlite` remains authoritative and
  provider memory is only a cache. Common host instructions, S17 major-season
  mechanics, ordinary minor patches, and hard-data/ranking/wiki layers remain
  separate.

Verification:

```powershell
node tools\verify-jcc-requirements-authority.mjs
```

## 2026-07-27 - Choice-intake and proactive-coach authority migration

- Migrated authority entrypoints and runbooks to the approved choice intake:
  augment, S17 star-god two-choice, and item/anvil candidates are
  current-match user reports only, with no OCR or host multimodal fallback for
  candidate names.
- Preserved active OCR only for HUD self-state and explicit owned-augment
  text-panel recovery. Choice OCR tools are documented as
  compatibility/calibration only and must not populate live product choice
  candidates.
- Documented the composer behavior: mode actions prefill and wait for the user
  to send; refresh prefills the refreshed-report prefix and does not auto-send;
  the 2-1 augment report includes current equipment and later augment rounds
  use equipment deltas unless more facts changed.
- Clarified proactive cruise authority: continuous facts update immutable latest
  decision snapshots, derived decisions enter a decision agenda, normal cadence
  is at most one visible answer per one to two rounds, and stale cross-stage
  advice is suppressed/recomputed.
- Reaffirmed lineup card output as `pinned_result` with schema
  `jcc-internal-lineup-plan-v1`; the deterministic runtime renderer owns the
  4x7 board materialization.
- Kept Host reasoning effort session-stable instead of adding per-turn dynamic
  routing. A real `gpt-5.6-sol` two-turn persistent-session comparison measured
  low at 8.9s/7.9s and high at 9.2s/7.7s, which is not a material latency
  difference. Dynamic routing remains disabled until it can preserve the same
  live native provider session and demonstrates a repeatable benefit.

Verification:

```powershell
node -e "JSON.parse(require('fs').readFileSync('docs/requirements/requirements-registry.json','utf8')); console.log('requirements registry json ok')"
node tools\verify-jcc-requirements-authority.mjs
```

## 2026-07-23 - Field-level equipment resolution and coaching decisions

- Made left-item-rail inventory and equipped-holder assignments independent
  facts. Each field now uses its highest currently reliable source instead of
  treating equipment as an all-or-nothing snapshot.
- Current-match user confirmation is immediately usable and never waits for
  MuMu recovery or visual/icon candidates. A structured observed-empty field
  clears older fallback for that field; partial confirmation preserves the
  other previously confirmed field.
- Limited contextual equipment questions to a specific missing field that can
  change the next action. The user's reply owns one direct Host answer and may
  immediately give slam, wait, holder, or transfer advice without a sibling
  event answer.
- Passed effective equipment through deterministic scoring, proactive event
  admission, cruise pipeline context, and Host request context. Visual-only
  candidates remain non-authoritative and cannot open the proactive item lane.
- Added universal itemization doctrine for survival, tempo, core holders,
  utility gaps, tools, and big-data priors. Kept S17 star-god, psionic-weapon,
  emblem, judge-law, and stargazing item interactions in the S17 rules only.
- Removed S17 variable names from the common manual-variable UI field list,
  product-gated future-season renderer isolation, and classified the obsolete
  S17 manual-variable contract as historical lineage instead of current
  acceptance authority.

Verification:

```powershell
node tools\verify-jcc-user-confirmed-equipment-context.mjs
node tools\verify-jcc-mumu-item-source-health-context.mjs
node tools\verify-jcc-effective-equipment-runtime-flow.mjs
node tools\verify-jcc-cruise-runtime-pipeline.mjs
```

## 2026-07-22 - Live-match authority and exactly-once Host delivery

- Bound every pending Host answer to its immutable task-specific request event;
  a later request can no longer overwrite the identity used to validate an
  earlier model answer.
- Kept one strategy-answer owner per interaction. Derived intent/target facts
  update context only, and confirmation-only choice messages cancel the old
  choice task before one localized confirmation/follow-up owner continues.
- Made daemon response-task reconciliation owner-aware and monotonic. Delayed
  failures cannot overwrite completed or delivered answers, and automatic
  preparing tasks have a bounded watchdog that releases the lane silently.
  Ownerless idle snapshots cannot clear a registered preparing owner.
- Split HUD stage and economy freshness. Stage-only sensing preserves a still
  fresh full-economy observation without extending its TTL, and HUD facts are
  promoted before optional icon fallback work.
- Corrected resident RapidOCR option forwarding. Verified local HP and level
  crops use recognition-only OCR, combat damage panels cannot emit HP, and
  level 10 produces structured max XP.
- Made MuMu item-source health explicit: 4357 is still primary for the left
  rail, trusted 4356-to-4353 assignment is still primary for equipped items,
  and missing/empty structured commands are reported as source degradation.
- Made renderer modes and missing-choice prompts active-season capabilities.
  S17 keeps its star-god mode; a future season without that mechanic cannot
  inherit its UI, checkpoint, or follow-up prompts.
- Made the active choice-mode contract inject the visible candidate set into
  its declared Host context field. Augment, season-special, and item choices
  now share one data-driven path, so a model cannot receive a choice task while
  the structured candidates remain stranded only in pipeline state.
- Removed the last common-runtime S17 deterministic choice recommender and its
  user-visible escape hatch. Choice scorers remain structured evidence only;
  candidate evidence paths are declared by each active version contract and
  the Host model owns the one visible coaching answer.
- Added bounded MuMu item-source diagnostics. The watcher now distinguishes a
  missing 4357 source, suspected command-id drift, payload/line parse rejection,
  4356 promotion-gate rejection, and logcat capture loss without retaining a
  full raw log or promoting icon-match fallback candidates.
- Removed the final S17 choice vocabulary from common Host coaching questions
  and correction prompts. Daemon task scope now treats only explicit daily
  modes as daily; future season modes are match-scoped without adding them to
  a common-code whitelist.
- Split season-scoped OCR worker identity from reusable worker capability.
  Common runtime dispatches `augment_choice`, `god_choice`, and `item_choice`
  capabilities from active descriptors and no longer branches on an S17-only
  worker key. HUD sampling also has a machine-owned context-only trigger
  contract instead of a verifier depending on documentation wording.

Verification:

```powershell
node tools\verify-jcc-host-request-task-identity.mjs
node tools\verify-jcc-response-task-delivery-contract.mjs
node tools\verify-jcc-ocr-field-aggregator.mjs
node tools\verify-jcc-stage-context-authority.mjs
node tools\verify-jcc-mumu-item-source-health-context.mjs
node tools\verify-jcc-season-aware-renderer-modes.mjs
```

## 2026-07-22 - Data-driven choice checkpoint validation

- Made every major-season choice mechanic declare `intent_terms`; compiled
  checkpoints now carry label, kind, mode, phase, trigger terms, aliases, and
  normalized semantic terms.
- Removed common Host and cruise-pipeline keyword branches for augment and
  S17 star-god checkpoints. Both validators now consume only the active
  compiled checkpoint descriptor.
- Preserved S17 augment and star-god wording through S17 rule data, not common
  code.
- Added a synthetic S18-style mechanic test proving a new mechanic is
  validated from its own terms and an absent star-god mechanic is not inherited.

Verification:

```powershell
node tools\verify-jcc-active-rules-context.mjs
node tools\verify-jcc-season-version-isolation.mjs
node tools\verify-jcc-requirements-authority.mjs
```

## 2026-07-21 - Canonical choice descriptor consumption

- Made the active-rules compiler the single builder for runtime choice mode
  descriptors.
- Removed S17-only mode names, task routing, and star-god Host context prose
  from the common cruise/context-pack registries; S17 special rules now own
  those fields.
- Required every effective choice descriptor to declare candidate paths,
  advice-task trigger terms, visible-window answer behavior, and Host mode
  context.
- Made Electron mode registration, OCR warmup, cruise routing, and Host context
  packs consume the same active descriptor list.
- Changed generic active-version verifiers to compare against the promoted tuple
  instead of pinning `s17` / `s17_7`; S17 timing remains in S17-scoped fixtures.
- Added a no-special-mechanic context-pack fixture so a future season cannot
  inherit or advertise an absent S17 mode.
- Removed active-runtime `--patch-dir` overrides from cruise/combat-cap context;
  the promoted manifest is validated and required strategy indexes fail closed.
- Replaced exceptional patch-rule deep merge with whitelisted, declared-surface
  replacement; undeclared payload and non-rule metadata changes are rejected.

## 2026-07-20 - Requirements authority v1

- Established daemon + SQLite as canonical runtime state; legacy JSON remains
  mirror/debug output only.
- Established scoped RapidOCR ROI as the HUD and visible choice-text fast path;
  host multimodal vision is fallback for missing or ambiguous evidence.
- Established MuMu `4357` as the item-rail primary source and gated `4356` to
  trusted `4353` assignment under `S=1` plus a fresh non-empty `4354` anchor.
- Removed opponent board, opponent power scan, and counter-positioning from the
  product mainline.
- Established `data/runtime/jcc/runtime-ui-mode-contract.json` as mode authority,
  including `lineup_card`.
- Reclassified old implementation plans, generated review snapshots, and the
  Android companion track so they cannot gate the MuMu desktop release.
- Required every repository Markdown requirement surface to have an exact
  registry entry or inherit an explicit non-current subtree classification.

Verification:

```powershell
node tools\verify-jcc-requirements-authority.mjs
node tools\verify-jcc-runtime-product-gate.mjs --profile core
```

## 2026-07-20 - Season version governance split

- Established the active season as an immutable promotion tuple:
  `season_id`, `active_patch_id`, `game_mode_id`, `package_id`, and
  `hard_data_manifest`.
- Split major-season runtime rules from minor-patch hard data, rankings, and
  patch strategy overrides.
- Moved S17.7 economy/meta coaching bias out of S17 normal game-rule timing and
  into a patch-scoped strategy override file.
- Required active tuple changes to apply to new matches only; in-progress match
  sessions retain the tuple captured at match start.
- Added rollback/history policy: keep old season modules, patch overrides,
  hard-data packages, previous rankings, and postgame evidence addressable.
- Added an operator runbook for S17.7 to S17.8 minor-patch promotion and S17 to
  S18 major-season promotion.

Verification:

```powershell
node tools\verify-jcc-requirements-authority.mjs
```

## 2026-07-20 - Canonical host instruction and current-turn authority

- Established `host-coach-instruction-contract.json` as the single provider-neutral
  runtime-invariant instruction source for Codex and Kimi host adapters.
- Required runtime-service and cruise pipeline to use the same instruction builder
  and active-rules compiler.
- Removed stage-only reuse of caller-derived game-rule/game-state contracts; each
  host call now rebuilds a match/mode/stage/rules-fingerprint current-turn contract.
- Added request-level checks for the key S17 choice stages and synthetic future-season
  isolation without placing S17 timing into invariant instructions.

Verification:

```powershell
node tools\verify-jcc-host-coach-instruction-contract.mjs
node tools\verify-jcc-active-rules-context.mjs
node tools\verify-jcc-host-request-stage-snapshots.mjs
node tools\verify-jcc-season-version-isolation.mjs
```

## 2026-07-21 - Fail-closed version authority and data-driven choice mechanics

- Removed the hardcoded S17.7 fallback when the runtime season contract is
  missing, invalid, or incomplete.
- Required active matches to carry the complete new-match promotion tuple and
  reject advice when any immutable field, including `hard_data_manifest`, no
  longer matches the compiled active rules bundle.
- Replaced common-layer `star_god_*` timing fields with data-driven
  `choice_mechanics`; S17 now owns its star-god descriptor, host mode add-on,
  and `god_choice` alias inside S17 special rules.
- Required exceptional patch rule overrides to match both active season and
  patch, include rollback evidence, and restore the prior fingerprint when the
  override is removed.
- Completed the choice-mode boundary: common runtime now registers choice
  sensing from active descriptors, while S17 owns its star-god intent, ROI,
  worker, visual, candidate, follow-up, and opening-variable semantics.
- Removed fixed active-package paths from current runtime contracts and
  executable tools. Active operations follow the promotion tuple; candidate
  hard-data build and verification require an explicit validated manifest.
- New matches now freeze the exact compiled `rules_source_fingerprint` in
  addition to the promotion tuple; in-place rule drift during a match fails
  closed.
- Major-season ids must use `s<number>`; patch-shaped ids cannot create a major
  season namespace. Missing common economy doctrine also fails closed instead
  of falling back to a copy embedded in runtime code.
- Start-match choice OCR warmup is now derived from active choice descriptors,
  so a future season without S17 star-god mechanics does not load or advertise
  the S17 special-choice worker.

Verification:

```powershell
node tools\verify-jcc-host-coach-instruction-contract.mjs
node tools\verify-jcc-season-version-isolation.mjs
node tools\verify-jcc-stage-context-authority.mjs
node tools\verify-jcc-electron-host-request-smoke.mjs
```

## 2026-07-21 - Requirements authority domain enforcement

- Upgraded the requirement registry to v2 with machine-readable authority
  domains that bind each critical behavior to its owning machine contract,
  guidance, engineering entrypoints, implementation paths, and core-gated
  verifiers.
- Declared `AGENTS.md` and the repo-local `jcc-runtime-agent` skill to be
  discovery/authoring entrypoints rather than fallback product authorities.
- Locked the canonical host instruction contract, season version contract, and
  season governance runbook into the authority verifier's required current
  classifications.
- Made removed-product requirement scanning derive from every registered
  current Markdown/JSON text authority instead of a hand-maintained subset.
- Added explicit change routing for provider-neutral instructions, reusable
  base doctrine, major-season mechanics, ordinary minor patches, and exceptional
  same-season rule changes.
- Added complete active hard-data verification to the core product gate.
- Closed a descriptor contract gap by requiring every choice mode to declare
  its missing-selection follow-up instead of relying on a generic runtime
  fallback.
- Classified `AGENTS.md` and the repo-local skill as `entrypoint_only` current
  guidance rather than behavior `source_of_truth` entries.
- Removed the remaining `star-god` wording from reusable base doctrine and added
  a future-season leakage assertion derived from active special-mechanic terms.

Verification:

```powershell
node tools\verify-jcc-requirements-authority.mjs
node tools\verify-jcc-active-rules-context.mjs
node tools\verify-jcc-host-coach-instruction-contract.mjs
node tools\verify-jcc-season-module-boundaries.mjs
node tools\verify-jcc-season-version-isolation.mjs
node tools\verify-jcc-hard-data.mjs
node tools\verify-jcc-runtime-product-gate.mjs --profile core
```

## 2026-07-21 - Product-gate canonical-state isolation

- Required every product-gate child process to receive a unique temporary
  `JCC_RUNTIME_DATA_DIR`; deterministic verification must never hydrate from or
  write to the real `.jcc-runtime-data/app.sqlite` state.
- Removed verifier cleanup paths that hard-coded the production data root after
  temporary tests. Cleanup now restores the process's original isolated root.
- Added a core gate self-check so missing runtime-data isolation fails before
  behavioral verifiers can run against player state.

Verification:

```powershell
node tools\verify-jcc-runtime-product-gate.mjs --profile core
```

## 2026-07-21 - Shared OCR lifecycle and Android 15 capture

- Consolidated every HUD and choice OCR consumer behind one daemon-owned
  RapidOCR process and one serialized request queue.
- Made concurrent prewarm idempotent and made startup timeout, window close, and
  daemon shutdown terminate the full worker process tree.
- Changed the production capture default to ADB-first `auto`, with discovered
  MuMuShell as an empty-frame fallback instead of a MuMu 12-only prerequisite.
- Clarified that HUD sampling updates authoritative facts but cannot directly
  consume the host-model response lane; model speech remains semantic-event or
  user-request driven.

Verification:

```powershell
node tools\verify-jcc-rapidocr-resident-worker-lifecycle.mjs
node tools\verify-jcc-self-state-roi-capture-source-contract.mjs
node tools\verify-jcc-mumu-source-degraded-contract.mjs
```

## 2026-07-21 - Current-stage doctrine guard

- Moved the opening-example freshness guard into the provider-neutral canonical
  host instruction contract so every manual, cruise, choice, and lineup request
  treats examples such as 1-1 as doctrine rather than a later-stage action.
- Updated regression coverage to inspect the canonical contract instead of
  requiring duplicate prompt text in `runtime-service.js`.

Verification:

```powershell
node tools\verify-jcc-host-coach-instruction-contract.mjs
node tools\verify-jcc-live-test-symptom-regression.mjs
```

## 2026-07-21 - Bounded sensing, exact host delivery, and resilient rankings

- Made all scoped ROI subprocesses use one bounded process runner with hidden
  Windows execution, full-tree timeout termination, and exit confirmation.
- Kept background HUD refresh strict single-flight: stale status no longer
  releases the lock while old work is alive, and manual refresh cannot overlap
  an unfinished run.
- Changed sensing retention to bound both files and nested run directories,
  fail closed on invalid limits, and remain isolated from real runtime state in
  tests.
- Correlated resident OCR responses by request id so a late timed-out response
  cannot settle the next crop task.
- Made authoritative 4357 availability independent from HUD OCR success and
  retained icon matching as a throttled fallback-only path.
- Selected the unique host JSON object containing canonical `final_text`,
  rejected multiple coach objects, rebuilt responses from a field allowlist,
  rejected identity conflicts, quarantined provider transport diagnostics, and
  used a bounded UI identity set for exactly-once delivery.
- Staged and audited live rankings before promotion. New-date rotation and
  same-date replacement are recoverable transactions; every failure preserves
  the last-known-good `current` snapshot.
- Added authority domains and core/goal gates for runtime sensing, response-task
  delivery, and live-ranking resilience; removed stale companion and
  visual-first equipment guidance from current documents.

Verification:

```powershell
node tools\verify-jcc-rapidocr-resident-worker-lifecycle.mjs
node tools\verify-jcc-runtime-sensing-artifact-retention.mjs
node tools\verify-jcc-host-response-json-decoder.mjs
node tools\verify-jcc-coach-response-delivery-dedup.mjs
node tools\verify-jcc-live-rankings-promotion.mjs
node tools\verify-jcc-requirements-authority.mjs
node tools\verify-jcc-runtime-product-gate.mjs --profile core
```
## 2026-07-21 - User interaction response ownership

- Defined one strategy-bearing coach answer per user interaction. Operational
  system status may remain visible, but it cannot contain a second strategy
  answer.
- Made the direct `response_task` own answers to user chat. The resulting
  `latest_user_intent_changed` event is interaction context only and carries
  its interaction/response-task causation.
- Separated durable `target_plan` facts from provisional lineup-like user
  intent. Ordinary lineup, economy, and item questions no longer manufacture
  a second `target_plan_changed` advice event.
- Kept target-plan changes available to later stage, choice, equipment-fit,
  economy, HP, and strategy-fit decisions without letting the field mutation
  itself occupy the Host CLI response lane.
- Assigned mixed confirmation-plus-question messages to the direct response
  task, while confirmation-only messages may designate one semantic follow-up
  as the strategy-answer owner.
- Changed manual match-variable confirmation to show an operational status
  immediately and reserve the one strategy answer for the AI-native
  `match_variables_changed` follow-up.
- Made confirmation-only and manual-variable UI actions immediately schedule
  canonical observe/delivery after their status message, instead of waiting for
  a later watcher observation or the 30-second watchdog.
- Made manual-variable events content-addressed so the explicit action and the
  semantic detector converge on one event key rather than two model jobs.
- Kept recent lineup intent available to strategy-fit, economy, equipment, and
  later event decisions as `provisional_user_intent` when no durable target plan
  exists; this context does not silently become confirmed and owns no answer.

Verification:

```powershell
node tools\verify-jcc-response-task-delivery-contract.mjs
node tools\verify-jcc-runtime-event-driven-observe.mjs
node tools\verify-jcc-requirements-authority.mjs
```

## 2026-07-21 - Proactive cruise decision deltas

- Kept raw shop, gold, board/bench, item, and snapshot changes as continuously
  committed facts without giving them direct Host speaking rights.
- Reused the deterministic cruise scorer before the Host gate and added typed,
  cooldowned decision deltas for shop/interest/lock, key-unit progression,
  lineup commit-or-pivot/cap gap, and explicit streak-plan changes.
- Kept direct user intent and durable target-plan mutations context-only so one
  interaction still has one strategy-answer owner.
- Added persistent provisional target context to economy, equipment, and
  decision scoring; an unrelated later chat message no longer erases the most
  recent lineup direction used by proactive decisions.
- Made durable target-plan timestamps authoritative over older lineup chat, so
  stale intent cannot redirect later key-unit or pivot scoring.
- Made semantic-trigger Host request selection fail closed; a proactive event
  cannot consume an unrelated latest request or disguise request-generation
  failure as a harmless no-advice result.
- Assigned every admitted proactive semantic event one event-owned
  `runtime_event_followup` request carrying its exact event key and focus;
  parallel scorer tasks remain evidence and cannot become sibling answers.
- Reserved all active and upcoming choice windows for the explicit
  augment/star-god/item mode and ROI paths, including when another derived
  decision changes during the same stage.
- Added key-unit and late cap-gap product triggers, a one-or-two-decision cruise
  response focus, and a guard against inventing win/loss streak state.
- Registered proactive cruise decisioning as its own requirements authority
  domain with implementation and verifier ownership.
- Made the product contract the single admission inventory for all 12
  proactive decision types, including early direction, tempo, level/roll,
  bench pressure, item posture, key-unit progression, and commit/pivot.
- Changed decision cooldown from broad category suppression to per-trigger
  cooldown while retaining the global anti-noise interval.
- Deferred choice-window decision evidence only to the immediate post-choice
  stage; a confirmed-choice semantic follow-up subsumes deferred evidence so it
  cannot create a second answer.
- Added delivery-time stage and live-state fingerprint expiry for non-durable
  proactive answers, while durable match-variable and confirmed-choice
  follow-ups may survive a stage transition.
- Removed the duplicate full daily-ranking payload from the summarized cruise
  decision context. The Host request keeps one root daily-data copy plus the
  compact strategy-fit result and provenance reference, reducing the measured
  cruise selected context from about 178 KB to about 135 KB.
- Moved stage checkpoints, choice-lane reservations, dangerous-HP follow-ups,
  confirmed choices, match variables, and all other Host-lane semantic
  categories into the UI mode contract with explicit priority and cooldown.
  Runtime no longer owns a second hardcoded admission table.
- Classified `special_context_visual_probe` as context-evidence acquisition,
  not a proactive answer owner; it cannot bypass explicit sensing boundaries
  or create another visible cruise response.

Verification:

```powershell
node tools\verify-jcc-proactive-coach-decision-delta.mjs
node tools\verify-jcc-runtime-event-driven-observe.mjs
node tools\verify-jcc-cruise-trigger-coverage.mjs
node tools\verify-jcc-runtime-event-pipeline-preemption.mjs
node tools\verify-jcc-host-coach-instruction-contract.mjs
node tools\verify-jcc-requirements-authority.mjs
```
- Choice candidate delivery is now contract-scoped end to end: stale generic `context.choices` cannot cross modes, visual choice cleanup follows active `candidate_paths`, S17 star-god OCR uses an explicitly season-scoped worker key, and deterministic scorer output remains hidden evidence for the Host coach rather than a second visible answer.
- MuMu item telemetry diagnosis now crosses the watcher/runtime boundary as a bounded summary: command counts and `source_not_emitted` / `parse_rejection` / `changed_command_id_suspected` / `promotion_gate_rejected` classifications reach Host context, while raw log lines remain out of live state and icon matches remain fallback-only evidence.
- Canonical Host instructions now preserve usefulness during MuMu item-source degradation: high-confidence icon candidates may support explicitly conditional advice, but cannot become owned item facts, holder assignments, or irreversible recommendations without confirmation.
- Removed the hidden periodic left-item icon fallback from background HUD sensing. MuMu `4357`/gated `4356` remain opportunistic structured sources; when they are absent, one bounded icon-matcher run is allowed only for an explicit user refresh/equipment request or explicit conflict check, and its output remains non-authoritative candidate evidence.
- Made automatic response delivery and retry expiry use the newest authoritative HUD stage rather than a stale raw MuMu stage shell, preventing earlier-stage advice from reviving or reaching the UI after the match has advanced.
- Made renderer reconciliation call the backend delivery reconciler for active
  `preparing`/`running`/pending tasks instead of returning early forever. Host
  completion, failure, and timeout now converge through the same canonical
  delivery and ACK path.
- Made a new direct user message preempt older Host work before it waits behind
  the daemon's serialized state reducer. The state transition itself remains
  serialized, so user priority no longer trades away canonical-state safety.
- Removed the renderer's second direct cruise-response delivery branch and
  made identical runtime-event retries idempotent. One response has one UI
  delivery surface, and an occupied answer lane no longer rewrites the same
  retry/audit record on every observation tick.
- Added an explicit current-item evidence gate: questions that depend on the
  player's current owned components/items may run one bounded left-item-rail
  matcher when `4357` is absent. General item-build questions do not capture a
  frame, choice modes remain latency-reserved, and matcher output stays
  candidate-only rather than becoming owned-item authority.

## 2026-07-23 - User-confirmed equipment context layer

- Established field-level equipment precedence: trusted `4357` item-rail and
  trusted `4356`-to-`4353` holder assignments first, active-match explicit user
  confirmation second, and visual/icon candidates last as conditional evidence.
- Added catalog-backed parsing for explicit current-equipment reports while
  keeping theoretical item questions as normal questions.
- Stored user-confirmed item bench and holder assignments with explicit source,
  revision, stage, and `match_session_id`; a new match cannot inherit them.
- Added a low-frequency contextual cruise prompt only when a material
  equipment-dependent decision lacks reliable structured or confirmed facts.
  The prompt uses the existing text/voice composer, is status-only, respects
  choice windows and active response tasks, and cannot reserve the Host lane.
- Kept `刷新我方状态` as the explicit bounded visual fallback path. Rejected a
  permanent `更新装备` mode/preset because an empty immediate send cannot carry
  the required user facts and would expose an implementation fallback as a
  first-class product mode.
- Made direct user equipment reports update selected context without starting
  icon matching or creating a derived sibling strategy answer. The equipment
  reply itself remains the single direct answer owner and may immediately give
  slam/wait/holder advice from the newly recorded facts.
- Split historical MuMu command presence from current field authority. A
  `4357` source seen earlier in the match no longer turns a missing current
  payload into an authoritative empty inventory; only an explicit current
  payload observation may clear the corresponding confirmed field.
- Required the inner `user_confirmed_equipment.match_session_id` to match the
  active match at pipeline, lifecycle, scorer, and Host-context boundaries.
  Missing or stale inner IDs are rejected even when an enclosing legacy
  context is unscoped.
- Applied the same no-wait rule to explicit self-state refresh: once the
  required current-match equipment field is confirmed, refresh does not run
  the item icon matcher before continuing.

Verification:

```powershell
node tools\verify-jcc-user-confirmed-equipment-context.mjs
node tools\verify-jcc-itemization-decision-context.mjs
node tools\verify-jcc-runtime-event-driven-observe.mjs
node tools\verify-jcc-requirements-authority.mjs
```
### 2026-07-23 - Equipment fact isolation and semantic answer-lane authority

- Direct scorer calls and the canonical equipment resolver now fail closed without an exact active-match boundary; raw `user_confirmed_equipment` from an old, unscoped, or active-id-less match cannot enter item scoring or advice evidence.
- `semantic_event_admission_policy[].opens_host_answer` is now the runtime admission authority before priority or response-lane mutation; categories declared context-only cannot open or preempt a Host answer lane.

## 2026-07-27 - Normalize current-match user-report intake for choice flows

- Standardized choice intake vocabulary on `candidate_input_policy:
  "current_match_user_report"` and a `user_report_contract` object so runtime
  and contract fields no longer drift on synonym names.
- Required `report_required_before_advice`, `report_prompt`,
  `refresh_report_prefix`, `refresh_creates_new_choice_set_revision`,
  `current_match_only`, and `no_ocr_or_vision_fallback` for current-match
  choice reporting.
- Kept first-equipment and later delta reports inside the augment-side
  `user_report_contract` shape while aligning god, augment, and item choice
  flows to the same current-match report policy.
- Preserved the refresh rule that a refreshed report creates a new choice-set
  revision and invalidates the prior candidate set.

Verification:

```powershell
node tools\verify-jcc-requirements-authority.mjs
```

## 2026-07-28 - Discoverable professional actions and match setup

- Moved Cruise quick actions out of renderer hardcoding and into the common,
  season-neutral runtime UI mode contract. The compact action set now covers
  ceiling lineup, economy tempo, lineup validation, current data, augment fit,
  and item/roll timing, with novice-facing descriptions supplied as tooltips.
- Added one contract-backed lineup materialization action for the attainable
  ceiling. The Host still produces the existing deterministic
  pinned-result schema; this change does not introduce a second card path.
- Kept augment, active-season choice, and equipment candidate flows as
  user-report-first inputs. Their action prefills the composer and waits for the
  player to complete and send it; refresh reporting remains prefill-only. The
  explicit owned-augment detail-panel reader remains a separate immediate OCR
  operation after the player opens that panel, not a candidate-report preset.
- Made a successful Start Match reveal the pinned Variables tab immediately
  while Cruise stays selected. Showing the setup card does not switch backend
  mode, confirm blank values, reserve the answer lane, or create a Host turn.
- Replaced current product and IA references to fixed old-season choice fields
  with active-major-season descriptor language so a future major season can
  replace its mechanic without changing common renderer code.

Verification:

```powershell
node tools\verify-jcc-runtime-ui-mode-contract.mjs
node tools\verify-jcc-ui-runtime-bridge.mjs
node tools\verify-jcc-choice-composer-prefill-ui.mjs
node tools\verify-jcc-pinned-card-browser.mjs
node tools\verify-jcc-requirements-authority.mjs
```

## 2026-07-29 - Structured decision cards and deterministic lineup delivery

- Replaced chat-composer candidate templates for augment, active-season choice,
  and forge/anvil decisions with structured searchable cards. Candidate reports,
  advice requests, and final confirmations now carry match, stage, choice-kind,
  choice-set revision, and report identity instead of relying on free-text binding.
- Defined exact-stage augment catalogs and separate pending-set versus final-choice
  boundaries. A partial reroll keeps unchanged slots; the player edits only the
  candidates that actually changed and submits again from the same card.
- Restored the S17 Star-God mode through the S17 descriptor only. Its card stores
  both the selected god and current reward text. Seasons without an equivalent
  descriptor hide the mode and its missing-choice checkpoints.
- Added one shared current-match equipment editor across decision cards, with
  component, completed-item, artifact, and emblem tokens. Omitted categories
  preserve current facts; explicit empty categories clear only themselves;
  Backspace removes one whole token.
- Narrowed Equipment mode to supported four/five-option forge and anvil choices.
  Ordinary inventory remains shared decision context rather than a separate
  report mode.
- Made current-data and ceiling-lineup quick actions prefill-only and open-ended.
  Runtime attaches current data when the player sends instead of dumping selected
  context into the composer.
- Strengthened opening economy advice to one canonical, exactly-once response of
  at most five compact lines separating known facts, keep/sell, interest, credible
  streak spend, and the first augment/equipment posture.
- Required every structured-card advice and final-confirm interaction to start the
  executable runtime-event Host pipeline after reserving its canonical owner. A
  `preparing` card task without a runner is invalid and may not age out silently.
- Made the card payload binding mandatory at the IPC trust boundary. Submit and
  final confirmation now reject a missing, stale, wrong-stage, wrong-kind,
  wrong-revision, or wrong-report binding instead of silently minting a new one.
- Preserved explicit whole-card versus choice-only advice semantics and registered
  both categories in the proactive event inventory. Each card action writes an
  immutable latest-fact snapshot whose stage is the card checkpoint, so a 3-2
  report cannot start a Host turn against a lingering 3-1 phase frame.
- Standardized lineup-card output on `jcc-internal-lineup-plan-v1`: canonical
  `recommended_moves` is an object array, `moves` is a string array, and the
  deterministic 4x7 renderer owns materialization. Deep lineup planning may use
  the registered 300-second timeout without changing real-time choice budgets.

## 2026-07-29 - Stage-safe choice discovery and shared equipment facts

- Replaced icon-manifest stage hints as augment gameplay authority with a
  generated, versioned availability index tied to the promoted season/patch
  data tuple. The generated audit currently isolates 55 catalog rows whose
  stage remains unknown instead of leaking them into every default dropdown.
- Split discovery into two deliberate scopes. Empty dropdowns expose the full
  legal list for the exact stage and tier. Explicit typed search may discover
  cross-stage and unknown-stage rows, but the UI labels their availability and
  prevents a known wrong-stage selection from silently becoming current truth.
- Bound `神律新令` to `3-2 / gold` and kept `投资`, `投资+`, and `投资++` as
  separate stage-bound entities. Added regression coverage for stage/tier lists,
  global search metadata, and the unknown-stage audit.
- Made component, completed-item, artifact, and emblem catalogs available to
  every structured choice card. Token add/remove/clear operations now persist
  as no-model current-match facts and inherit across modes; only whole-equipment
  or whole-card advice may reserve the Host answer lane.
- Added multi-tag equipment browse facets while preserving full-category typed
  search. Tags are lookup aids rather than exclusive strategic classifications.
- Removed the requirement to request advice before confirming a final choice.
  One confirm click atomically saves any dirty candidate set without a model
  answer, then confirms the selected candidate and opens at most one semantic
  Coach follow-up.
- Restored S17 Star-God as a descriptor-driven visible card and connected the
  stage-specific `god_reward` catalog. Normal gods show their same-stage rewards;
  Thresh may search every god's rewards from the same checkpoint. Future seasons
  without that descriptor remain free of S17 UI and checkpoints.

Verification:

```powershell
node tools\verify-jcc-decision-input-catalog.mjs
node tools\verify-jcc-decision-input-ui.mjs
node tools\verify-jcc-season-aware-renderer-modes.mjs
node tools\verify-jcc-structured-card-backend-actions-blackbox.mjs
node tools\verify-jcc-requirements-authority.mjs
```
## 2026-07-29 - Structured decision cards validate canonical choice identity

- Item/anvil reports now require the exact descriptor-owned candidate count and catalog category at daemon submission time; renderer filtering is no longer trusted as the canonical boundary.
- S17 star-god rewards now remain scoped to the selected god and current stage, with Thresh as the explicit same-stage all-gods exception. Custom current-match reward text remains supported when no catalog reward exists.
- Structured dropdowns expand inside the scrollable decision card instead of covering neighboring fields on compact windows.
## 2026-07-30 - Curated equipment roles and canonical Star-God card inheritance

- Split equipment browse/holder taxonomy from raw stat and effect tags. Standard
  completed items, radiant variants, and artifacts now carry curated
  `primary_role` and `browse_facets`; components remain untagged for role
  browsing. Frontline means a real defensive/tank use case, so incidental AP,
  AD, health, armor, magic resistance, healing, or recovery text can no longer
  place Gunblade, Shojin, Infinity Edge, or similar items into the wrong UI
  category.
- Propagated the curated taxonomy through the hard-data package, decision-input
  catalog, daemon DTO, shared confirmed-equipment editor, and item/anvil card.
  Explicit text search still spans the complete item category, while facet
  buttons filter only by curated usage roles.
- Made S17 Star-God candidate inheritance descriptor-owned. `god_options` seeds
  the 2-4 card; a card candidate report synchronizes the latest pair back to the
  same canonical variable without a model answer; 3-4 and 4-4 inherit that pair
  until the player changes it. Common UI remains season-neutral.
- Reworked catalog option metadata into readable two-line rows with separate
  stage/facet chips and full accessible labels, replacing the truncated combined
  badge used by Star-God rewards.

Verification:

```powershell
node tools\verify-jcc-hard-data.mjs
node tools\verify-jcc-decision-input-catalog.mjs
node tools\verify-jcc-decision-input-ui.mjs
node tools\verify-jcc-structured-card-backend-actions-blackbox.mjs
npm.cmd --prefix ui run build
```

## 2026-07-30 - Inject curated equipment semantics without turn bloat

- Added the compact current-patch equipment role taxonomy to the provider's
  one-time static session capsule. It is not repeated in gameplay turn deltas.
- Propagated `primary_role`, `browse_facets`, and taxonomy provenance into
  champion-specific itemization retrieval packets, so Host decisions receive
  the same curated semantics used by the structured cards.
- Kept facets as retrieval and role evidence rather than a final itemization
  verdict; current HP, economy, target plan, holder, components, traits,
  augments, and exact item effects still decide the action.

Verification:

```powershell
node tools\verify-jcc-host-request-runtime-context.mjs
node tools\verify-jcc-runtime-mode-host-request-benchmark.mjs
node tools\verify-jcc-itemization-decision-context.mjs
```

## 2026-08-02 - Promote the S17.8 official data and ranking tuple

- Collected the official `17.17.8-S18` Mode 17 package as the immutable
  `jcc-mode17-s18-17.17.8` source and normalized its 71 champions, 178 items,
  34 traits, 267 player-facing augments, and 141 Star-God rewards.
- Applied the supplied S17.8 hero, trait, Anima Squad equipment, Psionic Agent
  equipment, and augment balance changes as patch-provenanced hard data. Exact
  verifier assertions cover the changed entities instead of relying on a prose
  release note at Host time.
- Stopped official current-value packages from replaying historical normalized
  patch attachments. The S17.8 verifier now requires every current-patch
  provenance entry to match the declared balance ledger exactly, so older
  S17.5/S17.7 deltas cannot be relabeled as S17.8 changes.
- Removed the historical `patch17_7_duang` synthetic augment. The official
  player-facing entity remains `10611 / 邦！`; `DUANG!` is its search alias and
  links to official chess variant 1464 for the current 0.8 attack speed.
  Current packages reject historical patch-specific augment IDs and prose.
- Removed historical entity-count assumptions from hard-data readiness and made
  parser inventory verification distinguish required current semantics from
  source-dependent patterns. New S17.8 effect text now produces explicit
  semantic refinements instead of remaining in the high-priority unresolved
  queue.
- Rebuilt the decision-input catalog for `s17_8`, preserving exact-stage
  availability and a complete 40-row unknown-stage audit. Candidate catalog
  verification now checks the candidate package and runtime patch identity.
- Refreshed the latest available Zhangmeng ranking snapshot for `20260801`
  against the S17.8 candidate package. Ranking refresh now explicitly accepts a
  candidate manifest before tuple promotion while preserving last-known-good
  `current/` on fetch, write, or audit failure.
- Promoted the complete active tuple to `s17_8 / jcc-mode17 /
  jcc-mode17-s18-17.17.8`. Common Host instructions and S17 major-season rules
  remain unchanged; the patch strategy file supplies only soft tempo and
  balance priors, while live facts and promoted rankings remain decisive.

Verification:

```powershell
node tools\verify-jcc-hard-data.mjs
node tools\verify-jcc-decision-input-catalog.mjs
node tools\verify-jcc-live-rankings.mjs
node tools\verify-jcc-active-rules-context.mjs
node tools\verify-jcc-season-version-isolation.mjs
node tools\verify-jcc-requirements-authority.mjs
```
## 2026-08-10 - Separate equipment fact confirmation from advice and preserve proactive delivery

- Added a whole-snapshot `确认装备` action that records the hydrated current-match
  equipment state without opening a Host turn. `整体装备建议` remains a separate
  explicit action with one Host answer owner.
- Kept failed structured-card answers in their originating mode and made Host
  artifact filenames Windows-safe, preventing response-task IDs containing `:`
  from failing after the model had already completed.
- Separated durable target plans from provisional lineup intent. With no durable
  target, Cruise now evaluates current stage, HP, economy, own board/bench,
  equipment, choices, and ranking candidates instead of treating a ranking line
  as the player's chosen composition.
- Replaced whole-live-state proactive expiry with decision-scoped freshness.
  Non-durable advice requires a current stage; scorer-driven events use the same
  decision-trigger fingerprint domain at admission and delivery; exact shop and
  bench advice remains material-state strict.
- Kept scorer-driven shop and bench decisions exact-state strict while also
  expiring them when a newer target or choice context changes their action
  fingerprint. Opening economy advice is now represented by its real stage
  categories instead of an unproduced scorer trigger.
- Prevented transient S=2/non-self views from cancelling an already-owned
  proactive answer based on the last trusted self snapshot. New advice remains
  suppressed while the current view is not self-owned.
- Stopped non-durable proactive events from opening Host tasks without a stage.
  If an existing answer temporarily cannot verify the current stage, runtime
  now preserves its owner and defers delivery instead of deleting the answer.
- Added compact per-field HUD audit evidence (`observed`/`missing`, normalized
  value, source, and confidence) to every successful HUD facts event, allowing
  HP ROI reliability to be measured without retaining screenshots.
- Hardened HP aggregation against the observed overlapping scoreboard-row
  marker: a dominant `100` glyph remains 100, malformed `00` remains missing,
  and a separate row number can no longer be concatenated into active HP.

## 2026-08-11 - Require a visible Windows window before desktop launch succeeds

- Fixed the cold-start path where Electron remained alive with `show: false`
  after a stalled `ready-to-show` event. A bounded fallback now exposes the
  window and retries the initial renderer load once.
- Changed the hidden developer launcher so an existing Electron process with no
  visible window is not reported as success. It asks the owning Electron process
  to reveal its BrowserWindow through a user-scoped local activation pipe and
  keeps native second-instance activation as the bounded fallback.
- Extended the Windows distribution gate to cover cold-start visibility and
  hidden-window recovery in addition to ordinary single-instance focus.

## 2026-08-11 - Make Stop Match preempt an unfinished provider bootstrap

- Fixed the control-lane inversion where `stopMatch` waited behind a long-running
  `startMatch` Host bootstrap and therefore never entered canonical match cleanup.
- Registered Codex app-server and Kimi ACP bootstrap transports before their
  native session exists, so Start Match replacement and Stop Match can close the
  in-progress process tree immediately while preserving serialized state writes.
- Blocked the stopping match route before a provider transport exists, covering
  the earlier window between canonical match creation and Host bootstrap start.
- Disabled hooks and plugins on the isolated Codex app-server transport. The
  JCC Host session now avoids unrelated plugin synchronization during startup,
  consistent with its selected-context-only runtime home.
- Added bounded Codex and Kimi pending-bootstrap tests that fail if route close
  waits for the provider lifecycle timeout.

## 2026-08-13 - Make structured cards authoritative and add proactive lineup convergence

- Fixed Augment Quick OCR dispatch so the real renderer payload (`augment` UI
  mode plus `augment_choice` backend kind) reaches the explicit draft OCR path.
  Start Match continues to prewarm one shared RapidOCR worker; its background
  model-load budget is now long enough for measured cold starts while the
  bounded Start Match wait remains independent.
- Verified the reported 2-1 screenshot through the production ROI geometry and
  shared worker. It read all three names (`神赐锻炉`, `心之钢`, `坦度成双`),
  proving ROI and OCR were healthy. The remaining third-slot failure came from
  validating S17.8 text against the stale MuMu visual overlay; Quick OCR now
  uses the active generated decision-input catalog instead.
- Protected renderer edits made while Quick OCR is running. A late result whose
  stage, tier, or candidate fingerprint no longer matches the local draft is
  discarded rather than overwriting the player's newer input.
- Removed ordinary-chat choice parsing and candidate extraction. Chat updates
  direct intent and provisional plans only; augment, active-season, and
  item/anvil candidates and final choices are canonical only through their
  structured cards. Legacy owned-augment panel OCR is diagnostic only.
- Added a registered proactive lineup-convergence agenda. With no durable
  target, Cruise offers 2-3 candidate lines in stage 2, narrows to a primary and
  backup after 3-2, recommends relative convergence around 3-5 to 3-7, and
  moves to commit/pivot execution after 4-2 without requiring a quick action.
- Hardened live-ranking retrieval around user target identity. Candidate groups
  now retain variant names, trait breakpoints, matching terms, and statistics;
  exact target relevance outranks generic high-stat fallbacks. The promoted
  master-plus snapshot now resolves `5太空律动` with its 24,792-game sample into
  the Host turn instead of reporting that the lineup is absent.
- Scoped structured-card bindings to one match, mode, choice kind, and stage.
  Moving from 2-1 to 3-2 or 4-2 now creates a fresh binding instead of forcing
  the player through a stale-card retry, while reopening the same checkpoint
  continues to preserve its draft.
- Made identical concurrent card submissions idempotent under one report
  identity while retaining fail-closed rejection for genuinely stale content.
- Gave survival-pressure decisions ownership over simultaneous lineup
  convergence advice; the convergence agenda remains context and resumes after
  the urgent stabilization action instead of competing for a second answer.
- Promoted the exact structured-card report into its card-owned Host request.
  Current candidates now override older observed/game-state fallback choices,
  preventing a correctly submitted card from reaching the model as an empty or
  previous-stage choice set.
- Made the long-session latency gate evaluate the real provider path: one
  static bootstrap followed by bounded current-turn deltas. Current measured
  turn prompts remain below 13 KB for Cruise, 10 KB for choice modes, and 11 KB
  for lineup materialization; the legacy all-context debug prompt is diagnostic
  only.
- Compacted Host correction turns inside native long conversations. They now
  carry the violated contract, request identity, and field diagnostics without
  replaying the just-seen static capsule, rankings, live snapshot, or full bad
  response.
- Bound the generated decision-input catalog to one deterministic source
  fingerprint over the exact hard-data manifest, normalized augment/item/reward
  inputs, alias gateway, stage authority, and common/major-season choice rules.
  Same-version source drift now fails closed before dropdown, search, save,
  confirmation, or Augment Quick OCR consumes the catalog.
- Replaced the developer-desktop OCR regression dependency with a repository-
  owned, privacy-redacted real frame that preserves the production 1434x807 ROI
  geometry, and added that real resident-worker run to the product gate.
- Strengthened target-aware ranking verification so a direct user message, a
  provisional latest target intent, and a durable target plan must each
  independently retrieve the 24,792-game `5太空律动` master-plus sample. Tests
  no longer hide a broken production entrance by repeating the same target in
  every context field.
- Serialized candidate saves and final confirmations through one mutation lane,
  and gave each explicit structured-card advice click a stable action identity.
  Concurrent duplicate submissions now share one report and one Host owner;
  a changed candidate set cannot overwrite an already confirmed checkpoint.
- Made current target identity explicit in live-ranking retrieval. A lineup named
  in the current user turn now outranks provisional intent, durable plan, and
  historical trait mentions, so old context cannot displace a direct query such
  as `5太空律动`; the selected packet carries primary and matched-primary terms.
- Normalized durable target identity across `name`, `target_name`, `lineup_name`,
  `summary`, `text`, and `primary_carry` wherever the canonical target plan may
  enter a Host request. A name-only persisted target now retrieves the same
  ranking evidence as an equivalent direct user statement.
- Reused that same target identity extractor in the proactive Cruise scorer, so
  ranking retrieval and lineup convergence cannot disagree about whether a
  `target_name`, `lineup_name`, or carry-only durable plan represents a target.
- Kept lineup Cruise active after a target exists. Generic discovery remains
  suppressed before 4-2, while 4-2 and later checkpoints proactively validate
  continue versus exit conditions and give an immediate execution action.
- Scoped the Augment Quick OCR single-flight lock by match. A new match can
  start its own draft OCR without waiting for an old match, while late old-match
  completion is fenced from the new renderer draft.
- Removed a second cold-start from the Quick OCR click path. The resident
  RapidOCR worker now receives the full frame plus normalized Augment panel ROI
  and performs crop plus recognition in memory instead of spawning a separate
  Python/Pillow cropper. The real redacted frame now reaches card slots 1/2/3
  through the production runner. Repeated measurements on the current machine
  ranged from about 1.9 seconds to 6.8 seconds after worker readiness, before
  connected-device ADB capture can be included in a live-match measurement.
- Separated the RapidOCR worker-startup allowance from one Quick OCR click. A
  hot click now has a 10-second OCR request bound instead of inheriting the
  120-second model-startup budget, and worker `warmup_ms` is normalized into the
  shared `load_ms` diagnostic for production timing evidence.
# 2026-08-15

- Made Augment Quick OCR a bounded foreground mechanical path. The resident
  worker now prioritizes the explicit choice-window request over queued HUD
  work, enforces a 15-second end-to-end budget starting at queue admission,
  removes expired requests before Python execution, correlates worker errors by
  request id, and fills every uniquely
  resolved physical slot instead of discarding a useful 1/3 or 2/3 result.
- Bounded canonical SQLite diagnostics without resetting user state. Startup,
  Stop Match, and daemon exit now prune terminal queue/event history while
  preserving live work, user preferences, strategy Wiki, sessions, and review
  records; Stop Match and exit also truncate-checkpoint the WAL. Persisted Host
  tasks and advice lifecycle diagnostics now store compact identities instead
  of repeated multi-megabyte context snapshots.
- Added an offline writer-lease guard for SQLite maintenance and an allowlisted
  local-artifact prune command for historical long-replay/verification output;
  neither cleanup path deletes preferences, Wiki, review state, provider
  sessions, rankings, or the current watcher state.
- Kept Cruise obligations simple and visible: missed lineup convergence advice
  is recomputed from the newest trusted facts and labels the stage used for the
  answer instead of being permanently cancelled by ordinary live-state churn.
# 2026-08-17 - Make fault diagnostics discoverable and repository UI launches fresh

- Moved the default-off OCR/Host fault-evidence switch out of strategy preferences
  into a dedicated Settings page with an independent save action.
- Made the repository desktop launcher fingerprint Renderer build inputs and
  rebuild stale `ui/dist` output before a cold launch; `dist/index.html`
  existence alone is no longer treated as proof that the desktop UI is current.

Constraint: Fault evidence remains default-off, bounded to seven days, and has
no strategy effect.
Rejected: Keep the switch under the user-preference label | Users could not
discover a runtime diagnostic control from a strategy-preference entry.
Confidence: high
Scope-risk: narrow
Tested: targeted UI bridge, Windows shortcut contract, requirements authority,
TypeScript build, and cold-launch fingerprint behavior.

# 2026-08-18 - Make every match a bounded runtime ownership scope

- Made Start Match prepare a new identity without touching the old watcher
  workspace, then publish that workspace only after the prior watcher process
  tree confirms exit. The prior match provider closes in parallel and a failed
  close now leaves the new match degraded instead of starting a competing Host
  owner.
- Made provider close results truthful. Codex and Kimi transport shutdown now
  reports the owned PID and confirmed exit result; a Codex transport that
  already crashed can still finish cleanup, while a live process that did not
  exit cannot be reported as closed.
- Retired queued RapidOCR work by `match_session_id`, fenced late OCR and Host
  completions from a replacement match, cleared match/mode context packs and
  renderer drafts at the canonical boundary, and removed old match messages
  from the renderer stream.
- Kept durable product state outside that boundary: user preferences, approved
  strategy memory, strategy Wiki, the lobby conversation, device connection,
  promoted data packages, and at most 20 compact structured postgame summaries.
  Raw screenshots, full request bodies, full live-state dumps, and unbounded
  diagnostics are not review memory.

Constraint: Start Match must not expose a second provider, watcher, or OCR owner
when the previous owner has not confirmed termination.
Rejected: Clear the shared workspace before stopping the old watcher | The old
process could repopulate files inside the new match boundary.
Confidence: high
Scope-risk: moderate
Tested: Host crash recovery and lifecycle contract, new-match isolation,
RapidOCR queue retirement, daemon/state-store retention, user settings and
20-match review rotation, requirements authority, and UI typecheck/build.

# 2026-08-18 - Make lineup retrieval re-queryable and composition-aware

- Added a season-neutral typed query compiler for natural-language lineup
  requests, including independent groups, exact breakpoints, champion roles,
  precedence-preserving AND/OR/NOT, explicit compare-each alternatives, and
  bounded unseen-result pagination.
- Made the complete promoted Master+ typed index the retrieval pool in lobby
  and match routes. Static Meta Map entries are orientation only; Start Match
  reranks the complete lightweight pool from current facts and hydrates full
  strategy detail only for selected candidates.
- Bound each exact query hit to the matching atomic published variant. Unknown
  entities, illegal breakpoints, resolver faults, and changed ranking
  fingerprints fail closed instead of silently dropping conditions or
  returning a normal-looking Meta fallback.
- Limited Host-visible lineup strength to national Master+ top-four, top-one,
  and appearance rates; winning-lineup recipe metrics remain offline gameplay
  linkage evidence.

Constraint: Live turns must keep the full candidate pool searchable without
copying raw ranking snapshots or complete strategy packages into each request.
Rejected: Reuse the first three Meta Map families as a permanent candidate pool
| It ignores user corrections, additional result pages, and material match
changes.
Confidence: high
Scope-risk: moderate
Tested: typed-intent, atomic retrieval, cursor pagination and invalidation,
real-current-data target retrieval, Host strategy payload boundaries, stage
weights, request-size benchmark, requirements authority, and UI build.

# 2026-08-19 - Make game knowledge a hot-swappable compiled authority

- Split season-neutral concepts, formulas, doctrine, routes, choice lifecycle,
  and retrieval policy from major-season mechanics and minor-patch source data.
  The common augment schedule remains 2-1, 3-2, and 4-2 unless a selected major
  season explicitly replaces or disables it.
- Made one immutable Core Profile the production active-rules authority and one
  immutable Ranking Overlay the current Master+ data authority. Start Match pins
  the Core Profile; each Host turn captures one compatible Knowledge Snapshot.
- Added typed-first retrieval over the complete Master+ lineup pool and a
  bounded MiniSearch layer for playbook, Wiki, alias, and fuzzy-language
  evidence. Full hard data and ranking snapshots are never copied into task or
  SQLite payloads.
- Separated the runtime-local `jcc-s17-s17_8` identity from upstream
  `jcc-mode17-s18-17.17.8` provenance. Upstream identifiers remain source proof
  only and cannot select local rules or appear as the product season.
- Retired the unused graph assets and graph builder after zero-consumer and
  typed-index parity gates passed. Legacy normal/special rule files now require
  explicit fixture opt-in and are no longer production authority.

Constraint: Current matches cannot mix Core or Ranking identities, and failed
candidate compilation or ranking refresh must preserve the last-known-good
active pointers.
Rejected: Keep raw graph bundles and legacy rule files as parallel production
authorities | Duplicate authorities make S18 hot-swap ambiguous and reintroduce
large, repeated runtime context.
Confidence: high
Scope-risk: broad
Tested: targeted compiler/profile, active-rule parity, knowledge snapshot,
typed/semantic retrieval, ranking generation, hard-data, storage-budget,
requirements-authority, season-isolation, and desktop integration gates.
# 2026-08-20 - Stage S18 hard data behind an explicit release gate

- Added deterministic S17 in-place archival metadata so active, rollback, and
  leased paths remain valid while the season is frozen against further edits.
- Registered S18/S18.1 as Runtime-local identity and kept upstream S19/18.18.1
  labels as provenance only.
- Defined the S18 Nature Sprite system as a shop extension rather than a new
  choice mode or manual variable, with no Runtime UI change in this phase.
- Allowed incomplete major-season candidates to compile for audit while making
  every non-empty `activation_blockers` list fail closed at Core promotion.
- Required a compatible audited current-day Master+ ranking overlay before S18
  can clear its ranking blocker and become production-active.
# 2026-08-21 - Standardize modular version updates and retire legacy rule fallback

- Added a machine-readable Harness entrypoint and one season-neutral version
  pipeline covering source adapters, deterministic inspection, immutable
  compilation, verification, explicit promotion, archive, and pruning.
- Renamed the candidate pointer to `candidate-profile.json` so it cannot be
  confused with the production `active-profile.json`.
- Made production active-rule loading Core-Profile-only and removed one-time
  migration, shadow-parity, and legacy fixture acceptance surfaces after cutover.
- Moved pre-profile S17 rule files into the frozen S17 archive for lineage only.
- Recorded Source Adapter, content-addressed generation, exact-id promotion,
  activation-blocker, lease, and rollback boundaries for future seasons and
  external Harnesses.
- Serialized hard-data publication, patch-candidate pointer replacement, and
  pruning under one lifecycle lock; abandoned locks recover only after their
  recorded owner process is no longer alive.

Constraint: S18 remains an unpromoted candidate until its registered activation
blockers are cleared; architecture cleanup cannot waive release evidence.

Rejected: Adopting Dagster, DVC, DataHub, Nix, TUF, GraphRAG, or a vector
database as a production dependency | their mature patterns are useful, but the
current local scale needs only a small deterministic implementation.

Directive: New season work may add or replace a patch Source Adapter, descriptor,
and source data, but must not branch shared Runtime, compiler, verifier, promotion,
archive, or pruning code by season name.
# 2026-08-28 - Close fixed Cruise checkpoints and current-match strategy evidence

- Made the registered Cruise checkpoint agenda the primary strategic coaching
  cadence while preserving one Host answer owner, delayed re-evaluation, and
  current-stage freshness.
- Kept durable target plans authoritative over older provisional chat and let
  material key-unit progress supersede generic continue/pivot scoring within a
  checkpoint round.
- Carried confirmed augment effect text, equipment facts, board/bench quality,
  Ranking working candidates, and final-lineup card requirements through the
  current-match decision packet.
- Removed the retired opponent board snapshot field from Android product live
  state and aligned owned-augment text-panel OCR documentation with the current
  diagnostic-only contract.
- Promoted MuMu's shop-anchored current-view board and derived traits into the
  Cruise live-state packet, preserving board/bench separation and rejecting
  unanchored or S=2 views as current own-board facts.
- Kept the strategic candidate working set intact during budget reduction and
  raised only the `lineup_card` soft target to 160 KiB; Cruise remains at 128
  KiB and every provider turn remains bounded by the 512 KiB hard ceiling.
- Updated MuMu regression fixtures to the active S18 catalog IDs and schema so
  tests validate the production contract rather than retired ID examples.

Constraint: Runtime may schedule and validate strategic obligations, but the
Host Agent remains responsible for comparing evidence and writing the final
coaching judgment.
Rejected: Treat every shop/economy update as an independent proactive answer |
it starves strategic convergence and repeats low-value facts.
Confidence: high
Scope-risk: broad
Tested: fixed checkpoints, delayed retries, target authority, decision deltas,
choice ownership, equipment/augment isolation, final lineup cards, Start Match
state authority, and UI build.

# 2026-09-01 - Separate engineering governance from the production Host contract

- Kept requirement-registry discovery and authority checks in the repo-local
  JCC Runtime authoring skill.
- Kept the root `AGENTS.md` as a thin production Host isolation contract that
  accepts only Runtime-selected `INPUT_JSON` context.
- Removed the contradictory verifier requirement that injected repository
  governance instructions into the production Host context.
- Registered canonical Ranking identity, atomic variants, recipe freshness,
  maintenance publication closure, and typed augment effects in the product
  gate so those modules cannot silently disappear from version verification.

Constraint: the same root file is copied into the Host workspace and therefore
cannot also serve as the engineering repository-navigation guide.
Rejected: restoring requirement-registry prose to the production Host prompt |
it violates the selected-context isolation boundary and increases prompt noise.
Confidence: high
Scope-risk: moderate
Tested: requirements authority verification and version-pipeline verifier
registration.

# 2026-09-02 - Apply 18.1b as an audited delta over the promoted Core baseline

- Preserved the pinned S18 DataTFT snapshot as an immutable Core supplement for
  its declared reward-rate, trait-tracking, and champion/item/sprite enrichment
  roles while keeping it outside Ranking authority, Runtime retrieval, and
  network refresh.
- Added a typed balance-patch overlay so ordinary same-season updates inherit
  the complete promoted Core and replace only explicitly declared fields.
- Published the 18.1b hard-data generation, Core Profile, compatible Master+
  Ranking Overlay, and recipe generation as one verified identity closure.
- Decoupled MuMu champion mapping receipts from balance-only field changes while
  retaining fail-closed checks for champion identity, name, star, and variant
  mapping drift.
- Pruned unreferenced generated generations after promotion and retained the
  bounded active, candidate, previous, archived, and leased rollback set.

Constraint: Minor balance patches must retain all unmodified Core hard data and
must not promote a supplemental source into live Ranking or Runtime authority.
Rejected: Rebuilding each minor patch from a different external dataset | it
would silently drop retained hard data and make patch provenance non-deterministic.
Confidence: high
Scope-risk: broad
Directive: Future S18 minor patches must name the latest promoted hard-data
generation as their parent and publish immutable Core, Ranking, and recipe
identities through the registered version pipeline.
Tested: balance overlay, S18 staging, DataTFT database/rate/tracker sources,
compiler, hard-data validation, MuMu mapping, Ranking closure, requirements
authority, registered version verification, and repository diff hygiene.
Not-tested: live gameplay decisions against a completed 18.1b match.

## 2026-09-06 - Register architecture audit and layered gate ownership

- Registered the existing compatibility-authority audit as supporting snapshot
  evidence, not a new current behavior authority.
- Linked the existing Host projection, task-contract registry, evidence
  materialization, turn trace, Ranking status view model, and strategic queue
  modules to their owning requirement domains.
- Explicitly classified product checks as deterministic, provider contract,
  or live acceptance. Deterministic gate children reject Provider discovery
  and answer dispatch; stub transport checks remain provider contracts.
- Added exact check selection and incrementally persisted atomic JSON reports.
  Failure categories remain blocking and require evidence rather than matching
  incidental words in test diagnostics. Live dependency skips are not passes.
- Corrected the semantic-maintenance verifier workspace expectation to use
  the configured Runtime data root instead of a hardcoded repository path.

Tested: requirements-authority targeted gate; classification, registration,
report writing, selection, offline Provider rejection, failure and timeout probes.
Not-tested: full product gate or live acceptance in this change; existing
mainline target-gate results were retained rather than rerun.

### 2026-09-06 - Register schema matrix and first-token checks

- Registered the existing Host schema transport matrix as deterministic and
  the local fake-provider first-token verifier as provider_contract.
- Linked both verifiers to response-task and Host-delivery authority.
- Rechecked Markdown registry coverage without running existing business tests.
  The activeMatchState equipment fix supplies an explicit reset-state fixture;
  it does not establish production persistence across a test state replacement.

Validated: new registration uniqueness, layer, path existence and diff syntax.
Not-tested: these business verifiers or the running mainline core gate.

### 2026-09-06 - Separate live execution from provider-contract classification

- Registered the existing native schema probe as provider_contract with explicit
  live execution. Only live/full profiles or exact --only selection include it;
  default core and offline provider_contract profiles never call this provider.
- Registered the existing evidence-materialization verifier as deterministic.
- Linked both verifiers to response-task and Host-delivery authority.

Validated: registration and profile selection only; no business gate was rerun.

### 2026-09-06 - Align projection authority and verifier outcome protocol

- Synchronized registry review dates for the Host lifecycle contract, strategy
  evidence runtime contract, and engineering skill index with the current change.
- The machine-owned task_projection_boundary defines fresh task projection,
  content-derived identity, native conversation ownership, evidence aliases and
  observation-only traces. candidate_boundaries separates the complete retrieval
  pool, at-most-ten Agent working set and requested display set while preserving
  candidate atomicity and explicitly absorbed strategic delivery obligations.
- No payload-budget values were changed by this registry alignment.
- Six verifiers previously exited successfully but emitted plain text or only
  status=ok. Standardized their terminal success envelope to JSON ok=true after
  all original assertions. Kept zero-exit, malformed output, skips and pending
  dependencies insufficient for gate success; explicit failure overrides pass.
- Added isolated subprocess outcome-protocol tests. Runtime data isolation and
  the deterministic Provider guard remain unchanged.

Tested: the six affected verifiers, outcome-protocol subprocess matrix and
requirements authority through the isolated gate; all eight checks passed.
Evidence: .omx/runtime-evidence/gate-outcome-protocol-affected.json.
Not-tested: a full gate rerun, real providers or existing user state directories.

### 2026-09-06 - Close augment and journey helper gate coverage

- Kept the existing Host evidence-materialization registration without duplication.
- Registered augment response semantic boundaries, current-Core augment profile
  resolution, and the journey acceptance helper verifier as deterministic checks.
- Linked the journey acceptance helper implementation and new verifiers to the
  corresponding authority domains. Helper coverage distinguishes failed tasks,
  missing ACK, actual dispatch evidence and performance targets from tolerance.
- This registration change does not rerun the full journey or live acceptance.

### 2026-09-06 - Separate whole-suite benchmark time from Host answer limits

- The mode benchmark runs daily cases, six match-mode cases and routing checks
  serially before optional live turns. The previous 90-second gate ceiling killed
  the whole local suite without a result; it did not measure one Host answer.
- Set this verifier's gate-only total timeout to 300 seconds. Existing production
  180-second Host call limits, live 60-second targets and payload assertions are
  unchanged. This is a bounded suite allowance, not a measured latency promise.
- Added local phase elapsed times; prior reports carried payload sizes and live
  timings but did not measure local preparation. The local sum excludes optional
  live calls and cleanup, while the outer gate includes the full process lifetime.
- The offline journey's explicit --real-host branch is recognized by the static
  classification audit; realHost defaults false and the runtime Provider guard
  remains active for every deterministic gate child.
# 2026-09-09 Knowledge Architecture Follow-Up

- Register authoritative Core traits before relation placeholders, preserving full trait details.
- Native Wiki retrieval uses full scoped published pages captured for the broker; unclassified legacy pages remain excluded. Native Ranking trend retrieval no longer depends on optional prefetch.
- Check Core/Ranking source identity on authorized broker calls, including cache hits, instead of labeling a changed source as the captured snapshot.
- Clarify search filters versus game context and repeated leading candidates; explicit re-fetch remains allowed.
- Performance probes retain independently named samples, query arguments, snapshot metadata and correction calls. Historical single timings are not controlled A/B evidence.
# 2026-09-11

- Strengthened Host current-turn projection: when `live_state_summary` owns fresh HUD stage/economy facts, `match_facts` no longer repeats that HUD payload; current SQLite decision snapshots remain authoritative for recovery.
- Kept raw ADB, watcher protocol diagnostics, ROI paths and parser counters outside ordinary Host turns while retaining bounded local sensing diagnostics and labelled visual fallback candidates.
- Raised the context-only manual-variable persistent-turn optimization target from 8 KiB to 16 KiB without changing the ordinary 2 MiB or strategic 8 MiB absolute ceilings.

# 2026-09-12 AI-native Host execution and strategic delivery

- Split Host context into one complete Agent-readable Common bootstrap, concise base instructions, full per-turn Mode contracts, and checkpoint-specific Action Briefs. Common removes machine metadata and exact duplicate representations without dropping independent decision facts; `get_common_knowledge` can recover complete relevant sections after compaction.
- Removed Provider format-correction turns and natural-language quality gates from production delivery. Runtime locally normalizes equivalent fields, records bounded soft diagnostics, immediately delivers readable strategy text, and degrades only the affected card. Hard rejection remains limited to transport recovery failure, unauthorized state mutation, incompatible authority snapshots, and cross-candidate authoritative card composition.
- Made native `jcc.query_knowledge` and `jcc.calculate` the model-visible knowledge interface. Repeated same-turn queries reuse snapshot-bound results, budgets reserve evidence adaptively, and compatibility transport is hidden from the Agent.
- Reworked fixed strategic scheduling around one in-process owned preparation task with an observational SLO. A live owner continues past 30 seconds without restart; an ownerless task recovered after Runtime interruption requeues the same strategic obligation or exposes one user-task failure. Later checkpoints absorb stale obligations; 2-5 remains a 2-2 recovery boundary and adds only a conditional one-cost reroll window when the confirmed target needs it.
- Unified Core, Ranking, augment, item, champion, variant, and transition relations into one typed relation index with provenance and collision-safe typed entity keys. Runtime mechanical fit is evidence; the Host Agent retains final strategy judgment.
- Bound prefetch-complete strategy evidence to each turn's existing soft target instead of its hard ceiling. Complete atomic evidence may still use the separate ordinary or strategic ceiling during final materialization.
- Removed the mutable active-version duplicate from the season module contract. Core Profile is now the only active season/patch/package authority for Host context, Wiki curation, itemization, and verification, preventing future patch promotion drift.
- Updated the full-player journey acceptance contract to measure delivery, stale-ACK probes, and exact renderer ACK separately; the three state-only augment confirmations are no longer counted as Host turns.
- Aligned the journey gate with the current checkpoint contract: the former 4-7 equipment/transition reply is absorbed by 3-7 and must not open a second Host turn.
- Removed an unused second lineup-score pass from fixed strategic response delivery; checkpoint freshness remains governed by stage and obligation-merging rules, while non-strategic events still recompute their action fingerprint when required.
- Added an explicit two-second delivery-stage acceptance limit so a future accidental strategic re-score cannot hide inside renderer ACK timing.
- Increased only the deterministic event-pipeline verification budget to cover its intentional delayed-preparation scenarios; production response timeouts are unchanged.
- Rebound Wiki curation and its regression gate to the promoted Active Core Profile season/patch identity instead of the retired mutable season selector.
- Published the latest available Tencent/JCC Master+ source date `20260911` as Ranking generation `20260911-28239845698266bb187b4886`, with 398 recipes, 47 lineup groups, 516 canonical rosters, completed semantic maintenance, and a `20260910`/`20260911` trend sequence. The current Core remains `s18/s18_2`.
- Kept provider tool negotiation out of the static Host capsule fingerprint. Codex now bootstraps the static capsule once, registers `jcc.query_knowledge` and `jcc.calculate`, then sends the first gameplay request as a delta-only turn instead of a redundant static-context update.
- Added per-check progress and elapsed-time diagnostics to the Host session lifecycle verifier. Increased only whole-suite gate budgets for long serial fixture suites; production Host request, provider, preparation, delivery, and ACK limits are unchanged.
- Confirmed retention semantics: two finalized Previous versions are retained from otherwise unreferenced Ranking generations, while Active, valid Core-candidate, archived, and leased generations remain independently protected. Compact trend history remains a separate store.

Validated: Common completeness/deduplication, native tools and reuse, semantic features and relation graph, soft response delivery, card materialization downgrade, checkpoint recovery/merge, strategic queue identity normalization, all Mode payload budgets, provider-session lifecycle, Electron Host request smoke, version-pipeline architecture, UI production build, and three adversarial review passes.

# 2026-09-13 Start Match minimal transport and readiness closure

- Replaced strategy-shaped Provider output with `final_text` plus at most one
  task-owned mechanical handoff: choice, candidate identity, lineup identity, or
  authorized fact capture. Runtime continues to accept legacy envelopes only at
  the normalization boundary; they are no longer requested from the Provider.
- Added recursive output-schema preflight and made every declared Provider field
  structurally required, using nullable values for semantic optionality. This
  prevents invalid Match schemas from reaching the Provider as HTTP 400 requests.
- Preserved readable `final_text` when optional handoff/card materialization is
  incomplete. Runtime records soft diagnostics without correction turns; only
  transport, authority, snapshot, permission, and atomic-card boundaries can
  reject their affected mechanical artifact.
- Made Lobby and Match bootstrap single-owner operations with activity leases,
  five-minute initialization and answer budgets, real cancellation, failed-session
  disposal before retry, and Match UI readiness only after watcher/OCR preparation
  and Host bootstrap complete.
- Added generic augment reward-promise compilation and conditional next-augment
  tier forecasts. Updated checkpoint briefs for artifact/emblem rewards, retained
  candidate persistence, one-cost 2-5 timing, six/seven-population transitions,
  and durable-target execution through late game.
- Updated schema, lifecycle, UI, semantic, checkpoint, and symptom-regression
  tests to assert the minimal handoff architecture. Long serial fixture suites use
  independent test budgets and do not redefine production response limits.
