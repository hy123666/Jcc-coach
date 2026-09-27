import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assembleStrategicObligationResponsePayload,
  absorbStrategicObligation,
  completeStrategicObligation,
  createStrategicObligationQueueState,
  enqueueStrategicObligation,
  selectPrimaryStrategicObligation,
  strategicObligationDeliveryEnvelope,
  completeStrategicObligationReceipts,
  completeStrategicObligationDelivery,
  diagnoseStrategicObligationResponseCoverage,
  normalizeStrategicObligationResponsePayload,
  recordStrategicObligationPartialCompletion,
  strategicObligationResponseDiagnostics,
  strategicObligationResponseIsComplete,
} from "../ui/electron/cruise-strategic-obligation-queue.js";

const event = (stage_round, fixed_checkpoint_id, decision_trigger_id = "lineup_convergence_checkpoint") => ({
  stage_round,
  fixed_checkpoint_id,
  decision_trigger_id,
  event_key: `verify:${stage_round}`,
});

const confirmedTarget = {
  schema: "jcc-runtime-target-plan-v1",
  candidate_id: "candidate-main",
  selected_variant_id: "candidate-main-variant",
  candidate_evidence_id: "evidence-candidate-main",
  name: "主线阵容",
  text: "主线阵容",
};

const confirmedTargetEvent = (stage_round, fixed_checkpoint_id) => ({
  ...event(stage_round, fixed_checkpoint_id),
  target_plan: confirmedTarget,
  target_context_authority: "durable_target_plan",
});

assert.equal(
  enqueueStrategicObligation(createStrategicObligationQueueState(), {
    ...event("2-2", "direction_exploration"),
    source: "persistent_strategic_obligation_queue:catchup",
  }).obligations_by_block.lineup_direction_commitment.latest_checkpoint_id,
  "direction_exploration",
  "fixed-checkpoint source suffixes must not invalidate a registered strategic obligation event",
);

let queue = createStrategicObligationQueueState();
queue = enqueueStrategicObligation(queue, event("2-2", "direction_exploration"));
const first = selectPrimaryStrategicObligation(queue);
assert.equal(first.latest_checkpoint_id, "direction_exploration");
assert(first.required_decisions.includes("complete_candidate_rosters"));

queue = enqueueStrategicObligation(queue, event("3-3", "post_3_2_narrowing"));
const narrowed = selectPrimaryStrategicObligation(queue);
assert.equal(narrowed.latest_checkpoint_id, "post_3_2_narrowing");
assert(narrowed.required_checkpoint_ids.includes("direction_exploration"));
assert(narrowed.required_decisions.includes("complete_candidate_rosters"));
assert(narrowed.required_decisions.includes("complete_candidate_rosters_and_roles"));

queue = absorbStrategicObligation(queue, event("4-3", "final_lineup_confirmation"));
const final = selectPrimaryStrategicObligation(queue);
assert.equal(final.latest_checkpoint_id, "final_lineup_confirmation");
assert(final.required_decisions.includes("complete_final_roster"));
assert(final.absorbed_checkpoint_ids.includes("post_3_2_narrowing"));

let targetLockedQueue = createStrategicObligationQueueState();
targetLockedQueue = enqueueStrategicObligation(
  targetLockedQueue,
  event("2-2", "direction_exploration"),
);
const unlockedRevision = targetLockedQueue.revision;
targetLockedQueue = enqueueStrategicObligation(
  targetLockedQueue,
  confirmedTargetEvent("2-2", "direction_exploration"),
);
const targetLockedExploration = strategicObligationDeliveryEnvelope(targetLockedQueue);
assert(targetLockedQueue.revision > unlockedRevision,
  "confirming a target while the same checkpoint is pending must upgrade the queue revision");
assert.equal(
  targetLockedExploration.candidate_policy,
  "confirmed_target_execution_or_reconciliation",
  "an early confirmed target must switch the direction block into target execution mode",
);
assert(!targetLockedExploration.required_decisions.includes("complete_candidate_rosters"),
  "a confirmed target must not retain the multi-candidate exploration obligation");
assert(targetLockedExploration.required_decisions.includes("confirmed_target_identity"),
  "target execution must preserve the confirmed target identity");
assert(targetLockedExploration.required_decisions.includes("complete_final_roster"),
  "target execution must still require the complete target roster");
assert.deepEqual(targetLockedExploration.target_plan, confirmedTarget,
  "the delivery envelope must carry the exact durable target plan");

const provisionalTargetEvent = {
  ...event("2-2", "direction_exploration"),
  target_plan: { text: "想围绕法系来牌运营，但不支持就转", source: "user_preference" },
};
const provisionalQueue = enqueueStrategicObligation(createStrategicObligationQueueState(), provisionalTargetEvent);
const provisionalEnvelope = strategicObligationDeliveryEnvelope(provisionalQueue);
assert.equal(provisionalEnvelope.target_plan, null,
  "a provisional preference must not become a durable target execution obligation");
assert(provisionalEnvelope.required_decisions.includes("complete_candidate_rosters"),
  "a provisional preference must preserve first-checkpoint candidate exploration");

targetLockedQueue = enqueueStrategicObligation(
  targetLockedQueue,
  confirmedTargetEvent("3-3", "post_3_2_narrowing"),
);
const targetLockedNarrowing = strategicObligationDeliveryEnvelope(targetLockedQueue);
assert.equal(targetLockedNarrowing.latest_checkpoint_id, "post_3_2_narrowing");
assert.equal(targetLockedNarrowing.candidate_policy, "confirmed_target_execution_or_reconciliation");
assert(!targetLockedNarrowing.required_decisions.includes("choice_effect_on_each_direction"),
  "3-3 must not re-open candidate comparison after target confirmation");
assert(!targetLockedNarrowing.required_decisions.includes("mainline_backup_and_pivot_condition"),
  "3-3 must not require a new mainline/backup choice after target confirmation");
assert(targetLockedNarrowing.required_decisions.includes("target_compatibility_with_current_choice"));
assert(targetLockedNarrowing.required_decisions.includes("target_execution_path"));

targetLockedQueue = enqueueStrategicObligation(
  targetLockedQueue,
  confirmedTargetEvent("4-3", "final_lineup_confirmation"),
);
const targetLockedFinal = strategicObligationDeliveryEnvelope(targetLockedQueue);
assert.equal(targetLockedFinal.latest_checkpoint_id, "final_lineup_confirmation");
assert.equal(targetLockedFinal.candidate_policy, "confirmed_target_final_reconciliation");
assert(targetLockedFinal.required_decisions.includes("confirmed_target_identity"));
assert(targetLockedFinal.required_decisions.includes("complete_final_roster"));
assert.equal(targetLockedFinal.ranking_candidate_selection_required, true,
  "a candidate-backed target may still require exact candidate identity");
assert.equal(targetLockedFinal.target_roster_required, true,
  "a confirmed target must require its complete roster independently of candidate selection");
assert(!targetLockedFinal.required_decisions.includes("lock_one_complete_target_candidate_identity_or_two_separately_named_last_choices"),
  "4-3 must not reopen a two-choice confirmation after the target is already locked");

let deferredSignalQueue = createStrategicObligationQueueState();
deferredSignalQueue = enqueueStrategicObligation(deferredSignalQueue, {
  fixed_checkpoint_id: "direction_exploration",
  fixed_checkpoint_stage_round: "2-2",
  decision_trigger_id: "lineup_convergence_checkpoint",
  event_key: "verify:deferred-signal:2-2",
});
assert.equal(
  selectPrimaryStrategicObligation(deferredSignalQueue)?.latest_stage_round,
  "2-2",
  "a deferred strategic signal must enqueue from fixed_checkpoint_stage_round",
);

