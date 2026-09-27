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
    "  node tools/verify-jcc-round-select-source-insights.mjs [--live-state <match-live-state.json>]",
    "",
    "Verifies round_select_infos is exposed as source insight without promoting carousel unit/pick fields.",
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
  const insight = liveState.source_insights?.round_select_candidates;

  assert(insight, "source_insights.round_select_candidates must exist");
  assert(insight.count === 0, "active match window must not inherit round_select_infos from an earlier match window");
  assert(insight.latest == null, "active match round_select latest must remain null when not observed in-window");
  assert(insight.promotion_decision?.carousel_available_units?.status === "missing", "missing in-window round_select must keep carousel.available_units missing");
  assert(liveState.carousel?.active?.source_signal_type === "carousel_active_candidate", "carousel.active may be a separate draft-turn candidate");
  assert(Array.isArray(liveState.carousel?.available_units) && liveState.carousel.available_units.length === 0, "carousel.available_units must remain empty");
  assert(liveState.field_status?.["carousel.available_units"]?.status === "missing", "carousel.available_units status must remain missing");
  assert(liveState.field_status?.["source_insights.round_select_candidates"] == null, "empty round_select insight should not add a partial field_status entry");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "round_select source insight present",
      "earlier match round_select is not inherited",
      "round_select does not promote carousel unit/pick fields",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
