import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const builderSource = await readFile(path.join(process.cwd(), "tools/build-jcc-combat-cap-estimator-context.mjs"), "utf8");
  assert(
    builderSource.includes('lineup?.source_role === "national_master_plus_strength_anchor"')
      && builderSource.includes("lineup?.metrics_authority === true"),
    "combat-cap scoring must reject recipe-only lineup metrics",
  );
  const tmp = await mkdtemp(path.join(os.tmpdir(), "jcc-combat-cap-estimator-"));
  try {
    const liveState = {
      match_session_id: "match-estimator",
      phase: { stage_round: "5-1", status: 1 },
      economy: { gold: 21, hp: 24, level: 6 },
      board: {
        board_units: [
          { id: 11452, base_id: 1452, name: "Leona", star: 2 },
          { id: 11471, base_id: 1471, name: "Diana", star: 2 },
          { id: 11453, base_id: 1453, name: "Nasus", star: 1 },
          { id: 11460, base_id: 1460, name: "Illaoi", star: 1 }
        ]
      },
      bench: {
        bench_units: [
          { id: 11471, base_id: 1471, name: "Diana" },
          { id: 11461, base_id: 1461, name: "Aurora" }
        ]
      },
      shop: {
        shop_units: [
          { id: 11471, base_id: 1471, name: "Diana" },
          { id: 11452, base_id: 1452, name: "Leona" }
        ]
      },
      items: {
        item_bench: [
          { id: 1001, name: "B. F. Sword" },
          { id: 1005, name: "Recurve Bow" }
        ],
        equipped_items: [
          { holder_id: 11471, holder_base_id: 1471, item_id: 2011, name: "Void Staff" }
        ]
      },
    };
    const context = {
      target_plan: {
        id: "phantom-diana",
        name: "Phantom Diana",
        core_unit_ids: [11471, 1471],
        unit_ids: [11471, 1471, 11452, 1452, 11460, 1460, 11461, 1461],
        unit_names: ["Diana", "Leona", "Illaoi", "Aurora"]
      }
    };
    const liveFile = path.join(tmp, "live.json");
    const contextFile = path.join(tmp, "context.json");
    const outFile = path.join(tmp, "estimator.json");
    await writeFile(liveFile, JSON.stringify(liveState, null, 2), "utf8");
    await writeFile(contextFile, JSON.stringify(context, null, 2), "utf8");

    const result = await runNode([
      "tools/build-jcc-combat-cap-estimator-context.mjs",
      "--live-state", liveFile,
      "--context", contextFile,
      "--out", outFile,
    ]);
    assert(result.code === 0, `estimator builder failed\n${result.stdout}\n${result.stderr}`);
    const built = JSON.parse(result.stdout);
    assert(built.schema === "jcc-combat-cap-estimator-context-v1", "schema mismatch");
    assert(built.match_session_id === "match-estimator", "match session mismatch");
    assert(built.context?.combat_cap_estimator, "combat_cap_estimator missing");
    const estimator = built.context.combat_cap_estimator;
    for (const field of [
      "board_power_score",
      "item_power_score",
      "cap_power_score",
      "survival_pressure_score",
      "expected_damage_risk",
    ]) {
      assert(typeof estimator[field] === "number", `${field} must be numeric`);
      assert(estimator[field] >= 0 && estimator[field] <= 1, `${field} out of range`);
    }
    assert(!("lobby_pressure_score" in estimator), "removed lobby_pressure_score must not be emitted");
    assert(!("opponent_power_scores" in estimator), "removed opponent_power_scores must not be emitted");
    assert(estimator.estimator_policy === "hard_data_with_optional_master_plus_rankings_fast_estimate", "policy mismatch");
    assert(estimator.lineup_lifecycle?.schema === "jcc-lineup-lifecycle-context-v1", "lineup lifecycle context missing");
    assert(estimator.board_readiness?.schema === "jcc-board-readiness-v1", "board readiness context missing");
    assert(estimator.board_readiness?.estimator_policy === "own_state_fast_estimate_not_full_combat_simulation", "board readiness must remain a fast own-state estimate");
    for (const field of [
      "population_gain_score",
      "equipment_closure_score",
      "core_two_star_count",
      "core_two_star_coverage_score",
      "immediate_upgrade_gain_score",
      "fault_tolerance_score",
      "main_carry_ready",
      "main_tank_ready",
    ]) {
      assert(field in estimator.board_readiness, `${field} missing from board readiness passthrough`);
    }
    assert(!("opponent_board" in estimator.board_readiness), "board readiness must not include opponent board sensing");
    assert(estimator.opponent_board_policy === "opponent_board_pressure_removed_no_reliable_mumu_unit_source", "opponent sensing policy must stay removed");
    assert(built.context.hard_data_context?.entity_strategy_weights, "hard-data weights must be attached");
    assert(built.context.live_rankings_context, "Master+ Ranking Overlay context boundary must be attached");
    assert(built.evidence.some((entry) => entry.type === "hard_data.champion_profiles"), "champion hard-data evidence missing");
    assert(built.evidence.some((entry) => entry.type === "hard_data.item_fit"), "item fit evidence missing");
    assert(built.evidence.some((entry) => entry.type === "hard_data.trait_breakpoint_distance"), "trait breakpoint evidence missing");
    assert(!built.evidence.some((entry) => entry.type === "live_rankings.runtime_strategy_context"), "legacy live rankings evidence must be absent");

    const scoreResult = await runNode([
      "tools/score-jcc-cruise-strategy.mjs",
      "--live-state", liveFile,
      "--context", outFile,
      "--include-suppressed",
    ]);
    assert(scoreResult.code === 0, `scorer with built context failed\n${scoreResult.stdout}\n${scoreResult.stderr}`);
    const scored = JSON.parse(scoreResult.stdout);
    assert(scored.live_state_summary?.target_plan === "Phantom Diana", "scorer did not consume built target-plan context");

    const dangerousContext = JSON.parse(JSON.stringify(built));
    dangerousContext.context.combat_cap_estimator.board_power_score = 0.2;
    dangerousContext.context.combat_cap_estimator.cap_power_score = 0.25;
    dangerousContext.context.combat_cap_estimator.survival_pressure_score = 0.86;
    dangerousContext.context.combat_cap_estimator.expected_damage_risk = 0.82;
    const dangerousContextFile = path.join(tmp, "dangerous-estimator.json");
    await writeFile(dangerousContextFile, JSON.stringify(dangerousContext, null, 2), "utf8");
    const dangerousScoreResult = await runNode([
      "tools/score-jcc-cruise-strategy.mjs",
      "--live-state", liveFile,
      "--context", dangerousContextFile,
      "--include-suppressed",
    ]);
    assert(dangerousScoreResult.code === 0, `dangerous scorer failed\n${dangerousScoreResult.stdout}\n${dangerousScoreResult.stderr}`);
    const dangerousScore = JSON.parse(dangerousScoreResult.stdout);
    assert(
      dangerousScore.advice_tasks.some((task) => task.evidence.some((entry) => entry.type === "combat_cap_estimator.fast_estimate")),
      "scorer did not consume dangerous built estimator for cap-gap advice"
    );

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "hard-data champion profiles feed board power",
        "hard-data item fit feeds item power",
        "hard-data trait breakpoints feed cap power",
        "legacy live rankings are not attached as a scoring prior",
        "own state feeds survival pressure without opponent board snapshots",
        "built context can be consumed by cruise scorer",
      ],
      estimator,
    }, null, 2));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
