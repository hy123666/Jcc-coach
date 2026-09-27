import { readFile } from "node:fs/promises";

const DEFAULT_LIVE_STATE = ".omx/runtime-evidence/android-probe-ingame-20260605-214908/match-live-state.json";
const DEFAULT_SIGNALS = ".omx/runtime-evidence/android-probe-ingame-20260605-214908/candidate-runtime-signals.json";

function parseArgs(argv) {
  const options = { liveState: DEFAULT_LIVE_STATE, signals: DEFAULT_SIGNALS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--live-state") options.liveState = argv[++index];
    else if (arg === "--signals") options.signals = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-carousel-active-candidate.mjs [--live-state <match-live-state.json>] [--signals <candidate-runtime-signals.json>]",
    "",
    "Verifies draft-turn evidence is surfaced as a carousel.active candidate without promoting pick/unit details.",
  ].join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const snapshot = JSON.parse(await readFile(options.liveState, "utf8"));
  const signalReport = JSON.parse(await readFile(options.signals, "utf8"));
  const liveState = snapshot.live_state || {};
  const signals = signalReport.signals || [];
  const status = liveState.field_status || {};

  const carouselSignals = signals.filter((signal) => signal.type === "carousel_active_candidate");
  assert(carouselSignals.length > 0, "signals must include carousel_active_candidate");
  assert(signalReport.signal_counts?.carousel_active_candidate === carouselSignals.length, "signal count must include carousel active candidates");

  const active = liveState.carousel?.active;
  assert(active && active !== "unknown", "carousel.active must expose a candidate object");
  assert(active.source_signal_type === "carousel_active_candidate", "carousel.active must cite carousel_active_candidate");
  assert(active.event === "draft_turn_start", "carousel.active must preserve draft event");
  assert(active.semantic_status === "candidate_only", "carousel.active must remain candidate_only");
  assert(status["carousel.active"]?.status === "partial", "carousel.active status must be partial");

  assert(Array.isArray(liveState.carousel?.available_units) && liveState.carousel.available_units.length === 0, "carousel.available_units must remain empty");
  assert(liveState.carousel?.can_pick_now === "unknown", "carousel.can_pick_now must remain unknown");
  assert(liveState.carousel?.selected_pick === "unknown", "carousel.selected_pick must remain unknown");
  assert(status["carousel.available_units"]?.status === "missing", "carousel.available_units must remain missing");
  assert(status["carousel.can_pick_now"]?.status === "missing", "carousel.can_pick_now must remain missing");
  assert(status["actions.can_pick_carousel"]?.status === "missing", "actions.can_pick_carousel must remain missing");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "draft-turn evidence becomes carousel.active candidate",
      "carousel unit and pick details remain unknown",
      "action pick availability is not promoted",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
