import { createHash } from "node:crypto";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function containsAtomicCandidates(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return false;
  if (Array.isArray(value)) return value.some((entry) => containsAtomicCandidates(entry, depth + 1));
  return Object.entries(value).some(([key, child]) => (
    /^(?:candidates?|candidate_(?:frontier|lines|presentations)|canonical_variant|roster|transitions)$/i.test(key)
      ? Array.isArray(child) || Boolean(child && typeof child === "object")
      : containsAtomicCandidates(child, depth + 1)
  ));
}

export function createEvidenceMaterializationRegistry(evidenceSnapshotId) {
  const entries = new Map();
  return {
    register(facetId, value) {
      if (value === null || value === undefined) return null;
      const contentSha256 = sha256(value);
      const evidenceKey = `${evidenceSnapshotId}:material:${contentSha256}`;
      const existing = entries.get(evidenceKey);
      if (existing) {
        if (!existing.facet_ids.includes(facetId)) existing.facet_ids.push(facetId);
        return existing;
      }
      const entry = {
        evidence_key: evidenceKey,
        evidence_identity: `sha256:${contentSha256}`,
        canonical_facet_id: facetId,
        facet_ids: [facetId],
        contains_atomic_candidates: containsAtomicCandidates(value),
        value,
      };
      entries.set(evidenceKey, entry);
      return entry;
    },
    get(evidenceKey) {
      return entries.get(evidenceKey) || null;
    },
    manifest() {
      return [...entries.values()].map(({ value: _value, ...entry }) => entry);
    },
  };
}

function frameworkDefinition(framework) {
  return asArray(framework?.entries).find((entry) => entry?.framework_schema === "jcc-common-strategy-evidence-framework-v1")
    || framework;
}

function routeMatches(route, text) {
  const normalized = String(text || "").toLocaleLowerCase("zh-CN");
  return asArray(route?.intent_terms).some((term) => normalized.includes(String(term).toLocaleLowerCase("zh-CN")));
}

export function planStrategyEvidenceRouteIds(framework, {
  queryText,
  runtimeMode,
  requestKind,
  runtimeContext,
} = {}) {
  const routes = asArray(frameworkDefinition(framework)?.routes);
  let selected = routes.filter((route) => routeMatches(route, queryText)).map((route) => route.id);
  // Route text is only a hint. Entity resolution and UI contracts are authoritative
  // inputs; a natural-language paraphrase must still receive the matching facts.
  const hasResolvedEntity = Boolean(runtimeContext?.resolved_entities?.length
    || runtimeContext?.decision_math_context?.components?.entity_details
    || runtimeContext?.decision_math_context?.operation === "query_core_entities"
    || runtimeContext?.current_match_user_report?.mentioned_entities?.length);
  if (hasResolvedEntity) selected.push("entity_details");
  const lobbyMode = ["daily_chat", "postgame_review", "strategy_wiki", "user_preferences"].includes(runtimeMode);
  const hasCurrentMatchFacts = Boolean(runtimeContext?.match_facts || runtimeContext?.match_session?.status === "active");
  if (lobbyMode && !hasCurrentMatchFacts) {
    selected = selected.filter((routeId) => routeId !== "current_match_strategy");
    if (runtimeMode === "daily_chat" && /(上分|版本|环境|强势)/i.test(String(queryText || ""))) {
      selected.push("lobby_meta_strategy");
    }
    if (runtimeMode === "postgame_review") {
      selected.push("postgame_review_strategy");
    }
  }
  if (["cruise", "lineup_card"].includes(runtimeMode) && runtimeContext?.match_facts) selected.push("current_match_strategy");
  if (runtimeMode === "lineup_card") selected.push("lineup_construction");
  if (runtimeMode === "augment_choice" || runtimeContext?.cruise_decision_context?.augment_choice_evaluation) selected.push("augment_selection");
  if (runtimeMode === "item_choice" || runtimeContext?.cruise_decision_context?.equipment) selected.push("itemization");
  if (runtimeContext?.strategy_fit_packet?.candidate_lines?.length) selected.push("lineup_construction");
  if (runtimeContext?.semantic_evidence?.transitions?.length) selected.push("transition_planning");
  if (requestKind === "hard_data_query" && /(阵容|九五|95|84|搭一套)/i.test(queryText)) selected.push("lineup_construction");
  if (!selected.length && runtimeContext?.cruise_decision_context) selected.push("current_match_strategy");
  return uniqueStrings(selected);
}

