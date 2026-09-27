import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCruiseIntegratedDecision,
} from "../ui/electron/cruise-decision-orchestrator.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const framework = JSON.parse(await readFile(
  path.join(repoRoot, "data/game-knowledge/jcc/common/cruise-decision-framework.json"),
  "utf8",
));
const runtimeSemantics = JSON.parse(await readFile(
  path.join(repoRoot, "data/runtime/jcc/cruise-strategy-semantics-contract.json"),
  "utf8",
));
const orchestrationContract = runtimeSemantics.integrated_decision_orchestration;

const semanticFeatureIndex = {
  schema: "jcc-semantic-feature-index-v1",
  identity: { core_profile_id: "core-test" },
  entities: [
    {
      entity_kind: "champion",
      entity_id: "tank-1",
      name: "测试前排",
      features: ["role.frontline", "output.tank", "effect.shield", "evidence.core_profile"],
    },
    {
      entity_kind: "champion",
      entity_id: "carry-1",
      name: "测试后排",
      features: ["role.backline", "output.ap", "cadence.spell_cast", "evidence.core_profile"],
    },
    {
      entity_kind: "item",
      entity_id: "item-ap",
      name: "测试法装",
      features: ["effect.spell_power", "suitable_for.spell_carry", "evidence.core_profile"],
    },
    {
      entity_kind: "item",
      entity_id: "item-tank",
      name: "测试坦装",
      features: ["effect.durability", "suitable_for.frontline", "evidence.core_profile"],
    },
    {
      entity_kind: "trait",
      entity_id: "trait-test",
      name: "测试羁绊",
      features: ["effect.team_power", "evidence.core_profile"],
    },
  ],
};

const augmentSemanticProfiles = {
  source_core_profile_id: "core-test",
  by_id: {
    "augment-delay": {
      augment_id: "augment-delay",
      name: "测试延迟经济",
      category_ids: ["economy"],
      features: [
        "category.economy",
        "effect.economy",
        "delivery.delayed",
        "reliability.conditional",
        "risk.delayed_payout",
        "objective.economy",
      ],
      required_context_fields: ["hp", "board_power_score", "gold"],
      semantic_coverage: "classified_structured",
    },
    "augment-now": {
      augment_id: "augment-now",
      name: "测试即时战力",
      category_ids: ["combat"],
      features: ["category.combat", "effect.team_power", "delivery.immediate", "reliability.deterministic"],
      required_context_fields: ["owned_units"],
      semantic_coverage: "classified_structured",
    },
  },
  by_name: {},
};
augmentSemanticProfiles.by_name["测试延迟经济"] = augmentSemanticProfiles.by_id["augment-delay"];
augmentSemanticProfiles.by_name["测试即时战力"] = augmentSemanticProfiles.by_id["augment-now"];

const input = {
  framework,
  orchestrationContract,
  semanticFeatureIndex,
  augmentSemanticProfiles,
  matchSessionId: "match-current",
  stageRound: "3-5",
  economy: { hp: 24, gold: 46, level: 7, xp: "12/36" },
  currentBoardShopBench: {
    board_units: [
      { champion_id: "tank-1", name: "测试前排", star: 2, items: ["测试坦装"] },
      { champion_id: "carry-1", name: "测试后排", star: 2, items: ["测试法装"] },
      { champion_id: "carry-1", name: "异局棋子", star: 3, match_session_id: "match-other" },
    ],
    bench_units: [{ champion_id: "carry-1", name: "测试后排", star: 1 }],
    shop_units: [{ champion_id: "tank-1", name: "测试前排", star: 1 }],
    active_traits: [{ trait_id: "trait-test", name: "测试羁绊", count: 2 }],
  },
  equipment: {
    effective_item_bench: [{ name: "测试散件" }],
    effective_equipped_items: [
      { name: "测试坦装", owner_unit: "测试前排" },
      { name: "测试法装", owner_unit: "测试后排" },
      { name: "异局装备", owner_unit: "异局棋子", match_session_id: "match-other" },
    ],
  },
  confirmedChoices: [
    {
      kind: "augment",
      selected: "测试延迟经济",
      selected_id: "augment-delay",
      stage_round: "3-2",
      remaining_rounds: 3,
    },
    {
      kind: "augment",
      selected: "测试即时战力",
      selected_id: "augment-now",
      stage_round: "2-1",
    },
    {
      kind: "augment",
      selected: "异局强化",
      selected_id: "other-match",
      match_session_id: "match-other",
    },
  ],
  economicDecisionContext: {
    status: "ready",
    actions: [
      { action: "hold_gold_interest", score: 0.82, confidence: "high", gold_after: 46, interest_after: 4 },
      { action: "roll_to_stabilize", score: 0.74, confidence: "medium", roll_budget: 16, gold_after: 30 },
    ],
    heuristic_top_candidate: { action: "hold_gold_interest", score: 0.82 },
    missing_decision_facts: [],
  },
  combatCapContext: { board_power_score: 0.62 },
  strategyFitPacket: {
    best_current_posture: "stabilize",
    candidate_lines: [{ line: "测试阵容", combined_fit_score: 0.71 }],
    equipment_fit: { token_count: 3 },
    latest_user_intent_fit: { target_alignment: "no_user_target_declared" },
  },
  targetContextAuthority: "none",
};

