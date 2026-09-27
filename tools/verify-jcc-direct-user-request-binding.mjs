import assert from "node:assert/strict";

process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
process.env.JCC_DISABLE_RESIDENT_AUGMENT_CHOICE_OCR = "1";
process.env.JCC_DISABLE_RESIDENT_ITEM_CHOICE_OCR = "1";
process.env.JCC_DISABLE_RESIDENT_SELF_STATE_ROI_OCR = "1";

const service = await import(`../ui/electron/runtime-service.js?direct-user-binding=${Date.now()}`);
const targetContextResolver = await import(`../ui/electron/target-context-resolver.js?direct-user-binding=${Date.now()}`);

assert.equal(
  service.explicitTargetPlanFromUserMessage("现在该留哪些牌？结合我想玩的方向和大数据说。"),
  null,
  "an exploratory strategy question must not become a confirmed durable lineup target",
);

const confirmedTarget = service.explicitTargetPlanFromUserMessage("我这把就玩六护卫蛇女。");
assert.equal(confirmedTarget?.status, "confirmed", "an explicit named lineup commitment should remain durable");
assert.match(confirmedTarget?.name || "", /六护卫蛇女/, "the durable target should preserve the named lineup identity");

assert.equal(
  service.explicitTargetPlanFromUserMessage("给我一张当前能转的阵容卡片，棋子放到 4x7 框里。"),
  null,
  "a lineup-card delivery request must not become a durable target plan",
);
assert.equal(
  service.explicitTargetPlanFromUserMessage("我这把就玩艾希，做成阵容图。"),
  null,
  "a named lineup-card materialization command must not silently rewrite the durable target",
);
assert.equal(
  service.explicitTargetPlanFromUserMessage("已确定最终阵容：六护卫蛇女，把最终阵容放到卡片内。")?.status,
  "confirmed",
  "an explicit final-lineup confirmation may persist while requesting card materialization",
);
const explicitPivotTarget = service.explicitTargetPlanFromUserMessage("这把转到六护卫蛇女。");
assert.equal(explicitPivotTarget?.status, "confirmed", "an explicit pivot to a named lineup must remain a durable target change");

const replacedTarget = targetContextResolver.buildDurableTargetPlanReplacement(
  {
    name: "旧目标A",
    candidate_id: "candidate-a",
    selected_variant_id: "variant-a",
    atomic_roster_id: "roster-a",
    target_revision: 4,
    authority: "durable_target_plan",
  },
  {
    name: "新目标B",
    text: "用户确认改玩新目标B",
    source: "explicit_user_commitment",
  },
);
assert.equal(replacedTarget.name, "新目标B", "a durable target replacement must make the new target active");
assert.equal(replacedTarget.target_revision, 5, "durable target replacement must advance its revision");
assert.equal(replacedTarget.candidate_id, undefined, "a text-only replacement must not inherit the old candidate identity");
assert.equal(replacedTarget.selected_variant_id, undefined, "a text-only replacement must not inherit the old variant identity");
assert.equal(replacedTarget.atomic_roster_id, undefined, "a text-only replacement must not inherit the old roster identity");
assert.equal(replacedTarget.previous_target_plan.name, "旧目标A", "the old target must remain audit-only history");
assert.equal(
  targetContextResolver.resolveTargetContextAuthority({ durableTargetPlan: replacedTarget }).target.name,
  "新目标B",
  "target resolution must consume the replacement, not the audit history");

assert.equal(
  service.classifyPersistedTargetPlanAuthority({
    text: "用户想围绕当前法系来牌运营，但允许根据硬数据和来牌转向。",
    confirmed_at: "2026-09-02T00:00:00.000Z",
    status: "confirmed",
  }),
  "provisional_user_intent",
  "legacy open preferences must not be upgraded into a durable atomic target",
);
assert.equal(
  service.classifyPersistedTargetPlanAuthority({
    candidate_id: "national:example",
    status: "confirmed",
  }),
  "durable_target_plan",
  "confirmed atomic candidate identity must remain durable",
);