function decisionMathComponent(runtimeContext, name) {
  const decision = runtimeContext?.decision_math_context;
  if (!decision || decision.executable !== true) return null;
  if (decision.operation === "compose_theorycraft_decision") return decision.components?.[name] || null;
  if (name === "lineup" && decision.operation === "solve_trait_roster_role_coverage") return decision;
  if (name === "itemization" && /item|equipment/i.test(String(decision.operation || ""))) return decision;
  if (name === "augments" && /augment/i.test(String(decision.operation || ""))) return decision;
  return null;
}

function snapshotBoundRankingCapability(runtimeContext, providerCapability) {
  if (providerCapability !== "native_dynamic_tools") return null;
  const dailyBigData = runtimeContext?.daily_big_data;
  const sourcePolicy = runtimeContext?.current_turn_contract?.source_policy?.live_rankings;
  const rankingOverlayId = runtimeContext?.knowledge_snapshot?.ranking_overlay_id
    || runtimeContext?.current_turn_contract?.knowledge_snapshot?.ranking_overlay_id
    || dailyBigData?.ranking_overlay_id
    || null;
  if (!rankingOverlayId || String(rankingOverlayId).startsWith("unavailable:")) return null;
  if (dailyBigData?.available === false || sourcePolicy?.active_for_turn === false) return null;
  if (dailyBigData?.ranking_strength_available === false) return null;
  if (dailyBigData?.ranking_overlay_id && dailyBigData.ranking_overlay_id !== rankingOverlayId) return null;
  if (dailyBigData?.available !== true && sourcePolicy?.active_for_turn !== true) return null;
  return {
    schema: "jcc-snapshot-bound-ranking-capability-v1",
    availability: "available_via_snapshot_bound_tool",
    tool: "jcc.query_knowledge",
    ranking_overlay_id: rankingOverlayId,
    stat_date: dailyBigData?.stat_date || null,
    ranking_scope: dailyBigData?.ranking_scope || {
      required_ranking_label: "master_plus",
      fallback_to_other_tiers: false,
    },
  };
}

