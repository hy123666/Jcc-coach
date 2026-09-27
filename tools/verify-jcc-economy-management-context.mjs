import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { loadActiveRulesBundle } from "./jcc_active_rules_contract.mjs";
import { createActiveCoreProfileSnapshot } from "./jcc_test_core_profile_fixture.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function firstArray(value) {
  return Array.isArray(value) ? value : [];
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

async function main() {
  const runtimePaths = createRuntimePaths(process.cwd());
  const activeRulesBundle = loadActiveRulesBundle({ repoRoot: process.cwd(), runtimePaths });
  const activeCoreProfileSnapshot = createActiveCoreProfileSnapshot(process.cwd(), { runtimePaths });
  const [commonDoctrine, service, contextPack, pipeline, uiModeContract] = await Promise.all([
    readJson("data/game-knowledge/jcc/common/complete-game-doctrine.json"),
    readFile("ui/electron/runtime-service.js", "utf8"),
    readFile("tools/build-jcc-host-agent-context-pack.mjs", "utf8"),
    readFile("tools/run-jcc-cruise-runtime-pipeline.mjs", "utf8"),
    readJson("data/runtime/jcc/runtime-ui-mode-contract.json"),
  ]);

  const commonEconomyEntry = firstArray(commonDoctrine.entries)
    .find((entry) => entry?.source_key === "economy_management");
  const economy = commonEconomyEntry?.content;
  const compiledEconomy = activeRulesBundle.base_game_rules?.economy_management;
  assert(economy?.schema === "jcc-economy-management-base-v1", "base rules must define economy_management schema");
  assert(compiledEconomy?.schema === economy.schema, "active Core Profile must compile the authored Common economy doctrine");
  assert(Array.isArray(economy.core_principles) && economy.core_principles.length >= 4, "base economy rules must include core principles");
  assert(economy.opening_drop_models?.standard_11_gold_start, "base economy rules must include standard 11-gold opener model");
  assert(economy.opening_drop_models?.money_start, "base economy rules must include money-start opener model");
  assert(economy.open_sell_policy?.host_policy, "base economy rules must include open-sell host policy");
  assert(economy.early_leveling_policy?.level_4, "base economy rules must include level-4 policy");
  assert(economy.streak_and_neutral_policy?.streak_carries_into_neutrals === true, "base economy rules must encode neutral streak carryover");
  assert(economy.interest_threshold_math?.reroll_32_gold_reference, "base economy rules must encode reroll 32-gold reference");
  assert(economy.level_timing_priors?.level_8, "base economy rules must include level-8 timing prior");
  assert(Array.isArray(economy.event_policy?.advice_stage_priors), "base economy rules must include event-policy advice stage priors");
  assert(economy.event_policy.trigger_policy?.includes("not automatic speak"), "base economy event policy must forbid automatic stage speaking");

  assert(!Object.hasOwn(activeRulesBundle.season_normal_rules || {}, "economy_management_overrides"), "major-season rules must not contain patch/meta economy strategy");
  const patchEconomy = activeRulesBundle.patch_strategy_overrides?.economy_management_overrides;
  assert(patchEconomy?.schema === "jcc-economy-management-patch-strategy-v1", "active patch may carry only the registered explicit economy exception schema");
  assert(patchEconomy?.relationship_to_base?.includes("Apply Common economy"), "patch economy exception must explicitly keep Common economy as the base authority");
  assert(!Object.hasOwn(patchEconomy || {}, "core_principles") && !Object.hasOwn(patchEconomy || {}, "interest_threshold_math"), "patch economy exception must not duplicate Common economy defaults");
  assert(!JSON.stringify(commonDoctrine).includes("star_god_choice_stages"), "Common economy doctrine must not import season-specific mechanics");

  for (const [label, source] of [
    ["runtime-service", service],
    ["cruise-pipeline", pipeline],
  ]) {
    assert(source.includes("economy_management"), `${label} must surface economy management in active rules/context`);
    assert(source.includes("economic_decision_context"), `${label} must reference computed economic decision context`);
  }
  assert(contextPack.includes("loadActiveRulesBundle"), "context-pack must consume economy management through the canonical active-rules compiler");

  assert(service.includes("buildLevelingEconomyContext({"), "runtime service must use existing leveling economy EV instead of prompt-only doctrine");
  assert(!service.includes('id: "spring"'), "runtime service must not hardcode S17 stargazer constellation options");
  assert(!service.includes('name: "\\u6cc9\\u6c34"'), "runtime service must not hardcode S17 stargazer constellation display text");
  assert(service.includes('source: "active_season_normalized_hard_data"'), "manual variable options must identify active-season data as their source");
  assert(service.includes("type: \"economic_decision_context_changed\""), "runtime service must emit derived economic decision event");
  assert(service.includes("type: \"target_plan_changed\""), "runtime service must emit target-plan semantic events for AI-native pivot review");
  assert(service.includes("heuristic_top_candidate"), "runtime service must expose economy actions as heuristic candidates, not commands");
  assert(service.includes("missing_decision_facts"), "runtime service must expose missing economy decision facts");
  assert(service.includes("model_must_check"), "runtime service must expose model-side economy checks");
  assert(service.includes("economic_decision_context_unavailable"), "runtime service must record diagnostics when economy context builder fails");
  assert(service.includes("diagnostics_ref: \"runtime_event_log:economic_decision_context_unavailable\""), "host economy context must get a safe diagnostics reference, not raw stack traces");
  assert(service.includes("reason: \"gold bucket changed; local scorer may use this but it must not directly call host model\""), "raw gold bucket changes must stay fact-only");
  assert(service.includes("economyManagementAdviceStageSet"), "runtime service must read economy advice stages from active rules instead of a hardcoded Set");
  assert(!service.includes("const economyManagementAdviceStages = new Set"), "runtime service must not hardcode economy advice stages in code");
  const economyAdmission = firstArray(uiModeContract.cruise_mode_policy?.interrupt_policy?.semantic_event_admission_policy)
    .find((entry) => entry?.category === "economy_management_context");
  assert(Number(economyAdmission?.cooldown_seconds) >= 60, "economy event category must be long-cooldowned by the UI contract");

  const tempDir = await mkdtemp(path.join(tmpdir(), "jcc-economy-context-pack-"));
  try {
    const result = spawnSync(process.execPath, [
      "tools/build-jcc-host-agent-context-pack.mjs",
      "--scope",
      "match",
      "--match-session-id",
      "verify-economy-context-pack",
      "--season-snapshot-base64url",
      Buffer.from(JSON.stringify(activeCoreProfileSnapshot), "utf8").toString("base64url"),
      "--expected-core-profile-id",
      activeCoreProfileSnapshot.core_profile_id,
      "--out-dir",
      tempDir,
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert(result.status === 0, `context pack build must succeed: ${result.stderr || result.stdout}`);
    const pack = await readJson(path.join(tempDir, "match-context-pack.json"));
    assert(pack.active_rules_bundle?.base_game_rules?.economy_management?.schema === "jcc-economy-management-base-v1", "built context pack must carry base economy_management object");
    assert(pack.active_rules_bundle?.patch_strategy_overrides?.economy_management_overrides?.schema === patchEconomy.schema, "built context pack must carry the registered patch economy exception without synthesizing a replacement");
    assert(pack.active_rules_bundle?.coach_rules_brief?.economy_management?.policy, "built context pack must carry coach economy brief");
    assert(pack.active_rules_bundle?.coach_rules_brief?.economy_management?.base_schema === economy.schema, "built context pack must identify Common as the economy authority");
    assert(pack.active_rules_bundle?.coach_rules_brief?.economy_management?.patch_strategy_schema === patchEconomy.schema, "built context pack must identify the registered patch economy exception schema");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const pipelineTempDir = await mkdtemp(path.join(tmpdir(), "jcc-economy-pipeline-"));
  try {
    const liveStateFile = path.join(pipelineTempDir, "live-state.json");
    const contextFile = path.join(pipelineTempDir, "context.json");
    const adviceStateFile = path.join(pipelineTempDir, "advice-state.json");
    const outFile = path.join(pipelineTempDir, "pipeline-out.json");
    await writeFile(liveStateFile, `${JSON.stringify({
      match_session_id: "verify-economy-ai-native",
      phase: { stage_round: "3-2", status: 1 },
      economy: { gold: 42, hp: 68, level: 6, xp: { value: 14, to_next: 36 } },
      current_view: {
        status: 1,
        shop_units: [
          { id: "shop-a", name: "阿利斯塔", cost: 2 },
          { id: "shop-b", name: "赫卡里姆", cost: 3 },
        ],
        local_board_units_candidate: [
          { id: "u1", name: "慎", cost: 2, star: 2 },
          { id: "u2", name: "蔚", cost: 3, star: 1 },
        ],
      },
      bench_units: [
        { id: "b1", name: "瑟庄妮", cost: 2, star: 1 },
      ],
      items: {
        item_bench: [{ id: "bf", name: "暴风大剑" }],
      },
      augments: { selected_augments: [{ name: "升级咯！", choice_stage_round: "2-1" }] },
      match_variables: { encounter: "verify" },
    }, null, 2)}\n`, "utf8");
    await writeFile(contextFile, `${JSON.stringify({
      force_response_reason: "manual_verify_economy",
      match_context: {
        target_plan: { summary: "验证四费主C线", target_level: 8 },
        recent_user_messages: [
          { text: "我想玩四费主C，但看装备和海克斯可以转", tags: ["lineup_intent", "tempo_economy_intent"], mode: "cruise" },
        ],
        choice_confirmations: [
          { kind: "augment", choice_stage_round: "2-1", selected: "升级咯！" },
        ],
        match_variables: { encounter: "verify" },
      },
    }, null, 2)}\n`, "utf8");
    const result = spawnSync(process.execPath, [
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state",
      liveStateFile,
      "--context",
      contextFile,
      "--advice-state",
      adviceStateFile,
      "--mode",
      "cruise",
      "--user-message",
      "现在经济怎么走？",
      "--out",
      outFile,
      "--retain-full-state",
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert(result.status === 0, `pipeline build must succeed: ${result.stderr || result.stdout}`);
    const pipelineOut = await readJson(outFile);
    const responseEvents = pipelineOut.response_events || pipelineOut.output_events || [];
    const hostRequest = responseEvents.find((event) => event.host_cli_agent_request)?.host_cli_agent_request;
    assert(hostRequest, "pipeline must emit a host_cli_agent_request for the user-triggered economy question");
    const cruiseContext = hostRequest.context?.cruise_decision_context;
    assert(cruiseContext?.lineup_lifecycle?.schema === "jcc-lineup-lifecycle-context-v1", "pipeline host request must carry lineup lifecycle context");
    assert(cruiseContext.lineup_lifecycle.season_neutral === true, "pipeline lifecycle context must remain season neutral");
    assert(cruiseContext?.economy_management_context?.schema === "jcc-economy-management-selected-context-v1", "pipeline host request must carry economy_management_context");
    assert(cruiseContext.economy_management_context.base?.interest_reference, "pipeline compact economy context must expose interest references");
    assert(!Object.hasOwn(cruiseContext.economy_management_context.base || {}, "interest_threshold_math"), "pipeline compact economy context must not pass full interest formula prose as host-call doctrine");
    assert(cruiseContext?.economic_decision_context?.schema === "jcc-economic-decision-context-v1", "pipeline host request must carry economic_decision_context");
    assert(Object.hasOwn(cruiseContext.economic_decision_context, "heuristic_top_candidate"), "pipeline economic_decision_context must expose heuristic_top_candidate");
    assert(!Object.hasOwn(cruiseContext.economic_decision_context, "top_action"), "pipeline economic_decision_context must not expose top_action to the host model");
    assert(Array.isArray(cruiseContext.economic_decision_context.missing_decision_facts), "pipeline economic_decision_context must expose missing_decision_facts");
    assert(Array.isArray(cruiseContext.economic_decision_context.decision_factors?.model_must_check), "pipeline economic_decision_context must expose model_must_check");
    assert(cruiseContext.strategy_fit_packet?.economy_management?.economic_decision_context?.schema === "jcc-economic-decision-context-v1", "pipeline strategy_fit_packet must carry economy evidence");
  } finally {
    await rm(pipelineTempDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "authored Common economy doctrine is structured, season-agnostic, and compiled into the active Core Profile",
      "Common remains the default economy authority when the active patch declares no explicit exception",
      "manual variable options are sourced from active-season data rather than hardcoded S17 choices",
      "runtime/context-pack/pipeline surface economy_management",
      "runtime and pipeline host selected context include economy_management_context and heuristic economic_decision_context",
      "economic decision context exposes model checks and missing facts instead of authoritative commands",
      "target-plan changes are first-class semantic events for pivot review",
      "built match context pack carries economy rules and coach economy brief",
      "economy context builder failures are observable internally without exposing raw errors to host",
      "raw gold bucket changes remain fact-only while derived economy decisions can trigger long-cooldown advice",
      "economy advice stage priors are rule data, not runtime hardcoded stage lists",
      "compact host economy context exposes interest references, not full formula prose as commands",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
