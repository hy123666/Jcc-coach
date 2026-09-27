export const RANKING_EMBLEM_PLAN_SCHEMA = "jcc-ranking-emblem-plan-v1";

const DEFAULT_LIMITS = Object.freeze({
  beam_width: 64,
  max_plans_per_variant: 8,
  max_emblem_copies: 12,
  max_holders: 12,
  max_variants: 48,
  max_expanded_states: 20_000,
  max_emblems_per_holder: 3,
});

function text(value, label) {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw new RangeError(`${label} must be an integer from ${min} to ${max}`);
  }
  return normalized;
}

function uniqueTexts(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = text(value, label);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeLimits(liveConstraints = {}) {
  const source = liveConstraints?.limits || {};
  return Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, fallback]) => [
    key,
    integer(source[key] ?? fallback, `liveConstraints.limits.${key}`, { min: 1, max: fallback }),
  ]));
}

function normalizeTraitCatalog(rows) {
  if (!Array.isArray(rows)) throw new TypeError("traitCatalog must be an array");
  const grouped = new Map();
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new TypeError(`traitCatalog[${index}] must be an object`);
    }
    const traitId = text(row.trait_id ?? row.id, `traitCatalog[${index}].trait_id`);
    const rawBreakpoints = row.breakpoints ?? row.breakpoint_counts;
    if (!Array.isArray(rawBreakpoints) || !rawBreakpoints.length) {
      throw new TypeError(`trait ${traitId} must provide breakpoints`);
    }
    const breakpoints = rawBreakpoints.map((entry, breakpointIndex) => {
      const object = typeof entry === "number" ? { count: entry } : entry;
      if (!object || typeof object !== "object" || Array.isArray(object)) {
        throw new TypeError(`trait ${traitId} breakpoint ${breakpointIndex} must be an object or number`);
      }
      return {
        count: integer(object.count ?? object.breakpoint ?? object.hero_num, `trait ${traitId} breakpoint count`, { min: 1 }),
        tier: object.tier == null && object.label == null ? null : text(object.tier ?? object.label, `trait ${traitId} breakpoint tier`),
        prismatic: object.prismatic === true || String(object.tier ?? object.label ?? "").toLowerCase() === "prismatic",
      };
    }).sort((left, right) => left.count - right.count || String(left.tier).localeCompare(String(right.tier)));
    if (new Set(breakpoints.map(({ count }) => count)).size !== breakpoints.length) {
      throw new Error(`trait ${traitId} has duplicate breakpoint counts`);
    }
    const normalized = { trait_id: traitId, trait_name: row.name == null ? null : String(row.name), breakpoints };
    grouped.set(traitId, [...(grouped.get(traitId) || []), normalized]);
  }
  return grouped;
}

function resolveTrait(traits, traitId) {
  const matches = traits.get(traitId) || [];
  if (matches.length !== 1) {
    throw new Error(`granted trait ${traitId} must resolve to exactly one active trait catalog row`);
  }
  return matches[0];
}

function normalizeNaturalTraits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("championNaturalTraits must be an object or Map");
  }
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return new Map(entries.map(([championId, traitIds]) => [
    text(championId, "champion id"),
    new Set(uniqueTexts(traitIds, `natural traits for ${championId}`)),
  ]));
}

function normalizeEmblems(rows, traits, maxCopies) {
  if (!Array.isArray(rows)) throw new TypeError("confirmedEmblems must be an array");
  const totals = new Map();
  const grantsByEmblem = new Map();
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new TypeError(`confirmedEmblems[${index}] must be an object`);
    }
    const emblemId = text(row.emblem_id ?? row.item_id ?? row.id, `confirmedEmblems[${index}].emblem_id`);
    const traitId = text(row.granted_trait_id, `confirmedEmblems[${index}].granted_trait_id`);
    resolveTrait(traits, traitId);
    const quantity = integer(row.quantity ?? 1, `confirmedEmblems[${index}].quantity`, { min: 1, max: maxCopies });
    if (grantsByEmblem.has(emblemId) && grantsByEmblem.get(emblemId) !== traitId) {
      throw new Error(`emblem ${emblemId} has conflicting granted traits`);
    }
    grantsByEmblem.set(emblemId, traitId);
    const key = `${emblemId}\u0000${traitId}`;
    totals.set(key, (totals.get(key) || 0) + quantity);
  }
  const totalCopies = [...totals.values()].reduce((sum, quantity) => sum + quantity, 0);
  if (totalCopies > maxCopies) throw new RangeError(`confirmed emblem copies exceed ${maxCopies}`);
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, quantity]) => {
      const [emblemId, traitId] = key.split("\u0000");
      return Array.from({ length: quantity }, (_, copy) => ({ emblem_id: emblemId, trait_id: traitId, copy: copy + 1 }));
    });
}

