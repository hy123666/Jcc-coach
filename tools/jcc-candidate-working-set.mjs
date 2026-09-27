// The first strategic retrieval is five candidates. A tenth candidate is
// added only when the first bounded result has a real coverage gap; visible
// breadth is a separate contract from retrieval width.
const DEFAULT_MIN_WORKING_SET = 5;
const DEFAULT_MAX_WORKING_SET = 10;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyArrayLength(value) {
  return asArray(value).filter(Boolean).length;
}

function candidatePrimaryVariant(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const variants = asArray(candidate.variants);
  const selectedId = String(
    candidate.selected_variant_id
      || candidate.query_variant_id
      || candidate.variant_id
      || "",
  ).trim();
  if (selectedId) {
    const selected = [candidate.canonical_variant, ...variants]
      .find((variant) => String(variant?.variant_id || variant?.id || "").trim() === selectedId);
    if (selected) return selected;
    return null;
  }
  if (candidate.canonical_variant && typeof candidate.canonical_variant === "object") {
    return candidate.canonical_variant;
  }
  return variants.find((variant) => variant?.roster_is_atomic === true && (
    asArray(variant?.atomic_roster_members).length
      || asArray(variant?.lineup_names).length
      || asArray(variant?.core_units).length
  )) || null;
}

function candidateRoster(candidate) {
  const primaryVariant = candidatePrimaryVariant(candidate);
  const sources = [
    candidate?.atomic_roster_members,
    candidate?.lineup_names,
    candidate?.champion_names,
    candidate?.unit_names,
    candidate?.core_units,
    primaryVariant?.atomic_roster_members,
    primaryVariant?.lineup_names,
    primaryVariant?.core_units,
  ];
  const hasIdentity = (unit) => {
    if (typeof unit === "string" || typeof unit === "number") return String(unit).trim().length > 0;
    if (!unit || typeof unit !== "object") return false;
    return [
      unit.champion_id,
      unit.champion_name,
      unit.unit_id,
      unit.source_unit_id,
      unit.id,
      unit.name,
      unit.display_name,
    ].some((value) => String(value || "").trim());
  };
  const rosterOccupancy = (roster) => roster.filter((unit) => (
    !unit || typeof unit !== "object" || unit.occupies_population !== false
  )).length;
  return sources
    .map((source, index) => ({ roster: asArray(source).filter(hasIdentity), index }))
    .filter(({ roster }) => roster.length)
    .sort((left, right) => (
      rosterOccupancy(right.roster) - rosterOccupancy(left.roster)
      || right.roster.length - left.roster.length
      || Number(right.roster.some((unit) => unit && typeof unit === "object"))
        - Number(left.roster.some((unit) => unit && typeof unit === "object"))
      || left.index - right.index
    ))[0]?.roster || [];
}

function candidatePopulation(candidate) {
  const primaryVariant = candidatePrimaryVariant(candidate);
  const value = Number(
    candidate?.target_population
      ?? candidate?.population
      ?? primaryVariant?.population,
  );
  return Number.isInteger(value) && value > 0 ? value : null;
}

function candidatePopulationOccupancy(candidate) {
  return candidateRoster(candidate).reduce((total, unit) => {
    if (!unit || typeof unit !== "object") return total + 1;
    if (unit.occupies_population === false) return total;
    const cost = Number(unit.population_cost ?? 1);
    return total + (Number.isFinite(cost) && cost >= 0 ? cost : 1);
  }, 0);
}