function facetEvidence(facetId, { runtimeContext, hostRequest, evidencePolicyId, providerCapability }) {
  const decision = runtimeContext?.decision_math_context || null;
  const lineup = decisionMathComponent(runtimeContext, "lineup");
  const itemization = decisionMathComponent(runtimeContext, "itemization");
  const augments = decisionMathComponent(runtimeContext, "augments");
  const rankingForbidden = evidencePolicyId === "active_core_profile_only";
  const ranking = runtimeContext?.selected_ranking_candidates || hostRequest?.selected_ranking_candidates || null;
  const retrievableRanking = ranking ? null : snapshotBoundRankingCapability(runtimeContext, providerCapability);
  const map = {
    common_game_doctrine: runtimeContext?.game_rule_contract || runtimeContext?.game_state_brief || runtimeContext?.active_rules_bundle,
    current_core_identity: runtimeContext?.knowledge_snapshot || runtimeContext?.current_turn_contract?.knowledge_snapshot || decision?.profile,
    current_core_entity_details: decision?.components?.entity_details
      || (decision?.operation === "query_core_entities" ? decision : null)
      || (lineup?.roster?.length ? lineup.roster : null) || runtimeContext?.hard_data_query_context,
    semantic_seed: decision?.semantic_seed
      || lineup?.semantic_seed
      || itemization?.semantic_seed
      || augments?.semantic_seed
      || runtimeContext?.strategy_fit_packet?.semantic_seed
      || runtimeContext?.semantic_seed
      || null,
    candidate_frontier: asArray(
      lineup?.candidate_frontier
        || itemization?.candidate_frontier
        || augments?.candidate_frontier
        || runtimeContext?.strategy_fit_packet?.candidate_frontier
        || decision?.candidate_frontier,
    ).length
      ? (lineup?.candidate_frontier
        || itemization?.candidate_frontier
        || augments?.candidate_frontier
        || runtimeContext?.strategy_fit_packet?.candidate_frontier
        || decision?.candidate_frontier)
      : null,
    champion_trait_map: lineup?.trait_coverage || (lineup?.roster?.some((unit) => asArray(unit?.traits).length) ? lineup.roster : null),
    champion_skill_role_profiles: lineup?.roster?.some((unit) => unit?.skill || unit?.role || unit?.role_proxy) ? lineup.roster : null,
    legal_roster_solution: lineup?.executable === true && asArray(lineup?.roster).length ? lineup : null,
    formation_difficulty_profile: lineup?.formation_profile || runtimeContext?.formation_profile || null,
    transition_candidates: asArray(lineup?.transitions).length ? lineup.transitions : runtimeContext?.semantic_evidence?.transitions,
    equipment_continuity: asArray(lineup?.transitions).some((row) => row?.equipment_continuity || row?.transitions_to) || itemization?.executable === true ? (lineup?.transitions || itemization) : null,
    equipment_effects_and_fit: itemization?.executable === true ? itemization : runtimeContext?.itemization_context,
    augment_effects_and_fit: augments?.executable === true ? augments : runtimeContext?.cruise_decision_context?.augment_choice_evaluation,
    deterministic_math: decision?.executable === true ? decision : null,
    current_match_state: runtimeContext?.match_facts || hostRequest?.context?.live_state_summary || hostRequest?.live_state_summary,
    recent_match_decision_summaries: runtimeContext?.recent_match_decision_summaries
      || hostRequest?.recent_match_decision_summaries
      || hostRequest?.context?.recent_match_decision_summaries
      || null,
    current_equipment_and_holders: runtimeContext?.match_facts?.equipment || runtimeContext?.cruise_decision_context?.equipment,
    current_choice_candidates: hostRequest?.choices || runtimeContext?.cruise_decision_context?.augment_choice_evaluation,
    target_or_candidate_direction: runtimeContext?.match_facts?.target_plan || runtimeContext?.strategy_fit_packet,
    active_effect_timing: runtimeContext?.semantic_evidence?.active_effects || runtimeContext?.cruise_decision_context?.active_effects,
    semantic_relations: runtimeContext?.semantic_evidence,
    ranking_observations: ranking,
    ranking_lineup_candidates: ranking,
    ranking_transition_evidence: ranking?.candidates?.some((candidate) => candidate?.strategy_profile?.transition) ? ranking : null,
    ranking_item_observations: ranking?.candidates?.some((candidate) => candidate?.strategy_profile?.hero_market_and_item_profile) ? ranking : null,
    ranking_augment_associations: ranking?.candidates?.some((candidate) => candidate?.strategy_profile?.augment_associations) ? ranking : null,
  };
  if (facetId.startsWith("ranking_") || facetId === "ranking_observations") {
    if (rankingForbidden) return { state: "forbidden", value: null, reason: "active_core_profile_only" };
    if (!ranking && retrievableRanking) {
      return { state: "satisfied", value: retrievableRanking, reason: null, source_domain: "ranking" };
    }
    if (!ranking) {
      return {
        state: "degraded",
        value: null,
        reason: runtimeContext?.daily_big_data?.unavailable_reason || "compatible_master_plus_rankings_unavailable",
      };
    }
  }
  const value = map[facetId] || null;
  return value
    ? { state: "satisfied", value, reason: null,
        source_domain: facetId.startsWith("ranking_") ? "ranking"
          : facetId === "candidate_frontier"
            ? (asArray(lineup?.candidate_frontier || itemization?.candidate_frontier || augments?.candidate_frontier).length
              ? "core" : asArray(runtimeContext?.strategy_fit_packet?.candidate_frontier).length ? "ranking" : "core")
            : null }
    : { state: "missing", value: null, reason: "evidence_not_prefetched_or_unavailable" };
}

