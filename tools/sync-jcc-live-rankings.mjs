import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  acquireLiveRankingRefreshLease,
  liveRankingBindingFromSourceIdentity,
  publishLiveRankingGeneration,
  sha256File,
} from "./jcc_live_rankings_generation_store.mjs";
import {
  archiveLiveRankingSignal,
  buildLiveRankingTrendSummaryIncludingSignal,
  normalizeLiveRankingTraitTrendKey,
} from "./jcc_live_rankings_history.mjs";
import { buildLiveRankingCoverageMinimums } from "./jcc_live_rankings_coverage_policy.mjs";
import { auditLiveRankingCatalogCompatibility } from "./jcc_live_rankings_catalog_compatibility.mjs";
import { buildLiveRankingStrategyIndex } from "./jcc_live_rankings_strategy_index.mjs";
import { resolveRankingTarget } from "./jcc_ranking_target.mjs";
import {
  buildRankingRecipeAuxiliaryRegistry,
  fetchAndPublishRankingRecipeCandidate,
  publishRankingRecipeCandidate,
  winningRecipeGroupsFromRaw,
} from "./jcc_live_rankings_recipe_sources.mjs";
import {
  resolveRankingRefreshBaselineClosureSync,
} from "./jcc_live_rankings_active_closure.mjs";
import { rankingCapabilityWarnings } from "./jcc_live_rankings_capability_status.mjs";
import {
  evaluateRecipeSourceFreshness,
  recipeFreshnessAllowsAutomaticPairing,
} from "./jcc_ranking_recipe_freshness.mjs";
import { createRankingMaintenancePreparationPointer } from "./jcc_ranking_maintenance_preparation.mjs";
import {
  buildOfficialSourceDictionary,
  resolveOfficialTraitSemantic,
} from "./jcc_official_source_dictionary.mjs";

const API_ORIGIN = "https://mlol.qt.qq.com";
const REFERER = "https://jcc.qq.com/zmjkzone/page/datarank/";
const OUTPUT_DIR = path.resolve("data/live-rankings/jcc");
const CURRENT_DIR = path.join(OUTPUT_DIR, "current");
const PREVIOUS_DIR = path.join(OUTPUT_DIR, "previous");
const repoRoot = path.resolve(import.meta.dirname, "..");
const rankingTarget = await resolveRankingTarget({ repoRoot, argv: process.argv.slice(2) });
const PATCH_DIR = rankingTarget.hard_data_package_dir;

const MASTER_PLUS_TIER_ID = "0";
const TIERS = [{ id: MASTER_PLUS_TIER_ID, label: "master_plus" }];
const HERO_LEVELS = ["255", "1", "2", "3"];
const BATTLE_TYPE = "31";
const LINEUP_VERSION_ID = "v6";
const LOOKBACK_DAYS = 7;
const GENERATION_ARTIFACT_FILES = [
  "snapshot.json",
  "rank-signal.json",
  "lineup-strategy-index.json",
  "latest-diff.json",
  "audit.json",
  "manifest.json",
];

const HERO_ITEM_SIGNAL_LIMIT = 35;
const HERO_ITEM_SIGNAL_EQUIP_LIMIT = 8;
const AUGMENT_LINEUP_SIGNAL_LIMIT = 60;
const AUGMENT_LINEUP_SIGNAL_LINEUP_LIMIT = 6;
const HERO_EQUIP_FETCH_CONCURRENCY = 8;
const HERO_EQUIP_MINIMUM_COVERAGE = 40;

function responseFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function parseArgs(argv) {
  const args = { today: null, deferActivation: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--today") args.today = argv[index + 1];
    if (arg === "--defer-activation") args.deferActivation = true;
  }
  return args;
}

