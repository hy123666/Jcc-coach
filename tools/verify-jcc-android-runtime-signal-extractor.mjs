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

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-extractor-"));
  try {
    const logFile = path.join(tempDir, "runtime.log");
    const outFile = path.join(tempDir, "signals.json");
    await writeFile(logFile, [
      "TAC_GenerateHeroListFromHeroPool:11456,11454,11455,11457,11458,",
      "GameStart time:20260605213933",
      "TAC_GenerateHeroListFromHeroPool:11457,13470,8,0,",
      "InGameRoundSelectInfos|123456789012345|2026-06-05 19:05:19|1109811436|1|10010|914573605|14095456849|0|31|1|11462:-1:2223264523:8:1;11450:-1:3027392712:7:1;11457:-1:338601081:1:1;|17||tail",
      "InGameRoundFlow|123456789012345|2026-06-05 19:05:19||0|10010|338601081|14095456849|1|31|11|5|5|3|0|0|3|1|2|96|0|0|0|0|10428|5|2808|1712|0|1004;1005;|13462;12458:2045;13460:1007;12460;11457;|83360101;83370101;83200101;|13462;12460;12452;|3003;1001;|0|0|42|3|1|0|0|0|0|0|5|1|0|1|0|0|0|0|17|11|40;12;23;43;60;||||0||||0|4|secretTokenABC123456789XYZ",
      "TAC_ReqAddOutFieldToBattleGround:1, 18421, -5000, 7900",
      "EquipBagCtrl RefillBag: refillTimes=1, totalItems=8",
      "interalBattle iPlayerID is 2223264523, iEarnedMoney:3",
      "interalBattle iPlayerID is 2223264523, iDeductLife:5",
      "interalBattle pPlayer life 100, endflag True , life 95 ChairId: 1",
      "AITreeNode_SwitchPlayer Uin:2227756805 SwitchToChairId:6 Ext:TurnStartBack",
      "AITreeNode_GetOnChess Uin:271271988 Hero:300064|13453|1 Up To Pos:0|3",
      "AITreeNode_MoveBattleChess Uin:271271988 Hero:300064|13453 From:0|3 To:2|3",
      "AITreeNode_MoveBattleChess Uin:271271988 Hero:300012|12460 From:0|3 To:0|3 Ext:SamePos Do Not Move",
      "AITreeNode_SellChess Uin:271271988 Hero:99|12456 Pos:0|-1",
      "AITreeNode_SellChess Uin:271271988 Hero:500088|13471 Pos:2|-1",
      "#SoGame_Report# [Frame:9075 TurnCount:12] next report index:0 chairid: 6 preReportIndex: 0 reportPlayerCount: 1",
      "CSoGame PlayBattleEnd iChairId:6 CurrentTotalTurnCount:12",
      "CSoGame PlayBattleEnd Win:True",
      "minteralBattle iPlayerID:6 iEnemyID:0, vecEnemyLeftEntities size:0 vecPlayerLeftEntities size:1 bIsHome:False",
    ].join("\n"), "utf8");

    const result = await runNode([
      "tools/extract-jcc-android-runtime-signals.mjs",
      "--input",
      logFile,
      "--out",
      outFile,
    ]);
    assert(result.code === 0, `extractor exited ${result.code}\n${result.stderr}`);

    const report = JSON.parse(await readFile(outFile, "utf8"));
    const reportText = JSON.stringify(report);
    assert(!("input" in report), "report must not persist absolute input path");
    assert(!("patch_dir" in (report.catalog || {})), "report catalog must not persist absolute patch_dir");
    assert(typeof report.catalog?.patch_ref === "string", "report catalog must include portable patch_ref");
    assert(!path.isAbsolute(report.catalog.patch_ref), "report catalog patch_ref must be relative");
    assert(!reportText.includes(process.cwd()), "report must not persist workspace absolute paths");
    assert(!reportText.includes(tempDir), "report must not persist temp absolute paths");
    assert(!reportText.includes("secretTokenABC123456789XYZ"), "report must redact long alphanumeric tokens");

    const shop = report.signals.find((signal) => signal.type === "shop_roll_candidate");
    assert(report.signals.some((signal) => signal.type === "match_start" && signal.payload.game_start_time === "20260605213933"), "must extract match start boundaries");
    assert(shop, "missing shop_roll_candidate signal");
    assert(!shop.payload.hero_ids.includes(0), "shop_roll_candidate must not include false hero id 0 from trailing comma");
    assert(shop.payload.heroes?.some((hero) => hero.raw_id === 11457 && hero.name === "丽桑卓"), "shop_roll_candidate must decode 11457 as 丽桑卓");
    const noisyShop = report.signals.filter((signal) => signal.type === "shop_roll_candidate")[1];
    assert(noisyShop.payload.raw_numbers.includes(0), "shop_roll_candidate should keep raw numeric protocol fields for investigation");
    assert(!noisyShop.payload.hero_ids.includes(0) && !noisyShop.payload.hero_ids.includes(8), "shop_roll_candidate hero_ids must exclude placeholders");
    assert(noisyShop.payload.unknown_hero_ids.includes(13470), "shop_roll_candidate should separate undecoded positive ids");

    const select = report.signals.find((signal) => signal.type === "round_select_infos");
    assert(select?.payload.decoded?.select_entries?.some((entry) => entry.hero?.name === "丽桑卓" && entry.chair_id === 1), "round_select_infos must decode select entries");

    const flow = report.signals.find((signal) => signal.type === "round_flow");
    assert(flow?.payload.decoded?.heroes?.some((hero) => hero.name === "丽桑卓"), "round_flow must expose decoded hero candidates");
    assert(flow?.payload.decoded?.snapshot_candidate?.hp === 96, "round_flow must expose anonymous hp candidate");
    assert(flow?.payload.decoded?.snapshot_candidate?.chair_candidates?.includes(2), "round_flow must expose anonymous chair candidates");
    assert(flow?.payload.decoded?.snapshot_candidate?.board_units?.some((unit) => unit.hero?.raw_id === 13462), "round_flow must expose anonymous board hero candidates");
    assert(flow?.payload.decoded?.snapshot_candidate?.bench_units?.some((unit) => unit.hero?.raw_id === 12452), "round_flow must expose anonymous bench hero candidates");
    assert(flow?.payload.decoded?.snapshot_candidate?.item_bench?.some((item) => item.raw_id === 1001), "round_flow must expose anonymous item candidates");
    assert(!JSON.stringify(select.payload).includes("2223264523"), "runtime signal payload should redact long player-like ids");
    assert(report.signals.some((signal) => signal.type === "outfield_add_candidate"), "must extract outfield add candidates");
    assert(report.signals.some((signal) => signal.type === "equipment_bag_refill"), "must extract equipment bag refill");
    assert(report.signals.some((signal) => signal.type === "battle_result_money"), "must extract battle result money");
    assert(report.signals.some((signal) => signal.type === "battle_result_life"), "must extract battle result life");
    assert(report.signals.some((signal) => signal.type === "player_life"), "must extract player life");
    assert(report.signals.some((signal) => signal.type === "switch_player_chair" && signal.payload.chair_id === 6), "must extract switch-player chair candidates");
    assert(report.signals.some((signal) => signal.type === "local_report_chair_candidate" && signal.payload.chair_id === 6 && signal.payload.turn_count === 12), "must extract local report chair candidates");
    assert(report.signals.some((signal) => signal.type === "battle_end_chair" && signal.payload.chair_id === 6), "must extract battle-end chair candidates");
    assert(report.signals.some((signal) => signal.type === "battle_pairing" && signal.payload.player_chair_id === 6 && signal.payload.enemy_chair_id === 0), "must extract battle pairings");
    assert(!reportText.includes("2227756805"), "chair binding payload should redact UIN-like ids");
    const getOnChess = report.signals.find((signal) => signal.type === "get_on_chess_candidate");
    assert(/^actor:[0-9a-f]{12}$/.test(getOnChess?.payload.actor_ref || ""), "must preserve redacted get-on-chess actor ref");
    assert(getOnChess?.payload.entity_id === 300064, "must extract get-on-chess entity id");
    assert(getOnChess?.payload.action_chair_id_candidate === 3, "must infer get-on-chess action chair from entity id");
    assert(getOnChess?.payload.raw_hero_id === 13453, "must extract get-on-chess raw hero id");
    assert(getOnChess?.payload.to?.x === 0 && getOnChess?.payload.to?.y === 3, "must extract get-on-chess target position");
    assert(getOnChess?.payload.hero?.raw_id === 13453, "must preserve get-on-chess hero raw id");
    const moveChess = report.signals.find((signal) => signal.type === "move_battle_chess_candidate" && signal.payload.to?.x === 2);
    assert(moveChess?.payload.actor_ref === getOnChess.payload.actor_ref, "same UIN must map to same redacted actor ref");
    assert(moveChess?.payload.action_chair_id_candidate === 3, "must infer move-battle-chess action chair from entity id");
    assert(moveChess?.payload.from?.x === 0 && moveChess?.payload.from?.y === 3, "must extract move-battle-chess source position");
    assert(moveChess?.payload.to?.x === 2 && moveChess?.payload.to?.y === 3, "must extract move-battle-chess target position");
    assert(moveChess?.payload.hero?.raw_id === 13453, "must preserve move-battle-chess hero raw id");
    const samePositionMove = report.signals.find((signal) => signal.type === "move_battle_chess_candidate" && signal.payload.same_position);
    assert(samePositionMove?.payload.ext === "SamePos Do Not Move", "must preserve same-position move reason");
    const sellChess = report.signals.find((signal) => signal.type === "sell_chess_candidate");
    assert(sellChess?.payload.actor_ref === getOnChess.payload.actor_ref, "sell-chess must carry redacted actor ref");
    assert(sellChess?.payload.entity_id === 99, "must extract sell-chess entity id");
    assert(sellChess?.payload.action_chair_id_candidate == null, "small sell-chess entity ids must not invent an action chair");
    assert(sellChess?.payload.raw_hero_id === 12456, "must extract sell-chess raw hero id");
    assert(sellChess?.payload.position?.x === 0 && sellChess?.payload.position?.y === -1, "must extract sell-chess position");
    assert(sellChess?.payload.hero?.raw_id === 12456, "must preserve sell-chess hero raw id");
    const nunuVariantSell = report.signals.find((signal) => signal.type === "sell_chess_candidate" && signal.payload.raw_hero_id === 13471);
    assert(nunuVariantSell?.payload.hero?.champion_id === "4371", "observed 13471 action-log variant must decode as champion 4371");
    assert(nunuVariantSell?.payload.hero?.name === "努努和威朗普", "observed 13471 action-log variant must decode as 努努和威朗普");
    assert(nunuVariantSell?.payload.hero?.canonical_raw_id === 14371, "observed 13471 action-log variant must retain canonical raw id evidence");
    assert(nunuVariantSell?.payload.hero?.decode_alias === "observed_action_log_raw_id_variant", "observed 13471 action-log variant must declare alias provenance");
    assert(!reportText.includes("271271988"), "chess action payload should redact UIN-like ids");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "report privacy redaction",
        "match start boundary extracted",
        "shop tail comma ignored",
        "shop unknown ids separated",
        "hero ids decoded",
        "round select decoded",
        "round flow decoded",
        "round flow unknown candidates retained",
        "secondary signal types extracted",
        "chair binding signals extracted",
        "board/bench/sell action candidates extracted",
        "observed raw hero aliases decoded with provenance",
        "player-like ids redacted",
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
