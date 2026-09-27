import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  collectRankingQueryTerms,
  readItemBrowseTaxonomySummary,
  sortStrategyFitCandidateLines,
} from "../ui/electron/runtime-service.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ""))];
}

function traitLookupFromOverlay(overlay) {
  return overlay?.traits_by_id || {};
}

function traitNameByCodeFromOverlay(overlay) {
  const out = {};
  for (const trait of Object.values(overlay?.traits_by_id || {})) {
    const code = String(trait?.code_id || "").trim();
    const name = trait?.normalized_name || trait?.name || null;
    if (code && name && !out[code]) out[code] = name;
  }
  return out;
}

function readableTrait(trait, traitsById) {
  const traitId = String(trait?.trait_id || "").trim();
  const count = trait?.hero_num || trait?.chess_num || null;
  const match = traitsById[traitId];
  const name = match?.normalized_name || match?.name || null;
  return {
    ...trait,
    trait_id: traitId || trait?.trait_id || null,
    trait_name: name,
    display_name: name && count ? `${name}${count}` : name || null,
  };
}

function readableRankingEntry(entry, traitsById) {
  const mainTraits = Array.isArray(entry?.main_traits)
    ? entry.main_traits.map((trait) => readableTrait(trait, traitsById))
    : null;
  const mainTraitList = Array.isArray(entry?.main_trait_list)
    ? entry.main_trait_list.map((trait) => readableTrait(trait, traitsById))
    : null;
  const displayParts = (mainTraits || mainTraitList || [])
    .filter((trait) => trait.trait_name)
    .map((trait) => trait.display_name);
  const unresolvedTraits = (mainTraits || mainTraitList || [])
    .filter((trait) => !trait.trait_name)
    .map((trait) => ({
      trait_id: trait.trait_id,
      hero_num: trait.hero_num || trait.chess_num || null,
    }));
  return {
    ...entry,
    ...(mainTraits ? { main_traits: mainTraits } : {}),
    ...(mainTraitList ? { main_trait_list: mainTraitList } : {}),
    display_name: displayParts.length ? displayParts.join(" + ") : null,
    unresolved_traits: unresolvedTraits,
    raw_key: entry?.key || entry?.id || null,
  };
}

function compactRankingEntries(entries, traitsById, count = 5) {
  return Array.isArray(entries) ? entries.slice(0, count).map((entry) => readableRankingEntry(entry, traitsById)) : [];
}

function readableHeroItemSignal(entry, championsByRankingId, itemsById) {
  const champion = championsByRankingId[String(entry?.hero_id || "")] || null;
  return {
    hero_id: entry?.hero_id || null,
    hero_name: champion?.normalized_name || champion?.name || null,
    interpretation: entry?.interpretation || "rank_prior_not_perfect_item_combo",
    source: entry?.source || "equip_rank.top_3_hero",
    items: (Array.isArray(entry?.items) ? entry.items : []).slice(0, 4).map((item) => {
      const equip = itemsById[String(item?.equip_id || "")] || null;
      return {
        equip_id: item?.equip_id || null,
        equip_name: equip?.normalized_name || equip?.name || null,
        top1_rate: numericMetric(item?.top1_rate),
        top4_rate: numericMetric(item?.top4_rate),
        avg_rank: numericMetric(item?.avg_rank),
        use_rate: numericMetric(item?.use_rate),
        use_count: numericMetric(item?.use_count),
        signal_score: numericMetric(item?.signal_score),
      };
    }),
  };
}

function compactHeroItemSignals(entries, overlay, count = 5) {
  const championsByRankingId = {};
  for (const champion of Object.values(overlay?.champions_by_id || {})) {
    for (const id of uniqueStrings([
      String(champion?.id || ""),
      String(champion?.id || "").replace(/^\d(?=\d{4}$)/, ""),
    ].filter(Boolean))) {
      championsByRankingId[id] = champion;
    }
  }
  const itemsById = overlay?.items_by_id || {};
  return Array.isArray(entries)
    ? entries.slice(0, count).map((entry) => readableHeroItemSignal(entry, championsByRankingId, itemsById))
    : [];
}

function readableAugmentLineupSignal(entry, overlay, traitsById) {
  const augment = overlay?.augments_by_id?.[String(entry?.augment_id || "")] || null;
  return {
    augment_id: entry?.augment_id || null,
    augment_name: augment?.normalized_name || augment?.name || null,
    source: entry?.source || "lineup_group.info.list.rune_id_group",
    interpretation: entry?.interpretation || "lineup_association_prior_not_independent_augment_winrate",
    not_independent_winrate: entry?.not_independent_winrate === true,
    lineup_count: numericMetric(entry?.lineup_count),
    total_use_num: numericMetric(entry?.total_use_num),
    weighted_top1_rate: numericMetric(entry?.weighted_top1_rate),
    weighted_top4_rate: numericMetric(entry?.weighted_top4_rate),
    weighted_avg_rank: numericMetric(entry?.weighted_avg_rank),
    weighted_use_rate: numericMetric(entry?.weighted_use_rate),
    signal_score: numericMetric(entry?.signal_score),
    associated_lineups: (Array.isArray(entry?.associated_lineups) ? entry.associated_lineups : []).slice(0, 3).map((lineup) => ({
      lineup_group_id: lineup?.lineup_group_id || null,
      lineup_rank: lineup?.lineup_rank || null,
      population: lineup?.population || null,
      main_traits: traitDisplayList(lineup?.main_trait_group || lineup?.main_trait_list, traitsById),
      lineup_ids: Array.isArray(lineup?.lineup_ids) ? lineup.lineup_ids.slice(0, 10).map(String) : [],
      core_chess_ids: Array.isArray(lineup?.core_chess_ids) ? lineup.core_chess_ids.slice(0, 10).map(String) : [],
      avg_rank: numericMetric(lineup?.avg_rank),
      top1_rate: numericMetric(lineup?.top1_rate),
      top4_rate: numericMetric(lineup?.top4_rate),
      use_rate: numericMetric(lineup?.use_rate),
      use_num: numericMetric(lineup?.use_num),
      signal_score: numericMetric(lineup?.signal_score),
    })),
  };
}

