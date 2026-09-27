#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cruiseCheckpointAgendaSnapshot,
  cruiseCheckpointBlockSnapshot,
  cruiseConditionalCheckpointSnapshot,
  cruiseCheckpointForStage,
  cruiseRecoveryPolicyForStage,
  cruiseRecoveryPolicyMatchesObligation,
  cruiseRecoveryStageSnapshot,
  isCruiseFixedCheckpointStage,
  CRUISE_CHECKPOINT_AGENDA_SCHEMA,
} from "../ui/electron/cruise-checkpoint-agenda.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
const agenda = cruiseCheckpointAgendaSnapshot();
const runtimeModeContract = readJson("data/runtime/jcc/runtime-ui-mode-contract.json");
const strategyContract = readJson("data/runtime/jcc/cruise-strategy-semantics-contract.json");
const commonFramework = readJson("data/game-knowledge/jcc/common/cruise-decision-framework.json");
const runtimeAgenda = runtimeModeContract.cruise_mode_policy.fixed_checkpoint_agenda;
const strategyAgenda = strategyContract.integrated_decision_orchestration.fixed_checkpoint_agenda;
const commonAgenda = commonFramework.entries.find((entry) => entry.id === "cruise.fixed_checkpoint_agenda");

assert.equal(runtimeAgenda.implementation, "ui/electron/cruise-checkpoint-agenda.js");
assert.equal(strategyAgenda.implementation, "ui/electron/cruise-checkpoint-agenda.js");
assert.equal(commonAgenda?.id, "cruise.fixed_checkpoint_agenda");
assert.equal(CRUISE_CHECKPOINT_AGENDA_SCHEMA, "jcc-cruise-fixed-checkpoint-agenda-v2");

const stageRounds = agenda.map((entry) => entry.stage_round);
const contractStages = runtimeAgenda.stages;
assert.deepEqual(contractStages, stageRounds, "runtime contract must publish the executable fixed checkpoint stages");
assert.deepEqual(strategyAgenda.checkpoint_stages, stageRounds, "strategy contract must publish the executable fixed checkpoint stages");
assert.deepEqual(commonAgenda.checkpoint_stages, stageRounds, "Common framework must publish the same checkpoint stages");

const recoveryStages = cruiseRecoveryStageSnapshot();
const runtimeRecoveryStages = runtimeAgenda.recovery_stages;
assert.deepEqual(runtimeRecoveryStages, recoveryStages, "runtime contract must publish executable recovery stages separately");
assert.deepEqual(strategyAgenda.recovery_stages, recoveryStages, "strategy contract must publish executable recovery stages separately");
assert.deepEqual(commonAgenda.recovery_stages, recoveryStages, "Common framework must publish executable recovery stages separately");
assert.equal(cruiseCheckpointForStage("2-5"), null, "2-5 must not resolve to a fixed checkpoint");
assert.equal(isCruiseFixedCheckpointStage("2-5"), false, "2-5 must not open a new fixed-checkpoint Host task");
const conditionalCheckpoints = cruiseConditionalCheckpointSnapshot();
assert.deepEqual(conditionalCheckpoints.map((entry) => entry.checkpoint_id), ["one_cost_reroll_window"]);
assert.equal(conditionalCheckpoints[0].activation_condition, "durable_target_or_retained_candidate_is_one_cost_reroll");
for (const checkpoint of [...agenda, ...conditionalCheckpoints]) {
  assert.equal(typeof checkpoint.answer_contract?.action_brief, "string", `${checkpoint.checkpoint_id} must provide an Action Brief`);
  assert(checkpoint.answer_contract.action_brief.length >= 40, `${checkpoint.checkpoint_id} Action Brief must be substantive`);
}
assert(!agenda.find((entry) => entry.stage_round === "2-2").answer_contract.action_brief.includes("2-7 四级搜牌窗口"),
  "2-2 must not duplicate the one-cost reroll window owned by 2-5");
assert.match(
  agenda.find((entry) => entry.stage_round === "2-2").answer_contract.action_brief,
  /至少 3 套.*不同.*真实.*候选/,
  "2-2 must ask for at least three distinct visible candidates when the source pool supports them",
);
assert.equal(
  agenda.find((entry) => entry.stage_round === "2-2").answer_contract.candidate_policy,
  "at_least_three_visible_candidates_when_supported",
  "2-2 candidate policy must distinguish visible breadth from the wider 5/10 working set",
);
assert(agenda.find((entry) => entry.stage_round === "2-7").answer_contract.action_brief.includes("完整六人口过渡阵容"),
  "2-7 must request complete level-six transitions for applicable retained directions");
assert(agenda.find((entry) => entry.stage_round === "3-5").answer_contract.action_brief.includes("七人口"),
  "3-5 must request the bound complete level-seven transition for four-cost and nine-five directions");
