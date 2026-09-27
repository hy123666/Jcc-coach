#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildDirectHostRequest,
  hostCoachNativeOutputSchemaForRequest,
  normalizeHostCoachResponse,
  summarizeHostRequest,
} from "../ui/electron/runtime-service.js";
import { normalizeHostCoachTransportEnvelope } from "../ui/electron/host-coach-response-contract.js";

const root = path.resolve(import.meta.dirname, "..");
const service = await readFile(path.join(root, "ui/electron/runtime-service.js"), "utf8");
const app = await readFile(path.join(root, "ui/src/App.tsx"), "utf8");

const request = {
  request_id: "verify-host-response-integrity",
  mode: "cruise",
  runtime_context: {},
};
assert.equal(
  buildDirectHostRequest("当前阵容怎么走", "cruise").expected_response_shape.schema,
  "jcc-host-cli-coach-response-v1",
  "direct Host requests must declare the canonical response schema before the first model token",
);
assert.equal(
  summarizeHostRequest({ request_id: "summary-schema", mode: "cruise" }).expected_response_shape.schema,
  "jcc-host-cli-coach-response-v1",
  "summarized Host requests must retain the canonical response schema",
);
const canonicalIdentity = {
  schema: "jcc-host-cli-coach-response-v1",
  generated_by: "current_cli_agent_main_model",
  request_id: request.request_id,
  request_hash: request.request_id,
  mode: request.mode,
};

const firstRevisionSchema = hostCoachNativeOutputSchemaForRequest({
  ...request,
  runtime_event_context: {
    strategic_obligation: {
      completion_receipts: [{ block_id: "lineup_direction_commitment", revision: 1, latest_checkpoint_id: "post_3_2_narrowing" }],
      required_decisions: ["choice_effect_on_each_direction"],
    },
  },
  runtime_context: {
    strategic_obligation: {
      completion_receipts: [{ block_id: "lineup_direction_commitment", revision: 1, latest_checkpoint_id: "post_3_2_narrowing" }],
      required_decisions: ["choice_effect_on_each_direction"],
    },
  },
});
const laterRevisionSchema = hostCoachNativeOutputSchemaForRequest({
  ...request,
  runtime_event_context: {
    strategic_obligation: {
      completion_receipts: [
        { block_id: "lineup_direction_commitment", revision: 1, latest_checkpoint_id: "post_3_2_narrowing" },
        { block_id: "formation_readiness_and_execution", revision: 1, latest_checkpoint_id: "three_cost_reroll_or_operation" },
      ],
      required_decisions: ["choice_effect_on_each_direction", "three_cost_carry_three_star_target_check"],
    },
  },
  runtime_context: {
    strategic_obligation: {
      completion_receipts: [
        { block_id: "lineup_direction_commitment", revision: 1, latest_checkpoint_id: "post_3_2_narrowing" },
        { block_id: "formation_readiness_and_execution", revision: 1, latest_checkpoint_id: "three_cost_reroll_or_operation" },
      ],
      required_decisions: ["choice_effect_on_each_direction", "three_cost_carry_three_star_target_check"],
    },
  },
});
assert(firstRevisionSchema.properties.candidate_refs,
  "a strategic turn with candidate identities must expose the minimal candidate handoff");
assert.equal(firstRevisionSchema.properties.strategic_completion, undefined,
  "strategy prose and completion receipts must not be part of Provider output Schema");
assert.equal(firstRevisionSchema.properties.strategy_selection, undefined,
  "the detailed legacy strategy selection object must not be part of Provider output Schema");
const lineupNativeSchema = hostCoachNativeOutputSchemaForRequest({
  request_id: "native-lineup-schema",
  mode: "lineup_card",
  lineup_card_intent: "final_target",
  lineup_confirmation_requested: true,
});
assert.equal(
  Boolean(lineupNativeSchema.properties.lineup_handoff),
  true,
  "lineup-card Host turns must use the minimal lineup handoff at turn/start",
);
const factCaptureNativeSchema = hostCoachNativeOutputSchemaForRequest({
  request_id: "native-fact-schema",
  mode: "cruise",
  request_kind: "match_fact_capture",
  expected_response_shape: { fact_capture: true },
});
assert.equal(
  factCaptureNativeSchema.properties.fact_capture.properties.schema.const,
  "jcc-match-fact-capture-v1",
  "fact-capture Host turns must use their production schema at turn/start",
);
assert(laterRevisionSchema.properties.candidate_refs,
  "a later strategic revision must use the same stable candidate identity handoff");
