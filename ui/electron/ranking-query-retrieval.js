export const RANKING_QUERY_RETRIEVAL_SCHEMA = "jcc-ranking-query-retrieval-v1";

const VALID_OPERATORS = new Set(["and", "or", "not"]);
const VALID_KINDS = new Set(["trait", "champion"]);
const VALID_ROLES = new Set(["main_carry", "primary_tank", "member"]);

function firstArray(...values) {
  return values.find((value) => Array.isArray(value) && value.length)
    || values.find(Array.isArray)
    || [];
}

function normalizeIdentity(value) {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function rawSourceTraitIdentity(value) {
  return /^\d{6,8}$/u.test(normalizeIdentity(value));
}

function traitEntityIdentities(entity) {
  if (entity === null || entity === undefined) return [];
  if (typeof entity !== "object") {
    const identity = normalizeIdentity(entity);
    return identity && !rawSourceTraitIdentity(identity) ? [identity] : [];
  }
  const canonicalTraitId = normalizeIdentity(entity.canonical_trait_id || entity.check_id);
  const legacyTraitId = normalizeIdentity(entity.trait_id);
  const semanticIds = [entity.id, entity.entity_id, entity.code_id]
    .map(normalizeIdentity)
    .filter((identity) => identity && !rawSourceTraitIdentity(identity));
  return unique([
    canonicalTraitId,
    !rawSourceTraitIdentity(legacyTraitId) ? legacyTraitId : null,
    ...semanticIds,
    entity.name,
    entity.display_name,
    entity.trait_name,
    entity.family_name,
  ].map(normalizeIdentity));
}

function entityIdentities(entity) {
  if (entity === null || entity === undefined) return [];
  if (typeof entity !== "object") return [normalizeIdentity(entity)].filter(Boolean);
  const canonical = unique([
    entity.id,
    entity.entity_id,
    entity.trait_id,
    entity.canonical_trait_id,
    entity.code_id,
    entity.champion_id,
    entity.name,
    entity.display_name,
    entity.trait_name,
    entity.family_name,
    entity.champion_name,
  ].map(normalizeIdentity));
  return canonical;
}

function atomIdentities(atom) {
  if (atom?.kind === "trait") return traitEntityIdentities(atom);
  return unique([
    atom.id,
    atom.entity_id,
    atom.trait_id,
    atom.canonical_trait_id,
    atom.champion_id,
    atom.name,
    atom.display_name,
    atom.value,
  ].map(normalizeIdentity));
}

function breakpointIdentity(value) {
  if (value === null || value === undefined || value === "") return null;
  return normalizeIdentity(value);
}

function traitEntriesForVariant(variant) {
  return [
    ...firstArray(variant?.trait_signature?.traits),
    ...firstArray(variant?.main_traits),
    ...firstArray(variant?.sub_traits),
  ].map((entry) => ({
    identities: traitEntityIdentities(entry),
    breakpoint: breakpointIdentity(
      entry?.breakpoint
      ?? entry?.count
      ?? entry?.chess_num
      ?? entry?.level,
    ),
  })).filter((entry) => entry.identities.length);
}

function roleIdentities(role) {
  return new Set(entityIdentities(role));
}

function memberIdentities(variant) {
  return new Set(unique([
    ...firstArray(variant?.lineup_ids),
    ...firstArray(variant?.lineup_names),
    ...firstArray(variant?.core_unit_ids),
    ...firstArray(variant?.core_units).flatMap(entityIdentities),
    ...firstArray(variant?.members).flatMap(entityIdentities),
    ...entityIdentities(variant?.main_carry),
    ...entityIdentities(variant?.primary_tank),
  ].map(normalizeIdentity)));
}

function intersects(left, right) {
  return left.some((value) => right.has(value));
}

function atomMatchesVariant(variant, atom) {
  const identities = atomIdentities(atom);
  if (!identities.length) return false;
  if (atom.kind === "trait") {
    const requiredBreakpoint = breakpointIdentity(atom.breakpoint);
    return traitEntriesForVariant(variant).some((entry) => (
      intersects(identities, new Set(entry.identities))
      && (requiredBreakpoint === null || entry.breakpoint === requiredBreakpoint)
    ));
  }
  const role = atom.role || "member";
  const haystack = role === "main_carry"
    ? roleIdentities(variant?.main_carry)
    : role === "primary_tank"
      ? roleIdentities(variant?.primary_tank)
      : memberIdentities(variant);
  return intersects(identities, haystack);
}

function validateExpression(expression, path = "expression") {
  if (!expression || typeof expression !== "object" || Array.isArray(expression)) {
    throw new TypeError(`${path} must be an object`);
  }
  if (expression.op !== undefined) {
    if (!VALID_OPERATORS.has(expression.op)) throw new RangeError(`${path}.op must be and, or, or not`);
    if (expression.op === "not") {
      validateExpression(expression.clause, `${path}.clause`);
      return;
    }
    if (!Array.isArray(expression.clauses) || expression.clauses.length === 0) {
      throw new TypeError(`${path}.clauses must be a non-empty array`);
    }
    expression.clauses.forEach((clause, index) => validateExpression(clause, `${path}.clauses[${index}]`));
    return;
  }
  if (!VALID_KINDS.has(expression.kind)) throw new RangeError(`${path}.kind must be trait or champion`);
  if (!atomIdentities(expression).length) throw new TypeError(`${path} must identify an entity`);
  if (expression.kind === "champion" && expression.role !== undefined && !VALID_ROLES.has(expression.role)) {
    throw new RangeError(`${path}.role must be main_carry, primary_tank, or member`);
  }
}

function roleWeight(expression) {
  if (expression.op === "not") return 0;
  if (expression.op === "and") return expression.clauses.reduce((sum, clause) => sum + roleWeight(clause), 0);
  if (expression.op === "or") return Math.max(...expression.clauses.map(roleWeight));
  if (expression.kind !== "champion") return 0;
  return expression.role === "main_carry" ? 3 : expression.role === "primary_tank" ? 2 : 1;
}

function evaluate(expression, variant) {
  if (expression.op === "not") {
    const child = evaluate(expression.clause, variant);
    return {
      exact: !child.exact,
      positive_matched: 0,
      positive_total: 0,
      role_score: 0,
      violates_not: child.exact,
    };
  }
  if (expression.op === "and") {
    const children = expression.clauses.map((clause) => evaluate(clause, variant));
    return {
      exact: children.every((child) => child.exact),
      positive_matched: children.reduce((sum, child) => sum + child.positive_matched, 0),
      positive_total: children.reduce((sum, child) => sum + child.positive_total, 0),
      role_score: children.reduce((sum, child) => sum + child.role_score, 0),
      violates_not: children.some((child) => child.violates_not),
    };
  }
  if (expression.op === "or") {
    const children = expression.clauses.map((clause) => evaluate(clause, variant));
    return [...children].sort(compareEvaluations)[0];
  }
  const matched = atomMatchesVariant(variant, expression);
  return {
    exact: matched,
    positive_matched: Number(matched),
    positive_total: 1,
    role_score: matched ? roleWeight(expression) : 0,
    violates_not: false,
  };
}

function coverage(evaluation) {
  if (!evaluation.positive_total) return evaluation.exact ? 1 : 0;
  return evaluation.positive_matched / evaluation.positive_total;
}

function compareEvaluations(left, right) {
  return Number(right.exact) - Number(left.exact)
    || Number(left.violates_not) - Number(right.violates_not)
    || coverage(right) - coverage(left)
    || right.role_score - left.role_score
    || right.positive_matched - left.positive_matched
    || left.positive_total - right.positive_total;
}

export function evaluateRankingVariant(variant, expression) {
  validateExpression(expression);
  if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
    throw new TypeError("variant must be an object");
  }
  const result = evaluate(expression, variant);
  return {
    exact: result.exact,
    positive_matched: result.positive_matched,
    positive_total: result.positive_total,
    coverage: Number(coverage(result).toFixed(6)),
    role_score: result.role_score,
    violates_not: result.violates_not,
  };
}

