import {
  cruiseCheckpointAgendaSnapshot,
  cruiseCheckpointById,
} from "./cruise-checkpoint-agenda.js";

export const CRUISE_STRATEGIC_OBLIGATION_QUEUE_SCHEMA = "jcc-cruise-strategic-obligation-queue-v1";
export const CRUISE_STRATEGIC_RESPONSE_COVERAGE_SCHEMA = "jcc-cruise-strategic-response-coverage-v1";

const STRATEGIC_TRIGGERS = new Set([
  "lineup_convergence_checkpoint",
  "cap_gap_check",
  "direction_commit_or_exit",
]);

const REQUIRED_FIELD_ALIASES = Object.freeze({
  complete_candidate_rosters: ["complete_candidate_rosters", "complete_candidate_rosters_and_roles"],
  complete_candidate_rosters_and_roles: ["complete_candidate_rosters", "complete_candidate_rosters_and_roles"],
  complete_final_roster: ["complete_final_roster", "full_final_roster"],
  full_final_roster: ["complete_final_roster", "full_final_roster"],
});

const REQUIRED_DECISION_COVERAGE_GROUPS = Object.freeze([
  Object.freeze([
    "complete_candidate_rosters",
    "complete_candidate_rosters_and_roles",
  ]),
  Object.freeze([
    "complete_final_roster",
    "full_final_roster",
  ]),
]);

const TARGET_EXECUTION_REQUIRED_DECISIONS = Object.freeze([
  "confirmed_target_identity",
  "complete_final_roster",
  "target_compatibility_with_current_choice",
  "target_execution_path",
  "target_pivot_condition",
]);

function durableTargetPlanFor(event = {}, previous = null) {
  const candidate = event.target_plan
    || event.targetPlan
    || event.runtime_event_context?.target_plan
    || event.runtime_event_context?.targetPlan
    || event.match_facts?.target_plan
    || null;
  const prior = previous?.target_plan || null;
  const target = candidate || prior;
  if (!target || typeof target !== "object") return null;
  const authority = String(
    event.target_context_authority
      || event.targetContextAuthority
      || target.authority
      || prior?.authority
      || "",
  ).trim();
  const hasStableIdentity = [
    target.candidate_id,
    target.lineup_group_id,
    target.atomic_roster_id,
    target.variant_id,
  ].some((value) => String(value || "").trim());
  return authority === "durable_target_plan"
      || target.source === "explicit_user_commitment"
      || hasStableIdentity
    ? target
    : null;
}

export function normalizedStrategicTargetIdentity(target = null) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  const roster = rosterMembersFrom(target);
  const normalizedText = (value) => String(value || "").normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
  return {
    authority: "durable_target_plan",
    candidate_id: String(target.candidate_id || target.lineup_group_id || target.lineup_id || target.id || "").trim() || null,
    selected_variant_id: String(target.selected_variant_id || target.variant_id || "").trim() || null,
    candidate_evidence_id: String(target.candidate_evidence_id || "").trim() || null,
    target_name: normalizedText(target.name || target.target_name || target.lineup_name || target.text || target.summary) || null,
    main_carry: normalizedText(target.main_carry || target.primary_carry || target.carry) || null,
    main_tank: normalizedText(target.main_tank || target.primary_tank || target.tank) || null,
    unit_names: roster.names.map(normalizedText).filter(Boolean).sort(),
    unit_ids: roster.ids.map(normalizedText).filter(Boolean).sort(),
  };
}

function sameStrategicTarget(left, right) {
  return sameStructuredValue(
    normalizedStrategicTargetIdentity(left),
    normalizedStrategicTargetIdentity(right),
  );
}

function targetAwareCandidatePolicy(checkpoint, answerContract, targetPlan) {
  if (!targetPlan) return answerContract.candidate_policy || null;
  if (checkpoint?.checkpoint_id === "final_lineup_confirmation") {
    return "confirmed_target_final_reconciliation";
  }
  if (checkpoint?.strategy_block_id === "lineup_direction_commitment") {
    return "confirmed_target_execution_or_reconciliation";
  }
  return "use_confirmed_target_only";
}

function targetAwareRequiredDecisions(checkpoint, answerContract, targetPlan) {
  if (!targetPlan) return canonicalRequiredDecisions(answerContract.required_decisions);
  const original = strings(answerContract.required_decisions).filter((decision) => ![
    "complete_candidate_rosters",
    "complete_candidate_rosters_and_roles",
    "choice_effect_on_each_direction",
    "current_direction_leader_and_backup",
    "mainline_backup_and_pivot_condition",
    "current_mainline_and_backup",
    "lock_one_complete_target_candidate_identity_or_two_separately_named_last_choices",
  ].includes(decision));
  const targetSpecific = [...TARGET_EXECUTION_REQUIRED_DECISIONS];
  if (checkpoint?.checkpoint_id === "final_lineup_confirmation") {
    targetSpecific.push(
      "forbid_silent_member_equipment_or_cap_mixing_across_standard_popular_winning_and_user_variants",
      "target_stars_and_total_piece_cost",
      "main_carry_main_tank_and_core_traits",
      "formation_and_equipment_assignments",
      "final_transition_and_pivot_condition",
      "carousel_4_4_priorities",
      "temporary_five_cost_holder_for_nine_five_when_relevant",
    );
  } else if (checkpoint?.checkpoint_id === "post_3_2_narrowing") {
    targetSpecific.push(
      "choice_effect_on_confirmed_target",
      "next_population_and_roll_window",
      "carousel_3_4_unit_item_and_emblem_priorities",
    );
  }
  const targetKeys = new Set(targetSpecific);
  return canonicalRequiredDecisions([
    ...targetSpecific,
    ...original,
  ]);
}

function strings(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function coveredDecisionStrings(value) {
  if (Array.isArray(value)) return strings(value);
  if (value && typeof value === "object") {
    return strings(Object.entries(value)
      .filter(([, covered]) => covered === true)
      .map(([decision]) => decision));
  }
  return strings(value);
}

function candidateIds(values) {
  return strings((Array.isArray(values) ? values : values === undefined || values === null ? [] : [values])
    .map((value) => {
      if (!value || typeof value !== "object") return value;
      return value.candidate_id || value.lineup_group_id || value.line_id || value.id || null;
    }));
}

function normalizedSelectionRef(value = {}) {
  const source = objectValue(value);
  const candidateId = candidateIds([source])[0] || null;
  if (!candidateId) return null;
  return {
    candidate_id: candidateId,
    selected_variant_id: String(
      source.selected_variant_id
        || source.selectedVariantId
        || source.variant_id
        || source.variantId
        || source.canonical_variant?.variant_id
        || "",
    ).trim() || null,
    candidate_evidence_id: String(
      source.candidate_evidence_id
        || source.candidateEvidenceId
        || source.evidence_id
        || source.evidenceId
        || source.canonical_variant?.candidate_evidence_id
        || "",
    ).trim() || null,
  };
}

function selectionRefKey(value = {}) {
  const ref = normalizedSelectionRef(value);
  if (!ref) return null;
  return [ref.candidate_id, ref.selected_variant_id || "", ref.candidate_evidence_id || ""].join("|");
}

function selectedCandidateRefs(selection = {}) {
  const source = objectValue(selection);
  const explicitRefs = Array.isArray(source.selected_candidate_refs)
    ? source.selected_candidate_refs
    : Array.isArray(source.selectedCandidateRefs)
      ? source.selectedCandidateRefs
    : Array.isArray(source.selection_refs)
      ? source.selection_refs
      : [];
  const refs = explicitRefs.map(normalizedSelectionRef).filter(Boolean);
  const knownIds = new Set(refs.map((ref) => ref.candidate_id));
  for (const candidateId of candidateIds(
    source.selected_candidate_ids
      ?? source.selectedCandidateIds
      ?? source.candidate_ids
      ?? source.candidateIds
      ?? source.selected_candidates,
  )) {
    if (knownIds.has(candidateId)) continue;
    refs.push({ candidate_id: candidateId, selected_variant_id: null, candidate_evidence_id: null });
    knownIds.add(candidateId);
  }
  return refs;
}

function rosterMembersFrom(value = {}) {
  const source = objectValue(value);
  const roster = objectValue(
    source.roster
      || source.atomic_roster
      || source.canonical_variant
      || source.variant,
  );
  const objectMembers = [
    ...(Array.isArray(source.atomic_roster_members) ? source.atomic_roster_members : []),
    ...(Array.isArray(source.core_units) ? source.core_units : []),
    ...(Array.isArray(roster.atomic_roster_members) ? roster.atomic_roster_members : []),
    ...(Array.isArray(roster.core_units) ? roster.core_units : []),
  ];
  const names = strings([
    source.unit_names,
    source.lineup_names,
    source.core_unit_names,
    roster.unit_names,
    roster.lineup_names,
    roster.core_unit_names,
    objectMembers.map((entry) => entry?.champion_name || entry?.source_unit_name || entry?.name || entry?.display_name || null),
  ]);
  const ids = strings([
    source.unit_ids,
    source.lineup_ids,
    source.core_unit_ids,
    roster.unit_ids,
    roster.lineup_ids,
    roster.core_unit_ids,
    objectMembers.map((entry) => entry?.source_unit_id || entry?.champion_id || entry?.id || entry?.unit_id || null),
  ]);
  const members = objectMembers.map((entry) => ({
    source_unit_id: String(entry?.source_unit_id || "").trim() || null,
    entity_kind: String(entry?.entity_kind || "").trim() || null,
    champion_id: String(entry?.champion_id || "").trim() || null,
    champion_name: String(entry?.champion_name || entry?.source_unit_name || entry?.name || entry?.display_name || "").trim() || null,
    occupies_population: entry?.occupies_population === true,
    catalog_resolution: String(entry?.catalog_resolution || "").trim() || null,
  })).filter((entry) => entry.source_unit_id || entry.champion_id || entry.champion_name);
  return { names, ids, members };
}

function normalizedCandidatePresentation(value = {}) {
  // Tool candidates and prefetch candidates share one local canonical projection.
  const source = { ...objectValue(value.strategy_profile), ...objectValue(value) };
  const roster = rosterMembersFrom(source);
  return {
    candidate_id: candidateIds([source])[0] || null,
    display_name: String(source.display_name || source.name || source.line || "").trim() || null,
    candidate_evidence_id: String(
      source.candidate_evidence_id
        || source.canonical_variant?.candidate_evidence_id
        || "",
    ).trim() || null,
    selected_variant_id: String(
      source.selected_variant_id
        || source.variant_id
        || source.canonical_variant?.variant_id
        || "",
    ).trim() || null,
    atomic_roster_id: String(
      source.atomic_roster_id
        || source.canonical_variant?.atomic_roster_id
        || "",
    ).trim() || null,
    roster_is_atomic: source.roster_is_atomic
      ?? source.atomic_roster?.roster_is_atomic
      ?? source.canonical_variant?.roster_is_atomic
      ?? null,
    unit_names: roster.names,
    unit_ids: roster.ids,
    atomic_roster_members: roster.members,
    target_population: integerOrNull(
      source.target_population
        ?? source.occupied_population
        ?? source.population
        ?? source.canonical_variant?.population
        ?? source.canonical_variant?.occupied_population,
    ),
    main_carry: String(
      source.main_carry?.champion_name
        || source.main_carry?.name
        || source.main_carry?.display_name
        || source.main_carry
        || "",
    ).trim() || null,
    primary_tank: String(
      source.primary_tank?.champion_name
        || source.primary_tank?.name
        || source.primary_tank?.display_name
        || source.main_tank?.champion_name
        || source.main_tank?.name
        || source.main_tank?.display_name
        || source.primary_tank
        || source.main_tank
        || "",
    ).trim() || null,
    core_traits: strings(
      source.core_traits
        || source.main_traits
        || source.canonical_variant?.core_traits
        || source.canonical_variant?.trait_signature?.traits?.map((trait) => `${trait?.trait_name || ""}${trait?.breakpoint ?? trait?.count ?? ""}`),
    ),
    star_targets: source.star_targets || source.canonical_variant?.star_targets || null,
    equipment_plan: source.equipment_plan
      || source.equipment_requirements
      || source.canonical_variant?.equipment_priority
      || null,
    augment_conditions: source.augment_conditions
      || source.associated_augments
      || source.canonical_variant?.augment_conditions
      || source.canonical_variant?.associated_augment_names
      || null,
    transition_path: source.transition_path
      || source.transition_steps
      || source.transition_populations
      || source.canonical_variant?.transition_path
      || source.canonical_variant?.transition_chain
      || null,
    lifecycle_prior: source.lifecycle_prior || source.canonical_variant?.lifecycle_prior || null,
    formation_profile: source.formation_profile || source.canonical_variant?.formation_profile || null,
    positioning_template: source.positioning_template || source.canonical_variant?.positioning_template || null,
    canonical_lineup_identity: source.canonical_lineup_identity || source.canonical_variant?.canonical_lineup_identity || null,
    atomic_roster_observation: source.atomic_roster_observation || source.canonical_variant?.atomic_roster_observation || null,
    atomic_variant_difference: source.atomic_variant_difference || source.canonical_variant?.atomic_variant_difference || null,
    mature_recipe_variants: source.mature_recipe_variants || source.canonical_variant?.mature_recipe_variants || null,
    mature_recipe_variant_receipt: source.mature_recipe_variant_receipt || source.canonical_variant?.mature_recipe_variant_receipt || null,
    source_role: source.source_role || null,
    metrics_authority: source.metrics_authority || null,
    provenance: source.provenance || null,
    evidence_boundary: source.evidence_boundary || null,
    cap: source.cap || source.ceiling || source.upper_bound || source.canonical_variant?.cap || null,
    floor: source.floor || source.lower_bound || source.canonical_variant?.floor || null,
  };
}

function candidatePresentationComplete(value = {}) {
  const presentation = normalizedCandidatePresentation(value);
  return Boolean(
    presentation.candidate_id
      && presentation.roster_is_atomic === true
      && (presentation.unit_names.length || presentation.unit_ids.length)
      && presentation.candidate_evidence_id
      && presentation.main_carry
      && presentation.primary_tank,
  );
}

function fullExplorationCandidateRequirement(envelope, completeAllowedCandidates) {
  const contracts = array(envelope?.checkpoint_contracts);
  const required = contracts.some((contract) => (
    contract?.checkpoint_id === "direction_exploration"
      || contract?.candidate_policy === "three_to_five_real_directions_when_supported"
  ));
  if (!required) return { required: false, minimum: 0, maximum: null };
  return {
    required: true,
    minimum: Math.min(3, completeAllowedCandidates.length),
    maximum: Math.min(5, completeAllowedCandidates.length),
  };
}

function normalizedCompletionReceipt(value = {}) {
  const receipt = objectValue(value);
  return {
    block_id: String(receipt.block_id || receipt.strategy_block_id || "").trim() || null,
    revision: integerOrNull(receipt.revision ?? receipt.block_revision),
    latest_checkpoint_id: String(receipt.latest_checkpoint_id || receipt.checkpoint_id || "").trim() || null,
  };
}

function decisionCoverageKey(value) {
  const decision = String(value || "").trim();
  const group = REQUIRED_DECISION_COVERAGE_GROUPS.find((aliases) => aliases.includes(decision));
  return group?.[0] || decision;
}

function requiredDecisionCoverage(values) {
  const entries = [];
  const seen = new Set();
  for (const decision of strings(values)) {
    const key = decisionCoverageKey(decision);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, decision });
  }
  return entries;
}

