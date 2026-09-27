import { readFile } from "node:fs/promises";

const DEFAULT_DISCOVERY = ".omx/runtime-evidence/jcc-mumu-gameassist-source/mumu-gameassist-source-discovery.json";

function parseArgs(argv) {
  const options = { discovery: DEFAULT_DISCOVERY };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--discovery") options.discovery = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-mumu-gameassist-source-discovery.mjs [--discovery <mumu-gameassist-source-discovery.json>]",
    "",
    "Verifies MuMu gameassist discovery remains a candidate/OCR source and not a live board oracle.",
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

  const discovery = JSON.parse(await readFile(options.discovery, "utf8"));
  assert(discovery.schema_version === 1, "discovery schema_version must be 1");
  assert(discovery.product_boundary === "mumu_gameassist_jkchess_apk_private_cache", "discovery must use MuMu gameassist boundary");
  assert(discovery.source_decision?.status === "candidate_source_verified", "MuMu source must verify as candidate source");
  assert(discovery.source_decision?.direct_live_board_snapshot_status === "not_observed", "MuMu discovery must not claim direct live board snapshot");
  assert(/Promote only when runtime-local binding/i.test(discovery.source_decision?.live_state_boundary || ""), "live_state boundary must require runtime binding");
  assert(/Never merge MuMu gameassist candidates/i.test(discovery.source_decision?.pollution_guard || ""), "pollution guard must be explicit");

  const observedStructures = discovery.dex_evidence?.observed_structures || [];
  assert(observedStructures.some((value) => value.includes("BuyHeroInfo")), "dex must expose BuyHeroInfo");
  assert(observedStructures.some((value) => value.includes("WaitHeroInfo") || value.includes("GiWaitHeroList")), "dex must expose wait/bench-like hero structures");
  assert(observedStructures.some((value) => value.includes("SellHeroInfo")), "dex must expose SellHeroInfo");
  assert(observedStructures.some((value) => value.includes("PlayerBattleInfo")), "dex must expose PlayerBattleInfo");

  const ocrStructures = discovery.dex_evidence?.ocr_structures || [];
  assert(ocrStructures.some((value) => /OcrResult|RapidOcr|captureDisplay/i.test(value)), "dex must expose OCR/screen capture evidence");

  const tables = discovery.private_cache_evidence?.tables || [];
  assert(tables.includes("user_lineup"), "private cache must expose user_lineup table");
  assert(tables.includes("lineup_index"), "private cache must expose lineup_index table");
  assert(tables.includes("config"), "private cache must expose config table");
  assert(discovery.private_cache_evidence?.has_live_board_table === false, "private cache must not expose live board table");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "MuMu APK/private-cache boundary",
      "JCC data/OCR candidate structures",
      "private lineup cache tables",
      "no direct live board snapshot claim",
      "pollution guard",
    ],
    observed_structure_count: observedStructures.length,
    ocr_structure_count: ocrStructures.length,
    private_tables: tables,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