let crossBlockQueue = createStrategicObligationQueueState();
crossBlockQueue = enqueueStrategicObligation(crossBlockQueue, event("2-2", "direction_exploration"));
const crossBlockRevision = crossBlockQueue.revision;
crossBlockQueue = enqueueStrategicObligation(crossBlockQueue, event("2-2", "direction_exploration"));
assert.equal(crossBlockQueue.revision, crossBlockRevision, "the same checkpoint event must be idempotent across detector and delivery stages");
crossBlockQueue = enqueueStrategicObligation(crossBlockQueue, {
  ...event("2-2", "direction_exploration"),
  event_key: "verify:delivery-wrapper:2-2",
  semantic_key: "strategic-obligation:delivery-wrapper:2-2",
});
assert.equal(
  crossBlockQueue.revision,
  crossBlockRevision,
  "the same checkpoint must remain idempotent when detector and delivery wrappers use different event keys",
);
crossBlockQueue = enqueueStrategicObligation(crossBlockQueue, event("3-5", "three_cost_reroll_or_operation"));
const crossBlock = strategicObligationDeliveryEnvelope(crossBlockQueue);
assert.equal(crossBlock.latest_checkpoint_id, "three_cost_reroll_or_operation", "the latest checkpoint across blocks must be primary");
assert(crossBlock.required_decisions.includes("complete_candidate_rosters"), "an undelivered stage-2 full-roster obligation must survive into a later block");
assert(crossBlock.required_decisions.includes("three_cost_carry_three_star_target_check"), "the current formation checkpoint must remain primary content");
assert.equal(crossBlock.supporting_obligations.length, 1, "the earlier direction block must be attached as supporting content");
assert.equal(crossBlock.completion_receipts.length, 2, "one delivered composite answer must carry exact receipts for both blocks");

const requiredDecisionsCovered = [...crossBlock.required_decisions];
const decisionOutputs = Object.fromEntries(requiredDecisionsCovered.map((decision) => [
  decision,
  `verified output for ${decision}`,
]));
const presentation = (candidateId, suffix) => ({
  candidate_id: candidateId,
  candidate_evidence_id: `evidence-${candidateId}`,
  selected_variant_id: `${candidateId}-variant`,
  atomic_roster_id: `${candidateId}-roster`,
  roster_is_atomic: true,
  unit_names: [`${suffix}主C`, `${suffix}主坦`, `${suffix}功能位`],
  atomic_roster_members: [
    { source_unit_id: `${candidateId}-carry`, champion_id: `${candidateId}-carry`, champion_name: `${suffix}主C`, entity_kind: "champion", occupies_population: true, catalog_resolution: "resolved" },
    { source_unit_id: `${candidateId}-tank`, champion_id: `${candidateId}-tank`, champion_name: `${suffix}主坦`, entity_kind: "champion", occupies_population: true, catalog_resolution: "resolved" },
    { source_unit_id: `${candidateId}-support`, champion_id: `${candidateId}-support`, champion_name: `${suffix}功能位`, entity_kind: "champion", occupies_population: true, catalog_resolution: "resolved" },
  ],
  target_population: 3,
  main_carry: `${suffix}主C`,
  primary_tank: `${suffix}主坦`,
  core_traits: [`${suffix}羁绊`],
  star_targets: [`${suffix}主C二星`],
  equipment_plan: [`${suffix}主C装备`],
  augment_conditions: [`${suffix}强化`],
  transition_path: [`${suffix}过渡`],
  lifecycle_prior: { archetype: "standard_operation", target_population: 8 },
  formation_profile: { formation_burden: "medium", estimated_burden_score: 0.5 },
  canonical_lineup_identity: { signature: `lineup:${candidateId}` },
  atomic_roster_observation: { sample_count: 100 },
  atomic_variant_difference: { variant_type: "baseline_complete" },
  mature_recipe_variants: [{
    source: "winning_recipe",
    removed_units: [],
    added_units: [],
    added_by_recipe_names: [`${suffix}变种棋子`],
  }],
  mature_recipe_variant_receipt: { source_count: 1, retained_count: 1, truncated: false },
  source_role: "master_plus_atomic_candidate",
  metrics_authority: "national_master_plus_current_snapshot",
  provenance: {
    canonical_roster_source: "national_atomic_roster",
    strength_source: "national_master_plus_trait_strength",
    recipe_source: "winning_recipe",
    recipe_metrics_used: false,
  },
  evidence_boundary: {
    canonical_roster_source: "national_atomic_roster",
    strength_source: "national_master_plus_trait_strength",
    recipe_source: "winning_recipe",
    recipe_metrics_used: false,
  },
  cap: `${suffix}成型上限`,
  floor: `${suffix}成型下限`,
});
const allowedCandidates = [
  presentation("candidate-main", "主线"),
  presentation("candidate-backup", "备用"),
  presentation("candidate-third", "第三"),
];
const validHostPayload = {
  final_text: `主线主C、主线主坦、主线功能位；备用主C、备用主坦、备用功能位；第三主C、第三主坦、第三功能位。${Object.values(decisionOutputs).join("；")}。`,
  strategic_completion: {
    queue_revision: crossBlock.queue_revision,
    completion_receipts: crossBlock.completion_receipts,
    covered_required_decisions: requiredDecisionsCovered,
    decision_outputs: decisionOutputs,
  },
  strategy_selection: {
    selected_candidate_ids: ["candidate-main", "candidate-backup", "candidate-third", "candidate-main"],
    candidate_presentations: allowedCandidates,
  },
};

const customTargetWithoutRoster = {
  ...crossBlock,
  target_roster_required: true,
  ranking_candidate_selection_required: false,
  target_plan: { target_id: "chat-target-1", name: "聊天发现阵容" },
};
const customTargetMissingRoster = diagnoseStrategicObligationResponseCoverage(
  customTargetWithoutRoster,
  {
    ...validHostPayload,
    final_text: "聊天发现阵容已确认。",
  },
);
assert(customTargetMissingRoster.errors.some((entry) => entry.code === "strategy_target_roster_missing"),
  "custom and chat-discovered targets must not pass without a complete roster");

const customTargetWithRoster = {
  ...customTargetWithoutRoster,
  target_plan: {
    target_id: "chat-target-1",
    name: "聊天发现阵容",
    unit_names: ["主C", "主坦"],
  },
};
const customTargetComplete = diagnoseStrategicObligationResponseCoverage(
  customTargetWithRoster,
  {
    ...validHostPayload,
    final_text: "聊天发现阵容包含主C和主坦，按目标执行。",
  },
);
assert(!customTargetComplete.errors.some((entry) => entry.code.startsWith("strategy_target_roster_missing")),
  "a custom target with a complete roster must satisfy target roster coverage");
const normalizedHostPayload = normalizeStrategicObligationResponsePayload(validHostPayload);
assert.deepEqual(
  normalizedHostPayload.strategy_selection.selected_candidate_ids,
  ["candidate-main", "candidate-backup", "candidate-third"],
  "normalization must deduplicate selected candidate ids without changing their order",
);
const validCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  validHostPayload,
  { allowedCandidateIds: ["candidate-main", "candidate-backup", "candidate-third"], allowedCandidates },
);
assert.equal(validCoverage.ok, true, JSON.stringify(validCoverage.errors));
assert.deepEqual(validCoverage.checks, {
  queue_revision_exact: true,
  completion_receipts_exact: true,
  required_decisions_covered: true,
  required_decision_outputs_complete: true,
  strategy_selection_valid: true,
  candidate_presentations_complete: true,
});
assert.equal(
  strategicObligationResponseIsComplete(
    crossBlock,
    validHostPayload,
    ["candidate-main", "candidate-backup", "candidate-third"],
    allowedCandidates,
  ),
  true,
  "the public completeness export must accept a valid response",
);
const publicDiagnostics = strategicObligationResponseDiagnostics(
  crossBlock,
  validHostPayload,
  ["candidate-main", "candidate-backup", "candidate-third"],
  allowedCandidates,
);
assert.equal(publicDiagnostics.ok, true);
assert.equal(publicDiagnostics.checks.required_decisions_covered, true);
assert.equal(publicDiagnostics.checks.required_decision_outputs_complete, true);
assert.equal(publicDiagnostics.checks.completion_receipts_exact, true);
assert.equal(publicDiagnostics.checks.strategy_selection_valid, true);

