import { createHash } from "node:crypto";
import path from "node:path";
import {
  CURRENT_DAY_RANKING_SOURCE,
  CURRENT_DAY_SAMPLE_AUTHORITY,
  evaluateRankingStrength,
} from "./jcc_ranking_strength_evaluator.mjs";
import { evaluateRankingCurrentness } from "./jcc_ranking_currentness_evaluator.mjs";
import { normalizeLiveRankingTraitTrendKey } from "./jcc_live_rankings_history.mjs";
import { buildRankingRecipeAuxiliaryRegistry } from "./jcc_live_rankings_recipe_sources.mjs";
import { compileRankingSemanticFeaturePacket } from "../ui/electron/semantic-feature-layer.js";
import { evaluateLineupFeasibility } from "./jcc-lineup-feasibility-engine.mjs";
import { buildCanonicalLineupIdentity } from "./jcc_canonical_lineup_identity.mjs";
import { parseTypedMetrics } from "./jcc_typed_effect_parser.mjs";
import { compareAtomicVariants } from "./jcc_atomic_variant_comparator.mjs";
import {
  buildRankingRecipeFreshnessProfile,
  recipeFreshnessAllowsAutomaticPairing,
  recipeFreshnessRequiresHighConfidence,
} from "./jcc_ranking_recipe_freshness.mjs";
import {
  NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA,
  normalizeRankingRecipeStorage,
} from "./jcc_ranking_recipe_storage.mjs";

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRate(value) {
  const parsed = finiteNumber(value);
  if (parsed === null) return null;
  return parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizedPopulationCost(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : 1;
}

function normalizedTraitContributions(values) {
  return firstArray(values).map((entry) => ({
    trait_id: String(entry?.trait_id || entry?.id || "").trim(),
    trait_name: entry?.trait_name || entry?.name || null,
    value: finiteNumber(entry?.value ?? entry?.count ?? 1),
  })).filter((entry) => entry.trait_id && entry.value !== null && entry.value > 0);
}

function stableHash(value, length = 24) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);
}

function atomicRosterId(candidateId, semanticMembers) {
  return `atomic:${stableHash({
    candidate_id: candidateId,
    members: firstArray(semanticMembers).map((member) => member?.source_semantic_identity || member),
  })}`;
}

function candidateEvidenceId(candidateId, variant) {
  const matureVariants = firstArray(variant?.mature_recipe_variants);
  const evidence = {
    candidate_id: candidateId || null,
    variant_id: variant?.variant_id || null,
    atomic_roster_id: variant?.atomic_roster_id || null,
    atomic_roster_members: firstArray(variant?.atomic_roster_members).map((unit) => ({
      entity_kind: unit?.entity_kind || null,
      champion_id: unit?.champion_id || null,
      source_semantic_identity: unit?.source_semantic_identity || null,
      occupies_population: unit?.occupies_population === true,
    })),
    statistics: variant?.atomic_roster_statistics || null,
    difference: variant?.atomic_variant_difference || null,
    canonical_identity: variant?.canonical_lineup_identity || null,
    recipe_refs: matureVariants.map((recipe) => ({
      recipe_id: recipe?.recipe_id || null,
      classification: recipe?.classification || null,
      source_role: recipe?.source_role || null,
    })),
  };
  return `evidence:${createHash("sha256").update(JSON.stringify(evidence)).digest("hex").slice(0, 32)}`;
}

function atomicRosterStatistics(row, statDate) {
  const metric = (value) => finiteNumber(value);
  return {
    schema: "jcc-national-atomic-roster-statistics-v1",
    source: CURRENT_DAY_RANKING_SOURCE,
    stat_date: statDate || null,
    metrics_scope: "trait_group_minor_traits_datas_atomic_roster_row",
    denominator_definition: "source_row_current_day_master_plus_roster_observations",
    use_num: metric(row?.use_num),
    use_rate: normalizeRate(row?.use_rate),
    top1_rate: normalizeRate(row?.top_1_rate ?? row?.top1_rate ?? row?.win_rate),
    top4_rate: normalizeRate(row?.top_4_rate ?? row?.top4_rate ?? row?.top_four_rate),
    avg_rank: metric(row?.avg_rank ?? row?.average_rank),
    authority: "atomic_roster_source_row_only_not_trait_strength_or_recipe_metrics",
  };
}

function entityIds(values) {
  return uniqueStrings((Array.isArray(values) ? values : []).map((value) => (
    value && typeof value === "object"
      ? value.equip_id ?? value.item_id ?? value.id ?? null
      : value
  )));
}

function entityLookup(entries = [], { championAliases = false } = {}) {
  const lookup = new Map();
  for (const entry of entries || []) {
    const id = String(entry?.id || "").trim();
    if (!id) continue;
    const normalized = {
      ...entry,
      id,
      name: entry?.normalized_name || entry?.name || null,
      cost: finiteNumber(entry?.cost),
      type: entry?.type || null,
      tags: Array.isArray(entry?.tags) ? entry.tags : [],
      primary_role: entry?.primary_role || null,
      role: entry?.role || entry?.supplemental_source?.role || null,
      role_key: entry?.role_key || entry?.supplemental_source?.role_key || null,
      attributes_by_star: entry?.attributes_by_star || null,
      skill: entry?.skill || null,
    };
    lookup.set(id, normalized);
    if (championAliases) {
      const withoutPoolPrefix = id.replace(/^\d(?=\d{4}$)/, "");
      if (withoutPoolPrefix && !lookup.has(withoutPoolPrefix)) lookup.set(withoutPoolPrefix, normalized);
    }
  }
  return lookup;
}

function entityName(lookup, id) {
  return lookup.get(String(id || ""))?.name || null;
}

function metricPacket(row = {}) {
  return {
    avg_rank: finiteNumber(row.avg_rank),
    top1_rate: normalizeRate(row.top_1_rate ?? row.top1_rate),
    top4_rate: normalizeRate(row.top_4_rate ?? row.top4_rate),
    use_rate: normalizeRate(row.use_rate ?? row.user_rate),
    use_num: finiteNumber(row.use_num ?? row.use_count),
  };
}

function nodeMetricPacket(row = {}) {
  return {
    avg_rank: finiteNumber(row.node1_avg_rank ?? row.avg_rank),
    top1_rate: normalizeRate(row.node1_top1_rate ?? row.top_1_rate ?? row.top1_rate),
    top4_rate: normalizeRate(row.node1_top4_rate ?? row.top_4_rate ?? row.top4_rate),
    use_rate: normalizeRate(row.node1_use_rate ?? row.use_rate ?? row.user_rate),
    use_num: finiteNumber(row.node1_use_num ?? row.use_num ?? row.use_count),
  };
}

function sampleBand(sampleSize) {
  if (!Number.isFinite(sampleSize) || sampleSize <= 0) return "unknown";
  if (sampleSize >= 250) return "large";
  if (sampleSize >= 100) return "medium";
  if (sampleSize >= 30) return "small";
  return "tiny";
}

function qualityPacket(metrics) {
  const sampleSize = metrics.use_num;
  const sample = sampleBand(sampleSize);
  const support = sample === "large" ? 1 : sample === "medium" ? 0.7 : sample === "small" ? 0.5 : sample === "tiny" ? 0.3 : 0.2;
  const rankScore = metrics.avg_rank === null ? 0.5 : Math.max(0, Math.min(1, 1 - (metrics.avg_rank - 1) / 7));
  const floorScore = Math.max(0, Math.min(1,
    (metrics.top4_rate ?? 0.5) * 0.58 + rankScore * 0.27 + support * 0.15,
  ));
  const ceilingScore = Math.max(0, Math.min(1,
    (metrics.top1_rate ?? 0.12) * 0.72 + (metrics.top4_rate ?? 0.5) * 0.13 + support * 0.15,
  ));
  const popularityScore = Math.max(0, Math.min(1,
    (metrics.use_rate ?? 0) / 0.08 * 0.65 + support * 0.35,
  ));
  const stableMainline = sample === "large"
    && (metrics.top4_rate ?? 0) >= 0.55
    && (metrics.avg_rank ?? 8) <= 4.8;
  const highCeiling = (metrics.top1_rate ?? 0) >= 0.22;
  return {
    sample_size: sampleSize,
    sample_band: sample,
    confidence_score: Number(support.toFixed(3)),
    floor_score: Number(floorScore.toFixed(3)),
    ceiling_score: Number(ceilingScore.toFixed(3)),
    popularity_score: Number(popularityScore.toFixed(3)),
    classification: stableMainline
      ? highCeiling ? "stable_high_ceiling" : "stable_top_four_line"
      : highCeiling ? "conditional_high_ceiling" : sample === "small" || sample === "medium"
        ? "promising_needs_entry_validation"
        : "insufficient_evidence",
    caveats: [
      sample === "tiny" || sample === "small" ? "low_sample_can_overstate_results" : null,
      highCeiling && !stableMainline ? "high_ceiling_is_not_stable_mainline" : null,
      (metrics.top4_rate ?? 0) >= 0.6 && (metrics.top1_rate ?? 1) < 0.12
        ? "high_floor_lower_observed_first_place_conversion"
        : null,
    ].filter(Boolean),
  };
}

function traitFamilyId(traitId) {
  const value = String(traitId || "").trim();
  if (!value) return null;
  return value.length >= 6 ? value.slice(0, 6) : value;
}

function traitBreakpoint(row = {}) {
  return finiteNumber(row.hero_num ?? row.chess_num ?? row.count ?? row.breakpoint);
}

function normalizeTraitRows(rows = []) {
  const byFamily = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const traitId = String(row?.trait_id || "").trim();
    const family_id = traitFamilyId(traitId);
    const breakpoint = traitBreakpoint(row);
    if (!family_id || breakpoint === null) continue;
    const existing = byFamily.get(family_id);
    if (!existing || breakpoint > existing.breakpoint) {
      byFamily.set(family_id, { trait_id: traitId, family_id, breakpoint });
    }
  }
  return [...byFamily.values()].sort((left, right) => left.family_id.localeCompare(right.family_id));
}

function traitSignature(rows = []) {
  const traits = normalizeTraitRows(rows);
  return {
    key: traits.map((trait) => `${trait.family_id}:${trait.breakpoint}`).join("|"),
    families_key: traits.map((trait) => trait.family_id).join("|"),
    trait_count: traits.length,
    traits,
  };
}

function sourceSemanticTraitSignature(rows = []) {
  const traits = firstArray(rows).map((row) => {
    if (row?.source_dictionary_status !== "resolved_official_frontend_dictionary") return null;
    const canonicalTraitId = String(row?.canonical_trait_id || row?.check_id || "").trim();
    const breakpoint = traitBreakpoint(row);
    if (!canonicalTraitId || breakpoint === null) return null;
    return {
      canonical_trait_id: canonicalTraitId,
      trait_name: row?.source_trait_text || row?.trait_name || null,
      breakpoint,
      source_dictionary_status: row?.source_dictionary_status || null,
    };
  }).filter(Boolean).sort((left, right) => (
    left.canonical_trait_id.localeCompare(right.canonical_trait_id)
    || left.breakpoint - right.breakpoint
  ));
  if (!traits.length) return null;
  return {
    schema: "jcc-ranking-source-semantic-trait-signature-v1",
    key: traits.map((trait) => `${trait.canonical_trait_id}:${trait.breakpoint}`).join("|"),
    display_key: traits.map((trait) => `${trait.trait_name || trait.canonical_trait_id}${trait.breakpoint}`).join(" + "),
    traits,
    authority: "official_frontend_dictionary_translated_to_current_core_trait_ids",
  };
}

function combinedVariantTraits(variant = {}) {
  return [
    ...(Array.isArray(variant.main_trait_group) ? variant.main_trait_group : []),
    ...(Array.isArray(variant.sub_trait_list) ? variant.sub_trait_list : []),
  ];
}

function traitName(catalogs, traitId) {
  return entityName(catalogs.traits, traitId);
}

function rankingSnapshotTraitFamilyIds(tierData) {
  const familyIds = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if ((key === "trait_id" || key === "family_id") && /^\d{6,8}$/.test(String(entry))) {
        const raw = String(entry);
        familyIds.add(raw.length === 8 ? raw.slice(0, 6) : raw);
      } else {
        visit(entry);
      }
    }
  };
  visit(tierData);
  return [...familyIds].sort();
}


function canonicalTraitRows(identity) {
  return firstArray(identity?.active_traits).map((trait) => ({
    trait_id: trait.trait_id,
    canonical_trait_id: trait.trait_id,
    trait_name: trait.trait_name,
    breakpoint: trait.count,
    count: trait.count,
    active_breakpoint: trait.active_breakpoint,
    next_breakpoint: trait.next_breakpoint,
    identity_authority: "current_core_roster_derived_semantics",
  }));
}

function traitBreakpointRows(trait) {
  return [...new Set([
    ...firstArray(trait?.num_list).map(finiteNumber),
    ...firstArray(trait?.breakpoints).map((row) => finiteNumber(row?.count ?? row?.level)),
  ].filter((value) => Number.isFinite(value) && value > 0))].sort((left, right) => left - right);
}

function sourceTraitSignatures(primary, secondary) {
  const byId = new Map();
  for (const signature of [primary, secondary]) {
    for (const trait of firstArray(signature?.traits)) {
      const traitId = String(trait?.canonical_trait_id || trait?.trait_id || "").trim();
      const breakpoint = finiteNumber(trait?.breakpoint ?? trait?.count);
      if (!traitId || breakpoint === null) continue;
      byId.set(traitId, {
        ...trait,
        canonical_trait_id: traitId,
        breakpoint,
        trait_name: trait?.trait_name || null,
      });
    }
  }
  const traits = [...byId.values()].sort((left, right) => (
    left.canonical_trait_id.localeCompare(right.canonical_trait_id)
    || left.breakpoint - right.breakpoint
  ));
  if (!traits.length) return null;
  return {
    schema: "jcc-ranking-source-semantic-trait-signature-v1",
    key: traits.map((trait) => `${trait.canonical_trait_id}:${trait.breakpoint}`).join("|"),
    display_key: traits.map((trait) => `${trait.trait_name || trait.canonical_trait_id}${trait.breakpoint}`).join(" + "),
    traits,
    authority: "official_frontend_dictionary_translated_to_current_core_trait_ids",
  };
}