const pendingCruiseRequest = {
  request_id: "pipeline-request",
  request_hash: "pipeline-request",
  mode: "cruise",
  ranking_query_route_key: "match:binding-match:ranking",
  user_message: "旧的巡航任务",
  task: { trigger_id: "lineup_convergence_checkpoint" },
  target_plan: { text: "旧锁定目标", authority: "durable_target_plan" },
  target_context_authority: "durable_target_plan",
  runtime_event_context: { event_key: "old-event", decision_trigger_id: "lineup_convergence_checkpoint" },
  stale_large_payload: "direct-binding-stale-payload".repeat(100_000),
  runtime_context: {
    runtime_event_context: { event_key: "nested-runtime-event", decision_trigger_id: "cap_gap_check" },
    strategy_fit_packet: { candidate_working_set: [{ evidence: "stale-large".repeat(100_000) }] },
  },
  expected_response_shape: { final_text: "string" },
  context: {
    mode: "cruise",
    user_message: "旧的巡航任务",
    runtime_context: { runtime_event_context: { event_key: "nested-context-event" } },
  },
};

const rebound = service.bindPendingHostRequestToDirectUserTask(
  pendingCruiseRequest,
  "给我一张最终阵容卡片，棋子放到 4x7 框里。",
  "lineup_card",
  { schema: "test-context-pack" },
);

const rebuilt = service.stripMaterializedHostEvidenceForRebuild({
  request_id: "rebuild-test",
  mode: "cruise",
  user_message: "当前问题",
  runtime_context: { strategy_fit_packet: { candidate_working_set: [{ candidate_id: "stale" }] } },
  selected_ranking_candidates: { candidates: [{ id: "stale" }] },
  future_materialized_evidence: { candidate_evidence_id: "must-not-survive" },
  context: {
    mode: "cruise",
    user_message: "当前问题",
    task: { type: "direct_user_task", trigger_id: "user_message_response" },
    runtime_context: { strategy_fit_packet: { candidate_working_set: [{ candidate_id: "stale" }] } },
  },
});
assert.equal(rebuilt.runtime_context, undefined, "request rebuild must remove materialized root runtime context");
assert.equal(rebuilt.selected_ranking_candidates, undefined, "request rebuild must remove materialized ranking candidates");
assert.equal(rebuilt.context?.runtime_context, undefined, "request rebuild must remove nested materialized runtime context");
assert.equal(rebuilt.context?.task?.trigger_id, "user_message_response", "request rebuild must preserve task identity");
assert.equal(rebuilt.user_message, "当前问题", "request rebuild must preserve current user message");
assert.equal(rebuilt.future_materialized_evidence, undefined, "request projection must reject unknown materialized evidence fields");
const rebuiltAgain = service.stripMaterializedHostEvidenceForRebuild(rebuilt);
assert.deepEqual(rebuiltAgain, rebuilt, "request evidence projection must be idempotent across repeated enrichment");

assert.notEqual(rebound.request_id, "pipeline-request", "direct requests must receive a fresh request identity");
assert.match(rebound.request_id, /^ui-direct:/, "direct requests must use the direct request identity namespace");
assert.equal(rebound.mode, "lineup_card", "the current direct user mode must override the pending pipeline mode");
assert.equal(rebound.context?.mode, "lineup_card", "the nested context mode must match the current direct user mode");
assert.equal(rebound.user_message, "给我一张最终阵容卡片，棋子放到 4x7 框里。", "the current user text must override stale pipeline text");
assert.equal(rebound.context?.user_message, rebound.user_message, "nested user text must match the direct task");
assert.equal(rebound.pinned_result_required, true, "lineup-card rebinding must require a pinned card result");
assert.equal(rebound.lineup_card_intent, "final_target", "a normal lineup-card request should default to a final target board");
assert.equal(rebound.runtime_event_context, undefined, "a direct request must not inherit automatic runtime-event authority");
assert.equal(rebound.context?.runtime_event_context, undefined, "nested direct-request context must not inherit automatic runtime-event authority");
assert.equal(rebound.context?.supporting_context?.absorbed_runtime_event_context?.event_key, "old-event",
  "absorbed pipeline evidence may remain only in an explicitly non-authoritative supporting envelope");