function diagnostic(code, path, message, details = {}) {
  return { code, path, message, ...details };
}

function meaningfulOutput(value) {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

function normalizedDecisionOutput(value) {
  const entries = typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value
      : value && typeof value === "object"
        ? [value.summary, value.conclusion, value.action, value.reason]
        : [];
  const output = entries
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .join("；");
  if (output.length < 4) return null;
  const marker = normalizedText(output);
  if (/^(true|false|ok|yes|done|covered|complete|已覆盖|已完成|完成|见上文|同上|是|否|(已经?)?(覆盖|完成|处理)(了)?(该|本|这个)?(决策|要求|内容|字段)?)$/iu.test(marker)) return null;
  return output;
}

function decisionOutputs(value) {
  const source = objectValue(value);
  return Object.fromEntries(Object.entries(source)
    .map(([decision, output]) => [decision, normalizedDecisionOutput(output)])
    .filter(([, output]) => meaningfulOutput(output)));
}

function normalizedText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "");
}

function sameStringSet(left, right) {
  const expected = strings(left).sort();
  const actual = strings(right).sort();
  return expected.length === actual.length && expected.every((entry, index) => entry === actual[index]);
}

function sameStructuredValue(left, right) {
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalize(entry)]));
    return String(value ?? "").trim();
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function candidatePositionEvidence(candidate = {}) {
  const template = candidate.positioning_template || candidate.canonical_variant?.positioning_template;
  const coordinates = array(template?.coordinates);
  return {
    candidate_id: normalizedSelectionRef(candidate)?.candidate_id || null,
    status: coordinates.length ? "provided" : "unknown",
    reason: coordinates.length ? null : "source_positioning_not_provided",
    positioning_template: coordinates.length ? structuredClone(template) : null,
  };
}

function hasStructuredPositionOutput(value) {
  if (Array.isArray(value)) return value.some(hasStructuredPositionOutput);
  if (value && typeof value === "object") {
    if (Object.hasOwn(value, "row") && (Object.hasOwn(value, "col") || Object.hasOwn(value, "column"))) return true;
    return Object.values(value).some(hasStructuredPositionOutput);
  }
  return false;
}

function candidatePositionSourceMatches(presentation, candidates) {
  if (!hasStructuredPositionOutput(presentation)) return true;
  const ref = normalizedSelectionRef(presentation);
  const matches = array(candidates).filter((candidate) => {
    const sourceRef = normalizedSelectionRef(candidate);
    return ref && sourceRef && ref.candidate_id === sourceRef.candidate_id
      && (!ref.selected_variant_id || ref.selected_variant_id === sourceRef.selected_variant_id)
      && (!ref.candidate_evidence_id || ref.candidate_evidence_id === sourceRef.candidate_evidence_id);
  });
  if (matches.length !== 1) return false;
  const evidence = candidatePositionEvidence(matches[0]);
  const presented = candidatePositionEvidence(presentation);
  return evidence.status === "provided" && presented.status === "provided"
    && sameStructuredValue(presented.positioning_template, evidence.positioning_template);
}

function matureRecipeAlternativeUnitNames(presentation = {}) {
  return strings(array(presentation?.mature_recipe_variants).flatMap((variant) => [
    variant?.added_by_recipe_names,
    array(variant?.added_units).map((unit) => (
      unit?.champion_name || unit?.source_unit_name || unit?.name || unit?.display_name || null
    )),
  ]));
}

function transitionEvidenceNames(value) {
  if (Array.isArray(value)) return value.flatMap(transitionEvidenceNames);
  if (!value || typeof value !== "object") return [];
  return strings([
    value.champion_name, value.unit_name, value.source_unit_name,
    value.lineup_names, value.unit_names, value.champion_names,
    ...Object.values(value).filter((child) => child && typeof child === "object").flatMap(transitionEvidenceNames),
  ]);
}

function memberClaimText(value) {
  return normalizedText(value).replace(/(\*\*|__|\*|_)([^\n]+?)\1/gu, "$2");
}