assert.deepEqual(
  Object.keys(firstRevisionSchema.properties).sort(),
  Object.keys(laterRevisionSchema.properties).sort(),
  "changing strategic prose goals must not mutate the Provider transport shape",
);
assert(
  !service.includes("buildHostCoachCorrectionPrompt")
    && !service.includes("rule_correction_attempted: true"),
  "format and quality issues must not create a second Provider correction turn",
);
assert(
  !service.includes("strategicObligationResponseDiagnostics")
    && !service.includes("diagnoseStrategicObligationResponseCoverage")
    && !service.includes("recordStrategicObligationPartialCompletion"),
  "retired strict strategic coverage diagnostics must stay disconnected from production delivery",
);

const mojibake = normalizeHostCoachResponse({
    ...canonicalIdentity,
    final_text: "\u951b\u8bef\u7f16\u7801\u56de\u7b54",
    confidence: "medium",
  }, request);
assert.equal(mojibake.final_text, "\u951b\u8bef\u7f16\u7801\u56de\u7b54");
assert(mojibake.soft_quality_diagnostics.includes("final_text_mojibake_detected"),
  "mojibake must remain observable without turning a readable response into a correction loop");

const accepted = normalizeHostCoachResponse({
  ...canonicalIdentity,
  final_text: "当前先保经济，下一回合再根据对子决定是否拉人口。",
  confidence: "medium",
  provider_internal_field: "must not cross the boundary",
}, request);
assert.match(accepted.final_text, /保经济/);
assert.equal(accepted.schema, "jcc-host-cli-coach-response-v1");
assert.equal(accepted.provider_internal_field, undefined, "normalizer must rebuild an allowlisted coach response");
const normalizedTransportAliases = normalizeHostCoachResponse({
  responseSchema: "jcc-host-cli-coach-response-v1",
  generatedBy: "current_cli_agent_main_model",
  finalText: "字段别名由 Runtime 机械归一化。",
  recommendedAction: "继续按当前策略执行",
  followupQuestion: null,
}, request);
assert.equal(normalizedTransportAliases.final_text, "字段别名由 Runtime 机械归一化。");
assert.equal(normalizedTransportAliases.recommended_action, "继续按当前策略执行");
assert.equal(normalizedTransportAliases.schema, "jcc-host-cli-coach-response-v1");
const normalizedForeignSchema = normalizeHostCoachResponse({ ...canonicalIdentity, schema: "provider-debug-v1", final_text: "wrong schema" }, request);
assert.equal(normalizedForeignSchema.schema, "jcc-host-cli-coach-response-v1");
assert(normalizedForeignSchema.soft_quality_diagnostics.includes("response_schema_normalized"));
const normalizedForeignOwner = normalizeHostCoachResponse({ ...canonicalIdentity, request_id: "wrong-request", final_text: "wrong owner" }, request);
assert.equal(normalizedForeignOwner.request_id, request.request_id);
assert(normalizedForeignOwner.soft_quality_diagnostics.includes("response_request_id_normalized"));

const augmentRequest = {
  request_id: "verify-augment-normalization",
  request_hash: "verify-augment-normalization",
  mode: "augment_choice",
  structured_card_action: true,
  runtime_event_context: {
    user_message_kind: "structured_choice_advice",
    decision_domain: "augment",
  },
  runtime_context: {
    current_match_user_report: {
      kind: "augment",
      candidates: [
        { slot: 1, name: "神力天铸" },
        { slot: 2, name: "后排蓝图" },
        { slot: 3, name: "电火花I" },
      ],
    },
    cruise_decision_context: {
      augment_choice_evaluation: {
        candidate_ranking: ["神力天铸", "后排蓝图", "电火花I"],
        rows: [],
      },
    },
  },
};
const normalizedKeepAndPick = normalizeHostCoachResponse({
  schema: "jcc-host-cli-coach-response-v1",
  generated_by: "current_cli_agent_main_model",
  final_text: "保留并选择神力天铸。",
  confidence: "medium",
  choice_recommendation: {
    candidate_ranking: ["神力天铸", "后排蓝图", "电火花I"],
    refresh_action: "keep_and_pick",
    refresh_slots: [],
  },
}, augmentRequest);
assert.equal(
  normalizedKeepAndPick.choice_recommendation.selected_candidate,
  "神力天铸",
  "keep_and_pick should deterministically bind the first ranked candidate when Host omits the redundant selected_candidate field",
);
const normalizedRefreshAlias = normalizeHostCoachResponse({
  schema: "jcc-host-cli-coach-response-v1",
  generated_by: "current_cli_agent_main_model",
  final_text: "刷新全部三个位置。",
  confidence: "medium",
  choice_recommendation: {
    candidate_ranking: ["神力天铸", "后排蓝图", "电火花I"],
    refresh_action: "refresh all",
    refresh_slots: [],
  },
}, augmentRequest);
assert.equal(
  normalizedRefreshAlias.choice_recommendation.refresh_action,
  "refresh_all",
  "human-readable refresh action separators should normalize without requiring a second Host turn",
);
const normalizedLowerRankSwap = normalizeHostCoachResponse({
  schema: "jcc-host-cli-coach-response-v1",
  generated_by: "current_cli_agent_main_model",
  final_text: "选择神力天铸，不刷新。",
  confidence: "medium",
  choice_recommendation: {
    candidate_ranking: ["神力天铸", "电火花I", "后排蓝图"],
    refresh_action: "keep_and_pick",
    selected_candidate: "神力天铸",
    refresh_slots: [],
  },
}, augmentRequest);
assert.deepEqual(
  normalizedLowerRankSwap.choice_recommendation.candidate_ranking,
  ["神力天铸", "后排蓝图", "电火花I"],
  "a lower-rank-only permutation should mechanically restore evaluator order instead of requiring a correction turn",
);
const normalizedCamelChoice = normalizeHostCoachResponse({
  responseSchema: "jcc-host-cli-coach-response-v1",
  generatedBy: "current_cli_agent_main_model",
  finalText: "保留并选择神力天铸。",
  choiceRecommendation: {
    candidateRanking: ["神力天铸", "后排蓝图", "电火花I"],
    refreshAction: "keepAndPick",
    refreshSlots: [],
  },
}, augmentRequest);
assert.equal(normalizedCamelChoice.choice_recommendation.selected_candidate, "神力天铸");