assert.deepEqual(cruiseRecoveryPolicyForStage("2-5"), {
  stage_round: "2-5",
  recovery_id: "recover_direction_exploration",
  strategy_block_id: "lineup_direction_commitment",
  recovers_checkpoint_ids: ["direction_exploration"],
  completion_policy: "pending_or_partial_only",
  host_task_policy: "recover_existing_or_add_conditional_window",
  conditional_windows: ["one_cost_reroll_window"],
  completed_source_policy: "silent_unless_a_registered_conditional_window_applies",
});
assert.equal(cruiseRecoveryPolicyMatchesObligation(
  cruiseRecoveryPolicyForStage("2-5"),
  { required_checkpoint_ids: ["direction_exploration"] },
), true, "the configured recovery stage must match its pending obligation");
assert.equal(cruiseRecoveryPolicyMatchesObligation(
  { stage_round: "9-9", recovers_checkpoint_ids: ["synthetic_future_checkpoint"] },
  { required_checkpoint_ids: ["synthetic_future_checkpoint"] },
), true, "recovery matching must be checkpoint-agnostic and reusable for future modules");
assert.equal(cruiseRecoveryPolicyMatchesObligation(
  { stage_round: "9-9", recovers_checkpoint_ids: ["synthetic_future_checkpoint"] },
  { required_checkpoint_ids: ["different_checkpoint"] },
), false, "a recovery stage must never absorb unrelated strategic debt");

const choiceWindows = ["2-1", "3-2", "4-2"];
assert.deepEqual(runtimeAgenda.choice_windows, choiceWindows);
assert.deepEqual(strategyAgenda.choice_windows, choiceWindows);
assert.deepEqual(commonAgenda.choice_windows, choiceWindows);

const foldedStages = { "4-4": "4-3", "5-4": "5-3", "6-4": "6-3" };
assert.deepEqual(runtimeAgenda.folded_stages, foldedStages);
assert.deepEqual(strategyAgenda.folded_stages, foldedStages);
assert.deepEqual(commonAgenda.folded_stages, foldedStages);

for (const stageRound of choiceWindows) {
  assert(!stageRounds.includes(stageRound), `${stageRound} choice window must not become a duplicate strategic checkpoint`);
}
for (const stageRound of Object.keys(foldedStages)) {
  assert(!stageRounds.includes(stageRound), `${stageRound} folded stage must not create a duplicate checkpoint`);
}

const checkpointByStage = new Map(agenda.map((entry) => [entry.stage_round, entry]));
assert.equal(checkpointByStage.get("2-2")?.strategy_block_id, "lineup_direction_commitment");
assert.equal(checkpointByStage.get("3-3")?.strategy_block_id, "lineup_direction_commitment");
assert.equal(checkpointByStage.get("4-3")?.strategy_block_id, "lineup_direction_commitment");
assert.equal(checkpointByStage.get("4-5")?.strategy_block_id, "formation_readiness_and_execution");
assert.equal(checkpointByStage.get("4-7"), undefined, "4-7 must not create a standalone equipment checkpoint");
assert.equal(checkpointByStage.get("5-1")?.strategy_block_id, "cap_floor_endgame");
assert.equal(checkpointByStage.get("6-3")?.strategy_block_id, "cap_floor_endgame");
assert.equal(checkpointByStage.get("2-2")?.block_sequence, 1);
  assert.equal(checkpointByStage.get("3-3")?.block_sequence, 3);
assert.equal(checkpointByStage.get("4-5")?.block_sequence, 3);
assert.equal(checkpointByStage.get("5-1")?.block_sequence, 1);
assert.equal(checkpointByStage.get("6-3")?.block_sequence, 5);
assert(checkpointByStage.get("3-7")?.answer_contract?.required_decisions.includes("current_item_holders_and_transfer_order"));
assert.equal(checkpointByStage.get("3-7")?.answer_contract?.equipment_policy,
  "review_existing_completed_items_and_transition_holders_before_stage_four; do not open a separate equipment checkpoint");
assert.equal(checkpointByStage.get("4-5")?.answer_contract?.primary_decision, "formation_readiness_and_directionality");

assert.deepEqual(
  cruiseCheckpointBlockSnapshot("lineup_direction_commitment").map((entry) => entry.stage_round),
  ["2-2", "2-7", "3-3", "4-3"],
  "the direction block must remain ordered from exploration to commitment",
);
assert.deepEqual(
  cruiseCheckpointBlockSnapshot("formation_readiness_and_execution").map((entry) => entry.stage_round),
  ["3-5", "3-7", "4-5"],
  "the formation block must include 3-7 equipment continuity and 4-5 readiness without a duplicate equipment checkpoint",
);
assert.deepEqual(
  cruiseCheckpointBlockSnapshot("cap_floor_endgame").map((entry) => entry.stage_round),
  ["5-1", "5-3", "5-7", "6-1", "6-3"],
  "the endgame block must remain the sole fixed late-game strategic sequence",
);

assert.equal(runtimeAgenda.primary_cadence, true);
assert.equal(strategyAgenda.primary_cadence, true);
assert.match(runtimeAgenda.policy, /ordinary automatic events are fact-only supporting evidence/);
assert.match(runtimeAgenda.recovery_policy, /2-5.*pending or partial 2-2/i);
assert.match(strategyAgenda.supporting_event_policy, /never open, preempt, or create a separate Host answer lane/);
assert.match(strategyAgenda.recovery_policy, /2-5.*one_cost_reroll_window/i);
assert.match(commonAgenda.policy, /Ordinary events.*supporting evidence/);
assert.match(commonAgenda.recovery_policy, /2-5.*one_cost_reroll_window/i);

console.log(JSON.stringify({
  schema: CRUISE_CHECKPOINT_AGENDA_SCHEMA,
  checkpoint_count: agenda.length,
  stages: stageRounds,
  choice_windows: choiceWindows,
  folded_stages: foldedStages,
  recovery_stages: recoveryStages,
  strategy_blocks: [...new Set(agenda.map((entry) => entry.strategy_block_id))],
  contracts_consistent: true,
}, null, 2));