function compactAugmentLineupSignals(entries, overlay, traitsById, count = 8) {
  return Array.isArray(entries)
    ? entries.slice(0, count).map((entry) => readableAugmentLineupSignal(entry, overlay, traitsById))
    : [];
}

function traitDisplayList(traits, traitsById) {
  return (Array.isArray(traits) ? traits : [])
    .map((trait) => readableTrait({
      trait_id: trait?.trait_id,
      hero_num: trait?.hero_num || trait?.chess_num || null,
    }, traitsById))
    .filter((trait) => trait?.trait_name)
    .map((trait) => trait.display_name || trait.trait_name);
}

function numericMetric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactLineupVariant(variant, traitsById) {
  if (!variant || typeof variant !== "object") return null;
  return {
    lineup_rank: variant.lineup_rank || null,
    population: variant.population || null,
    main_traits: traitDisplayList(variant.main_trait_group, traitsById),
    sub_traits: traitDisplayList(variant.sub_trait_list, traitsById).slice(0, 6),
    lineup_ids: Array.isArray(variant.lineup) ? variant.lineup.slice(0, 10).map(String) : [],
    core_chess_ids: Array.isArray(variant.core_chess) ? variant.core_chess.slice(0, 10).map(String) : [],
    avg_rank: numericMetric(variant.avg_rank),
    top1_rate: numericMetric(variant.top_1_rate ?? variant.top1_rate),
    top4_rate: numericMetric(variant.top_4_rate ?? variant.top4_rate),
    use_rate: numericMetric(variant.use_rate),
  };
}

function compactLineupGroups(groups, traitsById, count = 20) {
  return (Array.isArray(groups) ? groups : []).slice(0, count).map((group) => {
    const variants = Array.isArray(group?.info?.list) ? group.info.list : [];
    return {
      id: group?.id || null,
      display_name: traitDisplayList(group?.main_trait_list, traitsById).join(" + ") || null,
      main_traits: traitDisplayList(group?.main_trait_list, traitsById),
      summary: {
        avg_rank: numericMetric(group?.info?.info?.sum?.avg_rank),
        top1_rate: numericMetric(group?.info?.info?.sum?.top_1_rate),
        top4_rate: numericMetric(group?.info?.info?.sum?.top_4_rate),
        use_rate: numericMetric(group?.info?.info?.sum?.use_rate),
      },
      variants: variants.slice(0, 2).map((variant) => compactLineupVariant(variant, traitsById)).filter(Boolean),
      variant_search_index: variants.map((variant) => ({
        lineup_rank: variant?.lineup_rank || null,
        lineup_ids: Array.isArray(variant?.lineup) ? variant.lineup.slice(0, 10).map(String) : [],
        core_chess_ids: Array.isArray(variant?.core_chess) ? variant.core_chess.slice(0, 10).map(String) : [],
      })),
    };
  });
}

function summarizeLiveRankings(manifest, rankSignal, latestDiff, overlay, snapshot = null) {
  const traitsById = traitLookupFromOverlay(overlay);
  const tiers = rankSignal?.tiers || {};
  const snapshotTiers = snapshot?.tiers || {};
  return {
    schema: "jcc-live-rankings-host-context-summary-v1",
    available: Boolean(rankSignal),
    stat_date: rankSignal?.stat_date || manifest?.current?.stat_date || null,
    battle_type: rankSignal?.battle_type || null,
    generated_at: rankSignal?.generated_at || manifest?.generated_at || null,
    previous_stat_date: latestDiff?.previous_stat_date || null,
    files: manifest?.current?.files || [],
    tiers: Object.fromEntries(Object.entries(tiers).map(([tierId, tier]) => [tierId, {
      label: tier.label || null,
      top_traits: compactRankingEntries(tier.top_traits, traitsById),
      top_heroes: compactRankingEntries(tier.top_heroes, traitsById),
      top_equips: compactRankingEntries(tier.top_equips, traitsById),
      hero_item_signal: compactHeroItemSignals(tier.hero_item_signal, overlay),
      augment_lineup_signal: compactAugmentLineupSignals(tier.augment_lineup_signal, overlay, traitsById),
      top_lineups: compactRankingEntries(tier.top_lineups, traitsById),
      lineup_groups: compactLineupGroups(snapshotTiers[tierId]?.lineup_group?.main_traits_data, traitsById),
    }])),
    latest_diff: latestDiff
      ? {
          status: latestDiff.status || null,
          stat_date: latestDiff.stat_date || null,
          previous_stat_date: latestDiff.previous_stat_date || null,
        }
      : null,
  };
}

function uniqueChampionEntries(overlay) {
  const traitByCode = traitNameByCodeFromOverlay(overlay);
  const byName = new Map();
  for (const champion of Object.values(overlay?.champions_by_id || {})) {
    const name = champion?.normalized_name || champion?.name || null;
    const cost = Number(champion?.cost);
    if (!name || !Number.isFinite(cost) || cost <= 0) continue;
    const traitCodes = uniqueStrings([champion?.class_or_trait_codes, champion?.shop_or_pool_code]
      .filter((value) => value !== null && value !== undefined)
      .flatMap((value) => String(value).split("|"))
      .map((code) => code.trim())
      .filter((code) => code && code !== "-1"));
    const traits = traitCodes.map((code) => traitByCode[code] || code).filter(Boolean);
    const existing = byName.get(name);
    const entry = {
      name,
      cost,
      traits,
      ids: [String(champion.id)].filter(Boolean),
      ranking_ids: uniqueStrings([
        String(champion.id || ""),
        String(champion.id || "").replace(/^\d(?=\d{4}$)/, ""),
      ].filter(Boolean)),
    };
    if (!existing) {
      byName.set(name, entry);
      continue;
    }
    existing.cost = Math.min(existing.cost, cost);
    existing.traits = uniqueStrings([...existing.traits, ...traits]);
    existing.ids = uniqueStrings([...existing.ids, ...entry.ids]);
    existing.ranking_ids = uniqueStrings([...(existing.ranking_ids || []), ...entry.ranking_ids]);
  }
  return [...byName.values()].sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name, "zh-Hans-CN"));
}

