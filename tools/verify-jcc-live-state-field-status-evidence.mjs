import { readFile } from "node:fs/promises";

const DEFAULT_LIVE_STATE = "data/runtime/jcc/fixtures/android-live-state-contract.json";
const REQUIRED_META = [
  "source_type",
  "observed_pattern",
  "extractor",
  "confidence",
  "freshness_budget",
  "evidence_status",
];

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-live-state-field-status-evidence.mjs [--live-state <match-live-state.json>]",
    "",
    "Verifies every schema field status carries evidence metadata copied from the field evidence matrix.",
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const snapshot = JSON.parse(await readFile(options.liveState, "utf8"));
  const status = snapshot.live_state?.field_status || {};
  const matrix = snapshot.field_matrix || {};
  const schemaFields = [
    ...matrix.verified_fields || [],
    ...matrix.partial_fields || [],
    ...matrix.missing_fields || [],
    ...matrix.fallback_fields || [],
    ...matrix.blocked_fields || [],
  ];

  assert(schemaFields.length > 0, "live_state field_matrix must expose schema fields");
  for (const field of schemaFields) {
    assert(status[field], `field_status missing ${field}`);
    for (const key of REQUIRED_META) {
      assert(Object.hasOwn(status[field], key), `field_status ${field} missing ${key}`);
    }
    if (status[field].status !== "verified") {
      assert(Object.hasOwn(status[field], "blocker"), `non-verified field_status ${field} missing blocker`);
      assert(Object.hasOwn(status[field], "next_experiment"), `non-verified field_status ${field} missing next_experiment`);
    }
  }

  assert(status["economy.hp"].status === "verified", "economy.hp should remain verified");
  assert(status["economy.hp"].source_type === "external_file", "economy.hp must carry matrix source_type");
  assert(status["board.board_units"].status === "missing", "board.board_units should remain missing");
  assert(status["board.board_units"].blocker, "board.board_units must carry blocker");
  assert(status["board.board_units"].next_experiment, "board.board_units must carry next_experiment");
  assert(status["opponents.alive_count"].status === "partial", "opponents.alive_count should remain partial");
  assert(status["opponents.alive_count"].freshness_budget, "opponents.alive_count must carry freshness_budget");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "all schema field_status entries carry evidence metadata",
      "non-verified field_status entries carry blocker and next_experiment",
      "runtime overrides preserve observed statuses",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