function reconcileSourceTraitState(identity, sourceSignature) {
  const derivedById = new Map(firstArray(identity?.observed_traits)
    .map((trait) => [String(trait?.trait_id || "").trim(), trait]));
  const unresolvedContributionGaps = [];
  const rosterDerivedExcesses = [];
  const sourceRows = firstArray(sourceSignature?.traits).map((source) => {
    const traitId = String(source?.canonical_trait_id || source?.trait_id || "").trim();
    const sourceDeclaredCount = finiteNumber(source?.breakpoint ?? source?.count);
    const derived = derivedById.get(traitId);
    const rosterDerivedCount = finiteNumber(derived?.count) ?? 0;
    const difference = sourceDeclaredCount !== null ? sourceDeclaredCount - rosterDerivedCount : 0;
    const row = {
      trait_id: traitId,
      trait_name: source?.trait_name || derived?.trait_name || null,
      source_declared_count: sourceDeclaredCount,
      roster_derived_count: rosterDerivedCount,
      difference,
      source_authority: "current_ranking_strength_anchor",
      derived_authority: "current_core_roster_and_special_contributions",
    };
    if (difference > 0) unresolvedContributionGaps.push({
      trait_id: row.trait_id,
      trait_name: row.trait_name,
      source_declared_count: row.source_declared_count,
      roster_derived_count: row.roster_derived_count,
      missing_contribution: difference,
    });
    if (difference < 0) rosterDerivedExcesses.push({
      trait_id: row.trait_id,
      trait_name: row.trait_name,
      source_declared_count: row.source_declared_count,
      roster_derived_count: row.roster_derived_count,
      excess_contribution: Math.abs(difference),
    });
    return row;
  });
  return {
    schema: "jcc-ranking-trait-state-reconciliation-v1",
    status: unresolvedContributionGaps.length
      ? "source_declaration_requires_unmodeled_contribution"
      : rosterDerivedExcesses.length
        ? "roster_exceeds_source_declaration"
        : "reconciled",
    source_authority: "current_ranking_strength_anchor",
    roster_authority: "current_core_roster_and_special_contributions",
    source_traits: sourceRows,
    unresolved_contribution_gaps: unresolvedContributionGaps,
    roster_derived_excesses: rosterDerivedExcesses,
    policy: "preserve_source_strength_state_for_ranking_identity; never infer an unobserved emblem_or_bonus_as_roster_fact",
  };
}

function explainSourceTraitGapsWithRecipeEmblems(reconciliation, recipe, resolvedMembers, catalogs) {
  const gaps = firstArray(reconciliation?.unresolved_contribution_gaps);
  if (!gaps.length || !["winning_recipe", "popular_recipe"].includes(recipe?.source_role)) return reconciliation;
  const holders = new Map(resolvedMembers.map((member) => [
    String(member?.resolution?.champion_id || ""), member?.resolution,
  ]).filter(([id]) => id));
  const emblemEvidence = firstArray(recipe.item_assignments).flatMap((assignment) => {
    const holderId = String(assignment?.holder_id || "");
    const holder = holders.get(holderId);
    if (!holder) return [];
    const naturalIdentity = buildCanonicalLineupIdentity({
      championIds: [holderId],
      champions: catalogs.champions,
      traits: catalogs.traits,
      traitContributions: holder.additional_trait_contributions,
    });
    return firstArray(assignment.item_ids).flatMap((itemId) => {
      const item = catalogs.items.get(String(itemId || ""));
      const grantedTrait = resolveGrantedTrait(item, catalogs);
      if (!grantedTrait || naturalIdentity.observed_traits.some((trait) => trait.trait_id === grantedTrait.trait_id)) return [];
      return [{
        item_id: String(itemId),
        item_name: item.name,
        holder_id: holderId,
        holder_name: entityName(catalogs.champions, holderId),
        granted_trait_id: grantedTrait.trait_id,
        granted_trait_name: grantedTrait.trait_name,
        granted_trait_resolution: grantedTrait.resolution,
        source_role: recipe.source_role,
        recipe_id: recipe.recipe_id,
      }];
    });
  });
  const explained = [];
  const unresolved = [];
  for (const gap of gaps) {
    const matching = emblemEvidence.filter((entry) => entry.granted_trait_id === gap.trait_id);
    if (matching.length === gap.missing_contribution) {
      explained.push({ ...gap, evidence: matching });
    } else {
      unresolved.push(gap);
    }
  }
  if (!explained.length) return reconciliation;
  return {
    ...reconciliation,
    status: unresolved.length ? reconciliation.status
      : firstArray(reconciliation.roster_derived_excesses).length ? "roster_exceeds_source_declaration"
        : "source_declaration_explained_by_recipe_emblems",
    explained_contribution_gaps: explained,
    unresolved_contribution_gaps: unresolved,
    policy: "Exact current-recipe emblems explain one way to reach the source breakpoint for this roster; the observed holder is evidence, not an exclusive holder requirement or a rewrite of Core traits or strength.",
  };
}

function publishedTraitRows(identity, sourceSignature, traits) {
  const rows = canonicalTraitRows(identity);
  const byId = new Map(rows.map((row) => [String(row.trait_id || ""), row]));
  for (const source of firstArray(sourceSignature?.traits)) {
    const traitId = String(source?.canonical_trait_id || source?.trait_id || "").trim();
    const sourceCount = finiteNumber(source?.breakpoint ?? source?.count);
    if (!traitId || sourceCount === null) continue;
    const row = byId.get(traitId) || {
      trait_id: traitId,
      canonical_trait_id: traitId,
      trait_name: source?.trait_name || null,
      breakpoint: sourceCount,
      count: sourceCount,
      active_breakpoint: sourceCount,
      next_breakpoint: null,
      identity_authority: "current_ranking_strength_anchor",
    };
    const trait = traits instanceof Map ? traits.get(traitId) : null;
    const breakpoints = traitBreakpointRows(trait);
    const derivedCount = finiteNumber(row.count) ?? 0;
    row.trait_name = row.trait_name || source?.trait_name || null;
    row.breakpoint = sourceCount;
    row.count = sourceCount;
    row.active_breakpoint = [...breakpoints].reverse().find((value) => value <= sourceCount) ?? sourceCount;
    row.next_breakpoint = breakpoints.find((value) => value > sourceCount) ?? null;
    row.identity_authority = "current_ranking_strength_anchor_reconciled_with_current_core";
    if (derivedCount !== sourceCount) row.roster_derived_count = derivedCount;
    byId.set(traitId, row);
  }
  return [...byId.values()].sort((left, right) => (
    Number(right.active_breakpoint !== null) - Number(left.active_breakpoint !== null)
    || Number(right.count || 0) - Number(left.count || 0)
    || String(left.trait_name || "").localeCompare(String(right.trait_name || ""), "zh-CN")
    || String(left.trait_id).localeCompare(String(right.trait_id))
  ));
}

function publishedTraitSignature(identity, sourceSignature, traits) {
  const rows = publishedTraitRows(identity, sourceSignature, traits);
  return {
    schema: "jcc-ranking-published-trait-signature-v1",
    key: rows.map((row) => `${row.trait_id}:${row.count}`).sort().join("|"),
    trait_count: rows.length,
    traits: rows,
    authority: "current_ranking_strength_anchor_reconciled_with_current_core_roster",
  };
}

function canonicalTraitSignature(identity) {
  const traits = canonicalTraitRows(identity);
  return {
    schema: "jcc-canonical-trait-signature-v1",
    key: String(identity?.key || ""),
    trait_count: traits.length,
    traits,
    authority: "current_core_roster_derived_semantics",
  };
}

function buildTraitDetailLookup(traitDetails = []) {
  const lookup = new Map();
  for (const detail of Array.isArray(traitDetails) ? traitDetails : []) {
    const signature = traitSignature(detail?.main_traits);
    if (signature.key) lookup.set(signature.key, detail?.data || null);
  }
  return lookup;
}

function buildTraitGroupLookup(traitGroups = []) {
  const lookup = new Map();
  for (const group of Array.isArray(traitGroups) ? traitGroups : []) {
    const signature = traitSignature(group?.main_traits);
    if (signature.key) lookup.set(signature.key, group?.data || null);
  }
  return lookup;
}

function buildStrengthAnchors(tierData, catalogs, statDate, trendSummary = null) {
  const detailsBySignature = buildTraitDetailLookup(tierData?.trait_details);
  const groupsBySignature = buildTraitGroupLookup(tierData?.trait_groups);
  const anchors = (Array.isArray(tierData?.main_trait_strength) ? tierData.main_trait_strength : [])
    .map((row) => {
      const signature = traitSignature(row?.main_traits);
      if (!signature.key) return null;
      const semanticSignature = sourceSemanticTraitSignature(row?.main_traits);
      if (!semanticSignature?.key) return null;
      const canonicalRosterSource = groupsBySignature.get(signature.key);
      const metrics = nodeMetricPacket(row);
      const variant = {
        anchor_id: `strength:${stableHash(semanticSignature)}`,
        source_anchor_id: `national:${signature.key}`,
        source_signature: signature,
        signature: semanticSignature,
        traits: semanticSignature.traits,
        metrics,
        trait_details: detailsBySignature.get(signature.key),
        canonical_roster_source: canonicalRosterSource,
        source_interpretation: "national_main_trait_strength_primary_lineup_strength_anchor",
      };
      return variant;
    })
    .filter(Boolean);
  if (!anchors.length) return [];
  const gradient = evaluateRankingStrength({
    current_day_rows: anchors.map((anchor) => ({
      candidate_id: anchor.anchor_id,
      stat_date: String(statDate || ""),
      source: CURRENT_DAY_RANKING_SOURCE,
      metrics: {
        top4_rate: anchor.metrics.top4_rate,
        avg_rank: anchor.metrics.avg_rank,
        top1_rate: anchor.metrics.top1_rate,
        use_rate: anchor.metrics.use_rate,
        sample_size: anchor.metrics.use_num ?? undefined,
        sample_size_authority: Number.isFinite(anchor.metrics.use_num)
          ? CURRENT_DAY_SAMPLE_AUTHORITY
          : undefined,
      },
    })),
  });
  const trendByKey = new Map((trendSummary?.tiers?.["0"]?.top_traits || [])
    .map((entry) => [normalizeLiveRankingTraitTrendKey(entry?.key), entry])
    .filter(([key]) => key));
  const currentness = evaluateRankingCurrentness({
    rows: gradient.rankings.map((ranking) => ({
      candidate_id: ranking.candidate_id,
      stat_date: ranking.stat_date,
      current_day_score: ranking.current_day_score,
      metrics: ranking.raw_current_day_metrics,
    })),
    trendByCandidate: Object.fromEntries(anchors.map((anchor) => [
      anchor.anchor_id,
      trendByKey.get(anchor.signature.key) || null,
    ])),
  });
  const currentnessByAnchor = new Map(currentness.profiles.map((profile) => [profile.candidate_id, profile]));
  const qualityByAnchor = new Map(gradient.rankings.map((ranking) => [ranking.candidate_id, {
    schema: gradient.schema,
    current_day_score: ranking.current_day_score,
    floor_score: ranking.floor_score,
    ceiling_score: ranking.ceiling_score,
    reliability_score: ranking.reliability_score,
    confidence_score: ranking.reliability_score,
    popularity_score: ranking.popularity?.score ?? null,
    sample_size: ranking.raw_current_day_metrics?.sample_size ?? null,
    sample_band: ranking.raw_current_day_metrics?.sample_size == null
      ? "unknown"
      : ranking.reliability_score >= 0.75
        ? "large"
        : ranking.reliability_score >= 0.5
          ? "medium"
          : ranking.reliability_score >= 0.3
            ? "small"
            : "tiny",
    sample_status: ranking.raw_current_day_metrics?.sample_size == null ? "unavailable" : "observed",
    currentness: currentnessByAnchor.get(ranking.candidate_id) || null,
    percentile: ranking.percentile,
    band: ranking.band,
    classification: ranking.classification,
    adjusted_metrics: ranking.adjusted_metrics,
    popularity: ranking.popularity,
    caveats: [
      ranking.adjusted_metrics?.sample_shrinkage_applied ? "authoritative_small_sample_shrinkage_applied" : null,
      ranking.raw_current_day_metrics?.sample_size == null ? "national_sample_size_missing_not_borrowed_from_recipe" : null,
    ].filter(Boolean),
    provenance: ranking.provenance,
  }]));
  return anchors
    .map((anchor) => {
      const trend = trendByKey.get(anchor.signature.key) || null;
      return {
        ...anchor,
        quality: qualityByAnchor.get(anchor.anchor_id),
        trend_evidence: trend ? {
          schema: "jcc-ranking-same-binding-trend-evidence-v1",
          observation_count: trend.observation_count,
          observations: trend.observations || [],
          first_stat_date: trend.first_stat_date,
          latest_stat_date: trend.latest_stat_date,
          deltas: trend.deltas,
          windows: trend.windows || null,
          consecutive: trend.consecutive || null,
          directions: trend.directions,
          binding_sha256: trendSummary.binding_sha256,
          role: "auxiliary_same_binding_context_only",
          may_affect_current_day_score: false,
          may_affect_current_day_order: false,
        } : {
          schema: "jcc-ranking-same-binding-trend-evidence-v1",
          observation_count: 1,
          observations: [{ stat_date: statDate, metrics: anchor.metrics }],
          first_stat_date: statDate,
          latest_stat_date: statDate,
          deltas: null,
          directions: null,
          binding_sha256: trendSummary?.binding_sha256 || null,
          role: "insufficient_history",
          may_affect_current_day_score: false,
          may_affect_current_day_order: false,
        },
      };
    })
    .sort((left, right) => right.quality.current_day_score - left.quality.current_day_score
      || left.anchor_id.localeCompare(right.anchor_id));
}

function identityTraitFamilies(group = {}) {
  return uniqueStrings([
    ...(Array.isArray(group?.main_trait_list) ? group.main_trait_list.map((row) => row?.trait_id) : []),
    ...(Array.isArray(group?.main_trait_list2) ? group.main_trait_list2 : []),
  ].map(traitFamilyId)).sort();
}

function publicStrengthAnchor(anchor) {
  if (!anchor) return null;
  return {
    anchor_id: anchor.anchor_id,
    source_anchor_id: anchor.source_anchor_id,
    signature: anchor.signature,
    traits: anchor.traits,
    metrics: anchor.metrics,
    quality: anchor.quality,
    trend_evidence: anchor.trend_evidence,
    trait_details: anchor.trait_details,
    source_interpretation: anchor.source_interpretation,
  };
}

function championCostMap(champions = []) {
  const out = new Map();
  for (const champion of champions || []) {
    const id = String(champion?.id || "").trim();
    const cost = finiteNumber(champion?.cost);
    if (!id || cost === null) continue;
    out.set(id, cost);
    if (/^\d{4}$/.test(id)) {
      for (const prefix of ["1", "2", "3", "4", "5"]) out.set(`${prefix}${id}`, cost);
    }
  }
  return out;
}

function compactPositionRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    chess_id: row?.chess_id ? String(row.chess_id) : null,
    x: finiteNumber(row?.position?.x),
    y: finiteNumber(row?.position?.y),
  })).filter((row) => row.chess_id && row.x !== null && row.y !== null);
}

const PRIMARY_TANK_ITEM_TAG_WEIGHTS = new Map([
  ["armor", 2],
  ["magic_resist", 2],
  ["damage_reduction", 2],
  ["shield", 1.5],
  ["tank", 2],
  ["frontline", 2],
  ["health", 0.5],
  ["healing", 0.5],
]);

