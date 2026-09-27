function firstArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sortedUnique(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function metricDelta(value, baseline) {
  const current = finiteNumber(value);
  const base = finiteNumber(baseline);
  return current === null || base === null ? null : Number((current - base).toFixed(6));
}

function unitNameMap(variants) {
  const names = new Map();
  for (const variant of firstArray(variants)) {
    for (const unit of firstArray(variant?.atomic_roster_members)) {
      const id = String(unit?.source_unit_id || unit?.champion_id || unit?.id || "").trim();
      const name = String(unit?.champion_name || unit?.source_unit_name || unit?.name || "").trim();
      if (id && name) names.set(id, name);
    }
    for (const unit of firstArray(variant?.core_units)) {
      const id = String(unit?.champion_id || unit?.id || "").trim();
      const name = String(unit?.champion_name || unit?.name || "").trim();
      if (id && name) names.set(id, name);
    }
    const ids = firstArray(variant?.lineup_ids);
    const lineupNames = firstArray(variant?.lineup_names);
    ids.forEach((id, index) => {
      const normalizedId = String(id || "").trim();
      const name = String(lineupNames[index] || "").trim();
      if (normalizedId && name) names.set(normalizedId, name);
    });
  }
  return names;
}

function namesFor(ids, names) {
  return firstArray(ids).map((id) => names.get(id) || id);
}

function populationRosterMembers(variant) {
  const members = firstArray(variant?.atomic_roster_members)
    .filter((member) => member?.occupies_population !== false)
    .map((member) => {
      const championId = String(member?.champion_id || "").trim();
      const sourceUnitId = String(member?.source_unit_id || member?.id || "").trim();
      const identity = championId ? `champion:${championId}` : sourceUnitId ? `source:${sourceUnitId}` : "";
      const name = String(member?.champion_name || member?.source_unit_name || member?.name || "").trim();
      return identity ? { identity, name: name || identity } : null;
    })
    .filter(Boolean);
  if (members.length) return members;
  const originalIds = firstArray(variant?.lineup_ids);
  const originalNames = firstArray(variant?.lineup_names);
  const namesById = new Map(originalIds.map((id, index) => [
    String(id || "").trim(),
    String(originalNames[index] || "").trim(),
  ]));
  return sortedUnique(originalIds).map((id) => ({
    identity: `champion:${id}`,
    name: namesById.get(id) || id,
  }));
}

function declaredVariantGroupIdentity(variant) {
  return String(
    variant?.lineup_group_id
      || variant?.candidate_id
      || variant?.source_anchor_id
      || variant?.group_id
      || "",
  ).trim();
}

function semanticTraitStateKey(variant) {
  const canonicalKey = String(variant?.canonical_lineup_identity?.key || "").trim();
  const emblemState = firstArray(variant?.formation_required_emblems)
    .map((row) => ({
      holder_id: String(row?.holder_id || row?.champion_id || "").trim() || null,
      granted_trait_id: String(row?.granted_trait_id || row?.trait_id || "").trim() || null,
      required: row?.required === true,
    }))
    .filter((row) => row.holder_id || row.granted_trait_id)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const explicitState = variant?.explicit_trait_state
    || variant?.season_extensions?.trait_state
    || variant?.season_extensions?.chosen_data?.trait_state
    || null;
  return JSON.stringify({ canonical_key: canonicalKey || null, emblems: emblemState, explicit_state: explicitState });
}

export function compareAtomicVariants(variants = [], { groupIdentity = null } = {}) {
  const rows = firstArray(variants);
  if (!rows.length) return { schema: "jcc-atomic-variant-comparison-v1", baseline_variant_id: null, variants: [] };
  const expectedGroupIdentity = String(groupIdentity || "").trim();
  if (!expectedGroupIdentity) throw new Error("atomic variant comparison requires an explicit group identity");
  const conflictingGroupIdentities = sortedUnique(rows.map(declaredVariantGroupIdentity).filter(Boolean))
    .filter((identity) => identity !== expectedGroupIdentity);
  if (conflictingGroupIdentities.length) {
    throw new Error(`atomic variant comparison cannot cross lineup groups: expected ${expectedGroupIdentity}, received ${conflictingGroupIdentities.join(", ")}`);
  }
  const names = unitNameMap(rows);
  const baseline = rows[0];
  const baselineMembers = populationRosterMembers(baseline);
  const baselineIds = sortedUnique(baselineMembers.map((member) => member.identity));
  const memberNames = new Map(baselineMembers.map((member) => [member.identity, member.name]));
  for (const row of rows.slice(1)) {
    for (const member of populationRosterMembers(row)) memberNames.set(member.identity, member.name);
  }
  const baselineStats = baseline?.atomic_roster_statistics || {};
  const comparisons = rows.map((variant, index) => {
    const variantMembers = populationRosterMembers(variant);
    const variantIds = sortedUnique(variantMembers.map((member) => member.identity));
    const removed = difference(baselineIds, variantIds);
    const added = difference(variantIds, baselineIds);
    const removedNames = removed.map((id) => memberNames.get(id) || id.replace(/^(?:champion|source):/u, ""));
    const addedNames = added.map((id) => memberNames.get(id) || id.replace(/^(?:champion|source):/u, ""));
    const sameRoster = removed.length === 0 && added.length === 0;
    const population = finiteNumber(variant?.population) ?? variantIds.length;
    const baselinePopulation = finiteNumber(baseline?.population) ?? baselineIds.length;
    const stats = variant?.atomic_roster_statistics || {};
    const sameRosterDifferentTraitState = index > 0
      && sameRoster
      && semanticTraitStateKey(variant) !== semanticTraitStateKey(baseline);
    const oneForOneReplacement = removed.length > 0 && removed.length === added.length;
    const samePopulationRosterCardinalityChange = population === baselinePopulation
      && removed.length > 0
      && added.length > 0
      && !oneForOneReplacement;
    let variantType = index === 0 ? "baseline_complete"
      : sameRosterDifferentTraitState ? "emblem_or_special_state"
        : sameRoster ? "same_roster_statistical_state"
        : population < baselinePopulation ? "lower_population_variant"
          : population > baselinePopulation ? "higher_population_cap"
            : samePopulationRosterCardinalityChange ? "roster_cardinality_change"
              : "same_population_replacement";
    const sampleCount = finiteNumber(stats?.use_num);
    if (index > 0 && sampleCount !== null && sampleCount < 30) variantType = "low_sample_observation";
    return {
      schema: "jcc-atomic-variant-difference-v1",
      baseline_variant_id: baseline?.variant_id || null,
      variant_id: variant?.variant_id || null,
      variant_type: variantType,
      population_count: population,
      population_delta: population - baselinePopulation,
      added_unit_ids: added.map((id) => id.replace(/^(?:champion|source):/u, "")),
      removed_unit_ids: removed.map((id) => id.replace(/^(?:champion|source):/u, "")),
      added_unit_names: addedNames,
      removed_unit_names: removedNames,
      added_units: added.map((id) => id.replace(/^(?:champion|source):/u, "")),
      removed_units: removed.map((id) => id.replace(/^(?:champion|source):/u, "")),
      replaced_units: oneForOneReplacement
        ? {
            removed: removed.map((id) => id.replace(/^(?:champion|source):/u, "")),
            added: added.map((id) => id.replace(/^(?:champion|source):/u, "")),
          }
        : null,
      replaced_unit_names: oneForOneReplacement
        ? { removed: removedNames, added: addedNames }
        : null,
      same_roster_different_trait_state: sameRosterDifferentTraitState,
      source_signature_differs: index > 0
        && String(variant?.source_trait_signature?.key || "") !== String(baseline?.source_trait_signature?.key || ""),
      sample_count: sampleCount,
      sample_count_delta_vs_baseline: metricDelta(stats?.use_num, baselineStats?.use_num),
      appearance_rate: finiteNumber(stats?.use_rate),
      top4_rate: finiteNumber(stats?.top4_rate),
      top1_rate: finiteNumber(stats?.top1_rate),
      top4_delta_vs_baseline: metricDelta(stats?.top4_rate, baselineStats?.top4_rate),
      top1_delta_vs_baseline: metricDelta(stats?.top1_rate, baselineStats?.top1_rate),
      appearance_delta_vs_baseline: metricDelta(stats?.use_rate, baselineStats?.use_rate),
      evidence_boundary: "descriptive_atomic_roster_observation_not_universal_unit_value",
      source_signature_boundary: "raw_source_family_differences_are_audit_only_and_never_prove_emblem_or_special_state",
    };
  });
  return {
    schema: "jcc-atomic-variant-comparison-v1",
    group_identity: expectedGroupIdentity,
    baseline_variant_id: baseline?.variant_id || null,
    baseline_population: finiteNumber(baseline?.population) ?? baselineIds.length,
    variants: comparisons,
    authority: "deterministic_member_population_and_current_day_atomic_statistics_only",
  };
}
