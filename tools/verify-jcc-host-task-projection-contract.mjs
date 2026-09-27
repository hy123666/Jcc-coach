import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  assertProjectedHostRequest,
  compactHostSupportingEvent,
  projectHostRequestForTask,
  withHostRequestProjectionMetadata,
} from "../ui/electron/host-request-projection.js";
import { taskContractFor } from "../ui/electron/host-task-contract-registry.js";

process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
process.env.JCC_DISABLE_RESIDENT_SELF_STATE_ROI_OCR = "1";
process.env.JCC_DISABLE_RESIDENT_AUGMENT_CHOICE_OCR = "1";
process.env.JCC_DISABLE_RESIDENT_ITEM_CHOICE_OCR = "1";

// Expose the actual private functions without changing production exports,
// replacing their dependencies, or creating a second copy of their logic.
const serviceUrl = new URL("../ui/electron/runtime-service.js", import.meta.url).href;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== serviceUrl) return result;
    return { ...result, source: `${result.source}\nexport { enrichHostRequestWithRuntimeContext, buildMatchFactCaptureHostRequest };` };
  },
});
const service = await import(serviceUrl);
hooks.deregister();
const checked = [];
const stale = { candidate_working_set: [{ candidate_id: "stale-candidate", roster: ["stale-unit"] }] };
const poison = (request) => ({
  ...request,
  unknown_future_evidence: stale,
  daily_big_data: stale,
  season_catalog: { champion_names: ["stale-unit"] },
  selected_ranking_candidates: stale,
  strategy_wiki_context: stale,
  context: { ...request.context, live_state_summary: stale, decision_snapshot: stale, runtime_context: stale, scores: stale },
  runtime_context: { ...request.runtime_context, match_facts: stale, selected_ranking_candidates: stale, strategy_fit_packet: stale, strategy_evidence_prefetch: stale },
});
function assertNoStale(request) {
  assert.equal(JSON.stringify(request).includes("stale-candidate"), false);
  assert.equal(JSON.stringify(request).includes("stale-unit"), false);
}

for (const mode of ["daily_chat", "augment_choice", "item_choice", "cruise", "lineup_card", "manual_match_variables", "descriptor_choice"] ) {
  const request = service.buildDirectHostRequest("current question", mode);
  request.current_match_user_report = { report_id: "sealed-report", revision: 3, candidates: ["A", "B", "C"] };
  request.choices = { report_id: "sealed-report", candidates: ["A", "B", "C"] };
  request.context = {
    task: { type: "direct_user_task", task_id: "task", title: "x".repeat(220), semantic_labels: ["x", "x", "y"], scores: stale },
    choices: request.choices,
    supporting_context: { authority: "supporting_evidence_only", absorbed_runtime_event_context: { event_key: "old-event", scores: stale } },
  };
  const result = projectHostRequestForTask(poison(request));
  assertNoStale(result);
  assert.deepEqual(result.expected_response_shape, request.expected_response_shape);
  assert.deepEqual(result.current_match_user_report, request.current_match_user_report);
  assert.deepEqual(result.context.choices, request.choices);
  assert.equal(result.context.supporting_context.authority, "supporting_evidence_only");
  assert.deepEqual(projectHostRequestForTask(result), result);
  assert.deepEqual(service.stripMaterializedHostEvidenceForRebuild(poison(request)), result);
  assertProjectedHostRequest(result);
}
checked.push("registry_consumed_by_runtime_rebuild_all_modes", "task_context_bounds_and_choice_identity", "projection_idempotence");

for (const reason of [undefined, null, ""]) {
  assert.equal(compactHostSupportingEvent({ reason }), null);
  assert.deepEqual(compactHostSupportingEvent({ event_key: "event", reason }), { event_key: "event" });
}
assert.deepEqual(compactHostSupportingEvent({ reason: "null" }), { reason: "null" });
assert.equal(compactHostSupportingEvent({ reason: "r".repeat(300) }).reason, `${"r".repeat(240)}...<truncated>`);
const verbatimMessage = `  ${"user text\t".repeat(100)}\ntrailing spaces  `;
const verbatimRequest = service.bindPendingHostRequestToDirectUserTask({}, verbatimMessage, "cruise");
assert.equal(verbatimRequest.context.task.user_message, verbatimMessage);
const verbatimProjection = projectHostRequestForTask(verbatimRequest);
assert.equal(verbatimProjection.user_message, verbatimMessage);
assert.equal(verbatimProjection.task.user_message, verbatimMessage);
assert.equal(verbatimProjection.context.user_message, verbatimMessage);
assert.equal(verbatimProjection.context.task.user_message, verbatimMessage);
assert.deepEqual(projectHostRequestForTask(verbatimProjection), verbatimProjection);
checked.push("absent_supporting_reason_not_materialized", "task_user_message_preserved_verbatim_without_truncation");