const augmentWithStrategicEvidence = {
  ...augmentRequest,
  runtime_event_context: {
    ...augmentRequest.runtime_event_context,
    strategic_obligation: {
      queue_revision: 7,
      completion_receipts: [{ block_id: "lineup-direction", revision: 2 }],
      required_decisions: ["lineup_direction"],
    },
  },
  runtime_context: {
    ...augmentRequest.runtime_context,
    strategy_fit_packet: {
      strategic_obligation: {
        queue_revision: 7,
        completion_receipts: [{ block_id: "lineup-direction", revision: 2 }],
        required_decisions: ["lineup_direction"],
      },
      candidate_working_set: [{ candidate_id: "candidate-a", display_name: "证据候选" }],
    },
  },
};
const augmentEvidenceSchema = hostCoachNativeOutputSchemaForRequest(augmentWithStrategicEvidence);
assert.equal(
  augmentEvidenceSchema.properties.strategic_completion,
  undefined,
  "augment choice must not acquire strategic output fields from attached strategic evidence",
);
const normalizedAugmentWithStrategicEvidence = normalizeHostCoachResponse({
  schema: "jcc-host-cli-coach-response-v1",
  generated_by: "current_cli_agent_main_model",
  final_text: "保留并选择神力天铸。",
  confidence: "high",
  choice_recommendation: {
    candidate_ranking: ["神力天铸", "后排蓝图", "电火花I"],
    refresh_action: "keep_and_pick",
    selected_candidate: "神力天铸",
    refresh_slots: [],
  },
}, augmentWithStrategicEvidence);
assert.equal(
  normalizedAugmentWithStrategicEvidence.strategic_obligation_coverage,
  null,
  "augment choice must not run strategic delivery validation merely because evidence is attached",
);
const mergedAugmentRequest = {
  ...augmentWithStrategicEvidence,
  task_contract: {
    strategic_delivery_required: true,
    absorbs_strategic_obligation: true,
  },
  expected_response_shape: {
    strategic_delivery_required: true,
  },
};
const mergedAugmentSchema = hostCoachNativeOutputSchemaForRequest(mergedAugmentRequest);
assert(mergedAugmentSchema.properties.choice_handoff, "an explicit merged choice must retain its minimal choice handoff");
assert.equal(mergedAugmentSchema.properties.candidate_refs, undefined,
  "an explicit merged choice must not duplicate identities in a second handoff");
assert.equal(mergedAugmentSchema.properties.strategic_completion, undefined);
const normalizedMergedAugment = normalizeHostCoachResponse({
  schema: "jcc-host-cli-coach-response-v1",
  generated_by: "current_cli_agent_main_model",
  final_text: "选择神力天铸，并说明它对候选方向的影响。",
  confidence: "high",
  choice_recommendation: {
    candidate_ranking: ["神力天铸", "后排蓝图", "电火花I"],
    refresh_action: "keep_and_pick",
    selected_candidate: "神力天铸",
    refresh_slots: [],
  },
  strategic_completion: {
    queue_revision: 7,
    completion_receipts: [{ block_id: "lineup-direction", revision: 2 }],
    covered_required_decisions: ["lineup_direction"],
    decision_outputs: { lineup_direction: "选择神力天铸，并说明它对候选方向的影响。" },
  },
  strategy_selection: {
    selected_candidate_ids: ["candidate-a"],
    selected_candidate_refs: [{ candidate_id: "candidate-a" }],
  },
}, mergedAugmentRequest);
assert.equal(normalizedMergedAugment.choice_recommendation.selected_candidate, "神力天铸");
assert.equal(normalizedMergedAugment.strategic_obligation_coverage, null,
  "strategic coverage quality diagnostics must not gate or mutate the delivered response");
