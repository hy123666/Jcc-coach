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
    "  node tools/verify-jcc-runtime-freshness-metadata.mjs [--live-state <match-live-state.json>] [--signals <candidate-runtime-signals.json>]",
    "",
    "Verifies live_state metadata exposes deterministic evidence freshness for the active match window.",
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
  const freshness = snapshot.live_state?.metadata?.freshness;

  assert(freshness && typeof freshness === "object", "metadata.freshness must be an object");
  assert(freshness.active_window_start_index >= 0, "freshness must include active window start index");
  assert(freshness.active_window_signal_count === snapshot.source?.active_signal_count, "freshness active signal count must match source metadata");
  assert(freshness.total_signal_count === (signals.signals || []).length, "freshness total signal count must match signal file");
  assert(freshness.last_signal_type, "freshness must include last signal type");
  assert(freshness.last_signal_evidence, "freshness must include last signal evidence");
  assert(freshness.game_start_time === snapshot.match?.game_start_time, "freshness must include match game_start_time");
  assert(freshness.source_health === "attached", "freshness must preserve source_health attached marker");
  assert(freshness.field_matrix === "attached", "freshness must preserve field_matrix attached marker");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "freshness includes active window boundaries",
      "freshness signal counts match evidence",
      "freshness cites last signal evidence",
      "freshness preserves source health and matrix markers",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