export function buildStrategyEvidenceKernelPacket({
  framework,
  hostRequest,
  runtimeMode,
  runtimeContext,
  providerCapability = "prefetch_complete",
  maxPrefetchBytes = 128 * 1024,
} = {}) {
  const definition = frameworkDefinition(framework);
  if (!definition?.routes) throw new Error("strategy evidence framework is required");
  const queryText = [hostRequest?.user_message, hostRequest?.task, ...asArray(hostRequest?.instructions)]
    .filter(Boolean).join("\n").slice(0, 12_000);
  const evidencePolicyId = hostRequest?.evidence_policy_id
    || runtimeContext?.context_policy?.evidence_policy_id
    || runtimeContext?.current_turn_contract?.source_policy?.evidence_policy
    || "normal_selected_context";
  const routeIds = planStrategyEvidenceRouteIds(framework, {
    queryText,
    runtimeMode,
    requestKind: hostRequest?.request_kind,
    runtimeContext,
  });
  const routeById = new Map(asArray(definition.routes).map((route) => [route.id, route]));
  const obligations = [];
  for (const routeId of routeIds) {
    const route = routeById.get(routeId);
    for (const [criticality, facets] of [["critical", route?.critical_facets], ["optional", route?.optional_facets]]) {
      for (const facetId of asArray(facets)) {
        const existing = obligations.find((entry) => entry.facet_id === facetId);
        if (existing) {
          if (criticality === "critical") existing.criticality = "critical";
          if (!existing.route_ids.includes(routeId)) existing.route_ids.push(routeId);
          continue;
        }
        obligations.push({ facet_id: facetId, criticality, route_ids: [routeId] });
      }
    }
  }
  const identity = {
    match_session_id: runtimeContext?.match_session?.match_session_id || runtimeContext?.current_turn_contract?.match_session_id || null,
    execution_match_session_id: Object.hasOwn(runtimeContext?.match_session || {}, "execution_match_session_id")
      ? runtimeContext.match_session.execution_match_session_id
      : runtimeContext?.match_session?.match_session_id || runtimeContext?.current_turn_contract?.match_session_id || null,
    request_id: hostRequest?.request_id || hostRequest?.response_task_id || null,
    core_profile_id: runtimeContext?.knowledge_snapshot?.core_profile_id || runtimeContext?.decision_math_context?.profile?.core_profile_id || null,
    ranking_overlay_id: runtimeContext?.knowledge_snapshot?.ranking_overlay_id || null,
    evidence_policy_id: evidencePolicyId,
    stage_round: runtimeContext?.game_state_brief?.stage_round || hostRequest?.context?.live_state_summary?.phase?.stage_round || null,
    decision_snapshot_id: runtimeContext?.decision_snapshot?.snapshot_id
      || runtimeContext?.decision_snapshot?.fact_fingerprint
      || hostRequest?.context?.decision_snapshot?.snapshot_id
      || hostRequest?.context?.decision_snapshot?.fact_fingerprint
      || null,
    decision_action_fingerprint: runtimeContext?.response_task_identity?.decision_action_fingerprint
      || hostRequest?.runtime_event_context?.decision_action_fingerprint
      || hostRequest?.task?.runtime_event_context?.decision_action_fingerprint
      || null,
    response_task_id: runtimeContext?.response_task_identity?.response_task_id
      || hostRequest?.response_task_id
      || null,
    response_task_revision: runtimeContext?.response_task_identity?.response_task_revision
      ?? hostRequest?.response_task_revision
      ?? null,
    response_task_mode: runtimeContext?.response_task_identity?.response_task_mode || null,
    response_task_match_session_id: runtimeContext?.response_task_identity?.response_task_match_session_id || null,
    response_task_origin: runtimeContext?.response_task_identity?.response_task_origin || null,
    response_task_event_key: runtimeContext?.response_task_identity?.response_task_event_key || null,
    choice_kind: runtimeContext?.choice_context_identity?.choice_kind
      || hostRequest?.choices?.choice_kind
      || hostRequest?.choices?.kind
      || null,
    choice_stage_round: runtimeContext?.choice_context_identity?.stage_round
      || hostRequest?.choices?.stage_round
      || null,
    choice_report_id: runtimeContext?.choice_context_identity?.report_id
      || hostRequest?.choices?.report_id
      || null,
    choice_set_revision: runtimeContext?.choice_context_identity?.choice_set_revision
      ?? hostRequest?.choices?.choice_set_revision
      ?? null,
    choice_revisions: runtimeContext?.decision_snapshot?.choice_set_revisions || null,
  };
  const evidenceSnapshotId = `evidence:${sha256(identity).slice(0, 24)}`;
  const materializationRegistry = createEvidenceMaterializationRegistry(evidenceSnapshotId);
  let receipts = obligations.map((obligation) => {
    const resolved = facetEvidence(obligation.facet_id, {
      runtimeContext,
      hostRequest,
      evidencePolicyId,
      providerCapability,
    });
    const materialization = materializationRegistry.register(obligation.facet_id, resolved.value);
    return {
      facet_id: obligation.facet_id,
      source_domain: resolved.source_domain || null,
      criticality: obligation.criticality,
      route_ids: obligation.route_ids,
      state: resolved.state,
      evidence_keys: materialization ? [materialization.evidence_key] : [],
      evidence_identity: materialization?.evidence_identity || null,
      canonical_facet_id: materialization?.canonical_facet_id || null,
      reason: resolved.reason,
      delivery: resolved.value ? "pending_prefetch" : null,
    };
  });
  const prefetch = {};
  let prefetchBytes = jsonBytes(prefetch);
  for (const receipt of [...receipts].sort((left, right) => (
    (left.criticality === "critical" ? 0 : 1) - (right.criticality === "critical" ? 0 : 1)
    || left.facet_id.localeCompare(right.facet_id)
  ))) {
    if (providerCapability === "native_dynamic_tools") continue;
    if (receipt.state !== "satisfied") continue;
    const key = receipt.evidence_keys[0];
    if (Object.hasOwn(prefetch, key)) continue;
    const value = materializationRegistry.get(key)?.value;
    const nextBytes = jsonBytes({ [key]: value });
    if (value === null || value === undefined || prefetchBytes + nextBytes > maxPrefetchBytes) continue;
    prefetch[key] = value;
    prefetchBytes += nextBytes;
  }
  receipts = receipts.map((receipt) => {
    if (receipt.state !== "satisfied") return receipt;
    const prefetched = receipt.evidence_keys.some((key) => Object.hasOwn(prefetch, key));
    if (prefetched) {
      return {
        ...receipt,
        delivery: receipt.facet_id === receipt.canonical_facet_id ? "prefetched" : "prefetched_reference",
      };
    }
    if (providerCapability === "native_dynamic_tools") return { ...receipt, delivery: "snapshot_bound_tool" };
    return {
      ...receipt,
      state: "missing",
      evidence_keys: [],
      reason: "prefetch_budget_exceeded",
      delivery: null,
    };
  });
  const missingCritical = receipts.filter((receipt) => receipt.criticality === "critical" && ["missing", "degraded"].includes(receipt.state));
  const semanticSeedReceipt = receipts.find((receipt) => receipt.facet_id === "semantic_seed" && receipt.state === "satisfied");
  const candidateFrontierReceipt = receipts.find((receipt) => receipt.facet_id === "candidate_frontier" && receipt.state === "satisfied");
  const plan = {
    schema: "jcc-strategy-evidence-plan-v1",
    evidence_snapshot_id: evidenceSnapshotId,
    query_hash: sha256(queryText),
    route_ids: routeIds,
    obligations,
    evidence_policy_id: evidencePolicyId,
    provider_capability: providerCapability,
    agent_contract: {
      may_plan_inside_one_host_turn: true,
      may_request_snapshot_bound_expansion: providerCapability === "native_dynamic_tools",
      must_not_widen_source_policy: true,
      owns_strategy_tradeoffs_and_explanation: true,
      semantic_seed_selection: "agent",
      mechanical_expansion: "runtime_deterministic",
      final_legality_validation: "runtime_deterministic",
      must_compare_candidate_frontier_when_present: true,
    },
    semantic_seed_ref: semanticSeedReceipt?.evidence_keys?.[0] || null,
    candidate_frontier_ref: candidateFrontierReceipt?.evidence_keys?.[0] || null,
  };
  const coverage = {
    schema: "jcc-strategy-evidence-coverage-v1",
    evidence_snapshot_id: evidenceSnapshotId,
    status: missingCritical.length ? "partial" : "complete",
    receipts,
    missing_critical_facets: missingCritical.map((receipt) => receipt.facet_id),
    forbidden_facets: receipts.filter((receipt) => receipt.state === "forbidden").map((receipt) => receipt.facet_id),
  };
  return deepFreeze({
    schema: "jcc-strategy-evidence-kernel-packet-v1",
    evidence_snapshot: { schema: "jcc-strategy-evidence-snapshot-v1", evidence_snapshot_id: evidenceSnapshotId, identity },
    plan,
    coverage,
    materialization_policy: {
      schema: "jcc-strategy-evidence-materialization-policy-v1",
      scope: "one_logical_host_turn",
      identity: "content_sha256_within_immutable_evidence_snapshot",
      full_materialization_limit_per_identity: 1,
      alias_policy: "receipts_and_sections_reference_the_canonical_evidence_key",
      atomic_candidate_policy: "complete_value_or_reference_never_partial_candidate_materialization",
      history_owner: "native_host_session_memory",
      transcript_system: "forbidden",
      entries: materializationRegistry.manifest(),
    },
    prefetch: {
      schema: "jcc-strategy-evidence-prefetch-v1",
      evidence_snapshot_id: evidenceSnapshotId,
      evidence: prefetch,
      serialized_bytes: prefetchBytes,
      max_bytes: maxPrefetchBytes,
    },
  });
}