const booleanOnlyCompletion = strategicObligationResponseDiagnostics(
  crossBlock,
  {
    ...validHostPayload,
    final_text: "收到。",
    strategic_completion: {
      ...validHostPayload.strategic_completion,
      decision_outputs: Object.fromEntries(requiredDecisionsCovered.map((decision) => [decision, true])),
    },
  },
  ["candidate-main", "candidate-backup", "candidate-third"],
  allowedCandidates,
);
assert.equal(booleanOnlyCompletion.ok, false, "boolean markers must not close strategic obligations without substantive visible decisions");
assert(booleanOnlyCompletion.errors.some((entry) => entry.code === "strategic_completion_required_decision_outputs_missing"));

const runtimeAssembledPayload = assembleStrategicObligationResponsePayload(
  crossBlock,
  {
    final_text: "当前优先主线，并保留备用与第三方向；具体取舍见各项战略结论。",
    strategic_completion: {
      decision_outputs: decisionOutputs,
    },
    strategy_selection: {
      selected_candidate_ids: ["candidate-main", "candidate-backup", "candidate-third"],
      candidate_presentations: [{
        ...allowedCandidates[0],
        unit_names: ["被模型错误改写的棋子"],
      }],
    },
  },
  { allowedCandidates },
);
assert.equal(
  runtimeAssembledPayload.strategic_completion.queue_revision,
  crossBlock.queue_revision,
  "Runtime must attach the sealed strategic queue revision",
);
assert.deepEqual(
  runtimeAssembledPayload.strategic_completion.completion_receipts,
  crossBlock.completion_receipts,
  "Runtime must attach the sealed strategic completion receipts",
);
assert.deepEqual(
  runtimeAssembledPayload.strategy_selection.candidate_presentations.map((candidate) => candidate.candidate_id),
  ["candidate-main", "candidate-backup", "candidate-third"],
  "Runtime must hydrate every selected candidate from the sealed working set",
);
assert.equal(
  runtimeAssembledPayload.final_text,
  "当前优先主线，并保留备用与第三方向；具体取舍见各项战略结论。",
  "strategic assembly must preserve Host-authored final_text exactly",
);
assert(!JSON.stringify(runtimeAssembledPayload.runtime_materialization).includes("被模型错误改写的棋子"));
assert.equal(runtimeAssembledPayload.runtime_materialization.candidate_presentations.length, 3);
const nestedSelectionPayload = assembleStrategicObligationResponsePayload(
  crossBlock,
  {
    final_text: "当前优先主线，并保留备用与第三方向；具体取舍见各项战略结论。",
    strategic_completion: {
      decision_outputs: decisionOutputs,
      strategy_selection: {
        selected_candidate_refs: allowedCandidates.map((candidate) => ({
          candidate_id: candidate.candidate_id,
          selected_variant_id: candidate.selected_variant_id,
          candidate_evidence_id: candidate.candidate_evidence_id,
        })),
      },
    },
  },
  { allowedCandidates },
);
assert.deepEqual(
  nestedSelectionPayload.strategy_selection.selected_candidate_ids,
  ["candidate-main", "candidate-backup", "candidate-third"],
  "Runtime must normalize a strategy_selection object nested under strategic_completion without losing exact candidate identity",
);
assert.equal(
  nestedSelectionPayload.runtime_materialization.candidate_presentations.length,
  3,
  "nested strategy selection must still hydrate exact canonical candidates from the sealed working set",
);
const runtimeAssembledVisiblePayload = {
  ...runtimeAssembledPayload,
  final_text: `${runtimeAssembledPayload.final_text}\n${Object.values(decisionOutputs).join("；")}\n${allowedCandidates.flatMap((candidate) => candidate.unit_names).join("、")}`,
};
const assembledDiagnostics = strategicObligationResponseDiagnostics(
  crossBlock,
  runtimeAssembledVisiblePayload,
  allowedCandidates.map((candidate) => candidate.candidate_id),
  allowedCandidates,
);
assert.equal(assembledDiagnostics.ok, true, JSON.stringify(assembledDiagnostics.errors));

const assembledMissingDecision = assembleStrategicObligationResponsePayload(
  crossBlock,
  {
    final_text: "缺少一项决策输出。",
    strategic_completion: {
      decision_outputs: {},
    },
    strategy_selection: {
      selected_candidate_ids: ["candidate-main", "candidate-backup", "candidate-third"],
    },
  },
  { allowedCandidates },
);
const assembledMissingDecisionDiagnostics = strategicObligationResponseDiagnostics(
  crossBlock,
  assembledMissingDecision,
  allowedCandidates.map((candidate) => candidate.candidate_id),
  allowedCandidates,
);
assert.equal(assembledMissingDecisionDiagnostics.ok, false);
assert(assembledMissingDecisionDiagnostics.errors.some((entry) => (
  entry.code === "strategic_completion_required_decisions_missing"
    || entry.code === "strategic_completion_required_decision_outputs_missing"
)));

const duplicateVariantCandidates = [
  { ...allowedCandidates[0], selected_variant_id: "candidate-main-variant-a", candidate_evidence_id: "candidate-main-evidence-a" },
  { ...allowedCandidates[0], selected_variant_id: "candidate-main-variant-b", candidate_evidence_id: "candidate-main-evidence-b" },
];
const ambiguousVariantPayload = assembleStrategicObligationResponsePayload(
  crossBlock,
  {
    final_text: "选择主线候选。",
    strategic_completion: { decision_outputs: decisionOutputs },
    strategy_selection: { selected_candidate_ids: ["candidate-main"] },
  },
  { allowedCandidates: duplicateVariantCandidates },
);
assert(ambiguousVariantPayload.runtime_materialization.selection_resolution_errors.some((entry) => (
  entry.code === "strategy_selection_candidate_ref_ambiguous"
)));
const exactVariantPayload = assembleStrategicObligationResponsePayload(
  crossBlock,
  {
    final_text: "选择主线候选。",
    strategic_completion: { decision_outputs: decisionOutputs },
    strategy_selection: {
      selected_candidate_refs: [{
        candidate_id: "candidate-main",
        selected_variant_id: "candidate-main-variant-a",
        candidate_evidence_id: "candidate-main-evidence-a",
      }],
    },
  },
  { allowedCandidates: duplicateVariantCandidates },
);
assert.equal(exactVariantPayload.runtime_materialization.selection_resolution_errors.length, 0);
assert.equal(
  exactVariantPayload.runtime_materialization.candidate_presentations[0].selected_variant_id,
  "candidate-main-variant-a",
);

const staleQueueCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    ...validHostPayload,
    strategic_completion: {
      ...validHostPayload.strategic_completion,
      queue_revision: crossBlock.queue_revision - 1,
    },
  },
  { allowedCandidateIds: ["candidate-main", "candidate-backup"] },
);
assert.equal(staleQueueCoverage.ok, false);
assert(staleQueueCoverage.errors.some((entry) => entry.code === "strategic_completion_queue_revision_mismatch"));
assert.equal(
  strategicObligationResponseIsComplete(
    crossBlock,
    {
      ...validHostPayload,
      strategic_completion: {
        ...validHostPayload.strategic_completion,
        queue_revision: crossBlock.queue_revision - 1,
      },
    },
    ["candidate-main", "candidate-backup"],
  ),
  false,
  "the public completeness export must reject a stale queue revision",
);

const staleReceiptCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    ...validHostPayload,
    strategic_completion: {
      ...validHostPayload.strategic_completion,
      completion_receipts: crossBlock.completion_receipts.map((receipt, index) => (
        index === 0 ? { ...receipt, revision: receipt.revision - 1 } : receipt
      )),
    },
  },
  { allowedCandidateIds: ["candidate-main", "candidate-backup"] },
);
assert.equal(staleReceiptCoverage.ok, false);
assert(staleReceiptCoverage.errors.some((entry) => entry.code === "strategic_completion_receipt_mismatch"));

const missingReceiptCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    ...validHostPayload,
    strategic_completion: {
      ...validHostPayload.strategic_completion,
      completion_receipts: crossBlock.completion_receipts.slice(0, 1),
    },
  },
  { allowedCandidateIds: ["candidate-main", "candidate-backup"] },
);
assert.equal(missingReceiptCoverage.ok, false);
assert(missingReceiptCoverage.errors.some((entry) => entry.code === "strategic_completion_receipt_missing"));

const unexpectedReceiptCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    ...validHostPayload,
    strategic_completion: {
      ...validHostPayload.strategic_completion,
      completion_receipts: [
        ...crossBlock.completion_receipts,
        { block_id: "unexpected_block", revision: 1, latest_checkpoint_id: "unexpected_checkpoint" },
      ],
    },
  },
  { allowedCandidateIds: ["candidate-main", "candidate-backup"] },
);
assert.equal(unexpectedReceiptCoverage.ok, false);
assert(unexpectedReceiptCoverage.errors.some((entry) => entry.code === "strategic_completion_receipt_unexpected"));

const incompleteDecisionCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    ...validHostPayload,
    strategic_completion: {
      ...validHostPayload.strategic_completion,
      covered_required_decisions: requiredDecisionsCovered.filter((decision) => decision !== "three_cost_carry_three_star_target_check"),
    },
  },
  { allowedCandidateIds: ["candidate-main", "candidate-backup"] },
);
assert.equal(incompleteDecisionCoverage.ok, false);
assert.deepEqual(incompleteDecisionCoverage.missing_required_decisions, ["three_cost_carry_three_star_target_check"]);

const aliasDecisionCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    strategic_completion: {
      ...validHostPayload.strategic_completion,
      covered_required_decisions: Object.fromEntries(
        requiredDecisionsCovered
          .filter((decision) => decision !== "complete_candidate_rosters_and_roles")
          .map((decision) => [decision, true]),
      ),
    },
    strategy_selection: {
      selected_candidates: [allowedCandidates[0]],
    },
    final_text: "主线主C、主线主坦、主线功能位。",
  },
  { allowedCandidateIds: ["candidate-main"], allowedCandidates: [allowedCandidates[0]] },
);
assert.equal(aliasDecisionCoverage.ok, true, JSON.stringify(aliasDecisionCoverage.errors));

const missingSelectionCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    strategic_completion: validHostPayload.strategic_completion,
    strategy_selection: {},
  },
  { allowedCandidateIds: ["candidate-main"] },
);
assert.equal(missingSelectionCoverage.ok, false);
assert(missingSelectionCoverage.errors.some((entry) => entry.code === "strategy_selection_candidate_ids_missing"));

const unavailableCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    strategic_completion: validHostPayload.strategic_completion,
    strategy_selection: {
      status: "unavailable",
      unavailable_reason: "The supplied working set contains no complete legal roster.",
    },
  },
);
assert.equal(unavailableCoverage.ok, true, JSON.stringify(unavailableCoverage.errors));

const unavailableDespiteCandidates = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    final_text: "当前不可用。",
    strategic_completion: validHostPayload.strategic_completion,
    strategy_selection: {
      status: "unavailable",
      unavailable_reason: "Host claims no candidate is available.",
    },
  },
  { allowedCandidates: [allowedCandidates[0]] },
);
assert.equal(unavailableDespiteCandidates.ok, false);
assert(unavailableDespiteCandidates.errors.some((entry) => entry.code === "strategy_selection_unavailable_with_complete_candidates"));

const selfReportedOnlyCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    final_text: "继续保持灵活。",
    strategic_completion: validHostPayload.strategic_completion,
    strategy_selection: {
      selected_candidate_ids: ["candidate-main"],
      candidate_presentations: [allowedCandidates[0]],
    },
  },
  { allowedCandidates: [allowedCandidates[0]] },
);
assert.equal(selfReportedOnlyCoverage.ok, false);
assert(selfReportedOnlyCoverage.errors.some((entry) => entry.code === "strategy_selection_roster_missing_from_final_text"));

const tooNarrowExplorationCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    final_text: "主线主C、主线主坦、主线功能位。",
    strategic_completion: validHostPayload.strategic_completion,
    strategy_selection: {
      selected_candidate_ids: ["candidate-main"],
      candidate_presentations: [allowedCandidates[0]],
    },
  },
  { allowedCandidates },
);
assert.equal(tooNarrowExplorationCoverage.ok, false);
assert(tooNarrowExplorationCoverage.errors.some((entry) => entry.code === "strategy_selection_candidate_count_below_checkpoint_minimum"));

const wrongVariantCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    ...validHostPayload,
    strategy_selection: {
      selected_candidate_ids: ["candidate-main"],
      candidate_presentations: [{ ...allowedCandidates[0], selected_variant_id: "candidate-main-wrong" }],
    },
    final_text: "主线主C、主线主坦、主线功能位。",
  },
  { allowedCandidates },
);
assert(wrongVariantCoverage.errors.some((entry) => entry.code === "strategy_selection_variant_id_mismatch"));

const wrongEvidenceIdentityCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    ...validHostPayload,
    strategy_selection: {
      selected_candidate_ids: ["candidate-main"],
      candidate_presentations: [{ ...allowedCandidates[0], candidate_evidence_id: "evidence-from-another-candidate" }],
    },
    final_text: "主线主C、主线主坦、主线功能位。",
  },
  { allowedCandidates },
);
assert(wrongEvidenceIdentityCoverage.errors.some((entry) => entry.code === "strategy_selection_candidate_evidence_id_mismatch"));

const foreignSemanticCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    ...validHostPayload,
    strategy_selection: {
      selected_candidate_ids: ["candidate-main"],
      candidate_presentations: [{
        ...allowedCandidates[0],
        main_carry: allowedCandidates[1].main_carry,
        primary_tank: allowedCandidates[1].primary_tank,
        core_traits: allowedCandidates[1].core_traits,
        equipment_plan: allowedCandidates[1].equipment_plan,
        cap: allowedCandidates[1].cap,
        floor: allowedCandidates[1].floor,
      }],
    },
    final_text: "主线主C、主线主坦、主线功能位。",
  },
  { allowedCandidates },
);
assert(foreignSemanticCoverage.errors.some((entry) => entry.code === "strategy_selection_canonical_variant_field_mismatch"));

const foreignVisibleRosterCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    ...validHostPayload,
    strategy_selection: {
      selected_candidate_ids: ["candidate-main"],
      candidate_presentations: [allowedCandidates[0]],
    },
    final_text: "主线主C、主线主坦、主线功能位，并上备用功能位。",
  },
  { allowedCandidates },
);
assert(foreignVisibleRosterCoverage.errors.some((entry) => entry.code === "strategy_selection_foreign_roster_member_in_final_text"));

const explicitlyExcludedForeignRosterCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    ...validHostPayload,
    strategy_selection: {
      selected_candidate_ids: ["candidate-main"],
      candidate_presentations: [allowedCandidates[0]],
    },
    final_text: "主线主C、主线主坦、主线功能位。暂不选备用功能位所在的另一套候选。",
  },
  { allowedCandidates },
);
assert(!explicitlyExcludedForeignRosterCoverage.errors.some((entry) => (
  entry.code === "strategy_selection_foreign_roster_member_in_final_text"
)));

const conditionallyExcludedForeignRosterCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    ...validHostPayload,
    strategy_selection: {
      selected_candidate_ids: ["candidate-main"],
      candidate_presentations: [allowedCandidates[0]],
    },
    final_text: `${validHostPayload.final_text} 第三方向暂不作为当前备选，除非第三主C和第三主坦的条件同时满足。`,
  },
  { allowedCandidates },
);
assert(!conditionallyExcludedForeignRosterCoverage.errors.some((entry) => (
  entry.code === "strategy_selection_foreign_roster_member_in_final_text"
)), "an explicitly excluded conditional branch must not trigger a false cross-lineup correction");
const comparisonOnlyForeignRosterCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    ...validHostPayload,
    strategy_selection: {
      selected_candidate_ids: ["candidate-main"],
      candidate_presentations: [allowedCandidates[0]],
    },
    final_text: "主线主C、主线主坦、主线功能位。备用候选暂不列入前二：备用主C、备用主坦仅作比较。",
  },
  { allowedCandidates },
);
assert(!comparisonOnlyForeignRosterCoverage.errors.some((entry) => (
  entry.code === "strategy_selection_foreign_roster_member_in_final_text"
)), "an explicitly excluded comparison candidate must not trigger a semantic correction turn");
const unrelatedChoiceVerbCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    ...validHostPayload,
    strategy_selection: {
      selected_candidate_ids: ["candidate-main"],
      candidate_presentations: [allowedCandidates[0]],
    },
    final_text: "已确认选择当前强化。另一套候选仍是备用主C、备用主坦的独立阵容，仅用于说明转向条件。",
  },
  { allowedCandidates },
);
assert(!unrelatedChoiceVerbCoverage.errors.some((entry) => (
  entry.code === "strategy_selection_foreign_roster_member_in_final_text"
)), "an unrelated choice verb in the same sentence must not be attached to a foreign roster member");

const recipeVariantLeakCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    ...validHostPayload,
    strategy_selection: {
      selected_candidate_ids: ["candidate-main", "candidate-backup", "candidate-third"],
      candidate_presentations: allowedCandidates,
    },
    strategic_completion: {
      ...validHostPayload.strategic_completion,
      decision_outputs: {
        ...decisionOutputs,
        complete_candidate_rosters: "把主线变种棋子换上场",
      },
    },
  },
  { allowedCandidates },
);
assert(recipeVariantLeakCoverage.errors.some((entry) => (
  entry.code === "strategy_selection_unselected_recipe_variant_member_in_decision_output"
)));

const labeledRecipeVariantCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    ...validHostPayload,
    final_text: `${validHostPayload.final_text} 另有热门变种：用主线变种棋子替换标准成员，这是另一套完整配方。`,
  },
  { allowedCandidates },
);
assert(!labeledRecipeVariantCoverage.errors.some((entry) => (
  entry.code === "strategy_selection_recipe_variant_member_unlabeled_in_final_text"
)));

// Neutral names must not themselves satisfy the variant-label detector.
const semanticCandidates = [presentation("semantic-main", "甲"), presentation("semantic-other", "乙"),
  presentation("semantic-third", "丙"), presentation("semantic-fourth", "丁")];