const result = buildCruiseIntegratedDecision(input);

assert.equal(result.schema, "jcc-cruise-integrated-decision-v1");
assert.equal(result.authority.final_answer_owner, "host_cli_agent");
assert.equal(result.authority.deterministic_output_role, "structured_decision_evidence_only");
assert.deepEqual(result.feature_projection.board.role_coverage, {
  frontline: 1,
  backline: 1,
  support: 0,
  tank: 1,
  ad: 0,
  ap: 1,
  mixed: 0,
});
assert.equal(result.feature_projection.board.star_summary.two_star, 2);
assert.equal(result.feature_projection.equipment.confirmed_holder_count, 2);
assert.equal(result.feature_projection.equipment.item_bench_count, 1);
assert.equal(result.active_effect_ledger.length, 5);
const delayedEffect = result.active_effect_ledger.find((effect) => effect.source_id === "augment-delay");
const immediateEffect = result.active_effect_ledger.find((effect) => effect.source_id === "augment-now");
assert.equal(delayedEffect.resolution_status, "resolved_active_core_profile");
assert.equal(delayedEffect.applicability_status, "pending_typed_match_lifecycle");
assert(!delayedEffect.missing_context_fields.includes("board_power_score"));
assert.equal(immediateEffect.applicability_status, "applicable");
assert(result.effective_feature_overlays.includes("effect.team_power"));
assert(!result.effective_feature_overlays.includes("risk.delayed_payout"));
assert(!JSON.stringify(result).includes("异局"));
assert(result.action_options.some((option) => option.operation === "stabilize_board"));
assert(result.action_options.some((option) => option.operation === "protect_pending_payout"));
assert(!result.action_options.some((option) => option.operation === "hold_economy"));
assert(result.decision_plan.suppressed_actions.some((option) => option.operation === "hold_economy"));
const stabilize = result.action_options.find((option) => option.operation === "stabilize_board");
assert.deepEqual(stabilize.contributing_routes.sort(), ["economy", "lineup_execution"]);
assert(result.action_options.every((option) => option.snapshot_id === result.resolved_snapshot_identity.snapshot_id));
assert(result.conflicts.some((conflict) => conflict.kind === "delayed_payout_under_survival_pressure"));
assert(result.conflicts.some((conflict) => conflict.kind === "mutually_exclusive_actions"));
assert.equal(result.evidence_packet.snapshot_identity.snapshot_id, result.resolved_snapshot_identity.snapshot_id);
assert(result.evidence_packet.selected_actions.length <= 4);
assert(result.evidence_packet.suppressed_actions.length <= 4);
assert(!Object.hasOwn(result.evidence_packet, "live_state"));
assert(!Object.hasOwn(result.evidence_packet, "ranking_payload"));
assert.equal(result.policy.no_sixth_lineup_score_channel, true);
assert.equal(result.policy.run_only_relevant_domain_evaluators, true);
assert.equal(result.policy.single_host_answer, true);
assert(!JSON.stringify(result).includes("S17"));
assert(!JSON.stringify(result).includes("S18"));

const reversed = buildCruiseIntegratedDecision({
  ...input,
  economicDecisionContext: {
    ...input.economicDecisionContext,
    actions: [...input.economicDecisionContext.actions].reverse(),
  },
});
assert.deepEqual(
  reversed.decision_plan.selected_actions.map((option) => option.action_id),
  result.decision_plan.selected_actions.map((option) => option.action_id),
);
assert.deepEqual(reversed.decision_plan.suppressed_actions, result.decision_plan.suppressed_actions);

