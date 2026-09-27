import { readFile } from "node:fs/promises";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ids(entries) {
  return new Set((entries || []).map((entry) => entry.id));
}

async function main() {
  const contract = JSON.parse(await readFile("data/runtime/jcc/cruise-strategy-semantics-contract.json", "utf8"));
  const uiMode = JSON.parse(await readFile("data/runtime/jcc/runtime-ui-mode-contract.json", "utf8"));
  assert(contract.schema === "jcc-cruise-strategy-semantics-contract-v1", "schema mismatch");
  assert(contract.binding_policy?.is_hard_rule_source === false, "semantics must not be hard rules");
  assert(contract.binding_policy?.is_strategy_source === false, "semantics must not be strategy source");
  assert(contract.binding_policy?.is_language_and_intent_layer === true, "semantics must be language/intent layer");
  assert(contract.binding_policy?.decision_source_order?.[0] === "current match live_state", "live_state must be first decision source");
  assert(contract.binding_policy?.decision_source_order?.includes("JCC hard-data"), "hard-data decision source missing");
  assert(contract.binding_policy?.decision_source_order?.includes("current-Match captured Zhangmeng/Tencent Master+ Ranking Overlay evidence when available"), "Master+ Ranking Overlay decision source missing");
  assert(contract.source_policy?.tft_lab_glossary?.url?.includes("tft-lab.com"), "TFT Lab glossary source missing");
  assert(/Do not treat glossary terms as mandatory strategy rules/i.test(contract.source_policy?.tft_lab_glossary?.use || ""), "glossary non-binding policy missing");
  assert(contract.source_policy?.jcc_hard_data?.use?.includes("Authoritative"), "JCC hard-data authority missing");
  assert(contract.source_policy?.live_rankings?.use?.includes("Zhangmeng/Tencent Master+"), "Master+ live rankings policy missing");

  const archetypes = ids(contract.strategy_archetypes);
  for (const required of [
    "fast_8",
    "slow_roll",
    "hyper_roll",
    "open_fort_lose_streak",
    "win_streak_tempo",
    "sit_on_gold_interest",
    "roll_down_stabilize",
    "pivot",
    "capped_board",
  ]) {
    assert(archetypes.has(required), `strategy archetype missing: ${required}`);
  }

  const operations = ids(contract.operation_terms);
  for (const required of ["refresh", "sit_on_level", "level_up", "lock_shop", "sell_unit"]) {
    assert(operations.has(required), `operation term missing: ${required}`);
  }

  const triggers = ids(contract.cruise_trigger_extensions);
  for (const required of [
    "interest_breakpoint_decision",
    "streak_guard",
    "level_or_roll_timing",
    "shop_lock_decision",
    "bench_space_pressure",
    "item_slam_or_greed",
    "cap_gap_check",
  ]) {
    assert(triggers.has(required), `cruise trigger extension missing: ${required}`);
  }
  assert(!triggers.has("contest_density_check"), "contest_density_check must stay removed with opponent board sensing");

  assert(contract.output_policy?.do_not_output_full_chain_of_thought === true, "output policy must hide chain of thought");
  assert(contract.output_policy?.must_reference_current_evidence === true, "advice must reference current evidence");
  assert(uiMode.cruise_mode_policy?.strategy_semantics === "data/runtime/jcc/cruise-strategy-semantics-contract.json", "UI mode must point to semantics contract");
  assert(/Non-binding tactical vocabulary/i.test(uiMode.cruise_mode_policy?.strategy_semantics_policy || ""), "UI mode non-binding policy missing");
  const uiTriggers = ids(uiMode.cruise_mode_policy?.proactive_advice_triggers);
  for (const required of [
    "direction_commit_or_exit",
    "lineup_convergence_checkpoint",
    "cap_gap_check",
  ]) {
    assert(uiTriggers.has(required), `UI cruise trigger missing: ${required}`);
  }

  console.log(JSON.stringify({
    ok: true,
    checked: {
      archetypes: [...archetypes],
      operation_terms: [...operations],
      cruise_trigger_extensions: [...triggers],
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
