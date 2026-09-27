import assert from "node:assert/strict";
import { acceptanceReport, assertExpectedValidTask, journeyOptions, REQUIRED_JOURNEY_TURNS } from "./jcc-player-journey-acceptance.mjs";

const options = journeyOptions([], {});
for (const status of ["failed", "no_advice", "expired", "cancelled"]) {
  assert.throws(() => assertExpectedValidTask({ response_task_id: "task", revision: 1, status }, "valid fixture"));
}
assert.throws(() => assertExpectedValidTask({ response_task_id: "task", revision: 1, status: "completed", response: { final_text: " " } }, "empty", { completed: true }));
assert.throws(() => assertExpectedValidTask({ response_task_id: "task", revision: 1, status: "completed", response: { final_text: "body", strategy_selection: { status: "unavailable" } } }, "unavailable", { completed: true }));
const turns = REQUIRED_JOURNEY_TURNS.map((label) => ({ label, normalized: true, acknowledged: true, body_chars: 20, preparation_ms: 20, host_ms: 50_000, delivery_ms: 5, ack_ms: 5, real_host_dispatch: false }));
assert.equal(acceptanceReport(turns, options, 1000, 480_000).target_met, true);
const slow = turns.map((turn) => ({ ...turn, host_ms: 70_000 }));
assert.equal(acceptanceReport(slow, options, 1000, 480_000).perf, true);
assert.equal(acceptanceReport(slow, options, 1000, 480_000).target_met, false);
assert.equal(acceptanceReport(turns, options, 1000, 480_000).real_host_dispatch, false);
assert.throws(() => acceptanceReport(turns, { ...options, realHost: true }, 1000, 480_000), /validity/);
assert.throws(() => acceptanceReport(turns.slice(1), options, 1000, 480_000), /missing/);
assert.throws(() => acceptanceReport(turns.map((turn) => ({ ...turn, host_ms: 180_001 })), options, 1000, 480_000), /performance/);
assert.throws(() => acceptanceReport(turns.map((turn) => ({ ...turn, delivery_ms: 2_001 })), options, 1000, 480_000), /performance/);
assert.throws(() => acceptanceReport(turns.map((turn) => ({ ...turn, acknowledged: false })), options, 1000, 480_000), /validity/);
assert.throws(() => journeyOptions(["--unknown"], {}), /Unknown/);
assert.throws(() => journeyOptions([], { JCC_JOURNEY_HOST_LIMIT_MS: "NaN" }), /finite/);
console.log(JSON.stringify({ ok: true, checked: ["failed_and_no_advice_rejected", "empty_body_rejected", "unavailable_not_success", "all_required_entries", "60s_target_separate_from_180s_tolerance", "delivery_limit_separate_from_ack_limit", "missing_ack_rejected", "default_not_real_dispatch"] }));
