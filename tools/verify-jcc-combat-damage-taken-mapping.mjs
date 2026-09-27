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
    "  node tools/verify-jcc-combat-damage-taken-mapping.mjs [--live-state <match-live-state.json>] [--signals <candidate-runtime-signals.json>]",
    "",
    "Verifies battle_result_life maps local chair combat damage without replacing current hp.",
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
  const signals = JSON.parse(await readFile(options.signals, "utf8"));
  const liveState = snapshot.live_state || {};
  const localChairId = liveState.local?.local_chair_id;
  const localLifeSignals = (signals.signals || [])
    .filter((signal) => signal.type === "battle_result_life")
    .filter((signal) => signal.payload?.player_chair_id_candidate === localChairId);

  assert(localLifeSignals.length > 0, "signals must preserve local battle_result_life chair candidate");
  assert(Number.isFinite(liveState.combat?.damage_taken), "combat.damage_taken must be a number from local battle_result_life");
  assert(liveState.combat.damage_taken === localLifeSignals.at(-1).payload.deducted_life, "combat.damage_taken must use latest local life event");
  assert(liveState.combat.damage_taken_source_signal_type === "battle_result_life", "combat.damage_taken must cite battle_result_life");
  assert(liveState.combat.damage_taken_evidence, "combat.damage_taken must carry evidence");
  assert(liveState.field_status?.["combat.damage_taken"]?.status === "partial", "combat.damage_taken field status must be partial");
  assert(liveState.economy?.hp === 92, "combat damage must not replace current hp");
  assert(liveState.field_status?.["economy.hp"]?.status === "verified", "economy.hp must remain verified from player_life");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "battle_result_life keeps chair candidate",
      "local chair combat damage maps to combat only",
      "combat damage carries evidence",
      "economy.hp remains verified current hp",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
