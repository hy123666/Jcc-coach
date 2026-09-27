import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildLineupLifecycleContext } from "./build-jcc-lineup-lifecycle-context.mjs";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { buildLevelingEconomyContext } from "./build-jcc-leveling-economy-context.mjs";
import { loadActiveRulesBundle } from "./jcc_active_rules_contract.mjs";
import { resolveHardDataTarget, validateHardDataTarget } from "./jcc_hard_data_target.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
function usage() {
  return [
    "Usage:",
    "  node tools/build-jcc-combat-cap-estimator-context.mjs --live-state <file> [--context <file>] [--live-rankings <file>] [--out <file>]",
    "",
    "Builds a lightweight combat/cap estimator context from live_state, hard data, an optional Match-compatible Master+ Ranking Overlay, and target plan.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--live-state") options.liveState = argv[++index];
    else if (arg === "--context") options.context = argv[++index];
    else if (arg === "--live-rankings") options.liveRankings = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file, fallback = null) {
  if (!file || !existsSync(file)) return fallback;
  const text = await readFile(file, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

async function readRequiredJson(file) {
  if (!file || !existsSync(file)) throw new Error(`Required active hard-data index is missing: ${file}`);
  const text = await readFile(file, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function roundScore(value) {
  return Number(clamp01(value).toFixed(2));
}

function normalizeAddressId(value) {
  const raw = String(value ?? "");
  if (!raw) return "";
  const match = raw.match(/(\d+)$/);
  return match ? match[1] : raw;
}

function baseId(value) {
  const number = numberOrNull(value);
  if (number === null) return "";
  if (number >= 10000) return String(number % 10000);
  return String(number);
}

function unitIds(unit) {
  return [
    unit?.base_id,
    unit?.baseId,
    unit?.hero_id,
    unit?.id,
    unit?.i,
    unit?.champion_address,
  ].map((value) => baseId(normalizeAddressId(value))).filter(Boolean);
}

function itemIds(item) {
  return [
    item?.item_id,
    item?.id,
    item?.i,
    item?.item_address,
  ].map((value) => normalizeAddressId(value)).filter(Boolean);
}

function normalizeUnits(units) {
  return asArray(units).map((unit) => ({
    ...unit,
    ids: unitIds(unit),
    base_id: unitIds(unit)[0] || "",
    name: unit?.name || unit?.hero_name || unit?.cn_name || unit?.display_name || unit?.n || String(unit?.id || "unknown"),
    star: numberOrNull(unit?.star || unit?.stars) || 1,
    cost: numberOrNull(unit?.cost),
  }));
}

function collectLiveState(raw) {
  const root = raw.live_state || raw;
  const economy = root.economy || root.player?.economy || {};
  const phase = root.phase || root.round || {};
  const board = root.board || root.own_board || {};
  const bench = root.bench || root.own_bench || {};
  const shop = root.shop || {};
  const items = root.items || {};
  return {
    raw: root,
    matchSessionId: root.match_session_id || root.matchSessionId || raw.match_session_id || null,
    phase: {
      stageRound: firstDefined(phase.stage_round, phase.stageRound, phase.round_key, phase.current_round, root.stage_round, null),
    },
    matchVariables: root.match_variables || {},
    economy: {
      hp: numberOrNull(firstDefined(economy.hp, economy.health, economy.life)),
      level: numberOrNull(firstDefined(economy.level, economy.lv)),
      gold: numberOrNull(firstDefined(economy.gold, economy.money)),
      xp: firstDefined(economy.xp, economy.exp, null),
    },
    boardUnits: normalizeUnits(firstDefined(board.board_units, board.units, root.board_units, [])),
    benchUnits: normalizeUnits(firstDefined(bench.bench_units, bench.units, root.bench_units, [])),
    shopUnits: normalizeUnits(firstDefined(shop.shop_units, shop.units, root.shop_units, [])),
    itemBench: asArray(firstDefined(items.item_bench, items.bench, items.inventory, root.item_bench, [])),
    equippedItems: asArray(firstDefined(items.equipped_items, items.equipped, root.equipped_items, [])),
  };
}

function normalizeContext(raw = {}) {
  const root = raw.context || raw;
  const targetPlan = root.target_plan || root.strategy?.target_plan || root.current_plan || null;
  const targetIds = new Set();
  for (const value of [
    ...asArray(targetPlan?.unit_ids),
    ...asArray(targetPlan?.core_unit_ids),
    ...asArray(targetPlan?.units),
  ]) {
    const id = baseId(normalizeAddressId(value?.id || value?.hero_id || value?.unit_id || value));
    if (id) targetIds.add(id);
  }
  const targetNames = new Set();
  for (const value of [
    ...asArray(targetPlan?.unit_names),
    ...asArray(targetPlan?.core_unit_names),
    ...asArray(targetPlan?.champions),
  ]) {
    targetNames.add(String(value?.name || value).toLowerCase());
  }
  return { root, targetPlan, targetIds, targetNames };
}

function mapByChampionId(rows) {
  const map = new Map();
  for (const row of asArray(rows)) {
    const id = baseId(normalizeAddressId(row.champion_address || row.entity_address || row.address));
    if (id) map.set(id, row);
  }
  return map;
}

function mapWeights(rows) {
  const byBaseId = {};
  for (const row of asArray(rows)) {
    if (row.entity_kind !== "champion") continue;
    const id = baseId(normalizeAddressId(row.entity_address || row.address));
    if (!id) continue;
    byBaseId[id] = row;
  }
  return byBaseId;
}

function mapItemHolderFit(rows) {
  const byItemId = new Map();
  for (const row of asArray(rows)) {
    const itemId = normalizeAddressId(row.item_address || row.address);
    if (itemId) byItemId.set(itemId, row);
  }
  return byItemId;
}

function rankingLineupsFromSource(liveRankings) {
  if (!liveRankings || typeof liveRankings !== "object") return [];
  const direct = [
    ...asArray(liveRankings.top_lineups),
    ...asArray(liveRankings.lineup_groups),
  ];
  const tiered = Object.values(liveRankings.tiers || {}).flatMap((tier) => [
    ...asArray(tier?.top_lineups),
    ...asArray(tier?.lineup_groups),
    ...asArray(tier?.lineup_candidates),
  ]);
  const seen = new Set();
  return [...direct, ...tiered].filter((lineup) => {
    if (!lineup || typeof lineup !== "object") return false;
    const key = String(lineup.id || lineup.lineup_group_id || lineup.anchor_id || JSON.stringify(lineup));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rankingIdentityFromSource(liveRankings) {
  return liveRankings?.ranking_overlay_id
    || liveRankings?.generation_id
    || liveRankings?.content_fingerprint
    || (liveRankings?.source_identity && [
      liveRankings.source_identity.runtime_season_id,
      liveRankings.source_identity.active_patch_id,
      liveRankings.source_identity.lineup_version_id,
      liveRankings.source_identity.ranking_set_id,
      liveRankings.stat_date,
    ].filter(Boolean).join(":"))
    || null;
}

function rankingCandidateMetrics(lineup) {
  const anchor = lineup?.strength_anchor || {};
  const metrics = anchor.metrics || lineup?.metrics || {};
  const quality = anchor.quality || lineup?.quality || {};
  const adjusted = quality.adjusted_metrics || {};
  return {
    top1_rate: firstDefined(metrics.top1_rate, metrics.top_1_rate, adjusted.top1_rate, lineup?.top1_rate),
    top4_rate: firstDefined(metrics.top4_rate, metrics.top_4_rate, adjusted.top4_rate, lineup?.top4_rate),
    use_rate: firstDefined(metrics.use_rate, metrics.user_rate, lineup?.use_rate),
    signal_score: firstDefined(lineup?.signal_score, quality.current_day_score, quality.ceiling_score),
  };
}

function normalizeRankingLineupForEstimator(lineup) {
  if (!lineup || typeof lineup !== "object") return null;
  const metrics = rankingCandidateMetrics(lineup);
  const hasSourceAuthority = lineup.source_role === "national_master_plus_strength_anchor"
    && lineup.metrics_authority === true;
  const hasDetailedStrengthAnchor = Boolean(lineup.strength_anchor && (
    lineup.strength_anchor.metrics || lineup.strength_anchor.quality
  ));
  if (!hasSourceAuthority && !hasDetailedStrengthAnchor) return lineup;
  return {
    ...lineup,
    id: lineup.id || lineup.lineup_group_id || lineup.strength_anchor?.anchor_id || null,
    main_traits: lineup.main_traits || lineup.main_trait_list || [],
    top1_rate: numberOrNull(metrics.top1_rate),
    top4_rate: numberOrNull(metrics.top4_rate),
    use_rate: numberOrNull(metrics.use_rate),
    signal_score: numberOrNull(metrics.signal_score),
    source_role: "national_master_plus_strength_anchor",
    metrics_authority: true,
  };
}

function scoreUnit(unit, hard) {
  const id = unit.base_id;
  const role = hard.role.get(id);
  const damage = hard.damage.get(id);
  const weights = hard.weights[id]?.strategy_weights?.weights || hard.weights[id]?.weights || {};
  const cost = unit.cost ?? role?.cost ?? damage?.cost ?? 1;
  const costScore = Math.min(1, cost / 5);
  const starScore = Math.min(1, unit.star / 3);
  const immediate = (numberOrNull(weights.immediate_power) || 0) / 50;
  const tempo = (numberOrNull(weights.tempo) || 0) / 50;
  const frontline = (numberOrNull(weights.frontline) || 0) / 50;
  const backline = (numberOrNull(weights.backline_damage) || 0) / 50;
  const roleBonus = role?.role === "frontline" ? 0.1 : role?.role?.includes("carry") ? 0.12 : 0.05;
  return clamp01(costScore * 0.25 + starScore * 0.28 + immediate * 0.12 + tempo * 0.1 + frontline * 0.1 + backline * 0.1 + roleBonus);
}

function targetHit(unit, context) {
  return unit.ids.some((id) => context.targetIds.has(id)) || context.targetNames.has(String(unit.name || "").toLowerCase());
}

function scoreBoard(live, hard, context) {
  if (!live.boardUnits.length) return { score: 0, hits: [] };
  const unitScores = live.boardUnits.map((unit) => ({ unit, score: scoreUnit(unit, hard) }));
  const average = unitScores.reduce((sum, row) => sum + row.score, 0) / unitScores.length;
  const targetHits = live.boardUnits.filter((unit) => targetHit(unit, context));
  const targetBonus = Math.min(0.15, targetHits.length * 0.035);
  return {
    score: roundScore(average + targetBonus),
    hits: targetHits.map((unit) => ({ id: unit.base_id, name: unit.name, star: unit.star })),
    unit_scores: unitScores.map((row) => ({ id: row.unit.base_id, name: row.unit.name, score: roundScore(row.score) })),
  };
}

function scoreItems(live, hard) {
  const boardIds = new Set(live.boardUnits.flatMap((unit) => unit.ids));
  const equippedScores = [];
  for (const item of live.equippedItems) {
    const ids = itemIds(item);
    const holderIds = unitIds({ id: item.holder_id, base_id: item.holder_base_id, champion_address: item.holder_champion_address });
    const holderId = holderIds.find(Boolean);
    let bestFit = 0.36;
    for (const itemId of ids) {
      const fit = hard.itemHolderFit.get(itemId);
      const candidate = asArray(fit?.candidate_holders).find((holder) => baseId(normalizeAddressId(holder.champion_address)) === holderId);
      if (candidate) bestFit = Math.max(bestFit, (numberOrNull(candidate.fit_score) || 0) / 100);
    }
    equippedScores.push(bestFit);
  }
  const benchScores = [];
  for (const item of live.itemBench) {
    const ids = itemIds(item);
    let bestFit = 0.28;
    for (const itemId of ids) {
      const fit = hard.itemHolderFit.get(itemId);
      const candidateFits = asArray(fit?.candidate_holders)
        .filter((holder) => boardIds.has(baseId(normalizeAddressId(holder.champion_address))))
        .map((holder) => (numberOrNull(holder.fit_score) || 0) / 100);
      if (candidateFits.length) bestFit = Math.max(bestFit, ...candidateFits);
    }
    benchScores.push(bestFit * 0.7);
  }
  const all = [...equippedScores, ...benchScores];
  if (!all.length) return { score: 0, equipped_scores: [], bench_scores: [] };
  return {
    score: roundScore(Math.min(1, all.reduce((sum, score) => sum + score, 0) / Math.max(3, all.length))),
    equipped_scores: equippedScores.map(roundScore),
    bench_scores: benchScores.map(roundScore),
  };
}

function scoreTraitCap(live, hard, context, liveRankings) {
  const ownedIds = new Set([...live.boardUnits, ...live.benchUnits, ...live.shopUnits].flatMap((unit) => unit.ids));
  let bestDistanceScore = 0;
  const closeTraits = [];
  for (const trait of hard.traitUnitMatrix) {
    const members = asArray(trait.members).map((member) => baseId(normalizeAddressId(member.champion_address))).filter(Boolean);
    const ownedCount = members.filter((id) => ownedIds.has(id)).length;
    const breakpoints = asArray(trait.breakpoints).map((bp) => numberOrNull(bp.count)).filter((count) => count !== null).sort((a, b) => a - b);
    const next = breakpoints.find((count) => count > ownedCount) ?? breakpoints[breakpoints.length - 1] ?? null;
    if (!next) continue;
    const distance = Math.max(0, next - ownedCount);
    const distanceScore = next ? clamp01(ownedCount / next) : 0;
    if (distanceScore > bestDistanceScore) bestDistanceScore = distanceScore;
    if (ownedCount > 0 && distance <= 2) {
      closeTraits.push({ trait_address: trait.trait_address, owned_count: ownedCount, next_breakpoint: next, distance });
    }
  }
  const targetTotal = Math.max(1, context.targetIds.size + context.targetNames.size);
  const targetOwned = [...new Set([...live.boardUnits, ...live.benchUnits, ...live.shopUnits].filter((unit) => targetHit(unit, context)).map((unit) => unit.base_id))].length;
  const targetCoverage = clamp01(targetOwned / targetTotal);
  const topLineups = asArray(liveRankings?.top_lineups).filter((lineup) => (
    lineup?.source_role === "national_master_plus_strength_anchor"
    && lineup?.metrics_authority === true
  ));
  const intelligenceSignal = topLineups.length
    ? Math.max(...topLineups.map((lineup) => numberOrNull(lineup.signal_score) || numberOrNull(lineup.top4_rate) || 0))
    : 0;
  return {
    score: roundScore(targetCoverage * 0.48 + bestDistanceScore * 0.24 + Math.min(1, intelligenceSignal) * 0.2 + Math.min(1, (live.economy.level || 0) / 10) * 0.08),
    target_coverage: roundScore(targetCoverage),
    close_traits: closeTraits.slice(0, 8),
    live_rankings_signal: roundScore(Math.min(1, intelligenceSignal)),
  };
}

function stageMajor(stageRound) {
  const match = String(stageRound || "").match(/^(\d+)-/);
  return match ? Number(match[1]) : null;
}

function scoreRisk(live, boardPower) {
  const hp = live.economy.hp;
  const major = stageMajor(live.phase.stageRound);
  const hpRisk = hp === null ? 0.45 : hp <= 35 ? 0.9 : hp <= 55 ? 0.65 : hp <= 75 ? 0.42 : 0.22;
  const stageRisk = major === null ? 0.35 : major <= 2 ? 0.18 : major === 3 ? 0.38 : major === 4 ? 0.58 : 0.75;
  const boardWeakness = 1 - clamp01(boardPower);
  return roundScore(hpRisk * 0.48 + stageRisk * 0.24 + boardWeakness * 0.28);
}

async function loadHardData(patchDir) {
  const indexDir = `${patchDir}/indexes`;
  const [
    damage,
    role,
    itemFit,
    itemHolderFit,
    traitBreakpoints,
    traitUnitMatrix,
    weightsRows,
  ] = await Promise.all([
    readRequiredJson(`${indexDir}/champion_damage_profile.json`),
    readRequiredJson(`${indexDir}/champion_role_profile.json`),
    readRequiredJson(`${indexDir}/champion_item_fit.json`),
    readRequiredJson(`${indexDir}/item_holder_fit.json`),
    readRequiredJson(`${indexDir}/trait_breakpoints.json`),
    readRequiredJson(`${indexDir}/trait_unit_matrix.json`),
    readRequiredJson(`${indexDir}/entity_strategy_weights.json`),
  ]);
  return {
    damage: mapByChampionId(damage),
    role: mapByChampionId(role),
    championItemFit: mapByChampionId(itemFit),
    itemHolderFit: mapItemHolderFit(itemHolderFit),
    traitBreakpoints,
    traitUnitMatrix,
    weightsRows,
    weights: mapWeights(weightsRows),
  };
}

function resolveProfileContext(explicitProfileContext = null) {
  if (explicitProfileContext) {
    const coreProfileId = String(explicitProfileContext.core_profile_id || "").trim();
    const hardDataManifest = String(explicitProfileContext.hard_data_manifest || "").trim();
    if (!/^[a-f0-9]{64}$/.test(coreProfileId)) {
      throw new Error("Captured combat estimator profile is missing a valid core_profile_id");
    }
    if (!hardDataManifest || !explicitProfileContext.base_game_rules) {
      throw new Error("Captured combat estimator profile must include hard_data_manifest and base_game_rules");
    }
    return Object.freeze({
      core_profile_id: coreProfileId,
      hard_data_manifest: hardDataManifest,
      rules_source_fingerprint: explicitProfileContext.rules_source_fingerprint || null,
      base_game_rules: explicitProfileContext.base_game_rules,
      semantic_feature_index: explicitProfileContext.semantic_feature_index || null,
      source: explicitProfileContext.source || "captured_core_profile",
    });
  }
  const runtimePaths = createRuntimePaths(repoRoot);
  const rulesBundle = loadActiveRulesBundle({ repoRoot, runtimePaths });
  return Object.freeze({
    core_profile_id: runtimePaths.activeCoreProfileId || null,
    hard_data_manifest: runtimePaths.activeHardDataManifest,
    rules_source_fingerprint: rulesBundle.source_fingerprint || null,
    base_game_rules: rulesBundle.base_game_rules,
    semantic_feature_index: runtimePaths.activeSemanticFeatureIndexFile,
    source: "standalone_active_profile_resolution",
  });
}

async function buildContext(options) {
  const profileContext = resolveProfileContext(options.profileContext || null);
  const hardDataTarget = resolveHardDataTarget({
    repoRoot,
    activeManifest: profileContext.hard_data_manifest,
    allowCandidate: false,
  });
  await validateHardDataTarget(hardDataTarget);
  const liveState = collectLiveState(await readJson(options.liveState));
  const sourceContext = normalizeContext(options.context ? await readJson(options.context, {}) : {});
  const hard = await loadHardData(hardDataTarget.packageDir);
  const semanticFeatureIndex = await readJson(profileContext.semantic_feature_index, {});
  const liveRankings = await readJson(options.liveRankings, sourceContext.root.live_rankings_context || {});
  const rankingLineups = rankingLineupsFromSource(liveRankings);
  const estimatorRankingLineups = rankingLineups
    .map(normalizeRankingLineupForEstimator)
    .filter(Boolean);
  const rankingIdentity = rankingIdentityFromSource(liveRankings);

  const board = scoreBoard(liveState, hard, sourceContext);
  const item = scoreItems(liveState, hard);
  const cap = scoreTraitCap(liveState, hard, sourceContext, { ...liveRankings, top_lineups: estimatorRankingLineups });
  const expectedDamageRisk = scoreRisk(liveState, board.score);
  const economyLeveling = buildLevelingEconomyContext({
    liveState: {
      match_session_id: liveState.matchSessionId,
      phase: liveState.phase,
      economy: {
        gold: liveState.economy.gold,
        hp: liveState.economy.hp,
        level: liveState.economy.level,
        xp: liveState.raw?.economy?.xp ?? liveState.raw?.economy?.exp ?? null,
      },
      board: { board_units: liveState.boardUnits },
      bench: { bench_units: liveState.benchUnits },
      shop: { shop_units: liveState.shopUnits },
      augments: { selected_augments: liveState.raw?.augments?.selected_augments || liveState.raw?.augments?.selected || [] },
      match_variables: liveState.matchVariables,
    },
    context: {
      ...sourceContext.root,
      __jcc_profile_context: profileContext,
    },
  });
  const lineupLifecycle = buildLineupLifecycleContext({
    liveState: liveState.raw || liveState,
    context: sourceContext.root,
    profileContext,
  });
  economyLeveling.lineup_lifecycle = lineupLifecycle;
  if (economyLeveling.leveling_math) economyLeveling.leveling_math.lineup_lifecycle = lineupLifecycle;
  const boardReadiness = lineupLifecycle.board_readiness;

  const context = {
    ...sourceContext.root,
    hard_data_context: {
      ...(sourceContext.root.hard_data_context || {}),
      source_hard_data_manifest: profileContext.hard_data_manifest,
      source_core_profile_id: profileContext.core_profile_id,
      rules_source_fingerprint: profileContext.rules_source_fingerprint,
      entity_strategy_weights: hard.weights,
      augment_semantic_profiles: {
        schema: "jcc-augment-semantic-profile-index-v1",
        source_core_profile_id: semanticFeatureIndex?.identity?.core_profile_id || null,
        season_id: semanticFeatureIndex?.identity?.season_id || null,
        by_id: Object.fromEntries((semanticFeatureIndex?.entities || [])
          .filter((entry) => entry?.entity_kind === "augment" && entry?.augment_profile)
          .map((entry) => [String(entry.entity_id), entry.augment_profile])),
        by_name: Object.fromEntries((semanticFeatureIndex?.entities || [])
          .filter((entry) => entry?.entity_kind === "augment" && entry?.augment_profile && entry?.name)
          .map((entry) => [String(entry.name).trim().toLowerCase(), entry.augment_profile])),
      },
    },
    live_rankings_context: {
      ...(sourceContext.root.live_rankings_context || {}),
      source_file: options.liveRankings || null,
      ranking_overlay_id: rankingIdentity,
      generated_at: liveRankings?.generated_at || null,
      stat_date: liveRankings?.stat_date || null,
      top_heroes: asArray(liveRankings?.top_heroes),
      top_lineups: estimatorRankingLineups.filter((lineup) => (
        lineup?.source_role === "national_master_plus_strength_anchor"
        && lineup?.metrics_authority === true
      )),
      lineup_candidates: asArray(liveRankings?.lineup_candidates)
        .length
        ? asArray(liveRankings.lineup_candidates)
        : asArray(liveRankings?.tiers?.["0"]?.lineup_candidates),
      lineup_groups: asArray(liveRankings?.lineup_groups)
        .length
        ? asArray(liveRankings.lineup_groups)
        : asArray(liveRankings?.tiers?.["0"]?.lineup_groups),
    },
    combat_cap_estimator: {
      board_power_score: board.score,
      item_power_score: item.score,
      cap_power_score: cap.score,
      economy_score: economyLeveling.status === "ready" ? roundScore(Math.max(0, Math.min(1, ((liveState.economy.gold || 0) / 50) * 0.55 + (economyLeveling.actions?.[0]?.score || 0) * 0.45))) : 0,
      tempo_score: economyLeveling.status === "ready" ? roundScore(Math.max(...economyLeveling.actions.map((action) => action.score), 0)) : 0,
      expected_damage_risk: expectedDamageRisk,
      survival_pressure_score: expectedDamageRisk,
      estimator_policy: "hard_data_with_optional_master_plus_rankings_fast_estimate",
      opponent_board_policy: "opponent_board_pressure_removed_no_reliable_mumu_unit_source",
      target_coverage_score: cap.target_coverage,
      economy_leveling: economyLeveling,
      lineup_lifecycle: lineupLifecycle,
      board_readiness: boardReadiness,
    },
  };

  return {
    schema: "jcc-combat-cap-estimator-context-v1",
    match_session_id: liveState.matchSessionId,
    core_profile_id: profileContext.core_profile_id,
    rules_source_fingerprint: profileContext.rules_source_fingerprint,
    generated_at: new Date().toISOString(),
    context,
    evidence: [
      { type: "hard_data.champion_profiles", summary: "Board power uses champion role/damage profiles plus entity strategy weights.", value: board },
      { type: "hard_data.item_fit", summary: "Item power uses item holder fit and current equipped/item bench evidence.", value: item },
      { type: "hard_data.trait_breakpoint_distance", summary: "Cap power uses target coverage and nearest trait breakpoint distance.", value: cap },
      ...(rankingIdentity || rankingLineups.length ? [{ type: "live_rankings.typed_context", summary: "The Match-compatible Tencent/JCC Master+ Ranking Overlay is an optional prior and does not override live_state or hard data.", value: { file: options.liveRankings || null, ranking_overlay_id: rankingIdentity, stat_date: liveRankings?.stat_date || null, candidate_count: estimatorRankingLineups.length } }] : []),
      { type: "runtime.opponent_board_policy", summary: "Opponent board pressure is intentionally excluded because MuMu does not expose reliable opponent unit identity.", value: { opponent_board_pressure_removed: true } },
      { type: "economy.leveling_ev", summary: "Leveling/economy EV is computed from current live_state and variable XP policy; lineup tempo is not pre-enumerated.", value: economyLeveling },
      { type: "lineup.lifecycle", summary: "Season-neutral cost-curve lifecycle constrains roll/level posture without hardcoding a season lineup.", value: lineupLifecycle },
      { type: "board.readiness", summary: "Own-board readiness estimates frontline, damage, stars, items, population, target coverage, and loss buffer; it is not a battle simulator.", value: boardReadiness },
    ],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.liveState) throw new Error("--live-state is required");
  const result = await buildContext(options);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) await writeFile(options.out, json, "utf8");
  process.stdout.write(json);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

export { buildContext };