semanticCandidates[0].transition_path = [{ lineup_names: ["乙主C"], main_carry: { champion_name: "乙主C" } }];
semanticCandidates[0].mature_recipe_variants = [{ added_by_recipe_names: ["乙主C", "测试棋子甲"] }];
semanticCandidates[0].mature_recipe_variants.push({ added_by_recipe_names: ["测试棋子乙"] });
semanticCandidates[2].mature_recipe_variants = [{ added_by_recipe_names: ["测试棋子丙"] }];
const rejectedRetentionCandidates = structuredClone(semanticCandidates);
rejectedRetentionCandidates[1].unit_names = ["婕拉", "韦鲁斯", "乙功能位"];
const rejectedRetentionText = "目标只锁这一套地狱火艾希，不再同时保留裁决婕拉或日蚀韦鲁斯作为同等主线。";
const semanticTextCodes = new Set([
  "strategy_selection_foreign_roster_member_in_final_text",
  "strategy_selection_unselected_recipe_variant_member_in_decision_output",
  "strategy_selection_recipe_variant_member_unlabeled_in_final_text",
]);
const semanticCases = [
  ["captured 4-3 negated alternatives verbatim", rejectedRetentionText, true, rejectedRetentionCandidates],
  ["captured sentence then final promotion", `${rejectedRetentionText}把婕拉加入最终阵容。`, false, rejectedRetentionCandidates],
  ["captured second object then final promotion", `${rejectedRetentionText}把韦鲁斯加入最终阵容。`, false, rejectedRetentionCandidates],
  ["negated retention of parallel alternatives", "目标只锁甲主C，不再同时保留测试棋子甲或测试棋子乙作为同等主线。", true],
  ["negated retention with named prefixes", "不再同时保留路线测试棋子甲或另一线测试棋子乙作为同等主线。", true],
  ["coordinator followed by new directive", "不保留乙主坦或改为让乙主C作为最终主C。", false],
  ["coordinated objects share retention negation", "不保留乙主坦或乙主C作为最终主C。", true],
  ["coordinator followed by causative", "不保留乙主坦或让乙主C作为最终主C。", false],
  ["negative list then affirmative promotion", "不再同时保留测试棋子甲或测试棋子乙作为同等主线，但把测试棋子乙加入最终阵容。", false],
  ["negative list then repeated member promotion", "不再同时保留测试棋子甲或测试棋子乙也要把测试棋子乙加入最终阵容。", false],
  ["negative retention then same mention promotion", "不再保留测试棋子甲作为备用而要加入最终阵容。", false],
  ["affirmative parallel retention", "同时保留测试棋子甲或测试棋子乙作为同等主线。", false],
  ["live recipe prose", "成熟配方差异只当命名替代，不能并入标准阵容：主线有单独成熟变种会用测试棋子甲替换甲主C，或用测试棋子丙作为另一个成熟变种成员。", true],
  ["sourced temporary holder", "2阶段装备给乙主C打工，甲主C到位后卖掉乙主C并转交装备，最终阵容不变。", true],
  ["sourced exit", "卖掉乙主C回到利息档，最终阵容不变。", true],
  ["independent overlapping recipe", "独立热门配方：换上乙主C替代甲主C，这是另一套完整阵容，标准阵容不变。", true],
  ["independent variant wording", "独立变体建议：测试棋子甲替换甲功能位，标准阵容不变。", true],
  ["temporary then variant", "乙主C仅在2阶段打工，甲主C到位后卖掉乙主C。独立变体建议：乙主C替换甲主C，标准阵容不变。", true],
  ["member-scoped negation", "不把乙主C加入最终阵容。", true],
  ["silent final promotion", "把乙主C加入选定的最终阵容。", false],
  ["temporary cannot authorize final", "2阶段先用乙主C打工，最终阵容也加入乙主C。", false],
  ["another member's negation", "不选乙主坦，但把乙主C加入最终阵容。", false],
  ["later action after label", "独立热门配方：乙主C替换甲主C，标准阵容不变。现在装备给乙主C，作为选定标准阵容的最终主C。", false],
  ["same sentence promotion", "独立热门配方：乙主C替换甲主C，但把乙主C加入选定标准阵容。", false],
  ["unsupported temporary member", "2阶段装备给乙功能位打工，甲主C到位后卖掉乙功能位。", false],
  ["unverified alternative is not a roster write", "独立变体建议：换上乙功能位替代甲功能位，标准阵容不变。", true],
  ["neutral unlabeled recipe", "把测试棋子甲换上场。", false],
  ["comparison cannot excuse later action", "乙主C仅作比较，但把乙主C加入最终阵容。", false],
  ["same member negation then action", "不选乙主C然后把乙主C加入最终阵容。", false],
  ["temporary then final role", "乙主C先打工，乙主C是最终主C。", false],
  ["final target after member", "乙主C先打工，随后把乙主C加入最终阵容。", false],
  ["no punctuation final promotion", "乙主C临时持装并加入最终阵容。", false],
  ["negation followed by second action", "不选乙主C而是把乙主C加入最终阵容。", false],
  ["negated action after member", "乙主C不要加入最终阵容。", true],
  ["two independent source recipes", "semantic-main独立变体：测试棋子甲替换甲功能位。semantic-third独立变体：测试棋子丙替换丙功能位。", true],
  ["wrong recipe owner", "semantic-main独立变体：测试棋子丙替换甲功能位。", true],
  ["mixed recipe owners", "独立变体：测试棋子甲和测试棋子丙一起上场。", true],
  ["same sentence independent recipes", "semantic-main独立变体：测试棋子甲替换甲功能位，semantic-third独立变体：测试棋子丙替换丙功能位。", true],
  ["second affirmative action", "不选乙主C仍把乙主C加入最终阵容。", false],
  ["same owner different recipes", "semantic-main独立变体：测试棋子甲和测试棋子乙一起上场。", true],
  ["separate recipes same owner", "semantic-main独立变体：测试棋子甲替换甲功能位，semantic-main独立变体：测试棋子乙替换甲功能位。", true],
  ["final target names another member", "乙主C临时持装，乙主C加入甲主C的最终阵容。", false],
  ["possessive independent label", "semantic-main的独立变体：测试棋子甲替换甲主C，标准阵容不变。", true],
  ["markdown independent label", "**独立变体建议**：测试棋子甲替换甲主C，标准阵容不变。", true],
  ["markdown possessive label", "**semantic-main的独立变体**：测试棋子甲替换甲主C，标准阵容不变。", true],
  ["formatted label cannot authorize promotion", "**semantic-main的独立变体**：测试棋子甲加入甲主C的最终阵容。", false],
  ["enumerated separate substitutions", "成熟配方差异：semantic-main的成熟配方存在甲主C换测试棋子甲、甲功能位换测试棋子乙等独立变种，均不并入标准阵容。", true],
  ["enumerated alternative is not a final roster write", "独立变体：测试棋子甲、测试棋子乙一起上场。", true],
  ["substitution discussion is not a final roster write", "成熟配方差异：甲主C换测试棋子甲、甲功能位换测试棋子乙等独立变种一起上场。", true],
  ["recipe list explicitly promoted", "成熟配方差异只作讨论。把测试棋子甲、测试棋子乙一起加入选定最终阵容。", false],
  ["negated variant cannot authorize action", "这不是变体，把测试棋子甲换上场。", false],
  ["negated recipe cannot authorize action", "这不是配方，把测试棋子甲换上场。", false],
  ["final roster heading binds list", "选定最终阵容：测试棋子甲。", false],
  ["final heading overrides variant context", "独立变体仅作讨论，选定最终阵容：测试棋子甲、测试棋子乙。", false],
  ["alternative heading remains descriptive", "单独成熟变种：测试棋子甲、测试棋子乙，不并入主线。", true],
  ["final membership assertion", "成熟变种仅供比较，但测试棋子甲就是我们最终阵容的一员。", false],
  ["final target assertion without action vocabulary", "独立变体只作讨论，最终阵容增加测试棋子甲。", false],
  ["standard execution membership", "独立变体仅供比较，执行方案：将测试棋子甲编入标准阵容。", false],
  ["multiline final roster list", "成熟变种仅供比较。选定最终阵容：\n测试棋子甲。", false],
  ["same member contrasting actions", "不把测试棋子甲加入最终阵容而把测试棋子甲保留在最终阵容。", false],
  ["negative final membership", "测试棋子甲不是最终阵容的成员，只属于单独成熟变种。", true],
  ["negative final insertion", "不要把测试棋子甲编入标准阵容。", true],
  ["multiline alternative description", "单独成熟变种：\n测试棋子甲、测试棋子乙，不并入标准阵容。", true],
  ["excluded from final roster", "最终阵容不包含测试棋子甲。", true],
  ["alternative rather than standard membership", "测试棋子甲仅用于独立变体而非标准阵容。", true],
  ["temporary not final carry", "乙主C只是临时持装而不是最终主C。", true],
  ["final roster list spans multiple lines", "选定最终阵容：\n甲主C\n测试棋子甲。", false],
  ["emphasized final roster heading", "**选定最终阵容：**\n测试棋子甲。", false],
  ["same member later affirmative obligation", "不选测试棋子甲也要把测试棋子甲加入最终阵容。", false],
  ["markdown roster bullets continue heading", "## **选定最终阵容：**\n- 甲主C\n- 测试棋子甲。", false],
  ["new heading ends roster list", "选定最终阵容：\n甲主C\n## 独立变体：\n测试棋子甲。", true],
  ["new sentence ends roster list", "选定最终阵容：\n甲主C。\n测试棋子甲仅用于独立变体。", true],
  ["prose ends roster list", "选定最终阵容：\n甲主C\n以下只讨论独立变体\n测试棋子甲。", true],
  ["negative target cannot excuse later same member", "测试棋子甲仅用于独立变体而非标准阵容也要把测试棋子甲加入最终阵容。", false],
  ["temporary negative target cannot excuse later promotion", "乙主C只是临时持装而不是最终主C也要把乙主C加入最终阵容。", false],
];
const semanticFailures = [];
for (const [label, text, expected, candidates = semanticCandidates] of semanticCases) {
  for (const decisionKey of [null, "target_execution_path", "target_pivot_condition", "variant_comparison"]) {
    const payload = assembleStrategicObligationResponsePayload(crossBlock, {
      ...validHostPayload,
      final_text: `甲主C、甲主坦、甲功能位；丙主C、丙主坦、丙功能位；丁主C、丁主坦、丁功能位。${text}`,
      strategy_selection: { selected_candidate_ids: ["semantic-main", "semantic-third", "semantic-fourth"] },
      strategic_completion: {
        ...validHostPayload.strategic_completion,
        decision_outputs: { ...decisionOutputs, ...(decisionKey ? { [decisionKey]: text } : {}) },
      },
    }, { allowedCandidates: candidates });
    const result = diagnoseStrategicObligationResponseCoverage(crossBlock, payload, { allowedCandidates: candidates });
    const errors = result.errors.filter((entry) => semanticTextCodes.has(entry.code));
    if ((errors.length === 0) !== expected) semanticFailures.push({ label, decisionKey, errors });
    if (expected) assert.equal(result.errors.filter((entry) => !semanticTextCodes.has(entry.code)).length, 0,
      `${label}: fixture must satisfy unrelated hard validation: ${JSON.stringify(result.errors)}`);
  }
}
assert.deepEqual(semanticFailures, [], "member-scoped text validation must preserve transitions and independent variants without allowing final-roster promotion");
// Optional local replay keeps the captured requests out of committed fixtures.
if (process.env.JCC_QUEUE_REPLAY_FILE) {
  const captures = JSON.parse(readFileSync(process.env.JCC_QUEUE_REPLAY_FILE, "utf8"));
  for (const [index, { request, response }] of captures.entries()) {
    const envelope = request.runtime_context.strategic_obligation
      || request.runtime_event_context?.strategic_obligation
      || request.runtime_context.strategy_fit_packet?.strategic_obligation;
    const candidates = request.runtime_context.strategy_fit_packet.candidate_working_set;
    const payload = assembleStrategicObligationResponsePayload(envelope, response, { allowedCandidates: candidates });
    // Model the Runtime-owned roster appendix, leaving Host prose untouched.
    payload.final_text += `\n${payload.runtime_materialization.candidate_presentations.flatMap((candidate) => candidate.unit_names).join("、")}`;
    const result = diagnoseStrategicObligationResponseCoverage(envelope, payload, { allowedCandidates: candidates });
    assert.equal(result.ok, true, `captured response ${index}: ${JSON.stringify(result.errors)}`);
  }
  console.log(JSON.stringify({ replayed_responses: captures.length, ok: true }));
}
const outputOnlyPromotion = assembleStrategicObligationResponsePayload(crossBlock, {
  ...validHostPayload,
  final_text: "甲主C、甲主坦、甲功能位；丙主C、丙主坦、丙功能位；丁主C、丁主坦、丁功能位。",
  strategy_selection: { selected_candidate_ids: ["semantic-main", "semantic-third", "semantic-fourth"] },
  strategic_completion: { ...validHostPayload.strategic_completion,
    decision_outputs: { ...decisionOutputs, target_execution_path: "把乙功能位加入最终阵容。" } },
}, { allowedCandidates: semanticCandidates });
assert(diagnoseStrategicObligationResponseCoverage(crossBlock, outputOnlyPromotion, { allowedCandidates: semanticCandidates })
  .errors.some((entry) => semanticTextCodes.has(entry.code)), "decision-only foreign promotion must not bypass the body check");
