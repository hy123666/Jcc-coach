import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  classifyMissingChoiceDependency,
  buildStrategyFitPacket,
  enforceHostTurnDeltaBudget,
  compactStrategyFitPacketForTurn,
  compactSelectedRankingCandidatesForTurn,
  evaluateAtomicStrategyVariant,
  sortStrategyFitCandidateLines,
  normalizeHostCoachResponse,
  strategyFitWeightsForStage,
  summarizeHostRequest,
  targetPlanIdentityValues,
} from "../ui/electron/runtime-service.js";
import { assessLineupCandidateStageReadiness } from "./build-jcc-lineup-lifecycle-context.mjs";
import { normalizeRequiredChoiceRecommendation } from "./run-jcc-host-coach-response.mjs";

const scorerContract = JSON.parse(await readFile(new URL("../data/runtime/jcc/cruise-strategy-scorer-contract.json", import.meta.url), "utf8"));
assert.match(scorerContract?.context_weighting?.target_plan?.use || "", /Shop facts are unowned immediate opportunities only/);
assert.match(scorerContract?.context_weighting?.target_plan?.use || "", /never increase lineup score or commitment until purchased/);

const augmentCandidates = ["强化甲", "强化乙", "强化丙"];
assert.equal(normalizeRequiredChoiceRecommendation({
  candidate_ranking: ["强化甲", "强化乙", "强化丙", "强化丁"],
  refresh_action: "keep_and_pick",
  selected_candidate: "强化甲",
}, augmentCandidates), null, "augment response validation must reject four raw ranking entries instead of silently truncating to three");
assert.deepEqual(normalizeRequiredChoiceRecommendation({
  candidate_ranking: ["强化乙", "强化甲", "强化丙"],
  refresh_action: "refresh_specific",
  refresh_slots: [1, 3],
}, augmentCandidates)?.candidate_ranking, ["强化乙", "强化甲", "强化丙"], "augment response validation must accept an exact permutation of the three reported candidates");

const stage2 = strategyFitWeightsForStage("2-5");
assert.deepEqual(stage2, {
  meta: 0.56,
  augment: 0.2,
  item: 0.14,
  tempo: 0.07,
  board: 0.03,
}, "stage two must use the user-approved initial weighting");

const stage3 = strategyFitWeightsForStage("3-5");
assert.deepEqual(stage3, {
  meta: 0.47,
  augment: 0.23,
  item: 0.14,
  tempo: 0.1,
  board: 0.06,
}, "stage three must use the user-approved convergence weighting");

const stage4 = strategyFitWeightsForStage("4-2");
assert.deepEqual(stage4, {
  meta: 0.4,
  augment: 0.22,
  item: 0.13,
  tempo: 0.13,
  board: 0.12,
}, "stage four and later must use the user-approved execution weighting");
for (const weights of [stage2, stage3, stage4]) {
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  assert(Math.abs(total - 1) < 1e-9, "every stage weighting profile must sum to one");
}

const visualFallbackCandidate = {
  id: "visual-fallback-ordering",
  display_name: "视觉装备不得改变排序",
  summary: { signal_score: 0.7, top4_rate: 0.6, top1_rate: 0.2, use_rate: 0.1 },
  strategy_profile: {
    main_carry: { champion_name: "测试主C" },
    primary_tank: { champion_name: "测试主坦" },
    equipment_requirements: { main_carry: ["测试视觉装备"] },
    variants: [],
  },
};
const visualFallbackEvaluationInput = {
  candidate: visualFallbackCandidate,
  variant: null,
  currentBoardShopBench: { board_units: [], bench_units: [], shop_units: [] },
  equipmentTokens: [],
  choiceTokens: [],
  userIntentTokens: [],
  equipmentEvidenceQuality: "none",
  stage: "2-2",
  hp: 100,
  gold: 10,
  level: 4,
  xp: 0,
  fitWeights: stage2,
  targetContext: { target: null, authority: "none" },
};
const withoutVisualFallback = evaluateAtomicStrategyVariant({
  ...visualFallbackEvaluationInput,
  fallbackEquipmentTokens: [],
});
const withVisualFallback = evaluateAtomicStrategyVariant({
  ...visualFallbackEvaluationInput,
  fallbackEquipmentTokens: ["测试视觉装备"],
});
assert(withVisualFallback.fallbackItemHits > 0, "the regression fixture must contain a matching visual-only equipment token");
assert.equal(withVisualFallback.itemEvidenceQuality, "visual_fallback_only", "visual-only matches must remain available for conditional wording");
assert.equal(withVisualFallback.itemFit, withoutVisualFallback.itemFit, "visual-only equipment evidence must not change item fit");
assert.equal(withVisualFallback.combinedFitScore, withoutVisualFallback.combinedFitScore, "visual-only equipment evidence must not change candidate ordering");

const lowCostObservation = assessLineupCandidateStageReadiness({
  candidate: {
    strategy_profile: {
      main_carry: { champion_name: "LowCostCarry", cost: 1 },
      core_units: [
        { champion_name: "LowCostCarry" },
        { champion_name: "LowCostTank" },
      ],
      lifecycle_prior: { archetype: "one_cost_reroll", main_carry_cost: 1, target_population: 5 },
    },
  },
  stageRound: "2-3",
  currentBoardShopBench: {
    board_units: [{ name: "LowCostCarry", cost: 1, star: 1 }],
    bench_units: [{ name: "LowCostCarry", cost: 1, star: 1 }],
  },
  metaStrength: 0.68,
  augmentFit: 0.3,
  itemFit: 0.3,
  currentBoardFit: 0.5,
});
assert.equal(lowCostObservation.state, "observe_only", "one temporary low-cost pair must not auto-start or durably constrain a stage-two direction");
assert.equal(lowCostObservation.may_create_durable_target, false, "stage-two observation evidence must stay provisional");

