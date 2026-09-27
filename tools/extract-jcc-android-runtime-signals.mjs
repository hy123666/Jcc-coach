import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { activeHardDataPackageDir } from "./jcc_hard_data_target.mjs";

const SIGNAL_PATTERNS = [
  {
    type: "match_start",
    pattern: /GameStart time:([0-9]{14})/g,
    confidence: 0.9,
  },
  {
    type: "round_flow",
    pattern: /InGameRoundFlow\|([^\r\n\x00]{20,900})/g,
    confidence: 0.7,
  },
  {
    type: "round_select_infos",
    pattern: /InGameRoundSelectInfos\|([^\r\n\x00]{20,900})/g,
    confidence: 0.82,
  },
  {
    type: "shop_roll_candidate",
    pattern: /TAC_GenerateHeroListFromHeroPool:([0-9,\s-]+)/g,
    confidence: 0.86,
  },
  {
    type: "outfield_add_candidate",
    pattern: /TAC_ReqAddOutFieldToBattleGround:([0-9,\s-]+)/g,
    confidence: 0.78,
  },
  {
    type: "equipment_bag_refill",
    pattern: /EquipBagCtrl RefillBag: refillTimes=([0-9]+), totalItems=([0-9]+)/g,
    confidence: 0.82,
  },
  {
    type: "turn_data_marker",
    pattern: /LogOnly_GamePlayTurnData\s*,([^\r\n\x00]{20,500})/g,
    confidence: 0.74,
  },
  {
    type: "battle_result_money",
    pattern: /interalBattle iPlayerID is ([0-9]+), iEarnedMoney:([0-9-]+)/g,
    confidence: 0.68,
  },
  {
    type: "battle_result_life",
    pattern: /interalBattle iPlayerID is ([0-9]+), iDeductLife:([0-9-]+)/g,
    confidence: 0.68,
  },
  {
    type: "player_life",
    pattern: /interalBattle pPlayer life ([0-9-]+), endflag (True|False) , life ([0-9-]+) ChairId: ([0-9]+)/g,
    confidence: 0.72,
  },
  {
    type: "switch_player_chair",
    pattern: /AITreeNode_SwitchPlayer Uin:([0-9]+) SwitchToChairId:([0-9-]+) Ext:([^\s\r\n\x00]+)/g,
    confidence: 0.72,
  },
  {
    type: "observed_battlefield_chair_candidate",
    pattern: /ObservedManager ChessBattleField open observe ([0-9-]+)/g,
    confidence: 0.76,
  },
  {
    type: "observed_logic_player_chair_candidate",
    pattern: /ChessBattleLogicPlayer ([0-9-]+) Attach Queue ([0-9-]+)/g,
    confidence: 0.68,
  },
  {
    type: "get_on_chess_candidate",
    pattern: /AITreeNode_GetOnChess Uin:([0-9]+) Hero:([0-9]+)\|([0-9]+)\|([0-9-]+) Up To Pos:([0-9-]+)\|([0-9-]+)/g,
    confidence: 0.78,
  },
  {
    type: "move_battle_chess_candidate",
    pattern: /AITreeNode_MoveBattleChess Uin:([0-9]+) Hero:([0-9]+)\|([0-9]+) From:([0-9-]+)\|([0-9-]+) To:([0-9-]+)\|([0-9-]+)(?: Ext:([^\r\n\x00]+))?/g,
    confidence: 0.78,
  },
  {
    type: "sell_chess_candidate",
    pattern: /AITreeNode_SellChess Uin:([0-9]+) Hero:([0-9]+)\|([0-9]+) Pos:([0-9-]+)\|([0-9-]+)/g,
    confidence: 0.8,
  },
  {
    type: "local_report_chair_candidate",
    pattern: /#SoGame_Report# \[Frame:([0-9]+) TurnCount:([0-9]+)\] next report index:([0-9-]+) chairid: ([0-9-]+) preReportIndex: ([0-9-]+) reportPlayerCount: ([0-9]+)/g,
    confidence: 0.84,
  },
  {
    type: "battle_end_chair",
    pattern: /CSoGame PlayBattleEnd iChairId:([0-9-]+) CurrentTotalTurnCount:([0-9]+)/g,
    confidence: 0.76,
  },
  {
    type: "battle_pairing",
    pattern: /minteralBattle iPlayerID:([0-9]+) iEnemyID:([0-9-]+),[^\r\n\x00]{0,300}?bIsHome:(True|False)/g,
    confidence: 0.74,
  },
  {
    type: "carousel_active_candidate",
    pattern: /draft turn start/g,
    confidence: 0.62,
  },
];

