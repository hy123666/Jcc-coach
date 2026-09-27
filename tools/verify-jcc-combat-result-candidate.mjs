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
    "  node tools/verify-jcc-combat-result-candidate.mjs [--live-state <match-live-state.json>]",
    "",
    "Verifies local battle_result_life is surfaced as a partial combat result candidate.",
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

  assert(combat.result && combat.result !== "unknown", "combat.result must expose a candidate object");
  assert(combat.result.source_signal_type === "battle_result_life", "combat.result must come from battle_result_life");
  assert(combat.result.local_chair_id === liveState.local?.local_chair_id, "combat.result must be scoped to local chair");
  assert(Number.isFinite(combat.result.damage_taken), "combat.result must include local damage_taken");
  assert(combat.win_loss === "candidate_no_damage_taken", "combat.win_loss must expose conservative no-damage candidate");
  assert(status["combat.result"]?.status === "partial", "combat.result must be partial");
  assert(status["combat.win_loss"]?.status === "partial", "combat.win_loss must be partial");
  assert(status["combat.result"]?.source_signal_type === "battle_result_life", "combat.result status must cite signal type");
  assert(status["combat.win_loss"]?.blocker === "win_loss_semantics_require_round_result_calibration", "win_loss blocker must preserve semantic uncertainty");
  assert(liveState.partial_fields?.includes("combat.active"), "combat.active must be partial when combat events are observed");
  assert(status["combat.active"]?.blocker === "combat_phase_active_semantics_require_timer_or_visible_phase_calibration", "combat.active must preserve phase/timer uncertainty");
  assert(liveState.missing_fields?.includes("combat.damage_dealt"), "combat.damage_dealt must remain missing");
  assert(liveState.missing_fields?.includes("combat.remaining_units"), "combat.remaining_units must remain missing");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "local battle_result_life creates a combat.result candidate",
      "combat.active is only a partial candidate",
      "win_loss is a conservative partial candidate",
      "unproven combat fields remain missing",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
