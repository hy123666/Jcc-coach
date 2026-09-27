import { readFile } from "node:fs/promises";

const CONTRACT_PATH = "data/runtime/jcc/android-runtime-capture-contract.json";
const SOURCE_CONTRACT_PATH = "data/runtime/jcc/android-source-contract.json";

const REQUIRED_SCENARIOS = [
  "loading",
  "opening",
  "planning_shop",
  "combat",
  "augment_choice",
  "item_reward",
  "carousel",
  "postgame",
];

const REQUIRED_FIELDS = [
  "board.board_units",
  "bench.bench_units",
  "items.item_bench",
  "items.equipped_items",
  "economy.gold",
  "economy.level",
  "economy.xp",
  "augments.choices",
  "carousel.available_units",
  "rewards.choices",
  "combat.result",
  "match.game_end_time",
];

const FORBIDDEN_METHODS = [
  "memory injection",
  "process modification",
  "anti-cheat bypass",
  "private account scraping",
  "credential extraction",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function allScenarioTargetFields(contract) {
  return new Set((contract.scenarios || []).flatMap((scenario) => scenario.target_fields || []));
}

async function main() {
  const contract = await readJson(CONTRACT_PATH);
  const sourceContract = await readJson(SOURCE_CONTRACT_PATH);

  assert(contract.contract_id === "jcc-android-runtime-targeted-capture-contract", "contract_id mismatch");
  assert(contract.product_boundary === "generic_android_adb_source", "capture contract must keep generic Android ADB boundary");
  assert(contract.source_contract_ref === SOURCE_CONTRACT_PATH, "capture contract must reference source contract");
  assert(contract.privacy_policy?.forbidden_methods?.length >= FORBIDDEN_METHODS.length, "privacy policy must list forbidden methods");
  for (const method of FORBIDDEN_METHODS) {
    assert(contract.privacy_policy.forbidden_methods.includes(method), `privacy policy missing forbidden method: ${method}`);
  }
  for (const allowed of sourceContract.allowed_sources || []) {
    if (allowed.includes("memory")) continue;
    assert(contract.allowed_sources.includes(allowed), `capture contract must carry allowed source: ${allowed}`);
  }

  const scenarios = contract.scenarios || [];
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  for (const id of REQUIRED_SCENARIOS) {
    assert(byId.has(id), `missing scenario: ${id}`);
    const scenario = byId.get(id);
    assert(Array.isArray(scenario.capture_steps) && scenario.capture_steps.length >= 2, `${id} must define capture steps`);
    assert(Array.isArray(scenario.allowed_sources) && scenario.allowed_sources.includes("adb logcat"), `${id} must include adb logcat source`);
    assert(scenario.allowed_sources.some((source) => source.includes("external") || source.includes("dumpsys") || source.includes("ocr") || source.includes("user input")), `${id} must include a second legal source/fallback`);
    assert(Array.isArray(scenario.target_fields) && scenario.target_fields.length > 0, `${id} must target live_state fields`);
    assert(scenario.success_criteria?.some((criterion) => criterion.includes("evidence")), `${id} must require evidence in success criteria`);
    assert(scenario.reject_if?.some((criterion) => criterion.includes("private") || criterion.includes("memory") || criterion.includes("anti-cheat")), `${id} must reject unsafe evidence`);
  }

  const targetFields = allScenarioTargetFields(contract);
  for (const field of REQUIRED_FIELDS) {
    assert(targetFields.has(field), `targeted capture contract does not cover ${field}`);
  }

  assert(contract.diff_policy?.same_fields_ignored === true, "diff policy must ignore unchanged fields");
  assert(contract.diff_policy?.changed_fields_emit_candidate_signal === true, "diff policy must emit candidate signals for changed fields");
  assert(contract.output_artifacts?.includes("probe-report.json"), "output artifacts must include probe-report.json");
  assert(contract.output_artifacts?.includes("targeted-capture-diff.json"), "output artifacts must include targeted-capture-diff.json");
  assert(contract.output_artifacts?.includes("targeted-capture-candidate-signals.json"), "output artifacts must include targeted-capture-candidate-signals.json");
  assert(contract.output_artifacts?.includes("candidate-runtime-signals.json"), "output artifacts must include candidate-runtime-signals.json");
  assert(contract.output_artifacts?.includes("source-health.json"), "output artifacts must include source-health.json");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "targeted capture scenarios cover required gameplay phases",
      "only legal observable Android sources are allowed",
      "unsafe/private/process methods are explicitly rejected",
      "missing runtime fields have concrete capture scenarios",
      "diff policy and output artifacts are defined",
    ],
    scenario_count: scenarios.length,
    covered_field_count: targetFields.size,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