const lowCostConditionalStart = assessLineupCandidateStageReadiness({
  candidate: {
    strategy_profile: {
      main_carry: { champion_name: "LowCostCarry", cost: 1 },
      core_units: [
        { champion_name: "LowCostCarry" },
        { champion_name: "LowCostTank" },
        { champion_name: "LowCostSupport" },
      ],
      lifecycle_prior: { archetype: "one_cost_reroll", main_carry_cost: 1, target_population: 5 },
    },
  },
  stageRound: "2-5",
  currentBoardShopBench: {
    board_units: [
      { name: "LowCostCarry", cost: 1, star: 2 },
      { name: "LowCostTank", cost: 1, star: 2 },
    ],
    bench_units: [{ name: "LowCostSupport", cost: 2, star: 1 }],
  },
  metaStrength: 0.72,
  augmentFit: 0.66,
  itemFit: 0.62,
  currentBoardFit: 0.7,
});
assert.equal(lowCostConditionalStart.state, "conditional_start", "a stage-two low-cost direction may start only after multiple independent signals agree");
assert.equal(lowCostConditionalStart.may_create_durable_target, false, "even a strong stage-two low-cost signal remains a candidate until the user or later evidence commits");

const formedThreeCost = assessLineupCandidateStageReadiness({
  candidate: {
    strategy_profile: {
      main_carry: { champion_name: "ThreeCostCarry", cost: 3 },
      core_units: [
        { champion_name: "ThreeCostCarry" },
        { champion_name: "CoreTank" },
        { champion_name: "CoreSupport" },
        { champion_name: "FourCostTraitUnit" },
      ],
      lifecycle_prior: { archetype: "three_cost_reroll", main_carry_cost: 3, target_population: 8 },
    },
  },
  stageRound: "4-2",
  currentBoardShopBench: {
    board_units: [
      { name: "ThreeCostCarry", cost: 3, star: 3 },
      { name: "CoreTank", cost: 3, star: 2 },
      { name: "CoreSupport", cost: 2, star: 2 },
      { name: "FourCostTraitUnit", cost: 4, star: 1 },
    ],
  },
  metaStrength: 0.62,
  augmentFit: 0.7,
  itemFit: 0.75,
  currentBoardFit: 0.86,
  durableTargetAligned: true,
  level: 8,
  gold: 24,
  hp: 49,
});
assert.equal(formedThreeCost.state, "formed_core_continue", "an established three-cost reroll core must remain a continue/quality/cap decision, not a generic four-cost pivot");
assert.equal(formedThreeCost.continuity_priority, 3, "formed target continuity must outrank unrelated generic discovery");
assert(formedThreeCost.host_guardrails.includes("do_not_replace_formed_core_with_unrelated_higher_cost_meta_line"), "formed target must carry an explicit anti-pivot guardrail");

const futureFourCost = assessLineupCandidateStageReadiness({
  candidate: {
    strategy_profile: {
      main_carry: { champion_name: "FourCostCarry", cost: 4 },
      core_units: [{ champion_name: "FourCostCarry" }, { champion_name: "FourCostTank" }],
      lifecycle_prior: { archetype: "four_cost_carry", main_carry_cost: 4, target_population: 8 },
    },
  },
  stageRound: "2-5",
  currentBoardShopBench: { board_units: [{ name: "TransitionUnit", cost: 2, star: 2 }] },
  metaStrength: 0.8,
  augmentFit: 0.45,
  itemFit: 0.55,
  currentBoardFit: 0.25,
  level: 5,
  gold: 42,
  hp: 92,
});
assert.equal(futureFourCost.state, "future_target", "higher-cost lines stay in the universal candidate set as future targets instead of needing a separate fee pool");

assert.deepEqual(
  targetPlanIdentityValues({ target_name: "ThreeCostLine", primary_carry: { champion_name: "ThreeCostCarry" } }),
  ["ThreeCostLine", "ThreeCostCarry"],
  "durable target identity must normalize named and object-valued fields without leaking object stringification",
);
const productionFitPacket = buildStrategyFitPacket({
  liveStateSummary: {
    phase: { stage_round: "4-2" },
    economy: { hp: 49, gold: 24, level: 8 },
  },
  matchFacts: {
    target_plan: {
      target_name: "ThreeCostLine",
      primary_carry: { champion_name: "ThreeCostCarry" },
      core_unit_names: ["ThreeCostCarry", "CoreTank", "CoreSupport"],
      source_candidate_id: "three-cost-line",
    },
    choice_confirmations: [{ stage_round: "3-2", kind: "augment", selected: "CombatAugment" }],
  },
  dailyBigData: { available: true },
  selectedRankingCandidates: {
    primary_query_terms: ["ThreeCostLine", "ThreeCostCarry"],
    target_role_intent: "main_carry",
    candidates: [{
      id: "three-cost-line",
      display_name: "ThreeCostLine",
      match_type: "primary_target_match",
      target_match_role: "main_carry",
      summary: { top4_rate: 0.72, top1_rate: 0.18, use_num: 1200, source_interpretation: "national_trait_ranking_primary_strength_evidence" },
      strategy_profile: {
        strength_anchor: { anchor_id: "national:test", metrics: { top4_rate: 0.72 }, quality: { confidence_score: 0.9 } },
        main_carry: { champion_name: "ThreeCostCarry", cost: 3 },
        core_units: [
          { champion_name: "ThreeCostCarry" },
          { champion_name: "CoreTank" },
          { champion_name: "CoreSupport" },
        ],
        lifecycle_prior: { archetype: "three_cost_reroll", main_carry_cost: 3, target_population: 8 },
        variants: [{
          variant_id: "three-cost-line-standard",
          atomic_roster_id: "three-cost-line-roster",
          candidate_evidence_id: "three-cost-line-evidence",
          roster_is_atomic: true,
          population: 8,
          lineup_names: ["ThreeCostCarry", "CoreTank", "CoreSupport", "Unit4", "Unit5", "Unit6", "Unit7", "Unit8"],
          main_carry: { champion_name: "ThreeCostCarry", cost: 3 },
          primary_tank: { champion_name: "CoreTank", cost: 3 },
          lifecycle_prior: { archetype: "three_cost_reroll", main_carry_cost: 3, target_population: 8 },
        }],
      },
    }],
  },
  gameRuleContract: { stage_round: "4-2" },
  gameStateBrief: { stage_round: "4-2", unknown_final_choices: [] },
  cruiseDecisionContext: {
    current_board_shop_bench: {
      board_units: [
        { name: "ThreeCostCarry", cost: 3, star: 3 },
        { name: "CoreTank", cost: 3, star: 2 },
        { name: "CoreSupport", cost: 2, star: 2 },
      ],
      bench_units: [],
      shop_units: [],
    },
    equipment: { effective_source_by_field: {}, effective_item_bench: [], effective_equipped_items: [] },
    economic_decision_context: null,
  },
});
assert.equal(productionFitPacket.inputs_summary.target_context_authority, "provisional_user_intent", "natural-language lineup intent must remain provisional until an explicit final-lineup confirmation persists it");
assert.equal(productionFitPacket.candidate_working_set[0].stage_readiness.state, "observe_only", "a provisional name/object target must not become a durable formed-core state");
assert(Number.isFinite(productionFitPacket.candidate_working_set[0].board_commitment_confidence), "current-board evidence must remain measurable even when target authority is provisional");

