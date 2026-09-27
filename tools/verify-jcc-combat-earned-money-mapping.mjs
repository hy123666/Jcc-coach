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
    "  node tools/verify-jcc-combat-earned-money-mapping.mjs [--live-state <match-live-state.json>] [--signals <candidate-runtime-signals.json>]",
    "",
    "Verifies battle_result_money maps local chair combat income without pretending it is total gold.",
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
  const localMoneySignals = (signals.signals || [])
    .filter((signal) => signal.type === "battle_result_money")
    .filter((signal) => signal.payload?.player_chair_id_candidate === localChairId);

  assert(localMoneySignals.length > 0, "signals must preserve local battle_result_money chair candidate");
  assert(Number.isFinite(liveState.combat?.earned_money), "combat.earned_money must be a number from local battle_result_money");
  assert(liveState.combat.earned_money === localMoneySignals.at(-1).payload.earned_money, "combat.earned_money must use latest local money event");
  assert(liveState.combat.earned_money_source_signal_type === "battle_result_money", "combat.earned_money must cite battle_result_money");
  assert(liveState.combat.earned_money_evidence, "combat.earned_money must carry evidence");
  assert(liveState.field_status?.["combat.earned_money"]?.status === "partial", "combat.earned_money field status must be partial");
  assert(liveState.economy?.gold === "unknown", "combat income must not promote economy.gold");
  assert(liveState.field_status?.["economy.gold"]?.status === "missing", "economy.gold field status must remain missing");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "battle_result_money keeps chair candidate",
      "local chair combat earned money maps to combat only",
      "combat earned money carries evidence",
      "economy.gold remains missing",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