function primaryTankFromPublishedSupport(supportCandidates, catalogs) {
  const ranked = (Array.isArray(supportCandidates) ? supportCandidates : [])
    .map((support) => {
      const itemIds = uniqueStrings(support?.item_ids);
      const defensiveScore = itemIds.reduce((score, itemId) => {
        const tags = catalogs.items.get(String(itemId || ""))?.tags || [];
        return score + tags.reduce((tagScore, tag) => (
          tagScore + (PRIMARY_TANK_ITEM_TAG_WEIGHTS.get(String(tag)) || 0)
        ), 0);
      }, 0);
      return { support, defensiveScore };
    })
    .sort((left, right) => right.defensiveScore - left.defensiveScore
      || String(left.support?.champion_id || "").localeCompare(String(right.support?.champion_id || "")));
  const best = ranked[0];
  if (!best || !uniqueStrings(best.support?.item_ids).length) return null;
  return {
    champion_id: best.support.champion_id || null,
    champion_name: best.support.champion_name || null,
    item_ids: uniqueStrings(best.support.item_ids),
    item_names: uniqueStrings(best.support.item_names),
    confidence: best.defensiveScore >= 5 ? "high" : best.defensiveScore >= 3 ? "medium" : "low",
    source_interpretation: best.defensiveScore >= 3
      ? "inferred_from_published_support_candidate_and_defensive_item_package"
      : "inferred_from_published_support_candidate_with_dedicated_item_package",
    evidence_boundary: "published_recipe_role_inference_not_explicit_upstream_main_tank_label",
  };
}

function explicitRequiredItemIds(row, role) {
  const prefixes = role === "main_carry"
    ? ["main_c_chess", "main_carry"]
    : ["assist_chess", "primary_tank", "main_tank"];
  return uniqueStrings(prefixes.flatMap((prefix) => [
    row?.[`${prefix}_required_equip`],
    row?.[`${prefix}_required_equips`],
    row?.[`${prefix}_must_equip`],
    row?.[`${prefix}_must_have_equip`],
    row?.[`required_${prefix}_equip`],
  ]).flatMap((value) => Array.isArray(value) ? value : value ? [value] : []));
}

function normalizedEntityLabel(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s·._\-—:：'"【】()[\]{}]+/g, "");
}

function resolveGrantedTrait(item, catalogs) {
  if (!item?.tags?.includes("emblem")) return null;
  const explicitTraitIds = uniqueStrings([
    item?.granted_trait_id,
    item?.grant_trait_id,
    item?.trait_id,
    item?.granted_trait?.id,
    item?.trait?.id,
  ]);
  const text = [item?.desc, item?.effect_block?.raw].filter(Boolean).join(" ");
  const explicitTraitNames = uniqueStrings([
    item?.granted_trait_name,
    item?.grant_trait_name,
    item?.granted_trait?.name,
    item?.trait?.name,
    text.match(/获得【([^】]+)】(?:特质|羁绊)/)?.[1],
    text.match(/\b(?:gain|gains|grant|grants)\s+(?:the\s+)?(.+?)\s+(?:trait|origin|class)\b/i)?.[1],
    String(item?.name || "").replace(/纹章$/, "").replace(/\s+(?:emblem|crest)$/i, "").trim(),
  ]);
  const traitRows = [...new Map([...catalogs.traits.values()]
    .map((trait) => [String(trait?.id || ""), trait])).values()];
  const matched = new Map();
  for (const traitId of explicitTraitIds) {
    const trait = catalogs.traits.get(traitId);
    if (trait) matched.set(trait.id, trait);
  }
  const normalizedNames = new Set(explicitTraitNames.map(normalizedEntityLabel).filter(Boolean));
  for (const trait of traitRows) {
    if (normalizedNames.has(normalizedEntityLabel(trait?.name))) matched.set(trait.id, trait);
  }
  if (matched.size !== 1) return null;
  const trait = [...matched.values()][0];
  return {
    trait_id: trait.id,
    trait_name: trait.name,
    resolution: explicitTraitIds.includes(trait.id)
      ? "current_hard_data_trait_id"
      : "current_hard_data_unique_trait_name",
  };
}

function equipmentConstraintDetails(itemIds, catalogs) {
  return uniqueStrings(itemIds).map((itemId) => {
    const item = catalogs.items.get(String(itemId || "")) || null;
    const grantedTrait = resolveGrantedTrait(item, catalogs);
    return {
      item_id: itemId,
      item_name: item?.name || null,
      item_tags: uniqueStrings(item?.tags),
      granted_trait_id: grantedTrait?.trait_id || null,
      granted_trait_name: grantedTrait?.trait_name || null,
      granted_trait_resolution: grantedTrait?.resolution || null,
    };
  });
}

function publishedRoleEquipmentPriority(row, role, holder, catalogs) {
  if (!holder) return null;
  const publishedItemIds = uniqueStrings(holder.item_ids);
  const requiredItemIds = explicitRequiredItemIds(row, role);
  return {
    holder_id: holder.champion_id || null,
    holder_name: holder.champion_name || null,
    published_priority_item_ids: publishedItemIds,
    published_priority_item_names: publishedItemIds.map((id) => entityName(catalogs.items, id)).filter(Boolean),
    published_priority_emblems: equipmentConstraintDetails(
      publishedItemIds.filter((id) => catalogs.items.get(String(id || ""))?.tags?.includes("emblem")),
      catalogs,
    ),
    explicit_required_item_ids: requiredItemIds,
    explicit_required_item_names: requiredItemIds.map((id) => entityName(catalogs.items, id)).filter(Boolean),
    explicit_required_items: equipmentConstraintDetails(requiredItemIds, catalogs),
    required_claim_policy: "only_explicit_upstream_required_fields_create_a_must_have_claim",
    emblem_holder_policy: "a_required_emblem_makes_this_holder_an_external_member_of_the_granted_trait_and_may_be_a_lineup_formation_condition",
  };
}

function transitionSourceRow(row, catalogs, legalPopulations) {
      const supportId = row?.assist_chess ? String(row.assist_chess) : null;
      const supportItemIds = uniqueStrings(row?.assist_chess_equip);
      const supportCandidates = supportId ? [{
        champion_id: supportId,
        champion_name: entityName(catalogs.champions, supportId),
        item_ids: supportItemIds,
        item_names: supportItemIds.map((id) => entityName(catalogs.items, id)).filter(Boolean),
        source_interpretation: "published_transition_support_candidate_not_automatically_main_tank",
      }] : [];
      const mainCarryId = row?.main_c_chess ? String(row.main_c_chess) : null;
      const mainCarryItemIds = uniqueStrings(row?.main_c_chess_equip);
      const mainCarry = {
        champion_id: mainCarryId,
        champion_name: entityName(catalogs.champions, mainCarryId),
        item_ids: mainCarryItemIds,
        item_names: mainCarryItemIds.map((id) => entityName(catalogs.items, id)).filter(Boolean),
      };
      const primaryTank = primaryTankFromPublishedSupport(supportCandidates, catalogs);
      const population = finiteNumber(row?.degree);
      const lineupIds = uniqueStrings(row?.lineup);
      const unresolvedLineupIds = lineupIds.filter((id) => !catalogs.champions.has(id));
      const legalIntegerPopulation = Number.isInteger(population) && legalPopulations.has(population);
      const uniqueRosterComplete = legalIntegerPopulation && lineupIds.length === population;
      const status = legalIntegerPopulation && !unresolvedLineupIds.length && uniqueRosterComplete
        ? "valid_full_node"
        : legalIntegerPopulation && !unresolvedLineupIds.length && lineupIds.length > 0 && lineupIds.length < population
          ? "partial_published_hint"
          : "invalid_source_node";
      return {
        semantic_role: "published_transition",
        semantic_role_source: "winning_lineup_variant.excessive_content_data",
        node_status: status,
        effective_full_node: status === "valid_full_node",
        population,
        observed_win_rate: normalizeRate(row?.win_rate),
        observed_use_rate: normalizeRate(row?.use_rate),
        lineup_ids: lineupIds,
        lineup_names: lineupIds.map((id) => entityName(catalogs.champions, id)).filter(Boolean),
        main_carry: mainCarry,
        support_candidates: supportCandidates,
        primary_tank: primaryTank,
        equipment_priority: {
          main_carry: publishedRoleEquipmentPriority(row, "main_carry", mainCarry, catalogs),
          primary_tank: publishedRoleEquipmentPriority(row, "primary_tank", primaryTank, catalogs),
          precedence: "explicit_required_then_published_recipe_then_hero_core_then_highest_top1_then_most_popular",
        },
        transfer_recommendations: Array.isArray(row?.transfer_recommend) ? row.transfer_recommend : [],
        positioning_template: {
          self_board_only: true,
          source_interpretation: "player_facing_transition_template_not_counter_positioning",
          coordinates: compactPositionRows(row?.position_list),
        },
        evidence_boundary: "published_transition_template_metrics_not_a_live_match_guarantee",
        validation: {
          legal_integer_population: legalIntegerPopulation,
          roster_size_matches_population: uniqueRosterComplete,
          unresolved_lineup_ids: unresolvedLineupIds,
        },
      };
}

function transitionHints(variant, catalogs, legalPopulations) {
  const seenValidPopulations = new Set();
  const effective = [];
  const audit = [];
  for (const row of Array.isArray(variant?.excessive_content_data) ? variant.excessive_content_data : []) {
    const normalized = transitionSourceRow(row, catalogs, legalPopulations);
    if (normalized.node_status === "valid_full_node" && seenValidPopulations.has(normalized.population)) {
      normalized.node_status = "invalid_source_node";
      normalized.effective_full_node = false;
      normalized.validation.duplicate_population = true;
    }
    if (normalized.effective_full_node) {
      seenValidPopulations.add(normalized.population);
      effective.push(normalized);
    } else {
      audit.push(normalized);
    }
  }
  return { effective, audit };
}

function compileTransitionSupport(variant, sourceVariant, catalogs, legalPopulations) {
  const published = transitionHints(sourceVariant, catalogs, legalPopulations);
  return {
    effective: published.effective,
    audit: published.audit,
    unfillable: [],
    runtime_gap_fill_policy: {
      source_parent_variant_id: variant.variant_id,
      published_populations: published.effective.map((row) => row.population),
      request_local_only: true,
      persisted_generated_nodes: 0,
    },
  };
}

function lifecyclePrior(mainCarryId, costs, populations) {
  const carryCost = costs.get(String(mainCarryId || "")) ?? null;
  const targetPopulation = populations.filter(Number.isFinite).sort((a, b) => a - b)[0] ?? null;
  const archetype = carryCost === null
    ? "unknown"
    : carryCost === 1 ? "one_cost_reroll"
      : carryCost === 2 ? "two_cost_reroll"
        : carryCost === 3 ? "three_cost_reroll"
          : carryCost === 4 ? "four_cost_carry"
            : "legendary_cap";
  return {
    archetype,
    main_carry_cost: carryCost,
    target_population: targetPopulation,
    authority: "soft_prior_requires_live_state_validation",
    must_reconcile: [
      "current_stage",
      "hp_and_loss_buffer",
      "gold_level_and_xp",
      "current_board_quality",
      "owned_copies_and_pairs",
      "confirmed_equipment",
      "confirmed_choices",
      "market_popularity_is_not_live_contest",
    ],
  };
}

function buildHeroMarketPriors(tierData) {
  return (Array.isArray(tierData?.hero_strength?.["255"]) ? tierData.hero_strength["255"] : [])
    .map((row) => {
      const metrics = {
        avg_rank: finiteNumber(row?.node1_avg_rank ?? row?.node2_avg_rank ?? row?.node3_avg_rank ?? row?.node4_avg_rank ?? row?.node5_avg_rank),
        top1_rate: normalizeRate(row?.node1_top1_rate ?? row?.node2_top1_rate ?? row?.node3_top1_rate ?? row?.node4_top1_rate ?? row?.node5_top1_rate),
        top4_rate: normalizeRate(row?.node1_top4_rate ?? row?.node2_top4_rate ?? row?.node3_top4_rate ?? row?.node4_top4_rate ?? row?.node5_top4_rate),
        use_rate: normalizeRate(row?.node1_use_rate ?? row?.node2_use_rate ?? row?.node3_use_rate ?? row?.node4_use_rate ?? row?.node5_use_rate),
        use_num: null,
      };
      return {
        champion_id: row?.hero_id ? String(row.hero_id) : null,
        metrics,
        interpretation: "market_popularity_prior_not_live_contest_fact",
      };
    })
    .filter((row) => row.champion_id)
    .sort((left, right) => (right.metrics.use_rate || 0) - (left.metrics.use_rate || 0));
}

function itemTags(catalogs, itemId) {
  const item = catalogs.items.get(String(itemId || ""));
  return uniqueStrings(Array.isArray(item?.tags) ? item.tags : [])
    .filter((tag) => tag === "artifact" || tag === "radiant");
}

function normalizeHeroItemPackages(rawPackages, catalogs) {
  const rows = Array.isArray(rawPackages) ? rawPackages : [];
  return rows.map((row, index) => {
    const itemIds = uniqueStrings(row?.item_ids ?? row?.equip_ids ?? row?.equip_id_group ?? row?.items ?? row?.equips ?? row?.package);
    const metrics = metricPacket({
      avg_rank: row?.avg_rank,
      top1_rate: row?.top_1_rate ?? row?.top1_rate,
      top4_rate: row?.top_4_rate ?? row?.top4_rate,
      use_rate: row?.use_rate ?? row?.playrate,
      use_num: row?.use_num ?? row?.use_count,
    });
    return {
      package_id: row?.package_id ? String(row.package_id) : `package_${index + 1}`,
      item_ids: itemIds,
      item_names: itemIds.map((id) => entityName(catalogs.items, id)).filter(Boolean),
      item_tags: Object.fromEntries(itemIds.map((id) => [id, itemTags(catalogs, id)]).filter(([, tags]) => tags.length)),
      metrics,
      support: sampleBand(metrics.use_num),
    };
  }).filter((row) => row.item_ids.length);
}

function normalizeHeroCoreItems(row, catalogs) {
  const itemIds = uniqueStrings(row?.single_itemid);
  const playRates = Array.isArray(row?.single_itemid_playrate) ? row.single_itemid_playrate : [];
  const top4Rates = Array.isArray(row?.single_itemid_top4_rate) ? row.single_itemid_top4_rate : [];
  const top1Rates = Array.isArray(row?.single_itemid_top1_rate) ? row.single_itemid_top1_rate : [];
  const avgRanks = Array.isArray(row?.single_itemid_avg_rank) ? row.single_itemid_avg_rank : [];
  return itemIds.map((itemId, index) => ({
    item_id: itemId,
    item_name: entityName(catalogs.items, itemId),
    item_tags: itemTags(catalogs, itemId),
    metrics: {
      avg_rank: finiteNumber(avgRanks[index]),
      top1_rate: normalizeRate(top1Rates[index]),
      top4_rate: normalizeRate(top4Rates[index]),
      use_rate: normalizeRate(playRates[index]),
      use_num: null,
    },
    source_interpretation: "hero_ranking_published_core_item_evidence",
  }));
}

function rawHeroEquipRows(heroEquipRankings) {
  if (Array.isArray(heroEquipRankings)) return heroEquipRankings;
  if (!heroEquipRankings || typeof heroEquipRankings !== "object") return [];
  const source = heroEquipRankings.by_hero_id && typeof heroEquipRankings.by_hero_id === "object"
    ? heroEquipRankings.by_hero_id
    : heroEquipRankings;
  return Object.entries(source).map(([heroId, value]) => ({
    hero_id: heroId,
    ...(value && typeof value === "object" && !Array.isArray(value) ? value : { packages: value }),
  }));
}

