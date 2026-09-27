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
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function actionSignal(type, payload, evidence = type) {
  return {
    source_file: "runtime.log",
    confidence: type === "sell_chess_candidate" ? 0.8 : 0.78,
    type,
    evidence,
    payload,
  };
}

async function buildLiveState(tempDir, name, signals) {
  const signalsFile = path.join(tempDir, `${name}-candidate-runtime-signals.json`);
  const liveStateFile = path.join(tempDir, `${name}-match-live-state.json`);
  await writeFile(signalsFile, `${JSON.stringify({
    ok: true,
    signal_kind: "candidate_runtime_signals",
    live_state_status: "not_complete_until_field_semantics_verified",
    decode_status: "decoded_with_local_catalog",
    signal_count: signals.length,
    signals,
  }, null, 2)}\n`, "utf8");
  const result = await runNode([
    "tools/build-jcc-match-live-state.mjs",
    "--signals",
    signalsFile,
    "--out",
    liveStateFile,
  ]);
  assert(result.code === 0, `live-state builder exited ${result.code}\n${result.stderr}`);
  return JSON.parse(await readFile(liveStateFile, "utf8"));
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-board-bench-actions-"));
  try {
    const baseSignal = {
      source_file: "runtime.log",
      confidence: 0.78,
    };
    const nonLocalSnapshot = await buildLiveState(tempDir, "nonlocal", [
        {
          ...baseSignal,
          type: "match_start",
          confidence: 0.9,
          evidence: "GameStart time:20260605213933",
          payload: {
            game_start_time: "20260605213933",
            interpretation: "new_match_window_boundary",
          },
        },
        {
          ...baseSignal,
          type: "local_report_chair_candidate",
          confidence: 0.84,
          evidence: "#SoGame_Report# [Frame:9075 TurnCount:12] next report index:0 chairid: 6 preReportIndex: 0 reportPlayerCount: 1",
          payload: {
            frame: 9075,
            turn_count: 12,
            next_report_index: 0,
            chair_id: 6,
            pre_report_index: 0,
            report_player_count: 1,
            interpretation: "local_report_chair_candidate",
          },
        },
        actionSignal("get_on_chess_candidate", {
            player_ref: "<player-id>",
            entity_id: 300064,
            action_chair_id_candidate: 3,
            raw_hero_id: 13453,
            star_or_state: 1,
            action: "get_on_chess",
            to: { x: 0, y: 3 },
            hero: { raw_id: 13453, champion_id: null, name: null },
            interpretation: "board_or_bench_action_candidate_not_promoted",
          }, "AITreeNode_GetOnChess Uin:<long-id> Hero:300064|13453|1 Up To Pos:0|3"),
        actionSignal("move_battle_chess_candidate", {
            player_ref: "<player-id>",
            entity_id: 300064,
            action_chair_id_candidate: 3,
            raw_hero_id: 13453,
            action: "move_battle_chess",
            from: { x: 0, y: 3 },
            to: { x: 2, y: 3 },
            ext: "",
            same_position: false,
            hero: { raw_id: 13453, champion_id: null, name: null },
            interpretation: "board_position_action_candidate_not_promoted",
          }, "AITreeNode_MoveBattleChess Uin:<long-id> Hero:300064|13453 From:0|3 To:2|3"),
        actionSignal("sell_chess_candidate", {
            player_ref: "<player-id>",
            entity_id: 99,
            action_chair_id_candidate: null,
            raw_hero_id: 12456,
            action: "sell_chess",
            position: { x: 0, y: -1 },
            hero: { raw_id: 12456, champion_id: null, name: null },
            interpretation: "sell_action_candidate_not_promoted",
          }, "AITreeNode_SellChess Uin:<long-id> Hero:99|12456 Pos:0|-1"),
    ]);

    const liveState = nonLocalSnapshot.live_state || {};
    const insights = liveState.source_insights?.board_bench_action_candidates;
    assert(insights?.count === 3, "must expose board/bench/sell action candidates");
    assert(insights.get_on_chess_count === 1, "must count get-on-chess action candidates");
    assert(insights.move_battle_chess_count === 1, "must count move-battle-chess action candidates");
    assert(insights.sell_chess_count === 1, "must count sell-chess action candidates");
    assert(insights.actions?.some((action) => action.action === "get_on_chess" && action.to?.x === 0 && action.to?.y === 3), "must preserve get-on-chess target position");
    assert(insights.actions?.some((action) => action.action === "move_battle_chess" && action.from?.x === 0 && action.to?.x === 2), "must preserve move-battle-chess positions");
    assert(insights.actions?.some((action) => action.action === "sell_chess" && action.position?.x === 0 && action.position?.y === -1), "must preserve sell-chess position");
    assert(insights.promotion_decision.board_units.status === "not_promoted", "action candidates must not promote to board_units");
    assert(insights.promotion_decision.bench_units.status === "not_promoted", "action candidates must not promote to bench_units");
    assert(insights.promotion_decision.position.status === "partial", "action candidates may only partially prove position");
    assert(insights.promotion_decision.sell.status === "partial", "sell candidates may only partially prove sell action");
    assert(Array.isArray(liveState.board?.board_units) && liveState.board.board_units.length === 0, "non-local board actions must not promote");
    assert(Array.isArray(liveState.bench?.bench_units) && liveState.bench.bench_units.length === 0, "unbound bench/sell actions must not promote");
    assert(liveState.field_status?.["source_insights.board_bench_action_candidates"]?.status === "partial", "source insight status must be partial");
    assert(liveState.field_status?.["board.board_units"]?.status === "blocked", "board.board_units status must remain blocked without strong local binding");
    assert(liveState.field_status?.["bench.bench_units"]?.status === "blocked", "bench.bench_units status must remain blocked without strong local binding");

    const localSnapshot = await buildLiveState(tempDir, "local", [
      {
        ...baseSignal,
        type: "match_start",
        confidence: 0.9,
        evidence: "GameStart time:20260605213933",
        payload: {
          game_start_time: "20260605213933",
          interpretation: "new_match_window_boundary",
        },
      },
      {
        ...baseSignal,
        type: "local_report_chair_candidate",
        confidence: 0.84,
        evidence: "#SoGame_Report# [Frame:9075 TurnCount:12] next report index:0 chairid: 3 preReportIndex: 0 reportPlayerCount: 1",
        payload: {
          frame: 9075,
          turn_count: 12,
          next_report_index: 0,
          chair_id: 3,
          pre_report_index: 0,
          report_player_count: 1,
          interpretation: "local_report_chair_candidate",
        },
      },
      actionSignal("switch_player_chair", {
        player_ref: "<player-id>",
        actor_ref: "actor:local03",
        chair_id: 3,
        ext: "TurnStartBack",
        interpretation: "view_or_actor_switch_candidate",
      }),
      actionSignal("get_on_chess_candidate", {
        player_ref: "<player-id>",
        actor_ref: "actor:local03",
        entity_id: 300064,
        action_chair_id_candidate: 3,
        raw_hero_id: 13453,
        star_or_state: 1,
        action: "get_on_chess",
        to: { x: 0, y: 3 },
        hero: { raw_id: 13453, champion_id: "3453", star_tier: 1, name: "Local A" },
        interpretation: "board_or_bench_action_candidate_not_promoted",
      }),
      actionSignal("move_battle_chess_candidate", {
        player_ref: "<player-id>",
        actor_ref: "actor:local03",
        entity_id: 300064,
        action_chair_id_candidate: 3,
        raw_hero_id: 13453,
        action: "move_battle_chess",
        from: { x: 0, y: 3 },
        to: { x: 2, y: 3 },
        ext: "",
        same_position: false,
        hero: { raw_id: 13453, champion_id: "3453", star_tier: 1, name: "Local A" },
        interpretation: "board_position_action_candidate_not_promoted",
      }),
      actionSignal("get_on_chess_candidate", {
        player_ref: "<player-id>",
        actor_ref: "actor:local03",
        entity_id: 300088,
        action_chair_id_candidate: 3,
        raw_hero_id: 12456,
        star_or_state: 1,
        action: "get_on_chess",
        to: { x: 1, y: -1 },
        hero: { raw_id: 12456, champion_id: "2456", star_tier: 1, name: "Local Bench" },
        interpretation: "board_or_bench_action_candidate_not_promoted",
      }),
      actionSignal("sell_chess_candidate", {
        player_ref: "<player-id>",
        actor_ref: "actor:local03",
        entity_id: 300088,
        action_chair_id_candidate: 3,
        raw_hero_id: 12456,
        action: "sell_chess",
        position: { x: 1, y: -1 },
        hero: { raw_id: 12456, champion_id: "2456", star_tier: 1, name: "Local Bench" },
        interpretation: "sell_action_candidate_not_promoted",
      }),
      actionSignal("get_on_chess_candidate", {
        player_ref: "<player-id>",
        entity_id: 400064,
        action_chair_id_candidate: 4,
        raw_hero_id: 11462,
        star_or_state: 1,
        action: "get_on_chess",
        to: { x: 6, y: 0 },
        hero: { raw_id: 11462, champion_id: "1462", star_tier: 1, name: "Non Local" },
        interpretation: "board_or_bench_action_candidate_not_promoted",
      }),
    ]);
    const localLiveState = localSnapshot.live_state || {};
    const folded = localLiveState.source_insights?.folded_board_bench_state;
    assert(folded?.action_count === 4, "folding must count only local chair actions");
    assert(folded.ignored_nonlocal_count === 1, "folding must count ignored non-local actions");
    assert(folded.action_type_counts?.get_on_chess_count === 2, "folding must count local get-on actions including bench insertion");
    assert(folded.action_type_counts?.sell_chess_count === 1, "folding must count local sell actions after bench insertion");
    assert(folded.board_units?.length === 1, "local action fold must retain one debug board unit");
    assert(folded.board_units[0].entity_id === 300064, "debug folded board unit must be local entity");
    assert(folded.board_units[0].position.x === 2 && folded.board_units[0].position.y === 3, "debug folded board unit must use latest move position");
    assert(folded.bench_units?.length === 0, "sold local bench unit must be removed from debug fold");
    assert(localLiveState.board?.board_units?.length === 0, "local action fold must not promote board units because combat boards can pollute home-board state");
    assert(localLiveState.bench?.bench_units?.length === 0, "local action fold must not promote bench units");
    assert(!JSON.stringify(localLiveState.board).includes("Non Local"), "non-local action must not pollute board state");
    assert(localLiveState.field_status?.["board.board_units"]?.status !== "observed", "debug action fold must not mark board observed");
    assert(localLiveState.field_status?.["source_insights.folded_board_bench_state"]?.status === "partial", "folded source insight must stay partial");

    const chairZeroSnapshot = await buildLiveState(tempDir, "chair-zero", [
      {
        ...baseSignal,
        type: "match_start",
        confidence: 0.9,
        evidence: "GameStart time:20260605213933",
        payload: {
          game_start_time: "20260605213933",
          interpretation: "new_match_window_boundary",
        },
      },
      {
        ...baseSignal,
        type: "local_report_chair_candidate",
        confidence: 0.84,
        evidence: "#SoGame_Report# [Frame:9075 TurnCount:12] next report index:0 chairid: 0 preReportIndex: 0 reportPlayerCount: 1",
        payload: {
          frame: 9075,
          turn_count: 12,
          next_report_index: 0,
          chair_id: 0,
          pre_report_index: 0,
          report_player_count: 1,
          interpretation: "local_report_chair_candidate",
        },
      },
      actionSignal("switch_player_chair", {
        player_ref: "<player-id>",
        actor_ref: "actor:chairzero01",
        chair_id: 0,
        ext: "TurnStartBack",
        interpretation: "view_or_actor_switch_candidate",
      }),
      actionSignal("get_on_chess_candidate", {
        player_ref: "<player-id>",
        actor_ref: "actor:chairzero01",
        entity_id: 99,
        action_chair_id_candidate: null,
        raw_hero_id: 12456,
        star_or_state: 1,
        action: "get_on_chess",
        to: { x: 0, y: -1 },
        hero: { raw_id: 12456, champion_id: "2456", star_tier: 1, name: "Chair Zero Bench" },
        interpretation: "board_or_bench_action_candidate_not_promoted",
      }),
      actionSignal("move_battle_chess_candidate", {
        player_ref: "<player-id>",
        actor_ref: "actor:chairzero01",
        entity_id: 99,
        action_chair_id_candidate: null,
        raw_hero_id: 12456,
        action: "move_battle_chess",
        from: { x: 0, y: -1 },
        to: { x: 2, y: 3 },
        ext: "",
        same_position: false,
        hero: { raw_id: 12456, champion_id: "2456", star_tier: 1, name: "Chair Zero Bench" },
        interpretation: "board_position_action_candidate_not_promoted",
      }),
      actionSignal("get_on_chess_candidate", {
        player_ref: "<player-id>",
        actor_ref: "actor:other000000",
        entity_id: 1,
        action_chair_id_candidate: null,
        raw_hero_id: 11462,
        star_or_state: 1,
        action: "get_on_chess",
        to: { x: 6, y: 0 },
        hero: { raw_id: 11462, champion_id: "1462", star_tier: 1, name: "Unknown Actor" },
        interpretation: "board_or_bench_action_candidate_not_promoted",
      }),
    ]);
    const chairZeroLiveState = chairZeroSnapshot.live_state || {};
    assert(chairZeroLiveState.source_insights?.folded_board_bench_state?.action_count === 2, "actor map must bind chair-zero local actions");
    assert(chairZeroLiveState.source_insights.folded_board_bench_state.ignored_unbound_count === 1, "unknown actor small entity must stay unbound");
    assert(chairZeroLiveState.source_insights.folded_board_bench_state.board_units?.length === 1, "chair-zero actor actions must retain debug board unit");
    assert(chairZeroLiveState.source_insights.folded_board_bench_state.board_units[0].entity_id === 99, "chair-zero small entity must be retained in debug fold");
    assert(chairZeroLiveState.source_insights.folded_board_bench_state.board_units[0].position.x === 2 && chairZeroLiveState.source_insights.folded_board_bench_state.board_units[0].position.y === 3, "chair-zero move must retain target board position in debug fold");
    assert(chairZeroLiveState.board?.board_units?.length === 0, "chair-zero debug action fold must not promote board unit");

    const conflictingBindingSnapshot = await buildLiveState(tempDir, "conflicting-binding", [
      {
        ...baseSignal,
        type: "match_start",
        confidence: 0.9,
        evidence: "GameStart time:20260605213933",
        payload: {
          game_start_time: "20260605213933",
          interpretation: "new_match_window_boundary",
        },
      },
      {
        ...baseSignal,
        type: "local_report_chair_candidate",
        confidence: 0.84,
        evidence: "#SoGame_Report# [Frame:100 TurnCount:1] next report index:0 chairid: 0 preReportIndex: 0 reportPlayerCount: 1",
        payload: {
          frame: 100,
          turn_count: 1,
          next_report_index: 0,
          chair_id: 0,
          pre_report_index: 0,
          report_player_count: 1,
          interpretation: "local_report_chair_candidate",
        },
      },
      {
        ...baseSignal,
        type: "local_report_chair_candidate",
        confidence: 0.84,
        evidence: "#SoGame_Report# [Frame:200 TurnCount:2] next report index:1 chairid: 3 preReportIndex: 0 reportPlayerCount: 1",
        payload: {
          frame: 200,
          turn_count: 2,
          next_report_index: 1,
          chair_id: 3,
          pre_report_index: 0,
          report_player_count: 1,
          interpretation: "local_report_chair_candidate",
        },
      },
      actionSignal("get_on_chess_candidate", {
        player_ref: "<player-id>",
        actor_ref: "actor:conflict03",
        entity_id: 300064,
        action_chair_id_candidate: 3,
        raw_hero_id: 13453,
        star_or_state: 1,
        action: "get_on_chess",
        to: { x: 2, y: 3 },
        hero: { raw_id: 13453, champion_id: "3453", star_tier: 1, name: "Conflict Local" },
        interpretation: "board_or_bench_action_candidate_not_promoted",
      }),
      actionSignal("get_on_chess_candidate", {
        player_ref: "<player-id>",
        actor_ref: "actor:conflict04",
        entity_id: 400064,
        action_chair_id_candidate: 4,
        raw_hero_id: 11462,
        star_or_state: 1,
        action: "get_on_chess",
        to: { x: 6, y: 0 },
        hero: { raw_id: 11462, champion_id: "1462", star_tier: 1, name: "Conflict Other" },
        interpretation: "board_or_bench_action_candidate_not_promoted",
      }),
    ]);
    const conflictingLiveState = conflictingBindingSnapshot.live_state || {};
    assert(conflictingBindingSnapshot.match?.binding_status === "weakly_bound_conflicting_reports", "conflicting local reports must weaken binding");
    assert(conflictingLiveState.gate?.strategy_input_allowed === false, "conflicting binding must block strategy input");
    assert(conflictingLiveState.source_insights?.board_bench_action_candidates?.count === 2, "conflicting binding must keep action audit visible");
    assert(conflictingLiveState.source_insights?.folded_board_bench_state?.action_count === 0, "conflicting binding must not fold actions into promoted board state");
    assert(conflictingLiveState.board?.board_units?.length === 0, "conflicting binding must not promote board state");
    assert(conflictingLiveState.field_status?.["local.local_chair_id"]?.status === "partial", "conflicting binding must mark local chair partial");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "board/bench/sell action candidates exposed",
        "get_on_chess target position retained",
        "move_battle_chess source/target retained",
        "sell_chess position retained",
        "non-local action candidates do not promote",
        "local action candidates fold into board state",
        "sell action removes local bench unit after insertion",
        "conflicting binding keeps folded state audit-only",
        "actor chair map promotes chair-zero small entity actions",
        "conflicting local chair reports block promotion",
        "field_status marks folded source insight as observed",
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