function buildBoardCommitmentPacket(currentBoardShopBench) {
  return buildStrategyFitPacket({
    liveStateSummary: {
      phase: { stage_round: "2-5" },
      economy: { hp: 90, gold: 40, level: 5 },
    },
    matchFacts: { choice_confirmations: [] },
    dailyBigData: { available: true },
    selectedRankingCandidates: {
      primary_query_terms: [],
      candidates: [{
        id: "board-commitment-line",
        display_name: "BoardCommitmentLine",
        summary: { top4_rate: 0.7, top1_rate: 0.18, use_rate: 0.08, source_interpretation: "national_trait_ranking_primary_strength_evidence" },
        strategy_profile: {
          strength_anchor: { anchor_id: "national:board", metrics: { top4_rate: 0.7, top1_rate: 0.18, use_rate: 0.08 } },
          main_carry: { champion_name: "BoardCarry", cost: 2 },
          primary_tank: { champion_name: "BoardTank", cost: 2 },
          core_units: [
            { champion_name: "BoardCarry" },
            { champion_name: "BoardTank" },
            { champion_name: "BoardSupport" },
          ],
          lifecycle_prior: { archetype: "two_cost_reroll", main_carry_cost: 2, target_population: 6 },
          variants: [{
            variant_id: "board-commitment-standard",
            atomic_roster_id: "board-commitment-roster",
            candidate_evidence_id: "board-commitment-evidence",
            roster_is_atomic: true,
            population: 6,
            lineup_names: ["BoardCarry", "BoardTank", "BoardSupport", "Unit4", "Unit5", "Unit6"],
            core_units: [
              { champion_name: "BoardCarry" },
              { champion_name: "BoardTank" },
              { champion_name: "BoardSupport" },
              { champion_name: "Unit4" },
              { champion_name: "Unit5" },
              { champion_name: "Unit6" },
            ],
            main_carry: { champion_name: "BoardCarry", cost: 2 },
            primary_tank: { champion_name: "BoardTank", cost: 2 },
            lifecycle_prior: { archetype: "two_cost_reroll", main_carry_cost: 2, target_population: 6 },
          }],
        },
      }],
    },
    gameRuleContract: { stage_round: "2-5" },
    gameStateBrief: { stage_round: "2-5", unknown_final_choices: [] },
    cruiseDecisionContext: {
      current_board_shop_bench: currentBoardShopBench,
      equipment: { effective_source_by_field: {}, effective_item_bench: [], effective_equipped_items: [] },
      economic_decision_context: null,
    },
  });
}

const oneStarTransitionPacket = buildBoardCommitmentPacket({
  board_units: [{ name: "BoardSupport", cost: 1, star: 1 }],
  bench_units: [],
  shop_units: [],
});
const ownedCarryPairPacket = buildBoardCommitmentPacket({
  board_units: [{ name: "BoardCarry", cost: 2, star: 1 }],
  bench_units: [{ name: "BoardCarry", cost: 2, star: 1 }],
  shop_units: [],
});
const oneStarBenchCarryPacket = buildBoardCommitmentPacket({
  board_units: [],
  bench_units: [{ name: "BoardCarry", cost: 2, star: 1 }],
  shop_units: [],
});
const upgradedBenchCarryPacket = buildBoardCommitmentPacket({
  board_units: [],
  bench_units: [{ name: "BoardCarry", cost: 2, star: 2 }],
  shop_units: [],
});
const upgradedBenchTankPacket = buildBoardCommitmentPacket({
  board_units: [],
  bench_units: [{ name: "BoardTank", cost: 2, star: 2 }],
  shop_units: [],
});
const upgradedBenchSupportPacket = buildBoardCommitmentPacket({
  board_units: [],
  bench_units: [{ name: "BoardSupport", cost: 2, star: 2 }],
  shop_units: [],
});
const benchCoreCoveragePacket = buildBoardCommitmentPacket({
  board_units: [],
  bench_units: [
    { name: "BoardCarry", cost: 2, star: 1 },
    { name: "BoardTank", cost: 2, star: 1 },
    { name: "BoardSupport", cost: 2, star: 1 },
  ],
  shop_units: [],
});
const formedBoardPacket = buildBoardCommitmentPacket({
  board_units: [
    { name: "BoardCarry", cost: 2, star: 2 },
    { name: "BoardTank", cost: 2, star: 2 },
    { name: "BoardSupport", cost: 1, star: 2 },
  ],
  bench_units: [],
  shop_units: [],
});
const shopOnlyPacket = buildBoardCommitmentPacket({
  board_units: [],
  bench_units: [],
  shop_units: [{ name: "BoardCarry", cost: 2, star: 1 }],
});
const emptyBoardPacket = buildBoardCommitmentPacket({ board_units: [], bench_units: [], shop_units: [] });
assert(oneStarTransitionPacket.candidate_working_set[0].board_commitment_confidence <= 0.4, "one ordinary one-star transition unit must remain low-commitment evidence");
assert(ownedCarryPairPacket.candidate_working_set[0].board_commitment_confidence > oneStarTransitionPacket.candidate_working_set[0].board_commitment_confidence, "a genuinely owned carry pair across board and bench must increase commitment evidence");
assert(ownedCarryPairPacket.candidate_working_set[0].board_commitment_confidence < formedBoardPacket.candidate_working_set[0].board_commitment_confidence, "an unupgraded pair must remain weaker than an upgraded carry/tank/core board");
assert(upgradedBenchCarryPacket.candidate_working_set[0].board_commitment_confidence > oneStarBenchCarryPacket.candidate_working_set[0].board_commitment_confidence, "an upgraded bench carry must contribute bounded star-level commitment");
assert(upgradedBenchTankPacket.candidate_working_set[0].board_commitment_confidence > upgradedBenchSupportPacket.candidate_working_set[0].board_commitment_confidence, "a bench primary tank must contribute more commitment than an ordinary bench core unit at equal star level");
assert.equal(benchCoreCoveragePacket.candidate_working_set[0].board_evidence.matched_core_count, 3, "distinct owned bench core units must contribute to core coverage");
assert(benchCoreCoveragePacket.candidate_working_set[0].board_commitment_confidence > oneStarBenchCarryPacket.candidate_working_set[0].board_commitment_confidence, "multi-core bench ownership must contribute more than one isolated bench carry");
assert(formedBoardPacket.candidate_working_set[0].board_commitment_confidence >= 0.8, "formed carry/tank/core upgrades must become high-commitment evidence");
assert(formedBoardPacket.candidate_working_set[0].current_board_fit > oneStarTransitionPacket.candidate_working_set[0].current_board_fit, "formed board evidence must contribute more than a temporary one-star overlap");
assert.equal(shopOnlyPacket.candidate_working_set[0].current_board_fit, emptyBoardPacket.candidate_working_set[0].current_board_fit, "unbought shop units must not enter current_board_fit");
assert.equal(shopOnlyPacket.candidate_working_set[0].board_commitment_confidence, emptyBoardPacket.candidate_working_set[0].board_commitment_confidence, "shop opportunity must not create board commitment");

