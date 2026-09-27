import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildStandardLiveState } from "./run-jcc-cruise-runtime-pipeline.mjs";

const root = path.resolve(import.meta.dirname, "..");

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function buildState(events, args = []) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-mumu-shop-anchor-guards-"));
  try {
    const eventsFile = path.join(tempDir, "events.jsonl");
    const outFile = path.join(tempDir, "live-state.json");
    await writeFile(eventsFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const result = await runNode([
      "tools/build-jcc-mumu-gi-live-state.mjs",
      "--events",
      eventsFile,
      "--out",
      outFile,
      ...args,
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return JSON.parse(await readFile(outFile, "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const legacyFlagResult = await runNode([
    "tools/build-jcc-mumu-gi-live-state.mjs",
    "--events",
    path.join(os.tmpdir(), "missing-events.jsonl"),
    "--self-view-anchor",
  ]);
  assert.notEqual(legacyFlagResult.code, 0, "legacy --self-view-anchor flag must be rejected");
  assert.match(legacyFlagResult.stderr || legacyFlagResult.stdout, /Unknown argument: --self-view-anchor/, "legacy self-view anchor rejection reason missing");

  const replayState = await buildState([
    { type: "mumu_gi_message", cmd: 4358, payload: { s: 1 }, observed_at: "2026-06-12T09:59:59.500Z", match_session_id: "match-replay", source_mode: "debug_replay" },
    { type: "mumu_gi_message", cmd: 4354, payload: { bl: [{ i: 11453 }] }, observed_at: "2026-06-12T10:00:00.000Z", match_session_id: "match-replay", source_mode: "debug_replay" },
    { type: "mumu_gi_message", cmd: 4353, payload: { hl: [{ i: 1451, x: 1, y: 1 }] }, observed_at: "2026-06-12T10:00:01.000Z", match_session_id: "match-replay", source_mode: "debug_replay" },
  ], ["--source-mode", "debug_replay"]);
  assert.notEqual(replayState.local.binding_status, "shop_self_view_anchor", "replay-like shop must not anchor self view");
  assert.equal(replayState.board.local_board_units_candidate.length, 0, "replay-like current view must not promote own board");
  assert(replayState.source_insights.rejected_events.some((event) => event.reason === "replay_or_observer_shop_cannot_anchor_self_view"), "replay shop rejection evidence missing");

  const crossMatchState = await buildState([
    { type: "mumu_gi_message", cmd: 4354, payload: { bl: [{ i: 11453 }] }, observed_at: "2026-06-12T10:00:00.000Z", match_session_id: "old-match" },
    { type: "mumu_gi_message", cmd: 4353, payload: { hl: [{ i: 1451, x: 1, y: 1 }] }, observed_at: "2026-06-12T10:00:01.000Z", match_session_id: "new-match" },
  ], ["--match-session-id", "new-match"]);
  assert.notEqual(crossMatchState.local.binding_status, "shop_self_view_anchor", "cross-match old shop must not anchor current match");
  assert.equal(crossMatchState.board.local_board_units_candidate.length, 0, "cross-match current view must not use old shop anchor");
  assert(crossMatchState.source_insights.rejected_events.some((event) => event.reason === "cross_match_event_rejected"), "cross-match rejection evidence missing");

  const missingS1State = await buildState([
    { type: "mumu_gi_message", cmd: 4354, payload: { bl: [{ i: 11453 }] }, observed_at: "2026-06-12T10:00:00.000Z", match_session_id: "match-no-s1" },
    { type: "mumu_gi_message", cmd: 4353, payload: { hl: [{ i: 1451, x: 1, y: 1 }] }, observed_at: "2026-06-12T10:00:01.000Z", match_session_id: "match-no-s1" },
  ], ["--match-session-id", "match-no-s1"]);
  assert.notEqual(missingS1State.local.binding_status, "shop_self_view_anchor", "4354 without S=1 must not anchor self view");
  assert.equal(missingS1State.board.local_board_units_candidate.length, 0, "4354 without S=1 must not promote own board");
  assert.equal(missingS1State.field_status["local.self_view_anchor"]?.reason, "requires_s1_plus_non_empty_4354_shop", "missing S=1 block reason missing");

  const staleState = await buildState([
    { type: "mumu_gi_message", cmd: 4358, payload: { s: 1 }, observed_at: "2026-06-12T09:59:59.500Z", match_session_id: "match-stale" },
    { type: "mumu_gi_message", cmd: 4354, payload: { bl: [{ i: 11453 }] }, observed_at: "2026-06-12T10:00:00.000Z", match_session_id: "match-stale" },
    { type: "mumu_gi_message", cmd: 4353, payload: { hl: [{ i: 1451, x: 1, y: 1 }] }, observed_at: "2026-06-12T10:02:31.000Z", match_session_id: "match-stale" },
  ], ["--match-session-id", "match-stale"]);
  assert.equal(staleState.local.binding_status, "shop_self_view_anchor", "fresh shop still records an anchor");
  assert.equal(staleState.board.local_board_units_candidate.length, 0, "stale shop anchor must not promote later current view");
  assert.equal(staleState.field_status["board.local_board_units_candidate"]?.promotion_block_reason, "shop_self_view_anchor_stale_or_missing_current_shop", "stale block reason missing");

  const heldState = await buildState([
    { type: "mumu_gi_message", cmd: 4358, payload: { s: 1 }, observed_at: "2026-06-12T10:00:00.000Z", match_session_id: "match-held" },
    { type: "mumu_gi_message", cmd: 4354, payload: { bl: [{ i: 11453 }] }, observed_at: "2026-06-12T10:00:00.500Z", match_session_id: "match-held" },
    { type: "mumu_gi_message", cmd: 4353, payload: { hl: [{ i: 11451, x: 1, y: 1 }] }, observed_at: "2026-06-12T10:00:01.000Z", match_session_id: "match-held" },
    { type: "mumu_gi_message", cmd: 4354, payload: { bl: [] }, observed_at: "2026-06-12T10:00:02.000Z", match_session_id: "match-held" },
  ], ["--match-session-id", "match-held"]);
  assert.equal(heldState.field_status["board.local_board_units_candidate"]?.status, "held_or_waiting", "invalidated self-view board must be held");
  assert.equal(heldState.board.local_board_units_candidate.length, 0, "held board rows must not remain exposed as the current observed board");
  assert.deepEqual(
    heldState.board.stale_local_board_units_reference?.units?.map((unit) => unit.base_hero_id),
    [11451],
    "the previously observed own board must remain available only as an explicit stale reference",
  );
  assert.equal(heldState.board.stale_local_board_units_reference?.reason, "shop_units_candidate", "stale board reference must record why promotion was held");
  assert.equal(heldState.current_view.derived_traits.length, 0, "stale board must clear current_view derived traits");
  assert.equal(heldState.traits.active_traits.length, 0, "stale board must clear active current traits");

  const heldRowsWithOldMarker = buildStandardLiveState({
    schema: "jcc-cruise-runtime-live-state-from-mumu-watch-v1",
    match_session_id: "match-held-standardization",
    board: {
      local_board_units_candidate: [{
        name: "OLD",
        semantic_status: "mumu_structured_self_view_anchor_candidate",
      }],
      stale_local_board_units_reference: { units: [{ name: "LAST_KNOWN_BOARD" }] },
      field_status: {
        status: "held_or_waiting",
        promotion_policy: "shop_self_view_anchor_plus_fresh_current_view",
        shop_anchor_fresh: false,
      },
    },
    bench: {
      bench_units: [{ name: "OLD_BENCH" }],
      stale_bench_units_reference: { units: [{ name: "LAST_KNOWN_BENCH" }] },
      field_status: { status: "held_or_waiting", promotion_policy: "s1_structured_bench_observation" },
    },
  }, {}, new Date("2026-06-12T10:03:00.000Z").toISOString());
  assert.deepEqual(heldRowsWithOldMarker.own_board.units, [], "held board status must override old row-level self-view markers");
  assert.deepEqual(heldRowsWithOldMarker.own_bench.units, [], "held bench rows must not be exposed as current observations");
  assert.equal(heldRowsWithOldMarker.data_quality.current_board.status, "stale_reference");
  assert.equal(heldRowsWithOldMarker.data_quality.current_bench.status, "stale_reference");
  assert.deepEqual(heldRowsWithOldMarker.data_quality.current_board.last_known_value, [{ name: "LAST_KNOWN_BOARD" }]);
  assert.deepEqual(heldRowsWithOldMarker.data_quality.current_bench.last_known_value, [{ name: "LAST_KNOWN_BENCH" }]);
  assert.equal(heldRowsWithOldMarker.data_quality.current_board.usable_for, "conditional_only");
  assert.equal(heldRowsWithOldMarker.data_quality.current_bench.usable_for, "conditional_only");
  assert.deepEqual(heldRowsWithOldMarker.own_board.last_known_value, [{ name: "LAST_KNOWN_BOARD" }]);
  assert.deepEqual(heldRowsWithOldMarker.own_bench.last_known_value, [{ name: "LAST_KNOWN_BENCH" }]);

  const qualityStates = {
    observedNonEmpty: buildStandardLiveState({
      board: { local_board_units_candidate: [{ name: "CURRENT_BOARD", semantic_status: "mumu_structured_self_view_anchor_candidate" }] },
      field_status: { "board.local_board_units_candidate": { status: "candidate", promotion_policy: "shop_self_view_anchor_plus_fresh_current_view", shop_anchor_fresh: true } },
    }, {}, new Date("2026-06-12T10:03:01.000Z").toISOString()),
    observedEmpty: buildStandardLiveState({
      board: { local_board_units_candidate: [] },
      field_status: { "board.local_board_units_candidate": { status: "observed_empty" } },
    }, {}, new Date("2026-06-12T10:03:02.000Z").toISOString()),
    notObserved: buildStandardLiveState({}, {}, new Date("2026-06-12T10:03:03.000Z").toISOString()),
    captureFailed: buildStandardLiveState({
      field_status: { "board.local_board_units_candidate": { status: "capture_failed" } },
    }, {}, new Date("2026-06-12T10:03:04.000Z").toISOString()),
  };
  assert.equal(qualityStates.observedNonEmpty.data_quality.current_board.status, "observed_non_empty");
  assert.equal(qualityStates.observedEmpty.data_quality.current_board.status, "observed_empty");
  assert.equal(qualityStates.notObserved.data_quality.current_board.status, "not_observed");
  assert.equal(qualityStates.captureFailed.data_quality.current_board.status, "capture_failed");

  const staleBenchState = await buildState([
    { type: "mumu_gi_message", cmd: 4358, payload: { s: 1 }, observed_at: "2026-06-12T11:00:00.000Z", match_session_id: "match-stale-bench" },
    { type: "mumu_gi_message", cmd: 4352, payload: { wl: [{ i: 11451 }] }, observed_at: "2026-06-12T11:00:01.000Z", match_session_id: "match-stale-bench" },
    { type: "mumu_gi_message", cmd: 4358, payload: { s: 2 }, observed_at: "2026-06-12T11:00:02.000Z", match_session_id: "match-stale-bench" },
    { type: "mumu_gi_message", cmd: 4352, payload: { wl: [{ i: 11453 }] }, observed_at: "2026-06-12T11:00:03.000Z", match_session_id: "match-stale-bench" },
  ], ["--match-session-id", "match-stale-bench"]);
  assert.deepEqual(staleBenchState.bench.bench_units, [], "a non-S1 bench packet must invalidate the current bench observation");
  assert.deepEqual(
    staleBenchState.bench.stale_bench_units_reference?.units?.map((unit) => unit.base_hero_id),
    [11451],
    "the last S1 bench may survive only as an explicit stale reference",
  );
  assert.equal(staleBenchState.field_status["bench.bench_units"]?.status, "held_or_waiting");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "replay-like 4354 shop does not establish self-view anchor",
      "cross-match 4354 shop is rejected before anchoring",
      "legacy --self-view-anchor cannot promote 4353 without S=1 plus 4354 shop evidence",
      "4354 without S=1 does not establish self-view anchor",
      "stale shop anchor does not promote later current_view",
      "held self-view board is removed from current observation and preserved as an explicit stale reference",
      "stale board synchronously clears derived/current traits",
      "held status overrides stale row-level self-view markers during standardization",
      "offline standardization emits Electron-compatible five-state board and bench data quality",
      "non-S1 bench observations invalidate current rows and preserve only a stale reference",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