const canonicalTransitionCandidates = structuredClone(semanticCandidates);
const productionTransition = [{ lineup_names: ["乙主C"], lineup_ids: ["carry-id"],
  population: 4, main_carry: { champion_name: "乙主C" } }];
delete canonicalTransitionCandidates[0].transition_path;
canonicalTransitionCandidates[0].canonical_variant = { transition_chain: productionTransition };
const normalizedTransitionPayload = assembleStrategicObligationResponsePayload(crossBlock, {
  ...outputOnlyPromotion,
  final_text: `${outputOnlyPromotion.final_text}2阶段装备给乙主C打工，甲主C到位后卖掉乙主C。`,
  strategic_completion: { ...validHostPayload.strategic_completion, decision_outputs: decisionOutputs },
}, { allowedCandidates: canonicalTransitionCandidates });
assert.deepEqual(normalizedTransitionPayload.runtime_materialization.candidate_presentations[0].transition_path,
  productionTransition, "production canonical_variant.transition_chain must survive normalization structurally");
assert.equal(diagnoseStrategicObligationResponseCoverage(crossBlock, normalizedTransitionPayload,
  { allowedCandidates: canonicalTransitionCandidates }).ok, true, "normalized production transitions authorize only the sourced temporary member");

const principlePayload = assembleStrategicObligationResponsePayload(crossBlock, {
  ...validHostPayload,
  runtime_materialization: { position_evidence: [{ status: "provided" }] },
  final_text: `${validHostPayload.final_text} 站位证据为空，不能固定格子；主坦前排承伤，主C后排安全输出。过渡单位在目标人口替换为完整目标单位。`,
}, { allowedCandidates });
assert(principlePayload.runtime_materialization.position_evidence.every((entry) => entry.status === "unknown" && entry.positioning_template === null));
const suppliedPositions = allowedCandidates.map((candidate) => ({ ...candidate,
  positioning_template: { self_board_only: true, coordinates: [{ champion_name: candidate.main_carry, row: 4, col: 7 }] },
}));
const sourcePositionPayload = assembleStrategicObligationResponsePayload(crossBlock, validHostPayload, { allowedCandidates: suppliedPositions });
assert(sourcePositionPayload.runtime_materialization.position_evidence.every((entry) => entry.status === "provided"));
assert.deepEqual(sourcePositionPayload.runtime_materialization.candidate_presentations[0].positioning_template,
  suppliedPositions[0].positioning_template, "source positions must survive normalization without invented coordinates");
const mixedPositionSources = [suppliedPositions[0], ...allowedCandidates.slice(1)];
const mixedPositionPayload = assembleStrategicObligationResponsePayload(crossBlock, {
  ...validHostPayload,
  strategy_selection: { ...validHostPayload.strategy_selection, candidate_presentations: mixedPositionSources },
}, { allowedCandidates: mixedPositionSources });
assert.equal(diagnoseStrategicObligationResponseCoverage(crossBlock, mixedPositionPayload, { allowedCandidates: mixedPositionSources }).ok, true,
  "one unknown candidate must not invalidate another candidate's sourced positions");
const mismatchedPositionPayload = assembleStrategicObligationResponsePayload(crossBlock, {
  ...validHostPayload,
  strategy_selection: { ...validHostPayload.strategy_selection, candidate_presentations: [{
    ...suppliedPositions[0], positioning_template: { coordinates: [{ row: 1, col: 1 }] },
  }] },
}, { allowedCandidates: suppliedPositions });
assert(mismatchedPositionPayload.runtime_materialization.selection_resolution_errors.some((entry) => entry.code === "strategy_selection_position_evidence_missing"),
  "assembler must not silently discard a source-mismatched structured template");
assert.equal(diagnoseStrategicObligationResponseCoverage(crossBlock, principlePayload, { allowedCandidates }).ok, true);
assert(diagnoseStrategicObligationResponseCoverage(crossBlock, {
  ...principlePayload,
  strategy_selection: { ...principlePayload.strategy_selection,
    candidate_presentations: [{ ...allowedCandidates[0], row: 4, col: 7 }] },
}, { allowedCandidates }).errors.some((entry) => entry.code === "strategy_selection_position_evidence_missing"));

const missingDecisionOutputCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    ...validHostPayload,
    strategic_completion: {
      ...validHostPayload.strategic_completion,
      decision_outputs: Object.fromEntries(
        Object.entries(decisionOutputs)
          .filter(([decision]) => decision !== "three_cost_carry_three_star_target_check"),
      ),
    },
  },
  { allowedCandidates },
);
assert.equal(missingDecisionOutputCoverage.ok, false);
assert(missingDecisionOutputCoverage.errors.some((entry) => entry.code === "strategic_completion_required_decision_outputs_missing"));

const unavailableWithoutReasonCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    strategic_completion: validHostPayload.strategic_completion,
    strategy_selection: { unavailable: true },
  },
);
assert.equal(unavailableWithoutReasonCoverage.ok, false);
assert(unavailableWithoutReasonCoverage.errors.some((entry) => entry.code === "strategy_selection_unavailable_reason_missing"));

const conflictingUnavailableCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    strategic_completion: validHostPayload.strategic_completion,
    strategy_selection: {
      unavailable: true,
      unavailable_reason: "No complete roster is available.",
      selected_candidate_ids: ["candidate-main"],
    },
  },
  { allowedCandidateIds: ["candidate-main"] },
);
assert.equal(conflictingUnavailableCoverage.ok, false);
assert(conflictingUnavailableCoverage.errors.some((entry) => entry.code === "strategy_selection_conflicting_availability"));

const disallowedSelectionCoverage = diagnoseStrategicObligationResponseCoverage(
  crossBlock,
  {
    strategic_completion: validHostPayload.strategic_completion,
    strategy_selection: { selected_candidate_ids: ["candidate-main", "candidate-outside"] },
  },
  { allowedCandidateIds: ["candidate-main", "candidate-backup"] },
);
assert.equal(disallowedSelectionCoverage.ok, false);
assert.deepEqual(disallowedSelectionCoverage.disallowed_candidate_ids, ["candidate-outside"]);
assert(disallowedSelectionCoverage.errors.some((entry) => entry.code === "strategy_selection_candidate_id_not_allowed"));

let monotonicQueue = createStrategicObligationQueueState();
monotonicQueue = enqueueStrategicObligation(monotonicQueue, event("4-3", "final_lineup_confirmation"));
const committedRevision = monotonicQueue.obligations_by_block.lineup_direction_commitment.revision;
monotonicQueue = enqueueStrategicObligation(monotonicQueue, event("3-3", "post_3_2_narrowing"));
const monotonicDirection = monotonicQueue.obligations_by_block.lineup_direction_commitment;
assert.equal(monotonicDirection.latest_checkpoint_id, "final_lineup_confirmation", "a late older checkpoint must not downgrade the latest obligation");
assert(monotonicDirection.required_checkpoint_ids.includes("post_3_2_narrowing"), "the late checkpoint contract must still be merged into the current obligation");
assert(monotonicDirection.required_decisions.includes("complete_candidate_rosters_and_roles"), "late full-roster requirements must survive as supporting obligations");
assert(monotonicDirection.revision > committedRevision, "adding a late missing contract must invalidate in-flight stale receipts");
const monotonicRevision = monotonicDirection.revision;
monotonicQueue = enqueueStrategicObligation(monotonicQueue, event("3-3", "post_3_2_narrowing"));
assert.equal(monotonicQueue.obligations_by_block.lineup_direction_commitment.revision, monotonicRevision, "repeated late checkpoints must be idempotent");

