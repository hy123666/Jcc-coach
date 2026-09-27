const REQUIRED = Object.freeze([
  "candidate_id", "selected_variant_id", "candidate_evidence_id", "roster",
  "target_population", "main_carry", "main_tank", "traits", "metrics",
  "equipment", "augment_fit", "transition", "formation",
]);

export const COMPLETE_CANDIDATE_REQUIRED_FIELDS = REQUIRED;

export function validateCompleteCandidateEvidence(candidate = {}) {
  const canonical = candidate.canonical_variant || candidate.canonical || {};
  const valueFor = (key) => ({
    roster: candidate.roster || candidate.atomic_roster_members || candidate.core_units || canonical.roster || canonical.atomic_roster_members,
    target_population: candidate.target_population || candidate.target_population_size || canonical.target_population,
    main_carry: candidate.main_carry || candidate.primary_carry || canonical.main_carry,
    main_tank: candidate.main_tank || candidate.primary_tank || canonical.main_tank || canonical.primary_tank,
    traits: candidate.traits || candidate.core_traits || canonical.traits || canonical.core_traits,
    metrics: candidate.metrics || candidate.ranking_metrics || canonical.metrics || canonical.ranking_metrics,
    equipment: candidate.equipment || candidate.equipment_requirements || canonical.equipment || canonical.equipment_requirements,
    augment_fit: candidate.augment_fit || candidate.augment_evidence || canonical.augment_fit,
    transition: candidate.transition || candidate.transition_steps || candidate.transition_populations || canonical.transition,
    formation: candidate.formation || candidate.formation_profile || canonical.formation,
  })[key] ?? candidate[key];
  const missing = REQUIRED.filter((key) => {
    const value = valueFor(key);
    return value === undefined || value === null || (Array.isArray(value) && value.length === 0) || (typeof value === "string" && !value.trim());
  });
  return Object.freeze({
    ok: missing.length === 0,
    candidate_id: candidate.candidate_id || null,
    selected_variant_id: candidate.selected_variant_id || candidate.canonical_variant?.variant_id || null,
    candidate_evidence_id: candidate.candidate_evidence_id || candidate.canonical_variant?.candidate_evidence_id || null,
    missing,
  });
}

export function validateCompleteCandidateEvidenceSet(candidates = []) {
  const results = (Array.isArray(candidates) ? candidates : []).map(validateCompleteCandidateEvidence);
  return Object.freeze({ ok: results.length > 0 && results.every((result) => result.ok), results });
}