export function reconcileStrategyEvidenceCoverage({ coverage, prefetch, providerCapability } = {}) {
  if (!coverage) return coverage;
  const evidence = prefetch?.evidence && typeof prefetch.evidence === "object" ? prefetch.evidence : {};
  const receipts = asArray(coverage.receipts).map((receipt) => {
    if (receipt.state !== "satisfied") return { ...receipt };
    const prefetched = asArray(receipt.evidence_keys).some((key) => Object.hasOwn(evidence, key));
    if (prefetched) return { ...receipt, delivery: "prefetched" };
    if (providerCapability === "native_dynamic_tools") return { ...receipt, delivery: "snapshot_bound_tool" };
    return {
      ...receipt,
      state: "missing",
      evidence_keys: [],
      reason: "evidence_not_present_in_turn_payload",
      delivery: null,
    };
  });
  const missingCritical = receipts.filter((receipt) => (
    receipt.criticality === "critical" && ["missing", "degraded"].includes(receipt.state)
  ));
  return deepFreeze({
    ...coverage,
    status: missingCritical.length ? "partial" : "complete",
    receipts,
    missing_critical_facets: missingCritical.map((receipt) => receipt.facet_id),
    forbidden_facets: receipts.filter((receipt) => receipt.state === "forbidden").map((receipt) => receipt.facet_id),
  });
}