const missingAugment = { kind: "augment", stage_round: "3-2" };
assert.equal(classifyMissingChoiceDependency(missingAugment, {
  mode: "cruise",
  user_message: "判断我现在该继续现有方向、先过渡还是转阵",
  current_stage_round: "3-3",
}), "conditional_uncertainty", "a missing augment must not block a lineup-direction decision");
assert.equal(classifyMissingChoiceDependency({ kind: "season_mechanic", stage_round: "3-4" }, {
  mode: "cruise",
  user_message: "判断阵容方向",
  current_stage_round: "3-5",
}), "reminder_only", "a passed descriptor-owned season choice must remain a nonblocking reminder");
assert.equal(classifyMissingChoiceDependency(missingAugment, {
  mode: "augment_choice",
  user_message: "这三个强化选哪个？要不要刷新？",
  current_stage_round: "3-2",
}), "required_for_current_question", "the exact current choice question may require its candidate facts");

for (const majorStage of [2, 3, 4, 5, 6, 7]) {
  assert.equal(classifyMissingChoiceDependency({ kind: "augment", stage_round: `${majorStage}-2` }, {
    mode: "cruise",
    user_message: "先回答我现在该升人口、搜牌还是继续当前阵容",
    current_stage_round: `${majorStage}-2`,
  }), "conditional_uncertainty", `stage ${majorStage} user-owned actions must not be blocked by a missing choice`);
}

const unsortedFitLines = [
  { index: 1, score: 0.2 },
  { index: 2, score: 0.3 },
  { index: 3, score: 0.9 },
].map(({ index, score }) => ({
    line_id: `line-${index}`,
    candidate_id: `line-${index}`,
    selected_variant_id: `line-${index}-standard`,
    candidate_evidence_id: `line-${index}-evidence`,
    atomic_roster_id: `line-${index}-roster`,
    roster_is_atomic: true,
    line: `候选${index}`,
    display_name: `候选${index}`,
    canonical_variant: {
      variant_id: `line-${index}-standard`,
      candidate_evidence_id: `line-${index}-evidence`,
      atomic_roster_id: `line-${index}-roster`,
      roster_is_atomic: true,
      population: 3,
      lineup_names: [`候选${index}主C`, `候选${index}主坦`, `候选${index}辅助`],
    },
    combined_fit_score: score,
    stage_readiness: index === 3 ? {
      state: "conditional_start",
      continuity_priority: 1,
      archetype: "three_cost_reroll",
      evidence: { signals: ["current_master_plus_meta_support"] },
      host_guardrails: ["do_not_create_or_change_durable_target_from_this_assessment_alone"],
    } : null,
    transition_steps: [{ population: 5 + index, lineup_names: [`过渡${index}`] }],
  }));
const fitPacket = {
  candidate_lines: sortStrategyFitCandidateLines(unsortedFitLines),
  candidate_working_set: sortStrategyFitCandidateLines(unsortedFitLines),
  candidate_working_set_count: unsortedFitLines.length,
  candidate_working_set_source_count: unsortedFitLines.length,
  candidate_working_set_limit: unsortedFitLines.length,
  next_coach_plan: { missing_facts_that_block_next_decision: [] },
};
const stage2CruisePacket = compactStrategyFitPacketForTurn(fitPacket, {
  mode: "cruise",
  currentStageRound: "2-5",
});
assert.equal(stage2CruisePacket.candidate_lines.length, 3, "stage two cruise must preserve two to three candidate directions");
assert.equal(stage2CruisePacket.candidate_lines[0].candidate_id, "line-3", "weighted fit ordering must be applied before stage-based truncation");
const stage2BestWorkingCandidate = stage2CruisePacket.candidate_working_set.find((candidate) => candidate.candidate_id === "line-3");
assert(stage2BestWorkingCandidate, "the display reference must resolve to a complete working-set candidate");
assert.deepEqual(stage2BestWorkingCandidate.transition_steps, [{ population: 8, lineup_names: ["过渡3"] }], "candidate transition evidence must survive turn compaction");
assert.equal(stage2BestWorkingCandidate.stage_readiness.state, "conditional_start", "candidate stage readiness must survive production turn compaction");
const stage3CruisePacket = compactStrategyFitPacketForTurn(fitPacket, {
  mode: "cruise",
  currentStageRound: "3-5",
});
assert.equal(stage3CruisePacket.candidate_lines.length, 2, "stage three cruise must narrow to a primary and backup direction");
assert.equal(stage3CruisePacket.candidate_lines[0].candidate_id, "line-3", "stage three truncation must retain the strongest executable candidate");