function verifyRankingCandidate(candidateDir, target) {
  const result = spawnSync(process.execPath, [
    "tools/verify-jcc-live-rankings.mjs",
    "--dir", candidateDir,
    "--season", target.season_id,
    "--patch", target.patch_id,
    "--expected-core-profile-id", target.core_profile_id,
    "--profile", target.selection,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Ranking candidate failed full pre-promotion verification: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(String(result.stdout || "{}").trim());
}

function ymd(date) {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function parseYmd(value) {
  if (!value) return new Date();
  if (!/^\d{8}$/.test(value)) throw new Error(`--today must be YYYYMMDD, got ${value}`);
  return new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))));
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readJsonIfExists(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeCompactJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function postJson(pathname, body) {
  const response = await fetch(`${API_ORIGIN}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://jcc.qq.com",
      Referer: REFERER,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`JCC_TENCENT_TRANSPORT_UNAVAILABLE: ${pathname} returned HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  try {
    const payload = JSON.parse(text);
    const businessResult = payload && typeof payload === "object" && Object.hasOwn(payload, "result")
      ? Number(payload.result)
      : 0;
    if (!Number.isFinite(businessResult) || businessResult !== 0) {
      throw new Error(
        `JCC_TENCENT_ADAPTER_CONTRACT_MISMATCH: ${pathname} rejected the Tencent/JCC adapter request (result=${String(payload?.result)}). `
        + "Check the API request version, Master+ tier, battle type, and request body against the current Zhangmeng page.",
      );
    }
    return payload;
  } catch (error) {
    if (/JCC_TENCENT_ADAPTER_CONTRACT_MISMATCH/u.test(String(error?.message || ""))) throw error;
    throw new Error(`JCC_TENCENT_ADAPTER_CONTRACT_MISMATCH: ${pathname} returned non-JSON: ${text.slice(0, 240)}`);
  }
}

function currentNode(row, prefix) {
  const value = Number(row?.[`node1_${prefix}`]);
  return Number.isFinite(value) ? value : null;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const items = Array.from(values || []);
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function nationalRosterHeroIds(traitGroups) {
  return [...new Set((traitGroups || []).flatMap((group) => (
    group?.data?.minor_traits_datas || []
  )).flatMap((row) => row?.hero_list || []).map((id) => String(id || "").replace(/^\d(?=\d{4}$)/, "")).filter(Boolean))].sort();
}

async function fetchHeroEquipRankings(tierId, setId, traitGroups = []) {
  const heroIds = nationalRosterHeroIds(traitGroups);
  const rows = await mapWithConcurrency(heroIds, HERO_EQUIP_FETCH_CONCURRENCY, async (heroId) => {
    try {
      const response = await postJson("/go/jgame/get_hero_equip_ranking", {
        heroid: heroId,
        tier_part: tierId,
        set_id: String(setId),
        time_type: "1",
      });
      const data = response?.data || null;
      if (!data || !Array.isArray(data.combine_itemid_details)) {
        return { hero_id: heroId, ok: false, error: "missing_combine_itemid_details" };
      }
      return {
        hero_id: heroId,
        ok: true,
        data: {
          dtstatdate: data.dtstatdate || null,
          hero_playrate: finiteNumber(data.hero_playrate),
          hero_top4_rate: finiteNumber(data.hero_top4_rate),
          hero_top1_rate: finiteNumber(data.hero_top1_rate),
          hero_avg_rank: finiteNumber(data.hero_avg_rank),
          single_itemid: Array.isArray(data.single_itemid) ? data.single_itemid.map(String) : [],
          single_itemid_playrate: Array.isArray(data.single_itemid_playrate) ? data.single_itemid_playrate.map(finiteNumber) : [],
          single_itemid_top4_rate: Array.isArray(data.single_itemid_top4_rate) ? data.single_itemid_top4_rate.map(finiteNumber) : [],
          single_itemid_top1_rate: Array.isArray(data.single_itemid_top1_rate) ? data.single_itemid_top1_rate.map(finiteNumber) : [],
          single_itemid_avg_rank: Array.isArray(data.single_itemid_avg_rank) ? data.single_itemid_avg_rank.map(finiteNumber) : [],
          combine_itemid_details: data.combine_itemid_details.map((entry) => ({
            equips: Array.isArray(entry?.equips) ? entry.equips.map(String) : [],
            playrate: finiteNumber(entry?.playrate),
            top4_rate: finiteNumber(entry?.top4_rate),
            top1_rate: finiteNumber(entry?.top1_rate),
            avg_rank: finiteNumber(entry?.avg_rank),
          })).filter((entry) => entry.equips.length),
        },
      };
    } catch (error) {
      return { hero_id: heroId, ok: false, error: error?.message || String(error) };
    }
  });
  return {
    expected_hero_ids: heroIds,
    by_hero_id: Object.fromEntries(rows.filter((row) => row.ok).map((row) => [row.hero_id, row.data])),
    failures: rows.filter((row) => !row.ok).map(({ hero_id, error }) => ({ hero_id, error })),
  };
}

function scoreTopOneAndFour(top1, top4, avgRank, useRate) {
  const safeTop1 = Number.isFinite(top1) ? top1 : 0;
  const safeTop4 = Number.isFinite(top4) ? top4 : 0;
  const safeAvgRank = Number.isFinite(avgRank) ? avgRank : 4.5;
  const safeUseRate = Number.isFinite(useRate) ? useRate : 0;
  return safeTop1 * 1.8 + safeTop4 * 0.8 - safeAvgRank * 0.08 + Math.log10(1 + safeUseRate * 1000) * 0.04;
}

function scoreHeroItemSignal(row, heroIndex) {
  const top1 = Number(row.top1_rate);
  const top4 = Number(row.top4_rate);
  const avgRank = Number(row.hero_rank);
  const useRate = Number(row.use_rate);
  const useCount = Number(row.use_count);
  const base = scoreTopOneAndFour(top1, top4, avgRank, useRate);
  const heroSlotPenalty = Number(heroIndex) * 0.08;
  const countReliability = Number.isFinite(useCount) ? Math.min(1, Math.log10(1 + useCount) / 4.2) : 0.35;
  const rateReliability = useRate >= 0.02 ? 1 : useRate >= 0.005 ? 0.72 : useRate >= 0.001 ? 0.48 : 0.28;
  const reliability = Math.min(countReliability, rateReliability);
  return base * reliability - heroSlotPenalty;
}

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactLineupForAugmentSignal(group, variant) {
  return {
    lineup_group_id: group?.id || null,
    lineup_rank: variant?.lineup_rank || null,
    main_trait_list: group?.main_trait_list || [],
    main_trait_group: variant?.main_trait_group || [],
    lineup_ids: Array.isArray(variant?.lineup) ? variant.lineup.slice(0, 10).map(String) : [],
    core_chess_ids: Array.isArray(variant?.core_chess) ? variant.core_chess.slice(0, 10).map(String) : [],
    main_c_chess_equip_ids: Array.isArray(variant?.main_c_chess_equip) ? variant.main_c_chess_equip.slice(0, 3).map(String) : [],
    assist_chess_equip_ids: Array.isArray(variant?.assist_chess_equip) ? variant.assist_chess_equip.slice(0, 3).map(String) : [],
    population: variant?.population || null,
    source_role: "winning_recipe_association_only",
  };
}

function buildAugmentLineupSignal(tierData) {
  const byAugment = new Map();
  for (const group of tierData.lineup_group?.main_traits_data || []) {
    for (const variant of group?.info?.list || []) {
      const augmentIds = Array.isArray(variant?.rune_id_group) ? variant.rune_id_group.map(String).filter(Boolean) : [];
      if (!augmentIds.length) continue;
      const lineupSignal = compactLineupForAugmentSignal(group, variant);
      for (const augmentId of augmentIds) {
        if (!byAugment.has(augmentId)) {
          byAugment.set(augmentId, {
            augment_id: augmentId,
            source: "lineup_group.info.list.rune_id_group",
            interpretation: "lineup_association_prior_not_independent_augment_winrate",
            not_independent_winrate: true,
            lineup_count: 0,
            associated_lineups: [],
          });
        }
        const entry = byAugment.get(augmentId);
        entry.lineup_count += 1;
        entry.associated_lineups.push(lineupSignal);
      }
    }
  }

  return [...byAugment.values()]
    .map((entry) => {
      const associatedLineups = entry.associated_lineups
        .sort((left, right) => String(left.lineup_group_id || "").localeCompare(String(right.lineup_group_id || "")))
        .slice(0, AUGMENT_LINEUP_SIGNAL_LINEUP_LIMIT);
      return {
        augment_id: entry.augment_id,
        source: entry.source,
        interpretation: entry.interpretation,
        not_independent_winrate: true,
        lineup_count: entry.lineup_count,
        associated_lineups: associatedLineups,
      };
    })
    .sort((left, right) => right.lineup_count - left.lineup_count || left.augment_id.localeCompare(right.augment_id))
    .slice(0, AUGMENT_LINEUP_SIGNAL_LIMIT);
}

function formatTraitKey(mainTraits = []) {
  return mainTraits.map((trait) => `${trait.trait_id},${trait.hero_num}`).join("$");
}

function traitLabel(mainTraits = []) {
  return normalizeLiveRankingTraitTrendKey(null, mainTraits);
}

function uniqueTraitRequests(rows) {
  const seen = new Set();
  const requests = [];
  for (const row of rows || []) {
    const key = formatTraitKey(row.main_traits);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    requests.push({ key, label: traitLabel(row.main_traits), main_traits: row.main_traits || [] });
  }
  return requests;
}

async function findLatestStatDate(today) {
  for (let offset = 0; offset < LOOKBACK_DAYS; offset += 1) {
    const date = new Date(today.getTime() - offset * 24 * 60 * 60 * 1000);
    const statDate = ymd(date);
    const traitResult = await postJson("/go/jgame/get_main_trait_strength_trend", {
      tier_part: MASTER_PLUS_TIER_ID,
      stat_date: statDate,
      battle_type: BATTLE_TYPE,
    });
    const traitCount = Array.isArray(traitResult.data) ? traitResult.data.length : 0;
    if (traitCount <= 0) continue;
    const heroResult = await postJson("/go/jgame/get_hero_strength_trend", {
      stat_date: statDate,
      tier_part: MASTER_PLUS_TIER_ID,
      battle_type: BATTLE_TYPE,
      hero_level: "255",
    });
    const heroCount = Array.isArray(heroResult.data) ? heroResult.data.length : 0;
    if (heroCount > 0) {
      const adjacentStatDate = ymd(new Date(date.getTime() - 24 * 60 * 60 * 1000));
      const [adjacentTraitResult, adjacentHeroResult] = await Promise.all([
        postJson("/go/jgame/get_main_trait_strength_trend", {
          tier_part: MASTER_PLUS_TIER_ID,
          stat_date: adjacentStatDate,
          battle_type: BATTLE_TYPE,
        }),
        postJson("/go/jgame/get_hero_strength_trend", {
          stat_date: adjacentStatDate,
          tier_part: MASTER_PLUS_TIER_ID,
          battle_type: BATTLE_TYPE,
          hero_level: "255",
        }),
      ]);
      const traitProbeFingerprint = responseFingerprint(traitResult.data);
      const heroProbeFingerprint = responseFingerprint(heroResult.data);
      const adjacentTraitProbeFingerprint = responseFingerprint(adjacentTraitResult.data);
      const adjacentHeroProbeFingerprint = responseFingerprint(adjacentHeroResult.data);
      const adjacentTraitCount = Array.isArray(adjacentTraitResult.data) ? adjacentTraitResult.data.length : 0;
      const adjacentHeroCount = Array.isArray(adjacentHeroResult.data) ? adjacentHeroResult.data.length : 0;
      if (adjacentTraitCount <= 0
        || adjacentHeroCount <= 0
        || adjacentTraitProbeFingerprint === traitProbeFingerprint
        || adjacentHeroProbeFingerprint === heroProbeFingerprint) {
        continue;
      }
      return {
        statDate,
        adjacentStatDate,
        fallbackDays: offset,
        probeCount: traitCount,
        heroProbeCount: heroCount,
        adjacentTraitProbeCount: adjacentTraitCount,
        adjacentHeroProbeCount: adjacentHeroCount,
        traitProbeFingerprint,
        heroProbeFingerprint,
        adjacentTraitProbeFingerprint,
        adjacentHeroProbeFingerprint,
        dateBindingVerified: true,
      };
    }
  }
  throw new Error(`JCC_TENCENT_RANKINGS_UNAVAILABLE: No non-empty trait+hero ranking data found within ${LOOKBACK_DAYS} days`);
}

async function fetchTierData(tierId, statDate, setId, probeReceipt = null) {
  const mainTrait = await postJson("/go/jgame/get_main_trait_strength_trend", {
    tier_part: tierId,
    stat_date: statDate,
    battle_type: BATTLE_TYPE,
  });
  const equip = await postJson("/go/jgame/equip_rank", {
    tier_part: tierId,
    battle_type: BATTLE_TYPE,
  });
  const lineup = await postJson("/go/jgame/common_proxy_v2", {
    req_group: [{
      req_alias: "lineup_group_list",
      req_params: {
        queue_id: BATTLE_TYPE,
        tier_part: tierId,
        time_type: "1",
        version_id: LINEUP_VERSION_ID,
      },
    }],
  });
  const lineupData = lineup.data?.[0]?.data || null;

  const heroStrength = {};
  for (const heroLevel of HERO_LEVELS) {
    const hero = await postJson("/go/jgame/get_hero_strength_trend", {
      stat_date: statDate,
      tier_part: tierId,
      battle_type: BATTLE_TYPE,
      hero_level: heroLevel,
    });
    heroStrength[heroLevel] = hero.data || [];
  }

  const traitDetails = [];
  const traitGroups = [];
  for (const request of uniqueTraitRequests(mainTrait.data)) {
    const requestParams = {
      tier_part: tierId,
      battletype: BATTLE_TYPE,
      dtstatdate: statDate,
      main_traits_leve: request.key,
    };
    const [detail, group] = await Promise.all([
      postJson("/go/jgame/common_proxy", {
        req_group: [{ req_alias: "trait_detail", req_params: requestParams }],
      }),
      postJson("/go/jgame/common_proxy", {
        req_group: [{ req_alias: "trait_group", req_params: requestParams }],
      }),
    ]);
    traitDetails.push({
      key: request.key,
      label: request.label,
      main_traits: request.main_traits,
      requested_stat_date: statDate,
      requested_tier_part: tierId,
      requested_battle_type: BATTLE_TYPE,
      data: detail.data?.[0]?.data || null,
      raw: detail,
    });
    traitGroups.push({
      key: request.key,
      label: request.label,
      main_traits: request.main_traits,
      requested_stat_date: statDate,
      requested_tier_part: tierId,
      requested_battle_type: BATTLE_TYPE,
      data: group.data?.[0]?.data || null,
      raw: group,
    });
  }

  const heroEquipRankings = await fetchHeroEquipRankings(tierId, setId, traitGroups);

  return {
    request_receipt: {
      requested_stat_date: statDate,
      requested_tier_part: tierId,
      requested_battle_type: BATTLE_TYPE,
      main_trait_response_fingerprint: responseFingerprint(mainTrait.data || []),
      hero_255_response_fingerprint: responseFingerprint(heroStrength["255"] || []),
      probe_main_trait_response_fingerprint: probeReceipt?.traitProbeFingerprint || null,
      probe_hero_255_response_fingerprint: probeReceipt?.heroProbeFingerprint || null,
      adjacent_stat_date: probeReceipt?.adjacentStatDate || null,
      adjacent_main_trait_response_fingerprint: probeReceipt?.adjacentTraitProbeFingerprint || null,
      adjacent_hero_255_response_fingerprint: probeReceipt?.adjacentHeroProbeFingerprint || null,
      adjacent_date_binding_verified: probeReceipt?.dateBindingVerified === true,
    },
    main_trait_strength: mainTrait.data || [],
    hero_strength: heroStrength,
    equip_rank: equip.data || null,
    lineup_group: lineupData,
    hero_equip_rankings: heroEquipRankings,
    trait_details: traitDetails,
    trait_groups: traitGroups,
    raw_status: {
      main_trait_result: mainTrait.result,
      equip_result: equip.result,
      lineup_result: lineup.result,
    },
  };
}

function loadStaticBasisPromise() {
  return Promise.all([
    readJson(path.join(PATCH_DIR, "normalized", "traits.json")),
    readJson(path.join(PATCH_DIR, "normalized", "champions.json")),
    readJson(path.join(PATCH_DIR, "indexes", "champion_role_profile.json")),
    readJson(path.join(PATCH_DIR, "normalized", "items.json")),
    readJson(path.join(PATCH_DIR, "normalized", "augments.json")),
    readJson(path.join(PATCH_DIR, "normalized", "source_entity_mappings.json")),
    readJson(path.join(PATCH_DIR, "manifest.json")),
  ]).then(([traits, champions, roleProfiles, items, augments, sourceEntityMappings, manifest]) => ({
    summary: {
      patch_package: manifest.packageId,
      version: manifest.version,
      mode: manifest.mode,
      season: manifest.season,
      trait_count: traits.length,
      champion_count: champions.length,
      item_count: items.length,
      augment_count: augments.length,
    },
    traits,
    champions,
    roleProfiles,
    items,
    augments,
    source_entity_mappings: sourceEntityMappings,
  }));
}

function enrichOfficialTraitSemantics(value, dictionary) {
  if (Array.isArray(value)) {
    for (const entry of value) enrichOfficialTraitSemantics(entry, dictionary);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.trait_id) {
    delete value.source_trait_id;
    delete value.source_trait_text;
    delete value.canonical_trait_id;
    delete value.source_dictionary_breakpoint;
    delete value.source_dictionary_status;
    const official = resolveOfficialTraitSemantic(dictionary, value);
    if (official) {
      value.source_trait_id = official.source_id;
      value.source_trait_text = official.name;
      value.canonical_trait_id = official.core?.check_id || null;
      value.source_dictionary_breakpoint = official.breakpoint;
      value.source_dictionary_status = "resolved_official_frontend_dictionary";
    } else {
      value.source_dictionary_status = "unresolved_official_frontend_dictionary";
    }
  }
  for (const entry of Object.values(value)) enrichOfficialTraitSemantics(entry, dictionary);
}

function coverageForTier(tierData, statDate) {
  const receipt = tierData.request_receipt || {};
  const heroEquipRows = Object.values(tierData.hero_equip_rankings?.by_hero_id || {});
  const winningRecipes = tierData.recipe_sources?.winning;
  const winningRecipeRows = Array.isArray(winningRecipes?.recipes) ? winningRecipes.recipes : [];
  const winningSourceGroups = Array.isArray(tierData.lineup_group?.main_traits_data)
    ? tierData.lineup_group.main_traits_data
    : [];
  const winningSourceVariantCount = winningSourceGroups.reduce((total, group) => (
    total + (Array.isArray(group?.info?.list) ? group.info.list.length : 0)
  ), 0);
  const popularRecipes = tierData.recipe_sources?.popular;
  return {
    traitCount: tierData.main_trait_strength.length,
    heroCounts: Object.fromEntries(HERO_LEVELS.map((level) => [level, tierData.hero_strength[level]?.length || 0])),
    equipCount: tierData.equip_rank?.list?.length || 0,
    // This is the upstream main-trait grouping count, not the number of
    // normalized winning recipes. Keep it for source diagnostics only.
    lineupGroupCount: tierData.lineup_group?.main_traits_data?.length || 0,
    winningSourceGroupCount: winningSourceGroups.length,
    winningSourceVariantCount,
    winningRecipeStatus: winningRecipes?.capability?.status || "unavailable",
    winningRecipeCount: winningRecipeRows.length,
    winningRecipeQuarantineCount: Array.isArray(winningRecipes?.quarantine) ? winningRecipes.quarantine.length : 0,
    popularSourceRowCount: Number.isInteger(popularRecipes?.capability?.source_row_count)
      ? popularRecipes.capability.source_row_count
      : null,
    popularRecipeCount: Array.isArray(popularRecipes?.recipes) ? popularRecipes.recipes.length : 0,
    popularRecipeQuarantineCount: Array.isArray(popularRecipes?.quarantine) ? popularRecipes.quarantine.length : 0,
    traitDetailCount: tierData.trait_details.length,
    emptyTraitDetailCount: tierData.trait_details.filter((detail) => !detail.data?.main_buff_data?.length).length,
    traitGroupCount: tierData.trait_groups.length,
    canonicalRosterCount: tierData.trait_groups.reduce((sum, group) => (
      sum + (Array.isArray(group?.data?.minor_traits_datas) ? group.data.minor_traits_datas.length : 0)
    ), 0),
    emptyTraitGroupCount: tierData.trait_groups.filter((group) => !group.data?.minor_traits_datas?.length).length,
    equipDate: tierData.equip_rank?.dtstatdate || null,
    lineupDate: tierData.lineup_group?.dtstatdate || null,
    requestIdentityMatches: receipt.requested_stat_date === statDate
      && receipt.requested_tier_part === MASTER_PLUS_TIER_ID
      && receipt.requested_battle_type === BATTLE_TYPE,
    probeResponseMatches: Boolean(receipt.main_trait_response_fingerprint)
      && receipt.main_trait_response_fingerprint === receipt.probe_main_trait_response_fingerprint
      && Boolean(receipt.hero_255_response_fingerprint)
      && receipt.hero_255_response_fingerprint === receipt.probe_hero_255_response_fingerprint
      && receipt.adjacent_date_binding_verified === true
      && Boolean(receipt.adjacent_stat_date)
      && receipt.adjacent_stat_date !== statDate
      && receipt.adjacent_main_trait_response_fingerprint !== receipt.main_trait_response_fingerprint
      && receipt.adjacent_hero_255_response_fingerprint !== receipt.hero_255_response_fingerprint,
    traitRequestIdentityMismatchCount: [...tierData.trait_details, ...tierData.trait_groups]
      .filter((entry) => entry?.requested_stat_date !== statDate
        || entry?.requested_tier_part !== MASTER_PLUS_TIER_ID
        || entry?.requested_battle_type !== BATTLE_TYPE).length,
    heroEquipExpectedCount: tierData.hero_equip_rankings?.expected_hero_ids?.length || 0,
    heroEquipCount: Object.keys(tierData.hero_equip_rankings?.by_hero_id || {}).length,
    heroEquipFailureCount: tierData.hero_equip_rankings?.failures?.length || 0,
    heroEquipDateMissingCount: heroEquipRows.filter((entry) => !entry?.dtstatdate).length,
    heroEquipDateMismatchCount: heroEquipRows.filter((entry) => entry?.dtstatdate !== statDate).length,
  };
}

function buildAudit(snapshot, minimums, catalogCompatibility) {
  const failures = [];
  const warnings = [];
  const tierCoverage = {};

  for (const tier of TIERS) {
    const tierData = snapshot.tiers[tier.id];
    const coverage = coverageForTier(tierData, snapshot.stat_date);
    tierCoverage[tier.id] = coverage;
    if (coverage.traitCount < minimums.traitCount) {
      failures.push({ reason: "trait_rank_below_minimum", tier: tier.id, ...coverage });
    }
    if (!coverage.requestIdentityMatches || coverage.traitRequestIdentityMismatchCount > 0) {
      failures.push({ reason: "master_plus_request_identity_mismatch", tier: tier.id, ...coverage });
    }
    if (!coverage.probeResponseMatches) {
      failures.push({ reason: "master_plus_probe_response_drift", tier: tier.id, ...coverage });
    }
    if (coverage.equipCount < minimums.equipCount) {
      failures.push({ reason: "equip_rank_below_minimum", tier: tier.id, ...coverage });
    }
    if (coverage.winningRecipeCount < minimums.winningRecipeCount) {
      warnings.push({ reason: "winning_recipe_count_below_minimum", tier: tier.id, ...coverage });
    }
    for (const [heroLevel, count] of Object.entries(coverage.heroCounts)) {
      if (count < minimums.heroCount) {
        failures.push({ reason: "hero_rank_below_minimum", tier: tier.id, heroLevel, count });
      }
    }
    if (coverage.traitDetailCount < coverage.traitCount) {
      failures.push({ reason: "trait_detail_missing_rank_rows", tier: tier.id, ...coverage });
    }
    if (coverage.emptyTraitDetailCount > 0) {
      failures.push({ reason: "trait_detail_empty", tier: tier.id, ...coverage });
    }
    if (coverage.traitGroupCount < coverage.traitCount || coverage.canonicalRosterCount < minimums.traitCount) {
      failures.push({ reason: "master_plus_canonical_roster_unavailable", tier: tier.id, ...coverage });
    }
    if (coverage.emptyTraitGroupCount > 0) {
      warnings.push({ reason: "master_plus_canonical_roster_partial", tier: tier.id, ...coverage });
    }
    if (!coverage.equipDate) {
      warnings.push({ reason: "equip_stat_date_missing", tier: tier.id, statDate: snapshot.stat_date });
    } else if (coverage.equipDate !== snapshot.stat_date) {
      warnings.push({ reason: "equip_date_differs_from_snapshot", tier: tier.id, equipDate: coverage.equipDate, statDate: snapshot.stat_date });
    }
    if (!coverage.lineupDate) {
      warnings.push({ reason: "winning_recipe_stat_date_missing", tier: tier.id, statDate: snapshot.stat_date });
    } else if (coverage.lineupDate !== snapshot.stat_date) {
      warnings.push({ reason: "lineup_date_differs_from_snapshot", tier: tier.id, lineupDate: coverage.lineupDate, statDate: snapshot.stat_date });
    }
    if (coverage.heroEquipExpectedCount > 0 && coverage.heroEquipCount < Math.min(HERO_EQUIP_MINIMUM_COVERAGE, coverage.heroEquipExpectedCount)) {
      failures.push({ reason: "hero_equip_ranking_below_minimum", tier: tier.id, ...coverage });
    }
    if (coverage.heroEquipFailureCount > 0) {
      warnings.push({ reason: "hero_equip_ranking_partial_failure", tier: tier.id, ...coverage });
    }
    if (coverage.heroEquipDateMissingCount > 0 || coverage.heroEquipDateMismatchCount > 0) {
      warnings.push({ reason: "hero_equip_ranking_stat_date_mismatch", tier: tier.id, ...coverage, statDate: snapshot.stat_date });
    }
  }
  failures.push(...(catalogCompatibility?.failures || []));

  return {
    schema_version: 1,
    status: failures.length ? "fail" : warnings.length ? "partial" : "pass",
    strength_status: failures.length ? "unavailable" : "available",
    recipe_status: warnings.some(({ reason }) => [
      "winning_recipe_count_below_minimum",
      "winning_recipe_stat_date_missing",
      "master_plus_canonical_roster_partial",
    ].includes(String(reason)))
      ? "partial"
      : "available",
    checked_at: new Date().toISOString(),
    minimums,
    catalog_compatibility: catalogCompatibility,
    coverage: {
      static_basis: snapshot.static_basis,
      tiers: tierCoverage,
    },
    failures,
    warnings,
  };
}

function buildTierSignal(tierData) {
  const topTraits = tierData.main_trait_strength
    .map((row) => {
      const top1 = currentNode(row, "top1_rate");
      const top4 = currentNode(row, "top4_rate");
      const useRate = currentNode(row, "use_rate");
      return {
        key: traitLabel(row.main_traits),
        main_traits: row.main_traits || [],
        top1_rate: top1,
        top4_rate: top4,
        use_rate: useRate,
        signal_score: scoreTopOneAndFour(top1, top4, null, useRate),
      };
    })
    .sort((left, right) => right.signal_score - left.signal_score);

  const topHeroes = (tierData.hero_strength["255"] || [])
    .map((row) => {
      const top1 = currentNode(row, "top1_rate");
      const top4 = currentNode(row, "top4_rate");
      const avgRank = currentNode(row, "avg_rank");
      const useRate = currentNode(row, "use_rate");
      return {
        hero_id: row.hero_id,
        top1_rate: top1,
        top4_rate: top4,
        avg_rank: avgRank,
        use_rate: useRate,
        signal_score: scoreTopOneAndFour(top1, top4, avgRank, useRate),
      };
    })
    .sort((left, right) => right.signal_score - left.signal_score)
    .slice(0, 25);

  const topEquips = (tierData.equip_rank?.list || [])
    .map((row) => ({
      equip_id: row.equip_id,
      top1_rate: Number(row.top1_rate),
      top4_rate: Number(row.top4_rate),
      avg_rank: Number(row.hero_rank),
      use_rate: Number(row.use_rate),
      top_3_hero: row.top_3_hero || [],
      signal_score: scoreTopOneAndFour(Number(row.top1_rate), Number(row.top4_rate), Number(row.hero_rank), Number(row.use_rate)),
    }))
    .sort((left, right) => right.signal_score - left.signal_score)
    .slice(0, 25);

  const heroItemMap = new Map();
  for (const row of tierData.equip_rank?.list || []) {
    const equipId = String(row.equip_id || "");
    if (!equipId) continue;
    const topHeroes = Array.isArray(row.top_3_hero) ? row.top_3_hero : [];
    topHeroes.forEach((heroId, heroIndex) => {
      const key = String(heroId || "");
      if (!key) return;
      if (!heroItemMap.has(key)) {
        heroItemMap.set(key, {
          hero_id: key,
          items: [],
          source: "equip_rank.top_3_hero",
          interpretation: "rank_prior_not_perfect_item_combo",
        });
      }
      heroItemMap.get(key).items.push({
        equip_id: equipId,
        top1_rate: Number(row.top1_rate),
        top4_rate: Number(row.top4_rate),
        avg_rank: Number(row.hero_rank),
        use_rate: Number(row.use_rate),
        use_count: Number(row.use_count),
        hero_slot: heroIndex + 1,
        signal_score: scoreHeroItemSignal(row, heroIndex),
      });
    });
  }

  const heroItemSignal = [...heroItemMap.values()]
    .map((entry) => ({
      ...entry,
      items: entry.items
        .sort((left, right) => right.signal_score - left.signal_score)
        .slice(0, HERO_ITEM_SIGNAL_EQUIP_LIMIT),
    }))
    .map((entry) => ({
      ...entry,
      signal_score: entry.items.reduce((sum, item, index) => sum + item.signal_score / (index + 1), 0),
    }))
    .sort((left, right) => right.signal_score - left.signal_score)
    .slice(0, HERO_ITEM_SIGNAL_LIMIT);

  const topLineups = topTraits.map((row) => ({
    id: `national:${row.key}`,
    name: row.key,
    main_traits: row.main_traits,
    top1_rate: row.top1_rate,
    top4_rate: row.top4_rate,
    use_rate: row.use_rate,
    signal_score: row.signal_score,
    source_role: "national_master_plus_strength_anchor",
    metrics_authority: true,
  }));
  const augmentLineupSignal = buildAugmentLineupSignal(tierData);

  return {
    top_traits: topTraits,
    top_heroes: topHeroes,
    top_equips: topEquips,
    hero_item_signal: heroItemSignal,
    top_lineups: topLineups,
    augment_lineup_signal: augmentLineupSignal,
  };
}

function buildRankSignal(snapshot) {
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    stat_date: snapshot.stat_date,
    battle_type: BATTLE_TYPE,
    lineup_version_id: LINEUP_VERSION_ID,
    evidence_domains: {
      strength: { status: "available", stat_date: snapshot.stat_date },
      heroes: { status: "available", stat_date: snapshot.stat_date },
      items: {
        status: TIERS.every((tier) => snapshot.tiers[tier.id]?.equip_rank?.dtstatdate)
          ? TIERS.every((tier) => snapshot.tiers[tier.id]?.equip_rank?.dtstatdate === snapshot.stat_date)
            ? "available"
            : "date_mismatch"
          : "unavailable",
        stat_date: snapshot.tiers[MASTER_PLUS_TIER_ID]?.equip_rank?.dtstatdate || null,
      },
      hero_items: {
        status: Object.keys(snapshot.tiers[MASTER_PLUS_TIER_ID]?.hero_equip_rankings?.by_hero_id || {}).length
          ? Object.values(snapshot.tiers[MASTER_PLUS_TIER_ID]?.hero_equip_rankings?.by_hero_id || {})
              .every((entry) => entry?.dtstatdate === snapshot.stat_date)
            ? "available"
            : "date_mismatch"
          : "unavailable",
        stat_date: Object.values(snapshot.tiers[MASTER_PLUS_TIER_ID]?.hero_equip_rankings?.by_hero_id || {})
          .map((entry) => entry?.dtstatdate)
          .find(Boolean) || null,
      },
      winning_recipes: {
        status: snapshot.tiers[MASTER_PLUS_TIER_ID]?.recipe_sources?.winning?.capability?.status || "unavailable",
        stat_date: snapshot.tiers[MASTER_PLUS_TIER_ID]?.recipe_sources?.winning?.capability?.source_stat_date || null,
      },
    },
    tiers: Object.fromEntries(TIERS.map((tier) => [tier.id, {
      label: tier.label,
      ...buildTierSignal(snapshot.tiers[tier.id]),
    }])),
  };
}

function indexByMetric(items, keyField, metricField) {
  const index = new Map();
  for (const item of items || []) {
    const key = item[keyField];
    const value = Number(item[metricField]);
    if (key && Number.isFinite(value)) index.set(String(key), value);
  }
  return index;
}

function metricDiff(currentItems, previousItems, keyField, metricField) {
  const previous = indexByMetric(previousItems, keyField, metricField);
  return (currentItems || [])
    .map((item) => {
      const key = String(item[keyField]);
      const currentValue = Number(item[metricField]);
      if (!key || !Number.isFinite(currentValue) || !previous.has(key)) return null;
      return { key, current: currentValue, previous: previous.get(key), delta: currentValue - previous.get(key) };
    })
    .filter(Boolean)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, 25);
}

function buildDiff(currentSignal, previousSignal) {
  if (!previousSignal) {
    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      status: "no_previous_snapshot",
      stat_date: currentSignal.stat_date,
      tiers: {},
    };
  }
  const tiers = {};
  for (const tier of TIERS) {
    const current = currentSignal.tiers[tier.id];
    const previous = previousSignal.tiers?.[tier.id];
    tiers[tier.id] = {
      top_trait_top1_delta: metricDiff(current?.top_traits, previous?.top_traits, "key", "top1_rate"),
      top_hero_avg_rank_delta: metricDiff(current?.top_heroes, previous?.top_heroes, "hero_id", "avg_rank"),
      top_equip_top4_delta: metricDiff(current?.top_equips, previous?.top_equips, "equip_id", "top4_rate"),
      hero_item_signal_delta: metricDiff(current?.hero_item_signal, previous?.hero_item_signal, "hero_id", "signal_score"),
      recipe_identity_delta: [],
      augment_recipe_association_delta: [],
    };
  }
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    status: "compared",
    previous_stat_date: previousSignal.stat_date,
    stat_date: currentSignal.stat_date,
    tiers,
  };
}

