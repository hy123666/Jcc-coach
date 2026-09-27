import { materializeReadonlyEvidence, restoreHostEvidence } from "./host-evidence-materialization.js";
import { buildHostKnowledgeOperationInstructions } from "../../tools/jcc_host_coach_instruction_contract.mjs";
import {
  canonicalQueryIdentity,
  normalizeHostToolResult,
} from "./host-turn-execution-contract.js";

const TOOL_CONTRACT_VERSION = "jcc-host-readonly-tools-v8";

const rosterFields = {
  population: { type: "integer", minimum: 1, maximum: 12 },
  main_carry: { type: "string", minLength: 1, maxLength: 160 },
  main_tank: { type: "string", minLength: 1, maxLength: 160 },
  owned_units: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 160 } },
  target_traits: { type: "array", maxItems: 12, items: {
    type: "object", required: ["trait", "count"], additionalProperties: false,
    properties: { trait: { type: "string", minLength: 1, maxLength: 160 }, count: { type: "integer", minimum: 1, maximum: 20 } },
  } },
  emblems: { type: "array", maxItems: 12, items: {
    type: "object", required: ["trait", "count"], additionalProperties: false,
    properties: { trait: { type: "string", minLength: 1, maxLength: 160 }, count: { type: "integer", minimum: 1, maximum: 12 }, holder: { type: "string", minLength: 1, maxLength: 160 } },
  } },
};

function validateCalculationField(value, schema, field) {
  const fail = () => { throw new Error(`readonly_tool_invalid_calculation_${field}`); };
  if (schema.type === "string" && (typeof value !== "string" || !value.trim() || value.length > schema.maxLength)) fail();
  if (schema.type === "integer" && (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum)) fail();
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > schema.maxItems) fail();
    value.forEach((entry) => validateCalculationField(entry, schema.items, field));
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    if (schema.required.some((key) => !Object.hasOwn(value, key))) fail();
    for (const [key, entry] of Object.entries(value)) {
      if (!schema.properties[key]) fail();
      validateCalculationField(entry, schema.properties[key], `${field}_${key}`);
    }
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function candidatePage(value) {
  return value?.result?.selected_ranking_candidates
    || (Array.isArray(value?.result?.candidates) ? value.result : null);
}

function bounded(value, maxBytes = 64 * 1024) {
  const encoded = materializeReadonlyEvidence(value);
  if (jsonBytes(encoded) <= maxBytes) return encoded;
  const candidates = candidatePage(value)?.candidates;
  if (Array.isArray(candidates)) {
    const compact = structuredClone(value);
    const selected = candidatePage(compact);
    const sourceCount = Number(
      selected.candidate_working_set_source_count
        ?? selected.candidate_working_set_count
        ?? selected.returned_count
        ?? candidates.length,
    );
    while (selected.candidates.length && jsonBytes(materializeReadonlyEvidence(compact)) > maxBytes) selected.candidates.pop();
    const retainedCount = selected.candidates.length;
    selected.returned_count = retainedCount;
    selected.candidate_working_set_count = retainedCount;
    selected.candidate_working_set_source_count = Number.isFinite(sourceCount)
      ? Math.max(retainedCount, sourceCount)
      : candidates.length;
    selected.candidate_working_set_retained_count = retainedCount;
    selected.candidate_working_set_truncated = retainedCount < selected.candidate_working_set_source_count;
    compact.status = "partial";
    compact.reason = retainedCount
      ? "complete_candidates_retained_with_candidate_boundary_compaction"
      : "single_complete_candidate_exceeds_tool_result_budget";
    compact.compaction = {
      policy: "whole_candidate_only_never_truncate_candidate_json",
      source_candidate_count: selected.candidate_working_set_source_count,
      retained_candidate_count: retainedCount,
      max_result_bytes: maxBytes,
    };
    while (selected.candidates.length && jsonBytes(materializeReadonlyEvidence(compact)) > maxBytes) selected.candidates.pop();
    selected.returned_count = selected.candidates.length;
    selected.candidate_working_set_count = selected.candidates.length;
    selected.candidate_working_set_retained_count = selected.candidates.length;
    compact.compaction.retained_candidate_count = selected.candidates.length;
    compact.reason = selected.candidates.length
      ? "complete_candidates_retained_with_candidate_boundary_compaction"
      : "single_complete_candidate_exceeds_tool_result_budget";
    if (!selected.candidates.length) {
      compact.exact_lookup_refs = candidates.slice(0, 10).map((candidate) => ({
        candidate_id: candidate.candidate_id || candidate.id,
        selected_variant_id: candidate.selected_variant_id,
        candidate_evidence_id: candidate.candidate_evidence_id,
      }));
      compact.next_operation = "get_lineup";
    }
    const compactEncoded = materializeReadonlyEvidence(compact);
    if (jsonBytes(compactEncoded) <= maxBytes) return compactEncoded;
  }
  return {
    schema: "jcc-readonly-tool-result-v1",
    status: "partial",
    reason: "tool_result_compacted",
    summary: typeof value === "string" ? value.slice(0, 16_000) : null,
    result_schema: value?.schema || null,
    original_bytes: jsonBytes(value),
    compaction_policy: "structured_receipt_only_never_mid_object_json_text",
  };
}