let capQueue = createStrategicObligationQueueState();
capQueue = enqueueStrategicObligation(capQueue, event("5-7", "late_ceiling_refresh", "cap_gap_check"));
capQueue = enqueueStrategicObligation(capQueue, event("5-3", "second_ceiling_floor_review", "cap_gap_check"));
assert.equal(capQueue.obligations_by_block.cap_floor_endgame.latest_checkpoint_id, "late_ceiling_refresh", "late cap evidence must not move the endgame obligation backward");

const queueAfterNewerDirection = enqueueStrategicObligation(crossBlockQueue, event("4-3", "final_lineup_confirmation"));
const staleCompositeCompletion = completeStrategicObligationReceipts(
  queueAfterNewerDirection,
  crossBlock.completion_receipts,
);
assert(staleCompositeCompletion.obligations_by_block.lineup_direction_commitment,
  "a composite response must not close a direction block that advanced while the answer was running");
assert(!staleCompositeCompletion.obligations_by_block.formation_readiness_and_execution,
  "the unchanged formation block delivered by the composite answer should close exactly");

let partialQueue = createStrategicObligationQueueState();
partialQueue = enqueueStrategicObligation(partialQueue, event("2-2", "direction_exploration"));
const stageTwoEnvelope = strategicObligationDeliveryEnvelope(partialQueue);
const partialHostPayload = {
  ...validHostPayload,
  strategic_completion: {
    ...validHostPayload.strategic_completion,
    queue_revision: stageTwoEnvelope.queue_revision,
    completion_receipts: stageTwoEnvelope.completion_receipts,
    covered_required_decisions: stageTwoEnvelope.required_decisions,
    decision_outputs: Object.fromEntries(stageTwoEnvelope.required_decisions.map((decision) => [decision, `partial output for ${decision}`])),
  },
  strategy_selection: {
    selected_candidate_ids: ["candidate-main", "candidate-backup"],
    candidate_presentations: [allowedCandidates[0]],
  },
  final_text: "主线主C、主线主坦、主线功能位。",
};
const partialCoverage = diagnoseStrategicObligationResponseCoverage(
  stageTwoEnvelope,
  partialHostPayload,
  { allowedCandidates },
);
assert.equal(partialCoverage.ok, false);
assert.deepEqual(partialCoverage.partial_completion.accepted_candidate_ids, ["candidate-main"]);
assert.deepEqual(partialCoverage.partial_completion.pending_candidate_ids, ["candidate-backup"]);
assert.equal(partialCoverage.partial_completion.required_additional_candidate_count, 1);
partialQueue = recordStrategicObligationPartialCompletion(partialQueue, stageTwoEnvelope, partialCoverage);
const partialDirection = partialQueue.obligations_by_block.lineup_direction_commitment;
assert.deepEqual(partialDirection.partial_completion.accepted_candidate_ids, ["candidate-main"]);
assert.deepEqual(partialDirection.pending_candidate_ids, ["candidate-backup"]);
assert(partialDirection.required_decisions.includes("complete_candidate_rosters"),
  "full-roster completion must remain pending while one selected candidate is incomplete");

const recoveryQueue = enqueueStrategicObligation(partialQueue, {
  ...event("2-5", "direction_exploration"),
  source: "persistent_strategic_obligation_queue:catchup",
});
assert.equal(
  recoveryQueue.obligations_by_block.lineup_direction_commitment.revision,
  partialQueue.obligations_by_block.lineup_direction_commitment.revision,
  "2-5 recovery must not create a new checkpoint revision or Host owner",
);
partialQueue = recoveryQueue;
const catchupEnvelope = strategicObligationDeliveryEnvelope(partialQueue);
assert.deepEqual(catchupEnvelope.partial_completion.accepted_candidate_ids, ["candidate-main"]);
assert.deepEqual(catchupEnvelope.pending_candidate_ids, ["candidate-backup"]);
assert(!catchupEnvelope.pending_candidate_ids.includes("candidate-main"),
  "catch-up must not request an already accepted candidate again");
const catchupPayload = {
  strategic_completion: {
    queue_revision: catchupEnvelope.queue_revision,
    completion_receipts: catchupEnvelope.completion_receipts,
    covered_required_decisions: catchupEnvelope.required_decisions,
    decision_outputs: Object.fromEntries(catchupEnvelope.required_decisions.map((decision) => [decision, `catchup output for ${decision}`])),
  },
  strategy_selection: {
    selected_candidate_ids: ["candidate-backup", "candidate-third"],
    candidate_presentations: [allowedCandidates[1], allowedCandidates[2]],
  },
  final_text: "备用主C、备用主坦、备用功能位；第三主C、第三主坦、第三功能位。",
};
const catchupCoverage = diagnoseStrategicObligationResponseCoverage(
  catchupEnvelope,
  catchupPayload,
  { allowedCandidates },
);
assert.equal(catchupCoverage.ok, true, JSON.stringify(catchupCoverage.errors));
partialQueue = completeStrategicObligationDelivery(partialQueue, catchupEnvelope);
const remainingDirection = partialQueue.obligations_by_block.lineup_direction_commitment;
assert.equal(remainingDirection, undefined,
  "after the recovered 2-2 envelope is delivered, 2-5 must leave no separate obligation behind");

queue = queueAfterNewerDirection;
const advancedFinal = selectPrimaryStrategicObligation(queue);

const staleCompletion = completeStrategicObligation(queue, {
  blockId: advancedFinal.block_id,
  revision: advancedFinal.revision - 1,
});
assert(staleCompletion.obligations_by_block[advancedFinal.block_id], "a stale task must not close a newer obligation");

let retargetedQueue = createStrategicObligationQueueState();
retargetedQueue = enqueueStrategicObligation(retargetedQueue, confirmedTargetEvent("4-3", "final_lineup_confirmation"));
const oldTargetEnvelope = strategicObligationDeliveryEnvelope(retargetedQueue);
const changedTarget = {
  ...confirmedTarget,
  candidate_id: "candidate-backup",
  selected_variant_id: "candidate-backup-variant",
  candidate_evidence_id: "evidence-candidate-backup",
  name: "备用阵容",
  text: "备用阵容",
};
retargetedQueue = enqueueStrategicObligation(retargetedQueue, {
  ...event("4-3", "final_lineup_confirmation"),
  target_plan: changedTarget,
  target_context_authority: "durable_target_plan",
});
const retargetedRevision = retargetedQueue.obligations_by_block.lineup_direction_commitment.revision;
retargetedQueue = completeStrategicObligationDelivery(retargetedQueue, oldTargetEnvelope);
assert.equal(
  retargetedQueue.obligations_by_block.lineup_direction_commitment.revision,
  retargetedRevision,
  "an old same-checkpoint response must not close or partially reconcile a newly confirmed target",
);
assert.equal(
  retargetedQueue.obligations_by_block.lineup_direction_commitment.target_plan.candidate_id,
  "candidate-backup",
  "the latest durable target must remain authoritative after a stale completion arrives",
);

queue = completeStrategicObligation(queue, { blockId: advancedFinal.block_id, revision: advancedFinal.revision });
assert.equal(selectPrimaryStrategicObligation(queue), null);

const receiptFenceQueue = enqueueStrategicObligation(createStrategicObligationQueueState(), event("3-3", "post_3_2_narrowing"));
const receiptFenceBefore = structuredClone(receiptFenceQueue);
completeStrategicObligation(receiptFenceQueue, { blockId: "lineup_direction_commitment" });
completeStrategicObligationReceipts(receiptFenceQueue, [{ block_id: "lineup_direction_commitment" }]);
completeStrategicObligationDelivery(receiptFenceQueue, {
  completion_receipts: [{ block_id: "lineup_direction_commitment", revision: 1, latest_checkpoint_id: "direction_exploration" }],
});
assert.deepEqual(receiptFenceQueue, receiptFenceBefore, "missing revision and wrong checkpoint receipts must fail closed");

console.log(JSON.stringify({ ok: true, schema: "jcc-strategic-obligation-queue-verification-v1" }, null, 2));