function publishedVariants(candidate) {
  const profile = candidate?.strategy_profile || candidate;
  const variants = firstArray(profile?.variants, candidate?.variants);
  if (variants.length) return variants;
  return profile?.canonical_variant ? [profile.canonical_variant] : [];
}

function candidateId(candidate, index) {
  const id = normalizeIdentity(candidate?.id ?? candidate?.lineup_group_id ?? candidate?.candidate_id);
  if (!id) throw new TypeError(`candidate at index ${index} must have id or lineup_group_id`);
  return String(candidate?.id ?? candidate?.lineup_group_id ?? candidate?.candidate_id).normalize("NFKC").trim();
}

function nationalMasterStrength(candidate) {
  const anchor = candidate?.strategy_profile?.strength_anchor || candidate?.strength_anchor;
  if (!anchor || typeof anchor !== "object") return 0;
  const compiledCurrentDayScore = Number(anchor?.quality?.current_day_score);
  if (Number.isFinite(compiledCurrentDayScore)) return compiledCurrentDayScore;
  return 0;
}

function bestVariantMatch(candidate, expression) {
  const matches = publishedVariants(candidate).map((variant, index) => ({
    variant_id: variant?.variant_id || variant?.id || `variant-${index + 1}`,
    ...evaluateRankingVariant(variant, expression),
  }));
  return matches.sort((left, right) => (
    compareEvaluations(left, right)
    || String(left.variant_id).localeCompare(String(right.variant_id))
  ))[0] || null;
}