function boundedStringArray(value, maxItems, maxChars) {
  return asArray(value)
    .slice(0, maxItems)
    .map((entry) => String(entry || "").trim().slice(0, maxChars))
    .filter(Boolean);
}

function optionalIdentity(args, field) {
  if (args[field] === undefined) return undefined;
  const value = typeof args[field] === "string" ? args[field].trim() : "";
  // Never truncate an identity or turn an invalid explicit selector into absence.
  if (!value || value.length > 256) throw new Error(`readonly_tool_invalid_${field}`);
  return value;
}

function normalizeToolArgs(toolName, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  if (toolName === "query_knowledge") {
    return {
      operation: ["search_lineups", "expand_ranking_candidates", "get_common_knowledge", "get_entity", "get_related_entities", "get_lineup", "get_lineup_variants", "get_ranking_trend", "get_strategy_wiki"].includes(args.operation)
        ? args.operation
        : "retrieve_evidence",
      route_ids: boundedStringArray(args.route_ids, 6, 96),
      facets: boundedStringArray(args.facets, 12, 96),
      entity_names: boundedStringArray(args.entity_names, 12, 160),
      role: ["main_carry", "main_tank", "member"].includes(args.role) ? args.role : null,
      candidate_id: optionalIdentity(args, "candidate_id"),
      selected_variant_id: optionalIdentity(args, "selected_variant_id"),
      candidate_evidence_id: optionalIdentity(args, "candidate_evidence_id"),
      candidate_working_set_hint: Number.isInteger(Number(args.candidate_working_set_hint))
        ? Math.max(1, Math.min(64, Number(args.candidate_working_set_hint)))
        : null,
      strength_bands: boundedStringArray(args.strength_bands, 5, 1)
        .map((band) => band.toLowerCase()).filter((band) => ["s", "a", "b", "c", "d"].includes(band)),
      include_band_directory: args.include_band_directory === true,
      question: String(args.question || "").slice(0, 4096),
      search_constraints: args.search_constraints === undefined ? undefined : String(args.search_constraints).slice(0, 4096),
      limit: Number.isInteger(Number(args.limit)) ? Math.max(1, Math.min(50, Number(args.limit))) : 20,
      cursor: String(args.cursor || "").slice(0, 256) || null,
      recover: args.recover === true,
      recovery_reason: ["context_compaction", "session_recovery", "lost_evidence"].includes(String(args.recovery_reason || "").trim().toLowerCase())
        ? String(args.recovery_reason).trim().toLowerCase()
        : null,
    };
  }
  if (toolName === "calculate") {
    const result = { question: String(args.question || "").slice(0, 4096) };
    if (args.operation === undefined && Object.keys(rosterFields).some((field) => args[field] !== undefined)) {
      throw new Error("readonly_tool_calculation_operation_required");
    }
    if (args.operation !== undefined) {
      if (args.operation !== "solve_trait_roster_role_coverage") throw new Error("readonly_tool_invalid_calculation_operation");
      result.operation = args.operation;
      for (const [field, schema] of Object.entries(rosterFields)) {
        if (args[field] === undefined) continue;
        validateCalculationField(args[field], schema, field);
        result[field] = structuredClone(args[field]);
      }
      if (!result.population) throw new Error("readonly_tool_invalid_calculation_population");
    }
    return result;
  }
  return {};
}