function normalizeVariants(candidates, naturalTraits, traits, maxHolders, maxVariants) {
  if (!Array.isArray(candidates)) throw new TypeError("lineupCandidates must be an array");
  const result = [];
  for (const [candidateIndex, candidate] of candidates.entries()) {
    const candidateId = text(candidate?.candidate_id ?? candidate?.id, `lineupCandidates[${candidateIndex}].candidate_id`);
    const variants = Array.isArray(candidate?.variants)
      ? candidate.variants
      : candidate?.canonical_variant ? [candidate.canonical_variant] : [];
    if (!variants.length) throw new TypeError(`candidate ${candidateId} must provide variants or canonical_variant`);
    for (const [variantIndex, variant] of variants.entries()) {
      const variantId = text(variant?.variant_id ?? variant?.id ?? `${candidateId}:variant:${variantIndex}`, `variant id for ${candidateId}`);
      const roster = uniqueTexts(variant?.roster ?? variant?.unit_ids ?? variant?.units, `roster for ${variantId}`);
      if (!roster.length || roster.length > maxHolders) throw new RangeError(`variant ${variantId} roster must contain 1 to ${maxHolders} champions`);
      for (const championId of roster) {
        if (!naturalTraits.has(championId)) throw new Error(`champion ${championId} is missing from championNaturalTraits`);
        for (const traitId of naturalTraits.get(championId)) resolveTrait(traits, traitId);
      }
      const requirements = (variant.formation_required_emblems || []).map((requirement, requirementIndex) => ({
        emblem_id: requirement.emblem_id == null ? null : text(requirement.emblem_id, `requirement emblem ${requirementIndex}`),
        trait_id: text(requirement.granted_trait_id ?? requirement.trait_id, `requirement trait ${requirementIndex}`),
        holder_id: text(requirement.holder_id, `requirement holder ${requirementIndex}`),
      }));
      for (const requirement of requirements) {
        resolveTrait(traits, requirement.trait_id);
        if (!roster.includes(requirement.holder_id)) throw new Error(`formation requirement holder ${requirement.holder_id} is outside variant ${variantId}`);
        if (naturalTraits.get(requirement.holder_id).has(requirement.trait_id)) {
          throw new Error(`formation requirement ${requirement.trait_id} is illegal on natural holder ${requirement.holder_id}`);
        }
      }
      result.push({ candidate_id: candidateId, variant_id: variantId, roster, requirements });
      if (result.length > maxVariants) throw new RangeError(`lineup variants exceed ${maxVariants}`);
    }
  }
  return result;
}

function normalizeConstraints(value, roster, defaultCapacity) {
  const constraints = value && typeof value === "object" ? value : {};
  const forbidden = new Set(uniqueTexts(constraints.forbidden_holders || [], "forbidden holders"));
  const capacities = new Map();
  for (const holderId of roster) {
    const configured = constraints.holder_emblem_capacity?.[holderId];
    capacities.set(holderId, configured == null
      ? defaultCapacity
      : integer(configured, `holder capacity for ${holderId}`, { min: 0, max: defaultCapacity }));
  }
  return { forbidden, capacities };
}

function baseTraitCounts(roster, naturalTraits) {
  const counts = new Map();
  for (const championId of roster) {
    for (const traitId of naturalTraits.get(championId)) counts.set(traitId, (counts.get(traitId) || 0) + 1);
  }
  return counts;
}

function reachedBreakpoints(trait, count) {
  return trait.breakpoints.filter((breakpoint) => breakpoint.count <= count);
}