async function readActiveSignal(activeClosure) {
  if (activeClosure?.availability !== "available") return null;
  return await readJsonIfExists(path.join(activeClosure.ranking.generation_dir, "rank-signal.json"));
}

function writeRecipeOnlySyncResult({ popularRecipeCandidate, phase, error }) {
  const failure = String(error?.message || error || "master_plus_source_unavailable").slice(0, 500);
  console.log(JSON.stringify({
    status: "ranking_strength_unavailable_recipes_cached",
    stat_date: null,
    coverage: {},
    failures: [{ reason: "master_plus_fetch_failed", phase, diagnostic: failure }],
    recipe_capabilities: {
      popular: popularRecipeCandidate.capability,
      winning: { status: "unavailable_master_plus_fetch_failed", source_role: "winning_recipe", metrics_authority: false },
      combined: {
        status: popularRecipeCandidate.capability.status,
        metrics_authority: false,
        accepted_recipe_count: popularRecipeCandidate.recipes.length,
        quarantined_row_count: popularRecipeCandidate.quarantine.length,
        generation_id: popularRecipeCandidate.generation?.generation_id || null,
      },
      full_ranking_overlay_available: false,
    },
    snapshot_in_use: "last_known_good_current",
    ranking_target: {
      selection: rankingTarget.selection,
      publication_scope: rankingTarget.publication_scope,
      season_id: rankingTarget.season_id,
      patch_id: rankingTarget.patch_id,
      game_mode_id: rankingTarget.game_mode_id,
      ranking_set_id: rankingTarget.ranking_set_id,
      core_profile_id: rankingTarget.core_profile_id,
    },
    history: null,
    candidate_verification: null,
    published_generation: null,
    active_generation: null,
    candidate_generation: null,
    prepared_generation: null,
    prepared_pointer_file: null,
    expected_active_generation_id: null,
    output_dir: null,
  }, null, 2));
}