export const JCC_HOST_READONLY_TOOL_CONTRACT_VERSION = TOOL_CONTRACT_VERSION;

export const JCC_CODEX_DYNAMIC_TOOL_SPECS = Object.freeze([
  {
    type: "namespace",
    name: "jcc",
    description: "Read-only JCC Runtime knowledge and deterministic calculation tools bound to the current immutable turn snapshot.",
    tools: [
      {
        type: "function",
        name: "query_knowledge",
        description: "Retrieve snapshot-bound evidence as one self-contained jcc-query-knowledge-result-v2 object. get_common_knowledge restores Common sections. search_lineups supplies complete atomic lineups. For population changes, resolve the candidate with get_lineup_variants then fetch an exact variant as needed. expand_ranking_candidates adds new directions. Recover genuinely lost evidence with recover=true and recovery_reason. This tool cannot widen source policy. " + buildHostKnowledgeOperationInstructions().join(" "),
        inputSchema: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["retrieve_evidence", "search_lineups", "expand_ranking_candidates", "get_common_knowledge", "get_entity", "get_related_entities", "get_lineup", "get_lineup_variants", "get_ranking_trend", "get_strategy_wiki"] },
            role: { type: "string", enum: ["main_carry", "main_tank", "member"], description: "Filter the named champion's role in the same atomic lineup. main_carry excludes mere roster membership." },
            search_constraints: { type: "string", maxLength: 4096, description: "Only the user's required lineup constraints, such as carry, traits or population. Use empty string for broad exploration. When present this replaces question as the search filter; question can then hold non-binding background. Do not copy stage, gold, HP or output instructions here." },
            limit: { type: "integer", minimum: 1, maximum: 50 },
            cursor: { type: "string", maxLength: 256 },
            route_ids: { type: "array", items: { type: "string", maxLength: 96 }, maxItems: 6 },
            facets: { type: "array", items: { type: "string", maxLength: 96 }, maxItems: 12 },
            entity_names: { type: "array", items: { type: "string", maxLength: 160 }, maxItems: 12 },
            candidate_id: { type: "string", minLength: 1, maxLength: 256, description: "Exact candidate identity for get_lineup/get_lineup_variants. Resolve conversational references; if ambiguous, clarify rather than choosing an arbitrary lineup." },
            selected_variant_id: { type: "string", minLength: 1, maxLength: 256, description: "Exact atomic variant identity; a mismatch must not fall back to another variant." },
            candidate_evidence_id: { type: "string", minLength: 1, maxLength: 256, description: "Exact candidate evidence identity within the current snapshot." },
            candidate_working_set_hint: { type: "integer", minimum: 1, maximum: 64 },
            strength_bands: { type: "array", items: { type: "string", enum: ["s", "a", "b", "c", "d"] }, maxItems: 5, description: "For search_lineups, restrict the current Master+ strength bands only when the user asks for particular bands. C and D remain searchable." },
            include_band_directory: { type: "boolean", description: "For a tier overview, add up to five lightweight, distinct direction references per S/A/B/C/D band without expanding extra complete rosters." },
            question: { type: "string", maxLength: 4096, description: "For search_lineups this is a search filter, not a copy of the user turn. Omit it for open direction exploration; put only requested lineup constraints here, not stage, HP, gold, current augment or output-format instructions. A smaller limit returns the same leading candidates, not new evidence. Use expand_ranking_candidates for additional directions." },
            recover: { type: "boolean", description: "Rehydrate lost evidence. For a complete same-turn cached result, also specify recovery_reason; otherwise reuse the existing result. Local field_aliases and JSON Pointer references are not lost evidence." },
            recovery_reason: { type: "string", enum: ["context_compaction", "session_recovery", "lost_evidence"], description: "Only when the prior result is no longer available, not to inspect it again. A self-reported lost_evidence reason is sufficient; no extra verification call is needed." }
          },
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "calculate",
        description: "Run a snapshot-bound Core calculation in any coaching mode. For custom lineups explicitly set operation=solve_trait_roster_role_coverage, population, target_traits and emblems (trait names, counts); optionally specify main_carry, main_tank and owned_units to retain. This builds theoretical roster candidates and trait coverage, not Ranking strength or a guaranteed optimum. Check unmet targets and emblem holder legality before claiming a completed lineup. Otherwise use question for existing natural-language calculations.",
        inputSchema: {
          type: "object",
          required: ["question"],
          properties: {
            question: { type: "string", minLength: 1, maxLength: 4096 },
            operation: { type: "string", enum: ["solve_trait_roster_role_coverage"] },
            ...rosterFields
          },
          additionalProperties: false
        }
      }
    ]
  }
]);

