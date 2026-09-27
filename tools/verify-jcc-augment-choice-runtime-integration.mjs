import assert from "node:assert/strict";
import {
  buildHostMatchFacts,
  buildStrategyFitPacket,
  normalizeHostCoachResponse,
  strategyFitWeightsForStage,
} from "../ui/electron/runtime-service.js";
import { resolveTargetContextAuthority } from "../ui/electron/target-context-resolver.js";

const durable = { name: "旧目标", updated_at: "2026-08-24T10:00:00.000Z" };
const replacement = { name: "新目标", at: "2026-08-24T10:01:00.000Z" };
const currentTurn = { name: "本轮明确目标" };

assert.equal(resolveTargetContextAuthority({ durableTargetPlan: durable }).authority, "durable_target_plan");
assert.equal(resolveTargetContextAuthority({
  durableTargetPlan: durable,
  replacementIntent: replacement,
}).authority, "current_turn_replacement");
assert.equal(resolveTargetContextAuthority({
  currentTurnInstruction: currentTurn,
  durableTargetPlan: durable,
  replacementIntent: replacement,
}).authority, "current_turn_instruction");
assert.equal(resolveTargetContextAuthority({
  provisionalIntent: { name: "看看这套" },
}).authority, "provisional_user_intent");

const replacementHostFacts = buildHostMatchFacts({
  target_plan: durable,
}, {
  effectiveTargetPlan: {
    ...replacement,
    authority: "current_turn_replacement",
    target_context_basis: "newer_explicit_replacement_for_current_answer",
  },
});
assert.equal(replacementHostFacts.target_context_authority, "current_turn_replacement");
assert.equal(replacementHostFacts.effective_target_context.name, "新目标");

const associatedAugment = { augment_id: "augment-a", augment_name: "测试强化A" };
const candidate = {
  id: "line-a",
  display_name: "测试阵容A",
  source: "selected_ranking_candidates",
  summary: {
    top4_rate: 0.62,
    top1_rate: 0.18,
    use_rate: 0.08,
    source_interpretation: "national_master_plus_strength_anchor",
  },
  strength_anchor: { source_role: "national_master_plus_strength_anchor" },
  strategy_profile: {
    strength_anchor: { source_role: "national_master_plus_strength_anchor" },
    main_carry: { champion_id: "carry-a", champion_name: "测试主C", cost: 4 },
    associated_augments: [associatedAugment, associatedAugment],
    variants: [
      {
        variant_id: "line-a-v1",
        atomic_roster_id: "line-a-v1-roster",
        candidate_evidence_id: "line-a-v1-evidence",
        roster_is_atomic: true,
        population: 2,
        atomic_roster_members: ["测试主C", "测试主坦"],
        lineup_ids: ["carry-a", "tank-a"],
        lineup_names: ["测试主C", "测试主坦"],
        main_carry: { champion_id: "carry-a", champion_name: "测试主C", cost: 4 },
        primary_tank: { champion_id: "tank-a", champion_name: "测试主坦", cost: 4 },
        associated_augments: [{ augment_id: "augment-selected", augment_name: "已选强化" }],
      },
      {
        variant_id: "line-a-v2",
        atomic_roster_id: "line-a-v2-roster",
        candidate_evidence_id: "line-a-v2-evidence",
        roster_is_atomic: true,
        population: 2,
        atomic_roster_members: ["测试副C", "测试副坦"],
        lineup_ids: ["carry-b", "tank-b"],
        lineup_names: ["测试副C", "测试副坦"],
        main_carry: { champion_id: "carry-b", champion_name: "测试副C", cost: 2 },
        primary_tank: { champion_id: "tank-b", champion_name: "测试副坦", cost: 2 },
        associated_augments: [associatedAugment, associatedAugment],
      },
    ],
  },
};

const liveStateSummary = {
  phase: { stage_round: "2-5" },
  economy: { hp: 82, gold: 34, level: 5, xp: { value: 4, to_next: 10 } },
  own_board: { units: [] },
  own_bench: { units: [] },
  shop: { units: [] },
};
const cruiseDecisionContext = {
  current_board_shop_bench: { board_units: [], bench_units: [], shop_units: [] },
  equipment: { effective_source_by_field: {}, effective_item_bench: [], effective_equipped_items: [] },
  economic_decision_context: null,
};
const selectedRankingCandidates = {
  candidates: [candidate],
  primary_query_terms: [],
};
const activeRulesBundle = { base_game_rules: { economy_management: {} } };

const packet = buildStrategyFitPacket({
  liveStateSummary,
  matchFacts: {
    target_plan: {
      candidate_id: "line-a",
      name: "测试阵容A",
      updated_at: "2026-08-24T10:00:00.000Z",
      status: "confirmed",
      authority: "durable_target_plan",
      source: "explicit_user_commitment",
    },
    choice_confirmations: [{ kind: "augment", selected: "已选强化", stage_round: "2-1" }],
  },
  dailyBigData: { available: true },
  selectedRankingCandidates,
  gameRuleContract: { stage_round: "2-5" },
  gameStateBrief: { stage_round: "2-5", unknown_final_choices: [] },
  cruiseDecisionContext,
  activeRulesBundle,
});

