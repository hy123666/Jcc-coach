import { readFile } from "node:fs/promises";

const SCHEMA_PATH = "data/runtime/jcc/android-live-state-schema.json";
const MATRIX_PATH = "data/runtime/jcc/android-live-state-field-evidence-matrix.json";
const SOURCE_CONTRACT_PATH = "data/runtime/jcc/android-source-contract.json";
const CAPTURE_CONTRACT_PATH = "data/runtime/jcc/android-runtime-capture-contract.json";

const REQUIRED_SECTIONS = [
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

const REQUIRED_STATUSES = new Set(["verified", "partial", "missing", "blocked", "fallback_only"]);

const REQUIRED_FIELD_KEYS = [
  "match.game_start_time",
  "local.local_chair_id",
  "phase.phase",
  "economy.hp",
  "economy.gold",
  "economy.level",
  "economy.xp",
  "shop.shop_units",
  "board.board_units",
  "bench.bench_units",
  "items.item_bench",
  "items.equipped_items",
  "augments.choices",
  "augments.selected_augments",
  "variables.other_set_variables",
  "traits.active_traits",
  "carousel.available_units",
  "rewards.choices",
  "combat.result",
  "actions.can_buy",
  "metadata.source_health",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function main() {
  const schema = await readJson(SCHEMA_PATH);
  const matrix = await readJson(MATRIX_PATH);
  const sourceContract = await readJson(SOURCE_CONTRACT_PATH);
  const captureContract = await readJson(CAPTURE_CONTRACT_PATH);
  assert(schema.contract_id === "jcc-android-runtime-live-state-schema", "schema contract_id mismatch");
  assert(matrix.contract_id === "jcc-android-runtime-field-evidence-matrix", "matrix contract_id mismatch");
  assert(sourceContract.contract_id === "jcc-android-runtime-source-contract", "source contract_id mismatch");
  assert(captureContract.contract_id === "jcc-android-runtime-targeted-capture-contract", "capture contract_id mismatch");
  assert(sourceContract.product_boundary === "generic_android_adb_source", "source contract must stay generic Android ADB");
  assert(captureContract.product_boundary === sourceContract.product_boundary, "capture contract must share generic Android ADB boundary");
  assert(sourceContract.targeted_capture_contract === CAPTURE_CONTRACT_PATH, "source contract must reference targeted capture contract");
  assert(sourceContract.sample_profiles?.some((profile) => profile.profile === "mumu" && profile.not_product_boundary === true), "MuMu must be marked sample-only");
  for (const forbidden of ["memory injection", "game process modification", "anti-cheat bypass", "private account data scraping"]) {
    assert(sourceContract.forbidden_sources?.includes(forbidden), `source contract missing forbidden source: ${forbidden}`);
  }

  for (const section of REQUIRED_SECTIONS) {
    assert(schema.sections?.[section], `schema missing section ${section}`);
    assert(Array.isArray(schema.sections[section].fields), `schema section ${section} missing fields`);
    assert(schema.sections[section].fields.length > 0, `schema section ${section} has no fields`);
  }

  const matrixEntries = matrix.fields || [];
  const byKey = new Map(matrixEntries.map((entry) => [entry.field_key, entry]));
  assert(!byKey.has("opponents.snapshots"), "field evidence matrix must not expose opponent board snapshots");
  for (const fieldKey of REQUIRED_FIELD_KEYS) {
    assert(byKey.has(fieldKey), `matrix missing required field ${fieldKey}`);
  }

  for (const section of REQUIRED_SECTIONS) {
    for (const field of schema.sections[section].fields) {
      const fieldKey = `${section}.${field.key}`;
      assert(byKey.has(fieldKey), `matrix missing schema field ${fieldKey}`);
    }
  }

  for (const entry of matrixEntries) {
    assert(REQUIRED_STATUSES.has(entry.status), `invalid status for ${entry.field_key}: ${entry.status}`);
    assert(entry.source_type, `missing source_type for ${entry.field_key}`);
    assert(entry.confidence != null, `missing confidence for ${entry.field_key}`);
    assert(entry.freshness_budget, `missing freshness_budget for ${entry.field_key}`);
    assert(entry.evidence_status, `missing evidence_status for ${entry.field_key}`);
    if (entry.status !== "verified") {
      assert(entry.blocker, `non-verified field ${entry.field_key} must include blocker`);
      assert(entry.next_experiment, `non-verified field ${entry.field_key} must include next_experiment`);
    }
    if (entry.status === "verified") {
      assert(entry.evidence_packet, `verified field ${entry.field_key} must include evidence_packet`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "schema sections A-Q present",
      "required field matrix entries present",
      "all schema fields have matrix coverage",
      "statuses constrained",
      "non-verified fields have blocker and next experiment",
      "verified fields have evidence packets",
      "source contract keeps MuMu sample-only",
      "forbidden sources declared",
      "targeted capture contract is linked",
    ],
    field_count: matrixEntries.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
