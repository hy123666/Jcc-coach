export const RANKING_DIRECTION_FAMILY_SCHEMA = "jcc-ranking-direction-family-v1";

const BANDS = ["s", "a", "b", "c", "d"];

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function identity(value) {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase();
}

function candidateId(candidate) {
  return String(candidate?.candidate_id || candidate?.lineup_group_id || candidate?.id || "").trim();
}

function canonicalVariant(candidate) {
  return candidate?.strategy_profile?.canonical_variant
    || candidate?.canonical_variant
    || rows(candidate?.strategy_profile?.variants)[0]
    || rows(candidate?.variants)[0]
    || null;
}

function roster(candidate) {
  const variant = canonicalVariant(candidate);
  return new Set(rows(variant?.lineup_ids).length
    ? variant.lineup_ids.map(identity).filter(Boolean)
    : rows(variant?.lineup_names).map(identity).filter(Boolean));
}

function primaryTrait(candidate) {
  const published = rows(candidate?.main_trait_list)[0] || rows(candidate?.main_traits)[0] || null;
  const signatures = rows(candidate?.strategy_profile?.strength_anchor?.source_trait_signature?.traits).length
    ? candidate.strategy_profile.strength_anchor.source_trait_signature.traits
    : rows(candidate?.strategy_profile?.strength_anchor?.traits).length
      ? candidate.strategy_profile.strength_anchor.traits
      : rows(candidate?.strength_anchor?.signature?.traits);
  const publishedName = typeof published === "string"
    ? published.replace(/\s*\d+$/u, "")
    : published?.trait_name || published?.name || null;
  const publishedKey = typeof published === "object"
    ? identity(published?.canonical_trait_id || published?.trait_id) : "";
  const matchingSignature = signatures.find((trait) => publishedKey
    ? identity(trait?.canonical_trait_id || trait?.trait_id) === publishedKey
    : publishedName && identity(trait?.trait_name || trait?.name) === identity(publishedName));
  const trait = matchingSignature || published || [...signatures].sort((left, right) =>
    Number(right?.breakpoint || right?.hero_num || right?.count || 0)
    - Number(left?.breakpoint || left?.hero_num || left?.count || 0))[0];
  if (typeof trait === "string") return { key: identity(publishedName), name: publishedName };
  return {
    key: identity(trait?.canonical_trait_id || trait?.trait_id || trait?.name || trait?.trait_name),
    name: trait?.trait_name || trait?.name || publishedName || null,
  };
}

function mainCarry(candidate) {
  const carry = candidate?.strategy_profile?.main_carry || candidate?.main_carry || canonicalVariant(candidate)?.main_carry;
  return identity(carry?.champion_id || carry?.champion_name || carry?.name || carry);
}

function strength(candidate) {
  const value = Number(candidate?.strategy_profile?.strength_anchor?.quality?.current_day_score
    ?? candidate?.strength_anchor?.quality?.current_day_score
    ?? candidate?.ranking_quality?.current_day_score);
  return Number.isFinite(value) ? value : 0;
}

function band(candidate) {
  return identity(candidate?.strategy_profile?.strength_anchor?.quality?.band
    || candidate?.strength_anchor?.quality?.band
    || candidate?.ranking_quality?.strength_band);
}

function overlap(left, right) {
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter((unit) => right.has(unit)).length;
  return shared / (left.size + right.size - shared);
}

function reference(candidate) {
  const variant = canonicalVariant(candidate);
  const traitNames = rows(candidate?.main_trait_list).length
    ? candidate.main_trait_list : rows(candidate?.main_traits);
  return {
    candidate_id: candidateId(candidate),
    variant_id: variant?.variant_id || null,
    display_name: candidate?.display_name || traitNames.map((trait) => typeof trait === "string"
      ? trait : `${trait?.trait_name || trait?.name || ""}${trait?.hero_num || trait?.breakpoint || ""}`)
      .filter(Boolean).join(" + ") || null,
    strength_band: band(candidate) || null,
    current_day_score: strength(candidate),
    sample_status: candidate?.strategy_profile?.strength_anchor?.quality?.sample_status
      || candidate?.ranking_quality?.sample_status || null,
    population: variant?.population || variant?.population_cost || variant?.target_population || null,
    main_carry: candidate?.strategy_profile?.main_carry?.champion_name
      || candidate?.main_carry?.champion_name || null,
    source_condition_status: variant?.formation_profile?.trait_completion_evidence?.status || null,
  };
}

