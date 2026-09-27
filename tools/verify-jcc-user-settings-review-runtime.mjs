import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { persistPipelineResult, runPipeline } from "./run-jcc-cruise-runtime-pipeline.mjs";

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
  const tmp = await mkdtemp(path.join(os.tmpdir(), "jcc-user-settings-review-"));
  try {
    const userSettingsFile = path.join(tmp, "runtime-user-settings.json");
    const userMemoryFile = path.join(tmp, "user-memory.json");
    const proposedMemoryFile = path.join(tmp, "user-memory-after-conflict.json");
    const proposalFile = path.join(tmp, "strategy-proposal.json");
    const recentDir = path.join(tmp, "recent-matches");
    const liveFile = path.join(tmp, "live.json");
    const contextFile = path.join(tmp, "context.json");
    const outFile = path.join(tmp, "pipeline.json");
    const lifecycleFile = path.join(tmp, "lifecycle.json");

    await writeFile(userSettingsFile, JSON.stringify({
      schema: "jcc-runtime-user-settings-v1",
      rank_tier: "diamond",
      operation_speed: "slow_needs_one_round_notice",
      default_goal: "safe_top_four",
      updated_at: "2026-06-11T00:00:00.000Z",
      source: "user_confirmed_menu_setting",
    }, null, 2), "utf8");

    await writeFile(userMemoryFile, JSON.stringify({
      schema: "jcc-runtime-user-memory-v1",
      updated_at: "2026-06-11T00:00:00.000Z",
      strategy_rows: [
        {
          id: "strategy-row-avoid-low-value-rolls",
          text: "我更喜欢少 D、多运营，低价值 D 牌不要乱建议。",
          tags: ["economy_bias", "avoid_reroll"],
          weight: 1.2,
          source: "daily_chat_user_confirmed",
          approved: true,
          enabled: true,
        },
        {
          id: "strategy-row-tempo",
          text: "血量低的时候优先稳血，不要硬贪。",
          tags: ["tempo_bias", "safe_top_four"],
          weight: 1,
          source: "postgame_review_user_confirmed",
          approved: true,
          enabled: true,
        },
      ],
      preferences: [
        { key: "climb_goal", value: "safe_top_four", source: "explicit_user_confirmation" },
        { key: "comfort_line", value: "Diana transition lines", source: "explicit_user_confirmation" },
      ],
      habits: [
        { key: "pivot_speed", value: "needs early warning before large board swap", source: "explicit_user_confirmation" },
      ],
      review_notes: [
        { key: "common_mistake", value: "greeds one extra round at low HP", source: "postgame_review" },
      ],
    }, null, 2), "utf8");

    await writeFile(liveFile, JSON.stringify({
      match_session_id: "settings-review-match",
      phase: { stage_round: "4-3", status: 1 },
      economy: { gold: 33, hp: 38, level: 7, xp: "18/56" },
      board: {
        board_units: [
          { id: 11471, name: "Diana", star: 2 },
          { id: 11452, name: "Leona", star: 2 },
          { id: 11460, name: "Illaoi", star: 1 },
        ],
      },
      bench: { bench_units: [{ id: 11471, name: "Diana" }] },
      shop: { shop_units: [{ id: 11471, name: "Diana" }, { id: 11501, name: "Morgana" }] },
      items: { item_bench: [{ id: 1001, name: "B. F. Sword" }] },
      opponents: {
        snapshots: [
          { opponent_id: "opp-a", board_units: [{ id: 11471, name: "Diana", star: 2 }] },
          { opponent_id: "opp-b", board_units: [{ id: 11471, name: "Diana", star: 1 }] },
        ],
      },
    }, null, 2), "utf8");

    await writeFile(contextFile, JSON.stringify({
      target_plan: {
        id: "diana-line",
        name: "Diana target",
        unit_ids: [11471, 11452, 11460, 11501],
        unit_names: ["Diana", "Leona", "Illaoi", "Morgana"],
      },
      minimum_value_score_to_speak: 0.65,
    }, null, 2), "utf8");

    const pipelineOptions = {
      liveState: liveFile,
      context: contextFile,
      adviceState: lifecycleFile,
      out: outFile,
      userSettings: userSettingsFile,
      userMemory: userMemoryFile,
      recentMatchesDir: recentDir,
      retainFullState: true,
      now: "2026-06-11T00:01:00.000Z",
      runtimeEventContextJson: JSON.stringify({
        event_key: "fixed-checkpoint:4-3:user-settings-review",
        event_type: "line_decision_context_changed",
        event_category: "line_decision_context",
        stage_round: "4-3",
        decision_trigger_id: "lineup_convergence_checkpoint",
        decision_task_id: "lineup-convergence:4-3:user-settings-review",
        fixed_checkpoint_id: "final_lineup_confirmation",
        checkpoint_answer_contract: {
          checkpoint_id: "final_lineup_confirmation",
        },
      }),
      runtimeUserSettings: {
        schema: "jcc-runtime-user-settings-v1",
        rank_tier: "diamond",
        operation_speed: "slow_needs_one_round_notice",
        default_goal: "safe_top_four",
      },
      userMemorySnapshot: {
        schema: "jcc-runtime-user-memory-v1",
        strategy_rows: [
          {
            id: "canonical-strategy-row",
            text: "我更喜欢少 D、多运营，低价值 D 牌不要乱建议。",
            tags: ["economy_bias", "avoid_reroll"],
            weight: 1.2,
            approved: true,
            enabled: true,
          },
        ],
        preferences: [],
        habits: [],
        review_notes: [],
      },
    };
    const pipelineResult = await runPipeline(pipelineOptions);
    await persistPipelineResult(pipelineResult, pipelineOptions);
    assert(pipelineResult.source_context?.runtime_user_settings?.operation_speed === "slow_needs_one_round_notice", "pipeline must load operation speed into source context");
    assert(pipelineResult.source_context?.user_memory?.strategy_rows?.length === 1, "pipeline must prefer canonical user memory over compatibility files");
    assert(pipelineResult.standardized_live_state?.strategy_context?.value?.runtime_user_settings?.default_goal === "safe_top_four", "standardized live_state must expose user settings to strategy context");
    assert(pipelineResult.score?.live_state_summary?.runtime_user_settings?.operation_speed === "slow_needs_one_round_notice", "scorer summary must include operation speed");
    assert(pipelineResult.score?.advice_tasks?.some((task) => task.evidence?.some((entry) => entry.type === "runtime_user_settings")), "advice tasks must cite runtime user settings");
    assert(pipelineResult.score?.advice_tasks?.some((task) => task.semantic_labels?.includes("safe_top_four_bias")), "safe top-four setting must affect scorer labels");
    assert(pipelineResult.score?.advice_tasks?.some((task) => task.actions?.includes("prepare_one_round_ahead")), "slow operation speed must add one-round-ahead action");
    assert(pipelineResult.score?.advice_tasks?.some((task) => task.evidence?.some((entry) => entry.type === "user_strategy_rows")), "custom strategy rows must be cited as advice evidence");
    assert(pipelineResult.score?.advice_tasks?.some((task) => task.actions?.includes("respect_user_strategy:avoid_low_value_rolls")), "custom strategy row must affect scorer actions");
    assert(pipelineResult.score?.advice_tasks?.some((task) => task.semantic_labels?.includes("custom_economy_bias")), "custom strategy row must affect scorer labels");
    const strategicOwner = pipelineResult.score?.advice_tasks?.find((task) => task.fixed_checkpoint_id === "final_lineup_confirmation");
    assert(strategicOwner?.evidence?.some((entry) => entry.type === "runtime_user_settings"), "fixed strategic answer owner must inherit runtime user settings");
    assert(strategicOwner?.evidence?.some((entry) => entry.type === "user_strategy_rows"), "fixed strategic answer owner must inherit confirmed strategy rows");

    for (let index = 0; index < 22; index += 1) {
      const summaryRun = await runNode([
        "tools/write-jcc-postgame-summary.mjs",
        "--pipeline-result", outFile,
        "--out-dir", recentDir,
        "--max", "20",
        "--match-session-id", `summary-match-${String(index).padStart(2, "0")}`,
        "--result-rank", String((index % 8) + 1),
        "--now", `2026-06-11T00:${String(index + 2).padStart(2, "0")}:00.000Z`,
      ]);
      assert(summaryRun.code === 0, `postgame summary writer failed at ${index}\n${summaryRun.stdout}\n${summaryRun.stderr}`);
    }
    const files = (await readdir(recentDir)).filter((name) => name.endsWith(".json")).sort();
    assert(files.length === 20, `recent match summary rotation should keep 20 files, got ${files.length}`);
    assert(!files.some((name) => name.includes("summary-match-00") || name.includes("summary-match-01")), "oldest recent match summaries should be rotated out");
    const latestSummary = JSON.parse(await readFile(path.join(recentDir, files.at(-1)), "utf8"));
    assert(latestSummary.schema === "jcc-postgame-decision-summary-v1", "postgame summary schema mismatch");
    assert(latestSummary.storage_policy?.store_raw_screenshots === false, "postgame summary must not store screenshots");
    assert(latestSummary.storage_policy?.store_full_raw_logs === false, "postgame summary must not store full raw logs");
    assert(Array.isArray(latestSummary.advice_tasks), "postgame summary must retain advice task summaries");
    assert(latestSummary.full_live_state === undefined, "postgame summary must not retain full live_state dump");

    const dailyContextRun = await runNode([
      "tools/build-jcc-review-chat-context.mjs",
      "--mode", "daily_chat",
      "--user-settings", userSettingsFile,
      "--user-memory", userMemoryFile,
      "--recent-matches-dir", recentDir,
    ]);
    assert(dailyContextRun.code === 0, `daily chat context failed\n${dailyContextRun.stdout}\n${dailyContextRun.stderr}`);
    const dailyContext = JSON.parse(dailyContextRun.stdout);
    assert(dailyContext.mode === "daily_chat", "daily chat context mode mismatch");
    assert(dailyContext.runtime_user_settings.default_goal === "safe_top_four", "daily chat context must include user goal");
    assert(dailyContext.user_memory.preferences.length === 2, "daily chat context must include user memory");
    assert(dailyContext.user_strategy_rows.length === 2, "daily chat context must expose confirmed custom strategy rows");
    assert(dailyContext.memory_write_policy?.fixed_menu_settings?.default_goal === "menu_only_not_chat_inferred", "daily chat must keep default goal as menu-only setting");
    assert(dailyContext.memory_write_policy?.allowed_writes?.includes("strategy_rows"), "daily chat must allow confirmed custom strategy rows");
    assert(dailyContext.recent_match_summaries.length === 20, "daily chat context must include recent 20 summaries");
    assert(dailyContext.can_open_during_active_match === false, "daily chat must not open during active match");

    const postgameContextRun = await runNode([
      "tools/build-jcc-review-chat-context.mjs",
      "--mode", "postgame_review",
      "--user-settings", userSettingsFile,
      "--user-memory", userMemoryFile,
      "--recent-matches-dir", recentDir,
    ]);
    assert(postgameContextRun.code === 0, `postgame context failed\n${postgameContextRun.stdout}\n${postgameContextRun.stderr}`);
    const postgameContext = JSON.parse(postgameContextRun.stdout);
    assert(postgameContext.mode === "postgame_review", "postgame context mode mismatch");
    assert(postgameContext.review_focus?.includes("mistake_attribution"), "postgame context must expose review focus");
    assert(postgameContext.memory_write_policy?.requires_user_approval === true, "memory writes must require approval");

    const proposalRun = await runNode([
      "tools/propose-jcc-user-strategy-memory.mjs",
      "--mode", "postgame_review",
      "--message", "以后我想少 D 多运营，血量低的时候先稳血，不要硬贪。",
    ]);
    assert(proposalRun.code === 0, `strategy proposal failed\n${proposalRun.stdout}\n${proposalRun.stderr}`);
    const proposal = JSON.parse(proposalRun.stdout);
    assert(proposal.should_propose === true, "strategy proposal should detect long-term strategy text");
    assert(proposal.proposal?.write_target === "user_memory.strategy_rows", "strategy proposal must target custom strategy rows");
    assert(proposal.proposal?.approved === false, "strategy proposal must require user confirmation before write");
    assert(proposal.write_policy?.fixed_settings_not_inferred_here?.includes("default_goal"), "strategy proposal must not infer fixed menu settings");

    await writeFile(proposalFile, JSON.stringify({
      schema: "jcc-user-strategy-memory-proposal-v1",
      proposal: {
        id: "strategy-row-reroll-comfort-new",
        text: "如果开局对子多，我喜欢慢 D 赌牌。",
        tags: ["reroll_comfort"],
        weight: 1,
        source: "daily_chat_agent_proposed_user_confirmed_required",
        write_target: "user_memory.strategy_rows",
      },
    }, null, 2), "utf8");
    const applyRun = await runNode([
      "tools/apply-jcc-user-strategy-memory.mjs",
      "--user-memory", userMemoryFile,
      "--proposal", proposalFile,
      "--out", proposedMemoryFile,
      "--now", "2026-06-11T00:30:00.000Z",
    ]);
    assert(applyRun.code === 0, `strategy memory apply failed\n${applyRun.stdout}\n${applyRun.stderr}`);
    const applyResult = JSON.parse(applyRun.stdout);
    assert(applyResult.confirmed_strategy_row?.approved === true, "confirmed strategy row must be approved after apply");
    assert(applyResult.policy?.newest_confirmed_strategy_wins_for_now === true, "newest strategy must win for now");
    assert(applyResult.conflict_count >= 1, "strategy apply must detect conflicts after full scan");
    assert(applyResult.agent_notice_events?.some((event) => event.type === "strategy_conflict_notice"), "strategy apply must emit conflict notice event");
    const updatedMemory = JSON.parse(await readFile(proposedMemoryFile, "utf8"));
    assert(updatedMemory.strategy_rows?.some((row) => row.id === "strategy-row-reroll-comfort-new"), "confirmed row must be written into strategy_rows");
    assert(updatedMemory.strategy_conflict_notices?.length >= 1, "memory must retain strategy conflict notices");

    const conflictContextRun = await runNode([
      "tools/build-jcc-review-chat-context.mjs",
      "--mode", "daily_chat",
      "--user-settings", userSettingsFile,
      "--user-memory", proposedMemoryFile,
      "--recent-matches-dir", recentDir,
    ]);
    assert(conflictContextRun.code === 0, `conflict context failed\n${conflictContextRun.stdout}\n${conflictContextRun.stderr}`);
    const conflictContext = JSON.parse(conflictContextRun.stdout);
    assert(conflictContext.user_strategy_conflicts?.length >= 1, "daily chat context must expose strategy conflicts");
    assert(conflictContext.memory_write_policy?.chat_strategy_row_flow?.includes("agent_emits_strategy_conflict_notice_if_needed"), "memory flow must document conflict notices");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "pipeline reads runtime user settings",
        "pipeline reads user memory",
        "scorer advice cites settings/memory and changes actions",
        "custom strategy rows change scorer evidence/actions/labels",
        "daily/postgame chat can propose strategy rows without writing fixed settings",
        "confirmed strategy rows are written before full conflict scan",
        "strategy conflicts emit agent notice events",
        "postgame writer stores structured summaries only",
        "postgame writer rotates to 20 recent matches",
        "daily chat context reads settings/memory/recent summaries",
        "postgame review context reads settings/memory/recent summaries",
        "daily/postgame modes stay outside active match",
      ],
    }, null, 2));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