export function createHostReadonlyToolBroker({
  evidencePacket,
  evidenceStore,
  queryKnowledge,
  calculate,
  assertFresh,
  maxTotalCalls = 6,
  maxCallsPerTool = 3,
  maxArgumentBytes = 16 * 1024,
  maxResultBytes = 128 * 1024,
  maxCumulativeResultBytes = 256 * 1024,
  onFailure = null,
  onResult = null,
  cacheQueries = false,
} = {}) {
  const snapshotId = evidencePacket?.evidence_snapshot?.evidence_snapshot_id;
  if (!snapshotId) throw new Error("readonly tool broker requires an evidence snapshot");
  let totalCalls = 0;
  const callsByTool = new Map();
  const audit = [];
  let cumulativeResultBytes = 0;
  const continuations = new Map();
  // One successful wire page per admitted query; replay never creates a new branch.
  const pageDeliveries = new Map();
  let pageSequence = 0;
  const deliveredIdentities = new Set();
  const deliveredCandidateBodies = new Map();
  const queryCache = new Map();
  const completeDeliveries = new Set();
  const knowledgeLedger = [];
  let pendingCall = Promise.resolve();

  const authorize = (tool) => {
    totalCalls += 1;
    callsByTool.set(tool, Number(callsByTool.get(tool) || 0) + 1);
    if (totalCalls > maxTotalCalls) throw new Error("readonly tool call budget exceeded");
    if (callsByTool.get(tool) > maxCallsPerTool) throw new Error(`readonly tool call budget exceeded for ${tool}`);
  };

  return {
    contract_version: TOOL_CONTRACT_VERSION,
    evidence_snapshot_id: snapshotId,
    specs: JCC_CODEX_DYNAMIC_TOOL_SPECS,
    audit,
    async call(toolName, args = {}, { signal } = {}) {
      // Cache admission, byte accounting and cursor publication share one turn state.
      const previousCall = pendingCall;
      let releaseCall;
      pendingCall = new Promise(resolve => { releaseCall = resolve; });
      await previousCall;
      const startedAt = Date.now();
      let normalized = String(toolName || "").replace(/^jcc\./, "");
      let argumentBytes = 0;
      let cacheHit = false;
      const assertNotAborted = () => {
        if (!signal?.aborted) return;
        const error = new Error("readonly_tool_call_aborted");
        error.name = "AbortError";
        throw error;
      };
      try {
        assertNotAborted();
        if (typeof assertFresh === "function") await assertFresh();
        assertNotAborted();
        const normalizedArgs = normalizeToolArgs(normalized, args);
        argumentBytes = jsonBytes(normalizedArgs);
        if (argumentBytes > maxArgumentBytes) throw new Error("readonly tool argument budget exceeded");
        if (cumulativeResultBytes + argumentBytes > maxCumulativeResultBytes) {
          throw new Error("readonly tool cumulative turn budget exceeded");
        }
        cumulativeResultBytes += argumentBytes;
        const queryOperation = normalized === "query_knowledge" ? normalizedArgs.operation : normalized;
        const queryIdentity = canonicalQueryIdentity(snapshotId, queryOperation, {
          ...normalizedArgs, recover: undefined, recovery_reason: undefined,
        });
        const selectorIdentity = canonicalQueryIdentity(snapshotId, queryOperation, {
          ...normalizedArgs, cursor: undefined, recover: undefined, recovery_reason: undefined,
        });
        let result;
        let pendingQueryCache = null;
        let reusedResult = false;
        let recoveryNeedsReason = false;
        let crossOperationReuse = false;
        const requestedCandidateId = String(normalizedArgs.candidate_id || "").trim();
        const deliveredCandidate = requestedCandidateId
          ? deliveredCandidateBodies.get(requestedCandidateId)
          : normalizedArgs.candidate_evidence_id
            ? deliveredCandidateBodies.get(`evidence:${normalizedArgs.candidate_evidence_id}`)
            : null;
        if (normalized === "query_knowledge"
          && normalizedArgs.operation === "get_lineup"
          && normalizedArgs.recover !== true
          && deliveredCandidate
          && normalizedArgs.facets.length === 0
          && (!normalizedArgs.selected_variant_id
            || deliveredCandidate.selected_variant_ids.has(normalizedArgs.selected_variant_id))
          && (!normalizedArgs.candidate_evidence_id
            || normalizedArgs.candidate_evidence_id === deliveredCandidate.candidate_evidence_id)) {
          authorize(normalized);
          crossOperationReuse = true;
          reusedResult = true;
          result = {
            schema: "jcc-query-knowledge-result-v2",
            ok: true,
            evidence_snapshot_id: snapshotId,
            operation: queryOperation,
            query_identity: queryIdentity,
            source_policy: evidencePacket?.plan?.evidence_policy_id || null,
            result: {},
            delivery: {
              returned_count: 0,
              previously_delivered_count: 1,
              complete_atomic_candidates: false,
              already_sufficient: true,
              already_retrieved: true,
              cache_hit: false,
              reused_result: true,
              recovery_available: true,
              reuse_reason: "candidate_already_delivered_by_complete_search_projection",
              next_action: "answer_from_previous_result",
            },
          };
        }
        if (!crossOperationReuse && normalized === "query_knowledge" && normalizedArgs.cursor?.startsWith("tool-page:")) {
          const page = continuations.get(normalizedArgs.cursor);
          if (!page || page.selector_identity !== selectorIdentity) throw new Error("readonly_tool_invalid_cursor");
          cacheHit = pageDeliveries.has(queryIdentity);
          if (!cacheHit) authorize(normalized);
          result = structuredClone(page.result);
        } else if (!crossOperationReuse && normalized === "query_knowledge") {
        const requestedFacets = new Set(normalizedArgs.facets);
        const requestedRoutes = new Set(normalizedArgs.route_ids);
        // Typed queries own their exact expansion. Evidence attachments require
        // an explicit retrieval scope, never an empty-selector wildcard.
        const scopedRetrieval = normalizedArgs.operation === "retrieve_evidence"
          && (requestedFacets.size > 0 || requestedRoutes.size > 0);
        const receipts = asArray(evidencePacket?.coverage?.receipts).filter((receipt) => (
          scopedRetrieval
          && (!requestedFacets.size || requestedFacets.has(receipt.facet_id))
          && (!requestedRoutes.size || asArray(receipt.route_ids).some((routeId) => requestedRoutes.has(routeId)))
        ));
        const cacheable = cacheQueries;
        const cacheKey = cacheable ? queryIdentity : null;
        cacheHit = Boolean(cacheKey && queryCache.has(cacheKey));
        // A model may over-eagerly ask for recovery after already receiving a
        // complete result. Keep recovery available, but require an explicit
        // loss signal before sending the full cached body again.
        const explicitRecovery = ["context_compaction", "session_recovery", "lost_evidence"]
          .includes(String(normalizedArgs.recovery_reason || "").trim().toLowerCase());
        recoveryNeedsReason = cacheHit && normalizedArgs.recover === true && !explicitRecovery
          && completeDeliveries.has(queryIdentity);
        reusedResult = cacheHit && completeDeliveries.has(queryIdentity)
          && (normalizedArgs.recover !== true || recoveryNeedsReason);
        assertNotAborted();
        if (!cacheHit) authorize(normalized);
        const sourceResult = cacheHit ? null
          : typeof queryKnowledge === "function" ? await queryKnowledge(normalizedArgs) : null;
        assertNotAborted();
        const normalizedSource = cacheHit
          ? structuredClone(queryCache.get(cacheKey))
          : normalizeHostToolResult(sourceResult, {
              operation: queryOperation,
              evidenceSnapshotId: snapshotId,
              queryIdentity,
            });
        if (cacheKey && !cacheHit && normalizedSource.ok && normalizedSource.delivery.payload_state === "complete") {
          pendingQueryCache = { key: cacheKey, value: structuredClone(normalizedSource) };
        }
        result = {
          schema: "jcc-query-knowledge-result-v2",
          ok: normalizedSource.ok,
          ...(normalizedSource.status ? { status: normalizedSource.status } : {}),
          ...(normalizedSource.error ? { error: normalizedSource.error } : {}),
          evidence_snapshot_id: snapshotId,
          operation: queryOperation,
          query_identity: queryIdentity,
          source_policy: evidencePacket?.plan?.evidence_policy_id || null,
          receipts,
          evidence: Object.fromEntries(receipts
            .filter((receipt) => receipt.state === "satisfied")
            .map((receipt) => [receipt.facet_id, evidenceStore?.[receipt.facet_id] ?? null])),
          requested_entity_names: normalizedArgs.entity_names,
          question: normalizedArgs.question || null,
          result: normalizedSource.result,
          delivery: {
            ...normalizedSource.delivery,
            cache_hit: cacheHit,
            reused_result: false,
          },
        };
        if (reusedResult) {
          result.result = {};
          result.delivery = {
            returned_count: 0,
            previously_delivered_count: 0,
            complete_atomic_candidates: false,
            already_sufficient: true,
            already_retrieved: true,
            cache_hit: true,
            reused_result: true,
            recovery_available: true,
            next_action: "answer_from_previous_result",
          };
        }
        } else if (crossOperationReuse) {
          // The complete candidate body is already in this turn's evidence.
        } else if (normalized === "calculate") {
        assertNotAborted();
        authorize(normalized);
        if (typeof calculate !== "function") throw new Error("deterministic calculation is unavailable for this snapshot");
        if (!normalizedArgs.question.trim()) throw new Error("deterministic calculation requires a question");
        result = await calculate(normalizedArgs.question, normalizedArgs);
        assertNotAborted();
        result = {
          schema: "jcc-calculate-tool-result-v1",
          evidence_snapshot_id: snapshotId,
          operation: "calculate",
          query_identity: queryIdentity,
          source_policy: evidencePacket?.plan?.evidence_policy_id || null,
          result,
        };
        } else {
          throw new Error(`unsupported JCC readonly tool: ${toolName}`);
        }
        // Account for arguments and earlier results before choosing a whole-candidate page.
        const availableBytes = Math.max(0, Math.min(maxResultBytes, maxCumulativeResultBytes - cumulativeResultBytes));
        const replayedPage = cacheHit && !reusedResult ? pageDeliveries.get(queryIdentity) : null;
        const sourcePage = candidatePage(result);
        if (sourcePage) {
          const identities = asArray(sourcePage.candidates).map(candidate => JSON.stringify([
            candidate.candidate_id || candidate.id, candidate.selected_variant_id, candidate.candidate_evidence_id,
          ]));
          result.delivery = {
            ...result.delivery,
            returned_count: identities.length,
            previously_delivered_count: identities.filter(id => deliveredIdentities.has(id)).length,
            content: identities.length ? "complete_selected_atomic_lineups" : "no_candidates_in_this_result",
            complete_atomic_candidates: result.ok !== false && identities.length > 0
              && result.delivery?.complete_atomic_candidates === true,
            already_sufficient: result.delivery?.already_sufficient === true,
            cache_hit: cacheHit,
            reused_result: reusedResult,
            field_alias_scope: "same_candidate",
            next_action: identities.length
              ? "answer_from_this_result"
              : "inspect_missing_facets_or_answer_with_available_evidence",
          };
        }
        const nextCursor = !replayedPage && sourcePage?.candidates?.length ? `tool-page:${pageSequence + 1}` : null;
        const reservedResult = nextCursor ? { ...result, next_cursor: nextCursor } : result;
        const compact = replayedPage ? restoreHostEvidence(replayedPage)
          : bounded(reservedResult, Math.max(0, availableBytes - 256));
        // Compaction may discard the payload, but never discard the identity and
        // source policy needed to interpret a partial tool result safely.
        const compactWithIdentity = compact?.status === "partial"
          ? {
              ...compact,
              ok: result.ok,
              ...(result.error ? { error: result.error } : {}),
              evidence_snapshot_id: snapshotId,
              source_policy: result?.source_policy ?? evidencePacket?.plan?.evidence_policy_id ?? null,
            }
          : compact;
        const retained = candidatePage(restoreHostEvidence(compactWithIdentity))?.candidates;
        if (compactWithIdentity.delivery && retained) {
          compactWithIdentity.delivery.returned_count = retained.length;
          compactWithIdentity.delivery.content = retained.length ? "complete_selected_atomic_lineups" : "no_candidates_in_this_result";
          compactWithIdentity.delivery.previously_delivered_count = retained.filter(candidate => deliveredIdentities.has(JSON.stringify([
            candidate.candidate_id || candidate.id, candidate.selected_variant_id, candidate.candidate_evidence_id,
          ]))).length;
          compactWithIdentity.delivery.complete_atomic_candidates = retained.length > 0
            && result.delivery?.complete_atomic_candidates === true;
          compactWithIdentity.delivery.already_sufficient = retained.length > 0
            && result.delivery?.already_sufficient === true;
          compactWithIdentity.delivery.cache_hit = cacheHit;
          compactWithIdentity.delivery.reused_result = reusedResult;
        }
        let pendingContinuation = null;
        if (nextCursor && retained?.length && retained.length < sourcePage.candidates.length) {
          const remainder = structuredClone(result);
          candidatePage(remainder).candidates = sourcePage.candidates.slice(retained.length);
          pendingContinuation = { selector_identity: selectorIdentity, result: remainder };
          compactWithIdentity.next_cursor = nextCursor;
        } else if (!replayedPage) {
          delete compactWithIdentity.next_cursor;
        }
        if (typeof assertFresh === "function") await assertFresh();
        assertNotAborted();
        const normalizedBeforeWire = normalizeHostToolResult(restoreHostEvidence(compactWithIdentity), {
          operation: queryOperation,
          evidenceSnapshotId: snapshotId,
          queryIdentity,
        });
        if (reusedResult) {
          normalizedBeforeWire.delivery = {
            ...normalizedBeforeWire.delivery,
            returned_count: 0,
            already_retrieved: true,
            already_sufficient: true,
            cache_hit: true,
            recovery_available: true,
            reused_result: true,
            next_action: "answer_from_previous_result",
            ...(recoveryNeedsReason ? {
              recovery_notice: "The complete result is already in this turn. Read it directly, including same-result aliases. If it is actually unavailable, set recovery_reason to context_compaction, session_recovery, or lost_evidence to receive it in full.",
            } : {}),
          };
        }
        // Search breadth is pagination, not damage to any returned candidate.
        const modelPage = candidatePage(normalizedBeforeWire);
        if (modelPage) delete modelPage.candidate_working_set_truncated;
        if (normalizedBeforeWire.delivery) {
          normalizedBeforeWire.delivery.recovery_available = normalizedBeforeWire.ok;
          normalizedBeforeWire.delivery.reference_scope = "same_result_document";
        }
        compactWithIdentity.schema = normalizedBeforeWire.schema;
        compactWithIdentity.ok = normalizedBeforeWire.ok;
        if (normalizedBeforeWire.error) compactWithIdentity.error = normalizedBeforeWire.error;
        compactWithIdentity.operation = normalizedBeforeWire.operation;
        compactWithIdentity.query_identity = normalizedBeforeWire.query_identity;
        compactWithIdentity.result = normalizedBeforeWire.result;
        compactWithIdentity.delivery = normalizedBeforeWire.delivery;
        const normalizedDelivery = normalizedBeforeWire.delivery || null;
        const wireResult = materializeReadonlyEvidence(compactWithIdentity);
        const resultBytes = jsonBytes(wireResult);
        if (resultBytes > maxResultBytes) throw new Error("readonly tool result budget exceeded");
        if (cumulativeResultBytes + resultBytes > maxCumulativeResultBytes) {
          throw new Error("readonly tool cumulative turn budget exceeded");
        }
        assertNotAborted();
        if (typeof onResult === "function") await onResult(compactWithIdentity, normalizedArgs, {
          elapsed_ms: Date.now() - startedAt,
          cache_hit: cacheHit,
          reused_result: reusedResult,
          query_identity: queryIdentity,
          result_bytes: resultBytes,
          cumulative_turn_bytes: cumulativeResultBytes + resultBytes,
        });
        // Publish broker state only after all asynchronous work accepted this call.
        assertNotAborted();
        if (pendingQueryCache) queryCache.set(pendingQueryCache.key, pendingQueryCache.value);
        cumulativeResultBytes += resultBytes;
        if (pendingContinuation) {
          pageSequence += 1;
          continuations.set(nextCursor, pendingContinuation);
        }
        if (!replayedPage && (pendingContinuation || normalizedArgs.cursor?.startsWith("tool-page:"))) {
          pageDeliveries.set(queryIdentity, structuredClone(wireResult));
        }
        if (!reusedResult && normalizedBeforeWire.ok && normalizedDelivery?.already_sufficient
          && normalizedDelivery.payload_state === "complete" && !compactWithIdentity.next_cursor) {
          completeDeliveries.add(queryIdentity);
        }
        for (const candidate of retained || []) deliveredIdentities.add(JSON.stringify([
          candidate.candidate_id || candidate.id, candidate.selected_variant_id, candidate.candidate_evidence_id,
        ]));
        for (const candidate of normalizedDelivery?.complete_atomic_candidates ? retained || [] : []) {
          const candidateId = String(candidate.candidate_id || candidate.id || "").trim();
          const candidateEvidenceId = String(candidate.candidate_evidence_id || "").trim();
          if (!candidateId && !candidateEvidenceId) continue;
          const deliveredBody = {
            candidate_evidence_id: candidateEvidenceId || null,
            selected_variant_ids: new Set([String(candidate.selected_variant_id || "").trim()].filter(Boolean)),
          };
          if (candidateId) deliveredCandidateBodies.set(candidateId, deliveredBody);
          if (candidateEvidenceId) deliveredCandidateBodies.set(`evidence:${candidateEvidenceId}`, deliveredBody);
        }
        knowledgeLedger.push({
          receipt_id: `tool-result:${audit.length + 1}`,
          query_identity: queryIdentity,
          operation: queryOperation,
          snapshot_id: snapshotId,
          coverage: normalizedDelivery?.complete_atomic_candidates
            ? ["complete_atomic_candidate_evidence"]
            : [],
          status: normalizedDelivery?.already_sufficient || queryOperation === "calculate"
            ? "sufficient"
            : "available",
          requery_allowed: true,
          reused_result: reusedResult,
        });
        audit.push({
          tool: normalized,
          evidence_snapshot_id: snapshotId,
          ok: true,
          argument_bytes: argumentBytes,
          result_bytes: resultBytes,
          cumulative_turn_bytes: cumulativeResultBytes,
          elapsed_ms: Date.now() - startedAt,
          cache_hit: cacheHit,
          reused_result: reusedResult,
          query_identity: queryIdentity,
        });
        return wireResult;
      } catch (error) {
        const failureCode = String(error?.message || error || "readonly_tool_failed").slice(0, 160);
        const receipt = {
          tool: normalized || "unknown",
          evidence_snapshot_id: snapshotId,
          ok: false,
          failure_code: failureCode,
          argument_bytes: argumentBytes,
          elapsed_ms: Math.max(0, Date.now() - startedAt),
        };
        audit.push(receipt);
        if (typeof onFailure === "function") {
          try { onFailure(receipt); } catch { /* diagnostics must not change tool semantics */ }
        }
        throw error;
      } finally {
        releaseCall();
      }
    },
    get knowledge_ledger() {
      return structuredClone(knowledgeLedger);
    },
  };
}
