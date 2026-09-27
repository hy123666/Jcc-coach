import { readFile } from "node:fs/promises";

const DEFAULT_LIVE_STATE = ".omx/runtime-evidence/android-probe-ingame-20260605-214908/match-live-state.json";

function parseArgs(argv) {
  const options = { liveState: DEFAULT_LIVE_STATE };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--live-state") options.liveState = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-phase-current-phase-candidate.mjs [--live-state <match-live-state.json>]",
    "",
    "Verifies draft-turn evidence is surfaced as a partial current phase candidate without inventing timers.",
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
  const liveState = snapshot.live_state || {};
  const phase = liveState.phase || {};
  const status = liveState.field_status || {};

  assert(phase.phase === "candidate_carousel", "phase.phase must expose candidate_carousel");
  assert(phase.phase_source_signal_type === "carousel_active_candidate", "phase.phase must cite carousel_active_candidate");
  assert(phase.phase_evidence === liveState.carousel?.active?.evidence, "phase.phase evidence must match carousel active evidence");
  assert(status["phase.phase"]?.status === "partial", "phase.phase status must be partial");
  assert(status["phase.phase"]?.source_signal_type === "carousel_active_candidate", "phase.phase status must cite signal type");
  assert(status["phase.phase"]?.blocker === "phase_semantics_candidate_from_draft_signal_only", "phase.phase blocker must preserve semantic uncertainty");
  assert(phase.planning_timer === "unknown", "planning_timer must remain unknown");
  assert(phase.combat_timer === "unknown", "combat_timer must remain unknown");
  assert(status["phase.planning_timer"]?.status === "missing", "planning_timer status must remain missing");
  assert(status["phase.combat_timer"]?.status === "missing", "combat_timer status must remain missing");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "draft-turn evidence becomes current phase candidate",
      "phase.phase remains partial",
      "timers remain unknown and missing",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
