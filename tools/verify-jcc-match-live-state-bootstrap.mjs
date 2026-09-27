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

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-match-live-state-"));
  try {
    const signalsFile = path.join(tempDir, "signals.json");
    const unboundSignalsFile = path.join(tempDir, "unbound-signals.json");
    const endedSignalsFile = path.join(tempDir, "ended-signals.json");
    const sourceHealthFile = path.join(tempDir, "source-health.json");
    const outFile = path.join(tempDir, "live-state.json");
    const unboundOutFile = path.join(tempDir, "unbound-live-state.json");
    const endedOutFile = path.join(tempDir, "ended-live-state.json");
    await writeFile(signalsFile, JSON.stringify({
      ok: true,
      signal_kind: "candidate_runtime_signals",
      signals: [
        {
          type: "match_start",
          confidence: 0.9,
          payload: { game_start_time: "20260605200000" },
          evidence: "GameStart time:20260605200000",
        },
        {
          type: "local_report_chair_candidate",
          confidence: 0.84,
          payload: { frame: 100, turn_count: 1, chair_id: 6, report_player_count: 1 },
          evidence: "#SoGame_Report# chairid: 6",
        },
        {
          type: "player_life",
          confidence: 0.72,
          payload: { chair_id: 6, life: 92 },
          evidence: "ChairId: 6",
        },
        {
          type: "match_start",
          confidence: 0.9,
          payload: { game_start_time: "20260605210000" },
          evidence: "GameStart time:20260605210000",
        },
        {
          type: "player_life",
          confidence: 0.72,
          payload: { chair_id: 6, life: 88 },
          evidence: "old chair should not bind new match",
        },
        {
          type: "local_report_chair_candidate",
          confidence: 0.84,
          payload: { frame: 120, turn_count: 1, chair_id: 2, report_player_count: 1 },
          evidence: "#SoGame_Report# chairid: 2",
        },
        {
          type: "switch_player_chair",
          confidence: 0.72,
          payload: { actor_ref: "actor:local-chair-2", chair_id: 2, ext: "TurnStartBack" },
          evidence: "AITreeNode_SwitchPlayer Uin:<long-id> SwitchToChairId:2 Ext:TurnStartBack",
        },
        {
          type: "get_on_chess_candidate",
          confidence: 0.78,
          payload: {
            actor_ref: "actor:local-chair-2",
            entity_id: 200123,
            action_chair_id_candidate: 2,
            raw_hero_id: 11457,
            star_or_state: 1,
            action: "get_on_chess",
            to: { x: 0, y: -1 },
            hero: { raw_id: 11457, champion_id: "1457", name: "Lissandra", cost: 1, traits: [] },
          },
          evidence: "AITreeNode_GetOnChess Uin:<long-id> Hero:200123|11457|1 Up To Pos:0|-1",
        },
        {
          type: "turn_data_marker",
          confidence: 0.74,
          payload: { decoded: { turn_candidate: 7 } },
          evidence: "LogOnly_GamePlayTurnData synthetic turn 7",
        },
        {
          type: "round_flow",
          confidence: 0.7,
          payload: {
            decoded: {
              snapshot_candidate: {
                interpretation: "anonymous_round_flow_snapshot_candidate",
                turn_count: 7,
                chair_candidates: [2, 4],
                hp: 96,
                level_candidate: 5,
                board_units: [{ hero: { raw_id: 13462, name: "Poppy" }, item_candidates: [] }],
                bench_units: [{ hero: { raw_id: 12452, name: "Talon" }, item_candidates: [] }],
                item_bench: [{ raw_id: 1001, name: "B.F. Sword" }],
              },
            },
          },
          evidence: "synthetic anonymous round flow snapshot",
        },
        {
          type: "round_flow",
          confidence: 0.7,
          payload: {
            decoded: {
              snapshot_candidate: {
                interpretation: "anonymous_round_flow_snapshot_candidate",
                turn_count: 7,
                chair_candidates: [2],
                hp: 88,
                board_units: [{ hero: { raw_id: 11450, name: "WrongHpCandidate" }, item_candidates: [] }],
                bench_units: [],
                item_bench: [],
              },
            },
          },
          evidence: "synthetic local chair but wrong hp",
        },
        {
          type: "player_life",
          confidence: 0.72,
          payload: { chair_id: 2, life: 96 },
          evidence: "ChairId: 2",
        },
        {
          type: "player_life",
          confidence: 0.72,
          payload: { chair_id: 5, life: 81 },
          evidence: "ChairId: 5",
        },
        {
          type: "player_life",
          confidence: 0.72,
          payload: { chair_id: 7, life: 0 },
          evidence: "dead opponent chair 7",
        },
        {
          type: "player_life",
          confidence: 0.72,
          payload: { chair_id: 44, life: 77 },
          evidence: "entity-like chair id must not become opponent",
        },
        {
          type: "battle_pairing",
          confidence: 0.74,
          payload: { player_chair_id: 2, enemy_chair_id: 5, is_home_board: false },
          evidence: "minteralBattle iPlayerID:2 iEnemyID:5 bIsHome:False",
        },
        {
          type: "battle_pairing",
          confidence: 0.74,
          payload: { player_chair_id: 2, enemy_chair_id: -1, is_home_board: true },
          evidence: "latest invalid pairing must not erase previous valid opponent",
        },
        {
          type: "shop_roll_candidate",
          confidence: 0.86,
          payload: {
            hero_ids: [11457],
            heroes: [{ raw_id: 11457, champion_id: "1457", name: "Lissandra", cost: 1, traits: [] }],
          },
          evidence: "TAC_GenerateHeroListFromHeroPool:11457",
        },
        {
          type: "board_unit_state",
          confidence: 0.8,
          payload: {
            chair_id: 2,
            entity_id: "local-board-1",
            champion_id: "1457",
            name: "Lissandra",
            star_level: 2,
            position: { row: 1, col: 3 },
            items: [{ item_id: "2091", name: "Guinsoo's Rageblade" }],
            summoned: false,
            clone: false,
          },
          evidence: "synthetic board local chair 2",
        },
        {
          type: "board_unit_state",
          confidence: 0.8,
          payload: {
            chair_id: 6,
            entity_id: "enemy-board-1",
            champion_id: "1450",
            name: "EnemyOnlyUnit",
            star_level: 1,
            position: { row: 0, col: 0 },
            items: [],
          },
          evidence: "synthetic board old chair 6",
        },
        {
          type: "bench_unit_state",
          confidence: 0.8,
          payload: {
            chair_id: 2,
            slot: 0,
            champion_id: "1501",
            name: "Nasus",
            star_level: 1,
            items: [],
            sellable: true,
          },
          evidence: "synthetic bench local chair 2",
        },
        {
          type: "item_bench_state",
          confidence: 0.78,
          payload: {
            chair_id: 2,
            slot: 1,
            item_id: "1001",
            name: "B.F. Sword",
            item_type: "component",
          },
          evidence: "synthetic item bench local chair 2",
        },
        {
          type: "equipped_item_state",
          confidence: 0.78,
          payload: {
            chair_id: 2,
            entity_id: "local-board-1",
            champion_id: "1457",
            item_id: "2091",
            name: "Guinsoo's Rageblade",
            item_type: "completed",
          },
          evidence: "synthetic equipped item local chair 2",
        },
      ],
    }, null, 2), "utf8");
    await writeFile(unboundSignalsFile, JSON.stringify({
      ok: true,
      signal_kind: "candidate_runtime_signals",
      signals: [
        {
          type: "match_start",
          confidence: 0.9,
          payload: { game_start_time: "20260605220000" },
          evidence: "GameStart time:20260605220000",
        },
        {
          type: "player_life",
          confidence: 0.72,
          payload: { chair_id: 3, life: 91 },
          evidence: "unbound life must not become local hp",
        },
        {
          type: "shop_roll_candidate",
          confidence: 0.86,
          payload: {
            hero_ids: [11457],
            heroes: [{ raw_id: 11457, champion_id: "1457", name: "Lissandra", cost: 1, traits: [] }],
          },
          evidence: "unbound shop must not become strategy input",
        },
        {
          type: "board_unit_state",
          confidence: 0.8,
          payload: {
            chair_id: 3,
            entity_id: "unbound-board-1",
            champion_id: "1457",
            name: "Lissandra",
            star_level: 2,
            position: { row: 1, col: 3 },
            items: [],
          },
          evidence: "unbound board must not become local board",
        },
      ],
    }, null, 2), "utf8");
    await writeFile(endedSignalsFile, JSON.stringify({
      ok: true,
      signal_kind: "candidate_runtime_signals",
      signals: [
        {
          type: "match_start",
          confidence: 0.9,
          payload: { game_start_time: "20260605230000" },
          evidence: "GameStart time:20260605230000",
        },
        {
          type: "local_report_chair_candidate",
          confidence: 0.84,
          payload: { frame: 100, turn_count: 1, chair_id: 4, report_player_count: 1 },
          evidence: "#SoGame_Report# chairid: 4",
        },
        {
          type: "switch_player_chair",
          confidence: 0.72,
          payload: { actor_ref: "actor:local-chair-4", chair_id: 4, ext: "TurnStartBack" },
          evidence: "AITreeNode_SwitchPlayer Uin:<long-id> SwitchToChairId:4 Ext:TurnStartBack",
        },
        {
          type: "sell_chess_candidate",
          confidence: 0.8,
          payload: {
            actor_ref: "actor:local-chair-4",
            entity_id: 400123,
            action_chair_id_candidate: 4,
            raw_hero_id: 11457,
            action: "sell_chess",
            position: { x: 0, y: -1 },
            hero: { raw_id: 11457, champion_id: "1457", name: "Lissandra" },
          },
          evidence: "AITreeNode_SellChess Uin:<long-id> Hero:400123|11457 Pos:0|-1",
        },
        {
          type: "player_life",
          confidence: 0.72,
          payload: { chair_id: 4, life: 0 },
          evidence: "local player eliminated",
        },
        {
          type: "match_end",
          confidence: 0.76,
          payload: { game_end_time: "20260605233512", reason: "postgame_result_observed" },
          evidence: "synthetic postgame result boundary",
        },
      ],
    }, null, 2), "utf8");
    await writeFile(sourceHealthFile, JSON.stringify({
      contract_id: "jcc-android-runtime-source-health",
      product_boundary: "generic_android_adb_source",
      adb_device_id: "127.0.0.1:7555",
      emulator_profile: "mumu",
      profile_is_product_boundary: false,
      package_id: "com.tencent.jkchess",
      capabilities: {
        adb_transport: "verified",
        foreground_package: "verified",
        external_files: "verified",
      },
    }, null, 2), "utf8");

    const result = await runNode([
      "tools/build-jcc-match-live-state.mjs",
      "--signals",
      signalsFile,
      "--source-health",
      sourceHealthFile,
      "--out",
      outFile,
    ]);
    assert(result.code === 0, `live-state builder exited ${result.code}\n${result.stderr}`);

    const liveState = JSON.parse(await readFile(outFile, "utf8"));
    assert(liveState.ok === true, "live-state builder should produce ok=true for a strongly bound match");
    assert(liveState.match?.game_start_time === "20260605210000", "builder must select the latest match window");
    assert(liveState.match?.game_end_time == null, "in-game match must not invent game_end_time");
    assert(liveState.match?.status === "in_game", "match without end signal must report status=in_game");
    assert(liveState.live_state?.field_status?.["match.status"]?.status === "verified", "in-game match must expose verified match status");
    assert(liveState.match?.local_chair_id === 2, "builder must bind chair 2 for the latest match");
    assert(liveState.match?.binding_status === "strongly_bound", "local chair binding must be strong before strategy use");
    assert(liveState.match?.binding_source === "action_actor_switch_player_chair", "binding should come from action actor switch evidence");
    assert(liveState.live_state?.phase?.turn_count === 7, "turn marker must normalize into phase.turn_count");
    assert(liveState.live_state?.source_insights?.round_flow_snapshots?.[0]?.hp === 96, "anonymous round_flow snapshots must be exposed as source insights");
    assert(liveState.live_state?.source_insights?.round_flow_snapshots?.[0]?.binding_status === "anonymous_unbound_candidate", "round_flow source insights must not claim local binding");
    assert(liveState.live_state?.source_insights?.round_flow_snapshots?.[0]?.board_units?.[0]?.hero?.raw_id === 13462, "round_flow source insights must carry board candidates");
    assert(liveState.live_state?.source_insights?.round_flow_binding_candidates?.[0]?.binding_status === "candidate_not_promoted", "round_flow binding candidates must not auto-promote to local board");
    assert(liveState.live_state?.source_insights?.round_flow_binding_candidates?.[0]?.matched_signals?.includes("hp"), "round_flow binding candidates should record hp matches");
    assert(liveState.live_state?.source_insights?.round_flow_binding_candidates?.some((candidate) => candidate.conflicts?.includes("hp_mismatch")), "round_flow binding candidates should record hp conflicts");
    assert(liveState.live_state?.source_insights?.round_flow_binding_decision?.status === "not_promoted", "round_flow binding decision must remain not_promoted without full proof");
    assert(liveState.live_state?.source_insights?.round_flow_binding_decision?.reason === "round_flow_chair_semantics_unverified", "round_flow binding decision must explain unverified chair semantics");
    assert(liveState.live_state?.field_status?.["source_insights.round_flow_snapshots"]?.status === "observed", "field_status must expose observed round_flow source insights");
    assert(liveState.live_state?.field_status?.["source_insights.round_flow_binding_candidates"]?.status === "partial", "field_status must expose partial round_flow binding candidates");
    assert(liveState.live_state?.field_status?.["phase.turn_count"]?.status === "partial", "field_status must expose partial turn_count status");
    assert(liveState.live_state?.hp === 96, "hp must be filtered through latest match local chair");
    assert(liveState.live_state?.opponents?.alive_count === 3, "alive_count must include alive player chairs only");
    assert(!("snapshots" in (liveState.live_state?.opponents || {})), "opponents.snapshots must not be emitted as a product field");
    assert(liveState.live_state?.combat?.opponent_chair_id === 5, "battle pairing must normalize local combat opponent");
    assert(liveState.live_state?.combat?.is_home_board === false, "battle pairing must normalize is_home_board");
    assert(!liveState.live_state?.field_status?.["opponents.snapshots"], "field_status must not expose opponent snapshots status");
    assert(liveState.live_state?.field_status?.["opponents.alive_count"]?.status === "partial", "field_status must expose alive_count status");
    assert(liveState.live_state?.field_status?.["opponents.current_rank"]?.status === "missing", "current_rank must remain missing without rank evidence");
    assert(liveState.live_state?.field_status?.["combat.opponent_chair_id"]?.status === "partial", "field_status must expose combat opponent status");
    assert(JSON.stringify(liveState).includes("Lissandra"), "shop candidates should be carried into live state");
    assert(liveState.live_state?.board_units?.[0]?.name === "Lissandra", "board units must be carried for the bound local chair");
    assert(!JSON.stringify(liveState.live_state?.board_units || []).includes("EnemyOnlyUnit"), "board units must filter out non-local chairs");
    assert(liveState.live_state?.board_units?.[0]?.evidence === "synthetic board local chair 2", "board units must keep evidence pointers");
    assert(liveState.live_state?.bench_units?.[0]?.name === "Nasus", "bench units must be carried for the bound local chair");
    assert(liveState.live_state?.item_bench?.[0]?.name === "B.F. Sword", "item bench must be carried for the bound local chair");
    assert(liveState.live_state?.equipped_items?.[0]?.name === "Guinsoo's Rageblade", "equipped items must be carried for the bound local chair");
    assert(!liveState.live_state?.missing_fields?.includes("board.board_units"), "live_state with board evidence should not mark board.board_units missing in the current snapshot");
    assert(!liveState.live_state?.missing_fields?.includes("bench.bench_units"), "live_state with bench evidence should not mark bench.bench_units missing in the current snapshot");
    assert(!liveState.live_state?.missing_fields?.includes("items.item_bench"), "live_state with item bench evidence should not mark items.item_bench missing in the current snapshot");
    assert(!liveState.live_state?.missing_fields?.includes("items.equipped_items"), "live_state with equipped item evidence should not mark items.equipped_items missing in the current snapshot");
    assert(!liveState.metadata?.missing_fields?.includes("board.board_units"), "metadata missing fields must match current snapshot board evidence");
    assert(!liveState.metadata?.missing_fields?.includes("bench.bench_units"), "metadata missing fields must match current snapshot bench evidence");
    assert(!liveState.metadata?.missing_fields?.includes("items.item_bench"), "metadata missing fields must match current snapshot item bench evidence");
    assert(!liveState.metadata?.missing_fields?.includes("items.equipped_items"), "metadata missing fields must match current snapshot equipped item evidence");
    assert(liveState.live_state?.field_status?.["economy.hp"]?.status === "verified", "field_status must expose hp status");
    assert(liveState.live_state?.field_status?.["shop.shop_units"]?.status === "verified", "field_status must expose shop status");
    assert(liveState.live_state?.field_status?.["board.board_units"]?.status === "observed", "field_status must expose observed board status when snapshot evidence exists");
    assert(liveState.live_state?.field_status?.["board.board_units"]?.evidence === "synthetic board local chair 2", "field_status must keep board evidence pointer");
    assert(liveState.live_state?.field_status?.["bench.bench_units"]?.status === "observed", "field_status must expose observed bench status when snapshot evidence exists");
    assert(liveState.live_state?.field_status?.["items.item_bench"]?.status === "observed", "field_status must expose observed item bench status when snapshot evidence exists");
    assert(liveState.live_state?.field_status?.["items.equipped_items"]?.status === "observed", "field_status must expose observed equipped item status when snapshot evidence exists");
    assert(!JSON.stringify(liveState.match).includes("\"local_chair_id\":6"), "latest match must not reuse prior chair 6");
    assert(liveState.runtime_contract?.opening_gate === "local_chair_id_required_before_strategy", "runtime contract must expose opening binding gate");
    assert(liveState.field_matrix?.schema_ref === "data/runtime/jcc/android-live-state-schema.json", "live_state must reference Android runtime schema");
    assert(liveState.field_matrix?.evidence_matrix_ref === "data/runtime/jcc/android-live-state-field-evidence-matrix.json", "live_state must reference field evidence matrix");
    assert(liveState.field_matrix?.verified_fields?.includes("local.local_chair_id"), "field matrix summary must expose verified local_chair_id");
    assert(liveState.metadata?.source_health?.product_boundary === "generic_android_adb_source", "live_state metadata must carry generic source boundary");
    assert(liveState.metadata?.emulator_profile === "mumu", "live_state metadata must carry emulator profile");

    const unboundResult = await runNode([
      "tools/build-jcc-match-live-state.mjs",
      "--signals",
      unboundSignalsFile,
      "--source-health",
      sourceHealthFile,
      "--out",
      unboundOutFile,
    ]);
    assert(unboundResult.code === 0, `unbound live-state builder exited ${unboundResult.code}\n${unboundResult.stderr}`);
    const unboundLiveState = JSON.parse(await readFile(unboundOutFile, "utf8"));
    assert(unboundLiveState.ok === false, "unbound match must not be ok for strategy use");
    assert(unboundLiveState.match?.binding_status === "unbound", "unbound match must report binding_status=unbound");
    assert(unboundLiveState.live_state?.hp == null, "unbound match must not emit local hp");
    assert((unboundLiveState.live_state?.shop_candidates || []).length === 0, "unbound match must not emit shop candidates as player-specific state");
    assert((unboundLiveState.live_state?.board_units || []).length === 0, "unbound match must not emit board units");
    assert(!("snapshots" in (unboundLiveState.live_state?.opponents || {})), "unbound match must not emit opponent snapshots");
    assert(unboundLiveState.live_state?.combat?.opponent_chair_id == null, "unbound match must not emit combat opponent");
    assert(unboundLiveState.live_state?.gate?.strategy_input_allowed === false, "unbound match must expose strategy gate=false");
    assert(unboundLiveState.live_state?.gate?.reason === "local_chair_id_unbound", "unbound match must explain the gate reason");
    assert(unboundLiveState.live_state?.field_status?.["shop.shop_units"]?.status === "blocked", "unbound shop field status must be blocked");
    assert(unboundLiveState.live_state?.field_status?.["shop.shop_units"]?.blocker === "local_chair_id_unbound", "unbound blocked field must explain blocker");
    assert(unboundLiveState.live_state?.missing_fields?.includes("local.local_chair_id"), "unbound match must mark local_chair_id missing");
    assert(unboundLiveState.metadata?.stale_fields?.includes("player_specific_state"), "unbound match must mark player-specific state as stale/unusable");

    const endedResult = await runNode([
      "tools/build-jcc-match-live-state.mjs",
      "--signals",
      endedSignalsFile,
      "--source-health",
      sourceHealthFile,
      "--out",
      endedOutFile,
    ]);
    assert(endedResult.code === 0, `ended live-state builder exited ${endedResult.code}\n${endedResult.stderr}`);
    const endedLiveState = JSON.parse(await readFile(endedOutFile, "utf8"));
    assert(endedLiveState.match?.status === "ended", "match_end signal must set match.status=ended");
    assert(endedLiveState.match?.game_end_time === "20260605233512", "match_end signal must set match.game_end_time");
    assert(endedLiveState.ok === false, "ended match must close the strategy input gate");
    assert(endedLiveState.live_state?.gate?.reason === "match_ended", "ended match gate must explain match_ended");
    assert(endedLiveState.live_state?.field_status?.["match.game_end_time"]?.status === "observed", "ended match must expose observed game_end_time field status");
    assert(endedLiveState.live_state?.field_status?.["match.status"]?.status === "verified", "ended match must expose verified match status");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "new match resets previous chair",
        "opening local chair binding is required",
        "unbound match blocks player-specific strategy state",
        "latest match local chair filters player hp",
        "shop candidates pass through normalized live state",
        "board/bench/items pass through normalized live state",
        "board/bench/items are filtered by latest match local chair",
        "field matrix summary attached",
        "missing fields surfaced",
        "source health metadata attached",
        "match lifecycle status and end gate handled",
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
