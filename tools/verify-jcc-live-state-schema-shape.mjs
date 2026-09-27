import { readFile } from "node:fs/promises";

const DEFAULT_LIVE_STATE = "data/runtime/jcc/fixtures/android-live-state-contract.json";

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-live-state-schema-shape.mjs [--live-state <match-live-state.json>]",
    "",
    "Verifies that runtime live_state exposes A-Q schema sections while preserving legacy aliases.",
  ].join("\n");
}

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const snapshot = JSON.parse(await readFile(options.liveState, "utf8"));
  const liveState = snapshot.live_state || {};
  const expectedSections = [
    "match",
    "local",
    "phase",
    "economy",
    "shop",
    "board",
    "bench",
    "items",
    "augments",
    "variables",
    "traits",
    "carousel",
    "rewards",
    "opponents",
    "combat",
    "actions",
    "metadata",
  ];
  for (const section of expectedSections) {
    assert(liveState[section] && typeof liveState[section] === "object", `live_state missing schema section ${section}`);
  }

  assert(liveState.match.status === snapshot.match?.status, "live_state.match must mirror top-level match status");
  assert(liveState.local.local_chair_id === snapshot.match?.local_chair_id, "live_state.local must expose local chair");
  assert(liveState.economy.hp === liveState.hp, "live_state.economy.hp must mirror legacy hp");
  assert(Array.isArray(liveState.shop.shop_units), "live_state.shop.shop_units must be an array");
  assert(liveState.shop.shop_units.length === liveState.shop_candidates.length, "live_state.shop.shop_units must mirror legacy shop_candidates");
  assert(Array.isArray(liveState.board.board_units), "live_state.board.board_units must be an array");
  assert(liveState.board.board_units.length === liveState.board_units.length, "live_state.board.board_units must mirror legacy board_units");
  assert(Array.isArray(liveState.bench.bench_units), "live_state.bench.bench_units must be an array");
  assert(liveState.bench.bench_units.length === liveState.bench_units.length, "live_state.bench.bench_units must mirror legacy bench_units");
  assert(Array.isArray(liveState.items.item_bench), "live_state.items.item_bench must be an array");
  assert(liveState.items.item_bench.length === liveState.item_bench.length, "live_state.items.item_bench must mirror legacy item_bench");
  assert(Array.isArray(liveState.items.equipped_items), "live_state.items.equipped_items must be an array");
  assert(liveState.items.equipped_items.length === liveState.equipped_items.length, "live_state.items.equipped_items must mirror legacy equipped_items");
  assert(!("snapshots" in liveState.opponents), "live_state.opponents.snapshots must not be emitted as a product field");
  assert(sameJson(liveState.metadata.missing_fields, liveState.missing_fields), "live_state.metadata.missing_fields must mirror the runtime missing field list");
  assert(sameJson(liveState.metadata.partial_fields, liveState.partial_fields), "live_state.metadata.partial_fields must mirror the runtime partial field list");
  assert(sameJson(liveState.metadata.fallback_fields, liveState.fallback_fields), "live_state.metadata.fallback_fields must mirror the runtime fallback field list");
  assert(sameJson(liveState.metadata.stale_fields, liveState.stale_fields), "live_state.metadata.stale_fields must mirror the runtime stale field list");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "A-Q schema sections exposed in live_state",
      "match/local/economy/shop/board/bench/items nested values mirror legacy aliases",
      "opponent board snapshots are absent from the product live_state shape",
      "metadata field lists are shared with legacy aliases",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