export function strategyEvidenceCapabilityManifest(framework, providerMode = "prefetch_complete") {
  const definition = frameworkDefinition(framework);
  return deepFreeze({
    schema: "jcc-strategy-evidence-capability-manifest-v1",
    routes: asArray(definition?.routes).map((route) => ({ id: route.id, critical_facets: route.critical_facets })),
    coverage_states: asArray(definition?.coverage_states),
    provider_mode: providerMode,
    tools: providerMode === "native_dynamic_tools" ? ["jcc.query_knowledge", "jcc.calculate"] : [],
    policy: "Runtime retrieves and verifies evidence; the Agent plans, weighs tradeoffs, forms strategy, and explains one answer.",
  });
}

export function buildStrategyEvidenceStore({ evidencePacket, hostRequest, runtimeContext } = {}) {
  const evidencePolicyId = evidencePacket?.plan?.evidence_policy_id || "normal_selected_context";
  const providerCapability = evidencePacket?.plan?.provider_capability || "prefetch_complete";
  const prefetched = evidencePacket?.prefetch?.evidence || {};
  return deepFreeze(Object.fromEntries(asArray(evidencePacket?.coverage?.receipts)
    .filter((receipt) => receipt.state === "satisfied")
    .map((receipt) => [
      receipt.facet_id,
      asArray(receipt.evidence_keys).map((key) => prefetched[key]).find((value) => value !== undefined)
        ?? facetEvidence(receipt.facet_id, {
          runtimeContext,
          hostRequest,
          evidencePolicyId,
          providerCapability,
        }).value,
    ])
    .filter(([, value]) => value !== null && value !== undefined)));
}