function stateEvaluation(state, baseCounts, traits) {
  const traitIds = new Set([...baseCounts.keys(), ...state.assignments.map(({ trait_id }) => trait_id)]);
  const trait_results = [...traitIds].sort().map((traitId) => {
    const trait = resolveTrait(traits, traitId);
    const base_count = baseCounts.get(traitId) || 0;
    const emblem_count = state.assignments.filter((assignment) => assignment.trait_id === traitId).length;
    const final_count = base_count + emblem_count;
    const before = reachedBreakpoints(trait, base_count);
    const after = reachedBreakpoints(trait, final_count);
    return {
      trait_id: traitId,
      base_count,
      emblem_count,
      final_count,
      gained_breakpoints: after.slice(before.length),
      highest_reached_breakpoint: after.at(-1) || null,
    };
  });
  return {
    trait_results,
    breakpoint_gain_count: trait_results.reduce((sum, result) => sum + result.gained_breakpoints.length, 0),
    prismatic_gain_count: trait_results.reduce((sum, result) => sum
      + result.gained_breakpoints.filter(({ prismatic }) => prismatic).length, 0),
  };
}

function requirementFor(requirements, emblem, holderId) {
  return requirements.find((requirement) => requirement.holder_id === holderId
    && requirement.trait_id === emblem.trait_id
    && (requirement.emblem_id == null || requirement.emblem_id === emblem.emblem_id)) || null;
}

function stateKey(state) {
  return state.assignments.map(({ emblem_id, copy, holder_id }) => `${emblem_id}:${copy}:${holder_id}`).join("|")
    + `|unused:${state.unused.map(({ emblem_id, copy }) => `${emblem_id}:${copy}`).join(",")}`;
}

function compareStates(left, right, baseCounts, traits) {
  const leftEval = stateEvaluation(left, baseCounts, traits);
  const rightEval = stateEvaluation(right, baseCounts, traits);
  return right.required_satisfied - left.required_satisfied
    || rightEval.prismatic_gain_count - leftEval.prismatic_gain_count
    || rightEval.breakpoint_gain_count - leftEval.breakpoint_gain_count
    || left.assignments.length - right.assignments.length
    || stateKey(left).localeCompare(stateKey(right));
}

