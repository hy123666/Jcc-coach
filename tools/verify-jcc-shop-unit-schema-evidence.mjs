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
    "  node tools/verify-jcc-shop-unit-schema-evidence.mjs [--live-state <match-live-state.json>]",
    "",
    "Verifies shop units expose the runtime schema fields slot/id/name/cost/traits/evidence.",
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
  const units = liveState.shop?.shop_units || [];

  assert(units.length === 5, "real shop must expose five shop units");
  units.forEach((unit, index) => {
    assert(unit.slot === index, `shop unit ${index} must expose zero-based slot`);
    assert(unit.id === unit.champion_id, `shop unit ${index} must expose id alias`);
    assert(Number.isFinite(unit.raw_id), `shop unit ${index} must preserve raw_id`);
    assert(unit.name, `shop unit ${index} must expose name`);
    assert(Number.isFinite(unit.cost), `shop unit ${index} must expose cost`);
    assert(Array.isArray(unit.traits), `shop unit ${index} must expose traits`);
    assert(unit.evidence, `shop unit ${index} must carry evidence`);
    assert(unit.source_signal_type === "shop_roll_candidate", `shop unit ${index} must cite shop_roll_candidate`);
  });
  assert(liveState.field_status?.["shop.shop_units"]?.status === "verified", "shop.shop_units must remain verified");
  assert(liveState.field_status?.["shop.shop_units"]?.evidence, "shop.shop_units field status must carry evidence");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "shop units expose slot/id/name/cost/traits/evidence",
      "shop units cite shop_roll_candidate",
      "shop.shop_units remains verified",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
