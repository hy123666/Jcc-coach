import { createHash } from "node:crypto";

const DAILY_ROUTE_HINTS = Object.freeze([
  { pattern: /(上分|版本|强势|环境)/u, route: "current_version_strategy" },
  { pattern: /(阵容|主 ?C|主c|体系|变阵)/iu, route: "ranking_lineup_search" },
  { pattern: /(运营|经济|节奏|升级|搜牌)/u, route: "economy_and_tempo" },
  { pattern: /(强化|海克斯|符文|装备|出装)/u, route: "choice_or_item_fit" },
]);

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function json(value) {
  return JSON.stringify(sortValue(value));
}

function textOf(value) {
  return String(value || "").trim();
}

function routesForDailyMessage(message) {
  const routes = DAILY_ROUTE_HINTS
    .filter((entry) => entry.pattern.test(textOf(message)))
    .map((entry) => entry.route);
  return routes.length ? [...new Set(routes)] : ["model_owned_semantic_route"];
}

function modeDefaults(mode, request = {}, runtimeContext = {}) {
  const normalizedMode = textOf(mode) || "daily_chat";
  if (normalizedMode === "cruise" || runtimeContext.strategic_obligation) {
    return {
      task_kind: "strategic_checkpoint",
      answer_owner: "cruise",
      semantic_owner: "host_model",
      possible_routes: ["strategic_checkpoint", "ranking_lineup_search"],
      first_action: "use_current_strategic_obligation_and_latest_live_state",
    };
  }
  if (normalizedMode === "augment_choice") {
    return {
      task_kind: "choice_recommendation",
      answer_owner: "augment_choice",
      semantic_owner: "host_model",
      possible_routes: ["choice_or_item_fit"],
      first_action: "read_bound_choice_candidates_and_live_state",
    };
  }
  if (normalizedMode === "item_choice" || normalizedMode === "descriptor_choice") {
    return {
      task_kind: "choice_recommendation",
      answer_owner: normalizedMode,
      semantic_owner: "host_model",
      possible_routes: ["choice_or_item_fit"],
      first_action: "read_bound_choice_candidates_and_live_state",
    };
  }
  if (normalizedMode === "lineup_card") {
    return {
      task_kind: "lineup_card",
      answer_owner: "lineup_card",
      semantic_owner: "host_model",
      possible_routes: ["lineup_identity_resolution", "lineup_variant_lookup"],
      first_action: "resolve_one_atomic_lineup_identity",
    };
  }
  if (normalizedMode === "postgame_review") {
    return {
      task_kind: "postgame_review",
      answer_owner: "postgame_review",
      semantic_owner: "host_model",
      possible_routes: ["postgame_review"],
      first_action: "read_bound_match_review_facts",
    };
  }
  const message = request.user_message || request.text || "";
  const dailyRoutes = routesForDailyMessage(message);
  const rankingEvidenceAvailable = runtimeContext?.daily_big_data?.available === true
    && runtimeContext?.knowledge_snapshot?.ranking_overlay_id
    && !String(runtimeContext.knowledge_snapshot.ranking_overlay_id).startsWith("unavailable:")
    && runtimeContext?.current_turn_contract?.source_policy?.live_rankings?.active_for_turn !== false;
  return {
    task_kind: "user_message",
    answer_owner: "direct_user_message",
    semantic_owner: "host_model",
    possible_routes: dailyRoutes,
    first_action: dailyRoutes.includes("current_version_strategy") && rankingEvidenceAvailable
      ? "understand_user_intent_then_query_current_master_plus_working_set_once_if_the_question_needs_rankings"
      : "understand_user_intent_then_choose_minimal_evidence",
  };
}

export function buildHostTurnExecutionContract({ mode, request = {}, runtimeContext = {} } = {}) {
  const defaults = modeDefaults(mode, request, runtimeContext);
  const normalizedMode = textOf(mode) || "daily_chat";
  return {
    schema: "jcc-host-turn-execution-contract-v1",
    mode: normalizedMode,
    task_kind: defaults.task_kind,
    answer_owner: defaults.answer_owner,
    semantic_owner: defaults.semantic_owner,
    runtime_hint: {
      possible_routes: defaults.possible_routes,
      confidence: defaults.task_kind === "user_message" ? "low" : "high",
    },
    first_action: defaults.first_action,
    model_policy: {
      understand_user_intent: true,
      choose_query_scope: true,
      may_change_route: true,
    },
    query_policy: {
      prefer_one_sufficient_query: true,
      allow_targeted_followup: true,
      same_query_source_execution: "cached_when_available",
      allow_recovery_requery: true,
      ledger_scope: "request_time_snapshot_not_live_provider_state",
    },
    response_policy: {
      internal_reasoning_allowed: true,
      interim_agent_messages_allowed: false,
      tool_call_is_first_assistant_action_when_required: true,
      final_response_objects: 1,
    },
    finalization: {
      answer_when: "evidence_sufficient_or_explicitly_unavailable",
      must_not_fake_missing_evidence: true,
    },
  };
}

export function canonicalQueryIdentity(snapshotId, operation, args = {}) {
  return `sha256:${createHash("sha256")
    .update(json({ snapshot_id: textOf(snapshotId), operation: textOf(operation), args }))
    .digest("hex")}`;
}

