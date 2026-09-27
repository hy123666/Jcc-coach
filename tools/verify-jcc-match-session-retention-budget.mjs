import { readFile } from "node:fs/promises";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

const contract = await readJson("data/runtime/jcc/match-session-retention-budget-contract.json");
assert(contract.schema === "jcc-match-session-retention-budget-contract-v1", "retention budget contract schema mismatch");
assert(contract.budgets.active_match_structured_state_target_mb <= 10, "active match target budget too large");
assert(contract.budgets.active_match_structured_state_hard_fail_mb <= 50, "active match hard fail budget too large");
assert(contract.default_retention.store_raw_screenshots === false, "raw screenshots must not be stored by default");
assert(contract.default_retention.store_full_live_state_every_tick === false, "full live_state every tick must not be stored");
assert(contract.default_retention.store_backend_drafts_as_final_advice === false, "backend drafts must not be final advice");
assert(contract.default_retention.allow_transient_visual_frame_until_host_response === true, "host visual input may be transient only");
assert(contract.default_retention.transient_visual_frame_ttl_ms <= 300000, "transient visual frame TTL must stay short");
assert(contract.bounded_match_state.output_events_max <= 200, "output event bound too high");
assert(contract.bounded_match_state.manual_scouting_notes_max <= 20, "manual scouting note bound too high");
assert(contract.bounded_match_state.postgame_recent_match_summaries_max === 20, "postgame recent summaries must be 20");

const pipeline = await readFile("tools/run-jcc-cruise-runtime-pipeline.mjs", "utf8");
assert(pipeline.includes("--retain-full-state"), "pipeline must keep full-state retention behind explicit flag");
assert(pipeline.includes("schema: \"jcc-cruise-runtime-pipeline-result-redacted-v1\""), "pipeline must emit redacted live_state by default");
assert(pipeline.includes("standardized_live_state_summary"), "pipeline must replace full live_state with a compact summary by default");
assert(pipeline.includes("slice(-100)"), "pipeline must bound lifecycle arrays at 100");
assert(pipeline.includes("slice(-200)"), "pipeline must bound emitted/output arrays at 200");
assert(pipeline.includes("manual_scouting_notes = asArray(lifecycle.match_context.manual_scouting_notes).slice(-20)"), "manual scouting notes must rotate at 20");
assert(!pipeline.includes("opponent_lobby_scans"), "pipeline must not retain removed opponent lobby scan state");

const watcher = await readFile("tools/watch-jcc-mumu-runtime-logcat.mjs", "utf8");
assert(watcher.includes("It does not save screenshots or full raw logs."), "structured MuMu watcher must declare that it does not retain screenshots");
assert(watcher.includes("screenshots_saved: false"), "structured MuMu watcher summary must report zero retained screenshots");
assert(!watcher.includes("capture-jcc-visual-frame.mjs"), "structured MuMu watcher must not own visual frame capture");
assert(!watcher.includes("pending-visual-requests.json"), "structured MuMu watcher must not schedule visual fallback work");

const pendingVisual = await readFile("tools/run-jcc-pending-visual-request.mjs", "utf8");
assert(pendingVisual.includes("removeTransientFrameAfterResponse"), "pending visual runner must delete consumed transient frames");
assert(pendingVisual.includes("removeBurstImagesAfterResponse"), "pending visual runner must delete consumed burst images");

const runtimeService = await readFile("ui/electron/runtime-service.js", "utf8");
assert(runtimeService.includes("cleanupPreparedVisualArtifacts"), "runtime-service must clean abandoned prepared visual frames");
assert(runtimeService.includes("host_visual_request_stale_timeout"), "runtime-service must clean visual frames when host visual work times out");
assert(runtimeService.includes("host_visual_request_failed"), "runtime-service must clean visual frames when the host visual request fails");

const postgame = await readFile("tools/write-jcc-postgame-summary.mjs", "utf8");
assert(postgame.includes("store_raw_screenshots: false"), "postgame writer must not store screenshots");
assert(postgame.includes("store_full_raw_logs: false"), "postgame writer must not store full raw logs");
assert(postgame.includes("store_full_live_state: false"), "postgame writer must not store full live_state");
assert(postgame.includes("options.max"), "postgame writer must support max retention");
assert(postgame.includes("slice(-80)") && postgame.includes("slice(-20)"), "postgame writer must compact decision summaries");

const visualContract = await readJson("data/runtime/jcc/visual-live-state-contract.json");
assert(
  /delete transient raw frames|delete transient/i.test(JSON.stringify(visualContract)),
  "visual contract must require transient frame deletion",
);

console.log(JSON.stringify({
  ok: true,
  budgets: contract.budgets,
  bounded_match_state: contract.bounded_match_state,
  checked: [
    "pipeline redacts full live_state by default",
    "pipeline lifecycle arrays are bounded",
    "postgame summaries are structured and rotated",
    "structured watcher stores no screenshots; explicit visual fallback frames are transient and TTL-cleaned",
    "opponent scan status is not final coach text",
  ],
}, null, 2));