assert.equal(packet.inputs_summary.target_context_authority, "durable_target_plan");
assert.equal(packet.augment_choice_evidence.status, "available");
assert.equal(packet.augment_choice_evidence.candidate_coverage_by_augment_id["augment-a"], 0.5);
assert.equal(packet.augment_choice_evidence.policy.lineup_baseline_excludes_augment_fit, true);

const line = packet.candidate_working_set[0];
assert(line, `durable target must retain its complete atomic candidate: ${JSON.stringify({
  target_context: packet.inputs_summary?.target_context,
  candidate_working_set_count: packet.candidate_working_set_count,
  candidate_working_set_source_count: packet.candidate_working_set_source_count,
  candidate_lines: packet.candidate_lines,
})}`);
const weights = strategyFitWeightsForStage("2-5");
const expectedNonAugment = (
  line.meta_strength * weights.meta
  + line.current_board_fit * weights.board
  + line.item_fit * weights.item
  + line.tempo_fit * weights.tempo
) / (weights.meta + weights.board + weights.item + weights.tempo);
assert.ok(Math.abs(line.non_augment_fit_score - expectedNonAugment) < 0.002);
const augmentAVariant = line.augment_compatibility_variants.find((variant) => (
  variant.associated_augments.some((augment) => augment.augment_id === "augment-a")
));
assert(augmentAVariant);
assert.equal(
  packet.augment_choice_evidence.lineup_fit_by_augment_id["augment-a"],
  Number(augmentAVariant.non_augment_fit_score.toFixed(4)),
);

const augmentHostRequest = {
  mode: "augment_choice",
  structured_card_action: true,
  runtime_context: {
    current_match_user_report: {
      candidates: [{ name: "强化甲" }, { name: "强化乙" }, { name: "强化丙" }],
    },
    cruise_decision_context: {
      augment_choice_evaluation: {
        candidate_ranking: ["强化甲", "强化乙", "强化丙"],
        rows: [],
      },
    },
    match_facts: {
      latest_authoritative_facts: { economy: { hp: 18 } },
    },
  },
};
const changedOrderResponse = {
  schema: "jcc-host-cli-coach-response-v1",
  generated_by: "current_cli_agent_main_model",
  mode: "augment_choice",
  final_text: "当前血量要求优先保命。",
  choice_recommendation: {
    candidate_ranking: ["强化丙", "强化乙", "强化甲"],
    refresh_action: "keep_and_pick",
    selected_candidate: "强化丙",
    refresh_slots: [],
  },
};
const changedOrderWithoutAudit = normalizeHostCoachResponse(changedOrderResponse, augmentHostRequest);
assert.equal(changedOrderWithoutAudit.choice_recommendation.candidate_ranking[0], "强化丙");
assert.equal(changedOrderWithoutAudit.choice_recommendation.candidate_ranking[1], "强化乙");
const overridden = normalizeHostCoachResponse({
  ...changedOrderResponse,
  augment_evaluator_override_reason: {
    source: "typed_current_fact",
    fact_path: "match_facts.latest_authoritative_facts.economy.hp",
    reason: "评估器生成后确认当前仅剩 18 血，必须提高即时保血优先级。",
  },
}, augmentHostRequest);
assert.equal(overridden.choice_recommendation.candidate_ranking[0], "强化丙");
assert.equal(overridden.augment_evaluator_override_reason.source, "typed_current_fact");

const coreOnly = buildStrategyFitPacket({
  liveStateSummary,
  matchFacts: { choice_confirmations: [] },
  dailyBigData: { available: false },
  selectedRankingCandidates: { candidates: [] },
  gameRuleContract: { stage_round: "2-5" },
  gameStateBrief: { stage_round: "2-5", unknown_final_choices: [] },
  cruiseDecisionContext,
  activeRulesBundle,
});
assert.equal(coreOnly.augment_choice_evidence.status, "ranking_unavailable_core_only");
assert.deepEqual(coreOnly.augment_choice_evidence.lineup_fit_by_augment_id, {});

const coreOnlyWithExplicitCandidate = buildStrategyFitPacket({
  liveStateSummary,
  matchFacts: { choice_confirmations: [] },
  dailyBigData: { available: false },
  selectedRankingCandidates: {
    candidates: [{
      ...candidate,
      strength_anchor: undefined,
      strategy_profile: { ...candidate.strategy_profile, strength_anchor: undefined },
    }],
    primary_query_terms: [],
  },
  gameRuleContract: { stage_round: "2-5" },
  gameStateBrief: { stage_round: "2-5", unknown_final_choices: [] },
  cruiseDecisionContext,
  activeRulesBundle,
});
assert.equal(coreOnlyWithExplicitCandidate.augment_choice_evidence.status, "ranking_unavailable_core_only");
assert.deepEqual(coreOnlyWithExplicitCandidate.augment_choice_evidence.lineup_fit_by_augment_id, {});

console.log(JSON.stringify({
  status: "pass",
  target_authorities: [
    "current_turn_instruction",
    "current_turn_replacement",
    "durable_target_plan",
    "provisional_user_intent",
  ],
  non_augment_fit_score: line.non_augment_fit_score,
  combined_fit_score: line.combined_fit_score,
  duplicate_association_coverage: packet.augment_choice_evidence.candidate_coverage_by_augment_id["augment-a"],
  host_override_audit: overridden.augment_evaluator_override_reason,
  ranking_unavailable_status: coreOnly.augment_choice_evidence.status,
}, null, 2));