const targetConstrainedOrdering = sortStrategyFitCandidateLines([
  {
    line_id: "formed-three-cost",
    target_alignment_priority: 3,
    durable_target_alignment_priority: 3,
    combined_fit_score: 0.62,
    stage_readiness: { state: "formed_core_continue", continuity_priority: 3 },
  },
  {
    line_id: "future-same-role",
    target_alignment_priority: 3,
    durable_target_alignment_priority: 0,
    combined_fit_score: 0.9,
    stage_readiness: { state: "future_target", continuity_priority: 0 },
  },
  {
    line_id: "unrelated-four-cost-meta",
    target_alignment_priority: 0,
    durable_target_alignment_priority: 0,
    combined_fit_score: 0.99,
    stage_readiness: { state: "conditional_start", continuity_priority: 1 },
  },
], { targetConstrained: true });
assert.equal(targetConstrainedOrdering[0].line_id, "formed-three-cost", "formed target continuity must win within the same explicit target identity before weighted score");
assert.equal(targetConstrainedOrdering[1].line_id, "unrelated-four-cost-meta", "after formed-core continuity, the registered five-weight score must order candidates without another target-alignment vote");

const provisionalReadinessOrdering = sortStrategyFitCandidateLines([
  {
    line_id: "lower-score-conditional-start",
    target_alignment_priority: 2,
    durable_target_alignment_priority: 0,
    combined_fit_score: 0.55,
    stage_readiness: { state: "conditional_start", continuity_priority: 1 },
  },
  {
    line_id: "higher-five-weight-score",
    target_alignment_priority: 2,
    durable_target_alignment_priority: 0,
    combined_fit_score: 0.82,
    stage_readiness: { state: "future_target", continuity_priority: 0 },
  },
], { targetConstrained: true });
assert.equal(
  provisionalReadinessOrdering[0].line_id,
  "higher-five-weight-score",
  "provisional readiness labels must not become a hidden sixth ranking dimension ahead of the registered five-weight score",
);

const deterministicTieOrdering = sortStrategyFitCandidateLines([
  { line_id: "z-meta-stronger", combined_fit_score: 0.7, meta_strength: 0.95 },
  { line_id: "a-meta-weaker", combined_fit_score: 0.7, meta_strength: 0.2 },
]);
assert.equal(deterministicTieOrdering[0].line_id, "a-meta-weaker", "an exact five-weight tie must use stable identity, not give meta strength an unregistered second vote");

function buildTempoCandidate(id, transitionPopulation) {
  const lineupNames = Array.from({ length: 8 }, (_, index) => `${id}-unit-${index + 1}`);
  lineupNames[0] = `${id}-carry`;
  lineupNames[1] = `${id}-tank`;
  return {
    id,
    display_name: id,
    summary: { top4_rate: 0.7, top1_rate: 0.18, use_rate: 0.08, source_interpretation: "national_trait_ranking_primary_strength_evidence" },
    strategy_profile: {
      strength_anchor: { anchor_id: `national:${id}`, metrics: { top4_rate: 0.7, top1_rate: 0.18, use_rate: 0.08 } },
      main_carry: { champion_name: `${id}-carry`, cost: 4 },
      core_units: lineupNames.map((champion_name) => ({ champion_name })),
      lifecycle_prior: { archetype: "four_cost_carry", main_carry_cost: 4, target_population: 8 },
      variants: [{
        variant_id: `${id}-standard`,
        atomic_roster_id: `${id}-roster`,
        candidate_evidence_id: `${id}-evidence`,
        roster_is_atomic: true,
        population: 8,
        lineup_names: lineupNames,
        core_units: lineupNames.map((champion_name) => ({ champion_name })),
        main_carry: { champion_name: `${id}-carry`, cost: 4 },
        primary_tank: { champion_name: `${id}-tank`, cost: 4 },
        transition_chain: [{ population: transitionPopulation, lineup_names: [`${id}-transition`] }],
      }],
    },
  };
}
const tempoDifferentiatedPacket = buildStrategyFitPacket({
  liveStateSummary: { phase: { stage_round: "4-2" }, economy: { hp: 35, gold: 30, level: 8 } },
  matchFacts: { choice_confirmations: [] },
  dailyBigData: { available: true },
  selectedRankingCandidates: { primary_query_terms: [], candidates: [buildTempoCandidate("near", 8), buildTempoCandidate("far", 5)] },
  gameRuleContract: { stage_round: "4-2" },
  gameStateBrief: { stage_round: "4-2", unknown_final_choices: [] },
  cruiseDecisionContext: {
    current_board_shop_bench: { board_units: [], bench_units: [], shop_units: [] },
    equipment: { effective_source_by_field: {}, effective_item_bench: [], effective_equipped_items: [] },
    economic_decision_context: null,
  },
});
assert.equal(tempoDifferentiatedPacket.candidate_working_set[0].line_id, "near", "candidate-specific transition reachability must affect the registered tempo component");
assert(
  tempoDifferentiatedPacket.candidate_working_set[0].tempo_fit > tempoDifferentiatedPacket.candidate_working_set[1].tempo_fit,
  `tempo evidence must distinguish a reachable transition from a distant one: ${JSON.stringify(tempoDifferentiatedPacket.candidate_working_set.map((line) => ({ line_id: line.line_id, tempo_fit: line.tempo_fit, transition_populations: line.transition_populations })))}`,
);

function buildCurrentnessCandidate(id, {
  officialStrength,
  interpretation,
  burden,
}) {
  const lineupNames = Array.from({ length: 8 }, (_, index) => `${id}-unit-${index + 1}`);
  lineupNames[0] = `${id}-carry`;
  lineupNames[1] = `${id}-tank`;
  return {
    id,
    display_name: id,
    summary: { top4_rate: 0.75, top1_rate: 0.25, use_rate: 0.04 },
    ranking_quality: {
      current_day_score: officialStrength,
      currentness: {
        interpretation,
        sample: { status: "unavailable" },
      },
    },
    strategy_profile: {
      strength_anchor: {
        anchor_id: `national:${id}`,
        quality: {
          current_day_score: officialStrength,
          currentness: {
            interpretation,
            sample: { status: "unavailable" },
          },
        },
      },
      main_carry: { champion_name: `${id}-carry`, cost: 4 },
      core_units: lineupNames.map((champion_name) => ({ champion_name })),
      lifecycle_prior: { archetype: "four_cost_carry", main_carry_cost: 4, target_population: 8 },
      formation_profile: { estimated_burden_score: burden },
      variants: [{
        variant_id: `${id}-standard`,
        atomic_roster_id: `${id}-roster`,
        candidate_evidence_id: `${id}-evidence`,
        roster_is_atomic: true,
        population: 8,
        lineup_names: lineupNames,
        core_units: lineupNames.map((champion_name) => ({ champion_name })),
        main_carry: { champion_name: `${id}-carry`, cost: 4 },
        primary_tank: { champion_name: `${id}-tank`, cost: 4 },
      }],
    },
  };
}
const currentnessAwarePacket = buildStrategyFitPacket({
  liveStateSummary: { phase: { stage_round: "2-2" }, economy: { hp: 100, gold: 10, level: 4 } },
  matchFacts: { choice_confirmations: [] },
  dailyBigData: { available: true },
  selectedRankingCandidates: {
    primary_query_terms: [],
    candidates: [
      buildCurrentnessCandidate("historical-carryover", {
        officialStrength: 0.84,
        interpretation: "legacy_carryover_risk",
        burden: 0.9,
      }),
      buildCurrentnessCandidate("current-stable", {
        officialStrength: 0.72,
        interpretation: "current_high_signal",
        burden: 0.2,
      }),
    ],
  },
  gameRuleContract: { stage_round: "2-2" },
  gameStateBrief: { stage_round: "2-2", unknown_final_choices: [] },
  cruiseDecisionContext: {
    current_board_shop_bench: { board_units: [], bench_units: [], shop_units: [] },
    equipment: { effective_source_by_field: {}, effective_item_bench: [], effective_equipped_items: [] },
    economic_decision_context: null,
  },
});
assert.equal(currentnessAwarePacket.candidate_working_set[0].line_id, "current-stable",
  "open stage-two exploration must use currentness as bounded selection context instead of mechanically recommending a declining historical aggregate");