function summarizeSeasonCatalog(overlay, activeSeason) {
  const champions = uniqueChampionEntries(overlay);
  const traits = Object.values(overlay?.traits_by_id || {}).reduce((acc, trait) => {
    const name = trait?.normalized_name || trait?.name || null;
    if (!name || acc.some((entry) => entry.name === name)) return acc;
    acc.push({
      name,
      code_id: trait?.code_id || null,
      breakpoints: trait?.breakpoints || null,
    });
    return acc;
  }, []).sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  const championsByCost = {};
  for (const champion of champions) {
    const key = String(champion.cost);
    if (!championsByCost[key]) championsByCost[key] = [];
    championsByCost[key].push(champion);
  }
  return {
    schema: "jcc-season-catalog-host-context-summary-v1",
    source: "data/runtime/jcc/mumu-catalog-overlay.json",
    active_season: activeSeason.season_id,
    active_patch_id: activeSeason.active_patch_id,
    champion_count: champions.length,
    trait_count: traits.length,
    champions_by_cost: championsByCost,
    champion_names: champions.map((champion) => champion.name),
    traits,
    policy: {
      current_season_only: true,
      do_not_invent_champions: true,
      if_name_missing: "Say it is not in the current season catalog or ask for clarification.",
    },
  };
}

function requestText(request) {
  return [
    request.user_message,
    request.task,
    ...(Array.isArray(request.instructions) ? request.instructions : []),
  ].filter(Boolean).join("\n");
}

function needsContext(text, keywords) {
  return keywords.some((keyword) => String(text || "").includes(keyword));
}

function hasStrategyEvidence(request) {
  const context = request.context || {};
  return Boolean(
    context.live_state_summary
      || context.live_state
      || context.current_state
      || context.strategy_context
      || context.estimator_context
      || context.scores
      || context.choices
      || context.augment_choices
      || context.item_choices
      || context.reward_choices
  );
}

function resolvePolicy(request, contract) {
  const mode = request.mode || "daily_chat";
  const text = requestText(request);
  const strategyIntent = needsContext(text, contract.strategy_intent_keywords) || hasStrategyEvidence(request);
  const rankingIntent = needsContext(text, contract.ranking_intent_keywords) || hasStrategyEvidence(request);
  const seasonCatalogIntent = needsContext(text, contract.season_catalog_intent_keywords) || hasStrategyEvidence(request);
  const includeUserPreferences = contract.user_preferences_policy.attach_when_modes.includes(mode) || strategyIntent;
  const includeDailyBigData = contract.daily_big_data_policy.attach_when_modes.includes(mode) || rankingIntent;
  const includeSeasonCatalog = contract.season_catalog_policy.attach_when_modes.includes(mode) || rankingIntent || seasonCatalogIntent;
  const includeStrategyWiki = mode !== "user_preferences"
    && ((contract.strategy_wiki_policy?.attach_when_modes || []).includes(mode)
      || strategyIntent
      || rankingIntent);
  return {
    schema: "jcc-runtime-host-context-policy-v1",
    contract: contract.schema,
    mode,
    strategy_intent: strategyIntent,
    ranking_intent: rankingIntent,
    season_catalog_intent: seasonCatalogIntent,
    include_user_preferences: includeUserPreferences,
    include_daily_big_data: includeDailyBigData,
    include_season_catalog: includeSeasonCatalog,
    include_strategy_wiki: includeStrategyWiki,
    reason: strategyIntent || includeUserPreferences || includeDailyBigData || includeSeasonCatalog || includeStrategyWiki
      ? "mode_or_user_message_needs_strategy_context"
      : "minimal_runtime_context_only",
  };
}

function buildRequest({ mode, userMessage, contract, userPreferences, dailyBigData, seasonCatalog, context = {} }) {
  const base = {
    request_id: `verify:${mode}:${userMessage}`,
    mode,
    user_message: userMessage,
    context,
  };
  const policy = resolvePolicy(base, contract);
  const strategyWikiContext = {
    schema: "jcc-strategy-wiki-host-context-v1",
    available: true,
    status_policy: "published_pages_only",
    evidence_priority: "soft_prior_below_live_state_rules_hard_data_big_data",
    pages: [{
      page_id: "verify-wiki",
      category: "universal_gameplay_strategy",
      title: "Verify published wiki prior",
      summary: "Published strategy wiki pages are soft evidence for strategy answers.",
    }],
  };
  return {
    ...base,
    ...(policy.include_user_preferences ? { user_preferences: userPreferences } : {}),
    ...(policy.include_daily_big_data ? { daily_big_data: dailyBigData } : {}),
    ...(policy.include_season_catalog ? { season_catalog: seasonCatalog } : {}),
    ...(policy.include_strategy_wiki ? { strategy_wiki_context: strategyWikiContext } : {}),
    runtime_context: {
      schema: "jcc-runtime-host-request-context-v1",
      context_policy: policy,
      host_session_kind: ["daily_chat", "postgame_review", "user_preferences", "strategy_wiki"].includes(mode) ? "daily" : "match",
      active_mode: mode,
      device_connection: { status: "connected" },
      match_session: { status: mode === "daily_chat" ? "idle" : "active", match_session_id: mode === "daily_chat" ? null : "verify-match" },
      host_cli: { provider: "codex", selected_model: "gpt-5.5" },
      user_preferences: policy.include_user_preferences ? userPreferences : null,
      daily_big_data: policy.include_daily_big_data ? dailyBigData : null,
      season_catalog: policy.include_season_catalog ? seasonCatalog : null,
      strategy_wiki_context: policy.include_strategy_wiki ? strategyWikiContext : null,
    },
  };
}

