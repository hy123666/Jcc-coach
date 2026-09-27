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
    "  node tools/verify-jcc-round-flow-candidate-insights.mjs [--live-state <match-live-state.json>]",
    "",
    "Verifies anonymous round_flow board/bench/item candidates stay in source_insights and never promote to local live_state.",
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
  const insights = liveState.source_insights?.board_bench_item_candidates;

  assert(insights, "live_state.source_insights must include board_bench_item_candidates");
  assert(insights.binding_status === "anonymous_round_flow_not_local_state", "round_flow candidates must remain anonymous");
  assert(insights.board_units.count > 0, "real packet must expose anonymous board unit candidates");
  assert(insights.bench_units.count > 0, "real packet must expose anonymous bench unit candidates");
  assert(insights.item_bench.count > 0, "real packet must expose anonymous item bench candidates");
  assert(insights.promotion_decision.board_units.status === "not_promoted", "board candidates must not promote");
  assert(insights.promotion_decision.bench_units.status === "not_promoted", "bench candidates must not promote");
  assert(insights.promotion_decision.item_bench.status === "not_promoted", "item bench candidates must not promote");
  assert(Array.isArray(liveState.board?.board_units) && liveState.board.board_units.length === 0, "local board_units must remain empty");
  assert(Array.isArray(liveState.bench?.bench_units) && liveState.bench.bench_units.length === 0, "local bench_units must remain empty");
  assert(Array.isArray(liveState.items?.item_bench) && liveState.items.item_bench.length === 0, "local item_bench must remain empty");
  assert(liveState.field_status?.["board.board_units"]?.status === "missing", "board.board_units status must remain missing");
  assert(liveState.field_status?.["bench.bench_units"]?.status === "missing", "bench.bench_units status must remain missing");
  assert(liveState.field_status?.["items.item_bench"]?.status === "missing", "items.item_bench status must remain missing");
  assert(liveState.field_status?.["source_insights.board_bench_item_candidates"]?.status === "partial", "source insight status must be partial");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "anonymous round_flow board candidates exposed",
      "anonymous round_flow bench candidates exposed",
      "anonymous round_flow item candidates exposed",
      "candidates are not promoted to local live_state",
      "schema fields remain missing until local semantics are proven",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