const carryoverLine = currentnessAwarePacket.candidate_working_set.find((line) => line.line_id === "historical-carryover");
assert.equal(carryoverLine.meta_strength, 0.84, "official Master+ strength must remain visible and unchanged");
const recomposedCarryoverScore = Number((
  carryoverLine.meta_strength * carryoverLine.fit_weights.meta
  + carryoverLine.augment_fit * carryoverLine.fit_weights.augment
  + carryoverLine.item_fit * carryoverLine.fit_weights.item
  + carryoverLine.tempo_fit * carryoverLine.fit_weights.tempo
  + carryoverLine.current_board_fit * carryoverLine.fit_weights.board
).toFixed(3));
assert.equal(carryoverLine.combined_fit_score, recomposedCarryoverScore,
  "the registered five-component score must continue using official Master+ strength");
assert(carryoverLine.selection_meta_strength < carryoverLine.meta_strength,
  "carryover risk must affect only the open-exploration selection strength");
assert(carryoverLine.selection_priority_score < carryoverLine.combined_fit_score,
  "currentness must remain a separate open-exploration ordering modifier");
assert(!carryoverLine.ranking_selection_context.factors.some((factor) => factor.id === "formation_burden"),
  "formation burden must not be double-counted inside currentness");
assert.equal(carryoverLine.ranking_selection_context.authority.official_strength_order_unchanged, true);

const conflictingTargetFitPacket = buildStrategyFitPacket({
  liveStateSummary: {
    phase: { stage_round: "4-2" },
    economy: { hp: 55, gold: 30, level: 8 },
  },
  matchFacts: {
    target_plan: {
      target_name: "DurableLineA",
      primary_carry: { champion_name: "CarryA" },
      authority: "durable_target_plan",
      candidate_id: "line-a",
    },
    latest_target_intent: { text: "想看看LineB是否值得转" },
  },
  dailyBigData: { available: true },
  selectedRankingCandidates: {
    primary_query_terms: ["LineB", "CarryB"],
    target_role_intent: "main_carry",
    candidates: [{
      id: "line-b",
      display_name: "LineB",
      match_type: "primary_target_match",
      target_match_role: "main_carry",
      summary: { top4_rate: 0.74, top1_rate: 0.2, use_num: 1600 },
      strategy_profile: {
        strength_anchor: { anchor_id: "national:line-b", metrics: { top4_rate: 0.74 }, quality: { confidence_score: 0.9 } },
        main_carry: { champion_name: "CarryB", cost: 3 },
        core_units: [
          { champion_name: "CarryB" },
          { champion_name: "TankB" },
          { champion_name: "SupportB" },
        ],
        lifecycle_prior: { archetype: "three_cost_reroll", main_carry_cost: 3, target_population: 8 },
        variants: [],
      },
    }],
  },
  gameRuleContract: { stage_round: "4-2" },
  gameStateBrief: { stage_round: "4-2", unknown_final_choices: [] },
  cruiseDecisionContext: {
    current_board_shop_bench: {
      board_units: [
        { name: "CarryB", cost: 3, star: 3 },
        { name: "TankB", cost: 3, star: 2 },
        { name: "SupportB", cost: 2, star: 2 },
      ],
      bench_units: [],
      shop_units: [],
    },
    equipment: { effective_source_by_field: {}, effective_item_bench: [], effective_equipped_items: [] },
    economic_decision_context: null,
  },
});
assert.equal(
  conflictingTargetFitPacket.candidate_lines.length,
  0,
  "an exploratory question about an unrelated line must not inject that line into a confirmed durable target's atomic candidate set",
);

const preselectedRankingPacket = {
  query_status: "primary_target_matches_found",
  primary_query_terms: ["TargetLine"],
  candidates: [{ id: "target-line", display_name: "TargetLine" }],
};
const summarizedPreselectedRequest = summarizeHostRequest({
  request_id: "preselected-ranking-reuse",
  request_hash: "preselected-ranking-reuse",
  mode: "cruise",
  user_message: "继续TargetLine吗",
  daily_big_data: {
    available: true,
    tiers: {
      0: {
        lineup_groups: [
          { id: "fallback-1", display_name: "FallbackOne" },
          { id: "fallback-2", display_name: "FallbackTwo" },
        ],
      },
    },
  },
  runtime_context: {
    selected_ranking_candidates: preselectedRankingPacket,
  },
  context: {},
});
assert.equal(
  summarizedPreselectedRequest.selected_ranking_candidates.candidates[0].id,
  "target-line",
  "Host summarization must reuse the raw-index preselection instead of rerunning retrieval against a truncated ranking summary",
);

