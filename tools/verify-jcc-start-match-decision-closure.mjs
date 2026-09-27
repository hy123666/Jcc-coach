#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  compactChoiceCandidatesForTurn,
  compactChoiceConfirmationsForDecision,
  compactCurrentBoardForDecision,
  compactLiveStateForHost,
  explicitTargetPlanFromUserMessage,
  hostRequestRequiresAugmentRefreshDecision,
} from "../ui/electron/runtime-service.js";
import { lineupPinnedResultMinimumUnitCount } from "../ui/electron/lineup-card-contract.js";

const durableTarget = explicitTargetPlanFromUserMessage("我这把不是已经跟你确定六护卫蛇女了吗？");
assert.equal(durableTarget?.name, "六护卫蛇女", "explicit target confirmation must become a clean durable target name");
assert.equal(durableTarget?.authority, "durable_target_plan", "explicit target confirmation must carry durable authority");
assert.equal(explicitTargetPlanFromUserMessage("给我三套当前版本阵容方向"), null, "an exploratory question must not become a durable target");

const choices = compactChoiceCandidatesForTurn({
  schema: "jcc-choice-v1",
  candidates: [{
    name: "女巫使魔",
    description: "每达到里程碑就获得当前版本的对应奖励。",
    rounds: ["2-1"],
    tags: ["economy", "flexibility"],
  }],
});
assert.equal(choices.candidates[0].description, "每达到里程碑就获得当前版本的对应奖励。", "choice description must reach the Host turn");
assert.deepEqual(choices.candidates[0].rounds, ["2-1"], "choice stage evidence must reach the Host turn");

const confirmation = compactChoiceConfirmationsForDecision({
  choice_confirmations: [{
    kind: "augment",
    choice_stage_round: "2-1",
    selected: "女巫使魔",
    selected_candidate_metadata: { description: "已确认的当前版本强化效果。", tier: "2", tier_color: "gold", tags: ["economy"] },
  }],
});
assert.equal(confirmation[0].description, "已确认的当前版本强化效果。", "confirmed choice must retain its effect description");
assert.equal(confirmation[0].tier_color, "gold", "confirmed augment tier must remain available for the next-choice forecast");

const retainedAugments = compactChoiceConfirmationsForDecision({
  choice_confirmations: [
    { kind: "augment", choice_stage_round: "2-1", selected: "old-history-copy" },
    ...Array.from({ length: 20 }, (_, index) => ({
      kind: "item_choice",
      choice_stage_round: `4-${index + 1}`,
      selected: `recent-event-${index + 1}`,
    })),
  ],
  augments: {
    selected_augments: [
      { kind: "augment", choice_stage_round: "2-1", selected: "强化一", selected_id: "augment:1" },
      { kind: "augment", choice_stage_round: "3-2", selected: "强化二", selected_id: "augment:2" },
      { kind: "augment", choice_stage_round: "4-2", selected: "强化三", selected_id: "augment:3" },
    ],
  },
});
assert.deepEqual(
  retainedAugments.filter((entry) => entry.kind === "augment").map((entry) => entry.selected),
  ["强化一", "强化二", "强化三"],
  "all durable augments must survive mixed-event history caps",
);
assert.deepEqual(
  retainedAugments.filter((entry) => entry.kind === "item_choice").map((entry) => entry.selected),
  Array.from({ length: 6 }, (_, index) => `recent-event-${index + 15}`),
  "only recent non-durable choice events should be capped",
);

const board = compactCurrentBoardForDecision({
  own_board: { units: [{ name: "卡西奥佩娅" }] },
  own_bench: { units: [{ name: "拉露恩" }] },
  data_quality: {
    current_board: { status: "observed_non_empty", usable_for: "current_fact" },
    current_bench: { status: "observed_non_empty", usable_for: "current_fact" },
  },
});
assert.equal(board.location_evidence.board.status, "observed_non_empty", "board location quality must be explicit");
assert.match(board.location_evidence.policy, /stale_reference.*conditional/i, "stale locations must not authorize move instructions");

const mumuHostSummary = compactLiveStateForHost({
  schema: "jcc-cruise-runtime-live-state-from-mumu-watch-v1",
  board: {
    local_board_units_candidate: [{ name: "卡西奥佩娅" }, { name: "艾翁" }],
    field_status: {
      status: "candidate",
      promotion_policy: "shop_self_view_anchor_plus_fresh_current_view",
      shop_anchor_fresh: true,
    },
  },
  bench: { bench_units: [{ name: "拉露恩" }] },
  traits: { active_traits: [{ name: "魔女", count: 3 }] },
});
assert.deepEqual(mumuHostSummary.own_board.units.map((unit) => unit.name), ["卡西奥佩娅", "艾翁"], "MuMu promoted board units must reach the Host summary");
assert.equal(mumuHostSummary.own_bench.units[0].name, "拉露恩", "MuMu bench units must remain separate from the promoted board");
assert.equal(mumuHostSummary.data_quality.current_board.status, "observed_non_empty", "a promoted MuMu board must not degrade to an unobserved empty board");
assert.equal(mumuHostSummary.traits.active_traits[0].name, "魔女", "traits derived from the same promoted board snapshot must reach the Host");

assert.equal(hostRequestRequiresAugmentRefreshDecision({
  mode: "augment_choice",
  runtime_event_context: { decision_domain: "equipment", user_message_kind: "structured_equipment_advice" },
  choices: { candidates: [{ name: "a" }, { name: "b" }, { name: "c" }] },
}), false, "equipment advice must never enter augment refresh evaluation");
assert.equal(lineupPinnedResultMinimumUnitCount(
  { slot: "lineup", title: "10峡谷野怪最终阵容" },
  { user_message: "把10峡谷野怪放到阵容图里面" },
), 10, "trait breakpoint requests must require the target population on the final card");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-start-match-decision-closure-verification-v1",
  checked: [
    "explicit durable target promotion",
    "exploratory intent remains provisional",
    "augment descriptions and stages reach Host",
    "confirmed augment effects persist",
    "durable augments survive mixed-event history caps",
    "board and bench location quality is explicit",
    "MuMu promoted board and same-snapshot traits reach Host",
    "equipment domain is isolated from augment evaluation",
    "trait breakpoint enforces final card population",
  ],
}, null, 2));
