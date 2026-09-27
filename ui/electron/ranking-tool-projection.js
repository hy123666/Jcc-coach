import { isDeepStrictEqual } from "node:util";

function compactItemPackage(value) {
  if (!value || typeof value !== "object") return null;
  return {
    item_ids: Array.isArray(value.item_ids) ? value.item_ids : [],
    item_names: Array.isArray(value.item_names) ? value.item_names : [],
    metrics: value.metrics || null,
  };
}

function compactEquipmentRole(value) {
  if (!value || typeof value !== "object") return value || null;
  const ranking = value.hero_ranking_item_evidence || {};
  return {
    holder_id: value.holder_id || null,
    holder_name: value.holder_name || null,
    published_priority_item_ids: value.published_priority_item_ids || [],
    published_priority_item_names: value.published_priority_item_names || [],
    observed_highest_top1_package: compactItemPackage(ranking.highest_top1_package),
    observed_most_popular_package: compactItemPackage(ranking.most_popular_package),
    source_interpretation: value.source_interpretation || null,
  };
}

function compactEquipmentRequirements(value) {
  if (!value || typeof value !== "object") return value || null;
  return {
    main_carry: compactEquipmentRole(value.main_carry),
    primary_tank: compactEquipmentRole(value.primary_tank),
    precedence: value.precedence || null,
  };
}

function compactTransitionNode(value) {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries({
    semantic_role: value.semantic_role,
    population: value.population,
    lineup_ids: value.lineup_ids,
    lineup_names: value.lineup_names,
    main_carry: value.main_carry,
    primary_tank: value.primary_tank,
    equipment_priority: value.equipment_priority,
    transfer_recommendations: value.transfer_recommendations,
    positioning_template: value.positioning_template,
    item_continuity: value.item_continuity,
  }).filter(([, entry]) => entry !== null && entry !== undefined && (!Array.isArray(entry) || entry.length)));
}

function compactFormationProfile(value) {
  if (!value || typeof value !== "object") return value || null;
  const economy = value.formation_economy_profile || {};
  const acquisition = value.acquisition_profile || {};
  const shared = value.shared_feasibility || {};
  return {
    schema: value.schema || null,
    authority: value.authority || null,
    target_population: value.target_population ?? null,
    roster_unit_count: value.roster_unit_count ?? null,
    high_cost_counts: value.high_cost_counts || null,
    contest_pressure: value.contest_pressure ? {
      score: value.contest_pressure.score ?? null,
      interpretation: value.contest_pressure.interpretation || null,
    } : null,
    transition_support: value.transition_support || null,
    explicit_requirements: value.explicit_requirements || null,
    trait_completion_evidence: value.trait_completion_evidence || null,
    formation_economy_profile: {
      roster_purchase_cost: economy.roster_purchase_cost ?? null,
      star_target_purchase_cost: economy.star_target_purchase_cost ?? null,
      target_roster_purchase_cost: economy.target_roster_purchase_cost ?? null,
      roll_and_xp_cost_requires_current_gold_level_xp: economy.roll_and_xp_cost_requires_current_gold_level_xp === true,
    },
    acquisition_profile: {
      star_targets: acquisition.star_targets || [],
      estimate_boundary: acquisition.estimate_boundary || null,
    },
    estimated_burden_score: value.estimated_burden_score ?? null,
    burden_band: value.burden_band || null,
    evidence_coverage: value.evidence_coverage ?? null,
    unknowns: value.unknowns || [],
    runtime_reconcile: value.runtime_reconcile || [],
    shared_feasibility: {
      archetype: shared.archetype || null,
      style: shared.style || null,
      stabilize_population: shared.stabilize_population ?? null,
      core_cost: shared.core_cost ?? null,
      burden_score: shared.burden_score ?? null,
      burden_band: shared.burden_band || null,
      unknowns: shared.unknowns || [],
    },
  };
}