function planVariant(variant, emblemCopies, naturalTraits, traits, liveConstraints, limits) {
  const baseCounts = baseTraitCounts(variant.roster, naturalTraits);
  const constraints = normalizeConstraints(liveConstraints, variant.roster, limits.max_emblems_per_holder);
  const requirementsByTrait = new Map();
  for (const requirement of variant.requirements) {
    const key = `${requirement.emblem_id || "*"}|${requirement.trait_id}`;
    requirementsByTrait.set(key, [...(requirementsByTrait.get(key) || []), requirement]);
  }
  for (const [key, requirements] of requirementsByTrait) {
    const [emblemId, traitId] = key.split("|");
    const available = emblemCopies.filter((emblem) => emblem.trait_id === traitId
      && (emblemId === "*" || emblem.emblem_id === emblemId)).length;
    if (available < requirements.length) return { plans: [], expanded_states: 0, truncated: false };
  }

  let states = [{ assignments: [], unused: [], holder_counts: new Map(), required_satisfied: 0 }];
  let expandedStates = 0;
  let truncated = false;
  for (const [emblemIndex, emblem] of emblemCopies.entries()) {
    const next = [];
    for (const state of states) {
      const matchingRequirements = variant.requirements.filter((requirement) => requirement.trait_id === emblem.trait_id
        && (requirement.emblem_id == null || requirement.emblem_id === emblem.emblem_id)
        && !state.assignments.some((assignment) => assignment.requirement_holder_id === requirement.holder_id));
      const options = matchingRequirements.length
        ? matchingRequirements.map(({ holder_id }) => holder_id)
        : [...variant.roster, null];
      for (const holderId of options) {
        if (expandedStates >= limits.max_expanded_states) {
          truncated = true;
          break;
        }
        expandedStates += 1;
        if (holderId == null) {
          next.push({ ...state, unused: [...state.unused, emblem] });
          continue;
        }
        if (constraints.forbidden.has(holderId) || naturalTraits.get(holderId).has(emblem.trait_id)) continue;
        if ((state.holder_counts.get(holderId) || 0) >= constraints.capacities.get(holderId)) continue;
        if (state.assignments.some((assignment) => assignment.holder_id === holderId && assignment.trait_id === emblem.trait_id)) continue;
        const requirement = requirementFor(variant.requirements, emblem, holderId);
        const holderCounts = new Map(state.holder_counts);
        holderCounts.set(holderId, (holderCounts.get(holderId) || 0) + 1);
        next.push({
          assignments: [...state.assignments, {
            emblem_id: emblem.emblem_id,
            emblem_copy: emblem.copy,
            granted_trait_id: emblem.trait_id,
            trait_id: emblem.trait_id,
            holder_id: holderId,
            evidence_kind: requirement ? "published_formation_required" : "rule_derived",
            requirement_holder_id: requirement?.holder_id || null,
          }],
          unused: state.unused,
          holder_counts: holderCounts,
          required_satisfied: state.required_satisfied + (requirement ? 1 : 0),
        });
      }
      if (truncated) break;
    }
    states = next.sort((left, right) => compareStates(left, right, baseCounts, traits)).slice(0, limits.beam_width);
    if (truncated) {
      const remaining = emblemCopies.slice(emblemIndex + 1);
      states = states.map((state) => ({ ...state, unused: [...state.unused, ...remaining] }));
      break;
    }
    if (!states.length) break;
  }

  return {
    expanded_states: expandedStates,
    truncated,
    plans: states
      .filter((state) => state.required_satisfied === variant.requirements.length)
      .sort((left, right) => compareStates(left, right, baseCounts, traits))
      .slice(0, limits.max_plans_per_variant)
      .map((state, index) => {
        const evaluation = stateEvaluation(state, baseCounts, traits);
        const evidenceKinds = new Set(state.assignments.map(({ evidence_kind }) => evidence_kind));
        return {
          plan_rank: index + 1,
          derivation_kind: evidenceKinds.size > 1 ? "mixed" : evidenceKinds.has("published_formation_required")
            ? "published_formation_required" : "rule_derived",
          assignments: state.assignments.map(({ requirement_holder_id: _ignored, ...assignment }) => assignment),
          unused_emblems: state.unused.map((emblem) => ({
            emblem_id: emblem.emblem_id,
            emblem_copy: emblem.copy,
            granted_trait_id: emblem.trait_id,
          })),
          trait_results: evaluation.trait_results,
          breakpoint_gain_count: evaluation.breakpoint_gain_count,
          prismatic_gain_count: evaluation.prismatic_gain_count,
        };
      }),
  };
}

export function planConstrainedEmblemAssignments({
  lineupCandidates,
  confirmedEmblems,
  traitCatalog,
  championNaturalTraits,
  liveConstraints = {},
} = {}) {
  try {
    const limits = normalizeLimits(liveConstraints);
    const traits = normalizeTraitCatalog(traitCatalog);
    const naturalTraits = normalizeNaturalTraits(championNaturalTraits);
    const emblems = normalizeEmblems(confirmedEmblems, traits, limits.max_emblem_copies);
    const variants = normalizeVariants(lineupCandidates, naturalTraits, traits, limits.max_holders, limits.max_variants);
    let totalExpanded = 0;
    let truncated = false;
    const variant_plans = variants.map((variant) => {
      const result = planVariant(variant, emblems, naturalTraits, traits, liveConstraints, {
        ...limits,
        max_expanded_states: Math.max(0, limits.max_expanded_states - totalExpanded),
      });
      totalExpanded += result.expanded_states;
      truncated ||= result.truncated;
      return {
        candidate_id: variant.candidate_id,
        variant_id: variant.variant_id,
        published_roster: [...variant.roster],
        plans: result.plans,
      };
    });
    return {
      schema: RANKING_EMBLEM_PLAN_SCHEMA,
      status: "ok",
      variant_plans,
      search: {
        beam_width: limits.beam_width,
        max_plans_per_variant: limits.max_plans_per_variant,
        max_expanded_states: limits.max_expanded_states,
        expanded_states: totalExpanded,
        truncated,
      },
    };
  } catch (error) {
    return {
      schema: RANKING_EMBLEM_PLAN_SCHEMA,
      status: "invalid_input",
      reason: error instanceof Error ? error.message : String(error),
      variant_plans: [],
    };
  }
}
