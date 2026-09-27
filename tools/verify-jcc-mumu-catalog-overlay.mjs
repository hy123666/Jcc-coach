import { readFile } from "node:fs/promises";

const DEFAULT_OVERLAY = "data/runtime/jcc/mumu-catalog-overlay.json";

function parseArgs(argv) {
  const options = { overlay: DEFAULT_OVERLAY };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--overlay") options.overlay = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requireEntry(map, id, expectedName) {
  const entry = map[String(id)];
  assert(entry, `missing catalog entry ${id}`);
  assert(entry.name === expectedName, `expected ${id} to be ${expectedName}, got ${entry.name}`);
  assert(entry.icon_url && /^https?:\/\//.test(entry.icon_url), `missing icon_url for ${id}`);
  return entry;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const overlay = JSON.parse(await readFile(options.overlay, "utf8"));
  assert(overlay.schema === "jcc-runtime-catalog-overlay-v1", "unexpected overlay schema");
  assert(overlay.immutable_core_profile_artifact === true, "catalog must come from an immutable Core Profile");
  assert(overlay.identity?.season_id === "s18", "current compatibility mirror must expose active S18");

  assert(Object.keys(overlay.champions_by_id || {}).length >= 65, "active S18 champion catalog too small");
  assert(Object.keys(overlay.items_by_id || {}).length >= 100, "active S18 item catalog too small");
  assert(Object.keys(overlay.augments_by_id || {}).length >= 250, "active S18 augment catalog too small");
  assert(Object.keys(overlay.traits_by_id || {}).length >= 30, "active S18 trait catalog too small");

  requireEntry(overlay.champions_by_id, 1500, "奥恩");
  requireEntry(overlay.items_by_id, 1001, "暴风之剑");
  requireEntry(overlay.augments_by_id, 1002, "存心失利");

  assert(Object.values(overlay.champions_by_id).some((entry) => entry.name === "奥恩"), "catalog must include 奥恩");

  console.log(JSON.stringify({
    ok: true,
    overlay: options.overlay,
    counts: overlay.counts,
    samples: {
      champion_1500: overlay.champions_by_id["1500"],
      item_1001: overlay.items_by_id["1001"],
      augment_1002: overlay.augments_by_id["1002"],
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