const ordered = { mode: "cruise", expected_response_shape: { z: 1, a: { b: 2, a: 3 } }, choices: ["A", "B"] };
const reordered = { choices: ["A", "B"], expected_response_shape: { a: { a: 3, b: 2 }, z: 1 }, mode: "cruise" };
const first = projectHostRequestForTask(ordered);
assert.equal(first.projection_hash, projectHostRequestForTask(reordered).projection_hash);
const changed = { ...first, choices: ["B", "A"] };
assert.notEqual(first.projection_hash, projectHostRequestForTask(changed).projection_hash);
assert.throws(() => assertProjectedHostRequest(changed), /stale/);
const tamperedHash = { ...first, projection_hash: "forged-old-hash" };
assert.equal(projectHostRequestForTask(tamperedHash).projection_hash, first.projection_hash);
first.expected_response_shape.a.a = 999;
assert.equal(ordered.expected_response_shape.a.a, 3, "projection must not alias mutable input");
const evidenceA = withHostRequestProjectionMetadata({ mode: "cruise", runtime_context: { current_hp: 80 } });
const evidenceB = withHostRequestProjectionMetadata({ ...evidenceA, runtime_context: { current_hp: 79 } });
assert.notEqual(evidenceA.projection_hash, evidenceB.projection_hash, "final receipt must hash rebuilt evidence too");
assert.equal(taskContractFor("lineup_card", "match_fact_capture").id, "fact_capture");
assert.equal(taskContractFor("toString", "constructor").id, "default");
assert.equal(projectHostRequestForTask({ mode: "fact_capture", runtime_context: { fact_capture_catalog: {} } }).runtime_context, undefined);
assert.equal(projectHostRequestForTask({ mode: "cruise" }, { requestKind: "match_fact_capture" }).request_kind, undefined);
checked.push("canonical_hash_key_order_array_order_and_content", "old_hash_never_reused", "no_mode_or_option_authority_escalation");