function chooseHeroPackages(packages) {
  const highestTop1 = [...packages]
    .sort((left, right) => (right.metrics.top1_rate ?? -1) - (left.metrics.top1_rate ?? -1)
      || (right.metrics.use_rate ?? 0) - (left.metrics.use_rate ?? 0)
      || left.package_id.localeCompare(right.package_id))[0] || null;
  const mostPopular = [...packages]
    .sort((left, right) => (right.metrics.use_rate ?? 0) - (left.metrics.use_rate ?? 0)
      || (right.metrics.use_num ?? 0) - (left.metrics.use_num ?? 0)
      || left.package_id.localeCompare(right.package_id))[0] || null;
  return { highest_top1: highestTop1, most_popular: mostPopular };
}

function buildHeroProfiles(tierData, catalogs) {
  const marketByHero = new Map(buildHeroMarketPriors(tierData).map((row) => [row.champion_id, row]));
  const rows = rawHeroEquipRows(tierData?.hero_equip_rankings);
  return rows.map((row) => {
    const championId = row?.hero_id ?? row?.champion_id ?? row?.chess_id;
    if (!championId) return null;
    const champion_id = String(championId);
    const packages = normalizeHeroItemPackages(
      row?.combine_itemid_details ?? row?.packages ?? row?.item_packages ?? row?.list ?? row?.items,
      catalogs,
    );
    const selected = chooseHeroPackages(packages);
    return {
      champion_id,
      champion_name: entityName(catalogs.champions, champion_id),
      market_prior: marketByHero.get(champion_id) || null,
      item_packages: packages,
      core_items: normalizeHeroCoreItems(row, catalogs),
      selected_item_packages: selected,
      interpretation: "hero_ranking_is_popularity_contest_pressure_and_item_preference_not_lineup_strength",
    };
  }).filter(Boolean).sort((left, right) => left.champion_id.localeCompare(right.champion_id));
}

function buildEquipmentPriors(tierData) {
  return (Array.isArray(tierData?.equip_rank?.list) ? tierData.equip_rank.list : []).map((row) => ({
    item_id: row?.equip_id ? String(row.equip_id) : null,
    associated_champion_ids: uniqueStrings(row?.top_3_hero),
    metrics: metricPacket({
      avg_rank: row?.hero_rank,
      top1_rate: row?.top1_rate,
      top4_rate: row?.top4_rate,
      use_rate: row?.use_rate,
      use_num: row?.use_count,
    }),
    interpretation: "low_weight_item_to_champion_association_not_best_holder_truth",
  })).filter((row) => row.item_id);
}

function canonicalChampionId(catalogs, value) {
  return resolveSourceChampion(catalogs, value)?.champion_id || null;
}

function sourceAliasIds(value) {
  const sourceId = String(value || "").trim();
  if (!sourceId) return [];
  return uniqueStrings([
    sourceId,
    /^\d{4}$/u.test(sourceId) ? `1${sourceId}` : null,
    /^1\d{4}$/u.test(sourceId) ? sourceId.slice(1) : null,
  ]);
}

function sourceChampionSemanticIdentity(resolution) {
  if (!resolution?.champion_id) return null;
  return {
    champion_id: resolution.champion_id,
    additional_trait_ids: uniqueStrings(resolution.additional_trait_ids).sort(),
    ...(resolution.population_cost !== 1 ? { population_cost: resolution.population_cost } : {}),
    ...(firstArray(resolution.additional_trait_contributions).some((entry) => entry.value !== 1)
      ? { additional_trait_contributions: resolution.additional_trait_contributions }
      : {}),
    ...(firstArray(resolution.base_trait_contributions).some((entry) => entry.value !== 1)
      ? { base_trait_contributions: resolution.base_trait_contributions }
      : {}),
  };
}

function sourceChampionResolution(champion, {
  additionalTraitIds = [],
  mappingKind = "canonical_catalog",
  variantTraitContribution = null,
} = {}) {
  const additionalIds = uniqueStrings(additionalTraitIds);
  const declaredVariantContribution = finiteNumber(
    variantTraitContribution ?? champion?.runtime_semantics?.variant_trait_contribution,
  );
  const additionalTraitContributions = additionalIds.map((traitId) => ({
    trait_id: traitId,
    trait_name: null,
    value: declaredVariantContribution !== null && declaredVariantContribution > 0
      ? declaredVariantContribution
      : 1,
  }));
  return {
    champion_id: champion.id,
    champion_name: champion.name,
    additional_trait_ids: additionalIds,
    additional_trait_contributions: additionalTraitContributions,
    base_trait_contributions: normalizedTraitContributions(champion?.runtime_semantics?.trait_contributions),
    population_cost: normalizedPopulationCost(champion?.runtime_semantics?.population_cost),
    mapping_kind: mappingKind,
  };
}

function resolveSourceChampion(catalogs, value) {
  for (const alias of sourceAliasIds(value)) {
    const direct = catalogs.champions.get(alias);
    if (direct) return sourceChampionResolution(direct);
    const mapped = catalogs.sourceChampionMappings?.get(alias);
    if (mapped) return mapped;
  }
  return null;
}

function championTraitIds(champion) {
  const structured = firstArray(champion?.traits)
    .map((trait) => String(trait?.id || trait?.trait_id || "").trim())
    .filter(Boolean);
  return structured.length
    ? structured
    : String(champion?.class_or_trait_codes || "").split("|").map((id) => id.trim()).filter(Boolean);
}

function activeTraitEffectText(trait, breakpoint) {
  const row = firstArray(trait?.breakpoints)
    .find((entry) => finiteNumber(entry?.count ?? entry?.level) === finiteNumber(breakpoint));
  return uniqueStrings([
    row?.effect,
    row?.levelDesc,
    row?.description,
    row?.desc,
  ]).join(" ");
}

