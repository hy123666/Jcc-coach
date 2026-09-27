function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstArray(value) {
  return Array.isArray(value) ? value : [];
}

function traitBreakpoints(trait) {
  return [...new Set([
    ...firstArray(trait?.num_list).map(finiteNumber),
    ...firstArray(trait?.breakpoints).map((row) => finiteNumber(row?.count ?? row?.level)),
  ].filter((value) => Number.isFinite(value) && value > 0))].sort((left, right) => left - right);
}

function traitRowsForChampion(champion) {
  const structured = firstArray(champion?.traits)
    .map((trait) => ({
      trait_id: String(trait?.id || trait?.trait_id || "").trim(),
      trait_name: trait?.name || trait?.trait_name || null,
    }))
    .filter((trait) => trait.trait_id);
  if (structured.length) return structured;
  return String(champion?.class_or_trait_codes || "")
    .split("|")
    .map((traitId) => ({ trait_id: String(traitId || "").trim(), trait_name: null }))
    .filter((trait) => trait.trait_id);
}

function semanticRow(row) {
  return {
    trait_id: row.trait_id,
    trait_name: row.trait_name,
    count: row.count,
    active_breakpoint: row.active_breakpoint,
    next_breakpoint: row.next_breakpoint,
    activated: row.activated,
  };
}

function normalizedTraitContributions(values) {
  return firstArray(values).map((entry) => ({
    trait_id: String(entry?.trait_id || entry?.id || "").trim(),
    trait_name: entry?.trait_name || entry?.name || null,
    value: finiteNumber(entry?.value ?? entry?.count ?? 1),
  })).filter((entry) => entry.trait_id && entry.value !== null && entry.value > 0);
}

export function buildCanonicalLineupIdentity({
  championIds = [],
  champions,
  traits,
  traitContributions = [],
} = {}) {
  if (!(champions instanceof Map) || !(traits instanceof Map)) {
    throw new TypeError("canonical lineup identity requires champion and trait Maps");
  }
  const counts = new Map();
  for (const championId of championIds || []) {
    const champion = champions.get(String(championId || ""));
    if (!champion) continue;
    for (const trait of traitRowsForChampion(champion)) {
      const current = counts.get(trait.trait_id) || { count: 0, trait_name: trait.trait_name };
      current.count += 1;
      if (!current.trait_name && trait.trait_name) current.trait_name = trait.trait_name;
      counts.set(trait.trait_id, current);
    }
    for (const contribution of firstArray(champion?.runtime_semantics?.trait_contributions)) {
      const traitId = String(contribution?.trait_id || "").trim();
      const value = finiteNumber(contribution?.value);
      if (!traitId || value === null || value <= 1) continue;
      const current = counts.get(traitId) || { count: 0, trait_name: null };
      current.count += value - 1;
      counts.set(traitId, current);
    }
  }
  for (const contribution of normalizedTraitContributions(traitContributions)) {
    const current = counts.get(contribution.trait_id) || {
      count: 0,
      trait_name: contribution.trait_name,
    };
    current.count += contribution.value;
    if (!current.trait_name && contribution.trait_name) current.trait_name = contribution.trait_name;
    counts.set(contribution.trait_id, current);
  }

  const observedTraits = [...counts.entries()].map(([traitId, observation]) => {
    const trait = traits.get(traitId) || null;
    const breakpoints = traitBreakpoints(trait);
    const activeBreakpoint = [...breakpoints].reverse().find((value) => value <= observation.count) ?? null;
    return {
      trait_id: traitId,
      trait_name: trait?.name || observation.trait_name || null,
      count: observation.count,
      active_breakpoint: activeBreakpoint,
      next_breakpoint: breakpoints.find((value) => value > observation.count) ?? null,
      activated: activeBreakpoint !== null,
    };
  }).sort((left, right) => (
    Number(right.activated) - Number(left.activated)
    || right.count - left.count
    || String(left.trait_name || "").localeCompare(String(right.trait_name || ""), "zh-CN")
    || left.trait_id.localeCompare(right.trait_id)
  ));
  const activeTraits = observedTraits.filter((row) => row.activated);
  return {
    schema: "jcc-canonical-lineup-identity-v1",
    authority: "current_core_roster_derived_semantics",
    observed_traits: observedTraits.map(semanticRow),
    active_traits: activeTraits.map(semanticRow),
    key: activeTraits.map((row) => `${row.trait_id}:${row.count}`).sort().join("|"),
    display_key: activeTraits
      .map((row) => `${row.trait_name || row.trait_id}${row.count}`)
      .join(" + "),
    roster_ids: [...new Set((championIds || []).map((id) => String(id || "").trim()).filter(Boolean))].sort(),
  };
}