const root = await mkdtemp(path.join(os.tmpdir(), "jcc-host-projection-"));
try {
  service.configureRuntimeServicePaths({ dataRoot: root });
  const snapshot = service.captureMatchSeasonVersionSnapshot();
  service.setRuntimeServiceState({
    schema: "jcc-ui-runtime-state-v1",
    active_mode: "cruise",
    match_session: { status: "active", match_session_id: "projection-match", season_version_snapshot: snapshot },
    match_context: {
      match_session_id: "projection-match",
      choice_confirmations: [{ stage_round: "2-1", kind: "augment", name: "current-confirmation" }],
      user_confirmed_equipment: { components: [{ name: "current-component", count: 2 }] },
      manual_match_variables: { current: true },
    },
    response_task: { status: "idle" }, response_task_revision: 0,
    host_cli: { status: "idle", provider: "codex" }, runtime_events: { latest: [] },
  });

  const quick = await service.buildMatchFactCaptureHostRequest("current equipment report", { scope: "mode", mode_id: "cruise" }, { phase: { stage_round: "3-2" } });
  assert.ok(Object.keys(quick.runtime_context.fact_capture_catalog.entities).length > 0);
  const capture = await service.enrichHostRequestWithRuntimeContext(poison(quick), "cruise");
  assertNoStale(capture);
  assert.deepEqual(capture.expected_response_shape, quick.expected_response_shape);
  assert.deepEqual(capture.runtime_context.fact_capture_catalog, quick.runtime_context.fact_capture_catalog);
  assert.deepEqual(capture.runtime_context.current_match_facts, quick.runtime_context.current_match_facts);
  assert.equal(capture.runtime_context.current_stage_round, "3-2");
  assert.equal(capture.runtime_context.match_session_id, "projection-match");
  assert.equal(capture.request_kind, "match_fact_capture");
  assert.equal(capture.pinned_result_required, false);
  const captureAgain = await service.enrichHostRequestWithRuntimeContext(capture, "cruise");
  assert.deepEqual(captureAgain, capture);
  assertProjectedHostRequest(captureAgain);
  const delta = service.compactHostTurnDelta(captureAgain, { capsule_id: "test", fingerprint: "test", route_key: "match:test" });
  assert.deepEqual(delta.runtime_context.fact_capture_catalog, quick.runtime_context.fact_capture_catalog);
  assert.equal(delta.response_contract_ref.fact_capture_required, true);
  const captureNativeSchema = service.hostCoachNativeOutputSchemaForRequest(captureAgain);
  assert.ok(captureNativeSchema.properties.fact_capture);
  assert.ok(captureNativeSchema.required.includes("fact_capture"));
  assert.deepEqual(captureNativeSchema, service.hostCoachNativeOutputSchemaForRequest(quick));
  checked.push("actual_quick_capture_builder_and_enrich_twice", "fact_capture_catalog_facts_shape_identity_and_delta_preserved", "projected_fact_capture_native_schema_unchanged");

  const direct = service.bindPendingHostRequestToDirectUserTask(poison({ mode: "cruise", runtime_event_context: { event_key: "old-event" } }), "hello", "cruise");
  direct.provider_readonly_tool_mode = "prefetch_complete";
  const enriched = await service.enrichHostRequestWithRuntimeContext(poison(direct), "cruise");
  const enrichedAgain = await service.enrichHostRequestWithRuntimeContext(poison(enriched), "cruise");
  for (const current of [enriched, enrichedAgain]) {
    assertNoStale(current);
    assert.equal(current.user_message, direct.user_message);
    assert.deepEqual(current.expected_response_shape, direct.expected_response_shape);
    assert.equal(current.context.supporting_context.authority, "supporting_evidence_only");
    assert.equal(current.runtime_event_context, undefined);
    assert.ok(current.runtime_context.context_policy);
    assert.ok(current.runtime_context.strategy_evidence_snapshot);
    assert.ok(current.runtime_context.strategy_evidence_plan);
    assert.equal(current.runtime_context.strategy_evidence_plan.provider_capability, "prefetch_complete");
    assert.equal(current.runtime_context.match_facts.match_session_id, "projection-match");
    assertProjectedHostRequest(current);
  }
  assert.deepEqual(projectHostRequestForTask(enrichedAgain), projectHostRequestForTask(enriched));
  checked.push("actual_direct_enrich_twice_rebuilds_evidence", "final_metadata_covers_complete_strategy_packet");

  for (const [kind, origin, mode] of [
    ["hard_data_query", "cruise_no_big_data", "cruise"],
    ["daily_core_theory_query", "daily_no_big_data", "daily_chat"],
  ]) {
    const request = { ...service.buildDirectHostRequest("hello", mode), request_kind: kind, origin_action_id: origin, evidence_policy_id: "active_core_profile_only" };
    let current = poison(request);
    for (let pass = 0; pass < 2; pass += 1) {
      current = await service.enrichHostRequestWithRuntimeContext(current, mode);
      assertNoStale(current);
      assert.equal(current.origin_action_id, origin);
      assert.equal(current.evidence_policy_id, "active_core_profile_only");
      assert.deepEqual(current.expected_response_shape, request.expected_response_shape);
      assert.equal(current.runtime_context.context_policy.hard_data_only, true);
      assert.equal(current.runtime_context.context_policy.include_daily_big_data, false);
      assert.equal(current.daily_big_data, undefined);
      assert.equal(current.strategy_wiki_context, undefined);
      assertProjectedHostRequest(current);
    }
  }
  checked.push("actual_core_only_and_daily_core_enrich_twice_preserve_source_policy");

  const popular = { ...service.buildDirectHostRequest("hello", "cruise"), request_kind: "popular_recipe_query", origin_action_id: "cruise_popular_recipe_query", evidence_policy_id: "popular_recipe_catalog_only" };
  const popularEnriched = await service.enrichHostRequestWithRuntimeContext(poison(popular), "cruise");
  const popularAgain = await service.enrichHostRequestWithRuntimeContext(popularEnriched, "cruise");
  assertNoStale(popularAgain);
  assert.deepEqual(popularAgain, popularEnriched, "popular isolation instructions must not grow on re-enrichment");
  assert.equal(popularAgain.runtime_context.popular_recipe_query_context.strength_authority, false);
  assert.equal(popularAgain.runtime_context.match_facts, undefined);
  assert.equal(popularAgain.runtime_context.strategy_evidence_plan, undefined);
  assertProjectedHostRequest(popularAgain);
  checked.push("actual_popular_enrich_twice_isolated_and_idempotent");

  for (const mode of ["augment_choice", "lineup_card"]) {
    const request = service.buildDirectHostRequest("hello", mode, null, { lineupConfirmationRequested: true });
    request.choices = { kind: "augment", candidates: ["A", "B", "C"], source: "current_match_user_report" };
    request.current_match_user_report = { report_id: "sealed-card", revision: 2 };
    const current = await service.enrichHostRequestWithRuntimeContext(poison(request), mode);
    assertNoStale(current);
    assert.deepEqual(current.choices, request.choices);
    assert.deepEqual(current.current_match_user_report, request.current_match_user_report);
    assert.deepEqual(current.expected_response_shape, request.expected_response_shape);
    assert.equal(current.pinned_result_required, mode === "lineup_card");
    assert.equal(current.lineup_confirmation_requested, request.lineup_confirmation_requested);
    assertProjectedHostRequest(current);
  }
  const textOnly = projectHostRequestForTask(service.buildDirectHostRequest("hard_data_query match_fact_capture popular_recipe_query", "cruise"));
  assert.equal(textOnly.request_kind, undefined);
  assert.equal(textOnly.evidence_policy_id, undefined);
  assert.equal(service.resolveRuntimeContextPolicy("cruise", textOnly).hard_data_only, false);
  checked.push("actual_choice_and_lineup_authority_preserved", "visible_text_never_grants_source_or_fact_authority");
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ ok: true, schema: "jcc-host-task-projection-verifier-v1", checked }, null, 2)}\n`);