function assertAttached(request, field, label) {
  assert(request[field], `${label} should attach ${field}`);
  assert(request.runtime_context[field], `${label} should mirror ${field} in runtime_context`);
}

function assertNotAttached(request, field, label) {
  assert(!request[field], `${label} should not attach top-level ${field}`);
  assert(request.runtime_context[field] === null, `${label} should keep runtime_context.${field} null`);
}

function normalizeSearchText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "");
}

function selectedRankingCandidatesForTest(request) {
  const terms = collectRankingQueryTerms(request);
  const candidates = [];
  for (const [tier, value] of Object.entries(request.daily_big_data?.tiers || {})) {
    for (const group of value.lineup_groups || []) {
      const searchable = normalizeSearchText([
        group.display_name,
        ...(group.main_traits || []),
        ...(group.variant_search_index || []).flatMap((variant) => [
          ...(variant.lineup_ids || []),
          ...(variant.core_chess_ids || []),
        ]),
        ...(group.variants || []).flatMap((variant) => [
          ...(variant.lineup_ids || []),
          ...(variant.core_chess_ids || []),
          ...(variant.main_traits || []),
          ...(variant.sub_traits || []),
        ]),
      ].join(" "));
      const matched = terms.some((term) => term && searchable.includes(term));
      if (matched) candidates.push({ tier, display_name: group.display_name, variants: group.variants || [] });
    }
  }
  return { query_terms: terms, candidates: candidates.slice(0, 6) };
}

function sanitizeRankingEntryForHostTest(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    display_name: entry.display_name || null,
    top1_rate: entry.top1_rate ?? null,
    top4_rate: entry.top4_rate ?? null,
    use_rate: entry.use_rate ?? null,
    signal_score: entry.signal_score ?? null,
  };
}

function sanitizeDailyBigDataForHostTest(dailyBigData) {
  if (!dailyBigData || typeof dailyBigData !== "object") return null;
  const tiers = {};
  for (const [tier, value] of Object.entries(dailyBigData.tiers || {})) {
    tiers[tier] = {
      label: value?.label || tier,
      top_lineups: (Array.isArray(value?.top_lineups) ? value.top_lineups : []).slice(0, 5).map(sanitizeRankingEntryForHostTest).filter(Boolean),
      lineup_groups: (Array.isArray(value?.lineup_groups) ? value.lineup_groups : []).slice(0, 5).map((group) => ({
        display_name: group?.display_name || null,
        main_traits: Array.isArray(group?.main_traits) ? group.main_traits.slice(0, 8) : [],
        variants: Array.isArray(group?.variants) ? group.variants.slice(0, 2) : [],
      })),
      hero_item_signal: (Array.isArray(value?.hero_item_signal) ? value.hero_item_signal : []).slice(0, 5).map((entry) => ({
        hero_name: entry?.hero_name || null,
        interpretation: entry?.interpretation || null,
        items: Array.isArray(entry?.items) ? entry.items.slice(0, 4).map((item) => ({ equip_name: item?.equip_name || null })) : [],
      })),
      augment_lineup_signal: (Array.isArray(value?.augment_lineup_signal) ? value.augment_lineup_signal : []).slice(0, 5).map((entry) => ({
        augment_name: entry?.augment_name || null,
        interpretation: entry?.interpretation || null,
        not_independent_winrate: entry?.not_independent_winrate === true,
        associated_lineups: Array.isArray(entry?.associated_lineups) ? entry.associated_lineups.slice(0, 3) : [],
      })),
    };
  }
  return {
    available: dailyBigData.available === true,
    ranking_overlay_id: dailyBigData.ranking_overlay_id || null,
    unavailable_reason: dailyBigData.unavailable_reason || null,
    stat_date: dailyBigData.stat_date || null,
    tiers,
  };
}

function championByName(seasonCatalog, name) {
  return seasonCatalog.champion_names.includes(name)
    ? Object.values(seasonCatalog.champions_by_cost).flat().find((entry) => entry.name === name)
    : null;
}