const budgetReduced = enforceHostTurnDeltaBudget({
  schema: "jcc-host-current-turn-delta-v1",
  request_id: "budget-readiness",
  mode: "cruise",
  itemization_context: { oversized_optional_evidence: "x".repeat(20_000) },
  runtime_context: {
    schema: "jcc-runtime-host-request-context-v1",
    active_mode: "cruise",
    strategy_fit_packet: {
      schema: "jcc-strategy-fit-packet-v1",
      inputs_summary: { stage_round: "4-2", target_context_authority: "durable_target_plan" },
      fit_weights: stage4,
      candidate_working_set: [{
        line_id: "formed-three-cost",
        candidate_id: "formed-three-cost",
        line: "FormedThreeCost",
        display_name: "FormedThreeCost",
        selected_variant_id: "formed-three-cost-standard",
        durable_target_alignment_priority: 3,
        combined_fit_score: 0.68,
        fit_weights: stage4,
        canonical_variant: {
          variant_id: "formed-three-cost-standard",
          atomic_roster_id: "formed-three-cost-roster",
          candidate_evidence_id: "formed-three-cost-evidence",
          roster_is_atomic: true,
          population: 8,
          lineup_names: Array.from({ length: 8 }, (_, index) => `formed-unit-${index + 1}`),
        },
        stage_readiness: {
          state: "formed_core_continue",
          continuity_priority: 3,
          host_guardrails: ["do_not_replace_formed_core_with_unrelated_higher_cost_meta_line"],
        },
      }],
      candidate_lines: [{
        line_id: "formed-three-cost",
        candidate_id: "formed-three-cost",
        line: "FormedThreeCost",
        durable_target_alignment_priority: 3,
        combined_fit_score: 0.68,
      }],
    },
  },
}, 6_000);
assert.equal(
  budgetReduced.runtime_context.strategy_fit_packet.candidate_working_set[0].stage_readiness.state,
  "formed_core_continue",
  "the emergency turn-budget fallback must retain minimal stage readiness and anti-pivot evidence",
);
assert.deepEqual(
  budgetReduced.runtime_context.strategy_fit_packet.fit_weights,
  stage4,
  "the emergency turn-budget fallback must retain the exact registered stage weight profile",
);

const compacted = compactSelectedRankingCandidatesForTurn({
  query_status: "primary_target_matches_found",
  candidates: [
    {
      display_name: "太空律动5",
      match_type: "primary_target_match",
      target_match_role: "main_carry",
      summary: { top4_rate: 0.52, top1_rate: 0.13, use_num: 23000, source_interpretation: "national_trait_ranking_primary_strength_evidence" },
      strategy_profile: {
        main_carry: { champion_name: "娜美", cost: 4 },
        recipe_match: { classification: "exact" },
        lifecycle_prior: { target_population: 8 },
        core_units: [
          { champion_name: "娜美" },
          { champion_name: "布里茨" },
          { champion_name: "内瑟斯" },
          { champion_name: "俄洛伊" },
          { champion_name: "其他变体单位" },
        ],
        variants: [
          {
            variant_id: "space-8-canonical",
            lineup_rank: 1,
            population: 8,
            lineup_ids: ["nami", "blitz", "nasus", "ornn", "samira", "teemo", "graves", "tahm"],
            lineup_names: ["娜美", "布里茨", "内瑟斯", "奥恩", "莎弥拉", "提莫", "格雷福斯", "塔姆"],
            trait_signature: { key: "space5", traits: [{ family_id: "space", breakpoint: 5 }] },
            main_carry_items: [{ item_name: "朔极之矛" }],
            quality: { sample_size: 420 },
          },
          {
            variant_id: "space-9-alternate",
            lineup_rank: 2,
            population: 9,
            lineup_ids: ["nami", "illaoi", "nasus", "ornn", "samira", "teemo", "graves", "tahm", "viego"],
            lineup_names: ["娜美", "俄洛伊", "内瑟斯", "奥恩", "莎弥拉", "提莫", "格雷福斯", "塔姆", "佛耶戈"],
            trait_signature: { key: "space5-alt", traits: [{ family_id: "space", breakpoint: 5 }] },
            quality: { sample_size: 780 },
          },
        ],
      },
    },
    {
      display_name: "魔术师4",
      match_type: "contextual_target_match",
      target_match_role: "core_member",
      summary: { top4_rate: 0.71, top1_rate: 0.19, use_num: 3200, source_interpretation: "winning_lineup_recipe_metrics_without_national_strength_anchor" },
      query_match: { group_matches: [{ variant_id: "mage-8", group_id: "mage-group", exact: true }] },
      strategy_profile: {
        main_carry: { champion_name: "璐璐", cost: 3 },
        recipe_match: { classification: "analogous" },
        variants: [{
          variant_id: "mage-8",
          population: 8,
          lineup_names: ["璐璐", "前排B", "功能B"],
          transitions: [{
            semantic_role: "published_transition",
            population: 4,
            lineup_names: ["过渡C", "前排D", "功能D"],
          }],
        }],
      },
    },
  ],
}, { maxCandidates: 3, includeLineupIds: true });
assert.equal(compacted.candidates[0].strategy_profile.main_carry.champion_name, "娜美");
assert.deepEqual(
  compacted.candidates[0].strategy_profile.canonical_variant.lineup_names,
  ["娜美", "布里茨", "内瑟斯", "奥恩", "莎弥拉", "提莫", "格雷福斯", "塔姆"],
  "Host evidence must preserve one complete population-matched published variant instead of synthesizing a roster",
);
assert.equal(compacted.candidates[0].strategy_profile.canonical_variant.variant_id, "space-8-canonical");
assert.ok(compacted.candidates[0].strategy_profile.canonical_variant.roster_policy.includes("one-for-one"));
assert.ok(!compacted.candidates[0].strategy_profile.canonical_variant.lineup_names.includes("俄洛伊"), "alternate-variant members must not leak into the canonical roster");
assert(compacted.candidates[0].strategy_profile.sibling_variants?.some((variant) => variant.lineup_names.includes("俄洛伊")),
  "alternate members must remain available only inside their own atomic sibling variant");
assert.equal(compacted.candidates[1].strategy_profile.main_carry.champion_name, "璐璐", "every compact candidate must preserve its main carry");
assert.equal(compacted.candidates[1].target_match_role, "core_member", "compact evidence must distinguish a member match from a carry match");
assert.equal(compacted.candidates[1].summary.source_interpretation, "winning_lineup_recipe_metrics_without_national_strength_anchor", "compact evidence must retain metric authority");
assert.equal(
  compacted.candidates[0].strategy_profile.detail_level,
  "complete_current_turn_strategy_package",
  "the first strategic candidate must keep a complete package",
);
assert.equal(
  compacted.candidates[1].strategy_profile.detail_level,
  "complete_current_turn_strategy_package",
  "every strategic candidate supplied to Host must keep a complete package, not only the first candidate",
);
assert.equal(
  compacted.candidates[1].runtime_transition_fit?.source_parent_variant_id,
  "mage-8",
  "every strategic candidate must receive its own transition-fit evidence",
);

