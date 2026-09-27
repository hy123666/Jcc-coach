import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function runNode(args) {
  return new Promise((resolve, reject) => {
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
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function signal(type, payload, evidence = type) {
  return { type, payload, evidence, confidence: type === "match_start" ? 0.9 : 0.8, source_file: "runtime.log" };
}

function matchStart(gameStartTime) {
  return signal("match_start", {
    game_start_time: gameStartTime,
    interpretation: "new_match_window_boundary",
  }, `GameStart time:${gameStartTime}`);
}

function sell({ entityId, rawHeroId, championId, name, chair, x = 0, y = -1 }) {
  return signal("sell_chess_candidate", {
    player_ref: "<player-id>",
    actor_ref: `actor:chair${chair}`,
    entity_id: entityId,
    action_chair_id_candidate: chair,
    raw_hero_id: rawHeroId,
    action: "sell_chess",
    position: { x, y },
    hero: { raw_id: rawHeroId, champion_id: championId, name },
    interpretation: "sell_action_candidate_not_promoted",
  }, `AITreeNode_SellChess Uin:<long-id> Hero:${entityId}|${rawHeroId} Pos:${x}|${y}`);
}

function localReport(chair, turnCount = 1) {
  return signal("local_report_chair_candidate", {
    frame: turnCount * 100,
    turn_count: turnCount,
    next_report_index: 0,
    chair_id: chair,
    pre_report_index: 0,
    report_player_count: 1,
    interpretation: "local_report_chair_candidate",
  }, `#SoGame_Report# [Frame:${turnCount * 100} TurnCount:${turnCount}] next report index:0 chairid: ${chair} preReportIndex: 0 reportPlayerCount: 1`);
}

function switchPlayer(chair) {
  return signal("switch_player_chair", {
    player_ref: "<player-id>",
    actor_ref: `actor:chair${chair}`,
    chair_id: chair,
    ext: "TurnStartBack",
    interpretation: "view_or_actor_switch_candidate",
  }, `AITreeNode_SwitchPlayer Uin:<long-id> SwitchToChairId:${chair} Ext:TurnStartBack`);
}

async function writeSignals(file, signals) {
  await writeFile(file, `${JSON.stringify({
    ok: true,
    signal_kind: "candidate_runtime_signals",
    signal_count: signals.length,
    signals,
  }, null, 2)}\n`, "utf8");
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-current-match-diff-"));
  try {
    const beforeFile = path.join(tempDir, "before.json");
    const afterFile = path.join(tempDir, "after.json");
    const outFile = path.join(tempDir, "diff.json");

    const oldTwistedFateSell = sell({
      entityId: 700025,
      rawHeroId: 11450,
      championId: "1450",
      name: "崔斯特",
      chair: 7,
    });
    const currentNonTfSell = sell({
      entityId: 500077,
      rawHeroId: 11460,
      championId: "1460",
      name: "提莫",
      chair: 5,
      x: 2,
    });

    await writeSignals(beforeFile, [
      matchStart("20260606181245"),
      oldTwistedFateSell,
      matchStart("20260606191245"),
    ]);
    await writeSignals(afterFile, [
      matchStart("20260606181245"),
      oldTwistedFateSell,
      matchStart("20260606191245"),
      currentNonTfSell,
    ]);

    const result = await runNode([
      "tools/diff-jcc-current-match-actions.mjs",
      "--before",
      beforeFile,
      "--after",
      afterFile,
      "--champion-id",
      "1450",
      "--out",
      outFile,
    ]);
    assert(result.code === 0, `diff command exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const diff = JSON.parse(await readFile(outFile, "utf8"));
    assert(diff.current_match_only === true, "diff must declare current-match-only semantics");
    assert(diff.match.game_start_time === "20260606191245", "diff must use the latest GameStart as the current match");
    assert(diff.added_total === 1, "diff must only include actions added in the current match window");
    assert(diff.sell_delta === 1, "diff must count the new current-match sell");
    assert(diff.champion_sell_delta === 0, "old-match Twisted Fate sell must not leak into current-match champion delta");
    assert(!JSON.stringify(diff.added_actions).includes("崔斯特"), "old-match Twisted Fate action must not appear in current-match added actions");
    assert(diff.added_actions[0]?.hero?.name === "提莫", "current-match non-TF sell should remain visible");

    const sameMatchOut = path.join(tempDir, "same-match-diff.json");
    await writeSignals(beforeFile, [
      matchStart("20260606191245"),
      currentNonTfSell,
    ]);
    const currentTfSell = sell({
      entityId: 100022,
      rawHeroId: 11450,
      championId: "1450",
      name: "崔斯特",
      chair: 1,
      x: 1,
    });
    await writeSignals(afterFile, [
      matchStart("20260606191245"),
      currentNonTfSell,
      currentTfSell,
    ]);
    const sameMatchResult = await runNode([
      "tools/diff-jcc-current-match-actions.mjs",
      "--before",
      beforeFile,
      "--after",
      afterFile,
      "--champion-id",
      "1450",
      "--out",
      sameMatchOut,
    ]);
    assert(sameMatchResult.code === 0, `same-match diff command exited ${sameMatchResult.code}\n${sameMatchResult.stderr}`);
    const sameMatchDiff = JSON.parse(await readFile(sameMatchOut, "utf8"));
    assert(sameMatchDiff.added_total === 1, "same-match diff must subtract existing current-match actions");
    assert(sameMatchDiff.champion_sell_delta === 1, "same-match current Twisted Fate sell must be detected");
    assert(sameMatchDiff.champion_sells[0]?.entity_id === 100022, "detected Twisted Fate sell must be the new current-match action");

    const scopedOut = path.join(tempDir, "scoped-diff.json");
    const localSell = sell({
      entityId: 300111,
      rawHeroId: 11450,
      championId: "1450",
      name: "Local TF",
      chair: 3,
      x: 2,
    });
    const otherSell = sell({
      entityId: 500111,
      rawHeroId: 11460,
      championId: "1460",
      name: "Other Teemo",
      chair: 5,
      x: 4,
    });
    await writeSignals(beforeFile, [
      matchStart("20260606191245"),
      localReport(3, 1),
      switchPlayer(3),
    ]);
    await writeSignals(afterFile, [
      matchStart("20260606191245"),
      localReport(3, 1),
      switchPlayer(3),
      localSell,
      otherSell,
    ]);
    const scopedResult = await runNode([
      "tools/diff-jcc-current-match-actions.mjs",
      "--before",
      beforeFile,
      "--after",
      afterFile,
      "--champion-id",
      "1450",
      "--out",
      scopedOut,
    ]);
    assert(scopedResult.code === 0, `scoped diff command exited ${scopedResult.code}\n${scopedResult.stderr}`);
    const scopedDiff = JSON.parse(await readFile(scopedOut, "utf8"));
    assert(scopedDiff.local_binding?.binding_status === "strongly_bound", "actor switch plus local action must create strong local binding");
    assert(scopedDiff.primary_local_added_total === 1, "strong binding must split local actions into primary layer");
    assert(scopedDiff.secondary_global_added_total === 1, "strong binding must keep non-local actions in secondary layer");
    assert(scopedDiff.primary_local_champion_sell_delta === 1, "primary local champion delta must count local target sell only");
    assert(scopedDiff.primary_local_added_actions[0]?.entity_id === 300111, "primary local action must be the local sell");
    assert(scopedDiff.secondary_global_added_actions[0]?.entity_id === 500111, "secondary global action must be the non-local sell");

    const conflictingOut = path.join(tempDir, "conflicting-diff.json");
    await writeSignals(beforeFile, [
      matchStart("20260606191245"),
      localReport(1, 1),
    ]);
    await writeSignals(afterFile, [
      matchStart("20260606191245"),
      localReport(1, 1),
      localReport(3, 2),
      localSell,
      otherSell,
    ]);
    const conflictingResult = await runNode([
      "tools/diff-jcc-current-match-actions.mjs",
      "--before",
      beforeFile,
      "--after",
      afterFile,
      "--champion-id",
      "1450",
      "--out",
      conflictingOut,
    ]);
    assert(conflictingResult.code === 0, `conflicting diff command exited ${conflictingResult.code}\n${conflictingResult.stderr}`);
    const conflictingDiff = JSON.parse(await readFile(conflictingOut, "utf8"));
    assert(conflictingDiff.local_binding?.binding_status === "weakly_bound_conflicting_reports", "conflicting reports must weaken local binding");
    assert(conflictingDiff.action_scope_decision?.primary_status === "blocked", "weak binding must block primary local layer");
    assert(conflictingDiff.primary_local_added_total === 0, "weak binding must not expose primary local actions");
    assert(conflictingDiff.secondary_global_added_total === 2, "weak binding must keep all actions secondary/debug-only");
    assert(conflictingDiff.primary_local_champion_sell_delta === 0, "weak binding must not claim a primary local champion sell");

    const reportOnlyOut = path.join(tempDir, "report-only-diff.json");
    await writeSignals(beforeFile, [
      matchStart("20260606191245"),
      localReport(3, 1),
    ]);
    await writeSignals(afterFile, [
      matchStart("20260606191245"),
      localReport(3, 1),
      localSell,
    ]);
    const reportOnlyResult = await runNode([
      "tools/diff-jcc-current-match-actions.mjs",
      "--before",
      beforeFile,
      "--after",
      afterFile,
      "--out",
      reportOnlyOut,
    ]);
    assert(reportOnlyResult.code === 0, `report-only diff command exited ${reportOnlyResult.code}\n${reportOnlyResult.stderr}`);
    const reportOnlyDiff = JSON.parse(await readFile(reportOnlyOut, "utf8"));
    assert(reportOnlyDiff.local_binding?.binding_status === "weakly_bound_report_cycle", "single report-only chair must not be strong local binding");
    assert(reportOnlyDiff.primary_local_added_total === 0, "report-only chair must not expose primary local actions");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "old match action candidates do not pollute current match delta",
        "latest GameStart defines current match scope",
        "same-match before actions are subtracted as a multiset",
        "current-match Twisted Fate sell remains detectable",
        "strong local binding splits primary local actions from secondary global actions",
        "weak local binding blocks primary local action claims",
        "report-only chair candidates remain weak and do not promote",
      ],
    }, null, 2));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
