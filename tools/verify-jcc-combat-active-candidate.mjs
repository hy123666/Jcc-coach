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
    "  node tools/verify-jcc-combat-active-candidate.mjs [--live-state <match-live-state.json>]",
    "",
    "Verifies battle pairing/result events create a conservative partial combat.active candidate.",
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
  const combat = liveState.combat || {};
  const status = liveState.field_status || {};

  assert(combat.active && combat.active !== "unknown", "combat.active must expose a candidate object");
  assert(combat.active.state === "candidate_combat_observed", "combat.active must use conservative candidate state");
  assert(combat.active.local_chair_id === liveState.local?.local_chair_id, "combat.active must be scoped to local chair");
  assert(["battle_pairing", "battle_result_life", "battle_result_money"].includes(combat.active.source_signal_type), "combat.active must cite a combat signal type");
  assert(combat.active.evidence, "combat.active must carry source evidence");
  assert(combat.active.semantic_status === "candidate_only", "combat.active must preserve semantic uncertainty");
  assert(status["combat.active"]?.status === "partial", "combat.active status must be partial");
  assert(status["combat.active"]?.blocker === "combat_phase_active_semantics_require_timer_or_visible_phase_calibration", "combat.active blocker must require phase calibration");
  assert(liveState.partial_fields?.includes("combat.active"), "combat.active must be listed as partial");
  assert(!liveState.missing_fields?.includes("combat.active"), "combat.active must not remain missing when combat events are observed");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "combat.active candidate is scoped to local chair",
      "combat.active carries combat evidence",
      "combat.active remains partial until phase/timer semantics are calibrated",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