assert.equal(rebound.context?.supporting_context?.authority, "supporting_evidence_only",
  "absorbed event evidence must declare that it cannot own or reclassify the direct request");
assert.equal(JSON.stringify(rebound).includes("direct-binding-stale-payload"), false,
  "direct rebinding must not copy stale top-level payloads");
assert.equal(JSON.stringify(rebound).includes("stale-large"), false,
  "direct rebinding must not copy stale nested strategy evidence");
assert.equal(rebound.context?.runtime_context, undefined,
  "direct rebinding must not retain nested runtime context authority");
assert.equal(rebound.task?.trigger_id, "direct_lineup_card_request", "the direct task must not inherit the pending automatic trigger identity");
assert.equal(rebound.target_plan, undefined, "the direct materialization request must not inherit stale target authority");
assert.equal(rebound.target_context_authority, undefined, "the direct materialization request must recompute target authority from current match context");
assert.equal(rebound.expected_response_shape?.request_id, undefined, "transport schema must not ask the model to echo request identity");
assert(rebound.expected_response_shape?.lineup_handoff, "the response contract must include only the lineup handoff shape");

const nestedRuntimeEventLocations = [
  (request) => { request.runtime_event_context = { event_key: "top-level" }; },
  (request) => { request.task = { runtime_event_context: { event_key: "task-level" } }; },
  (request) => { request.runtime_context = { runtime_event_context: { event_key: "root-context" } }; },
  (request) => { request.context = { runtime_event_context: { event_key: "context-level" } }; },
  (request) => { request.context = { runtime_context: { runtime_event_context: { event_key: "nested-context" } } }; },
];
for (const [index, addRuntimeEventContext] of nestedRuntimeEventLocations.entries()) {
  const request = {};
  addRuntimeEventContext(request);
  const isolated = service.bindPendingHostRequestToDirectUserTask(
    request,
    `问题 ${index + 1}`,
    "cruise",
    { schema: "test-context-pack" },
  );
  assert.equal(isolated.runtime_event_context, undefined, `direct request must drop runtime-event authority at location ${index}`);
  assert.equal(isolated.context?.runtime_event_context, undefined, `direct context must drop runtime-event authority at location ${index}`);
  assert.equal(isolated.context?.runtime_context, undefined, `direct nested context must drop runtime-event authority at location ${index}`);
  assert.equal(
    isolated.context?.supporting_context?.absorbed_runtime_event_context?.event_key,
    index === 0 ? "top-level" : index === 1 ? "task-level" : index === 2 ? "root-context" : index === 3 ? "context-level" : "nested-context",
    `direct request must preserve only compact supporting evidence at location ${index}`,
  );
}

const refreshedStrategicRequest = service.hostRequestWithStrategicObligationEnvelope({
  request_id: "strategic-correction",
  request_hash: "strategic-correction",
  mode: "cruise",
  runtime_context: {
    strategy_fit_packet: {
      strategic_obligation: { queue_revision: 1, completion_receipts: [{ block_id: "lineup", revision: 1 }] },
      next_coach_plan: {
        strategic_obligation: { queue_revision: 1, completion_receipts: [{ block_id: "lineup", revision: 1 }] },
      },
    },
  },
  context: {},
  expected_response_shape: {},
}, {
  queue_revision: 3,
  completion_receipts: [{ block_id: "lineup", revision: 2, latest_checkpoint_id: "3-3" }],
  required_decisions: ["lineup_convergence"],
  complete_candidate_rosters_required: true,
  pending_candidate_ids: ["candidate-b"],
});
assert.equal(refreshedStrategicRequest.runtime_context?.strategy_fit_packet?.strategic_obligation?.queue_revision, 3,
  "a strategic correction must replace the stale embedded obligation with the latest queue envelope");