const DEFAULT_PATCH_DIR = activeHardDataPackageDir(path.resolve(import.meta.dirname, ".."));

let catalog = {
  championsById: new Map(),
  itemsById: new Map(),
  loaded: false,
  patch_ref: null,
};

const OBSERVED_RAW_HERO_ALIASES = new Map([
  [13471, { championId: "4371", starTier: 1, canonicalRawId: 14371, reason: "observed_action_log_raw_id_variant" }],
]);

function usage() {
  return [
    "Usage:",
    "  node tools/extract-jcc-android-runtime-signals.mjs --input <probe-report.json|log-file|dir> [--out <signals.json>] [--patch-dir <dir>]",
    "",
    "Extracts candidate in-game runtime signals from pulled Android public net logs.",
    "The output is not a complete live_state snapshot until field semantics are verified.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--input") options.input = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--patch-dir") options.patchDir = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function listFilesRecursive(root) {
  const found = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(filePath);
      else found.push(filePath);
    }
  }
  await walk(root);
  return found;
}

async function resolveInputs(inputPath) {
  const resolved = path.resolve(inputPath);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) return listFilesRecursive(resolved);
  if (path.basename(resolved) !== "probe-report.json") return [resolved];

  const report = JSON.parse(await readFile(resolved, "utf8"));
  const probeDir = path.dirname(resolved);
  const candidateRoots = [
    path.join(probeDir, "net"),
    path.join(probeDir, "net", "net"),
  ];
  const files = [];
  for (const root of candidateRoots) {
    if (fs.existsSync(root)) files.push(...await listFilesRecursive(root));
  }
  return [...new Set(files)];
}

async function loadCatalog(patchDir) {
  const resolvedPatchDir = path.resolve(patchDir);
  const catalogRef = path.relative(process.cwd(), resolvedPatchDir) || ".";
  const championsPath = path.join(resolvedPatchDir, "normalized", "champions.json");
  const itemsPath = path.join(resolvedPatchDir, "normalized", "items.json");
  try {
    const champions = JSON.parse(await readFile(championsPath, "utf8"));
    const items = JSON.parse(await readFile(itemsPath, "utf8"));
    catalog = {
      championsById: new Map(champions.map((champion) => [String(champion.id), champion])),
      itemsById: new Map(items.map((item) => [String(item.id), item])),
      loaded: true,
      patch_ref: catalogRef,
    };
  } catch {
    catalog = {
      championsById: new Map(),
      itemsById: new Map(),
      loaded: false,
      patch_ref: catalogRef,
    };
  }
}

function cleanText(buffer) {
  return buffer
    .toString("utf8")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, "\n");
}