function buildRosterCapacityProfile({ atomicRosterMembers, canonicalLineupIdentity, catalogs, legalPopulations }) {
  const occupiedPopulation = firstArray(atomicRosterMembers).reduce((sum, member) => (
    sum + (member?.occupies_population === true ? normalizedPopulationCost(member?.population_cost) : 0)
  ), 0);
  const teamSizeModifiers = firstArray(canonicalLineupIdentity?.active_traits).flatMap((activeTrait) => {
    const trait = catalogs.traits.get(String(activeTrait?.trait_id || ""));
    const effectText = activeTraitEffectText(trait, activeTrait?.active_breakpoint);
    const teamSizeMetrics = parseTypedMetrics(effectText)
      .filter((metric) => metric.metric === "team_size" && metric.delta > 0);
    const teamSizeBonus = teamSizeMetrics
      .reduce((sum, metric) => sum + metric.delta, 0);
    if (!(teamSizeBonus > 0)) return [];
    const activationOccupiedPopulation = firstArray(atomicRosterMembers).reduce((sum, member) => {
      if (member?.entity_kind !== "canonical_champion") return sum;
      const champion = catalogs.champions.get(String(member?.champion_id || ""));
      const contributes = championTraitIds(champion).includes(String(activeTrait.trait_id))
        || firstArray(member?.additional_trait_contributions)
          .some((entry) => String(entry?.trait_id || "") === String(activeTrait.trait_id));
      return sum + (contributes ? normalizedPopulationCost(member?.population_cost) : 0);
    }, 0);
    return [{
      source_kind: "active_trait_breakpoint",
      trait_id: activeTrait.trait_id,
      trait_name: activeTrait.trait_name,
      active_breakpoint: activeTrait.active_breakpoint,
      team_size_bonus: teamSizeBonus,
      activation_occupied_population: activationOccupiedPopulation,
      source_effect: uniqueStrings(teamSizeMetrics.map((metric) => metric.source_text)).join(" "),
    }];
  });
  const teamSizeBonus = teamSizeModifiers.reduce((sum, modifier) => sum + modifier.team_size_bonus, 0);
  const activationPopulation = teamSizeModifiers.reduce((maximum, modifier) => (
    Math.max(maximum, modifier.activation_occupied_population)
  ), 0);
  const baseTeamSize = Math.max(occupiedPopulation - teamSizeBonus, activationPopulation);
  const effectiveTeamSize = baseTeamSize + teamSizeBonus;
  return {
    roster_unit_count: firstArray(atomicRosterMembers).length,
    occupied_population: occupiedPopulation,
    base_team_size: baseTeamSize,
    team_size_bonus: teamSizeBonus,
    effective_team_size: effectiveTeamSize,
    population_legal: legalPopulations.has(baseTeamSize)
      && activationPopulation <= baseTeamSize
      && occupiedPopulation <= effectiveTeamSize,
    team_size_modifiers: teamSizeModifiers,
  };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function explicitFormationRequirements(raw, catalogs) {
  const source = raw?.formation_requirements || raw?.requirements || null;
  if (!source || typeof source !== "object") {
    return { status: "unknown", source: "no_explicit_requirement_record" };
  }
  const resolveIds = (values, lookup) => uniqueStrings(Array.isArray(values) ? values : [])
    .filter((id) => lookup.has(id));
  const starTargets = Array.isArray(source.required_star_targets || source.star_targets)
    ? (source.required_star_targets || source.star_targets).map((target) => ({
        champion_id: canonicalChampionId(catalogs, target?.champion_id || target?.unit_id || target?.id),
        star: finiteNumber(target?.star ?? target?.stars),
      })).filter((target) => target.champion_id && Number.isFinite(target.star))
    : [];
  const result = {
    status: "explicit",
    source: "recipe_or_version_requirement_record",
    required_item_ids: resolveIds(source.required_item_ids || source.items, catalogs.items),
    required_augment_ids: resolveIds(source.required_augment_ids || source.augments, catalogs.augments),
    required_emblem_ids: resolveIds(source.required_emblem_ids || source.emblems, catalogs.items),
    required_unit_ids: resolveIds(source.required_unit_ids || source.units, catalogs.champions),
    required_star_targets: starTargets,
    special_mechanics: uniqueStrings(source.special_mechanics || source.mechanics),
  };
  const hasAny = Object.entries(result)
    .filter(([key]) => key.endsWith("_ids") || key === "required_star_targets" || key === "special_mechanics")
    .some(([, value]) => Array.isArray(value) && value.length);
  return hasAny ? result : { status: "unknown", source: "empty_explicit_requirement_record" };
}

function buildHeroHeatLookup(heroProfiles) {
  const rows = (heroProfiles || [])
    .map((profile) => ({
      champion_id: String(profile?.champion_id || ""),
      use_rate: finiteNumber(profile?.market_prior?.metrics?.use_rate),
    }))
    .filter((row) => row.champion_id && row.use_rate !== null)
    .sort((left, right) => right.use_rate - left.use_rate || left.champion_id.localeCompare(right.champion_id));
  const denominator = Math.max(1, rows.length - 1);
  return new Map(rows.map((row, index) => [row.champion_id, {
    use_rate: row.use_rate,
    heat_percentile: Number((1 - index / denominator).toFixed(3)),
  }]));
}

function buildFormationProfile(variant, recipe, costs, catalogs, heroProfiles) {
  const unitRows = firstArray(variant?.atomic_roster_members)
    .filter((member) => member?.entity_kind === "canonical_champion" && member?.champion_id)
    .map((member) => ({
      champion_id: member.champion_id,
      champion_name: member.champion_name || entityName(catalogs.champions, member.champion_id),
      cost: costs.get(member.champion_id) ?? null,
      population_cost: normalizedPopulationCost(member.population_cost),
    }));
  const highCostUnits = unitRows.filter((unit) => (unit.cost || 0) >= 4);
  const fourCostUnits = highCostUnits.filter((unit) => unit.cost === 4);
  const fiveCostUnits = highCostUnits.filter((unit) => unit.cost === 5);
  const heatLookup = buildHeroHeatLookup(heroProfiles);
  const unitHeat = unitRows.map((unit) => ({
    ...unit,
    ...(heatLookup.get(unit.champion_id) || { use_rate: null, heat_percentile: null }),
  }));
  const knownHeat = unitHeat.filter((unit) => unit.heat_percentile !== null);
  const contestPressure = knownHeat.length
    ? Number((knownHeat.reduce((sum, unit) => sum + unit.heat_percentile, 0) / knownHeat.length).toFixed(3))
    : null;
  const transitions = Array.isArray(variant?.transitions) ? variant.transitions : [];
  const publishedPopulations = uniqueStrings(transitions.map((transition) => transition?.population))
    .map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  const roleResolution = variant?.role_resolution || null;
  const resolvedRecipe = recipe ? {
    ...recipe,
    main_carry_id: roleResolution?.main_carry_id || recipe.main_carry_id || null,
    primary_tank_id: roleResolution?.primary_tank_id || recipe.primary_tank_id || null,
  } : null;
  const requirements = explicitFormationRequirements(resolvedRecipe, catalogs);
  const traitReconciliation = variant?.trait_state_reconciliation;
  const traitCompletionEvidence = firstArray(traitReconciliation?.explained_contribution_gaps).length
    || firstArray(traitReconciliation?.unresolved_contribution_gaps).length
    ? {
        status: traitReconciliation.status,
        explained_contribution_gaps: firstArray(traitReconciliation.explained_contribution_gaps),
        unresolved_contribution_gaps: firstArray(traitReconciliation.unresolved_contribution_gaps),
        authority: "source_breakpoint_compared_with_current_core_roster_and_exact_recipe_items",
      }
    : null;
  const requiredStarTargets = requirements.status === "explicit"
    ? requirements.required_star_targets.map((target) => ({
        unit_id: target.champion_id,
        star: target.star,
        source: "recipe_explicit_requirement",
      }))
    : [];
  const sharedFeasibility = evaluateLineupFeasibility({
    roster: unitRows.map((unit) => ({
      id: unit.champion_id,
      name: unit.champion_name,
      cost: unit.cost,
      population_cost: unit.population_cost,
      roles: [
        ...(String(resolvedRecipe?.main_carry_id || resolvedRecipe?.main_carry?.champion_id || "") === String(unit.champion_id)
          ? ["main_carry"] : []),
        ...(String(resolvedRecipe?.primary_tank_id || resolvedRecipe?.main_tank_id || resolvedRecipe?.main_tank?.champion_id || "") === String(unit.champion_id)
          ? ["main_tank"] : []),
      ],
    })),
    population: variant?.population ?? unitRows.length,
    archetype: recipe?.archetype || recipe?.lifecycle_prior?.archetype
      || variant?.lifecycle_prior?.archetype || null,
    starTargets: requiredStarTargets,
    requiredConditions: requirements,
    sourceAuthority: "daily_ranking_recipe",
  });
  const explicitGateCount = requirements.status === "explicit"
    ? [
        requirements.required_item_ids,
        requirements.required_augment_ids,
        requirements.required_emblem_ids,
        requirements.required_unit_ids,
        requirements.required_star_targets,
        requirements.special_mechanics,
      ].filter((values) => values.length).length
    : null;
  const components = [
    { id: "target_population", value: clamp01(((variant?.population ?? 7) - 7) / 5), weight: 0.3 },
    { id: "high_cost_dependency", value: clamp01(fourCostUnits.length * 0.14 + fiveCostUnits.length * 0.28), weight: 0.3 },
    { id: "contest_pressure", value: contestPressure, weight: 0.15 },
    { id: "transition_gap", value: publishedPopulations.length ? clamp01(1 - publishedPopulations.length / 3) : null, weight: 0.15 },
    { id: "explicit_gate_pressure", value: explicitGateCount === null ? null : clamp01(explicitGateCount / 3), weight: 0.1 },
  ];
  const knownComponents = components.filter((component) => component.value !== null);
  const knownWeight = knownComponents.reduce((sum, component) => sum + component.weight, 0);
  const burdenScore = knownWeight
    ? Number((knownComponents.reduce((sum, component) => sum + component.value * component.weight, 0) / knownWeight).toFixed(3))
    : null;
  const unknowns = [];
  if (requirements.status !== "explicit") unknowns.push("star_item_augment_emblem_and_special_mechanic_requirements_not_explicitly_declared");
  if (!publishedPopulations.length) unknowns.push("published_transition_support_unavailable");
  if (!knownHeat.length) unknowns.push("hero_heat_evidence_unavailable");
  return {
    schema: "jcc-lineup-formation-profile-v1",
    authority: "parallel_to_national_strength_not_a_strength_adjustment",
    target_population: variant?.population ?? null,
    roster_unit_count: variant?.roster_unit_count ?? unitRows.length,
    occupied_population: variant?.occupied_population ?? unitRows
      .reduce((sum, unit) => sum + unit.population_cost, 0),
    base_team_size: variant?.base_team_size ?? variant?.population ?? null,
    team_size_bonus: variant?.team_size_bonus ?? 0,
    effective_team_size: variant?.effective_team_size ?? variant?.population ?? null,
    population_legal: variant?.population_legal ?? null,
    team_size_modifiers: firstArray(variant?.team_size_modifiers),
    target_units: unitRows,
    high_cost_units: highCostUnits,
    high_cost_counts: {
      four_cost: fourCostUnits.length,
      five_cost: fiveCostUnits.length,
      total: highCostUnits.length,
    },
    trait_breakpoints: (variant?.trait_signature?.traits || []).map((trait) => ({
      canonical_trait_id: trait?.canonical_trait_id || trait?.trait_id || null,
      trait_name: trait?.trait_name || null,
      breakpoint: trait?.breakpoint ?? null,
      count: trait?.count ?? trait?.breakpoint ?? null,
    })),
    contest_pressure: {
      score: contestPressure,
      unit_heat: unitHeat,
      interpretation: "hero_use_rate_is_heat_and_contest_evidence_not_formation_probability",
    },
    transition_support: {
      status: publishedPopulations.length ? "published" : "unknown",
      published_populations: publishedPopulations,
      earliest_published_population: publishedPopulations[0] ?? null,
      count: publishedPopulations.length,
    },
    explicit_requirements: requirements,
    trait_completion_evidence: traitCompletionEvidence,
    formation_economy_profile: sharedFeasibility.economy_profile,
    acquisition_profile: sharedFeasibility.acquisition_profile,
    components,
    estimated_burden_score: burdenScore,
    burden_band: burdenScore === null ? "unknown" : burdenScore >= 0.66 ? "high" : burdenScore >= 0.33 ? "medium" : "low",
    evidence_coverage: Number((knownComponents.length / components.length).toFixed(3)),
    unknowns,
    runtime_reconcile: [
      "current_stage",
      "hp_and_loss_buffer",
      "gold_level_and_xp",
      "current_board_quality",
      "owned_copies_and_pairs",
      "confirmed_equipment",
      "confirmed_choices",
      "live_contest_is_not_fully_observed_by_market_heat",
    ],
    shared_feasibility: sharedFeasibility.formation_profile,
  };
}

function recipeEvidencePolicy(classification) {
  if (classification === "exact") {
    return {
      use_as: "bounded_recipe_enrichment",
      allowed_fields: [
        "roles",
        "items",
        "augments",
        "variants",
        "transitions",
        "positioning",
        "playbook",
        "lineup_code",
      ],
      may_replace_roster: false,
      may_merge_variants: false,
      may_inherit_strength: false,
      evidence_boundary: "recipe_enrichment_only_national_roster_and_strength_remain_authoritative",
    };
  }
  if (classification === "compatible") {
    return {
      use_as: "named_variant_difference_only",
      allowed_fields: ["variant_difference", "role_hints", "hero_item_lookup"],
      may_replace_roster: false,
      may_merge_variants: false,
      may_inherit_strength: false,
      evidence_boundary: "compatible_recipe_is_a_named_alternative_and_cannot_supply_transitions_positioning_or_playbook_to_the_standard_roster",
    };
  }
  if (classification === "analogous") {
    return {
      use_as: "bounded_reference_only",
      allowed_fields: ["role_hints", "hero_item_lookup"],
      may_replace_roster: false,
      may_merge_variants: false,
      may_inherit_strength: false,
      evidence_boundary: "analogous_recipe_can_hint_roles_only_hero_item_board_supplies_equipment_reference",
    };
  }
  return {
    use_as: "unmatched",
    allowed_fields: [],
    may_replace_roster: false,
    may_merge_variants: false,
    may_inherit_strength: false,
    evidence_boundary: "no_recipe_enrichment",
  };
}

function normalizedPublishedRecipe(recipe, catalogs, {
  recipePrefix,
  sourceRole,
  sourceKind,
  sourcePriority,
  freshness,
}) {
  const finalRosterIds = uniqueStrings((recipe?.final_roster || []).map((entry) => entry?.champion_id))
    .map((id) => canonicalChampionId(catalogs, id))
    .filter(Boolean);
  return {
    recipe_id: `${recipePrefix}:${recipe.recipe_id}`,
    display_name: recipe?.name || recipe?.display_name || recipe?.title || null,
    source_id: recipe?.source_id || null,
    author: recipe?.author || recipe?.creator || recipe?.author_name || null,
    source_role: sourceRole,
    source_kind: sourceKind,
    source_priority: sourcePriority,
    freshness: freshness || null,
    source_trait_signature: traitSignature(recipe?.source_main_traits || []),
    source_identity_trait_families: uniqueStrings(recipe?.source_identity_trait_ids || [])
      .map(traitFamilyId)
      .filter(Boolean)
      .sort(),
    final_roster_ids: finalRosterIds,
    canonical_lineup_identity: buildCanonicalLineupIdentity({
      championIds: finalRosterIds,
      champions: catalogs.champions,
      traits: catalogs.traits,
    }),
    auxiliary_units: (recipe?.final_auxiliary_units || []).map((unit) => ({
      source_unit_id: unit?.source_unit_id || null,
      source_unit_name: unit?.source_unit_name || null,
      unit_type: unit?.unit_type || "auxiliary",
      position: unit?.position || null,
      occupies_population: unit?.occupies_population === true,
      catalog_resolution: unit?.catalog_resolution || null,
      source_declared_unit_type: unit?.source_declared_unit_type || null,
    })),
    main_carry_id: canonicalChampionId(catalogs, recipe?.roles?.main_carry),
    primary_tank_id: canonicalChampionId(catalogs, recipe?.roles?.primary_tank),
    item_assignments: (recipe?.final_roster || []).map((entry) => ({
      holder_id: canonicalChampionId(catalogs, entry?.champion_id),
      item_ids: uniqueStrings((entry?.items || []).map((item) => item?.id)).filter((id) => catalogs.items.has(id)),
    })).filter((assignment) => assignment.holder_id && assignment.item_ids.length),
    augment_ids: uniqueStrings((recipe?.augments || []).map((augment) => augment?.id)).filter((id) => catalogs.augments.has(id)),
    transitions: (recipe?.level_map || []).map((transition) => ({
      semantic_role: "published_transition",
      semantic_role_source: `${sourceKind}.level_map`,
      population: finiteNumber(transition?.population ?? transition?.level),
      lineup_ids: uniqueStrings((transition?.roster || []).map((entry) => entry?.champion_id)),
      lineup_names: uniqueStrings((transition?.roster || []).map((entry) => entry?.champion_name)),
      auxiliary_units: (transition?.auxiliary_units || []).map((unit) => ({
        source_unit_id: unit?.source_unit_id || null,
        source_unit_name: unit?.source_unit_name || null,
        unit_type: unit?.unit_type || "auxiliary",
        position: unit?.position || null,
        occupies_population: unit?.occupies_population === true,
        catalog_resolution: unit?.catalog_resolution || null,
        source_declared_unit_type: unit?.source_declared_unit_type || null,
      })),
      evidence_boundary: `${sourceRole}_transition_template_without_strength_authority`,
    })).filter((transition) => transition.lineup_ids.length),
    transition_audit: [],
    positioning_template: {
      self_board_only: true,
      coordinates: (recipe?.final_roster || []).map((entry) => ({
        chess_id: canonicalChampionId(catalogs, entry?.champion_id),
        x: entry?.position?.x ?? null,
        y: entry?.position?.y ?? null,
      })).filter((entry) => entry.chess_id && (entry.x !== null || entry.y !== null)),
    },
    playbook: recipe?.gameplay || null,
    lineup_code: recipe?.lineup_code || null,
    formation_requirements: recipe?.formation_requirements || recipe?.requirements || null,
  };
}

function normalizedWinningRecipes(tierData, catalogs, legalPopulations, freshness) {
  const capabilityStatus = tierData?.recipe_sources?.winning?.capability?.status || null;
  if (capabilityStatus && capabilityStatus !== "available") return [];
  const publishedRecipes = tierData?.recipe_sources?.winning?.recipes || [];
  if (publishedRecipes.length) {
    return publishedRecipes.map((recipe) => normalizedPublishedRecipe(recipe, catalogs, {
      recipePrefix: "winning",
      sourceRole: "winning_recipe",
      sourceKind: "tencent_winning_lineup",
      sourcePriority: 1,
      freshness,
    })).filter((recipe) => recipe.final_roster_ids.length);
  }
  const recipes = [];
  for (const group of tierData?.lineup_group?.main_traits_data || []) {
    for (const [index, variant] of (group?.info?.list || []).entries()) {
      const finalRosterIds = uniqueStrings(variant?.lineup)
        .map((id) => canonicalChampionId(catalogs, id))
        .filter(Boolean);
      if (!finalRosterIds.length || finalRosterIds.length !== uniqueStrings(variant?.lineup).length) continue;
      const mainCarryId = canonicalChampionId(catalogs, group?.info?.main_c_chess_id);
      const supportId = canonicalChampionId(catalogs, variant?.assist_chess);
      const transition = transitionHints(variant, catalogs, legalPopulations);
      recipes.push({
        recipe_id: `winning:${group?.id || "unknown"}:${variant?.lineup_rank || index + 1}`,
        source_role: "winning_recipe",
        source_kind: "tencent_winning_lineup",
        source_priority: 1,
        freshness: freshness || null,
        source_trait_signature: traitSignature(variant?.main_trait_group || group?.main_trait_list || []),
        source_identity_trait_families: identityTraitFamilies(group),
        final_roster_ids: finalRosterIds,
        canonical_lineup_identity: buildCanonicalLineupIdentity({
          championIds: finalRosterIds,
          champions: catalogs.champions,
          traits: catalogs.traits,
        }),
        main_carry_id: mainCarryId,
        primary_tank_id: supportId,
        item_assignments: [
          mainCarryId ? { holder_id: mainCarryId, item_ids: uniqueStrings(variant?.main_c_chess_equip) } : null,
          supportId ? { holder_id: supportId, item_ids: uniqueStrings(variant?.assist_chess_equip) } : null,
        ].filter((row) => row?.item_ids?.length),
        augment_ids: uniqueStrings(variant?.rune_id_group),
        transitions: transition.effective,
        transition_audit: transition.audit,
        positioning_template: {
          self_board_only: true,
          coordinates: compactPositionRows(variant?.position_data?.chess_position),
        },
        playbook: null,
        lineup_code: null,
        formation_requirements: null,
      });
    }
  }
  return recipes;
}

function normalizedPopularRecipes(tierData, catalogs, freshness) {
  return (tierData?.recipe_sources?.popular?.recipes || []).map((recipe) => normalizedPublishedRecipe(recipe, catalogs, {
    recipePrefix: "popular",
    sourceRole: "popular_recipe",
    sourceKind: "official_curated_popular_lineup",
    sourcePriority: 2,
    freshness,
  })).filter((recipe) => recipe.final_roster_ids.length);
}

function recipeMatchForRoster(recipe, rosterIds, canonicalIdentity) {
  if (!recipeFreshnessAllowsAutomaticPairing(recipe?.freshness)) {
    return { classification: "unmatched", overlap: 0, freshness: recipe?.freshness || null };
  }
  const roster = new Set(rosterIds);
  const recipeRoster = new Set(recipe?.final_roster_ids || []);
  if (!roster.size || !recipeRoster.size) return { classification: "unmatched", overlap: 0 };
  const intersection = [...roster].filter((id) => recipeRoster.has(id)).length;
  const exact = roster.size === recipeRoster.size && intersection === roster.size;
  const rosterCoverage = intersection / roster.size;
  const recipeCoverage = intersection / recipeRoster.size;
  const rosterTraits = firstArray(canonicalIdentity?.active_traits);
  const recipeTraits = firstArray(recipe?.canonical_lineup_identity?.active_traits);
  const rosterTraitById = new Map(rosterTraits.map((trait) => [String(trait?.trait_id || ""), trait]));
  const sharedCanonicalTraits = recipeTraits.filter((trait) => rosterTraitById.has(String(trait?.trait_id || "")));
  const sharedCanonicalTraitCount = sharedCanonicalTraits.length;
  const canonicalTraitCoverage = rosterTraits.length ? sharedCanonicalTraitCount / rosterTraits.length : 0;
  const recipeTraitCoverage = recipeTraits.length ? sharedCanonicalTraitCount / recipeTraits.length : 0;
  const breakpointCompatible = sharedCanonicalTraits.some((trait) => {
    const rosterTrait = rosterTraitById.get(String(trait?.trait_id || ""));
    return Number(rosterTrait?.active_breakpoint || 0) === Number(trait?.active_breakpoint || 0);
  });
  const canonicalTraitIdentityAvailable = recipeTraits.length > 0;
  const canonicalTraitCompatible = canonicalTraitIdentityAvailable
    && sharedCanonicalTraitCount > 0
    && canonicalTraitCoverage >= 0.67
    && recipeTraitCoverage >= 0.67
    && breakpointCompatible;
  let classification = exact && (!canonicalTraitIdentityAvailable || canonicalTraitCompatible)
    ? "exact"
    : rosterCoverage >= 0.75 && recipeCoverage >= 0.65 && canonicalTraitCompatible
      ? "compatible"
      : intersection >= 2 && rosterCoverage >= 0.35
        ? "analogous"
        : "unmatched";
  if (recipeFreshnessRequiresHighConfidence(recipe?.freshness)) {
    const highConfidenceCompatible = classification === "compatible"
      && rosterCoverage >= 0.85
      && recipeCoverage >= 0.8
      && canonicalTraitCoverage >= 0.8
      && recipeTraitCoverage >= 0.8;
    if (classification !== "exact" && !highConfidenceCompatible) classification = "unmatched";
  }
  return {
    classification,
    overlap: intersection,
    roster_coverage: Number(rosterCoverage.toFixed(3)),
    recipe_coverage: Number(recipeCoverage.toFixed(3)),
    shared_canonical_trait_count: sharedCanonicalTraitCount,
    canonical_trait_coverage: Number(canonicalTraitCoverage.toFixed(3)),
    recipe_trait_coverage: Number(recipeTraitCoverage.toFixed(3)),
    canonical_trait_identity_available: canonicalTraitIdentityAvailable,
    canonical_trait_compatible: canonicalTraitCompatible,
    freshness: recipe?.freshness || null,
  };
}

function selectRecipeForRoster(recipes, rosterIds, canonicalIdentity) {
  const priority = {
    "winning_recipe:exact": 600,
    "winning_recipe:compatible": 500,
    "popular_recipe:exact": 400,
    "popular_recipe:compatible": 300,
    "winning_recipe:analogous": 200,
    "popular_recipe:analogous": 100,
  };
  return (recipes || []).map((recipe) => ({ recipe, match: recipeMatchForRoster(recipe, rosterIds, canonicalIdentity) }))
    .filter((row) => row.match.classification !== "unmatched")
    .sort((left, right) => (priority[`${right.recipe.source_role}:${right.match.classification}`] || 0)
      - (priority[`${left.recipe.source_role}:${left.match.classification}`] || 0)
      || right.match.overlap - left.match.overlap
      || String(left.recipe.recipe_id).localeCompare(String(right.recipe.recipe_id)))[0] || null;
}

function recipeVariantDifferences(recipes, rosterIds, canonicalIdentity, catalogs, roleProfiles = []) {
  const roster = uniqueStrings(rosterIds).sort();
  const rosterSet = new Set(roster);
  const priority = { exact: 3, compatible: 2, analogous: 1, unmatched: 0 };
  const matches = (recipes || []).map((recipe) => {
    const match = recipeMatchForRoster(recipe, rosterIds, canonicalIdentity);
    const recipeRoster = uniqueStrings(recipe?.final_roster_ids).sort();
    const recipeSet = new Set(recipeRoster);
    const removedFromStandard = roster.filter((id) => !recipeSet.has(id));
    const addedByRecipe = recipeRoster.filter((id) => !rosterSet.has(id));
    const removedNames = removedFromStandard.map((id) => entityName(catalogs.champions, id) || id);
    const addedNames = addedByRecipe.map((id) => entityName(catalogs.champions, id) || id);
    const sourceLabel = recipe?.source_role === "popular_recipe" ? "热门变种" : "胜率变种";
    const generatedName = removedNames.length && addedNames.length
      ? `${sourceLabel}：${removedNames.join("、")} -> ${addedNames.join("、")}`
      : removedNames.length
        ? `${sourceLabel}：缺少${removedNames.join("、")}`
        : addedNames.length
          ? `${sourceLabel}：增加${addedNames.join("、")}`
          : `${sourceLabel}：标准阵容同构配方`;
    const recipeRoleResolution = resolveLineupRoles({
      lineupIds: recipeRoster,
      recipe,
      catalogs,
      roleProfiles,
    });
    const resolvedMainCarryId = recipeRoleResolution.main_carry_id || recipe?.main_carry_id || null;
    const resolvedPrimaryTankId = recipeRoleResolution.primary_tank_id || recipe?.primary_tank_id || null;
    const sharedReferenceFields = {
      recipe_id: recipe.recipe_id,
      display_name: recipe.display_name || generatedName,
      source_role: recipe.source_role,
      classification: match.classification,
      removed_from_standard: removedFromStandard,
      added_by_recipe: addedByRecipe,
      removed_from_standard_names: removedNames,
      added_by_recipe_names: addedNames,
      canonical_trait_coverage: match.canonical_trait_coverage ?? null,
      roster_coverage: match.roster_coverage ?? null,
      recipe_coverage: match.recipe_coverage ?? null,
      freshness: match.freshness || recipe?.freshness || null,
      main_carry_id: resolvedMainCarryId,
      main_carry_name: resolvedMainCarryId ? entityName(catalogs.champions, resolvedMainCarryId) || resolvedMainCarryId : null,
      primary_tank_id: resolvedPrimaryTankId,
      primary_tank_name: resolvedPrimaryTankId ? entityName(catalogs.champions, resolvedPrimaryTankId) || resolvedPrimaryTankId : null,
      role_resolution: recipeRoleResolution,
      item_assignments: firstArray(recipe?.item_assignments),
      may_replace_standard_roster: false,
      evidence_boundary: "published_recipe_variant_must_be_named_and_never_silently_merged_into_master_plus_standard",
    };
    if (match.classification === "exact") {
      return {
        ...sharedReferenceFields,
        augment_ids: firstArray(recipe?.augment_ids),
        transitions: firstArray(recipe?.transitions),
        positioning_template: recipe?.positioning_template || null,
        lineup_code: recipe?.lineup_code || null,
        playbook: recipe?.playbook || null,
        formation_requirements: recipe?.formation_requirements || null,
        use_as: "same_roster_recipe_enrichment",
      };
    }
    return {
      ...sharedReferenceFields,
      use_as: match.classification === "compatible"
        ? "named_variant_difference_only"
        : "bounded_role_and_item_reference_only",
      operational_fields_withheld: true,
    };
  }).filter((row) => row.classification !== "unmatched")
    .sort((left, right) => (priority[right.classification] - priority[left.classification])
      || Number(right.source_role === "winning_recipe") - Number(left.source_role === "winning_recipe")
      || String(left.recipe_id).localeCompare(String(right.recipe_id)));
  return {
    schema: "jcc-mature-recipe-variant-set-v1",
    source_count: matches.length,
    retained_count: matches.length,
    truncated: false,
    variants: matches,
    evidence_boundary: "complete_mature_recipe_variants_are_named_alternatives_and_never_modify_the_master_plus_standard_roster",
  };
}

const CARRY_ROLE_PATTERN = /(carry|后排|输出|caster|ranged|ap_carry|physical_carry|attack_speed_carry|damage)/iu;
const FRONTLINE_ROLE_PATTERN = /(tank|坦克|前排|frontline|护卫|guard)/iu;
const CARRY_ITEM_ROLE_PATTERN = /(carry|caster|攻击|输出|damage|ap|物理|法术)/iu;
const FRONTLINE_ITEM_ROLE_PATTERN = /(tank|frontline|防御|前排)/iu;
const CARRY_ITEM_TAG_WEIGHTS = new Map([
  ["physical_damage", 3],
  ["magic_damage", 3],
  ["attack_speed", 2],
  ["critical_strike", 2],
  ["mana", 1],
  ["omnivamp", 1],
]);

function roleProfileIdentity(profile) {
  const direct = profile?.champion_id ?? profile?.hero_id ?? profile?.id;
  if (direct != null && String(direct).trim()) return String(direct).trim();
  const address = String(profile?.champion_address || profile?.address || "").trim();
  return address.split(":").pop() || null;
}

function roleProfileLookup(roleProfiles) {
  return new Map((Array.isArray(roleProfiles) ? roleProfiles : [])
    .map((profile) => [roleProfileIdentity(profile), profile])
    .filter(([id]) => id));
}

function roleEvidenceForChampion({ champion, roleProfile, assignment, catalogs, declaredRole }) {
  const explicitRoleText = [
    champion?.primary_role,
    champion?.role,
    champion?.role_key,
    roleProfile?.role,
    roleProfile?.role_key,
  ].filter(Boolean).join(" ");
  const roleTagText = [
    ...(champion?.tags || []),
    ...(roleProfile?.tags || []),
  ].filter(Boolean).join(" ");
  let carryScore = CARRY_ROLE_PATTERN.test(explicitRoleText) ? 8 : 0;
  let frontlineScore = FRONTLINE_ROLE_PATTERN.test(explicitRoleText) ? 8 : 0;
  // An explicit Core role wins over output tags: a frontline caster is not
  // a carry merely because its spell deals magic damage. Tags fill the gap
  // only when the role index has no usable role classification.
  if (!carryScore && !frontlineScore) {
    carryScore = CARRY_ROLE_PATTERN.test(roleTagText) ? 4 : 0;
    frontlineScore = FRONTLINE_ROLE_PATTERN.test(roleTagText) ? 4 : 0;
  }
  const itemSignals = [];
  for (const itemId of uniqueStrings(assignment?.item_ids)) {
    const item = catalogs.items.get(String(itemId || ""));
    if (!item) continue;
    const primaryRole = String(item.primary_role || item.role || "");
    const tags = uniqueStrings(item.tags);
    const tankByRole = FRONTLINE_ITEM_ROLE_PATTERN.test(primaryRole);
    const carryByRole = CARRY_ITEM_ROLE_PATTERN.test(primaryRole);
    const tagCarryScore = tags.reduce((score, tag) => score + (CARRY_ITEM_TAG_WEIGHTS.get(tag) || 0), 0);
    const tagFrontlineScore = tags.reduce((score, tag) => score + (PRIMARY_TANK_ITEM_TAG_WEIGHTS.get(tag) || 0), 0);
    carryScore += (carryByRole ? 6 : 0) + tagCarryScore;
    frontlineScore += (tankByRole ? 6 : 0) + tagFrontlineScore;
    itemSignals.push({
      item_id: itemId,
      primary_role: item.primary_role || item.role || null,
      carry_score: (carryByRole ? 6 : 0) + tagCarryScore,
      frontline_score: (tankByRole ? 6 : 0) + tagFrontlineScore,
    });
  }
  if (declaredRole === "main_carry") carryScore += 7;
  if (declaredRole === "primary_tank") frontlineScore += 7;
  if (declaredRole === "main_carry") frontlineScore -= 3;
  if (declaredRole === "primary_tank") carryScore -= 3;
  return {
    champion_id: champion?.id || null,
    champion_name: champion?.name || null,
    carry_score: carryScore,
    frontline_score: frontlineScore,
    item_signals: itemSignals,
    role_source: roleProfile ? "core_champion_role_profile" : "catalog_champion_role_fields",
  };
}

function roleCandidateConfidence(score, opposingScore) {
  const margin = Number(score || 0) - Number(opposingScore || 0);
  return margin >= 10 ? "high" : margin >= 4 ? "medium" : "low";
}

export function resolveLineupRoles({ lineupIds = [], recipe = null, catalogs, roleProfiles = [] } = {}) {
  const roster = uniqueStrings(lineupIds)
    .map((id) => catalogs?.champions?.get(String(id || "")))
    .filter(Boolean);
  const roleProfilesById = roleProfileLookup(roleProfiles);
  const assignmentsByHolder = new Map((recipe?.item_assignments || [])
    .map((assignment) => [String(assignment?.holder_id || ""), assignment])
    .filter(([id]) => id));
  const declaredCarryId = recipe?.main_carry_id || null;
  const declaredTankId = recipe?.primary_tank_id || null;
  const evidence = roster.map((champion) => {
    const id = String(champion.id);
    const roleProfile = roleProfilesById.get(id) || null;
    const assignment = assignmentsByHolder.get(id) || null;
    const declaredRole = id === String(declaredCarryId || "")
      ? "main_carry"
      : id === String(declaredTankId || "") ? "primary_tank" : null;
    const signals = roleEvidenceForChampion({ champion, roleProfile, assignment, catalogs, declaredRole });
    return {
      ...signals,
      cost: finiteNumber(champion.cost) || 0,
    };
  });
  const sortedFor = (role) => [...evidence].sort((left, right) => {
    const leftScore = role === "main_carry" ? left.carry_score - left.frontline_score : left.frontline_score - left.carry_score;
    const rightScore = role === "main_carry" ? right.carry_score - right.frontline_score : right.frontline_score - right.carry_score;
    return rightScore - leftScore || right.cost - left.cost || String(left.champion_id).localeCompare(String(right.champion_id));
  });
  const carryRanked = sortedFor("main_carry");
  const mainCarry = carryRanked[0] || null;
  const tankCandidates = evidence.length > 1
    ? evidence.filter((candidate) => candidate.champion_id !== mainCarry?.champion_id)
    : evidence;
  const tankRanked = tankCandidates.sort((left, right) => (
    (right.frontline_score - right.carry_score) - (left.frontline_score - left.carry_score)
      || right.cost - left.cost
      || String(left.champion_id).localeCompare(String(right.champion_id))
  ));
  const primaryTank = tankRanked[0] || null;
  const buildRole = (selected, role, ranked) => {
    const selectedId = selected?.champion_id || null;
    const declaredId = role === "main_carry" ? declaredCarryId : declaredTankId;
    const selectedScore = role === "main_carry"
      ? selected?.carry_score
      : selected?.frontline_score;
    const opposingScore = role === "main_carry"
      ? selected?.frontline_score
      : selected?.carry_score;
    return {
      selected_id: selectedId,
      declared_id: declaredId,
      overridden: Boolean(declaredId && selectedId && String(declaredId) !== String(selectedId)),
      confidence: selected ? roleCandidateConfidence(selectedScore, opposingScore) : "low",
      candidates: ranked.slice(0, 3).map((candidate) => ({
        champion_id: candidate.champion_id,
        champion_name: candidate.champion_name,
        score: role === "main_carry" ? candidate.carry_score : candidate.frontline_score,
        opposing_score: role === "main_carry" ? candidate.frontline_score : candidate.carry_score,
      })),
    };
  };
  return {
    schema: "jcc-lineup-role-resolution-v1",
    source: "recipe_cross_checked_with_core_role_and_item_evidence",
    main_carry_id: mainCarry?.champion_id || null,
    primary_tank_id: primaryTank?.champion_id || null,
    main_carry: buildRole(mainCarry, "main_carry", carryRanked),
    primary_tank: buildRole(primaryTank, "primary_tank", tankRanked),
    soft_conflicts: [
      mainCarry?.champion_id && declaredCarryId && String(mainCarry.champion_id) !== String(declaredCarryId)
        ? "recipe_main_carry_conflicts_with_core_role_or_item_evidence" : null,
      primaryTank?.champion_id && declaredTankId && String(primaryTank.champion_id) !== String(declaredTankId)
        ? "recipe_primary_tank_conflicts_with_core_role_or_item_evidence" : null,
    ].filter(Boolean),
  };
}

function heroItemEvidence(heroProfilesById, championId) {
  const profile = heroProfilesById.get(String(championId || ""));
  if (!profile) return null;
  return {
    core_items: profile.core_items || [],
    highest_top1_package: profile.selected_item_packages?.highest_top1 || null,
    most_popular_package: profile.selected_item_packages?.most_popular || null,
    precedence: "hero_ranking_highest_top1_then_most_popular",
  };
}

function buildNationalLineupCandidates({
  strengthAnchors,
  tierData,
  catalogs,
  costs,
  legalPopulations,
  heroProfiles,
  roleProfiles,
  commonSemanticDocument,
  semanticIdentity,
  statDate,
}) {
  const recipeFreshness = buildRankingRecipeFreshnessProfile({
    rankingStatDate: statDate,
    sourceCapabilities: {
      winning: tierData?.recipe_sources?.winning?.capability || {},
      popular: tierData?.recipe_sources?.popular?.capability || {},
    },
  });
  const recipes = [
    ...normalizedWinningRecipes(tierData, catalogs, legalPopulations, recipeFreshness.sources.winning),
    ...normalizedPopularRecipes(tierData, catalogs, recipeFreshness.sources.popular),
  ];
  const auxiliaryRegistry = buildRankingRecipeAuxiliaryRegistry([
    ...(tierData?.recipe_sources?.winning?.recipes || []),
    ...(tierData?.recipe_sources?.popular?.recipes || []),
  ]);
  const heroProfilesById = new Map(heroProfiles.map((profile) => [profile.champion_id, profile]));
  const candidates = [];
  for (const anchor of strengthAnchors) {
    const sourceRows = Array.isArray(anchor?.canonical_roster_source?.minor_traits_datas)
      ? anchor.canonical_roster_source.minor_traits_datas
      : [];
    const rosterRows = sourceRows.map((row) => {
      const rawIds = uniqueStrings(row?.hero_list);
      const resolvedMembers = rawIds.map((sourceUnitId) => ({
        source_unit_id: sourceUnitId,
        resolution: resolveSourceChampion(catalogs, sourceUnitId),
      }));
      const lineupIds = resolvedMembers.map((member) => member.resolution?.champion_id).filter(Boolean);
      const auxiliaryUnits = rawIds
        .filter((id) => !canonicalChampionId(catalogs, id))
        .map((id) => auxiliaryRegistry.get(id) || {
          source_unit_id: id,
          source_unit_name: null,
          unit_type: "external_roster_unit",
          position: null,
          occupies_population: true,
          catalog_resolution: "unresolved_official_source_unit_preserved",
          source_declared_unit_type: "champion",
          unresolved: true,
        });
      return { row, rawIds, lineupIds, auxiliaryUnits, resolvedMembers };
    }).filter(({ rawIds, lineupIds, auxiliaryUnits }) => (
      rawIds.length >= 4
      && rawIds.length === lineupIds.length + auxiliaryUnits.length
      && auxiliaryUnits.every((unit) => unit?.unresolved !== true || unit?.source_unit_name)
    ))
      .sort((left, right) => (finiteNumber(right.row?.use_num) || 0) - (finiteNumber(left.row?.use_num) || 0)
        || left.lineupIds.join("|").localeCompare(right.lineupIds.join("|")));
    if (!rosterRows.length) continue;
    const baselineMembers = rosterRows[0].resolvedMembers.map((member) => (
      sourceChampionSemanticIdentity(member.resolution) || { unresolved_source_unit_id: member.source_unit_id }
    ));
    const candidateId = `lineup:${stableHash({
      source_semantic_traits: anchor.signature,
      baseline_members: baselineMembers,
    })}`;
    const variants = rosterRows.map(({ row, rawIds, lineupIds, auxiliaryUnits, resolvedMembers }, index) => {
      const traitContributions = resolvedMembers.flatMap((member) => (
        firstArray(member.resolution?.additional_trait_contributions).map((contribution) => ({
          ...contribution,
          trait_name: contribution.trait_name || traitName(catalogs, contribution.trait_id),
        }))
      ));
      const canonicalLineupIdentity = buildCanonicalLineupIdentity({
        championIds: lineupIds,
        champions: catalogs.champions,
        traits: catalogs.traits,
        traitContributions,
      });
      const sourceTraitSignature = sourceTraitSignatures(
        anchor.signature,
        sourceSemanticTraitSignature(row?.trait_list),
      );
      const initialTraitReconciliation = reconcileSourceTraitState(canonicalLineupIdentity, sourceTraitSignature);
      const selected = selectRecipeForRoster(recipes, lineupIds, canonicalLineupIdentity);
      const matureRecipeVariantSet = recipeVariantDifferences(recipes, lineupIds, canonicalLineupIdentity, catalogs, roleProfiles);
      const matureRecipeVariants = matureRecipeVariantSet.variants;
      const recipe = selected?.recipe || null;
      const matchClassification = selected?.match?.classification || "unmatched";
      const recipePolicy = recipeEvidencePolicy(matchClassification);
      const allowsFullRecipe = matchClassification === "exact";
      const traitStateReconciliation = explainSourceTraitGapsWithRecipeEmblems(
        initialTraitReconciliation,
        allowsFullRecipe ? recipe : null,
        resolvedMembers,
        catalogs,
      );
      const roleResolution = resolveLineupRoles({
        lineupIds,
        recipe: allowsFullRecipe ? recipe : recipe ? { ...recipe, item_assignments: [] } : null,
        catalogs,
        roleProfiles,
      });
      const mainCarryId = roleResolution.main_carry_id || null;
      const primaryTankId = roleResolution.primary_tank_id || null;
      const assignmentFor = (holderId) => recipe?.item_assignments?.find((entry) => entry.holder_id === holderId) || null;
      const carryAssignment = assignmentFor(mainCarryId);
      const tankAssignment = assignmentFor(primaryTankId);
      const rolePacket = (holderId, assignment, role) => holderId ? {
        holder_id: holderId,
        holder_name: entityName(catalogs.champions, holderId),
        published_priority_item_ids: allowsFullRecipe ? uniqueStrings(assignment?.item_ids) : [],
        published_priority_item_names: allowsFullRecipe
          ? uniqueStrings(assignment?.item_ids).map((id) => entityName(catalogs.items, id)).filter(Boolean)
          : [],
        hero_ranking_item_evidence: heroItemEvidence(heroProfilesById, holderId),
        source_interpretation: assignment && allowsFullRecipe
          ? `${recipe.source_role}_holder_items_roles_only`
          : `hard_data_${role}_inference_plus_hero_ranking_items`,
      } : null;
      const atomicRosterMembers = rawIds.map((sourceUnitId) => {
        const resolution = resolveSourceChampion(catalogs, sourceUnitId);
        if (resolution?.champion_id) {
          const additionalTraitContributions = firstArray(resolution.additional_trait_contributions)
            .map((contribution) => ({
              ...contribution,
              trait_name: contribution.trait_name || traitName(catalogs, contribution.trait_id),
            }));
          return {
            source_unit_id: sourceUnitId,
            entity_kind: "canonical_champion",
            champion_id: resolution.champion_id,
            champion_name: entityName(catalogs.champions, resolution.champion_id),
            source_semantic_identity: sourceChampionSemanticIdentity(resolution),
            additional_trait_ids: uniqueStrings(resolution.additional_trait_ids),
            additional_trait_contributions: additionalTraitContributions,
            special_trait_contributions: [
              ...firstArray(resolution.base_trait_contributions),
              ...additionalTraitContributions,
            ].filter((contribution) => contribution.value !== 1),
            population_cost: resolution.population_cost,
            occupies_population: true,
          };
        }
        const external = auxiliaryUnits.find((unit) => String(unit?.source_unit_id || "") === sourceUnitId);
        return {
          source_unit_id: sourceUnitId,
          entity_kind: external?.unit_type || "external_roster_unit",
          champion_id: null,
          champion_name: external?.source_unit_name || null,
          population_cost: external?.occupies_population === true
            ? normalizedPopulationCost(external?.population_cost)
            : 0,
          occupies_population: external?.occupies_population === true,
          catalog_resolution: external?.catalog_resolution || null,
        };
      });
      const capacityProfile = buildRosterCapacityProfile({
        atomicRosterMembers,
        canonicalLineupIdentity,
        catalogs,
        legalPopulations,
      });
      return {
        variant_id: `${candidateId}:roster:${index + 1}`,
        atomic_roster_id: atomicRosterId(candidateId, resolvedMembers.map((member) => (
          sourceChampionSemanticIdentity(member.resolution) || { unresolved_source_unit_id: member.source_unit_id }
        ))),
        roster_is_atomic: true,
        semantic_role: "national_master_plus_atomic_roster",
        semantic_role_source: "trait_group.minor_traits_datas.hero_list",
        lineup_rank: index + 1,
        population: capacityProfile.base_team_size,
        ...capacityProfile,
        lineup_ids: lineupIds,
        lineup_names: lineupIds.map((id) => entityName(catalogs.champions, id)).filter(Boolean),
        atomic_roster_members: atomicRosterMembers,
        atomic_roster_statistics: atomicRosterStatistics(row, semanticIdentity?.stat_date || null),
        source_trait_signature: sourceTraitSignature || anchor.signature,
        source_declared_trait_state: sourceTraitSignature,
        canonical_lineup_identity: canonicalLineupIdentity,
        trait_state_reconciliation: traitStateReconciliation,
        auxiliary_units: auxiliaryUnits,
        core_unit_ids: lineupIds,
        core_units: lineupIds.map((id) => ({ champion_id: id, champion_name: entityName(catalogs.champions, id) })),
        flexible_unit_ids: [],
        role_resolution: roleResolution,
        main_carry: {
          champion_id: mainCarryId,
          champion_name: entityName(catalogs.champions, mainCarryId),
          item_ids: allowsFullRecipe ? uniqueStrings(carryAssignment?.item_ids) : [],
          item_names: allowsFullRecipe ? uniqueStrings(carryAssignment?.item_ids).map((id) => entityName(catalogs.items, id)).filter(Boolean) : [],
          source_interpretation: roleResolution.main_carry.overridden
            ? "deterministic_role_arbitration"
            : recipe?.main_carry_id === mainCarryId ? `${recipe.source_role}_role_enrichment` : "hard_data_role_inference",
        },
        primary_tank: primaryTankId ? {
          champion_id: primaryTankId,
          champion_name: entityName(catalogs.champions, primaryTankId),
          item_ids: allowsFullRecipe ? uniqueStrings(tankAssignment?.item_ids) : [],
          item_names: allowsFullRecipe ? uniqueStrings(tankAssignment?.item_ids).map((id) => entityName(catalogs.items, id)).filter(Boolean) : [],
          source_interpretation: roleResolution.primary_tank.overridden
            ? "deterministic_role_arbitration"
            : recipe?.primary_tank_id === primaryTankId ? `${recipe.source_role}_role_enrichment` : "hard_data_role_inference",
        } : null,
        support_candidates: [],
        equipment_priority: {
          main_carry: rolePacket(mainCarryId, carryAssignment, "main_carry"),
          primary_tank: rolePacket(primaryTankId, tankAssignment, "primary_tank"),
          precedence: "winning_then_popular_holder_association; hero_ranking_highest_top1_then_most_popular",
        },
        main_traits: publishedTraitRows(canonicalLineupIdentity, sourceTraitSignature, catalogs.traits),
        sub_traits: [],
        trait_signature: publishedTraitSignature(canonicalLineupIdentity, sourceTraitSignature, catalogs.traits),
        associated_augment_ids: allowsFullRecipe ? uniqueStrings(recipe?.augment_ids) : [],
        associated_augments: allowsFullRecipe ? uniqueStrings(recipe?.augment_ids).map((id) => ({ augment_id: id, augment_name: entityName(catalogs.augments, id) })) : [],
        transitions: allowsFullRecipe ? recipe?.transitions || [] : [],
        transition_source_audit: allowsFullRecipe ? recipe?.transition_audit || [] : [],
        transition_unfillable: [],
        runtime_transition_gap_fill_policy: {
          source_parent_variant_id: `${candidateId}:roster:${index + 1}`,
          request_local_only: true,
          persisted_generated_nodes: 0,
        },
        positioning_template: allowsFullRecipe ? recipe?.positioning_template || null : null,
        lifecycle_prior: lifecyclePrior(mainCarryId, costs, [capacityProfile.base_team_size]),
        recipe_match: selected ? {
          source_role: recipe.source_role,
          recipe_id: recipe.recipe_id,
          freshness: selected.match.freshness || recipe.freshness || null,
          classification: selected.match.classification,
          roster_coverage: selected.match.roster_coverage,
          recipe_coverage: selected.match.recipe_coverage,
          shared_canonical_trait_count: selected.match.shared_canonical_trait_count,
          canonical_trait_identity_available: selected.match.canonical_trait_identity_available,
          canonical_trait_compatible: selected.match.canonical_trait_compatible,
          enrichment_scope: recipePolicy.use_as,
          may_replace_roster: recipePolicy.may_replace_roster,
          may_merge_variants: recipePolicy.may_merge_variants,
          may_inherit_strength: recipePolicy.may_inherit_strength,
        } : { classification: "unmatched", source_role: null, recipe_id: null },
        lineup_code: allowsFullRecipe ? recipe?.lineup_code || null : null,
        playbook: allowsFullRecipe ? recipe?.playbook || null : null,
        recipe_evidence: selected ? {
          source_role: recipe.source_role,
          recipe_id: recipe.recipe_id,
          freshness: selected.match.freshness || recipe.freshness || null,
          display_name: recipe.display_name || null,
          source_id: recipe.source_id || null,
          author: recipe.author || null,
          classification: matchClassification,
          use_as: recipePolicy.use_as,
          source_interpretation: matchClassification === "analogous"
            ? "analogous_recipe_role_reference_only"
            : "recipe_roles_items_augments_transitions_playbook_without_strength_or_roster_authority",
          allowed_fields: recipePolicy.allowed_fields,
          may_replace_roster: recipePolicy.may_replace_roster,
          may_merge_variants: recipePolicy.may_merge_variants,
          may_inherit_strength: recipePolicy.may_inherit_strength,
          evidence_boundary: recipePolicy.evidence_boundary,
        } : null,
        mature_recipe_variants: matureRecipeVariants,
        mature_recipe_variant_receipt: {
          schema: matureRecipeVariantSet.schema,
          source_count: matureRecipeVariantSet.source_count,
          retained_count: matureRecipeVariantSet.retained_count,
          truncated: matureRecipeVariantSet.truncated,
          evidence_boundary: matureRecipeVariantSet.evidence_boundary,
        },
        roster_policy: "canonical roster is immutable national Master+ trait_group evidence; recipe evidence cannot add, remove, or replace units",
        unresolved_source_unit_ids: auxiliaryUnits
          .filter((unit) => unit?.unresolved === true)
          .map((unit) => unit.source_unit_id),
      };
      return variant;
    });
    const enrichedVariants = variants.map((variant) => ({
      ...variant,
      formation_profile: buildFormationProfile(
        variant,
        variant.recipe_match?.classification === "exact"
          ? recipes.find((recipe) => recipe.recipe_id === variant.recipe_match?.recipe_id) || null
          : null,
        costs,
        catalogs,
        heroProfiles,
      ),
    }));
    const atomicVariantComparison = compareAtomicVariants(enrichedVariants, { groupIdentity: candidateId });
    const comparisonByVariantId = new Map(atomicVariantComparison.variants.map((row) => [row.variant_id, row]));
    const comparedVariants = enrichedVariants.map((variant) => {
      const compared = {
        ...variant,
        atomic_variant_difference: comparisonByVariantId.get(variant.variant_id) || null,
      };
      return {
        ...compared,
        candidate_evidence_id: candidateEvidenceId(candidateId, compared),
      };
    });
    const canonical = comparedVariants[0];
    const candidate = {
      lineup_group_id: candidateId,
      main_trait_list: publishedTraitRows(canonical.canonical_lineup_identity, anchor.signature, catalogs.traits),
      main_trait_list_secondary: [],
      source_strength_anchor: {
        ...publicStrengthAnchor(anchor),
        anchor_id: candidateId,
      },
      strength_anchor: {
        ...publicStrengthAnchor(anchor),
        anchor_id: candidateId,
        source_trait_signature: anchor.signature,
        semantic_identity_authority: "current_ranking_strength_anchor_with_current_core_roster_audit",
      },
      canonical_lineup_identity: canonical.canonical_lineup_identity,
      candidate_evidence_id: canonical.candidate_evidence_id,
      semantic_signature: {
        trait_key: canonical.canonical_lineup_identity?.key || null,
        roster_key: canonical.canonical_lineup_identity?.roster_ids?.join("|") || null,
        authority: "current_core_traits_plus_canonical_atomic_roster",
      },
      atomic_variant_comparison: atomicVariantComparison,
      mature_recipe_variants: canonical.mature_recipe_variants || [],
      mature_recipe_variant_receipt: canonical.mature_recipe_variant_receipt || {
        schema: "jcc-mature-recipe-variant-set-v1",
        source_count: 0,
        retained_count: 0,
        truncated: false,
      },
      recipe_match: canonical.recipe_match,
      recipe_evidence: canonical.recipe_match?.recipe_id ? {
        source_role: canonical.recipe_match.source_role,
        recipe_id: canonical.recipe_match.recipe_id,
        ...(canonical.recipe_evidence || {}),
      } : {
        source_role: null,
        recipe_id: null,
        source_interpretation: "no_compatible_recipe",
        ...recipeEvidencePolicy("unmatched"),
      },
      main_carry: {
        champion_id: canonical.main_carry?.champion_id || null,
        champion_name: canonical.main_carry?.champion_name || null,
        cost: costs.get(String(canonical.main_carry?.champion_id || "")) ?? null,
        source_interpretation: canonical.main_carry?.source_interpretation || null,
      },
      primary_tank: canonical.primary_tank || null,
      role_resolution: canonical.role_resolution || null,
      core_unit_ids: canonical.lineup_ids,
      core_units: canonical.core_units,
      associated_augments: canonical.associated_augments.map((entry) => ({ id: entry.augment_id, name: entry.augment_name, variant_count: 1 })),
      main_carry_item_packages: canonical.main_carry?.item_ids?.length ? [{
        population: canonical.population,
        item_ids: canonical.main_carry.item_ids,
        item_names: canonical.main_carry.item_names,
        source_interpretation: `${canonical.recipe_match?.source_role || "hard_data"}_role_item_association`,
      }] : [],
      equipment_requirements: {
        main_carry: canonical.equipment_priority.main_carry,
        primary_tank: canonical.equipment_priority.primary_tank,
        source_interpretation: "recipe_holder_association_then_national_hero_item_packages",
      },
      lifecycle_prior: canonical.lifecycle_prior,
      formation_profile: canonical.formation_profile,
      variants: comparedVariants,
      condition_priors: {
        entry_evidence: [{ kind: "national_master_plus_atomic_roster" }],
        live_failure_checks: ["hp_economy_and_stage_do_not_support_target_population", "current_board_quality_requires_a_different_immediate_action"],
        live_pivot_checks: ["another_line_has_materially_better_units_items_augments_and_tempo_fit"],
        authority: "conditions_are_queries_for_live_runtime_not_precomputed_orders",
      },
      provenance: {
        source_anchor_id: anchor.source_anchor_id,
        canonical_roster_source: "snapshot.tiers[].trait_groups[].data.minor_traits_datas[].hero_list",
        strength_source: "snapshot.tiers[].main_trait_strength",
        recipe_source: canonical.recipe_match?.source_role || null,
        recipe_metrics_used: false,
        enrichment_scope: canonical.recipe_evidence?.use_as || "none",
      },
    };
    candidate.semantic_features = compileRankingSemanticFeaturePacket(candidate, commonSemanticDocument, semanticIdentity);
    candidates.push(candidate);
  }
  return candidates;
}

function addReverseIndex(index, key, id, lineupGroupId) {
  if (!id || !lineupGroupId) return;
  const bucket = index[key];
  if (!bucket[id]) bucket[id] = [];
  bucket[id].push(lineupGroupId);
}

function buildReverseIndexes(candidates) {
  const index = { augment: {}, champion: {}, item: {}, trait: {} };
  for (const candidate of candidates) {
    const lineupGroupId = candidate.lineup_group_id;
    for (const id of candidate.core_unit_ids || []) addReverseIndex(index, "champion", id, lineupGroupId);
    if (candidate.main_carry?.champion_id) addReverseIndex(index, "champion", candidate.main_carry.champion_id, lineupGroupId);
    for (const augment of candidate.associated_augments || []) addReverseIndex(index, "augment", augment.id, lineupGroupId);
    for (const pkg of candidate.main_carry_item_packages || []) {
      for (const id of pkg.item_ids || []) addReverseIndex(index, "item", id, lineupGroupId);
    }
    for (const variant of candidate.variants || []) {
      for (const trait of variant.trait_signature?.traits || []) {
        addReverseIndex(index, "trait", trait.canonical_trait_id || trait.trait_id, lineupGroupId);
        if (trait.trait_name) addReverseIndex(index, "trait", trait.trait_name, lineupGroupId);
      }
    }
  }
  for (const bucket of Object.values(index)) {
    for (const [id, values] of Object.entries(bucket)) {
      bucket[id] = [...new Set(values)].sort();
    }
  }
  return index;
}

export function buildLiveRankingStrategyIndex(snapshot, {
  champions = [],
  roleProfiles = [],
  items = [],
  augments = [],
  traits = [],
  generatedAt = new Date().toISOString(),
  runtimeSeasonId = null,
  upstreamSeasonId = null,
  activePatchId = null,
  gameModeId = null,
  packageId = null,
  sourcePackageId = null,
  coreProfileId = null,
  hardDataManifestFingerprint = null,
  catalogSourceFingerprint = null,
  trendSummary = null,
  commonSemanticDocument = null,
  officialSourceDictionary = null,
  sourceEntityMappings = null,
  legalTransitionPopulations = [4, 5, 6, 7, 8, 9, 10],
  repoRoot = path.resolve(import.meta.dirname, ".."),
} = {}) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("live ranking snapshot is required");
  const costs = championCostMap(champions);
  const catalogs = {
    champions: entityLookup(champions, { championAliases: true }),
    items: entityLookup(items),
    augments: entityLookup(augments),
    traits: entityLookup(traits),
    sourceChampionMappings: new Map(),
  };
  const championsByName = new Map();
  for (const champion of champions) {
    const name = String(champion?.name || "").trim();
    if (!name) continue;
    championsByName.set(name, championsByName.has(name) ? null : champion);
  }
  for (const mapping of firstArray(sourceEntityMappings?.champion_mappings)) {
    const champion = catalogs.champions.get(String(mapping?.canonical_champion_id || ""));
    if (!champion) continue;
    const resolved = sourceChampionResolution(champion, {
      additionalTraitIds: [mapping?.variant_trait_id],
      mappingKind: mapping?.mapping_kind || "source_entity_mapping",
      variantTraitContribution: mapping?.variant_trait_contribution,
    });
    for (const alias of sourceAliasIds(mapping?.source_id)) catalogs.sourceChampionMappings.set(alias, resolved);
  }
  for (const [sourceId, official] of Object.entries(officialSourceDictionary?.chess?.by_source_id || {})) {
    const champion = championsByName.get(String(official?.name || "").trim());
    if (!champion) continue;
    const baseTraitIds = new Set(firstArray(champion?.traits).map((trait) => String(trait?.id || trait?.trait_id || "")));
    const additionalTraitIds = uniqueStrings(official?.core?.trait_ids).filter((traitId) => !baseTraitIds.has(traitId));
    const resolved = sourceChampionResolution(champion, {
      additionalTraitIds,
      mappingKind: additionalTraitIds.length ? "official_frontend_variant" : "official_frontend_name_identity",
    });
    for (const alias of sourceAliasIds(sourceId)) {
      if (!catalogs.sourceChampionMappings.has(alias)) catalogs.sourceChampionMappings.set(alias, resolved);
    }
  }
  if (!commonSemanticDocument) throw new Error("ranking strategy compilation requires the Common semantic feature document");
  const legalPopulations = new Set(legalTransitionPopulations.map(Number).filter(Number.isInteger));
  const tiers = {};
  for (const [tierId, tierData] of Object.entries(snapshot.tiers || {})) {
    if (String(tierId) !== "0") continue;
    const strengthAnchors = buildStrengthAnchors(tierData, catalogs, snapshot.stat_date, trendSummary);
    const heroProfiles = buildHeroProfiles(tierData, catalogs);
    const lineupCandidates = buildNationalLineupCandidates({
      strengthAnchors,
      tierData,
      catalogs,
      costs,
      legalPopulations,
      heroProfiles,
      roleProfiles,
      commonSemanticDocument,
      semanticIdentity: {
        core_profile_id: coreProfileId,
        ranking_overlay_id: null,
        stat_date: snapshot.stat_date || null,
      },
      statDate: snapshot.stat_date || null,
    });
    const candidateByAnchorId = new Map(lineupCandidates.map((candidate) => [candidate.provenance?.source_anchor_id, candidate]));
    const boundStrengthAnchors = strengthAnchors.map((anchor) => ({
      ...anchor,
      source_trait_signature: anchor.signature,
      traits: candidateByAnchorId.get(anchor.source_anchor_id)?.main_trait_list || [],
      semantic_identity_authority: "current_ranking_strength_anchor_with_current_core_roster_audit",
    }));
    const snapshotTraitFamilyIds = rankingSnapshotTraitFamilyIds(tierData);
    const strategyTraitFamilyIds = [...new Set(strengthAnchors
      .flatMap((anchor) => firstArray(anchor.traits))
      .map((trait) => String(trait?.canonical_trait_id || "").trim())
      .filter(Boolean))].sort();
    const unresolvedMainCarryIds = uniqueStrings(lineupCandidates
      .filter((candidate) => candidate.main_carry?.champion_id && !candidate.main_carry?.champion_name)
      .map((candidate) => candidate.main_carry.champion_id));
    const matchClassCounts = lineupCandidates.reduce((counts, candidate) => {
      const classification = candidate.recipe_match?.classification || "unmatched";
      counts[classification] = (counts[classification] || 0) + 1;
      return counts;
    }, {});
    tiers[tierId] = {
      label: "master_plus",
      strength_anchors: boundStrengthAnchors.map(publicStrengthAnchor),
      lineup_candidates: lineupCandidates,
      hero_market_priors: buildHeroMarketPriors(tierData),
      hero_profiles: heroProfiles,
      equipment_priors: buildEquipmentPriors(tierData),
      reverse_indexes: buildReverseIndexes(lineupCandidates),
      semantic_feature_reverse_index: Object.fromEntries([...new Set(lineupCandidates.flatMap((candidate) => candidate.semantic_features?.features || []))]
        .sort()
        .map((feature) => [feature, lineupCandidates.filter((candidate) => candidate.semantic_features?.features?.includes(feature)).map((candidate) => candidate.lineup_group_id).sort()])),
      data_quality: {
        lineup_candidate_count: lineupCandidates.length,
        strength_anchor_count: strengthAnchors.length,
        hero_profile_count: heroProfiles.length,
        match_class_counts: matchClassCounts,
        unresolved_main_carry_ids: unresolvedMainCarryIds,
        transition_nodes: lineupCandidates.reduce((counts, candidate) => {
          for (const variant of candidate.variants || []) {
            for (const transition of variant.transitions || []) {
              const key = transition.semantic_role === "published_transition" ? "published" : "filled";
              counts[key] += 1;
            }
            counts.partial_or_rejected += (variant.transition_source_audit || []).length;
            counts.unfillable += (variant.transition_unfillable || []).length;
          }
          return counts;
        }, { published: 0, filled: 0, partial_or_rejected: 0, unfillable: 0 }),
        interpretation: "unresolved_current-hard-data_entities_remain_null_and_are_never_invented",
        source_family_audit: {
          schema: "jcc-ranking-trait-source-semantic-separation-v1",
          role: "source_row_correlation_and_audit_only",
          production_semantic_binding_disabled: true,
          strategy_source_family_count: strategyTraitFamilyIds.length,
          strategy_source_family_ids: strategyTraitFamilyIds,
          snapshot_source_family_count: snapshotTraitFamilyIds.length,
          snapshot_source_family_ids: snapshotTraitFamilyIds,
          semantic_authority: "candidate.canonical_lineup_identity_and_current_core_roster_derived_traits",
          forbidden_roles: ["user_visible_trait_name", "query_key", "candidate_merge_key", "agent_semantic_identity"],
        },
        canonical_roster_authority: "national_master_plus_trait_group_minor_traits_datas_hero_list",
        recipe_metrics_authority: false,
        recipe_metric_influence: false,
        recipe_source_priority: ["winning_recipe", "popular_recipe", "role_inference"],
      },
    };
  }
  const result = {
    schema: "jcc-live-ranking-strategy-index-v3",
    generated_at: generatedAt,
    stat_date: snapshot.stat_date || null,
    source_identity: {
      runtime_season_id: runtimeSeasonId,
      active_patch_id: activePatchId,
      game_mode_id: gameModeId,
      package_id: packageId || snapshot?.static_basis?.patch_package || null,
      source_package_id: sourcePackageId || snapshot?.static_basis?.patch_package || null,
      core_profile_id: coreProfileId,
      hard_data_manifest_fingerprint: hardDataManifestFingerprint,
      catalog_source_fingerprint: catalogSourceFingerprint,
      battle_type: snapshot?.source?.battle_type || null,
      lineup_version_id: snapshot?.source?.lineup_version_id || null,
      ranking_set_id: snapshot?.source?.set_id || null,
      patch_package: snapshot?.static_basis?.patch_package || null,
      patch_version: snapshot?.static_basis?.version || null,
      upstream_season_id: upstreamSeasonId || snapshot?.static_basis?.season || null,
    },
    tiers,
    policy: {
      role: "typed_daily_big_data_evidence_not_strategy_authority",
      tier_selection: "master_plus_only_for_every_user_preference; never_use_platinum_to_diamond_or_all_tiers",
      precedence: [
        "current_match_live_state",
        "active_hard_data",
        "confirmed_choices",
        "current_match_user_intent",
        "confirmed_equipment",
        "daily_big_data_evidence",
      ],
      season_neutrality: "season_extensions_are_opaque_until_the_active_compiled_season_descriptor_interprets_them",
    },
  };
  const normalized = normalizeRankingRecipeStorage(result, { clone: false });
  if (normalized.schema !== NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA) {
    throw new Error("ranking strategy index recipe storage normalization failed");
  }
  return {
    ...normalized,
    content_fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
  };
}