const missingSchema = normalizeHostCoachResponse({
  generatedBy: "current_cli_agent_main_model",
  finalText: "缺少响应 schema，但文本可读。",
}, request);
assert.equal(missingSchema.schema, "jcc-host-cli-coach-response-v1");
assert(missingSchema.soft_quality_diagnostics.includes("response_schema_normalized"));
const missingGenerator = normalizeHostCoachResponse({
  responseSchema: "jcc-host-cli-coach-response-v1",
  finalText: "缺少生成者身份，但文本可读。",
}, request);
assert.equal(missingGenerator.generated_by, "current_cli_agent_main_model");
assert(missingGenerator.soft_quality_diagnostics.includes("response_generator_normalized"));
const normalizedScalarRefreshSlot = normalizeHostCoachResponse({
  responseSchema: "jcc-host-cli-coach-response-v1",
  generatedBy: "current_cli_agent_main_model",
  finalText: "只刷新第二个位置。",
  choiceRecommendation: {
    candidateRanking: ["神力天铸", "后排蓝图", "电火花I"],
    refreshAction: "refreshSpecific",
    refreshSlots: 2,
  },
}, augmentRequest);
assert.deepEqual(normalizedScalarRefreshSlot.choice_recommendation.refresh_slots, [2]);
const normalizedNestedAliases = normalizeHostCoachTransportEnvelope({
  finalText: "嵌套别名规范化。",
  augmentEvaluatorOverrideReason: {
    source: "typed_current_fact",
    factPath: "match_facts.current_augment",
    reason: "当前强化事实已确认",
  },
  strategySelection: {
    selectedCandidateRefs: [{
      candidateId: "candidate-a",
      selectedVariantId: "variant-a",
      candidateEvidenceId: "evidence-a",
    }],
  },
});
assert.equal(normalizedNestedAliases.augment_evaluator_override_reason.fact_path, "match_facts.current_augment");
assert.deepEqual(normalizedNestedAliases.strategy_selection.selected_candidate_refs[0], {
  candidateId: "candidate-a",
  selectedVariantId: "variant-a",
  candidateEvidenceId: "evidence-a",
  candidate_id: "candidate-a",
  selected_variant_id: "variant-a",
  candidate_evidence_id: "evidence-a",
});

assert(
  service.includes('softDiagnostics.push("final_text_mojibake_detected")')
    && !service.includes("buildHostCoachCorrectionPrompt"),
  "mojibake must remain observable without starting a format-correction turn",
);
assert(
  app.includes("function isGenericHostExitOnly")
    && app.includes("const diagnosticText = userVisibleHostDiagnosticsText(diagnostics)")
    && app.includes("if (visible && !genericExitOnly) return visible"),
  "UI must show provider 401/403/429/503 details while translating a bare exit-code-only error into a useful fallback",
);
assert(
  service.includes('schema: "jcc-runtime-host-run-diagnostics-v1"')
    && service.includes("stdout_tail: sanitizedHostDiagnosticTail")
    && service.includes("stderr_tail: sanitizedHostDiagnosticTail")
    && service.includes('recordRuntimeEvent("host_cli_request_failed"'),
  "failed Host CLI calls must persist bounded sanitized diagnostics",
);
assert(
  service.includes('Authorization: Bearer <redacted>')
    && service.includes('"(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token)"'),
  "runtime diagnostics must redact bearer and JSON-key credentials before persistence",
);

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-host-response-integrity-verifier-v1",
  checked: [
    "live_normalizer_reports_mojibake_without_provider_retry",
    "live_normalizer_requires_canonical_final_text",
    "live_normalizer_rejects_identity_conflicts",
    "live_normalizer_rebuilds_allowlisted_schema",
    "augment_keep_selection_is_deterministically_completed",
    "augment_refresh_action_aliases_are_normalized",
    "nested_transport_aliases_are_normalized",
    "scalar_refresh_slot_is_normalized",
    "lineup_and_fact_capture_use_native_output_schema",
    "native_schema_tracks_latest_same_task_decision_revision",
    "host_failures_persist_sanitized_diagnostics",
    "provider_status_details_remain_user_visible",
  ],
}, null, 2));
