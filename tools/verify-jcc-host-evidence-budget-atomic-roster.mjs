import assert from "node:assert/strict";
import { enforceHostTurnDeltaBudget } from "../ui/electron/runtime-service.js";

const candidate = (id, observationValue, statisticsValue) => ({
  candidate_id: `candidate-${id}`,
  selected_variant_id: `variant-${id}`,
  candidate_evidence_id: `evidence-${id}`,
  atomic_roster_id: `roster-${id}`,
  roster_is_atomic: true,
  lineup_names: ["主C", "主坦", "功能位"],
  atomic_roster_members: [{ champion_id: "carry", champion_name: "主C" }],
  main_carry: "主C",
  primary_tank: "主坦",
  canonical_variant: {
    variant_id: `variant-${id}`,
    candidate_evidence_id: `evidence-${id}`,
    atomic_roster_id: `roster-${id}`,
    roster_is_atomic: true,
    lineup_names: ["主C", "主坦", "功能位"],
    atomic_roster_members: [{ champion_id: "carry", champion_name: "主C" }],
    atomic_roster_observation: observationValue,
    atomic_roster_statistics: statisticsValue,
  },
});

const observation = { observed_match_count: 123, top4_rate: 0.61 };
const statistics = { use_num: 456, use_rate: 0.12, top4_rate: 0.63 };
const delta = {
  schema: "jcc-host-turn-delta-v1",
  request_id: "atomic-roster-budget",
  request_hash: "atomic-roster-budget",
  request_kind: "host_question",
  mode: "cruise",
  task: { semantic_labels: ["persistent_strategic_obligation_queue"] },
  user_message: "验证原子阵容证据预算",
  payload: "x".repeat(1024 * 1024),
  runtime_context: {
    strategic_obligation: {
      completion_receipts: [{ block_id: "lineup_direction_commitment", revision: 1, latest_checkpoint_id: "direction_exploration" }],
    },
    strategy_fit_packet: {
      strategic_checkpoint: { checkpoint_id: "direction_exploration" },
      candidate_working_set: [
        candidate("both", observation, statistics),
        candidate("missing-observation", null, statistics),
      ],
    },
  },
};

const bounded = enforceHostTurnDeltaBudget(delta, 96 * 1024);
const retained = bounded.runtime_context.strategy_fit_packet.candidate_working_set;
assert.equal(retained.length, 2);
assert.deepEqual(retained[0].canonical_variant.atomic_roster_observation, observation);
assert.deepEqual(retained[0].canonical_variant.atomic_roster_statistics, statistics);
assert.equal(retained[1].canonical_variant.atomic_roster_observation, null);
assert.deepEqual(retained[1].canonical_variant.atomic_roster_statistics, statistics);
assert.deepEqual(retained[0].atomic_roster_observation, observation);
assert.deepEqual(retained[0].atomic_roster_statistics, statistics);
assert.equal(retained[1].atomic_roster_observation, null);
assert.deepEqual(retained[1].atomic_roster_statistics, statistics);

console.log(JSON.stringify({ ok: true, schema: "jcc-host-evidence-budget-atomic-roster-verification-v1" }, null, 2));