function compareCandidateMatches(left, right) {
  return Number(right.exact) - Number(left.exact)
    || right.coverage - left.coverage
    || right.role_score - left.role_score
    || right.national_master_strength - left.national_master_strength
    || left.id.localeCompare(right.id);
}

function compareCandidates(left, right) {
  return right.exact_group_ids.length - left.exact_group_ids.length
    || right.exact_coverage - left.exact_coverage
    || right.role_score - left.role_score
    || right.national_master_strength - left.national_master_strength
    || left.id.localeCompare(right.id);
}

export function retrieveRankingCandidates(candidates, intent) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  if (!intent || typeof intent !== "object" || !Array.isArray(intent.groups) || intent.groups.length === 0) {
    throw new TypeError("intent.groups must be a non-empty array");
  }
  const groupIds = new Set();
  const groups = intent.groups.map((group, index) => {
    const id = String(group?.id ?? `group-${index + 1}`).normalize("NFKC").trim();
    if (!id) throw new TypeError(`intent.groups[${index}].id must not be empty`);
    if (groupIds.has(id)) throw new Error(`duplicate intent group id: ${id}`);
    groupIds.add(id);
    validateExpression(group.expression, `intent.groups[${index}].expression`);
    return {
      id,
      expression: group.expression,
      source_group_id: group?.source_group_id || id,
      alternative_index: group?.alternative_index ?? null,
    };
  });

  const candidateMatches = candidates.map((candidate, index) => {
    const id = candidateId(candidate, index);
    const nationalStrength = nationalMasterStrength(candidate);
    const groupMatches = groups.map((group) => {
      const match = bestVariantMatch(candidate, group.expression);
      return {
        group_id: group.id,
        variant_id: match?.variant_id || null,
        exact: match?.exact === true,
        coverage: match?.coverage || 0,
        positive_matched: match?.positive_matched || 0,
        positive_total: match?.positive_total || 0,
        role_score: match?.role_score || 0,
        violates_not: match?.violates_not === true,
      };
    });
    return {
      id,
      display_name: candidate?.display_name || candidate?.name || id,
      national_master_strength: nationalStrength,
      exact_group_ids: groupMatches.filter((match) => match.exact).map((match) => match.group_id),
      partial_group_ids: groupMatches
        .filter((match) => !match.exact && !match.violates_not && match.positive_matched > 0)
        .map((match) => match.group_id),
      exact_coverage: groupMatches.reduce((sum, match) => sum + match.coverage, 0),
      role_score: groupMatches.reduce((sum, match) => sum + match.role_score, 0),
      group_matches: groupMatches,
    };
  });

  const groupResults = groups.map((group) => {
    const matches = candidateMatches.map((candidate) => {
      const match = candidate.group_matches.find((entry) => entry.group_id === group.id);
      return { ...match, id: candidate.id, national_master_strength: candidate.national_master_strength };
    });
    const exact = matches.filter((match) => match.exact).sort(compareCandidateMatches);
    const partial = matches
      .filter((match) => !match.exact && !match.violates_not && match.positive_matched > 0)
      .sort(compareCandidateMatches);
    return {
      id: group.id,
      source_group_id: group.source_group_id,
      alternative_index: group.alternative_index,
      status: exact.length ? "exact" : partial.length ? "partial_downgrade" : "no_match",
      downgrade_reason: exact.length ? null : partial.length ? "no_atomic_exact_match" : "no_candidate_evidence",
      exact_candidate_ids: exact.map((match) => match.id),
      partial_candidate_ids: partial.map((match) => match.id),
    };
  });

  return {
    schema: RANKING_QUERY_RETRIEVAL_SCHEMA,
    policy: "Each intent group is evaluated independently inside one published variant; evidence is never merged across variants.",
    groups: groupResults,
    candidates: candidateMatches
      .filter((candidate) => candidate.exact_group_ids.length || candidate.partial_group_ids.length)
      .sort(compareCandidates),
  };
}