function compactSemanticFeatures(value) {
  if (!value || typeof value !== "object") return value || null;
  const relations = Array.isArray(value.relations) ? value.relations : [];
  const uniqueRelations = new Set(relations.map((relation) => JSON.stringify([
    relation?.type,
    relation?.target_kind,
    relation?.target_id,
    relation?.variant_id || relation?.scope?.variant_id || relation?.owner_variant_id || null,
    relation?.scope || null,
    relation?.owner_id || relation?.source_id || null,
    relation?.condition || relation?.conditions || null,
  ])));
  return {
    schema: value.schema || null,
    scope: value.scope || null,
    features: [...new Set(Array.isArray(value.features) ? value.features : [])],
    conditions: value.conditions || null,
    policy: value.policy || null,
    relation_index: {
      expanded: false,
      source_count: relations.length,
      unique_count: uniqueRelations.size,
      next_operation: "get_related_entities",
    },
  };
}

function recipeVariantRef(value) {
  return {
    recipe_id: value?.recipe_id || null,
    display_name: value?.display_name || null,
    classification: value?.classification || null,
    removed_from_standard_names: value?.removed_from_standard_names || [],
    added_by_recipe_names: value?.added_by_recipe_names || [],
    main_carry_name: value?.main_carry_name || null,
    primary_tank_name: value?.primary_tank_name || null,
    use_as: value?.use_as || null,
  };
}

function compactUnitRefs(ids, names, objects) {
  const idList = Array.isArray(ids) ? ids : [];
  const nameList = Array.isArray(names) ? names : [];
  const objectList = Array.isArray(objects) ? objects : [];
  const length = Math.min(8, Math.max(idList.length, nameList.length, objectList.length));
  return Array.from({ length }, (_, index) => {
    const object = objectList[index];
    const unitId = idList[index] ?? (typeof object === "object" ? object?.unit_id || object?.champion_id || object?.id : object);
    const unitName = nameList[index] ?? (typeof object === "object" ? object?.unit_name || object?.champion_name || object?.name : null);
    return { unit_id: unitId || null, unit_name: unitName || null };
  }).filter((unit) => unit.unit_id || unit.unit_name);
}

function compactReplacedUnits(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    return {
      from_id: entry.from_id || entry.removed_id || entry.old_id || null,
      from_name: entry.from_name || entry.removed_name || entry.old_name || null,
      to_id: entry.to_id || entry.added_id || entry.new_id || null,
      to_name: entry.to_name || entry.added_name || entry.new_name || null,
    };
  });
}

function compactVariantDifference(value) {
  if (!value || typeof value !== "object") return null;
  const difference = {
    variant_type: value.variant_type || null,
    population_delta: value.population_delta ?? null,
    added_units: compactUnitRefs(value.added_unit_ids, value.added_unit_names, value.added_units),
    removed_units: compactUnitRefs(value.removed_unit_ids, value.removed_unit_names, value.removed_units),
    replaced_units: compactReplacedUnits(value.replaced_units),
    replaced_unit_names: Array.isArray(value.replaced_unit_names) ? value.replaced_unit_names.slice(0, 8) : [],
    same_roster_different_trait_state: value.same_roster_different_trait_state === true,
    top4_delta_vs_baseline: value.top4_delta_vs_baseline ?? null,
    top1_delta_vs_baseline: value.top1_delta_vs_baseline ?? null,
  };
  return Object.fromEntries(Object.entries(difference).filter(([, entry]) => (
    entry !== null && entry !== false && (!Array.isArray(entry) || entry.length > 0)
  )));
}

function siblingVariantRef(candidate, value) {
  const reference = {
    candidate_id: candidate?.candidate_id || candidate?.id || null,
    selected_variant_id: value?.variant_id || null,
    candidate_evidence_id: value?.candidate_evidence_id || null,
    display_name: value?.display_name || value?.name || null,
    population: value?.population ?? null,
    atomic_variant_difference: compactVariantDifference(value?.atomic_variant_difference),
    detail_retrieval: "get_lineup",
  };
  return Object.fromEntries(Object.entries(reference).filter(([, entry]) => (
    entry !== null && entry !== undefined && (!Array.isArray(entry) || entry.length > 0)
  )));
}