function safeSnippet(value) {
  return String(value)
    .replace(/\b\d{9,}\b/g, "<long-id>")
    .replace(/\b[A-Za-z0-9_-]{18,}\b/g, "<opaque-token>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function actorRefFromUin(value) {
  const text = String(value || "");
  if (!/^[0-9]+$/.test(text)) return null;
  return `actor:${crypto.createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

function compactChampion(champion, rawId = null, starTier = null) {
  if (!champion) return null;
  return {
    raw_id: rawId,
    champion_id: String(champion.id),
    star_tier: starTier,
    name: champion.name,
    cost: champion.cost,
    traits: (champion.traits || []).map((trait) => trait.name),
    address: champion.address,
  };
}

function compactAliasedChampion(champion, rawId, alias) {
  return {
    ...compactChampion(champion, rawId, alias.starTier),
    canonical_raw_id: alias.canonicalRawId,
    decode_alias: alias.reason,
  };
}

function decodeHeroId(rawValue) {
  const rawId = Number(rawValue);
  if (!Number.isFinite(rawId) || rawId <= 0) return null;

  const rawText = String(rawId);
  const direct = catalog.championsById.get(rawText);
  if (direct) return compactChampion(direct, rawId, null);

  if (rawText.length >= 5) {
    const starTier = Number(rawText.slice(0, 1));
    const championId = rawText.slice(1);
    const champion = catalog.championsById.get(championId);
    if (champion) return compactChampion(champion, rawId, Number.isFinite(starTier) ? starTier : null);
  }

  const alias = OBSERVED_RAW_HERO_ALIASES.get(rawId);
  if (alias) {
    const champion = catalog.championsById.get(alias.championId);
    if (champion) return compactAliasedChampion(champion, rawId, alias);
  }

  return {
    raw_id: rawId,
    champion_id: null,
    star_tier: null,
    name: null,
    cost: null,
    traits: [],
    address: null,
  };
}

function decodeItemId(rawValue) {
  const rawId = Number(rawValue);
  if (!Number.isFinite(rawId) || rawId <= 0) return null;
  const item = catalog.itemsById.get(String(rawId));
  if (!item) return { raw_id: rawId, item_id: null, name: null, type: null, address: null };
  return {
    raw_id: rawId,
    item_id: String(item.id),
    name: item.name,
    type: item.type,
    address: item.address,
  };
}

function chairCandidateFromEntityId(value) {
  const entityId = Number(value);
  if (!Number.isInteger(entityId) || entityId < 0) return null;
  if (entityId < 100000) return null;
  const chairId = Math.floor(entityId / 100000);
  return chairId >= 0 && chairId <= 7 ? chairId : null;
}

function splitNumberList(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => Number(entry))
    .filter(Number.isFinite);
}

function decodeHeroesFromFields(fields) {
  const seen = new Set();
  const heroes = [];
  for (const field of fields) {
    for (const match of String(field).matchAll(/\b[1-4]1[0-9]{3}\b/g)) {
      const decoded = decodeHeroId(match[0]);
      if (!decoded || seen.has(decoded.raw_id)) continue;
      seen.add(decoded.raw_id);
      heroes.push(decoded);
    }
  }
  return heroes;
}

function partitionDecodedHeroes(rawNumbers) {
  const heroes = [];
  const heroIds = [];
  const unknownHeroIds = [];
  for (const rawNumber of rawNumbers) {
    const decoded = decodeHeroId(rawNumber);
    if (decoded?.name) {
      heroIds.push(rawNumber);
      heroes.push(decoded);
    } else if (rawNumber > 0) {
      unknownHeroIds.push(rawNumber);
    }
  }
  return { heroIds, heroes, unknownHeroIds };
}

function parseRoundSelectEntries(value) {
  return String(value)
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [heroId, unknown_state, playerRef, chairId, flag] = entry.split(":");
      return {
        hero: decodeHeroId(heroId),
        unknown_state: Number(unknown_state),
        player_ref: playerRef && playerRef !== "0" ? "<player-id>" : "0",
        chair_id: Number(chairId),
        flag: Number(flag),
      };
    });
}

function parseHeroToken(value) {
  const [heroId, ...itemIds] = String(value).split(":").filter(Boolean);
  if (!heroId) return null;
  return {
    hero: decodeHeroId(heroId),
    item_candidates: itemIds.map((itemId) => decodeItemId(itemId)),
    raw: safeSnippet(value),
  };
}

function parseHeroList(value) {
  return String(value)
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseHeroToken)
    .filter(Boolean);
}

function parseItemList(value) {
  return String(value)
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => decodeItemId(entry));
}

function numberAt(fields, index) {
  const value = Number(fields[index]);
  return Number.isFinite(value) ? value : null;
}

function decodeRoundFlowSnapshot(fields) {
  return {
    interpretation: "anonymous_round_flow_snapshot_candidate",
    event_time: safeSnippet(fields[1] || ""),
    turn_count: numberAt(fields, 9),
    round_major_candidate: numberAt(fields, 10),
    round_minor_candidate: numberAt(fields, 11),
    chair_candidates: [numberAt(fields, 17), numberAt(fields, 62)].filter((value) => value != null),
    hp: numberAt(fields, 18),
    level_candidate: numberAt(fields, 24),
    board_units: parseHeroList(fields[29] || ""),
    augment_or_trait_candidates: String(fields[30] || "").split(";").map((entry) => entry.trim()).filter(Boolean),
    bench_units: parseHeroList(fields[31] || ""),
    item_bench: parseItemList(fields[32] || ""),
    raw_field_indexes: {
      turn_count: 9,
      chair_candidates: [17, 62],
      hp: 18,
      level_candidate: 24,
      board_units: 29,
      augment_or_trait_candidates: 30,
      bench_units: 31,
      item_bench: 32,
    },
  };
}

function parsePayload(type, match) {
  if (type === "match_start") {
    return {
      game_start_time: match[1],
      interpretation: "new_match_window_boundary",
    };
  }
  if (type === "shop_roll_candidate") {
    const rawNumbers = splitNumberList(match[1]);
    const { heroIds, heroes, unknownHeroIds } = partitionDecodedHeroes(rawNumbers);
    return {
      raw_numbers: rawNumbers,
      hero_ids: heroIds,
      heroes,
      unknown_hero_ids: unknownHeroIds,
    };
  }
  if (type === "outfield_add_candidate") {
    const [entity_id, table_id, x, y] = splitNumberList(match[1]);
    return {
      entity_id,
      table_id,
      x,
      y,
      decoded: {
        entity_as_hero: decodeHeroId(entity_id),
        table_as_item: decodeItemId(table_id),
      },
    };
  }
  if (type === "equipment_bag_refill") {
    return { refill_times: Number(match[1]), total_items: Number(match[2]) };
  }
  if (type === "battle_result_money") {
    return {
      player_ref: "<player-id>",
      player_chair_id_candidate: Number(match[1]),
      earned_money: Number(match[2]),
    };
  }
  if (type === "battle_result_life") {
    return {
      player_ref: "<player-id>",
      player_chair_id_candidate: Number(match[1]),
      deducted_life: Number(match[2]),
    };
  }
  if (type === "player_life") {
    return {
      life_before_or_current: Number(match[1]),
      endflag: match[2] === "True",
      life: Number(match[3]),
      chair_id: Number(match[4]),
    };
  }
  if (type === "switch_player_chair") {
    return {
      player_ref: "<player-id>",
      actor_ref: actorRefFromUin(match[1]),
      chair_id: Number(match[2]),
      ext: safeSnippet(match[3]),
      interpretation: "view_or_actor_switch_candidate",
    };
  }
  if (type === "observed_battlefield_chair_candidate") {
    return {
      chair_id: Number(match[1]),
      interpretation: "current_observed_battlefield_chair_candidate_not_local_player_proof",
    };
  }
  if (type === "observed_logic_player_chair_candidate") {
    return {
      chair_id: Number(match[1]),
      queue_id: Number(match[2]),
      interpretation: "current_observed_logic_player_chair_candidate_not_local_player_proof",
    };
  }
  if (type === "get_on_chess_candidate") {
    const entityId = Number(match[2]);
    return {
      player_ref: "<player-id>",
      actor_ref: actorRefFromUin(match[1]),
      entity_id: entityId,
      action_chair_id_candidate: chairCandidateFromEntityId(entityId),
      raw_hero_id: Number(match[3]),
      star_or_state: Number(match[4]),
      action: "get_on_chess",
      to: {
        x: Number(match[5]),
        y: Number(match[6]),
      },
      hero: decodeHeroId(match[3]),
      interpretation: "board_or_bench_action_candidate_not_promoted",
    };
  }
  if (type === "move_battle_chess_candidate") {
    const ext = safeSnippet(match[8] || "");
    const entityId = Number(match[2]);
    return {
      player_ref: "<player-id>",
      actor_ref: actorRefFromUin(match[1]),
      entity_id: entityId,
      action_chair_id_candidate: chairCandidateFromEntityId(entityId),
      raw_hero_id: Number(match[3]),
      action: "move_battle_chess",
      from: {
        x: Number(match[4]),
        y: Number(match[5]),
      },
      to: {
        x: Number(match[6]),
        y: Number(match[7]),
      },
      ext,
      same_position: /SamePos/i.test(ext),
      hero: decodeHeroId(match[3]),
      interpretation: "board_position_action_candidate_not_promoted",
    };
  }
  if (type === "sell_chess_candidate") {
    const entityId = Number(match[2]);
    return {
      player_ref: "<player-id>",
      actor_ref: actorRefFromUin(match[1]),
      entity_id: entityId,
      action_chair_id_candidate: chairCandidateFromEntityId(entityId),
      raw_hero_id: Number(match[3]),
      action: "sell_chess",
      position: {
        x: Number(match[4]),
        y: Number(match[5]),
      },
      hero: decodeHeroId(match[3]),
      interpretation: "sell_action_candidate_not_promoted",
    };
  }
  if (type === "local_report_chair_candidate") {
    return {
      frame: Number(match[1]),
      turn_count: Number(match[2]),
      next_report_index: Number(match[3]),
      chair_id: Number(match[4]),
      pre_report_index: Number(match[5]),
      report_player_count: Number(match[6]),
      interpretation: "local_report_chair_candidate",
    };
  }
  if (type === "battle_end_chair") {
    return {
      chair_id: Number(match[1]),
      turn_count: Number(match[2]),
      interpretation: "battle_end_chair_candidate",
    };
  }
  if (type === "battle_pairing") {
    return {
      player_chair_id: Number(match[1]),
      enemy_chair_id: Number(match[2]),
      is_home_board: match[3] === "True",
      interpretation: "battle_pairing_candidate",
    };
  }
  if (type === "carousel_active_candidate") {
    return {
      event: "draft_turn_start",
      active_candidate: true,
      interpretation: "carousel_or_draft_phase_active_candidate",
    };
  }
  if (type === "round_flow" || type === "round_select_infos" || type === "turn_data_marker") {
    const fields = match[1].split("|");
    const payload = {
      field_count: fields.length,
      fields: fields.slice(0, 80).map((field) => safeSnippet(field)),
    };
    if (type === "round_flow") {
      payload.decoded = {
        event_time: safeSnippet(fields[1] || ""),
        set_id_candidate: fields.find((field) => field === "17") || null,
        heroes: decodeHeroesFromFields(fields),
        snapshot_candidate: decodeRoundFlowSnapshot(fields),
      };
    } else if (type === "round_select_infos") {
      payload.decoded = {
        event_time: safeSnippet(fields[1] || ""),
        set_id_candidate: fields.find((field) => field === "17") || null,
        select_entries: parseRoundSelectEntries(fields.find((field) => field.includes(":") && field.includes(";")) || ""),
      };
    } else if (type === "turn_data_marker") {
      payload.decoded = {
        device: safeSnippet(fields[0] || ""),
        platform: safeSnippet(fields[1] || ""),
        turn_candidate: Number(fields[3]),
      };
    }
    return payload;
  }
  return { raw: safeSnippet(match[0]) };
}

function extractFromText(text, file) {
  const signals = [];
  for (const signalPattern of SIGNAL_PATTERNS) {
    for (const match of text.matchAll(signalPattern.pattern)) {
      signals.push({
        type: signalPattern.type,
        source_file: file,
        confidence: signalPattern.confidence,
        payload: parsePayload(signalPattern.type, match),
        evidence: safeSnippet(match[0]),
      });
    }
  }
  return signals;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.input) throw new Error(`Missing --input\n${usage()}`);
  await loadCatalog(options.patchDir || DEFAULT_PATCH_DIR);

  const input = path.resolve(options.input);
  const files = await resolveInputs(input);
  const signals = [];
  for (const file of files) {
    const text = cleanText(await readFile(file));
    signals.push(...extractFromText(text, path.relative(path.dirname(input), file)));
  }

  const byType = {};
  for (const signal of signals) byType[signal.type] = (byType[signal.type] || 0) + 1;
  const report = {
    ok: signals.length > 0,
    input_ref: path.basename(input),
    signal_kind: "candidate_runtime_signals",
    live_state_status: "not_complete_until_field_semantics_verified",
    decode_status: catalog.loaded ? "decoded_with_local_catalog" : "catalog_unavailable_raw_only",
    catalog: {
      patch_ref: catalog.patch_ref,
      champion_count: catalog.championsById.size,
      item_count: catalog.itemsById.size,
    },
    signal_count: signals.length,
    signal_counts: byType,
    signals,
  };

  if (options.out) {
    const out = path.resolve(options.out);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify({
    ok: report.ok,
    signal_kind: report.signal_kind,
    live_state_status: report.live_state_status,
    decode_status: report.decode_status,
    signal_count: report.signal_count,
    signal_counts: report.signal_counts,
    out: options.out ? path.resolve(options.out) : null,
  }, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