const invertedRouteScores = buildCruiseIntegratedDecision({
  ...input,
  economicDecisionContext: {
    ...input.economicDecisionContext,
    actions: input.economicDecisionContext.actions.map((action) => ({
      ...action,
      score: action.action === "hold_gold_interest" ? 0.01 : 99,
      confidence: action.action === "hold_gold_interest" ? "low" : "high",
    })),
  },
});
assert.deepEqual(
  invertedRouteScores.decision_plan.selected_actions.map((option) => option.action_id),
  result.decision_plan.selected_actions.map((option) => option.action_id),
);

const unknownLifecycle = buildCruiseIntegratedDecision({
  ...input,
  confirmedChoices: input.confirmedChoices.map((choice) => choice.selected_id === "augment-delay"
    ? { ...choice, remaining_rounds: null }
    : choice),
});
assert.equal(
  unknownLifecycle.active_effect_ledger.find((effect) => effect.source_id === "augment-delay").applicability_status,
  "unresolved_lifecycle",
);
assert(!unknownLifecycle.action_options.some((option) => option.operation === "protect_pending_payout"));

const resolvedLifecycle = buildCruiseIntegratedDecision({
  ...input,
  confirmedChoices: input.confirmedChoices.map((choice) => choice.selected_id === "augment-delay"
    ? { ...choice, remaining_rounds: 0 }
    : choice),
});
assert.equal(
  resolvedLifecycle.active_effect_ledger.find((effect) => effect.source_id === "augment-delay").lifecycle_state,
  "resolved",
);
assert(!resolvedLifecycle.action_options.some((option) => option.operation === "protect_pending_payout"));

const missingCombatCap = buildCruiseIntegratedDecision({ ...input, combatCapContext: {} });
assert(missingCombatCap.active_effect_ledger
  .find((effect) => effect.source_id === "augment-delay")
  .missing_context_fields.includes("board_power_score"));

const unknownChoice = buildCruiseIntegratedDecision({
  framework,
  orchestrationContract,
  semanticFeatureIndex,
  augmentSemanticProfiles,
  matchSessionId: "match-unknown",
  stageRound: "2-2",
  economy: { hp: 100, gold: 10, level: 4 },
  currentBoardShopBench: { board_units: [], bench_units: [], shop_units: [], active_traits: [] },
  equipment: {},
  confirmedChoices: [{ kind: "augment", selected: "未解析强化", selected_id: "missing" }],
  economicDecisionContext: { status: "ready", actions: [] },
  strategyFitPacket: null,
  targetContextAuthority: "none",
});
assert.equal(unknownChoice.active_effect_ledger[0].resolution_status, "unresolved_current_core_profile");
assert(unknownChoice.missing_facts.some((entry) => entry.field === "confirmed_choice_profile"));

const invalidLifecycle = buildCruiseIntegratedDecision({
  ...input,
  confirmedChoices: input.confirmedChoices.map((choice) => choice.selected_id === "augment-delay"
    ? { ...choice, remaining_rounds: null, effect_lifecycle_state: "probably_pending" }
    : choice),
});
assert.equal(
  invalidLifecycle.active_effect_ledger.find((effect) => effect.source_id === "augment-delay").lifecycle_state,
  "unresolved",
);
assert(!invalidLifecycle.action_options.some((option) => option.operation === "protect_pending_payout"));

const timings = [];
for (let index = 0; index < 100; index += 1) {
  const startedAt = performance.now();
  buildCruiseIntegratedDecision(input);
  timings.push(performance.now() - startedAt);
}
timings.sort((left, right) => left - right);
const p95Ms = timings[Math.floor(timings.length * 0.95)];
assert(p95Ms < Number(orchestrationContract.performance_budget.local_decision_total_p95_ms));

console.log(JSON.stringify({
  ok: true,
  status: "ok",
  schema: result.schema,
  selected_action_count: result.action_options.length,
  suppressed_action_count: result.decision_plan.suppressed_actions.length,
  conflict_count: result.conflicts.length,
  active_effect_count: result.active_effect_ledger.length,
  local_decision_p95_ms: Number(p95Ms.toFixed(3)),
}, null, 2));