assert.equal(refreshedStrategicRequest.runtime_context?.strategy_fit_packet?.next_coach_plan?.strategic_obligation?.completion_receipts?.[0]?.revision, 2,
  "every strategic authority path must use the same refreshed completion receipt");
assert.equal(refreshedStrategicRequest.context?.runtime_context?.schema, "jcc-runtime-context-reference-v1",
  "nested strategic runtime context must be a bounded reference instead of a second full evidence payload");
assert.equal(refreshedStrategicRequest.context?.runtime_context?.strategy_fit_packet?.candidate_working_set, undefined,
  "nested strategic runtime context must not duplicate the candidate working set");
assert(refreshedStrategicRequest.expected_response_shape?.candidate_refs,
  "the refreshed response contract must ask only for candidate identity handoff");
assert.equal(refreshedStrategicRequest.expected_response_shape?.strategic_completion, undefined);

service.setRuntimeServiceState({
  ...service.getRuntimeServiceState(),
  match_session: { status: "active", match_session_id: "binding-match" },
});
const lineupRoute = service.ensureRankingQueryRouteKey(rebound, "lineup_card", {
  hard_data_only: false,
  include_daily_big_data: true,
});
assert.match(lineupRoute.ranking_query_route_key, /^match:binding-match:lineup-card:/, "lineup cards must use an isolated per-request ranking route");
assert.notEqual(lineupRoute.ranking_query_route_key, pendingCruiseRequest.ranking_query_route_key, "a stale shared match route must not survive lineup-card rebinding");

const recoveredIntent = service.recoverRankingQueryIntent({
  schema: "jcc-ranking-query-intent-v1",
  groups: [{ id: "legacy-group", constraints: null, roles: [] }],
}, {
  schema: "jcc-ranking-query-intent-v1",
  normalized_text: "给我一张阵容卡片",
  groups: [],
});
assert.equal(recoveredIntent.previous_invalidated, true, "an invalid legacy ranking intent must be invalidated at the route boundary");
assert.equal(recoveredIntent.intent.normalized_text, "给我一张阵容卡片", "recovery must continue with the current parsed request");

const mergeRecoveredIntent = service.recoverRankingQueryIntent({
  schema: "jcc-ranking-query-intent-v1",
  normalized_text: "继续",
  groups: [{ id: "g1", constraints: [], roles: [] }],
  continuation: { mode: "continue" },
}, {
  schema: "jcc-ranking-query-intent-v1",
  normalized_text: "给我一张阵容卡片",
  groups: [],
});
assert.equal(mergeRecoveredIntent.intent.normalized_text, "给我一张阵容卡片", "a safe route merge should still preserve the current request text");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-direct-user-request-binding-verification-v1",
  checked: [
    "exploratory_strategy_question_does_not_create_target",
    "explicit_named_target_remains_durable",
    "lineup_card_delivery_does_not_create_target",
    "named_lineup_card_materialization_does_not_rewrite_target",
    "explicit_final_lineup_confirmation_remains_durable",
    "explicit_named_pivot_remains_durable",
    "legacy_open_preference_remains_provisional",
    "pending_pipeline_request_rebound_to_current_lineup_mode",
    "absorbed_runtime_event_context_is_supporting_evidence_only",
    "all_supported_runtime_event_context_locations_are_sanitized",
    "lineup_card_contract_and_identity_preserved",
    "lineup_card_uses_isolated_ranking_route",
    "invalid_legacy_ranking_route_recovers_from_current_request",
  ],
}, null, 2));
