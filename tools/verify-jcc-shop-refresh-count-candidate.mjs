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
    "  node tools/verify-jcc-shop-refresh-count-candidate.mjs [--live-state <match-live-state.json>] [--signals <candidate-runtime-signals.json>]",
    "",
    "Verifies shop.refresh_count is only the active-window observed shop candidate count.",
  ].join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function activeMatchSignals(signals) {
  const allSignals = signals.signals || [];
  let startIndex = 0;
  for (let index = allSignals.length - 1; index >= 0; index -= 1) {
    if (allSignals[index].type === "match_start") {
      startIndex = index;
      break;
    }
  }
  return allSignals.slice(startIndex);
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
  const activeShopSignals = activeMatchSignals(signals).filter((signal) => signal.type === "shop_roll_candidate");

  assert(activeShopSignals.length > 0, "real active match must include shop_roll_candidate signals");
  assert(liveState.shop?.refresh_count === activeShopSignals.length, "shop.refresh_count must equal active-window shop_roll_candidate count");
  assert(liveState.field_status?.["shop.refresh_count"]?.status === "partial", "shop.refresh_count status must be partial");
  assert(liveState.field_status?.["shop.refresh_count"]?.source_signal_type === "shop_roll_candidate", "shop.refresh_count must cite shop_roll_candidate");
  assert(liveState.field_status?.["shop.refresh_count"]?.blocker === "observed_shop_generation_count_not_paid_reroll_count", "shop.refresh_count blocker must preserve candidate-only semantics");
  assert(liveState.shop?.lock_state === "unknown", "shop.lock_state must remain unknown");
  assert(liveState.actions?.can_roll === "unknown", "actions.can_roll must remain unknown");
  assert(liveState.economy?.gold === "unknown", "shop refresh candidate count must not promote economy.gold");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "shop.refresh_count equals active-window shop_roll_candidate count",
      "shop.refresh_count is partial candidate evidence only",
      "shop lock, roll action, and gold remain unknown",
    ],
    active_window_shop_roll_candidate_count: activeShopSignals.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