const reducedRankingDelta = enforceHostTurnDeltaBudget({
  mode: "cruise",
  request_kind: "host_question",
  user_message: "当前经济怎么处理",
  selected_ranking_candidates: {
    ...compacted,
    candidates: compacted.candidates.map((candidate) => ({
      ...candidate,
      padding: "x".repeat(90 * 1024),
    })),
  },
  runtime_context: {},
}, 512 * 1024);
assert((reducedRankingDelta.selected_ranking_candidates?.candidates || [])[0]
  ?.strategy_profile?.canonical_variant?.lineup_names?.length > 0,
"budget degradation must preserve the canonical atomic roster instead of replacing it with an empty variants array");

const augmentRequest = {
  request_id: "augment-refresh-contract",
  request_hash: "augment-refresh-contract",
  mode: "augment_choice",
  user_message: "选哪个？要不要刷新？",
  task: { type: "structured_card_action" },
  runtime_context: {
    current_match_user_report: { kind: "augment", candidates: ["A", "B", "C"] },
  },
};
const missingRefreshStructure = normalizeHostCoachResponse({
  schema: "jcc-host-cli-coach-response-v1",
  mode: "augment_choice",
  generated_by: "current_cli_agent_main_model",
  request_id: augmentRequest.request_id,
  request_hash: augmentRequest.request_hash,
  final_text: "优先选择A，B次选，C第三。",
}, augmentRequest);
assert.equal(missingRefreshStructure.choice_recommendation, null);
assert.ok(missingRefreshStructure.soft_quality_diagnostics.includes("augment_choice_structure_not_supplied"));
assert.equal(missingRefreshStructure.final_text, "优先选择A，B次选，C第三。");
const incompleteRanking = normalizeHostCoachResponse({
  schema: "jcc-host-cli-coach-response-v1",
  mode: "augment_choice",
  generated_by: "current_cli_agent_main_model",
  request_id: augmentRequest.request_id,
  request_hash: augmentRequest.request_hash,
  final_text: "不刷新，直接选择A。",
  choice_recommendation: {
    selected_candidate: "A",
    refresh_action: "keep_and_pick",
    refresh_slots: [],
  },
}, augmentRequest);
assert.equal(incompleteRanking.choice_recommendation, null);
assert.equal(incompleteRanking.final_text, "不刷新，直接选择A。");
for (const invalidRanking of [["A", "A", "C"], ["A", "B", "D"]]) {
  const invalidStructuredAction = normalizeHostCoachResponse({
    schema: "jcc-host-cli-coach-response-v1",
    mode: "augment_choice",
    generated_by: "current_cli_agent_main_model",
    request_id: augmentRequest.request_id,
    request_hash: augmentRequest.request_hash,
    final_text: "给出排序和刷新建议。",
    choice_recommendation: {
      candidate_ranking: invalidRanking,
      selected_candidate: "A",
      refresh_action: "keep_and_pick",
      refresh_slots: [],
    },
  }, augmentRequest);
  assert.equal(invalidStructuredAction.choice_recommendation, null, "invalid candidate sets must not become executable structured actions");
  assert.equal(invalidStructuredAction.final_text, "给出排序和刷新建议。", "invalid structured actions must not discard readable advice");
}
const normalized = normalizeHostCoachResponse({
  schema: "jcc-host-cli-coach-response-v1",
  mode: "augment_choice",
  generated_by: "current_cli_agent_main_model",
  request_id: augmentRequest.request_id,
  request_hash: augmentRequest.request_hash,
  final_text: "不刷新，直接选择A。",
  choice_recommendation: {
    candidate_ranking: ["A", "B", "C"],
    selected_candidate: "A",
    refresh_action: "keep_and_pick",
    refresh_slots: [],
  },
}, augmentRequest);
assert.equal(normalized.choice_recommendation.refresh_action, "keep_and_pick");
assert.deepEqual(normalized.choice_recommendation.candidate_ranking, ["A", "B", "C"]);

const oversizedReportRequest = structuredClone(augmentRequest);
oversizedReportRequest.request_id = "augment-oversized-current-report";
oversizedReportRequest.request_hash = oversizedReportRequest.request_id;
oversizedReportRequest.runtime_context.current_match_user_report.candidates = ["A", "B", "C", "D"];
const oversizedReport = normalizeHostCoachResponse({
  schema: "jcc-host-cli-coach-response-v1",
  mode: "augment_choice",
  generated_by: "current_cli_agent_main_model",
  request_id: oversizedReportRequest.request_id,
  request_hash: oversizedReportRequest.request_hash,
  final_text: "给出前三项排序和刷新建议。",
  choice_recommendation: {
    candidate_ranking: ["A", "B", "C"],
    selected_candidate: "A",
    refresh_action: "keep_and_pick",
    refresh_slots: [],
  },
}, oversizedReportRequest);
assert.equal(oversizedReport.choice_recommendation, null, "an incomplete subset of an oversized report must not become an executable choice action");
assert.equal(oversizedReport.final_text, "给出前三项排序和刷新建议。", "oversized report quality issues must not block readable delivery");

const confirmationRequest = structuredClone(augmentRequest);
confirmationRequest.request_id = "augment-final-confirmation";
confirmationRequest.request_hash = confirmationRequest.request_id;
confirmationRequest.runtime_context.runtime_event_context = { user_message_kind: "structured_choice_confirmation" };
assert.doesNotThrow(() => normalizeHostCoachResponse({
  schema: "jcc-host-cli-coach-response-v1",
  mode: "augment_choice",
  generated_by: "current_cli_agent_main_model",
  request_id: confirmationRequest.request_id,
  request_hash: confirmationRequest.request_hash,
  final_text: "已确认A，并给出确认后的下一步建议。",
}, confirmationRequest), "final confirmation follow-up must not require a preselection ranking or refresh action");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-lineup-decision-quality-verification-v1",
  stage_weights: { stage2, stage3, stage4 },
}, null, 2));