export function recordKnowledgeLedgerEntry(ledger = [], entry = {}) {
  const next = Array.isArray(ledger) ? ledger.filter((item) => item?.query_identity !== entry.query_identity) : [];
  return [...next, {
    receipt_id: entry.receipt_id || null,
    query_identity: entry.query_identity || null,
    operation: entry.operation || null,
    snapshot_id: entry.snapshot_id || null,
    coverage: Array.isArray(entry.coverage) ? [...new Set(entry.coverage)] : [],
    status: entry.status || "available",
    requery_allowed: entry.requery_allowed !== false,
  }];
}

export function decideKnowledgeQueryReuse(ledger = [], queryIdentity, { context_compacted = false } = {}) {
  const existing = (Array.isArray(ledger) ? ledger : []).find((entry) => entry?.query_identity === queryIdentity);
  if (!existing) return { action: "execute", existing: null };
  if (context_compacted) return { action: "recover", existing };
  return { action: "reuse", existing };
}

function unwrapToolValue(value) {
  if (typeof value !== "string") return value;
  try {
    return unwrapToolValue(JSON.parse(value));
  } catch {
    return value;
  }
}

function unwrapToolArray(value) {
  if (!Array.isArray(value)) return value;
  for (const item of value) {
    const text = item?.text || item?.input_text || item?.output || null;
    if (text) {
      const parsed = unwrapToolValue(text);
      if (parsed && typeof parsed === "object") return parsed;
    }
  }
  return value;
}

function resultBody(source) {
  if (source?.result && typeof source.result === "object") return source.result;
  return source && typeof source === "object" ? source : {};
}

export function normalizeHostToolResult(rawValue, { operation = null, evidenceSnapshotId = null, queryIdentity = null } = {}) {
  const unwrapped = unwrapToolArray(unwrapToolValue(rawValue));
  const source = unwrapped && typeof unwrapped === "object" ? unwrapped : {};
  const result = structuredClone(
    source.schema === "jcc-query-knowledge-result-v2" && source.result && typeof source.result === "object"
      ? source.result
      : resultBody(source),
  );
  const normalizedOperation = operation || source.operation || null;
  const isCalculation = normalizedOperation === "calculate" || source.schema === "jcc-calculate-tool-result-v1";
  if (isCalculation) {
    const ok = source.ok !== false && !source.error;
    return {
      schema: "jcc-calculate-tool-result-v1",
      ok,
      operation: "calculate",
      evidence_snapshot_id: evidenceSnapshotId || source.evidence_snapshot_id || null,
      query_identity: queryIdentity || source.query_identity || null,
      result,
      ...(ok ? {} : { error: source.error || { code: "readonly_calculation_failed" } }),
    };
  }
  const page = result.selected_ranking_candidates || result;
  const candidates = Array.isArray(page.candidates) ? page.candidates : [];
  const sourceDelivery = source.delivery || {};
  const partial = source.status === "partial" || sourceDelivery.payload_state === "partial";
  const reused = sourceDelivery.reused_result === true;
  const completeCandidates = candidates.length > 0
    && candidates.every((candidate) => candidate?.candidate_id || candidate?.id);
  const unavailableStatuses = ["unavailable", "forbidden", "error", "failed", "not_found", "query_required", "ambiguous"];
  const ok = Boolean(unwrapped && typeof unwrapped === "object")
    && source.ok !== false && !source.error && !source.error_code
    && sourceDelivery.payload_state !== "unavailable" && !unavailableStatuses.includes(source.status);
  const alreadySufficient = ok && !partial && sourceDelivery.already_sufficient !== false
    && (completeCandidates || Boolean(sourceDelivery.returned_count) || sourceDelivery.already_sufficient === true);
  return {
    schema: "jcc-query-knowledge-result-v2",
    ok,
    operation: normalizedOperation,
    evidence_snapshot_id: evidenceSnapshotId || source.evidence_snapshot_id || null,
    query_identity: queryIdentity || source.query_identity || null,
    ...(source.status && source.status !== "ok" ? { status: source.status } : {}),
    result,
    delivery: {
      returned_count: Number(sourceDelivery.returned_count ?? candidates.length),
      previously_delivered_count: Number(sourceDelivery.previously_delivered_count || 0),
      payload_state: !ok ? "unavailable" : reused ? "reuse_notice" : partial ? "partial" : "complete",
      more_available: Boolean(source.next_cursor || page.next_cursor || Number(page.remaining_count) > 0 || sourceDelivery.more_available),
      complete_atomic_candidates: ok && completeCandidates && (sourceDelivery.complete_atomic_candidates !== undefined
        ? sourceDelivery.complete_atomic_candidates === true : !partial),
      already_sufficient: alreadySufficient,
      already_retrieved: Boolean(sourceDelivery.already_retrieved || sourceDelivery.cache_hit || Number(sourceDelivery.previously_delivered_count) > 0),
      cache_hit: Boolean(sourceDelivery.cache_hit),
      recovery_available: ok && Boolean(sourceDelivery.recovery_available),
      reused_result: Boolean(sourceDelivery.reused_result),
      ...(sourceDelivery.reuse_reason ? { reuse_reason: sourceDelivery.reuse_reason } : {}),
      next_action: alreadySufficient
        ? sourceDelivery.next_action || "answer_from_this_result"
        : "inspect_missing_facets_or_answer_with_available_evidence",
    },
    ...(ok ? {} : { error: source.error || { code: source.error_code || source.status || "readonly_tool_failed" } }),
  };
}
