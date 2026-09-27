import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";

const source = await readFile(new URL("../ui/electron/runtime-service.js", import.meta.url), "utf8");
function section(start, end) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin);
  assert(begin >= 0 && finish > begin, `missing production boundary: ${start}`);
  return source.slice(begin, finish);
}
const now = 2_000_000;
const calls = [];
const sandbox = {
  process: { env: {} },
  Date: class extends Date { static now() { return now; } },
  state: { match_session: { status: "active", match_session_id: "isolated-match" }, active_mode: "cruise" },
  backgroundSelfStateRefreshPromise: null,
  BACKGROUND_SELF_STATE_REFRESH_INTERVAL_MS: 999999,
  BACKGROUND_SELF_STATE_REFRESH_STARVATION_MS: 30000,
  expireStaleBackgroundSelfStateRefresh() {},
  foregroundAugmentQuickOcrReservationActive: () => false,
  hasForegroundVisualOrResponseInFlight: () => false,
  randomUUID() { calls.push("uuid"); return "test-run"; },
  runBackgroundSelfStateRefresh() { calls.push("background"); return Promise.resolve(); },
  resolveActiveLiveStateForRuntime() { calls.push("resolve"); return Promise.resolve({}); },
  ensureDir() { calls.push("mkdir"); },
  pruneRuntimeSensingArtifactDirectory() { calls.push("prune"); },
  selectedAdbTargetSerial: () => "127.0.0.1:16384",
  uiRuntimeDir: "/unused-test-runtime",
  SENSING_ARTIFACT_MAX_FILES: 1,
  SENSING_ARTIFACT_MAX_AGE_MS: 1,
  path,
  recordRuntimeEvent() {},
  async getSelfStateRoiOcrWorker() { calls.push("worker"); return {}; },
  async runSelfStateRoiOcrWithWorker() { calls.push("resident_capture"); return { ok: false, status: "test_no_fields" }; },
  async runNodeTool() { calls.push("cold_capture"); return { ok: false, status: "test_no_fields" }; },
  selfStateRoiOcrWorkerState: { ready: {} },
  selfStateRoiOcrHasFields: () => false,
};
vm.createContext(sandbox);
vm.runInContext([
  section("function shouldRunBackgroundSelfStateRefresh(", "function foregroundAugmentQuickOcrReservationActive("),
  section("function startBackgroundSelfStateRefresh(", "async function "),
  section("async function runSelfStateRoiOcr(", "async function runLeftItemRailRoiIconRefresh("),
].join("\n"), sandbox);

sandbox.process.env.JCC_DISABLE_RESIDENT_SELF_STATE_ROI_OCR = "1";
sandbox.process.env.JCC_ALLOW_COLD_SELF_STATE_ROI_OCR_FALLBACK = "0";
const disabled = await sandbox.runSelfStateRoiOcr("isolation-test");
assert.equal(disabled.status, "resident_worker_disabled_no_cold_fallback");
assert.equal(disabled.ok, false);
assert.deepEqual(calls, [], "disabled capture must return before resolving state, filesystem work or capture, even with an ADB target");
delete sandbox.process.env.JCC_ALLOW_COLD_SELF_STATE_ROI_OCR_FALLBACK;
assert.equal((await sandbox.runSelfStateRoiOcr()).status, "resident_worker_disabled_no_cold_fallback");
assert.deepEqual(calls, []);
sandbox.process.env.JCC_ALLOW_COLD_SELF_STATE_ROI_OCR_FALLBACK = "1";
await sandbox.runSelfStateRoiOcr();
assert(calls.includes("cold_capture"), "explicit cold opt-in must remain usable");
assert(!calls.includes("resident_capture"));
calls.length = 0;
sandbox.process.env.JCC_DISABLE_RESIDENT_SELF_STATE_ROI_OCR = "0";
sandbox.process.env.JCC_ALLOW_COLD_SELF_STATE_ROI_OCR_FALLBACK = "0";
await sandbox.runSelfStateRoiOcr();
assert(calls.includes("resident_capture"), "enabled resident path must remain usable");
assert(!calls.includes("cold_capture"));
calls.length = 0;

sandbox.state.self_state_refresh = { last_completed_at: new Date(0).toISOString() };
assert.equal(sandbox.shouldRunBackgroundSelfStateRefresh(), true, "elapsed interval normally admits refresh");
sandbox.process.env.JCC_UI_DISABLE_BACKGROUND_SELF_STATE_REFRESH = "1";
assert.equal(sandbox.shouldRunBackgroundSelfStateRefresh(), false, "explicit disable must survive a long journey");
assert.equal(sandbox.startBackgroundSelfStateRefresh(), null);
assert.equal(sandbox.startBackgroundSelfStateRefresh("forced-background", { force: true }), null);
assert.deepEqual(calls, [], "disabled background entry must not create a run");
assert.equal(sandbox.shouldRunBackgroundSelfStateRefresh({ force: true }), true, "explicit manual refresh retains its separate force path");
delete sandbox.process.env.JCC_UI_DISABLE_BACKGROUND_SELF_STATE_REFRESH;
assert.equal(sandbox.shouldRunBackgroundSelfStateRefresh(), true);
sandbox.state.self_state_refresh = {
  status: "failed",
  last_completed_at: new Date(0).toISOString(),
  last_started_at: new Date(now - 1000).toISOString(),
};
assert.equal(sandbox.shouldRunBackgroundSelfStateRefresh(), false, "recent failed attempt must cool down despite old success");
sandbox.state.self_state_refresh.last_started_at = new Date(now - 999999).toISOString();
assert.equal(sandbox.shouldRunBackgroundSelfStateRefresh(), true, "retry resumes at the exact interval boundary");
sandbox.state.self_state_refresh.last_completed_at = new Date(now - 100).toISOString();
assert.equal(sandbox.shouldRunBackgroundSelfStateRefresh(), false, "newer completion also extends cooldown");
sandbox.state.self_state_refresh = { last_started_at: "invalid", last_completed_at: "invalid" };
assert.equal(sandbox.shouldRunBackgroundSelfStateRefresh(), true, "invalid timestamps must not block refresh forever");
sandbox.backgroundSelfStateRefreshPromise = Promise.resolve();
assert.equal(sandbox.shouldRunBackgroundSelfStateRefresh({ force: true }), false, "force must preserve single-flight ownership");
console.log(JSON.stringify({ ok: true, schema: "jcc-self-state-refresh-isolation-verifier-v1", checked: [
  "disabled_resident_and_cold_never_capture", "cold_opt_in_preserved", "resident_path_preserved",
  "background_disable_survives_elapsed_interval_and_force", "manual_force_preserved",
  "failed_attempt_cooldown", "cooldown_boundary", "newer_completion_cooldown", "invalid_timestamps", "single_flight",
] }, null, 2));