export function annotateRankingDirectionFamilies(candidates) {
  const source = rows(candidates);
  const ordered = [...source].filter((candidate) => candidateId(candidate)).sort((left, right) =>
    strength(right) - strength(left) || candidateId(left).localeCompare(candidateId(right)));
  const families = [];
  const assignments = new Map();
  for (const candidate of ordered) {
    const trait = primaryTrait(candidate);
    const units = roster(candidate);
    const carry = mainCarry(candidate);
    const family = families.find((entry) => entry.trait.key && entry.trait.key === trait.key
      && overlap(entry.roster, units) >= 0.4);
    const selectedFamily = family || {
      id: `family:${trait.key || "unclassified"}:${candidateId(candidate)}`,
      trait, roster: units, directions: [],
    };
    if (!family) families.push(selectedFamily);
    const direction = selectedFamily.directions.find((entry) => entry.carry && entry.carry === carry
      && overlap(entry.roster, units) >= 0.55);
    const selectedDirection = direction || {
      id: `direction:${candidateId(candidate)}`,
      carry, roster: units, candidates: [],
    };
    if (!direction) selectedFamily.directions.push(selectedDirection);
    selectedDirection.candidates.push(candidate);
    assignments.set(candidateId(candidate), { family: selectedFamily, direction: selectedDirection });
  }
  return source.map((candidate) => {
    const assignment = assignments.get(candidateId(candidate));
    if (!assignment) return candidate;
    const { family, direction } = assignment;
    return {
      ...candidate,
      direction_family: {
        schema: RANKING_DIRECTION_FAMILY_SCHEMA,
        family_id: family.id,
        family_name: family.trait.name,
        direction_id: direction.id,
        same_direction_candidates: direction.candidates.filter((entry) => candidateId(entry) !== candidateId(candidate))
          .slice(0, 4).map(reference),
        other_family_directions: family.directions.filter((entry) => entry.id !== direction.id)
          .slice(0, 2).map((entry) => reference(entry.candidates[0])),
        authority: "presentation_only_independent_atomic_strength_preserved",
      },
    };
  });
}

export function selectRankingDirectionShowcase(candidates, { count = 5, bands = null, maxPerFamily = 2 } = {}) {
  const annotated = rows(candidates).every((candidate) => candidate?.direction_family)
    ? candidates : annotateRankingDirectionFamilies(candidates);
  const allowed = bands && annotated.some((candidate) => band(candidate))
    ? new Set(bands.map(identity)) : null;
  const selected = [];
  const directions = new Set();
  const familyCounts = new Map();
  for (const candidate of annotated) {
    if (allowed && !allowed.has(band(candidate))) continue;
    const familyId = candidate.direction_family.family_id;
    const directionId = candidate.direction_family.direction_id;
    if (directions.has(directionId) || (familyCounts.get(familyId) || 0) >= maxPerFamily) continue;
    selected.push(candidate);
    directions.add(directionId);
    familyCounts.set(familyId, (familyCounts.get(familyId) || 0) + 1);
    if (selected.length >= count) break;
  }
  return selected;
}

export function prioritizeRankingDirectionCoverage(candidates, options = {}) {
  const annotated = rows(candidates).every((candidate) => candidate?.direction_family)
    ? candidates : annotateRankingDirectionFamilies(candidates);
  const selected = selectRankingDirectionShowcase(annotated, { count: annotated.length, ...options });
  const seen = new Set(selected.map(candidateId));
  return [...selected, ...annotated.filter((candidate) => !seen.has(candidateId(candidate)))];
}

export function remainingRankingDirectionCandidates(candidates, shown, { bands = null } = {}) {
  const source = rows(candidates);
  const allowed = bands && source.some((candidate) => band(candidate))
    ? new Set(bands.map(identity)) : null;
  const shownIds = new Set(rows(shown).map(candidateId));
  const shownDirections = new Set(rows(shown).map((candidate) => candidate?.direction_family?.direction_id).filter(Boolean));
  return source.filter((candidate) => (!allowed || allowed.has(band(candidate)))
    && !shownIds.has(candidateId(candidate))
    && !shownDirections.has(candidate?.direction_family?.direction_id));
}

export function buildRankingBandDirectory(candidates, { perBand = 5 } = {}) {
  const annotated = annotateRankingDirectionFamilies(candidates).sort((left, right) =>
    strength(right) - strength(left) || candidateId(left).localeCompare(candidateId(right)));
  return {
    schema: "jcc-ranking-band-directory-v1",
    authority: "current_master_plus_strength_with_presentation_only_family_grouping",
    bands: BANDS.map((value) => ({
      band: value,
      total_atomic_candidates: annotated.filter((candidate) => band(candidate) === value).length,
      featured_directions: selectRankingDirectionShowcase(annotated, {
        count: perBand, bands: [value], maxPerFamily: 2,
      }).map((candidate) => ({
        ...reference(candidate),
        family_id: candidate.direction_family.family_id,
        family_name: candidate.direction_family.family_name,
        direction_id: candidate.direction_family.direction_id,
        same_direction_candidate_ids: candidate.direction_family.same_direction_candidates.map((row) => row.candidate_id),
      })),
    })),
  };
}