// Aliases are relative to this candidate, never to an earlier tool response.
export function projectRankingToolCandidate(input) {
  const candidate = structuredClone(input);
  const profile = candidate.strategy_profile;
  if (!profile?.canonical_variant) return candidate;
  const canonical = profile.canonical_variant;
  profile.semantic_features = compactSemanticFeatures(profile.semantic_features);
  candidate.semantic_features = compactSemanticFeatures(candidate.semantic_features);
  profile.equipment_requirements = compactEquipmentRequirements(profile.equipment_requirements);
  delete profile.hero_market_and_item_profile;
  delete profile.primary_tank_item_evidence_by_champion;
  delete profile.main_carry_item_packages;
  delete profile.provenance;
  delete profile.evidence_boundary;
  profile.formation_profile = compactFormationProfile(profile.formation_profile);
  canonical.formation_profile = compactFormationProfile(canonical.formation_profile);
  canonical.transition_chain = Array.isArray(canonical.transition_chain)
    ? canonical.transition_chain.map(compactTransitionNode)
    : canonical.transition_chain;
  canonical.mature_recipe_variant_refs = Array.isArray(canonical.mature_recipe_variants)
    ? canonical.mature_recipe_variants.map(recipeVariantRef)
    : [];
  delete canonical.mature_recipe_variants;
  delete canonical.recipe_evidence;
  delete canonical.canonical_lineup_identity;
  delete canonical.lineup_ids;
  delete canonical.lineup_names;
  delete canonical.core_unit_names;
  delete canonical.roster_policy;
  delete canonical.semantic_role_source_ref;
  delete canonical.lifecycle_prior_ref;
  delete canonical.evidence_boundary;
  delete canonical.provenance;
  const aliases = {};
  const internFields = (source, target, sourcePrefix, targetPrefix) => {
    for (const [key, value] of Object.entries(source)) {
      if (!value || typeof value !== "object" || !Object.hasOwn(target, key)) continue;
      if (isDeepStrictEqual(value, target[key])) {
        aliases[`${sourcePrefix}${key}`] = `${targetPrefix}${key}`;
        delete source[key];
      }
    }
  };
  internFields(candidate, profile, "", "strategy_profile.");
  internFields(profile, canonical, "strategy_profile.", "strategy_profile.canonical_variant.");
  if (Array.isArray(profile.sibling_variants)) {
    candidate.available_variant_refs = profile.sibling_variants.map((variant) => siblingVariantRef(candidate, variant));
    delete profile.sibling_variants;
  }
  if (Object.keys(aliases).length) candidate.field_aliases = aliases;
  return candidate;
}

export function restoreRankingToolCandidate(input) {
  const candidate = structuredClone(input);
  const aliases = candidate.field_aliases || {};
  const resolving = new Set();
  const resolve = (path) => {
    if (resolving.has(path)) throw new Error("ranking_tool_field_alias_cycle");
    if (Object.hasOwn(aliases, path)) {
      resolving.add(path);
      const value = resolve(aliases[path]);
      resolving.delete(path);
      return value;
    }
    return path.split(".").reduce((value, key) => value?.[key], candidate);
  };
  for (const [path, target] of Object.entries(aliases)) {
    const keys = path.split(".");
    const key = keys.pop();
    const container = keys.reduce((value, part) => value?.[part], candidate);
    if (!container || ["__proto__", "constructor", "prototype"].some(part => path.split(".").includes(part))) {
      throw new Error("ranking_tool_field_alias_invalid");
    }
    container[key] = structuredClone(resolve(target));
  }
  delete candidate.field_aliases;
  return candidate;
}