function memberClaimSentences(text, memberNames) {
  const heading = /^(?:选定的?|当前的?)?(?:最终阵容|目标阵容|标准阵容)(?:成员)?[：:]$/u;
  const sentences = [];
  let listHeading = null;
  // Normalize formatting before interpreting newlines. Only roster-only lines
  // inherit a heading; prose, a new heading, or sentence punctuation ends it.
  for (const rawLine of String(text || "").split(/\r?\n/u)) {
    const line = memberClaimText(rawLine);
    if (!line) { listHeading = null; continue; }
    for (const fragment of line.split(/([。！？!?；;]+)/u)) {
      const part = fragment.replace(/^#{1,6}/u, "").replace(/^(?:[-+•]|\d+[.)])/u, "");
      if (!part) continue;
      if (/^[。！？!?；;]+$/u.test(part)) { listHeading = null; continue; }
      if (heading.test(part)) { listHeading = part; continue; }
      const remainder = memberNames.reduce((value, member) => value.split(normalizedText(member)).join(""), part);
      const rosterOnly = /^[、，,]*$/u.test(remainder);
      sentences.push(listHeading && rosterOnly ? `${listHeading}${part}` : part);
      if (!rosterOnly) listHeading = null;
    }
  }
  return sentences;
}

function rankingMemberTextClaims(text, unitName, { temporaryNames = new Set(), memberNames = [] } = {}) {
  const name = normalizedText(unitName);
  if (!name) return [];
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const actionBefore = "上场|并上|放上|补上|换上|替换成|卖出|卖掉|购买|买下|保留|追三|追3|追二|追2|搜出|找到|补入|加入|凑出|转向|改走|选择|装备给|给装备|携带装备|作为持有者";
  const actionAfter = "上场|放上|换上|替换|卖出|卖掉|购买|买下|保留|追三|追3|追二|追2|搜出|补入|加入|装备|携带|持有|作为|是最终";
  const actionBeforeUnit = new RegExp(`(?:${actionBefore}).{0,12}${escapedName}`, "iu");
  const actionAfterUnit = new RegExp(`${escapedName}.{0,12}(?:${actionAfter})`, "iu");
  const negatedMember = new RegExp(`(?:暂不|不要|不)(?:把|将)?${escapedName}.{0,6}(?:${actionAfter})|(?:暂不选|不选|不保留|不列入|排除|放弃|不考虑)${escapedName}|${escapedName}(?:暂不|不要|不)(?:${actionAfter})`, "iu");
  const negatedMembership = new RegExp(`(?:不要|不能|不)(?:把|将)${escapedName}|${escapedName}(?:并非|不是|不属于|不要|不能|不应)`, "iu");
  const claims = [];
  for (const sentence of memberClaimSentences(text, memberNames)) {
    let variantScope = false;
    let temporaryScope = false;
    let finalRosterList = false;
    // Scope ends at sentence boundaries and explicit contrasts/current execution.
    // Remove entity names before interpreting labels: a name is never a label.
    for (const clause of sentence.split(/[，,：:]|(?=但是|(?:但|而|仍|并)(?:把|将)|然而|却把|然后|而是|随后|现在)/u)) {
      const semantics = memberNames.reduce((value, member) => value.split(normalizedText(member)).join("单位"), clause);
      if (/^(?:选定的?|当前的?)?(?:最终阵容|目标阵容|标准阵容)(?:成员)?$/u.test(semantics)) {
        finalRosterList = true;
      }
      if (/^(?:但是|但|而|然而|却|然后|随后|仍把|仍将|并把|并将|现在|最终阵容)/u.test(clause)) {
        variantScope = false;
        temporaryScope = false;
      }
      if (/(?:不是|并非|非)(?:独立|单独|成熟)?(?:变体|变种|配方|另一套)/u.test(semantics)) {
        variantScope = false;
      } else if (/(?:变体|变种|配方|另一套|variant|recipe)/iu.test(semantics)) variantScope = true;
      if (/(?:打工|临时持装|临时持有|过渡持装|过渡单位)/u.test(semantics)) temporaryScope = true;
      if (!clause.includes(name)) continue;
      // The full clause owns the action's target. Other members only bound the
      // local action/negation span; they must not erase a possessive target.
      const targetPattern = /(?:最终|选定).{0,8}(?:阵容|主c|主坦|成员)|(?:标准阵容|主线阵容)/giu;
      const targets = [...clause.matchAll(targetPattern)].map((match) => ({
        start: match.index, end: match.index + match[0].length,
        negated: /(?:而非|而不是|并非|不是|不属于)$/u.test(clause.slice(0, match.index)),
      }));
      const otherNames = memberNames.map(normalizedText).filter(Boolean);
      const boundaries = otherNames.flatMap((other) => {
        const positions = [];
        for (let at = clause.indexOf(other); at >= 0; at = clause.indexOf(other, at + other.length)) {
          positions.push({ start: at, end: at + other.length });
        }
        return positions;
      });
      const actions = [...clause.matchAll(new RegExp(`(?:${actionBefore}|${actionAfter})`, "giu"))]
        .filter((match) => !boundaries.some((span) => match.index >= span.start && match.index < span.end));
      const negatedObjectAt = (at, end) => {
        const governing = actions.filter((match) => match.index < at).at(-1);
        if (!governing || !/(?:不|不要|不能|不应|不必)(?:再|同时|继续)*$/u.test(clause.slice(0, governing.index))) return false;
        const objectStart = governing.index + governing[0].length;
        const objects = boundaries.filter((span) => span.start >= objectStart && span.start <= at)
          .sort((left, right) => left.start - right.start || right.end - left.end)
          .filter((span, index, all) => !all.slice(0, index).some((prior) => prior.end > span.start));
        const seen = new Set();
        let previousEnd = objectStart;
        for (const [index, span] of objects.entries()) {
          const member = clause.slice(span.start, span.end);
          const gap = clause.slice(previousEnd, span.start);
          // A coordinator may introduce a new predicate, not another object.
          // Keep nominal route labels, but stop at directive/causative markers.
          const coordinatedObject = /^(?:或|和|与|及|、)/u.test(gap)
            && !/(?:改为|让|把|将)/u.test(gap);
          if (seen.has(member) || (index > 0 && !coordinatedObject)) return false;
          seen.add(member);
          previousEnd = span.end;
        }
        // A shared "as ..." complement belongs to the negated object list.
        // Any other following action starts a new claim, including promotion.
        return !actions.some((match) => match.index >= at + name.length && match.index < end && match[0] !== "作为");
      };
      for (let at = clause.indexOf(name); at >= 0; at = clause.indexOf(name, at + name.length)) {
        const start = Math.max(0, ...boundaries.filter((span) => span.end <= at).map((span) => span.end));
        const end = Math.min(clause.length, ...boundaries.filter((span) => span.start >= at + name.length).map((span) => span.start));
        const mention = clause.slice(start, end);
        const previousMention = at === 0 ? -1 : clause.lastIndexOf(name, at - name.length);
        const nextMention = clause.indexOf(name, at + name.length);
        const targetStart = previousMention < 0 ? 0 : previousMention + name.length;
        const targetEnd = nextMention < 0 ? clause.length : nextMention;
        const relatedTargets = targets.filter((target) => target.start >= targetStart && target.start < targetEnd);
        const finalTarget = relatedTargets.some((target) => !target.negated);
        const excludedTarget = relatedTargets.length > 0 && relatedTargets.every((target) => target.negated)
          || targets.some((target) => target.end <= at && target.end >= start
            && /^(?:不包含|不包括|不含)\s*$/u.test(clause.slice(target.end, at)));
        // Naming this member in an affirmative final-roster declaration is
        // itself a claim, even when it uses no enumerated action verb.
        const action = finalRosterList || finalTarget || actionBeforeUnit.test(mention) || actionAfterUnit.test(mention);
        const finalPromotion = action && (finalRosterList || finalTarget);
        const excluded = excludedTarget || negatedObjectAt(at, end) || negatedMember.test(mention) || (finalTarget && negatedMembership.test(mention))
          || (!action && /(?:仅作比较|只作比较|用于比较|不作为主线|不是主线|不进入执行|暂不作为当前备选)/u.test(mention));
        const exit = new RegExp(`(?:卖掉|卖出)${escapedName}|${escapedName}(?:卖掉|卖出)`, "iu").test(mention);
        const temporary = temporaryNames.has(name) && (temporaryScope || exit) && !finalPromotion;
        const variant = variantScope && !finalPromotion;
        claims.push({ action, allowed: !action || excluded || temporary || variant });
      }
    }
  }
  return claims;
}

export function normalizeStrategicObligationResponsePayload(payload = {}) {
  const source = objectValue(payload);
  const completion = objectValue(source.strategic_completion);
  const selection = objectValue(source.strategy_selection || completion.strategy_selection);
  const selectionStatus = String(selection.status || selection.selection_status || "").trim().toLowerCase();
  const unavailable = selection.unavailable === true
    || ["unavailable", "not_available", "no_valid_candidate"].includes(selectionStatus);
  const directCandidateRefs = Array.isArray(source.candidate_refs)
    ? source.candidate_refs.map((ref) => normalizedSelectionRef({
        ...objectValue(ref),
        selected_variant_id: ref?.selected_variant_id || ref?.variant_id || null,
      })).filter(Boolean)
    : [];
  const normalizedSelectionRefs = directCandidateRefs.length
    ? directCandidateRefs
    : selectedCandidateRefs(selection);
  return {
    schema: CRUISE_STRATEGIC_RESPONSE_COVERAGE_SCHEMA,
    strategic_completion: {
      queue_revision: integerOrNull(
        completion.queue_revision ?? completion.strategic_obligation_queue_revision,
      ),
      completion_receipts: (Array.isArray(completion.completion_receipts)
        ? completion.completion_receipts
        : Array.isArray(completion.receipts)
          ? completion.receipts
          : [])
        .map(normalizedCompletionReceipt),
      covered_required_decisions: canonicalRequiredDecisions(coveredDecisionStrings(
        completion.covered_required_decisions
          ?? completion.required_decisions_covered
          ?? completion.completed_required_decisions,
      )),
      decision_outputs: decisionOutputs(
        completion.decision_outputs
          ?? selection.decision_outputs
          ?? source.decision_outputs,
      ),
    },
    strategy_selection: {
      status: unavailable ? "unavailable" : selectionStatus || "selected",
      unavailable,
      unavailable_reason: String(selection.unavailable_reason || selection.reason || "").trim() || null,
      selected_candidate_ids: candidateIds(normalizedSelectionRefs),
      selected_candidate_refs: normalizedSelectionRefs,
      candidate_presentations: (Array.isArray(selection.candidate_presentations)
        ? selection.candidate_presentations
        : Array.isArray(selection.selected_candidates)
          ? selection.selected_candidates.filter((entry) => entry && typeof entry === "object")
          : [])
        .map(normalizedCandidatePresentation),
    },
  };
}

export function assembleStrategicObligationResponsePayload(
  deliveryEnvelope,
  payload = {},
  {
    allowedCandidates = [],
    allowed_candidates = [],
  } = {},
) {
  const envelope = objectValue(deliveryEnvelope);
  const source = objectValue(payload);
  const normalized = normalizeStrategicObligationResponsePayload(source);
  const suppliedCandidates = Array.isArray(allowedCandidates) && allowedCandidates.length
    ? allowedCandidates
    : allowed_candidates;
  const candidatesById = new Map();
  for (const candidate of Array.isArray(suppliedCandidates) ? suppliedCandidates : []) {
    const ref = normalizedSelectionRef(candidate);
    if (!ref) continue;
    const matches = candidatesById.get(ref.candidate_id) || [];
    matches.push(candidate);
    candidatesById.set(ref.candidate_id, matches);
  }
  const selectedCandidateRefs = normalized.strategy_selection.selected_candidate_refs;
  const resolutionErrors = [];
  const resolvedCandidates = selectedCandidateRefs.map((selectedRef) => {
    const matches = (candidatesById.get(selectedRef.candidate_id) || []).filter((candidate) => {
      const candidateRef = normalizedSelectionRef(candidate);
      if (!candidateRef) return false;
      if (selectedRef.selected_variant_id && selectedRef.selected_variant_id !== candidateRef.selected_variant_id) return false;
      if (selectedRef.candidate_evidence_id && selectedRef.candidate_evidence_id !== candidateRef.candidate_evidence_id) return false;
      return true;
    });
    if (matches.length === 1) return matches[0];
    resolutionErrors.push({
      code: matches.length > 1
        ? "strategy_selection_candidate_ref_ambiguous"
        : "strategy_selection_candidate_ref_unresolved",
      selection_ref: selectedRef,
      matching_candidate_count: matches.length,
    });
    return null;
  }).filter(Boolean);
  const candidatePresentations = resolvedCandidates;
  if (array(source.strategy_selection?.candidate_presentations)
    .some((presentation) => !candidatePositionSourceMatches(presentation, resolvedCandidates))) {
    resolutionErrors.push({ code: "strategy_selection_position_evidence_missing" });
  }
  const selectedCandidateIds = candidateIds(selectedCandidateRefs);
  const decisionOutputs = normalized.strategic_completion.decision_outputs;
  const coveredRequiredDecisions = canonicalRequiredDecisions([
    ...normalized.strategic_completion.covered_required_decisions,
    ...Object.keys(decisionOutputs),
  ]);
  const assembled = {
    ...source,
    final_text: source.final_text,
    candidate_refs: resolvedCandidates.map(normalizedSelectionRef).filter(Boolean),
    runtime_materialization: {
      schema: "jcc-strategic-runtime-materialization-v1",
      selected_candidate_refs: resolvedCandidates.map(normalizedSelectionRef).filter(Boolean),
      candidate_presentations: resolvedCandidates.map(normalizedCandidatePresentation),
      position_evidence: resolvedCandidates.map(candidatePositionEvidence),
      selection_resolution_errors: resolutionErrors,
    },
    strategic_completion: {
      ...objectValue(source.strategic_completion),
      queue_revision: integerOrNull(envelope.queue_revision),
      completion_receipts: (Array.isArray(envelope.completion_receipts) ? envelope.completion_receipts : [])
        .map(normalizedCompletionReceipt),
      covered_required_decisions: coveredRequiredDecisions,
      decision_outputs: decisionOutputs,
    },
    strategy_selection: {
      ...objectValue(source.strategy_selection),
      status: normalized.strategy_selection.status,
      unavailable: normalized.strategy_selection.unavailable,
      unavailable_reason: normalized.strategy_selection.unavailable_reason,
      selected_candidate_ids: selectedCandidateIds,
      selected_candidate_refs: resolvedCandidates.map(normalizedSelectionRef).filter(Boolean),
      candidate_presentations: candidatePresentations,
    },
  };
  return assembled;
}

export function diagnoseStrategicObligationResponseCoverage(
  deliveryEnvelope,
  payload = {},
  {
    allowedCandidateIds = [],
    allowed_candidate_ids = [],
    allowedCandidates = [],
    allowed_candidates = [],
    runtimeContext = null,
    runtime_context = null,
    matchFacts = null,
    match_facts = null,
  } = {},
) {
  const envelope = objectValue(deliveryEnvelope);
  const normalized = normalizeStrategicObligationResponsePayload(payload);
  const completion = normalized.strategic_completion;
  const selection = normalized.strategy_selection;
  const errors = [];
  for (const entry of array(payload?.runtime_materialization?.selection_resolution_errors)) {
    errors.push(diagnostic(
      entry?.code || "strategy_selection_candidate_ref_unresolved",
      "strategy_selection.selected_candidate_refs",
      "Every selected strategy candidate must resolve to one exact Runtime candidate variant.",
      {
        selection_ref: entry?.selection_ref || null,
        matching_candidate_count: Number(entry?.matching_candidate_count || 0),
      },
    ));
  }
  const expectedQueueRevision = integerOrNull(envelope.queue_revision);
  const expectedReceipts = (Array.isArray(envelope.completion_receipts)
    ? envelope.completion_receipts
    : []).map(normalizedCompletionReceipt);
  const actualReceipts = completion.completion_receipts;

  if (expectedQueueRevision === null) {
    errors.push(diagnostic(
      "delivery_envelope_queue_revision_missing",
      "delivery_envelope.queue_revision",
      "The delivery envelope must carry an integer queue revision.",
    ));
  } else if (completion.queue_revision !== expectedQueueRevision) {
    errors.push(diagnostic(
      "strategic_completion_queue_revision_mismatch",
      "strategic_completion.queue_revision",
      "The Host strategic completion must acknowledge the exact delivery-envelope queue revision.",
      { expected: expectedQueueRevision, actual: completion.queue_revision },
    ));
  }

  const expectedByBlock = new Map();
  for (const receipt of expectedReceipts) {
    if (!receipt.block_id || receipt.revision === null) {
      errors.push(diagnostic(
        "delivery_envelope_receipt_invalid",
        "delivery_envelope.completion_receipts",
        "Every delivery-envelope receipt must carry block_id and an integer revision.",
        { receipt },
      ));
      continue;
    }
    if (expectedByBlock.has(receipt.block_id)) {
      errors.push(diagnostic(
        "delivery_envelope_receipt_duplicate_block",
        "delivery_envelope.completion_receipts",
        "The delivery envelope must contain exactly one receipt per strategic block.",
        { block_id: receipt.block_id },
      ));
      continue;
    }
    expectedByBlock.set(receipt.block_id, receipt);
  }

  const actualByBlock = new Map();
  for (const receipt of actualReceipts) {
    if (!receipt.block_id || receipt.revision === null) {
      errors.push(diagnostic(
        "strategic_completion_receipt_invalid",
        "strategic_completion.completion_receipts",
        "Every Host completion receipt must carry block_id and an integer revision.",
        { receipt },
      ));
      continue;
    }
    if (actualByBlock.has(receipt.block_id)) {
      errors.push(diagnostic(
        "strategic_completion_receipt_duplicate_block",
        "strategic_completion.completion_receipts",
        "The Host strategic completion must contain exactly one receipt per strategic block.",
        { block_id: receipt.block_id },
      ));
      continue;
    }
    actualByBlock.set(receipt.block_id, receipt);
  }

  for (const [blockId, expected] of expectedByBlock.entries()) {
    const actual = actualByBlock.get(blockId);
    if (!actual) {
      errors.push(diagnostic(
        "strategic_completion_receipt_missing",
        "strategic_completion.completion_receipts",
        "The Host strategic completion is missing a required strategic-block receipt.",
        { block_id: blockId, expected },
      ));
      continue;
    }
    if (
      actual.revision !== expected.revision
      || actual.latest_checkpoint_id !== expected.latest_checkpoint_id
    ) {
      errors.push(diagnostic(
        "strategic_completion_receipt_mismatch",
        "strategic_completion.completion_receipts",
        "The Host strategic completion receipt must match the exact block revision and latest checkpoint.",
        { block_id: blockId, expected, actual },
      ));
    }
  }
  for (const [blockId, actual] of actualByBlock.entries()) {
    if (expectedByBlock.has(blockId)) continue;
    errors.push(diagnostic(
      "strategic_completion_receipt_unexpected",
      "strategic_completion.completion_receipts",
      "The Host strategic completion contains a receipt outside the supplied delivery envelope.",
      { block_id: blockId, actual },
    ));
  }

  const requiredCoverage = requiredDecisionCoverage(envelope.required_decisions);
  const coveredKeys = new Set(requiredDecisionCoverage(completion.covered_required_decisions)
    .map((entry) => entry.key));
  const missingRequiredDecisions = requiredCoverage
    .filter((entry) => !coveredKeys.has(entry.key))
    .map((entry) => entry.decision);
  if (missingRequiredDecisions.length) {
    errors.push(diagnostic(
      "strategic_completion_required_decisions_missing",
      "strategic_completion.covered_required_decisions",
      "The Host strategic completion must explicitly cover every required decision in the delivery envelope.",
      { missing_required_decisions: missingRequiredDecisions },
    ));
  }
  const decisionOutputKeys = new Set(Object.keys(completion.decision_outputs)
    .map(decisionCoverageKey));
  const missingDecisionOutputs = requiredCoverage
    .filter((entry) => !decisionOutputKeys.has(entry.key))
    .map((entry) => entry.decision);
  if (missingDecisionOutputs.length) {
    errors.push(diagnostic(
      "strategic_completion_required_decision_outputs_missing",
      "strategic_completion.decision_outputs",
      "Every required strategic decision must carry a non-empty structured output; a covered-decision name alone is not delivery evidence.",
      { missing_decision_outputs: missingDecisionOutputs },
    ));
  }
  const targetRosterRequired = envelope.target_roster_required === true;
  // A target-backed delivery is always a complete-roster delivery. Candidate
  // identity changes where the roster is resolved from; it does not weaken
  // the publication contract for chat-discovered or custom targets.
  const rankingCandidateSelectionRequired = targetRosterRequired
    ? envelope.ranking_candidate_selection_required === true
    : envelope.complete_candidate_rosters_required === true;
  const completeRosterRequired = targetRosterRequired
    || (!targetRosterRequired && requiredCoverage.some((entry) => ["complete_candidate_rosters", "complete_final_roster"].includes(entry.key)));
  const targetPlan = objectValue(envelope.target_plan);
  const targetIdentityPresent = Boolean([
    targetPlan.candidate_id,
    targetPlan.lineup_group_id,
    targetPlan.atomic_roster_id,
    targetPlan.variant_id,
    targetPlan.target_id,
    targetPlan.name,
    targetPlan.text,
  ].some((value) => String(value || "").trim()));
  const targetRoster = rosterMembersFrom(targetPlan);
  const selectedCandidateIds = selection.selected_candidate_ids;
  const suppliedCandidates = (Array.isArray(allowedCandidates) && allowedCandidates.length
    ? allowedCandidates
    : allowed_candidates);
  const normalizedAllowedCandidates = (Array.isArray(suppliedCandidates) ? suppliedCandidates : [])
    .map(normalizedCandidatePresentation)
    .filter((candidate) => candidate.candidate_id);
  const completeAllowedCandidates = normalizedAllowedCandidates.filter(candidatePresentationComplete);
  const targetCandidatePresentation = targetRosterRequired
    ? normalizedAllowedCandidates.find((candidate) => (
      candidate.candidate_id === String(targetPlan.candidate_id || targetPlan.lineup_group_id || "").trim()
    )) || null
    : null;
  const resolvedTargetRoster = {
    names: strings([targetRoster.names, targetCandidatePresentation?.unit_names]),
    ids: strings([targetRoster.ids, targetCandidatePresentation?.unit_ids]),
  };
  const explorationRequirement = fullExplorationCandidateRequirement(envelope, completeAllowedCandidates);
  const previouslyAcceptedCandidateIds = candidateIds(envelope?.partial_completion?.accepted_candidate_ids);
  const totalSelectedCandidateIds = candidateIds([
    ...previouslyAcceptedCandidateIds,
    ...selectedCandidateIds,
  ]);
  const candidateCardinalityDeficit = explorationRequirement.required
    ? Math.max(0, explorationRequirement.minimum - totalSelectedCandidateIds.length)
    : 0;
  if (selection.unavailable && !selection.unavailable_reason) {
    errors.push(diagnostic(
      "strategy_selection_unavailable_reason_missing",
      "strategy_selection.unavailable_reason",
      "An unavailable strategy selection must provide a non-empty reason.",
    ));
  }
  if (selection.unavailable && selectedCandidateIds.length) {
    errors.push(diagnostic(
      "strategy_selection_conflicting_availability",
      "strategy_selection",
      "A strategy selection cannot be both unavailable and contain selected candidate ids.",
      { selected_candidate_ids: selectedCandidateIds },
    ));
  }
  if (selection.unavailable && completeAllowedCandidates.length) {
    errors.push(diagnostic(
      "strategy_selection_unavailable_with_complete_candidates",
      "strategy_selection.unavailable",
      "A strategy obligation cannot be declared unavailable when the supplied working set contains complete atomic candidates.",
      { available_candidate_ids: completeAllowedCandidates.map((candidate) => candidate.candidate_id) },
    ));
  }
  if (rankingCandidateSelectionRequired && !selection.unavailable && !selectedCandidateIds.length) {
    errors.push(diagnostic(
      "strategy_selection_candidate_ids_missing",
      "strategy_selection.selected_candidate_ids",
      "Complete-roster obligations require at least one selected candidate id unless selection is explicitly unavailable with a reason.",
    ));
  }
  if (targetRosterRequired && !selection.unavailable && !targetIdentityPresent) {
    errors.push(diagnostic(
      "strategy_target_identity_missing",
      "delivery_envelope.target_plan",
      "A confirmed target must carry a stable candidate, custom-target, or chat-discovered identity.",
    ));
  }
  if (targetRosterRequired && !selection.unavailable && !resolvedTargetRoster.names.length && !resolvedTargetRoster.ids.length) {
    errors.push(diagnostic(
      "strategy_target_roster_missing",
      "delivery_envelope.target_plan",
      "A confirmed target must resolve to a complete roster from the target itself or its exact supplied candidate.",
    ));
  }
  if (!selection.unavailable && candidateCardinalityDeficit > 0) {
    errors.push(diagnostic(
      "strategy_selection_candidate_count_below_checkpoint_minimum",
      "strategy_selection.selected_candidate_ids",
      "The 2-2 full-exploration obligation must deliver three complete candidates when the supplied working set supports them.",
      {
        minimum_candidate_count: explorationRequirement.minimum,
        accepted_candidate_ids: previouslyAcceptedCandidateIds,
        selected_candidate_ids: selectedCandidateIds,
        additional_candidates_required: candidateCardinalityDeficit,
      },
    ));
  }
  if (!selection.unavailable
    && explorationRequirement.maximum !== null
    && totalSelectedCandidateIds.length > explorationRequirement.maximum) {
    errors.push(diagnostic(
      "strategy_selection_candidate_count_above_checkpoint_maximum",
      "strategy_selection.selected_candidate_ids",
      "The 2-2 player-visible exploration must remain bounded to at most five complete candidates.",
      { maximum_candidate_count: explorationRequirement.maximum, selected_candidate_ids: totalSelectedCandidateIds },
    ));
  }

  const allowedIds = candidateIds(
    Array.isArray(allowedCandidateIds) && allowedCandidateIds.length
      ? allowedCandidateIds
      : Array.isArray(allowed_candidate_ids) && allowed_candidate_ids.length
        ? allowed_candidate_ids
        : normalizedAllowedCandidates,
  );
  const allowedSet = new Set(allowedIds);
  if (selectedCandidateIds.length && !allowedIds.length) {
    errors.push(diagnostic(
      "strategy_selection_allowed_candidate_ids_missing",
      "allowed_candidate_ids",
      "Allowed candidate ids are required to validate a non-empty Host strategy selection.",
      { selected_candidate_ids: selectedCandidateIds },
    ));
  }
  const disallowedCandidateIds = selectedCandidateIds.filter((candidateId) => !allowedSet.has(candidateId));
  if (allowedIds.length && disallowedCandidateIds.length) {
    errors.push(diagnostic(
      "strategy_selection_candidate_id_not_allowed",
      "strategy_selection.selected_candidate_ids",
      "Every selected candidate id must belong to the supplied allowed candidate set.",
      { disallowed_candidate_ids: disallowedCandidateIds, allowed_candidate_ids: allowedIds },
    ));
  }

  const presentationsByCandidate = new Map(selection.candidate_presentations
    .filter((candidate) => candidate.candidate_id)
    .map((candidate) => [candidate.candidate_id, candidate]));
  const allowedByCandidate = new Map(normalizedAllowedCandidates
    .map((candidate) => [candidate.candidate_id, candidate]));
  const incompleteCandidatePresentationIds = [];
  if (completeRosterRequired && !selection.unavailable) {
    for (const candidateId of selectedCandidateIds) {
      const presentation = presentationsByCandidate.get(candidateId);
      const suppliedCandidate = allowedByCandidate.get(candidateId);
      if (!presentation || !candidatePresentationComplete(presentation)) {
        incompleteCandidatePresentationIds.push(candidateId);
        continue;
      }
      if (!presentation.selected_variant_id) {
        errors.push(diagnostic(
          "strategy_selection_variant_id_missing",
          "strategy_selection.candidate_presentations",
          "Every selected candidate presentation must bind an exact selected_variant_id.",
          { candidate_id: candidateId },
        ));
      } else if (!suppliedCandidate?.selected_variant_id || suppliedCandidate.selected_variant_id !== presentation.selected_variant_id) {
        errors.push(diagnostic(
          "strategy_selection_variant_id_mismatch",
          "strategy_selection.candidate_presentations",
          "A candidate presentation must bind the exact Runtime canonical variant.",
          { candidate_id: candidateId, expected: suppliedCandidate?.selected_variant_id || null, actual: presentation.selected_variant_id },
        ));
      }
      if (!presentation.candidate_evidence_id) {
        errors.push(diagnostic(
          "strategy_selection_candidate_evidence_id_missing",
          "strategy_selection.candidate_presentations",
          "Every selected candidate presentation must bind the exact Runtime candidate_evidence_id.",
          { candidate_id: candidateId },
        ));
      } else if (
        !suppliedCandidate?.candidate_evidence_id
        || suppliedCandidate.candidate_evidence_id !== presentation.candidate_evidence_id
      ) {
        errors.push(diagnostic(
          "strategy_selection_candidate_evidence_id_mismatch",
          "strategy_selection.candidate_presentations",
          "A candidate presentation must preserve the exact Runtime candidate evidence identity.",
          {
            candidate_id: candidateId,
            expected: suppliedCandidate?.candidate_evidence_id || null,
            actual: presentation.candidate_evidence_id,
          },
        ));
      }
      if (
        suppliedCandidate
        && suppliedCandidate.atomic_roster_id
        && presentation.atomic_roster_id
        && suppliedCandidate.atomic_roster_id !== presentation.atomic_roster_id
      ) {
        errors.push(diagnostic(
          "strategy_selection_atomic_roster_mismatch",
          "strategy_selection.candidate_presentations",
          "A candidate presentation must bind to the same atomic roster supplied by Runtime.",
          { candidate_id: candidateId, expected: suppliedCandidate.atomic_roster_id, actual: presentation.atomic_roster_id },
        ));
      }
      const suppliedNames = suppliedCandidate?.unit_names || [];
      const suppliedIds = suppliedCandidate?.unit_ids || [];
      const rosterMismatch = (suppliedNames.length && !sameStringSet(presentation.unit_names, suppliedNames))
        || (suppliedIds.length && !sameStringSet(presentation.unit_ids, suppliedIds))
        || presentation.target_population !== suppliedCandidate?.target_population;
      if ((suppliedNames.length || suppliedIds.length) && rosterMismatch) {
        errors.push(diagnostic(
          "strategy_selection_roster_member_not_allowed",
          "strategy_selection.candidate_presentations",
          "A candidate presentation must preserve the exact Runtime canonical roster set and population.",
          { candidate_id: candidateId },
        ));
      }
      const semanticFields = [
        ["atomic_roster_members", presentation.atomic_roster_members, suppliedCandidate?.atomic_roster_members],
        ["canonical_lineup_identity", presentation.canonical_lineup_identity, suppliedCandidate?.canonical_lineup_identity],
        ["atomic_roster_observation", presentation.atomic_roster_observation, suppliedCandidate?.atomic_roster_observation],
        ["atomic_variant_difference", presentation.atomic_variant_difference, suppliedCandidate?.atomic_variant_difference],
        ["mature_recipe_variants", presentation.mature_recipe_variants, suppliedCandidate?.mature_recipe_variants],
        ["mature_recipe_variant_receipt", presentation.mature_recipe_variant_receipt, suppliedCandidate?.mature_recipe_variant_receipt],
        ["main_carry", presentation.main_carry, suppliedCandidate?.main_carry],
        ["primary_tank", presentation.primary_tank, suppliedCandidate?.primary_tank],
        ["core_traits", presentation.core_traits, suppliedCandidate?.core_traits],
        ["equipment_plan", presentation.equipment_plan, suppliedCandidate?.equipment_plan],
        ["augment_conditions", presentation.augment_conditions, suppliedCandidate?.augment_conditions],
        ["transition_path", presentation.transition_path, suppliedCandidate?.transition_path],
        ["lifecycle_prior", presentation.lifecycle_prior, suppliedCandidate?.lifecycle_prior],
        ["formation_profile", presentation.formation_profile, suppliedCandidate?.formation_profile],
        ["positioning_template", presentation.positioning_template, suppliedCandidate?.positioning_template],
        ["source_role", presentation.source_role, suppliedCandidate?.source_role],
        ["metrics_authority", presentation.metrics_authority, suppliedCandidate?.metrics_authority],
        ["provenance", presentation.provenance, suppliedCandidate?.provenance],
        ["evidence_boundary", presentation.evidence_boundary, suppliedCandidate?.evidence_boundary],
        ["star_targets", presentation.star_targets, suppliedCandidate?.star_targets],
        ["cap", presentation.cap, suppliedCandidate?.cap],
        ["floor", presentation.floor, suppliedCandidate?.floor],
      ];
      for (const [field, actual, expected] of semanticFields) {
        if (meaningfulOutput(expected) && !sameStructuredValue(actual, expected)) {
          errors.push(diagnostic(
            "strategy_selection_canonical_variant_field_mismatch",
            `strategy_selection.candidate_presentations.${field}`,
            "A candidate presentation cannot mix strategic semantics from another candidate or variant.",
            { candidate_id: candidateId, field },
          ));
        }
      }
    }
  }
  if (incompleteCandidatePresentationIds.length) {
    errors.push(diagnostic(
      "strategy_selection_candidate_presentation_incomplete",
      "strategy_selection.candidate_presentations",
      "Every selected complete-roster candidate must include an atomic roster plus main carry and primary tank.",
      { incomplete_candidate_ids: incompleteCandidatePresentationIds },
    ));
  }
  const visibleText = normalizedText(payload?.final_text);
  const positionEvidence = selectedCandidateIds.map((id) => {
    const matches = (Array.isArray(allowedCandidates) && allowedCandidates.length ? allowedCandidates : allowed_candidates)
      .filter((candidate) => candidateIds([candidate])[0] === id);
    return candidatePositionEvidence(matches.length === 1 ? matches[0] : { candidate_id: id });
  });
  if (array(payload?.strategy_selection?.candidate_presentations).some((presentation) => !candidatePositionSourceMatches(
    presentation, array(allowedCandidates).length ? allowedCandidates : allowed_candidates,
  ))) {
    errors.push(diagnostic(
      "strategy_selection_position_evidence_missing",
      "strategy_selection",
      "Structured position fields require supplied candidate positioning evidence; missing source remains unknown.",
    ));
  }
  const rosterNamesMissingFromText = [];
  if (completeRosterRequired && !selection.unavailable) {
    for (const candidateId of selectedCandidateIds) {
      const presentation = presentationsByCandidate.get(candidateId);
      if (!presentation?.unit_names?.length) continue;
      const missingNames = presentation.unit_names
        .filter((name) => !visibleText.includes(normalizedText(name)));
      if (missingNames.length) rosterNamesMissingFromText.push({ candidate_id: candidateId, missing_names: missingNames });
    }
  }
  if (rosterNamesMissingFromText.length) {
    errors.push(diagnostic(
      "strategy_selection_roster_missing_from_final_text",
      "final_text",
      "The player-visible answer must name every unit in each selected complete atomic roster.",
      { candidates: rosterNamesMissingFromText },
    ));
  }
  if (targetRosterRequired && !selection.unavailable) {
    const targetRosterMissingFromText = resolvedTargetRoster.names
      .filter((name) => !visibleText.includes(normalizedText(name)));
    if (targetRosterMissingFromText.length) {
      errors.push(diagnostic(
        "strategy_target_roster_missing_from_final_text",
        "final_text",
        "A custom or chat-discovered confirmed target must name every target roster unit in the delivered answer.",
        { missing_names: targetRosterMissingFromText },
      ));
    }
  }
  const selectedRosterNames = new Set(selectedCandidateIds.flatMap((candidateId) => presentationsByCandidate.get(candidateId)?.unit_names || []));
  const selectedSources = normalizedAllowedCandidates.filter((candidate) => selectedCandidateIds.includes(candidate.candidate_id));
  const recipeOnlyNames = strings(selectedSources.flatMap(matureRecipeAlternativeUnitNames))
    .filter((name) => !selectedRosterNames.has(name));
  const memberTextContext = {
    temporaryNames: new Set(selectedSources.flatMap((candidate) => transitionEvidenceNames(candidate.transition_path)).map(normalizedText)),
    memberNames: strings([...normalizedAllowedCandidates.flatMap((candidate) => candidate.unit_names), ...recipeOnlyNames]),
  };
  const decisionTexts = Object.values(completion.decision_outputs).map((output) => (
    typeof output === "string" ? output : JSON.stringify(output)
  ));
  const foreignVisibleNames = normalizedAllowedCandidates
    .filter((candidate) => !selectedCandidateIds.includes(candidate.candidate_id))
    .flatMap((candidate) => candidate.unit_names)
    .filter((name) => (
      !selectedRosterNames.has(name)
      && [payload?.final_text, ...decisionTexts].some((text) => (
        rankingMemberTextClaims(text, name, memberTextContext).some((claim) => claim.action && !claim.allowed)
      ))
    ));
  if (foreignVisibleNames.length) {
    errors.push(diagnostic(
      "strategy_selection_foreign_roster_member_in_final_text",
      "final_text",
      "Player-visible lineup members must belong only to the selected canonical rosters.",
      { foreign_member_names: strings(foreignVisibleNames) },
    ));
  }
  const recipeNamesInDecisionOutputs = recipeOnlyNames.filter((name) => (
    Object.values(completion.decision_outputs).some((output) => rankingMemberTextClaims(
      typeof output === "string" ? output : JSON.stringify(output), name, memberTextContext,
    ).some((claim) => !claim.allowed))
  ));
  if (recipeNamesInDecisionOutputs.length) {
    errors.push(diagnostic(
      "strategy_selection_unselected_recipe_variant_member_in_decision_output",
      "strategic_completion.decision_outputs",
      "A mature recipe alternative may be explained as a separate variant, but its units cannot become operational decisions for the selected Master+ standard roster.",
      { recipe_variant_member_names: recipeNamesInDecisionOutputs },
    ));
  }
  const unlabeledRecipeNames = recipeOnlyNames.filter((name) => (
    rankingMemberTextClaims(payload?.final_text, name, memberTextContext).some((claim) => !claim.allowed)
  ));
  if (unlabeledRecipeNames.length) {
    errors.push(diagnostic(
      "strategy_selection_recipe_variant_member_unlabeled_in_final_text",
      "final_text",
      "Recipe discussion is allowed; affirmative operational instructions must not silently modify the selected standard roster.",
      { recipe_variant_member_names: unlabeledRecipeNames },
    ));
  }
  const receiptErrorCodes = new Set([
    "delivery_envelope_receipt_invalid",
    "delivery_envelope_receipt_duplicate_block",
    "strategic_completion_receipt_invalid",
    "strategic_completion_receipt_duplicate_block",
    "strategic_completion_receipt_missing",
    "strategic_completion_receipt_mismatch",
    "strategic_completion_receipt_unexpected",
  ]);
  const selectionErrorCodes = new Set([
    "strategy_selection_unavailable_reason_missing",
    "strategy_selection_conflicting_availability",
    "strategy_selection_candidate_ids_missing",
    "strategy_selection_allowed_candidate_ids_missing",
    "strategy_selection_candidate_id_not_allowed",
    "strategy_selection_candidate_ref_ambiguous",
    "strategy_selection_candidate_ref_unresolved",
    "strategy_selection_unavailable_with_complete_candidates",
    "strategy_selection_candidate_presentation_incomplete",
    "strategy_selection_variant_id_missing",
    "strategy_selection_variant_id_mismatch",
    "strategy_selection_atomic_roster_mismatch",
    "strategy_selection_roster_member_not_allowed",
    "strategy_selection_canonical_variant_field_mismatch",
    "strategy_selection_roster_missing_from_final_text",
    "strategy_selection_foreign_roster_member_in_final_text",
    "strategy_selection_position_evidence_missing",
    "strategy_selection_candidate_count_below_checkpoint_minimum",
    "strategy_selection_candidate_count_above_checkpoint_maximum",
    "strategy_selection_unselected_recipe_variant_member_in_decision_output",
    "strategy_selection_recipe_variant_member_unlabeled_in_final_text",
  ]);
  const candidateErrorIds = new Set(errors.flatMap((entry) => strings([
    entry.candidate_id,
    entry.incomplete_candidate_ids,
    array(entry.candidates).map((candidate) => candidate?.candidate_id),
  ])));
  const acceptedCandidatePresentations = selectedCandidateIds
    .map((candidateId) => presentationsByCandidate.get(candidateId))
    .filter((presentation) => (
      presentation
        && candidatePresentationComplete(presentation)
        && allowedSet.has(presentation.candidate_id)
        && !candidateErrorIds.has(presentation.candidate_id)
        && presentation.unit_names.every((name) => visibleText.includes(normalizedText(name)))
    ));
  const pendingCandidateIds = selectedCandidateIds.filter((candidateId) => (
    !acceptedCandidatePresentations.some((candidate) => candidate.candidate_id === candidateId)
  ));
  const acceptedDecisionOutputs = Object.fromEntries(requiredCoverage
    .filter((entry) => !(
      (pendingCandidateIds.length || candidateCardinalityDeficit > 0)
        && ["complete_candidate_rosters", "complete_final_roster"].includes(entry.key)
    ))
    .filter((entry) => coveredKeys.has(entry.key) && decisionOutputKeys.has(entry.key))
    .map((entry) => {
      const outputEntry = Object.entries(completion.decision_outputs)
        .find(([decision]) => decisionCoverageKey(decision) === entry.key);
      return [entry.decision, outputEntry?.[1]];
    })
    .filter(([, output]) => meaningfulOutput(output)));
  return {
    schema: "jcc-cruise-strategic-response-coverage-diagnostic-v1",
    ok: errors.length === 0,
    errors,
    checks: {
      queue_revision_exact: !errors.some((entry) => (
        entry.code === "delivery_envelope_queue_revision_missing"
          || entry.code === "strategic_completion_queue_revision_mismatch"
      )),
      completion_receipts_exact: !errors.some((entry) => receiptErrorCodes.has(entry.code)),
      required_decisions_covered: missingRequiredDecisions.length === 0,
      required_decision_outputs_complete: missingDecisionOutputs.length === 0,
      strategy_selection_valid: !errors.some((entry) => selectionErrorCodes.has(entry.code)),
      candidate_presentations_complete: incompleteCandidatePresentationIds.length === 0,
    },
    required_decisions: requiredCoverage.map((entry) => entry.decision),
    missing_required_decisions: missingRequiredDecisions,
    missing_decision_outputs: missingDecisionOutputs,
    complete_candidate_rosters_required: completeRosterRequired,
    allowed_candidate_ids: allowedIds,
    disallowed_candidate_ids: disallowedCandidateIds,
    position_evidence: positionEvidence,
    partial_completion: {
      accepted_required_decisions: Object.keys(acceptedDecisionOutputs),
      accepted_decision_outputs: acceptedDecisionOutputs,
      accepted_candidate_ids: acceptedCandidatePresentations.map((candidate) => candidate.candidate_id),
      accepted_candidate_presentations: acceptedCandidatePresentations,
      pending_candidate_ids: pendingCandidateIds,
      required_additional_candidate_count: candidateCardinalityDeficit,
    },
    normalized_payload: normalized,
  };
}

export function strategicObligationResponseDiagnostics(
  envelope,
  response,
  allowedCandidateIds = [],
  allowedCandidates = [],
  contextOptions = {},
) {
  return diagnoseStrategicObligationResponseCoverage(
    envelope,
    response,
    { allowedCandidateIds, allowedCandidates, ...objectValue(contextOptions) },
  );
}

export function strategicObligationResponseIsComplete(
  envelope,
  response,
  allowedCandidateIds = [],
  allowedCandidates = [],
) {
  return strategicObligationResponseDiagnostics(
    envelope,
    response,
    allowedCandidateIds,
    allowedCandidates,
  ).ok;
}

function checkpointForEvent(event = {}) {
  const checkpoint = cruiseCheckpointById(
    event.fixed_checkpoint_id
      || event.runtime_event_context?.fixed_checkpoint_id
      || event.checkpoint_answer_contract?.checkpoint_id,
  );
  const stageRound = String(
    event.fixed_checkpoint_stage_round
      || event.runtime_event_context?.fixed_checkpoint_stage_round
      || event.stage_round
      || event.fixed_checkpoint?.stage_round
      || event.runtime_event_context?.stage_round
      || event.checkpoint_answer_contract?.stage_round
      || "",
  ).trim();
  // A strategic obligation is created only by a registered checkpoint event.
  // Stage number alone is insufficient because legacy tempo events also carry it.
  if (!checkpoint || !stageRound || checkpoint.stage_round !== stageRound) return null;
  return checkpoint;
}

function requiredDecisionsFor(event, checkpoint) {
  return strings([
    event.checkpoint_answer_contract?.required_decisions,
    checkpoint?.answer_contract?.required_decisions,
  ]);
}

function checkpointAnswerContractFor(event, checkpoint, targetPlan = null) {
  const answerContract = event.checkpoint_answer_contract
    || checkpoint?.answer_contract
    || null;
  if (!answerContract || typeof answerContract !== "object") return null;
  return {
    checkpoint_id: checkpoint?.checkpoint_id || event.fixed_checkpoint_id || null,
    stage_round: checkpoint?.stage_round || event.stage_round || null,
    strategy_block_id: checkpoint?.strategy_block_id || event.strategy_block_id || null,
    block_sequence: checkpoint?.block_sequence ?? null,
    block_role: checkpoint?.block_role || null,
    focus: checkpoint?.focus || null,
    action_brief: answerContract.action_brief || null,
    primary_decision: answerContract.primary_decision || null,
    candidate_policy: targetAwareCandidatePolicy(checkpoint, answerContract, targetPlan),
    required_decisions: targetAwareRequiredDecisions(checkpoint, answerContract, targetPlan),
    supporting_decisions: strings(answerContract.supporting_decisions),
    equipment_policy: answerContract.equipment_policy || null,
    execution_scope: answerContract.execution_scope || null,
  };
}

function canonicalRequiredDecisions(values) {
  const result = new Set(strings(values));
  for (const [canonical, aliases] of Object.entries(REQUIRED_FIELD_ALIASES)) {
    if (aliases.some((alias) => result.has(alias))) {
      aliases.forEach((alias) => result.add(alias));
      result.add(canonical);
    }
  }
  return [...result];
}

function blockSequence(checkpoint) {
  return Number.isFinite(Number(checkpoint?.block_sequence))
    ? Number(checkpoint.block_sequence)
    : 0;
}

function checkpointOrder(checkpoint) {
  if (Number.isFinite(Number(checkpoint?.agenda_order))) return Number(checkpoint.agenda_order);
  const agenda = cruiseCheckpointAgendaSnapshot();
  const index = agenda.findIndex((entry) => entry.checkpoint_id === checkpoint?.checkpoint_id);
  return index >= 0 ? index : -1;
}

function obligationForCheckpoint(event, checkpoint, previous = null) {
  const blockId = checkpoint?.strategy_block_id || event.strategy_block_id || "unknown_strategy_block";
  const targetPlan = durableTargetPlanFor(event, previous);
  const currentContract = checkpointAnswerContractFor(event, checkpoint, targetPlan);
  const priorContracts = Array.isArray(previous?.checkpoint_contracts)
    ? previous.checkpoint_contracts
    : [];
  const checkpointContracts = [
    ...priorContracts.filter((entry) => entry?.checkpoint_id !== currentContract?.checkpoint_id),
    ...(currentContract ? [{ ...currentContract, absorbed: false }] : []),
  ].map((entry) => ({
    ...entry,
    absorbed: entry.checkpoint_id !== currentContract?.checkpoint_id,
  }));
  const absorbedContracts = checkpointContracts.filter((entry) => entry.absorbed === true);
  const checkpointActionFingerprints = {
    ...objectValue(previous?.checkpoint_action_fingerprints),
    ...(event.current_hash
      ? { [checkpoint.checkpoint_id]: String(event.current_hash).trim() }
      : {}),
  };
  const acceptedDecisionKeys = new Set(requiredDecisionCoverage(previous?.partial_completion?.accepted_required_decisions)
    .map((entry) => entry.key));
  const required = canonicalRequiredDecisions(targetPlan
    ? [
      ...(currentContract?.required_decisions || []),
      ...(previous?.required_decisions || []).filter((decision) => (
        TARGET_EXECUTION_REQUIRED_DECISIONS.includes(decision)
          || decision.startsWith("target_")
          || [
            "economy_posture",
            "current_board_quality",
            "economy_and_hp_tolerance",
            "equipment_distribution",
            "blood_and_board_tolerance",
            "equipment_continuity",
            "target_validity",
          ].includes(decision)
      )),
    ]
    : [
      ...(previous?.required_decisions || []),
      ...requiredDecisionsFor(event, checkpoint),
    ]).filter((decision) => !acceptedDecisionKeys.has(decisionCoverageKey(decision)));
  const candidateRequirements = strings([
    targetPlan ? currentContract?.candidate_policy : previous?.candidate_requirements,
    targetPlan ? null : checkpoint?.answer_contract?.candidate_policy,
    event.candidate_requirements,
  ]);
  return {
    schema: CRUISE_STRATEGIC_OBLIGATION_QUEUE_SCHEMA,
    block_id: blockId,
    block_role: checkpoint?.block_role || event.fixed_checkpoint_block_role || null,
    latest_checkpoint_id: checkpoint?.checkpoint_id || null,
    latest_stage_round: checkpoint?.stage_round
      || event.stage_round
      || event.fixed_checkpoint_stage_round
      || event.runtime_event_context?.stage_round
      || event.runtime_event_context?.fixed_checkpoint_stage_round
      || null,
    latest_block_sequence: blockSequence(checkpoint),
    latest_checkpoint_order: checkpointOrder(checkpoint),
    primary_trigger_id: event.decision_trigger_id || "lineup_convergence_checkpoint",
    required_decisions: required,
    candidate_requirements: candidateRequirements,
    required_checkpoint_ids: strings([
      ...(previous?.required_checkpoint_ids || []),
      checkpoint?.checkpoint_id,
    ]),
    absorbed_checkpoint_ids: strings([
      ...(previous?.absorbed_checkpoint_ids || []),
      previous?.latest_checkpoint_id && previous.latest_checkpoint_id !== checkpoint?.checkpoint_id
        ? previous.latest_checkpoint_id
        : null,
    ]),
    complete_candidate_rosters_required: !targetPlan && required.some((value) => (
      value === "complete_candidate_rosters"
        || value === "complete_candidate_rosters_and_roles"
        || value === "complete_final_roster"
        || value === "full_final_roster"
    )),
    latest_event_key: event.event_key || event.semantic_key || null,
    latest_event: event,
    checkpoint_action_fingerprints: checkpointActionFingerprints,
    checkpoint_contracts: checkpointContracts,
    checkpoint_answer_contract: currentContract,
    primary_decision: currentContract?.primary_decision || null,
    supporting_decisions: strings([
      ...(previous?.supporting_decisions || []),
      ...(currentContract?.supporting_decisions || []),
    ]),
    candidate_policy: currentContract?.candidate_policy || previous?.candidate_policy || null,
    target_plan: targetPlan,
    target_context_authority: targetPlan ? "durable_target_plan" : previous?.target_context_authority || "none",
    target_roster_required: Boolean(targetPlan),
    ranking_candidate_selection_required: Boolean(targetPlan?.candidate_id || targetPlan?.selected_variant_id),
    absorbed_checkpoint_contracts: absorbedContracts,
    partial_completion: previous?.partial_completion || null,
    pending_candidate_ids: strings(previous?.pending_candidate_ids),
    status: "pending",
    revision: Number(previous?.revision || 0) + 1,
    updated_at: new Date().toISOString(),
  };
}

function mergeOlderCheckpointIntoObligation(event, checkpoint, previous) {
  const targetPlan = durableTargetPlanFor(event, previous);
  const olderContract = checkpointAnswerContractFor(event, checkpoint, targetPlan);
  const checkpointContracts = [
    ...(previous?.checkpoint_contracts || []).filter((entry) => entry?.checkpoint_id !== olderContract?.checkpoint_id),
    ...(olderContract ? [{ ...olderContract, absorbed: true }] : []),
  ];
  const acceptedDecisionKeys = new Set(requiredDecisionCoverage(previous?.partial_completion?.accepted_required_decisions)
    .map((entry) => entry.key));
  const required = canonicalRequiredDecisions(targetPlan
    ? [
      ...(previous?.required_decisions || []).filter((decision) => (
        TARGET_EXECUTION_REQUIRED_DECISIONS.includes(decision)
          || decision.startsWith("target_")
          || decision === "complete_final_roster"
      )),
      ...(olderContract?.required_decisions || []),
    ]
    : [
      ...(previous?.required_decisions || []),
      ...requiredDecisionsFor(event, checkpoint),
    ]).filter((decision) => !acceptedDecisionKeys.has(decisionCoverageKey(decision)));
  const checkpointActionFingerprints = {
    ...objectValue(previous?.checkpoint_action_fingerprints),
    ...(event.current_hash
      ? { [checkpoint.checkpoint_id]: String(event.current_hash).trim() }
      : {}),
  };
  return {
    ...previous,
    required_decisions: required,
    candidate_requirements: strings([
      targetPlan ? olderContract?.candidate_policy : previous?.candidate_requirements,
      targetPlan ? null : checkpoint?.answer_contract?.candidate_policy,
      event.candidate_requirements,
    ]),
    required_checkpoint_ids: strings([
      ...(previous?.required_checkpoint_ids || []),
      checkpoint?.checkpoint_id,
    ]),
    absorbed_checkpoint_ids: strings([
      ...(previous?.absorbed_checkpoint_ids || []),
      checkpoint?.checkpoint_id,
    ]),
    complete_candidate_rosters_required: !targetPlan && required.some((value) => (
      value === "complete_candidate_rosters"
        || value === "complete_candidate_rosters_and_roles"
        || value === "complete_final_roster"
        || value === "full_final_roster"
    )),
    checkpoint_contracts: checkpointContracts,
    checkpoint_action_fingerprints: checkpointActionFingerprints,
    absorbed_checkpoint_contracts: checkpointContracts.filter((entry) => entry.absorbed === true),
    supporting_decisions: strings([
      ...(previous?.supporting_decisions || []),
      ...(olderContract?.supporting_decisions || []),
    ]),
    target_plan: targetPlan || previous?.target_plan || null,
    target_context_authority: targetPlan || previous?.target_plan ? "durable_target_plan" : previous?.target_context_authority || "none",
    target_roster_required: Boolean(targetPlan || previous?.target_plan),
    ranking_candidate_selection_required: Boolean(
      targetPlan?.candidate_id
        || targetPlan?.selected_variant_id
        || previous?.ranking_candidate_selection_required,
    ),
    revision: Number(previous?.revision || 0) + 1,
    updated_at: new Date().toISOString(),
  };
}

export function createStrategicObligationQueueState() {
  return {
    schema: CRUISE_STRATEGIC_OBLIGATION_QUEUE_SCHEMA,
    revision: 0,
    obligations_by_block: {},
    updated_at: null,
  };
}

export function isStrategicCheckpointEvent(event = {}) {
  const checkpoint = checkpointForEvent(event);
  return Boolean(
    checkpoint
      && STRATEGIC_TRIGGERS.has(String(event.decision_trigger_id || "")),
  );
}

export function enqueueStrategicObligation(queueInput, event = {}) {
  const queue = queueInput && typeof queueInput === "object"
    ? queueInput
    : createStrategicObligationQueueState();
  const checkpoint = checkpointForEvent(event);
  if (!isStrategicCheckpointEvent(event) || !checkpoint?.strategy_block_id) return queue;
  const blockId = checkpoint.strategy_block_id;
  const previous = queue.obligations_by_block?.[blockId] || null;
  const incomingEventKey = event.event_key || event.semantic_key || null;
  // Detector, scorer, retry, and delivery wrappers may all represent the same
  // registered checkpoint with different event keys. The checkpoint identity,
  // not the transient wrapper identity, owns the durable obligation revision.
  // Current live facts are resolved again when the obligation is delivered.
  if (previous?.latest_checkpoint_id === checkpoint.checkpoint_id) {
    const incomingTarget = durableTargetPlanFor(event, null);
    const previousTarget = durableTargetPlanFor({}, previous);
    if (!incomingTarget || sameStrategicTarget(incomingTarget, previousTarget)) return queue;
    const upgraded = obligationForCheckpoint(event, checkpoint, previous);
    queue.obligations_by_block = {
      ...(queue.obligations_by_block || {}),
      [blockId]: upgraded,
    };
    queue.revision = Number(queue.revision || 0) + 1;
    queue.updated_at = upgraded.updated_at;
    return queue;
  }
  const incomingCheckpointOrder = checkpointOrder(checkpoint);
  if (
    previous
    && incomingCheckpointOrder >= 0
    && incomingCheckpointOrder < Number(previous.latest_checkpoint_order ?? -1)
  ) {
    if (previous.required_checkpoint_ids?.includes(checkpoint.checkpoint_id)) return queue;
    const merged = mergeOlderCheckpointIntoObligation(event, checkpoint, previous);
    queue.obligations_by_block = {
      ...(queue.obligations_by_block || {}),
      [blockId]: merged,
    };
    queue.revision = Number(queue.revision || 0) + 1;
    queue.updated_at = merged.updated_at;
    return queue;
  }
  const next = obligationForCheckpoint(event, checkpoint, previous);
  queue.obligations_by_block = {
    ...(queue.obligations_by_block || {}),
    [blockId]: next,
  };
  queue.revision = Number(queue.revision || 0) + 1;
  queue.updated_at = next.updated_at;
  return queue;
}

export function absorbStrategicObligation(queueInput, event = {}) {
  const queue = enqueueStrategicObligation(queueInput, event);
  const checkpoint = checkpointForEvent(event);
  if (!checkpoint?.strategy_block_id) return queue;
  const obligation = queue.obligations_by_block?.[checkpoint.strategy_block_id];
  if (!obligation) return queue;
  obligation.absorbed_checkpoint_ids = strings([
    ...obligation.absorbed_checkpoint_ids,
    ...obligation.required_checkpoint_ids.filter((id) => id !== obligation.latest_checkpoint_id),
  ]);
  obligation.updated_at = new Date().toISOString();
  queue.updated_at = obligation.updated_at;
  return queue;
}

export function selectPrimaryStrategicObligation(queueInput) {
  const obligations = Object.values(queueInput?.obligations_by_block || {})
    .filter((entry) => entry?.status === "pending");
  return obligations.sort((left, right) => (
    Number(right.latest_checkpoint_order || -1) - Number(left.latest_checkpoint_order || -1)
      || Number(right.latest_block_sequence || 0) - Number(left.latest_block_sequence || 0)
      || String(right.updated_at || "").localeCompare(String(left.updated_at || ""))
  ))[0] || null;
}

export function strategicObligationDeliveryEnvelope(queueInput) {
  const pending = Object.values(queueInput?.obligations_by_block || {})
    .filter((entry) => entry?.status === "pending");
  const primary = selectPrimaryStrategicObligation(queueInput);
  if (!primary) return null;
  const supporting = pending.filter((entry) => entry.block_id !== primary.block_id);
  return {
    ...structuredClone(primary),
    schema: "jcc-cruise-strategic-obligation-delivery-envelope-v1",
    queue_schema: CRUISE_STRATEGIC_OBLIGATION_QUEUE_SCHEMA,
    queue_revision: Number(queueInput?.revision || 0),
    delivery_policy: "latest_checkpoint_is_primary; merge every pending block's required decisions and contracts into one answer; complete only exact delivered revisions",
    required_decisions: canonicalRequiredDecisions(pending.flatMap((entry) => entry.required_decisions || [])),
    required_checkpoint_ids: strings(pending.flatMap((entry) => entry.required_checkpoint_ids || [])),
    candidate_requirements: strings(pending.flatMap((entry) => entry.candidate_requirements || [])),
    supporting_decisions: strings(pending.flatMap((entry) => entry.supporting_decisions || [])),
    complete_candidate_rosters_required: pending.some((entry) => entry.complete_candidate_rosters_required === true),
    target_roster_required: pending.some((entry) => entry.target_roster_required === true),
    ranking_candidate_selection_required: pending.some((entry) => entry.ranking_candidate_selection_required === true),
    partial_completion: {
      accepted_required_decisions: canonicalRequiredDecisions(pending.flatMap((entry) => entry.partial_completion?.accepted_required_decisions || [])),
      accepted_decision_outputs: Object.assign({}, ...pending.map((entry) => entry.partial_completion?.accepted_decision_outputs || {})),
      accepted_candidate_ids: strings(pending.flatMap((entry) => entry.partial_completion?.accepted_candidate_ids || [])),
      accepted_candidate_presentations: pending.flatMap((entry) => entry.partial_completion?.accepted_candidate_presentations || []),
      required_additional_candidate_count: Math.max(0, ...pending.map((entry) => Number(entry.pending_candidate_count || 0))),
    },
    pending_candidate_ids: strings(pending.flatMap((entry) => entry.pending_candidate_ids || [])),
    checkpoint_contracts: pending.flatMap((entry) => entry.checkpoint_contracts || []),
    checkpoint_action_fingerprints_by_block: Object.fromEntries(pending.map((entry) => [
      entry.block_id,
      structuredClone(entry.checkpoint_action_fingerprints || {}),
    ])),
    absorbed_checkpoint_contracts: pending.flatMap((entry) => entry.absorbed_checkpoint_contracts || []),
    supporting_obligations: supporting.map((entry) => ({
      block_id: entry.block_id,
      block_role: entry.block_role || null,
      latest_checkpoint_id: entry.latest_checkpoint_id || null,
      latest_stage_round: entry.latest_stage_round || null,
      primary_decision: entry.primary_decision || null,
      required_decisions: [...(entry.required_decisions || [])],
      candidate_policy: entry.candidate_policy || null,
      checkpoint_contracts: structuredClone(entry.checkpoint_contracts || []),
    })),
    completion_receipts: pending.map((entry) => ({
      block_id: entry.block_id,
      revision: Number(entry.revision || 0),
      latest_checkpoint_id: entry.latest_checkpoint_id || null,
    })),
  };
}

export function recordStrategicObligationPartialCompletion(queueInput, deliveryEnvelope = {}, coverage = {}) {
  const queue = queueInput && typeof queueInput === "object"
    ? queueInput
    : createStrategicObligationQueueState();
  const partial = objectValue(coverage?.partial_completion);
  const acceptedDecisions = canonicalRequiredDecisions(partial.accepted_required_decisions);
  const acceptedDecisionKeys = new Set(requiredDecisionCoverage(acceptedDecisions).map((entry) => entry.key));
  const acceptedPresentations = (Array.isArray(partial.accepted_candidate_presentations)
    ? partial.accepted_candidate_presentations
    : []).map(normalizedCandidatePresentation).filter(candidatePresentationComplete);
  const pendingCandidateIds = strings(partial.pending_candidate_ids);
  const requiredAdditionalCandidateCount = Math.max(0, Number(partial.required_additional_candidate_count || 0));
  if (!acceptedDecisions.length && !acceptedPresentations.length) return queue;

  let changed = false;
  const nextObligations = { ...(queue.obligations_by_block || {}) };
  for (const rawReceipt of Array.isArray(deliveryEnvelope?.completion_receipts) ? deliveryEnvelope.completion_receipts : []) {
    const receipt = normalizedCompletionReceipt(rawReceipt);
    const obligation = nextObligations[receipt.block_id];
    if (!obligation || receipt.revision === null || Number(obligation.revision) !== Number(receipt.revision)) continue;
    const obligationDecisionKeys = new Set(requiredDecisionCoverage(obligation.required_decisions).map((entry) => entry.key));
    const acceptedForBlock = acceptedDecisions.filter((decision) => obligationDecisionKeys.has(decisionCoverageKey(decision)));
    const acceptedCandidatesForBlock = obligation.complete_candidate_rosters_required ? acceptedPresentations : [];
    if (!acceptedForBlock.length && !acceptedCandidatesForBlock.length) continue;
    const previousPartial = objectValue(obligation.partial_completion);
    const presentationsById = new Map([
      ...array(previousPartial.accepted_candidate_presentations),
      ...acceptedCandidatesForBlock,
    ].map(normalizedCandidatePresentation).filter(candidatePresentationComplete).map((candidate) => [candidate.candidate_id, candidate]));
    const nextPartial = {
      accepted_required_decisions: canonicalRequiredDecisions([
        previousPartial.accepted_required_decisions,
        acceptedForBlock,
      ]),
      accepted_decision_outputs: {
        ...objectValue(previousPartial.accepted_decision_outputs),
        ...Object.fromEntries(Object.entries(objectValue(partial.accepted_decision_outputs))
          .filter(([decision]) => obligationDecisionKeys.has(decisionCoverageKey(decision)))),
      },
      accepted_candidate_ids: [...presentationsById.keys()],
      accepted_candidate_presentations: [...presentationsById.values()],
      required_additional_candidate_count: requiredAdditionalCandidateCount,
    };
    const remainingRequired = canonicalRequiredDecisions(obligation.required_decisions)
      .filter((decision) => !acceptedDecisionKeys.has(decisionCoverageKey(decision)));
    const remainingCandidateIds = strings([
      obligation.pending_candidate_ids,
      pendingCandidateIds,
    ]).filter((candidateId) => !presentationsById.has(candidateId));
    const unchanged = sameStructuredValue(previousPartial, nextPartial)
      && sameStringSet(obligation.required_decisions, remainingRequired)
      && sameStringSet(obligation.pending_candidate_ids, remainingCandidateIds);
    if (unchanged) continue;
    nextObligations[receipt.block_id] = {
      ...obligation,
      required_decisions: remainingRequired,
      partial_completion: nextPartial,
      pending_candidate_ids: remainingCandidateIds,
      pending_candidate_count: requiredAdditionalCandidateCount,
      status: "pending",
      revision: Number(obligation.revision || 0),
      updated_at: new Date().toISOString(),
    };
    changed = true;
  }
  if (!changed) return queue;
  queue.obligations_by_block = nextObligations;
  queue.revision = Number(queue.revision || 0) + 1;
  queue.updated_at = new Date().toISOString();
  return queue;
}

export function completeStrategicObligation(queueInput, { blockId, revision } = {}) {
  const queue = queueInput && typeof queueInput === "object"
    ? queueInput
    : createStrategicObligationQueueState();
  const obligation = queue.obligations_by_block?.[blockId];
  if (!obligation) return queue;
  if (integerOrNull(revision) === null || Number(revision) !== Number(obligation.revision)) return queue;
  queue.obligations_by_block = { ...(queue.obligations_by_block || {}) };
  delete queue.obligations_by_block[blockId];
  queue.revision = Number(queue.revision || 0) + 1;
  queue.updated_at = new Date().toISOString();
  return queue;
}

export function completeStrategicObligationReceipts(queueInput, receipts = []) {
  let queue = queueInput && typeof queueInput === "object"
    ? queueInput
    : createStrategicObligationQueueState();
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    queue = completeStrategicObligation(queue, {
      blockId: receipt?.block_id,
      revision: receipt?.revision,
    });
  }
  return queue;
}

export function completeStrategicObligationDelivery(queueInput, deliveryEnvelope = {}) {
  let queue = queueInput && typeof queueInput === "object"
    ? queueInput
    : createStrategicObligationQueueState();
  for (const rawReceipt of Array.isArray(deliveryEnvelope?.completion_receipts)
    ? deliveryEnvelope.completion_receipts
    : []) {
    const receipt = normalizedCompletionReceipt(rawReceipt);
    const obligation = queue.obligations_by_block?.[receipt.block_id];
    if (!obligation || receipt.revision === null) continue;
    if (Number(obligation.revision) === Number(receipt.revision)
      && receipt.latest_checkpoint_id === obligation.latest_checkpoint_id) {
      queue = completeStrategicObligation(queue, {
        blockId: receipt.block_id,
        revision: receipt.revision,
      });
      continue;
    }
    if (Number(obligation.revision) < Number(receipt.revision)) continue;
    // A response may close another block whose revision did not change, but it
    // must never partially reconcile a block that advanced while the response
    // was running. The newer block owns the merged obligations and target.
  }
  return queue;
}

export function strategicObligationSnapshot(queueInput) {
  return structuredClone(queueInput || createStrategicObligationQueueState());
}
