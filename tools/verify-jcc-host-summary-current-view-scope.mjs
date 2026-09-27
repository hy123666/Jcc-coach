import assert from "node:assert/strict";
import { compactLiveStateForHost } from "../ui/electron/runtime-service.js";

function main() {
  const summary = compactLiveStateForHost({
    schema: "jcc-cruise-live-state-verify-v1",
    match_session_id: "summary-scope",
    current_view: {
      filtered_units: [
        { name: "Opponent Unit", position: { x: 1, y: 1 } },
      ],
    },
    field_status: {
      "board.local_board_units_candidate": {
        status: "blocked",
        promotion_policy: "shop_self_view_anchor_plus_fresh_current_view",
      },
    },
  });

  assert.equal(summary.own_board.units.length, 0, "host summary must not promote current_view into own_board");
  assert.equal(summary.current_view.units_candidate.length, 0, "host summary must not expose current_view unit candidates to the host model");
  assert.equal(summary.current_view.scope, null, "current_view scope should stay null when only diagnostic units are present");
  assert.match(summary.current_view.policy, /not exposed to the host model/, "current_view host policy marker missing");

  const staleBoardSummary = compactLiveStateForHost({
    schema: "jcc-cruise-live-state-verify-v1",
    match_session_id: "summary-stale-board",
    board: {
      local_board_units_candidate: [],
      stale_local_board_units_reference: {
        units: [{ name: "上一帧棋子", base_hero_id: 1451 }],
        reason: "shop_anchor_expired",
      },
    },
    field_status: {
      "board.local_board_units_candidate": {
        status: "held_or_waiting",
        source: "mumu",
      },
    },
  });
  assert.equal(staleBoardSummary.own_board.units.length, 0, "a stale board must not be exposed as the current board");
  assert.equal(staleBoardSummary.data_quality.current_board.status, "stale_reference");
  assert.equal(staleBoardSummary.data_quality.current_board.usable_for, "conditional_only");
  assert.equal(staleBoardSummary.data_quality.current_board.last_known_value[0].name, "上一帧棋子");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "current_view candidates are not summarized as own_board",
      "current_view diagnostic units are hidden from host-visible selected context",
      "held MuMu board state is exposed only as a conditional stale reference",
    ],
  }, null, 2));
}

main();