function runJsonTool(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code) {
        reject(new Error(`${args.join(" ")} failed\n${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.replace(/^\uFEFF/, "")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function main() {
  const serviceText = await readFile("ui/electron/runtime-service.js", "utf8");
  const skillText = await readFile(".codex/skills/jcc-runtime-agent/SKILL.md", "utf8");
  const agentsText = await readFile("AGENTS.md", "utf8");
  const contract = await readJson("data/runtime/jcc/host-request-context-policy-contract.json");
  const hostInstructionText = await readFile("data/runtime/jcc/host-coach-instruction-contract.json", "utf8");
  const candidateProfile = await readJson("data/game-knowledge/jcc/candidates/candidate-profile.json");
  const itemBrowseTaxonomy = await readItemBrowseTaxonomySummary(path.join(
    "data/game-knowledge/jcc",
    candidateProfile.decision_input_catalog_path,
  ));
  assert(itemBrowseTaxonomy.source === "active_core_profile.decision-input-catalog.json", "Host taxonomy must read the immutable Active Core catalog");
  assert(itemBrowseTaxonomy.classified_item_count > 0, "Host taxonomy must expose current-patch classified items");
  assert(itemBrowseTaxonomy.items_by_browse_facet.physical.includes("无尽之刃"), "Host physical facet must include the compiled Infinity Edge classification");
  assert(!itemBrowseTaxonomy.items_by_browse_facet.magic?.includes("无尽之刃"), "incidental skill-crit text must not classify Infinity Edge as magic");

  for (const needle of [
    "readSeasonCatalogSummary",
    "readItemBrowseTaxonomySummary",
    "item_browse_taxonomy",
    "items_by_browse_facet",
    "items_by_primary_role",
    "include_season_catalog",
    "include_strategy_wiki",
    "buildItemizationContextForHost",
    "equipmentRecipeQueryTextForHost",
    "equipmentRecipeQueryTextForHost(currentLiveStateSummaryWithTarget, hostMatchContext?.user_confirmed_equipment)",
    "include_itemization_context",
    "itemization_context: hostRequest?.itemization_context",
    "season_catalog: hostRequest?.season_catalog",
    "rawDailyBigData = policy.include_daily_big_data ? staticContextSource.daily_big_data : null",
    "compactDailyRankingMetaMap",
    "selected_ranking_candidates",
    "cruise_decision_context: summarizeCruiseDecisionContextForHost(runtimeContext.cruise_decision_context)",
    "active_rules_bundle: summarizeActiveRulesBundleForHost(runtimeContext.active_rules_bundle)",
    "strategy_fit_packet: summarizeStrategyFitPacketForHost",
    "buildCruiseDecisionContext({",
    "latest_user_intent: latestUserIntentFromMatchContext(matchContext)",
    "season_catalog: compactSeasonCatalogMetaMap(hostRequest?.season_catalog || context.season_catalog || runtimeContext?.season_catalog || null)",
    "runtime_context: runtimeContext",
    "context_policy: runtimeContext.context_policy || null",
    "buildHostCoachInstructions",
    "jcc-strategy-fit-packet-v1",
    "prior_and_candidate_generator_not_command",
    "highest_priority: [\"live_state\", \"active_rules_bundle\", \"confirmed_choices\", \"newer_user_intent\"]",
    "target_alignment: targetAlignment",
    "recommended_goal_policy: recommendedGoalPolicy",
    "user_intent_fit",
    "combined_fit_score",
    "self_state_roi_ocr_stale_match_result_dropped",
    "left_item_rail_roi_icon_stale_match_result_dropped",
    "initial_cruise_greeting_status: \"ready_without_automatic_answer\"",
    "resident_worker_failed_no_cold_fallback",
    "promotion_policy: item.promotion_policy || provenance.promotion_policy || null",
    "assignment_status: item.assignment_status || provenance.assignment_status || null",
    "freshness,",
    "missing_critical_facts: missingCriticalFacts",
    "choice_stage_round",
    "active_traits",
    "match_variables: matchFacts?.match_variables",
  ]) {
    assert(serviceText.includes(needle), `runtime-service.js missing ${needle}`);
  }
  assert(
    JSON.stringify(sortStrategyFitCandidateLines([
      { id: "low", combined_fit_score: 0.2 },
      { id: "high", combined_fit_score: 0.8 },
    ]).map((candidate) => candidate.id)) === JSON.stringify(["high", "low"]),
    "strategy candidates must be ordered by their computed fit score",
  );
  for (const needle of [
    "Use current-season catalog fields",
    "itemization context",
    "strategy wiki",
    "cruise_decision_context and strategy_fit_packet",
    "Mode add-ons narrow the answer surface",
    "Do not invent catalog entities",
  ]) {
    assert(hostInstructionText.includes(needle), `canonical host instruction contract missing ${needle}`);
  }
  const pipelineText = await readFile("tools/run-jcc-cruise-runtime-pipeline.mjs", "utf8");
  for (const needle of [
    "promotion_policy: rest.promotion_policy || rowProvenance.promotion_policy || null",
    "promotion_status: rest.promotion_status || rowProvenance.promotion_status || null",
    "assignment_status: rest.assignment_status || rowProvenance.assignment_status || null",
    "owner_scope: rest.owner_scope || rowProvenance.owner_scope || null",
  ]) {
    assert(pipelineText.includes(needle), `run-jcc-cruise-runtime-pipeline.mjs missing provenance preservation: ${needle}`);
  }
  for (const sentinelName of ["潘森", "古拉加斯", "派克", "蔚", "佛耶戈", "赛娜", "艾克", "慎"]) {
    assert(!serviceText.includes(sentinelName), `runtime-service.js must not hardcode champion sentinel name: ${sentinelName}`);
  }
  for (const needle of [
    "Runtime evidence inside a host request is also policy-gated",
    "Ranking ids such as `83110103_6` are backend-only signals",
  ]) {
    assert(skillText.includes(needle), `jcc-runtime-agent skill missing policy text: ${needle}`);
  }
  for (const needle of [
    "per-request INPUT_JSON selected context",
    "season_catalog",
  ]) {
    assert(agentsText.includes(needle), `AGENTS.md missing policy text: ${needle}`);
  }
  assert(/Do not\s+invent old-season champions/.test(agentsText), "AGENTS.md missing old-season invention guard");
  assert(contract.season_catalog_policy?.forbid_old_season_invention === true, "contract must forbid old-season champion invention");
  assert(contract.strategy_wiki_policy?.published_pages_only === true, "contract must limit host strategy wiki context to published pages");
  const selectedContextContract = contract.provider_neutral_selected_context_contract;
  assert(selectedContextContract?.schema === "jcc-host-selected-context-v1", "contract must define provider-neutral selected context schema");
  for (const field of [
    "runtime_context.game_state_brief.stage_round",
    "runtime_context.game_rule_contract",
    "runtime_context.match_facts.choice_confirmations",
    "runtime_context.match_facts.latest_user_intent",
    "runtime_context.cruise_decision_context",
    "runtime_context.cruise_decision_context.strategy_fit_packet",
    "live_state_summary.economy.gold",
    "missing_critical_facts",
  ]) {
    assert(selectedContextContract.always_include_for_match_answers?.includes(field), `selected context contract must always include ${field}`);
  }
  for (const check of [
    "latest_user_intent",
    "current_board_shop_bench",
    "confirmed_choice_history",
    "equipment_fit_from_4357_and_trusted_4356",
    "stage_economy_tempo",
    "daily_big_data.lineup_groups",
    "daily_big_data.hero_item_signal",
    "daily_big_data.augment_lineup_signal",
    "active_rules_bundle",
    "strategy_fit_packet.candidate_lines",
    "strategy_fit_packet.precedence_policy",
  ]) {
    assert(selectedContextContract.cruise_loop_fact_contract?.required_cross_checks?.includes(check), `cruise decision contract missing cross-check ${check}`);
  }
  for (const judgement of ["line_fit", "tempo_plan", "strategy_fit_packet.best_current_posture", "missing_facts_that_materially_change_next_decision"]) {
    assert(selectedContextContract.cruise_loop_fact_contract?.required_judgements?.includes(judgement), `cruise decision contract missing judgement ${judgement}`);
  }
  for (const shared of ["runtime_context.match_facts", "runtime_context.cruise_decision_context", "runtime_context.game_state_brief"]) {
    assert(selectedContextContract.cruise_loop_fact_contract?.shared_context_for_all_strategy_modes?.includes(shared), `manual modes must share ${shared}`);
  }
  for (const group of [
    "phase_and_economy_from_self_state_roi_ocr",
    "own_board_shop_bench_from_mumu_4353_4354_under_self_anchor",
    "item_bench_from_mumu_4357",
    "latest_user_intent",
  ]) {
    assert(selectedContextContract.cruise_loop_fact_contract?.fixed_fact_groups?.includes(group), `cruise fact contract missing ${group}`);
  }
  assert(selectedContextContract.manual_mode_fact_contract?.augment_choice?.includes("daily_big_data.augment_lineup_signal"), "augment mode must receive augment_lineup_signal as selected evidence");
  assert(selectedContextContract.evidence_boundary?.icon_matcher_role?.includes("fallback"), "selected context contract must keep icon matcher as fallback/conflict evidence");
  assert(selectedContextContract.evidence_boundary?.host_multimodal_role?.includes("outside_active_choice_intake"), "selected context contract must exclude host multimodal from active choice intake");
  assert(selectedContextContract.evidence_boundary?.host_multimodal_role?.includes("not_hot_path_default"), "selected context contract must keep host multimodal off the hot path");
  assert(selectedContextContract.missing_fact_policy?.newer_user_intent_overrides_older_conflicting_memory === true, "selected context contract must prefer newer user intent");
  assert(serviceText.includes('contract.candidate_input_policy === "current_match_user_report"'), "choice mode must be registered from its current-match user-report contract");
  assert(serviceText.includes('status: "mode_set_choice_ready_for_user_report"'), "choice mode entry must wait for a user report instead of starting sensing");
  assert(serviceText.includes("manualReportChoiceRuntimeModes.has(trigger.mode)"), "automatic phase handling must stop before compatibility choice sensing for user-report modes");
  assert(serviceText.includes("cancelled_by_new_match"), "startMatch must cancel stale response tasks from the previous match");

  const userPreferences = await readJson(".omx/state/jcc-runtime-user-settings.json");
  const activeProfile = await readJson("data/game-knowledge/jcc/active-profile.json");
  const overlay = await readJson(`data/game-knowledge/jcc/${activeProfile.runtime_catalog_overlay_path}`);
  const dailyBigData = {
    schema: "jcc-live-rankings-host-context-summary-v1",
    available: false,
    ranking_overlay_id: null,
    unavailable_reason: "active_core_profile_has_no_compatible_ranking_overlay",
    stat_date: null,
    tiers: {},
  };
  const seasonCatalog = summarizeSeasonCatalog(overlay, {
    season_id: activeProfile.season_id,
    active_patch_id: activeProfile.patch_id,
  });

  assert(activeProfile.season_id === "s18" && activeProfile.patch_id === "s18_2", "verification requires the promoted S18.2 Core Profile");
  assert(seasonCatalog.active_season === activeProfile.season_id, "season catalog must be selected by the active Core Profile");
  assert(seasonCatalog.active_patch_id === activeProfile.patch_id, "season catalog patch must match the active Core Profile");

  const cases = [
    {
      label: "minimal_daily_greeting",
      request: buildRequest({ mode: "daily_chat", userMessage: "你好", contract, userPreferences, dailyBigData, seasonCatalog }),
      expectPreferences: false,
      expectRankings: false,
      expectSeasonCatalog: false,
      expectStrategyWiki: false,
    },
    {
      label: "minimal_daily_greeting_with_context_pack_sources",
      request: buildRequest({ mode: "daily_chat", userMessage: "你好", contract, userPreferences, dailyBigData, seasonCatalog }),
      mutate(request) {
        request.context_pack = {
          scope: "mode",
          mode_id: "daily_chat",
          strategy_data_sources: { hard_data: { manifest: { exists: true } } },
        };
        request.runtime_context.context_policy = resolvePolicy(request, contract);
        assert(request.runtime_context.context_policy.reason === "minimal_runtime_context_only", "context_pack strategy_data_sources must not trigger heavy host context by itself");
      },
      expectPreferences: false,
      expectRankings: false,
      expectSeasonCatalog: false,
      expectStrategyWiki: false,
    },
    {
      label: "daily_strategy_question",
      request: buildRequest({ mode: "daily_chat", userMessage: "聊一下当前上分思路。", contract, userPreferences, dailyBigData, seasonCatalog }),
      expectPreferences: true,
      expectRankings: true,
      expectSeasonCatalog: true,
      expectStrategyWiki: true,
    },
    {
      label: "daily_lineup_members_question",
      request: buildRequest({ mode: "daily_chat", userMessage: "围绕奥恩、洛和霞，给我阵容成员具体名称。", contract, userPreferences, dailyBigData, seasonCatalog }),
      expectPreferences: true,
      expectRankings: true,
      expectSeasonCatalog: true,
      expectStrategyWiki: true,
    },
    {
      label: "generic_low_cost_lineup_question",
      request: buildRequest({ mode: "daily_chat", userMessage: "给我一套2费赌狗阵容，直接说阵容成员。", contract, userPreferences, dailyBigData, seasonCatalog }),
      expectPreferences: true,
      expectRankings: true,
      expectSeasonCatalog: true,
      expectStrategyWiki: true,
    },
    {
      label: "lineup_followup_members_only",
      request: buildRequest({ mode: "daily_chat", userMessage: "给我阵容成员就行。", contract, userPreferences, dailyBigData, seasonCatalog }),
      expectPreferences: true,
      expectRankings: true,
      expectSeasonCatalog: true,
      expectStrategyWiki: true,
    },
    {
      label: "lineup_followup_specific_names",
      request: buildRequest({ mode: "daily_chat", userMessage: "给我阵容成员就行其他成员呢？具体名称给我。", contract, userPreferences, dailyBigData, seasonCatalog }),
      expectPreferences: true,
      expectRankings: true,
      expectSeasonCatalog: true,
      expectStrategyWiki: true,
    },
    {
      label: "generic_champion_cost_question",
      request: buildRequest({ mode: "daily_chat", userMessage: "这个英雄现在是几费？能不能放进低费阵容？", contract, userPreferences, dailyBigData, seasonCatalog }),
      expectPreferences: true,
      expectRankings: true,
      expectSeasonCatalog: true,
      expectStrategyWiki: true,
    },
    {
      label: "generic_trait_lineup_question",
      request: buildRequest({ mode: "daily_chat", userMessage: "按当前赛季羁绊给我拼一套上分阵容。", contract, userPreferences, dailyBigData, seasonCatalog }),
      expectPreferences: true,
      expectRankings: true,
      expectSeasonCatalog: true,
      expectStrategyWiki: true,
    },
    {
      label: "augment_mode",
      request: buildRequest({ mode: "augment_choice", userMessage: "选哪个，要不要刷新？", contract, userPreferences, dailyBigData, seasonCatalog }),
      expectPreferences: true,
      expectRankings: true,
      expectSeasonCatalog: true,
      expectStrategyWiki: true,
    },
    {
      label: "user_preferences_mode",
      request: buildRequest({ mode: "user_preferences", userMessage: "保存我的默认目标。", contract, userPreferences, dailyBigData, seasonCatalog }),
      expectPreferences: true,
      expectRankings: false,
      expectSeasonCatalog: false,
      expectStrategyWiki: false,
    },
    {
      label: "evidence_forces_strategy_context",
      request: buildRequest({
        mode: "daily_chat",
        userMessage: "看看这个。",
        contract,
        userPreferences,
        dailyBigData,
        seasonCatalog,
        context: { strategy_context: { source: "verify" } },
      }),
      expectPreferences: true,
      expectRankings: true,
      expectSeasonCatalog: true,
      expectStrategyWiki: true,
    },
  ];

  for (const testCase of cases) {
    const { request, label } = testCase;
    if (testCase.mutate) testCase.mutate(request);
    assert(contract.required_runtime_reason_values.includes(request.runtime_context.context_policy.reason), `${label} has invalid policy reason`);
    if (testCase.expectPreferences) assertAttached(request, "user_preferences", label);
    else assertNotAttached(request, "user_preferences", label);
    if (testCase.expectRankings) assertAttached(request, "daily_big_data", label);
    else assertNotAttached(request, "daily_big_data", label);
    if (testCase.expectSeasonCatalog) assertAttached(request, "season_catalog", label);
    else assertNotAttached(request, "season_catalog", label);
    if (testCase.expectStrategyWiki) assertAttached(request, "strategy_wiki_context", label);
    else assertNotAttached(request, "strategy_wiki_context", label);
  }

  const lineupRequest = cases.find((testCase) => testCase.label === "daily_lineup_members_question").request;
  assert(lineupRequest.season_catalog.policy.current_season_only === true, "lineup request must carry current-season-only catalog policy");
  assert(lineupRequest.season_catalog.champion_count > 40, "season catalog must carry full current-season champion pool");
  for (const name of ["奥恩", "洛", "霞"]) {
    const champion = championByName(lineupRequest.season_catalog, name);
    assert(champion, `season catalog should include requested current-season champion: ${name}`);
    assert(champion.cost === 1, `${name} should be 1-cost in the active S18 catalog`);
  }
  const shen = championByName(lineupRequest.season_catalog, "慎");
  assert(shen?.cost === 2, "season catalog should expose 慎 as an S18 2-cost champion");
  for (const trait of ["地狱火", "护卫"]) {
    assert(shen?.traits?.includes(trait), `season catalog should expose 慎 trait: ${trait}`);
  }
  for (const oldName of ["潘森", "古拉加斯", "派克"]) {
    assert(!championByName(lineupRequest.season_catalog, oldName), `old/non-current champion must not be available for lineup generation: ${oldName}`);
  }

  const strategyCase = cases.find((testCase) => testCase.label === "daily_strategy_question");
  assert(strategyCase?.request?.daily_big_data, "daily strategy question case must include big-data context");
  assert(strategyCase?.request?.season_catalog, "daily strategy question case must include season catalog");
  assert(strategyCase.request.user_preferences.rank_tier, "strategy request must carry user_preferences.rank_tier");
  assert(strategyCase.request.daily_big_data.available === false, "strategy request must explicitly report compatible rankings unavailable");
  assert(strategyCase.request.daily_big_data.ranking_overlay_id === null, "unavailable rankings must not expose a stale overlay identity");
  assert(Boolean(strategyCase.request.daily_big_data.unavailable_reason), "unavailable rankings must carry an explicit reason");
  assert(strategyCase.request.daily_big_data.stat_date === null, "unavailable rankings must not expose a foreign stat_date");
  assert(Object.keys(strategyCase.request.daily_big_data.tiers || {}).length === 0, "unavailable rankings must not fall back to old-season tier signals");
  const compactDailyBigData = sanitizeDailyBigDataForHostTest(strategyCase.request.daily_big_data);
  assert(compactDailyBigData.available === false, "final compact INPUT_JSON must preserve ranking-unavailable status");
  assert(Object.keys(compactDailyBigData.tiers || {}).length === 0, "final compact INPUT_JSON must not synthesize ranking candidates");
  const xayahRequest = buildRequest({ mode: "daily_chat", userMessage: "给我一个霞主C的阵容图", contract, userPreferences, dailyBigData, seasonCatalog });
  const xayahCandidates = selectedRankingCandidatesForTest(xayahRequest);
  assert(xayahCandidates.query_terms.includes("霞"), "carry-specific lineup request must include requested carry name as a query term");
  assert(xayahCandidates.query_terms.includes("1509"), "carry-specific lineup request must include the active S18 catalog id hint");
  assert(xayahCandidates.candidates.length === 0, "ranking selection must stay empty while the active Core Profile has no compatible overlay");
  const confirmedAugmentRequest = buildRequest({
    mode: "cruise",
    userMessage: "给我下一步运营建议",
    contract,
    userPreferences,
    dailyBigData,
    seasonCatalog,
    context: {
      runtime_context: {
        match_facts: {
          choice_confirmations: [{ kind: "augment", stage_round: "2-1", selected: "活体锻炉" }],
        },
      },
    },
  });
  assert(
    collectRankingQueryTerms(confirmedAugmentRequest).includes(normalizeSearchText("活体锻炉")),
    "confirmed augment must enter production ranking query terms for its semantic follow-up",
  );

  const itemization = await runJsonTool(["tools/build-jcc-itemization-context.mjs", "--champion", "伊泽瑞尔", "--max-per-group", "2"]);
  assert(itemization.schema === "jcc-itemization-context-v1", "itemization context builder should emit schema");
  assert(itemization.active_season === activeProfile.season_id, "itemization context must use the active Core Profile major season id");
  assert(itemization.active_patch_id === activeProfile.patch_id, "itemization context must use the active Core Profile patch id");
  assert(itemization.contract.source_precedence[0] === "trusted_mumu_4357_item_bench_and_4356_to_4353_assignment", "itemization context must prefer trusted structured MuMu equipment");
  assert(itemization.contract.source_precedence[1] === "current_match_explicit_user_confirmation", "itemization context must prefer user confirmation over visual fallback");
  assert(itemization.contract.decision_actions.includes("wait_component"), "itemization context should support wait_component");
  assert(itemization.core_profile_id === activeProfile.core_profile_id, "itemization context must bind the active S18 Core Profile");
  assert(["unavailable", "available_as_soft_prior"].includes(itemization.candidate_scope?.ranking_evidence),
    "itemization context must explicitly classify Ranking evidence as unavailable or soft prior");
  assert(itemization.champion_context?.artifact_candidates?.length > 0, "itemization context should include artifact candidates");
  assert(itemization.champion_context?.radiant_candidates?.length > 0, "itemization context should include radiant candidates");
  for (const candidate of [
    ...(itemization.champion_context?.completed_candidates || []),
    ...(itemization.champion_context?.artifact_candidates || []),
    ...(itemization.champion_context?.radiant_candidates || []),
  ]) {
    assert(candidate.item_id && candidate.item_name, "itemization candidates must expose active hard-data identity to the Host");
    assert(candidate.fit_score > 0 && candidate.fit_reasons?.length > 0, "itemization candidates must retain deterministic hard-data fit evidence");
    assert(candidate.tags?.length > 0, "itemization candidates must retain active hard-data tags");
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-host-request-runtime-context-verification-v1",
    checked_cases: cases.map((testCase) => ({
      label: testCase.label,
      policy: testCase.request.runtime_context.context_policy,
    })),
    lineup_catalog_sample: {
      requested_core: ["奥恩", "洛", "霞"].map((name) => championByName(seasonCatalog, name)),
      sentinel_non_current_names: ["潘森", "古拉加斯", "派克"].map((name) => ({
        name,
        present: Boolean(championByName(seasonCatalog, name)),
      })),
      shen: championByName(seasonCatalog, "慎"),
    },
    strategy_context_sample: {
      user_preferences: strategyCase.request.user_preferences,
      daily_big_data: {
        available: strategyCase.request.daily_big_data.available,
        unavailable_reason: strategyCase.request.daily_big_data.unavailable_reason,
        tier_count: Object.keys(strategyCase.request.daily_big_data.tiers).length,
      },
      season_catalog: {
        champion_count: strategyCase.request.season_catalog.champion_count,
        trait_count: strategyCase.request.season_catalog.trait_count,
      },
    },
    selected_ranking_candidate_sample: {
      query_terms: xayahCandidates.query_terms,
      candidate_count: xayahCandidates.candidates.length,
      first_candidate: xayahCandidates.candidates[0] || null,
    },
    itemization_context_sample: {
      champion_name: itemization.champion_context?.champion_name || null,
      artifact_count: itemization.champion_context?.artifact_candidates?.length || 0,
      radiant_count: itemization.champion_context?.radiant_candidates?.length || 0,
      decision_actions: itemization.contract.decision_actions,
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