const args = parseArgs(process.argv.slice(2));
const today = parseYmd(args.today);
const hardDataManifest = rankingTarget.hard_data_manifest_value;
const staticData = await loadStaticBasisPromise();
const officialSourceDictionary = await buildOfficialSourceDictionary({
  upstream_identity: rankingTarget.upstream_identity,
});
const coverageMinimums = buildLiveRankingCoverageMinimums(staticData);
const staticBasis = staticData.summary;
const refreshLease = await acquireLiveRankingRefreshLease({ rootDir: OUTPUT_DIR });
try {
rankingRefresh: {
let popularRecipeCandidate;
try {
  popularRecipeCandidate = await fetchAndPublishRankingRecipeCandidate({
    target: rankingTarget,
    catalogs: staticData,
    rootDir: OUTPUT_DIR,
    lease: refreshLease,
  });
} catch (error) {
  popularRecipeCandidate = {
    capability: {
      schema: "jcc-live-ranking-recipe-capability-v1",
      capability: "official_curated_popular_lineup_recipes",
      status: "unavailable_error",
      source_role: "popular_recipe",
      metrics_authority: false,
      player_lineups_enabled: false,
      error: error?.message || String(error),
    },
    generation: null,
    recipes: [],
    quarantine: [],
  };
}
let latest;
try {
  latest = await findLatestStatDate(today);
} catch (error) {
  if (popularRecipeCandidate.capability.status !== "available") throw error;
  writeRecipeOnlySyncResult({ popularRecipeCandidate, phase: "find_latest_stat_date", error });
  break rankingRefresh;
}
const activeClosureBeforeUpdate = rankingTarget.publication_scope === "active"
  ? resolveRankingRefreshBaselineClosureSync({
      rootDir: OUTPUT_DIR,
      expectedIdentity: {
        core_profile_id: rankingTarget.core_profile_id,
        season_id: rankingTarget.season_id,
        patch_id: rankingTarget.patch_id,
        catalog_fingerprint: rankingTarget.catalog_source_fingerprint,
        hard_data_manifest_fingerprint: rankingTarget.hard_data_manifest_fingerprint,
      },
    })
  : {
      availability: "unavailable",
      closure_status: "candidate_target",
      reason: "candidate Ranking refresh does not read or mutate the production Active closure",
      ranking_generation_id: null,
      target_compatible: false,
      replacement_required: false,
    };
if (rankingTarget.publication_scope === "active" && activeClosureBeforeUpdate.closure_status === "invalid") {
  throw new Error(`active Ranking closure is invalid before refresh: ${activeClosureBeforeUpdate.reason || "unknown reason"}`);
}
const existingCurrentSignal = rankingTarget.publication_scope === "active"
  && activeClosureBeforeUpdate.target_compatible === true
  ? await readActiveSignal(activeClosureBeforeUpdate)
  : null;
const existingPreviousSignal = rankingTarget.publication_scope === "active"
  ? await readJsonIfExists(path.join(PREVIOUS_DIR, "rank-signal.json"))
  : null;
const sameStatDateRefresh = existingCurrentSignal?.stat_date === latest.statDate;
const previousSignal = sameStatDateRefresh
  ? existingPreviousSignal
  : existingCurrentSignal;
const stagingDir = path.join(OUTPUT_DIR, `.candidate-${process.pid}-${Date.now()}`);
const activePointerBeforeUpdate = activeClosureBeforeUpdate.availability === "available"
  ? {
      generation_id: activeClosureBeforeUpdate.ranking_generation_id,
      recipe_generation_id: activeClosureBeforeUpdate.recipe_generation_id,
      stat_date: activeClosureBeforeUpdate.stat_date,
      core_profile_id: activeClosureBeforeUpdate.core_profile_id,
    }
  : await readJsonIfExists(path.join(OUTPUT_DIR, "active-generation.json"));

const snapshot = {
  schema_version: 1,
  captured_at: new Date().toISOString(),
  source: {
    api_origin: API_ORIGIN,
    page: "https://jcc.qq.com/zmjkzone/page/datarank/",
    battle_type: BATTLE_TYPE,
    lineup_version_id: LINEUP_VERSION_ID,
    set_id: rankingTarget.ranking_set_id,
  },
  static_basis: staticBasis,
  stat_date: latest.statDate,
  fallback_days: latest.fallbackDays,
  probe_count: latest.probeCount,
  hero_probe_count: latest.heroProbeCount,
  tiers: {},
};

for (const tier of TIERS) {
  try {
    snapshot.tiers[tier.id] = await fetchTierData(tier.id, latest.statDate, rankingTarget.ranking_set_id, latest);
  } catch (error) {
    if (popularRecipeCandidate.capability.status !== "available") throw error;
    writeRecipeOnlySyncResult({ popularRecipeCandidate, phase: `fetch_master_plus_tier:${tier.id}`, error });
    break rankingRefresh;
  }
  const winningSourceDate = snapshot.tiers[tier.id].lineup_group?.dtstatdate || null;
  const winningFreshness = evaluateRecipeSourceFreshness({
    rankingStatDate: latest.statDate,
    sourceStatDate: winningSourceDate,
    identityCompatible: true,
    sourceStatus: winningSourceDate ? "available" : "missing",
    sourceRole: "winning_recipe",
  });
  const winningSourceEligible = recipeFreshnessAllowsAutomaticPairing(winningFreshness);
  const winningRecipes = winningSourceEligible
    ? winningRecipeGroupsFromRaw(snapshot.tiers[tier.id].lineup_group, staticData, {
        auxiliaryRegistry: buildRankingRecipeAuxiliaryRegistry(popularRecipeCandidate.recipes),
      })
    : {
        recipes: [],
        quarantine: [{
          source_id: "lineup_group_list",
          reason: winningSourceDate ? `winning_recipe_${winningFreshness.status}` : "winning_recipe_stat_date_missing",
          observed_stat_date: winningSourceDate,
          expected_stat_date: latest.statDate,
        }],
      };
  snapshot.tiers[tier.id].recipe_sources = {
    winning: {
      capability: {
        status: !winningSourceEligible
          ? "unavailable_invalid_stat_date"
          : winningRecipes.recipes.length ? "available" : "unavailable_no_current_catalog_recipe",
        source_role: "winning_recipe",
        metrics_authority: false,
        source_stat_date: winningSourceDate,
        expected_stat_date: latest.statDate,
        freshness: winningFreshness,
        accepted_recipe_count: winningRecipes.recipes.length,
        quarantined_row_count: winningRecipes.quarantine.length,
      },
      ...winningRecipes,
    },
    popular: {
      capability: {
        ...popularRecipeCandidate.capability,
        source_stat_date: popularRecipeCandidate.capability?.source_stat_date || null,
      },
      generation_id: popularRecipeCandidate.generation?.generation_id || null,
      recipes: popularRecipeCandidate.recipes,
      quarantine: popularRecipeCandidate.quarantine,
    },
  };
}
for (const tier of TIERS) {
  enrichOfficialTraitSemantics(snapshot.tiers[tier.id], officialSourceDictionary);
}
snapshot.official_source_dictionary = {
  schema: officialSourceDictionary.schema,
  upstream_identity: officialSourceDictionary.upstream_identity,
  source_hashes: officialSourceDictionary.source_hashes,
  content_hash: officialSourceDictionary.content_hash,
  trait_count: officialSourceDictionary.trait.count,
  chess_count: officialSourceDictionary.chess.count,
};

const masterWinningRecipes = snapshot.tiers[MASTER_PLUS_TIER_ID]?.recipe_sources?.winning || {
  capability: { status: "unavailable", source_role: "winning_recipe", metrics_authority: false },
  recipes: [],
  quarantine: [],
};
const catalogCompatibility = auditLiveRankingCatalogCompatibility(snapshot, staticData);
const audit = buildAudit(snapshot, coverageMinimums, catalogCompatibility);
const publishableWinningRecipes = masterWinningRecipes.capability?.status === "available"
  ? masterWinningRecipes
  : {
      capability: {
        status: "unavailable_master_plus_audit_failed",
        source_role: "winning_recipe",
        metrics_authority: false,
        accepted_recipe_count: 0,
        quarantined_row_count: masterWinningRecipes.recipes.length + masterWinningRecipes.quarantine.length,
      },
      recipes: [],
      quarantine: [
        ...masterWinningRecipes.quarantine,
        ...masterWinningRecipes.recipes.map((recipe) => ({
          source_id: recipe.source_id,
          reason: "master_plus_audit_failed_before_winning_recipe_publication",
        })),
      ],
    };
const combinedRecipeCandidate = await publishRankingRecipeCandidate({
  target: { ...rankingTarget, ranking_stat_date: latest.statDate },
  rootDir: OUTPUT_DIR,
  sourceCapabilities: {
    winning: publishableWinningRecipes.capability,
    popular: popularRecipeCandidate.capability,
  },
  recipes: [
    ...publishableWinningRecipes.recipes,
    ...popularRecipeCandidate.recipes,
  ],
  quarantine: [
    ...publishableWinningRecipes.quarantine.map((row) => ({ ...row, source_role: "winning_recipe" })),
    ...popularRecipeCandidate.quarantine.map((row) => ({ ...row, source_role: "popular_recipe" })),
  ],
  lease: refreshLease,
});
const signal = buildRankSignal(snapshot);
signal.source_identity = {
  runtime_season_id: rankingTarget.season_id,
  active_patch_id: rankingTarget.patch_id,
  game_mode_id: rankingTarget.game_mode_id,
  package_id: rankingTarget.package_id,
  source_package_id: hardDataManifest.packageId,
  core_profile_id: rankingTarget.core_profile_id,
  hard_data_manifest_fingerprint: rankingTarget.hard_data_manifest_fingerprint,
  catalog_source_fingerprint: rankingTarget.catalog_source_fingerprint,
  battle_type: snapshot.source.battle_type,
  lineup_version_id: snapshot.source.lineup_version_id,
  ranking_set_id: snapshot.source.set_id,
};
let historyBaseline = null;
if (previousSignal?.stat_date) {
  try {
    const archived = await archiveLiveRankingSignal(previousSignal, {
      rootDir: OUTPUT_DIR,
      keepDates: 14,
    });
    historyBaseline = {
      status: "archived_committed_baseline",
      stat_date: archived.stat_date,
      retained_dates: archived.pruned.retained_dates,
    };
  } catch (error) {
    historyBaseline = {
      status: "degraded",
      stat_date: previousSignal.stat_date,
      error: error?.message || String(error),
    };
  }
}
const trendSummary = await buildLiveRankingTrendSummaryIncludingSignal(signal, {
  rootDir: OUTPUT_DIR,
  keepDates: 14,
});
const strategyIndex = buildLiveRankingStrategyIndex(snapshot, {
  traits: staticData.traits,
  champions: staticData.champions,
  roleProfiles: staticData.roleProfiles,
  items: staticData.items,
  augments: staticData.augments,
  runtimeSeasonId: rankingTarget.season_id,
  upstreamSeasonId: rankingTarget.upstream_identity?.season || null,
  activePatchId: rankingTarget.patch_id,
  gameModeId: rankingTarget.game_mode_id,
  packageId: rankingTarget.package_id,
  sourcePackageId: hardDataManifest.packageId,
  coreProfileId: rankingTarget.core_profile_id,
  hardDataManifestFingerprint: rankingTarget.hard_data_manifest_fingerprint,
  catalogSourceFingerprint: rankingTarget.catalog_source_fingerprint,
  trendSummary,
  commonSemanticDocument: rankingTarget.common_semantic_document,
  officialSourceDictionary,
  sourceEntityMappings: staticData.source_entity_mappings,
});
audit.source_identity = strategyIndex.source_identity;
signal.source_identity = strategyIndex.source_identity;
const diff = buildDiff(signal, previousSignal);
const capabilityStatus = rankingCapabilityWarnings(audit, strategyIndex);
const strengthSnapshotAvailable = capabilityStatus.strength_status === "available";
const manifest = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source_identity: strategyIndex.source_identity,
  current: {
    stat_date: snapshot.stat_date,
    files: ["snapshot.json", "rank-signal.json", "lineup-strategy-index.json", "latest-diff.json", "audit.json"],
  },
  previous_retained: Boolean(previousSignal),
  same_stat_date_refresh: sameStatDateRefresh,
  retention_policy: "Keep current raw snapshot and one previous stat_date snapshot. Keep the latest 14 distinct compact history signals. Repeated refreshes for the same stat_date overwrite that date and must not rotate current into previous.",
};

await rm(stagingDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });
try {
  await writeJson(path.join(stagingDir, "snapshot.json"), snapshot);
  await writeJson(path.join(stagingDir, "rank-signal.json"), signal);
  await writeCompactJson(path.join(stagingDir, "lineup-strategy-index.json"), strategyIndex);
  await writeJson(path.join(stagingDir, "latest-diff.json"), diff);
  await writeJson(path.join(stagingDir, "audit.json"), audit);
  await writeJson(path.join(stagingDir, "manifest.json"), manifest);

  let candidateVerification = null;
  let generationPublication = null;
  const activePublicationLease = refreshLease;
  if (["ready", "ready_with_source_lag"].includes(capabilityStatus.overall_status)) {
    candidateVerification = verifyRankingCandidate(stagingDir, rankingTarget);
    const immutableArtifacts = await Promise.all(GENERATION_ARTIFACT_FILES.map(async (file) => ({
      path: file,
      sha256: await sha256File(path.join(stagingDir, file)),
    })));
    try {
      generationPublication = await publishLiveRankingGeneration({
        rootDir: OUTPUT_DIR,
        candidateDir: stagingDir,
        artifacts: immutableArtifacts,
        statDate: snapshot.stat_date,
        binding: liveRankingBindingFromSourceIdentity(strategyIndex.source_identity),
        activatePointer: false,
        lease: activePublicationLease,
      });
      if (rankingTarget.publication_scope === "candidate" && !args.deferActivation) {
        const pointer = {
          schema: "jcc-live-ranking-candidate-pointer-v1",
          season_id: rankingTarget.season_id,
          patch_id: rankingTarget.patch_id,
          game_mode_id: rankingTarget.game_mode_id,
          core_profile_id: rankingTarget.core_profile_id,
          generation_id: generationPublication.pointer.generation_id,
          recipe_generation_id: combinedRecipeCandidate.generation?.generation_id || null,
          stat_date: generationPublication.pointer.stat_date,
          content_sha256: generationPublication.pointer.content_sha256,
          catalog_fingerprint: generationPublication.pointer.catalog_fingerprint,
          hard_data_manifest_fingerprint: generationPublication.pointer.hard_data_manifest_fingerprint,
          status: "ready",
        };
        await mkdir(path.dirname(rankingTarget.candidate_pointer_file), { recursive: true });
        const tempPointer = `${rankingTarget.candidate_pointer_file}.${process.pid}.tmp`;
        try {
          await writeJson(tempPointer, pointer);
          await refreshLease.renew();
          await refreshLease.assertOwnership();
          await rename(tempPointer, rankingTarget.candidate_pointer_file);
        } finally {
          await rm(tempPointer, { force: true }).catch(() => {});
        }
      } else {
        const preparedPointerFile = path.join(
          OUTPUT_DIR,
          "candidates",
          `maintenance-${rankingTarget.core_profile_id}.json`,
        );
        const pointer = createRankingMaintenancePreparationPointer({
          season_id: rankingTarget.season_id,
          patch_id: rankingTarget.patch_id,
          game_mode_id: rankingTarget.game_mode_id,
          core_profile_id: rankingTarget.core_profile_id,
          generation_id: generationPublication.pointer.generation_id,
          recipe_generation_id: combinedRecipeCandidate.generation?.generation_id || null,
          stat_date: generationPublication.pointer.stat_date,
          content_sha256: generationPublication.pointer.content_sha256,
          catalog_fingerprint: generationPublication.pointer.catalog_fingerprint,
          hard_data_manifest_fingerprint: generationPublication.pointer.hard_data_manifest_fingerprint,
          expected_active_generation_id: activePointerBeforeUpdate?.generation_id || null,
          expected_active_ranking_generation_id: activePointerBeforeUpdate?.generation_id || null,
          expected_active_recipe_generation_id: activePointerBeforeUpdate?.recipe_generation_id || null,
          expected_active_stat_date: activePointerBeforeUpdate?.stat_date || null,
          expected_active_core_profile_id: activePointerBeforeUpdate?.core_profile_id || null,
        });
        await mkdir(path.dirname(preparedPointerFile), { recursive: true });
        const tempPointer = `${preparedPointerFile}.${process.pid}.tmp`;
        try {
          await writeJson(tempPointer, pointer);
          await refreshLease.renew();
          await refreshLease.assertOwnership();
          await rename(tempPointer, preparedPointerFile);
        } finally {
          await rm(tempPointer, { force: true }).catch(() => {});
        }
        generationPublication.prepared_pointer_file = preparedPointerFile;
      }
    } finally {
      await activePublicationLease.assertOwnership();
    }
  } else if (combinedRecipeCandidate.capability.status !== "available") {
    process.exitCode = 1;
  }

  const semanticMaintenancePrepared = rankingTarget.publication_scope === "active" || args.deferActivation;
  console.log(JSON.stringify({
    status: ["ready", "ready_with_source_lag"].includes(capabilityStatus.overall_status)
      ? (capabilityStatus.full_ranking_overlay_available ? "pass" : "ranking_strength_ready_with_partial_domains")
      : combinedRecipeCandidate.capability.status === "available"
        ? "ranking_strength_unavailable_recipes_cached"
        : "fail",
    capability_status: capabilityStatus,
    stat_date: strengthSnapshotAvailable ? snapshot.stat_date : null,
    attempted_stat_date: strengthSnapshotAvailable ? null : snapshot.stat_date,
    same_stat_date_refresh: sameStatDateRefresh,
    fallback_days: snapshot.fallback_days,
    coverage: audit.coverage.tiers,
    failures: audit.failures,
    recipe_capabilities: {
      popular: popularRecipeCandidate.capability,
      winning: publishableWinningRecipes.capability,
      combined: {
        ...combinedRecipeCandidate.capability,
        generation_id: combinedRecipeCandidate.generation?.generation_id || null,
      },
      full_ranking_overlay_available: capabilityStatus.full_ranking_overlay_available,
      ranking_strength_available: strengthSnapshotAvailable,
    },
    snapshot_in_use: strengthSnapshotAvailable
      ? (semanticMaintenancePrepared
          ? "prepared_for_semantic_maintenance"
          : "published_candidate")
      : "last_known_good_current",
    ranking_target: {
      selection: rankingTarget.selection,
      publication_scope: rankingTarget.publication_scope,
      season_id: rankingTarget.season_id,
      patch_id: rankingTarget.patch_id,
      game_mode_id: rankingTarget.game_mode_id,
      ranking_set_id: rankingTarget.ranking_set_id,
      core_profile_id: rankingTarget.core_profile_id,
    },
    history: {
      baseline: historyBaseline,
      current_signal: "archived_only_after_unified_publication_commit",
    },
    previous_tier_retention: null,
    candidate_verification: strengthSnapshotAvailable ? candidateVerification : null,
    published_generation: generationPublication?.pointer || null,
    active_generation: null,
    active_closure: null,
    active_recipe_generation: null,
    compatibility_mirror_errors: [],
    publication_status: "not_committed",
    candidate_generation: rankingTarget.publication_scope === "candidate" && !args.deferActivation ? generationPublication?.pointer || null : null,
    prepared_generation: semanticMaintenancePrepared ? generationPublication?.pointer || null : null,
    prepared_pointer_file: semanticMaintenancePrepared ? generationPublication?.prepared_pointer_file || null : null,
    expected_active_generation_id: semanticMaintenancePrepared ? activePointerBeforeUpdate?.generation_id || null : null,
    expected_active_ranking_generation_id: semanticMaintenancePrepared ? activePointerBeforeUpdate?.generation_id || null : null,
    expected_active_recipe_generation_id: semanticMaintenancePrepared ? activePointerBeforeUpdate?.recipe_generation_id || null : null,
    expected_active_stat_date: semanticMaintenancePrepared ? activePointerBeforeUpdate?.stat_date || null : null,
    expected_active_core_profile_id: semanticMaintenancePrepared ? activePointerBeforeUpdate?.core_profile_id || null : null,
    output_dir: semanticMaintenancePrepared
      ? generationPublication?.generation_dir || null
      : generationPublication?.generation_dir || null,
  }, null, 2));
} finally {
  await rm(stagingDir, { recursive: true, force: true });
}
}
} finally {
  await refreshLease.release();
}