function candidateGroupTokens(candidate) {
  if (!candidate || typeof candidate !== "object") return [];
  return [
    candidate.candidate_id,
    candidate.lineup_group_id,
    candidate.line_id,
    candidate.id,
  ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
}

function candidateVariantTokens(candidate) {
  if (!candidate || typeof candidate !== "object") return [];
  return [
    candidate.selected_variant_id,
    candidate.variant_id,
    candidate.atomic_roster_id,
    candidate.candidate_evidence_id,
    candidate.canonical_variant?.variant_id,
    candidate.canonical_variant?.atomic_roster_id,
    candidate.canonical_variant?.candidate_evidence_id,
  ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
}

function displayTokens(candidate) {
  if (!candidate || typeof candidate !== "object") return [];
  return [candidate.name, candidate.display_name, candidate.line, candidate.target_name, candidate.lineup_name]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

function targetMatchRank(candidate, target) {
  const targetGroups = new Set(candidateGroupTokens(target));
  const candidateGroups = candidateGroupTokens(candidate);
  if (targetGroups.size) {
    if (candidateGroups.some((value) => targetGroups.has(value))) return 4;
    return 0;
  }
  const targetVariants = new Set(candidateVariantTokens(target));
  const candidateVariants = candidateVariantTokens(candidate);
  if (targetVariants.size && candidateVariants.some((value) => targetVariants.has(value))) return 4;
  const alignment = Number(candidate?.durable_target_alignment_priority || 0);
  if (Number.isFinite(alignment) && alignment >= 2) return Math.min(3, alignment);
  const targetNames = new Set(displayTokens(target));
  if (targetNames.size && displayTokens(candidate).some((value) => targetNames.has(value))) return 2;
  return 0;
}

function candidateIdentityKey(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const explicit = candidate.candidate_id || candidate.line_id || candidate.id;
  const variant = candidate.selected_variant_id
    || candidate.candidate_evidence_id
    || candidate.canonical_variant?.variant_id
    || null;
  if (explicit) return `id:${String(explicit)}${variant ? `::variant:${String(variant)}` : ""}`;
  const roster = asArray(
    candidate.atomic_roster_members
      || candidate.lineup_names
      || candidate.champion_names
      || candidate.core_units
      || candidate.canonical_variant?.lineup_names,
  )
    .map((unit) => String(unit).trim().toLowerCase())
    .filter(Boolean)
    .sort();
  const traits = asArray(candidate.main_traits)
    .map((trait) => String(trait).trim().toLowerCase())
    .filter(Boolean)
    .sort();
  if (!roster.length && !traits.length) return null;
  return `fallback:${roster.join("|")}::${traits.join("|")}::${candidate.population || ""}`;
}

function candidateCompleteness(candidate) {
  if (!candidate || typeof candidate !== "object") return -1;
  return (
    nonEmptyArrayLength(candidate.atomic_roster_members) * 6
    + nonEmptyArrayLength(candidate.lineup_names) * 5
    + nonEmptyArrayLength(candidate.champion_names) * 5
    + nonEmptyArrayLength(candidate.core_units) * 5
    + nonEmptyArrayLength(candidate.main_traits) * 2
    + nonEmptyArrayLength(candidate.variants) * 3
    + nonEmptyArrayLength(candidate.canonical_variant?.lineup_names) * 4
    + (candidate.main_carry ? 5 : 0)
    + (candidate.primary_tank ? 5 : 0)
    + (candidate.equipment_requirements ? 4 : 0)
    + (candidate.lifecycle_prior ? 4 : 0)
    + (candidate.formation_profile ? 4 : 0)
    + (candidate.roster_is_atomic === true ? 8 : 0)
  );
}

export function candidateIsCompleteAtomicVariant(candidate) {
  if (!candidate || typeof candidate !== "object") return false;
  const roster = candidateRoster(candidate);
  const population = candidatePopulation(candidate);
  const occupiedPopulation = candidatePopulationOccupancy(candidate);
  const primaryVariant = candidatePrimaryVariant(candidate);
  return Boolean(
    candidateIdentityKey(candidate)
      && roster.length > 0
      && (population !== null ? occupiedPopulation >= population : occupiedPopulation >= 3)
      && (
        candidate.roster_is_atomic === true
        || primaryVariant?.roster_is_atomic === true
      ),
  );
}

export function candidateWorkingSetLimitForDisplay(displayCount, {
  min = DEFAULT_MIN_WORKING_SET,
  max = DEFAULT_MAX_WORKING_SET,
} = {}) {
  const normalizedDisplayCount = Number.isInteger(Number(displayCount)) && Number(displayCount) > 0
    ? Number(displayCount)
    : 3;
  const lower = Math.max(1, Number(min) || DEFAULT_MIN_WORKING_SET);
  const upper = Math.max(lower, Number(max) || DEFAULT_MAX_WORKING_SET);
  const firstWorkingSet = lower;
  const expandedWorkingSet = Math.max(firstWorkingSet, normalizedDisplayCount * 2);
  return Math.min(upper, normalizedDisplayCount <= 3 ? firstWorkingSet : expandedWorkingSet);
}

export function candidateWorkingSetLimitForStrategic({
  requestedDisplayCount = 3,
  declaredLimit = 0,
  sourceCount = 0,
  fallback = DEFAULT_MIN_WORKING_SET,
  max = DEFAULT_MAX_WORKING_SET,
} = {}) {
  const displayLimit = candidateWorkingSetLimitForDisplay(requestedDisplayCount, { max });
  const declared = Number(declaredLimit);
  const source = Number(sourceCount);
  const baseline = Number(fallback);
  const upper = Math.max(1, Number(max) || DEFAULT_MAX_WORKING_SET);
  const desired = Math.max(
    displayLimit,
    Number.isFinite(declared) && declared > 0 ? declared : 0,
    Number.isFinite(baseline) && baseline > 0 ? baseline : DEFAULT_MIN_WORKING_SET,
  );
  const available = Number.isFinite(source) && source > 0 ? source : upper;
  return Math.min(upper, available, desired);
}

export function selectCandidateWorkingSetForDurableTarget(candidates, target, {
  maxComparators = 2,
} = {}) {
  const deduped = dedupeCandidateWorkingSet(candidates).filter(candidateIsCompleteAtomicVariant);
  if (!target || typeof target !== "object" || Array.isArray(target)) return deduped;
  const ranked = deduped
    .map((candidate, index) => ({ candidate, index, rank: targetMatchRank(candidate, target) }))
    .filter((entry) => entry.rank > 0)
    .sort((left, right) => right.rank - left.rank || left.index - right.index);
  if (!ranked.length) return [];
  const primary = ranked[0];
  const primaryGroups = new Set([
    primary.candidate.candidate_id,
    primary.candidate.lineup_group_id,
    primary.candidate.id,
  ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
  const comparators = ranked.slice(1).filter((entry) => {
    const groups = [entry.candidate.candidate_id, entry.candidate.lineup_group_id, entry.candidate.id]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    return entry.rank >= 3 || groups.some((value) => primaryGroups.has(value));
  }).slice(0, Math.max(0, Number(maxComparators) || 0));
  return [primary, ...comparators].map((entry) => entry.candidate);
}

export function dedupeCandidateWorkingSet(candidates) {
  const byIdentity = new Map();
  for (const candidate of asArray(candidates)) {
    if (!candidate || typeof candidate !== "object") continue;
    const key = candidateIdentityKey(candidate);
    if (!key) continue;
    const previous = byIdentity.get(key);
    if (!previous || candidateCompleteness(candidate) > candidateCompleteness(previous)) {
      byIdentity.set(key, candidate);
    }
  }
  return [...byIdentity.values()];
}

export function boundedCandidateWorkingSet(candidates, {
  displayCount = 3,
  min = DEFAULT_MIN_WORKING_SET,
  max = DEFAULT_MAX_WORKING_SET,
  limit = null,
} = {}) {
  const boundedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(Math.max(1, Number(max) || DEFAULT_MAX_WORKING_SET), Math.max(1, Number(limit)))
    : candidateWorkingSetLimitForDisplay(displayCount, { min, max });
  return dedupeCandidateWorkingSet(candidates)
    .filter(candidateIsCompleteAtomicVariant)
    .slice(0, boundedLimit);
}

export {
  DEFAULT_MIN_WORKING_SET,
  DEFAULT_MAX_WORKING_SET,
  candidateIdentityKey,
  candidateCompleteness,
};
