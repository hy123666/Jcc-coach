import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { buildLevelingEconomyContext } from "./build-jcc-leveling-economy-context.mjs";
import { buildStrategyTables } from "./build-jcc-strategy-tables.mjs";
import { scoreLiveState } from "./score-jcc-cruise-strategy.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const liveState = {
    match_session_id: "leveling-economy-test",
    phase: { stage_round: "4-1", status: 1 },
    economy: {
      gold: 58,
      hp: 72,
      level: 6,
      xp: { value: 14, to_next: 36, display: "14/36", source: "ocr", confidence: 0.96 },
    },
    board: { board_units: [{ id: 11471, base_id: 1471, name: "Diana" }] },
    bench: { bench_units: [] },
    shop: { shop_units: [] },
  };
  const context = {
    target_plan: {
      name: "high cost target",
      units: [
        { name: "Core Four Cost", cost: 4 },
        { name: "Utility Four Cost", cost: 4 },
      ],
    },
  };
  const lowCostContext = {
    target_plan: {
      name: "low cost reroll target",
      units: [{ name: "Core One Cost", cost: 1 }],
    },
  };
  const rankingContext = {
    target_plan: {
      name: "ranking-backed high cap target",
      units: [{ name: "Known Pair", cost: 2 }],
    },
    live_rankings_context: {
      top_heroes: [
        { hero_id: "9004", cost: 4, signal_score: 0.95, avg_placement: 3.2 },
        { hero_id: "9005", cost: 5, signal_score: 0.72, avg_placement: 3.8 },
      ],
    },
  };
  const catalogNamedContext = {
    target_plan: {
      name: "catalog-name target",
      core_units: [{ name: "阿萝拉", role: "carry" }],
      units: [{ champion_id: "12459", role: "frontline" }],
    },
  };

  const tables = buildStrategyTables();
  assert(tables.policy.no_per_match_lineup_tempo_enumeration === true, "strategy tables must not enumerate per-match lineup tempo");
  assert(tables.leveling_rules.manual_xp_per_click === 4, "default click XP mismatch");
  assert(tables.leveling_rules.manual_xp_gold_cost === 4, "default XP click cost mismatch");
  assert(tables.resource_modifier_catalog?.confirmed_modifiers?.some((modifier) => modifier.key === "augment_wise_spending"), "strategy tables should expose confirmed resource modifiers");

  const economy = buildLevelingEconomyContext({ liveState, context, tables });
  assert(economy.status === "ready", "economy context should be ready");
  assert(economy.leveling_math.need_to_next_level === 22, "need to next should be 22");
  assert(economy.leveling_math.clicks_to_level_now === 6, "level now should need 6 clicks");
  assert(economy.leveling_math.gold_to_level_now === 24, "level now should cost 24 gold");
  assert(economy.leveling_math.clicks_to_prelevel_next_round === 5, "prelevel should need 5 clicks");
  assert(economy.leveling_math.gold_to_prelevel_next_round === 20, "prelevel should cost 20 gold");
  assert(economy.actions.some((action) => action.action === "prelevel_next_round" && action.landing_xp === "34/36"), "prelevel action should land at 34/36");
  assert(economy.decision_facts?.authority?.includes("heuristic candidates"), "economy actions must be marked as heuristic candidates");
  assert(economy.decision_facts?.model_must_check?.some((entry) => entry.includes("confirmed augments")), "economy context must tell the host model to check confirmed choices");
  const missingDecisionFields = new Set((economy.decision_facts?.missing_decision_facts || []).map((entry) => entry.field));
  assert(missingDecisionFields.has("streak"), "economy context must expose missing streak instead of guessing streak value");
  assert(missingDecisionFields.has("confirmed_choices"), "economy context must expose missing confirmed choices instead of assuming generic economy");
  assert(missingDecisionFields.has("equipment_facts"), "economy context must expose missing equipment fit instead of assuming combat conversion");
  assert(!missingDecisionFields.has("hp"), "economy context must not ask for HP when HP is present");
  const lowCostEconomy = buildLevelingEconomyContext({ liveState, context: lowCostContext, tables });
  const rankingEconomy = buildLevelingEconomyContext({ liveState, context: rankingContext, tables });
  const catalogNamedEconomy = buildLevelingEconomyContext({ liveState, context: catalogNamedContext, tables });
  assert(rankingEconomy.leveling_math.target_profile.source.includes("live_rankings") || rankingEconomy.leveling_math.target_profile.source.includes("mixed"), "daily rankings should influence target profile when provided");
  assert(rankingEconomy.leveling_math.target_pool_gain > lowCostEconomy.leveling_math.target_pool_gain, "ranking-backed high-cost targets should increase target pool gain versus low-cost reroll targets");
  assert(Number(rankingEconomy.leveling_math.target_profile.cost_weights["4"] || 0) > 0, "ranking cost weights should include 4-cost heroes");
  assert(Number(rankingEconomy.leveling_math.target_profile.cost_weights["5"] || 0) > 0, "ranking cost weights should include 5-cost heroes");
  assert(rankingEconomy.leveling_math.target_profile.weighted_core_cost > lowCostEconomy.leveling_math.target_profile.weighted_core_cost, "ranking weights should raise weighted core cost versus low-cost reroll target");
  assert(Number(catalogNamedEconomy.leveling_math.target_profile.cost_weights["3"] || 0) > 0, "target plan champion names should resolve cost from MuMu catalog");
  assert(Number(catalogNamedEconomy.leveling_math.target_profile.cost_weights["2"] || 0) > 0, "target plan champion ids should resolve cost from MuMu catalog");

  const modified = buildLevelingEconomyContext({
    liveState,
    context: { match_variables: { xp_policy: { manual_xp_per_click: 6, manual_xp_gold_cost: 3, modifiers: ["test_modifier"] } } },
    tables,
  });
  assert(modified.xp_policy.manual_xp_per_click === 6, "XP modifier should change XP per click");
  assert(modified.xp_policy.manual_xp_gold_cost === 3, "XP modifier should change click cost");
  assert(modified.leveling_math.clicks_to_level_now === 4, "modified XP policy should reduce clicks to level");
  assert(modified.leveling_math.gold_to_level_now === 12, "modified XP policy should reduce gold to level");
  const catalogModifier = buildLevelingEconomyContext({
    liveState,
    context: {
      match_variables: {
        xp_policy_modifiers: [
          { key: "catalog_confirmed_discount", manual_xp_per_click: 4, manual_xp_gold_cost: 3, source: "confirmed_catalog_rule" },
        ],
      },
    },
    tables,
  });
  assert(catalogModifier.xp_policy.manual_xp_gold_cost === 3, "confirmed modifier catalog rows should change XP click cost");
  assert(catalogModifier.xp_policy.source === "confirmed_catalog_rule", "confirmed modifier source should be preserved");
  const levelUpAugment = buildLevelingEconomyContext({
    liveState: {
      ...liveState,
      selected_augments: [{ name: "升级咯！", source: "user_confirmed" }],
    },
    context,
    tables,
  });
  assert(levelUpAugment.xp_policy.manual_xp_per_click === 6, "升级咯 should make each XP purchase grant +2 extra XP");
  assert(levelUpAugment.leveling_math.clicks_to_level_now === 4, "升级咯 should reduce clicks to level via 6 XP per purchase");
  const ambitionAugment = buildLevelingEconomyContext({
    liveState: {
      ...liveState,
      selected_augments: [{ name: "上进心", source: "user_confirmed" }],
    },
    context,
    tables,
  });
  assert(ambitionAugment.xp_policy.manual_xp_gold_cost === 3, "上进心 should reduce XP purchase cost by 1");
  assert(ambitionAugment.xp_policy.on_level_up_rewards?.hp === 2, "上进心 should preserve HP reward on level-up");
  assert(ambitionAugment.xp_policy.on_level_up_rewards?.free_rerolls === 1, "上进心 should preserve free reroll reward on level-up");
  assert(ambitionAugment.leveling_math.gold_to_level_now === 18, "上进心 should reduce level-now gold cost");
  const wiseSpendingAugment = buildLevelingEconomyContext({
    liveState: {
      ...liveState,
      selected_augments: [{ name: "明智消费", source: "user_confirmed" }],
    },
    context,
    tables,
  });
  assert(wiseSpendingAugment.xp_policy.can_buy_xp === false, "明智消费 should disable buying XP");
  assert(wiseSpendingAugment.leveling_math.shop_refresh_xp_gain === 2, "明智消费 should expose shop refresh XP gain");
  assert(!wiseSpendingAugment.actions.some((action) => action.action === "level_now_no_roll" || action.action === "prelevel_next_round"), "明智消费 should not emit buy-XP level/prelevel actions");
  const patientStudyAugment = buildLevelingEconomyContext({
    liveState: {
      ...liveState,
      selected_augments: [{ name: "耐心学习", source: "user_confirmed" }],
    },
    context,
    tables,
  });
  assert(patientStudyAugment.xp_policy.post_player_combat_xp_win === 2, "耐心学习 should expose win XP");
  assert(patientStudyAugment.xp_policy.post_player_combat_xp_loss === 3, "耐心学习 should expose loss XP");
  const lateGameReturns = buildLevelingEconomyContext({
    liveState: {
      ...liveState,
      selected_augments: [{ name: "后期收益", source: "user_confirmed" }],
    },
    context,
    tables,
  });
  assert(lateGameReturns.xp_policy.player_combat_start_xp_gain === 2, "后期收益 should expose combat-start XP gain");
  const score = scoreLiveState(liveState, { combat_cap_estimator: { economy_leveling: economy } });
  const task = score.advice_tasks.find((entry) => entry.trigger_id === "level_or_roll_timing");
  assert(task, "scorer should emit level_or_roll_timing from economy EV");
  assert(task.actions.includes(economy.actions[0].action), "task should carry best economy EV action");
  assert(task.short_advice.includes("不是固定节奏表"), "task should state that it is live-computed, not a fixed tempo table");

  const tmp = await mkdtemp(path.join(os.tmpdir(), "jcc-leveling-economy-"));
  try {
    const liveFile = path.join(tmp, "live.json");
    const modifiedLiveFile = path.join(tmp, "modified-live.json");
    const contextFile = path.join(tmp, "context.json");
    const outFile = path.join(tmp, "pipeline.json");
    await writeFile(liveFile, JSON.stringify(liveState, null, 2), "utf8");
    await writeFile(modifiedLiveFile, JSON.stringify({
      ...liveState,
      match_variables: {
        xp_policy: {
          manual_xp_per_click: 6,
          manual_xp_gold_cost: 3,
          modifiers: [{ key: "verified_test_xp_modifier", manual_xp_per_click: 6, manual_xp_gold_cost: 3 }],
        },
      },
    }, null, 2), "utf8");
    await writeFile(contextFile, JSON.stringify(context, null, 2), "utf8");
    const pipeline = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", liveFile,
      "--context", contextFile,
      "--advice-state", path.join(tmp, "advice.json"),
      "--now", "2026-06-11T12:00:00.000Z",
      "--retain-full-state",
    ]);
    assert(pipeline.code === 0, `pipeline failed\n${pipeline.stdout}\n${pipeline.stderr}`);
    const result = JSON.parse(pipeline.stdout);
    const embedded = result.estimator_context?.context?.combat_cap_estimator?.economy_leveling;
    assert(embedded?.status === "ready", "pipeline should embed economy_leveling context");
    assert(embedded.leveling_math.clicks_to_prelevel_next_round === 5, "pipeline should preserve XP progress fraction");
    const pipelineTask = result.score?.advice_tasks?.find((entry) => entry.trigger_id === "level_or_roll_timing")
      || result.score?.suppressed_tasks?.find((entry) => entry.trigger_id === "level_or_roll_timing");
    assert(pipelineTask, "pipeline should produce or suppress a level_or_roll_timing task");
    const redactedPipeline = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", liveFile,
      "--context", contextFile,
      "--advice-state", path.join(tmp, "redacted-advice.json"),
      "--out", outFile,
      "--now", "2026-06-11T12:00:01.000Z",
    ]);
    assert(redactedPipeline.code === 0, `redacted pipeline failed\n${redactedPipeline.stdout}\n${redactedPipeline.stderr}`);
    const redacted = JSON.parse(await readFile(outFile, "utf8"));
    assert(redacted.schema === "jcc-cruise-runtime-pipeline-result-redacted-v1", "pipeline out should stay redacted by default");

    const modifiedPipeline = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", modifiedLiveFile,
      "--context", contextFile,
      "--advice-state", path.join(tmp, "modified-advice.json"),
      "--now", "2026-06-11T12:00:02.000Z",
      "--retain-full-state",
    ]);
    assert(modifiedPipeline.code === 0, `modified pipeline failed\n${modifiedPipeline.stdout}\n${modifiedPipeline.stderr}`);
    const modifiedResult = JSON.parse(modifiedPipeline.stdout);
    const modifiedEmbedded = modifiedResult.estimator_context?.context?.combat_cap_estimator?.economy_leveling;
    assert(modifiedEmbedded?.xp_policy?.manual_xp_per_click === 6, "pipeline should thread live_state match_variables xp_policy into estimator");
    assert(modifiedEmbedded?.xp_policy?.manual_xp_gold_cost === 3, "pipeline should preserve live_state xp policy gold cost");
    assert(modifiedEmbedded?.leveling_math?.clicks_to_level_now === 4, "pipeline xp policy should affect leveling math");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "strategy tables keep only stable mechanism indexes",
      "14/36 XP computes need/clicks/prelevel landing",
      "economy EV exposes missing decision facts and model-side checks instead of treating scores as final advice",
      "XP policy modifiers change click math without scorer rewrites",
      "live_state match_variables xp_policy survives the runtime pipeline",
      "confirmed xp_policy_modifiers change policy while suspected names stay fail-closed",
      "confirmed encounter XP table modifiers apply only when OCR lacks explicit to_next",
      "confirmed XP/economy augments map to precise policy fields",
      "resource catalog exposes XP, gold, refresh, HP, and reward-timing policy fields",
      "target plan plus daily ranking signals influence target pool gain dynamically",
      "target plan plus daily ranking signals produce cost weights instead of max-cost-only heuristics",
      "target plan champion names and ids resolve costs through MuMu catalog overlay",
      "cruise scorer consumes economy EV candidate actions",
      "runtime pipeline preserves XP fraction and embeds economy_leveling",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
