import { restoreRankingToolCandidate } from "./ranking-tool-projection.js";

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined)
  .map(key => [key, value[key]]));

// Local execution state must never become serializable prompt context.
const queryScopes = new WeakMap();
const validatedResponses = new WeakMap();
const identity = (request) => JSON.stringify([
  request?.request_id, request?.request_hash || request?.request_id, request?.mode,
]);

export function knowledgeQueryScope(request) {
  if (!queryScopes.has(request)) queryScopes.set(request, { candidates: new Map(), rankingQueried: false, knowledge_ledger: [] });
  return queryScopes.get(request);
}

export function shareKnowledgeQueryScope(source, target) {
  queryScopes.set(target, knowledgeQueryScope(source));
}

export function recordKnowledgeToolResult(request, result, args) {
  const scope = knowledgeQueryScope(request);
  const page = result?.result?.selected_ranking_candidates
    || result?.result;
  const candidates = Array.isArray(page?.candidates) ? page.candidates
    : result?.result?.schema === "jcc-atomic-lineup-evidence-v1" && result.result.status === "ok" ? [result.result] : [];
  if (["search_lineups", "expand_ranking_candidates"].includes(args.operation) && page
    && (candidates.length || result.status !== "partial")) scope.rankingQueried = true;
  for (const candidate of candidates) {
    const id = candidate.candidate_id || candidate.line_id || candidate.id;
    if (id) {
      const key = JSON.stringify([id, candidate.selected_variant_id, candidate.candidate_evidence_id]);
      if (!scope.candidates.has(key) || Array.isArray(page?.candidates)) scope.candidates.set(key, restoreRankingToolCandidate(candidate));
    }
  }
  scope.knowledge_ledger ||= [];
  if (result?.query_identity) {
    scope.knowledge_ledger = scope.knowledge_ledger.filter((entry) => entry.query_identity !== result.query_identity);
    scope.knowledge_ledger.push({
      receipt_id: `tool-result:${scope.knowledge_ledger.length + 1}`,
      query_identity: result.query_identity,
      operation: result.operation || args.operation || null,
      snapshot_id: result.evidence_snapshot_id || null,
      coverage: result.delivery?.complete_atomic_candidates ? ["complete_atomic_candidate_evidence"] : [],
      status: result.delivery?.already_sufficient ? "sufficient" : "available",
      requery_allowed: true,
    });
  }
}

export function markValidatedHostResponse(response, request) {
  validatedResponses.set(response, identity(request));
  return response;
}

export function isValidatedHostResponse(response, request) {
  return validatedResponses.get(response) === identity(request);
}

// Only controls and current facts cross this boundary. Query results stay in
// the native transcript and in the local validation scope, never the next turn.
export function projectKnowledgeTurn(request, { capsule, facts, liveState, strategicContract, choices } = {}) {
  const context = request.runtime_context || request.context?.runtime_context || {};
  return {
    schema: "jcc-host-current-turn-delta-v1",
    knowledge_delivery: "native_pull",
    ...pick(request, ["request_id", "request_hash", "mode", "request_kind", "origin_action_id", "evidence_policy_id", "user_message", "pinned_result_required"]),
    task: typeof request.task === "string" ? request.task : pick(request.task, ["kind", "type", "instruction"]),
    capsule_ref: { capsule_id: capsule?.capsule_id, fingerprint: capsule?.fingerprint },
    choices,
    expected_response_shape: {
      ...(strategicContract ? { candidate_refs: {
        selection_candidates: [],
        selection_policy: "Return only exact candidate identities from this turn's search_lineups/get_lineup results when Runtime must preserve or materialize them.",
      } } : {}),
    },
    runtime_context: {
      ...pick(context, ["knowledge_snapshot", "current_turn_contract", "response_task_identity", "choice_context_identity", "context_policy"]),
      match_facts: facts,
      live_state_summary: liveState,
      query_tools: ["jcc.query_knowledge", "jcc.calculate"],
    },
  };
}

export function rankingToolQueryRequest(args, { requestId, mode, facts, liveState, catalog } = {}) {
  const names = Array.isArray(args.entity_names) ? args.entity_names : [];
  const role = args.role === "main_carry" ? "主C" : args.role === "main_tank" ? "主坦" : "";
  return {
    request_id: `${requestId || "query"}:ranking-tool`, mode,
    user_message: [args.search_constraints ?? args.question, ...names.map(name => `${name}${role}`)].filter(Boolean).join(" ") || "当前上分阵容",
    ranking_full_pool: true,
    ranking_recommendation: true,
    ranking_working_set_hint: Math.max(1, Math.min(10, Number(args.candidate_working_set_hint ?? args.limit) || 6)),
    ranking_strength_bands: args.strength_bands || null,
    ranking_include_band_directory: args.include_band_directory === true,
    ranking_query_catalog: catalog,
    context: { live_state_summary: liveState, match_context: facts },
    runtime_context: { match_facts: facts },
  };
}

export function candidateMatchesRequestedRole(candidate, args) {
  if (!args.role || args.role === "member" || !args.entity_names?.length) return true;
  const variant = candidate.canonical_variant || candidate.strategy_profile?.canonical_variant || candidate.strategy_profile || candidate;
  const role = args.role === "main_carry" ? variant.main_carry : variant.main_tank || variant.primary_tank;
  const values = typeof role === "string" ? [role] : [role?.champion_id, role?.champion_name, role?.id, role?.name];
  return args.entity_names.some(name => values.some(value => value && String(value).toLowerCase() === String(name).toLowerCase()));
}
