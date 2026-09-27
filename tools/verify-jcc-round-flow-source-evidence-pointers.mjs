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
    "  node tools/verify-jcc-round-flow-source-evidence-pointers.mjs [--live-state <match-live-state.json>]",
    "",
    "Verifies anonymous round_flow board/bench/item source insights carry reproducible evidence pointers.",
  ].join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPointer(snapshot, label) {
  assert(Number.isInteger(snapshot.signal_index), `${label} must include signal_index`);
  assert(snapshot.evidence, `${label} must include evidence`);
  assert(snapshot.source_signal_type === "round_flow", `${label} must cite round_flow`);
  assert(snapshot.raw_field_indexes?.board_units === 29, `${label} must carry board raw field index`);
  assert(snapshot.raw_field_indexes?.bench_units === 31, `${label} must carry bench raw field index`);
  assert(snapshot.raw_field_indexes?.item_bench === 32, `${label} must carry item raw field index`);
  assert(snapshot.binding_status === "anonymous_unbound_candidate", `${label} must remain anonymous`);
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
  const snapshots = liveState.source_insights?.round_flow_snapshots || [];

  assert(snapshots.length > 0, "round_flow_snapshots must be present");
  assertPointer(snapshots.at(-1), "latest round_flow snapshot");

  for (const [field, expectedReason] of [
    ["board_units", "round_flow_board_units_not_bound_to_local_chair"],
    ["bench_units", "round_flow_bench_units_not_bound_to_local_chair"],
    ["item_bench", "round_flow_item_bench_not_bound_to_local_chair"],
  ]) {
    const bucket = insights?.[field];
    assert(bucket?.count > 0, `${field} bucket must expose candidates`);
    assert(bucket.latest_source, `${field} bucket must include latest_source`);
    assertPointer(bucket.latest_source, `${field} latest_source`);
    assert(bucket.promotion_decision?.status === "not_promoted", `${field} promotion decision must remain not_promoted`);
    assert(bucket.promotion_decision?.reason === expectedReason, `${field} promotion reason must preserve local-chair blocker`);
  }

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "round_flow snapshots carry signal indexes and evidence",
      "board/bench/item candidate buckets carry latest source pointers",
      "anonymous candidates remain not promoted to local live_state",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
