import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildProactiveCoachContentAgenda,
  captureResponseTaskOwner,
  configureRuntimeServicePaths,
  detectRuntimeSemanticEvents,
  handleRuntimeAction,
  responseTaskOwnerStillCurrent,
  setRuntimeServiceCanonicalStateWriter,
  setRuntimeServiceState,
} from "../ui/electron/runtime-service.js";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-opening-choice-integration-"));

try {
  configureRuntimeServicePaths({ dataRoot: tempRoot });
  setRuntimeServiceCanonicalStateWriter(async (snapshot) => ({ ok: true, state: snapshot }));
  setRuntimeServiceState({
    schema: "jcc-ui-runtime-state-v1",
    match_session: {
      status: "active",
      match_session_id: "match-opening-choice-test",
    },
    match_connection: { status: "connected_to_live_match" },
    active_mode: "manual_match_variables",
    match_context: {
      schema: "jcc-runtime-ui-match-context-v1",
      match_session_id: "match-opening-choice-test",
      latest_authoritative_facts: {
        match_session_id: "match-opening-choice-test",
        stage_round: "1-2",
      },
    },
    response_task: { status: "idle", response_task_id: null, revision: 0 },
    response_task_revision: 0,
    runtime_event_advice: { handled: {}, retry_pending: {}, last_by_category: {}, last_by_trigger: {} },
    runtime_triggers: { visual_by_stage: {} },
    host_cli: { provider: "codex", available: false },
    host_sessions: { daily: { status: "idle" }, match: { status: "idle" } },
  });

  const savedVariables = await handleRuntimeAction("saveManualVariables", {
    seasonVariables: {
      encounter: "verify_encounter",
      god_options: ["verify_god_a", "verify_god_b"],
      stargazing: "verify_observer",
    },
  });
  assert.equal(savedVariables.ok, true);
  assert.equal(savedVariables.event?.type, "match_variables_changed");
  assert.equal(savedVariables.event?.advice_eligible, false, "manual variables must be fact-only and must not open a Host lane");
  assert.equal(savedVariables.event?.response_policy, "context_only", "manual variables must wait for the first 2-1 user-owned answer");
  assert.equal(savedVariables.state.response_task?.status, "idle", "manual variables must leave the current answer lane idle");
  assert.match(savedVariables.message || "", /2-1.*强化建议/, "confirmation text must explain where opening judgment will be merged");

  setRuntimeServiceState({
    ...savedVariables.state,
    runtime_event_detector: {
      schema: "jcc-runtime-event-detector-v1",
      last_snapshot: {
        stage_round: "1-2",
        match_variables_hash: null,
      },
    },
  });
  const observedEvents = detectRuntimeSemanticEvents({
    schema: "jcc-live-state-v1",
    match_session_id: "match-opening-choice-test",
    phase: { stage_round: "1-2", status: 1 },
    economy: {},
    own_board: { units: [] },
    own_bench: { units: [] },
    shop: { units: [] },
    items: {},
  }, { match_context: savedVariables.state.match_context });
  const observedVariableEvent = observedEvents.find((event) => event.type === "match_variables_changed");
  assert(observedVariableEvent, "semantic observation must retain the confirmed variable change");
  assert.equal(observedVariableEvent.advice_eligible, false, "semantic observation must not resurrect a separate opening Host task");
  assert.equal(observedVariableEvent.response_policy, "context_only");

  const owner = {
    response_task_id: "task-opening-choice",
    match_session_id: "match-opening-choice-test",
    mode: "cruise",
    origin: "runtime_event",
    event_key: "opening-event",
    revision: 1144,
  };
  assert.equal(responseTaskOwnerStillCurrent({
    status: "running",
    response_task_id: owner.response_task_id,
    match_session_id: owner.match_session_id,
    mode: owner.mode,
    origin: owner.origin,
    event_key: owner.event_key,
    revision: 1145,
  }, owner, owner.match_session_id), true, "ordinary canonical revision advancement must not discard the same Host answer owner");
  assert.equal(responseTaskOwnerStillCurrent({
    status: "cancelling",
    response_task_id: owner.response_task_id,
    match_session_id: owner.match_session_id,
    mode: owner.mode,
    origin: owner.origin,
    event_key: owner.event_key,
    revision: 1145,
  }, owner, owner.match_session_id), false, "a cancelled owner must still reject a late Host result");
  assert.equal(responseTaskOwnerStillCurrent({
    status: "running",
    response_task_id: "replacement-task",
    match_session_id: owner.match_session_id,
    mode: owner.mode,
    origin: owner.origin,
    event_key: owner.event_key,
    revision: 1145,
  }, owner, owner.match_session_id), false, "a replacement task must reject the old Host result");
  assert.equal(responseTaskOwnerStillCurrent({
    status: "running",
    response_task_id: owner.response_task_id,
    match_session_id: "replacement-match",
    mode: owner.mode,
    origin: owner.origin,
    event_key: owner.event_key,
    revision: 1145,
  }, owner, "replacement-match"), false, "a new match must fence the old Host result even when the task id is accidentally reused");
  assert.equal(responseTaskOwnerStillCurrent({
    status: "running",
    response_task_id: owner.response_task_id,
    match_session_id: owner.match_session_id,
    mode: owner.mode,
    origin: owner.origin,
    event_key: "replacement-event",
    revision: 1145,
  }, owner, owner.match_session_id), false, "a same-id task with a different semantic event owner must reject the old Host result");
  assert.equal(responseTaskOwnerStillCurrent({
    status: "running",
    response_task_id: "unbound-owner-task",
    match_session_id: owner.match_session_id,
    mode: "augment_choice",
    origin: "runtime_event",
    event_key: "late-binding-event",
    revision: 1145,
  }, {
    response_task_id: "unbound-owner-task",
    match_session_id: owner.match_session_id,
    mode: null,
    origin: null,
    event_key: null,
    revision: 1144,
  }, owner.match_session_id), false, "null owner fields must not act as wildcards when a task is later relabeled");

  setRuntimeServiceState({
    ...savedVariables.state,
    active_mode: "cruise",
    response_task: {
      status: "running",
      response_task_id: owner.response_task_id,
      match_session_id: owner.match_session_id,
      mode: owner.mode,
      origin: owner.origin,
      event_key: owner.event_key,
      revision: owner.revision,
    },
  });
  const capturedOwner = captureResponseTaskOwner(owner.response_task_id, owner.mode, owner.match_session_id);
  assert.deepEqual(capturedOwner, owner, "the production owner capture path must preserve every identity field used by freshness checks");
  for (const [field, value] of [["mode", "augment_choice"], ["origin", "user"], ["event_key", "replacement-event"]]) {
    assert.equal(responseTaskOwnerStillCurrent({
      ...savedVariables.state.response_task,
      status: "running",
      response_task_id: owner.response_task_id,
      match_session_id: owner.match_session_id,
      mode: owner.mode,
      origin: owner.origin,
      event_key: owner.event_key,
      revision: owner.revision + 1,
      [field]: value,
    }, capturedOwner, owner.match_session_id), false, `${field} changes must detach the captured owner`);
  }

  const firstAugmentAgenda = buildProactiveCoachContentAgenda({
    type: "reported_choices_changed",
    source_mode: "augment_choice",
    stage_round: "2-1",
  }, { category: "choice_advice" }, {
    phase: { stage_round: "2-1" },
  });
  assert.equal(firstAugmentAgenda.opening_judgment_merge, true, "the first augment answer must absorb opening-variable judgment");
  assert(firstAugmentAgenda.required_decisions.includes("rank_current_augment_choices_and_refresh_decision"));
  assert(!firstAugmentAgenda.required_decisions.includes("rank_two_or_three_candidate_lines_from_augments_items_units_and_rankings"), "pre-selection advice must not prematurely force lineup candidates");
  for (const stageRound of ["2-1", "3-2", "4-2"]) {
    const agenda = buildProactiveCoachContentAgenda({
      type: "reported_choices_changed",
      source_mode: "augment_choice",
      stage_round: stageRound,
    }, { category: "choice_advice" }, {
      phase: { stage_round: stageRound },
    });
    assert(
      agenda.required_decisions.includes("rank_current_augment_choices_and_refresh_decision"),
      `${stageRound} augment advice must include an explicit keep/refresh decision`,
    );
    assert.equal(agenda.opening_judgment_merge, stageRound === "2-1", "only the first augment absorbs opening judgment");
  }

  const cardSource = await readFile(path.resolve("ui/src/components/DecisionInputCard.tsx"), "utf8");
  assert(!cardSource.includes("只看当前选择"), "augment card must not expose the redundant choice-only advice button");
  assert(!cardSource.includes("整体获取建议"), "augment card must not expose a second whole-card advice button");
  assert.equal((cardSource.match(/>\s*获取建议\s*<\/button>/g) || []).length, 1, "augment card must expose exactly one unified advice action");
  assert(cardSource.includes('onClick={() => submitChoice()} disabled={busy !== null || !binding}'), "unified advice must remain available without waiting for equipment hydration");
  assert(!cardSource.includes("const submitChoice = async (includeEquipment: boolean"), "unified advice must not branch on whether context is visible to the Host");
  assert(cardSource.includes("...(equipmentHydrated ? {") && cardSource.includes("equipmentCategories.map((category) => category.key)"), "unified advice must atomically include the hydrated visible equipment snapshot when available");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "same_owner_survives_revision_advance",
      "cancelled_or_replaced_owner_rejects_late_result",
      "cross_match_or_event_owner_rejects_late_result",
      "null_owner_fields_are_not_wildcards",
      "captured_owner_identity_is_strict",
      "manual_variables_are_fact_only",
      "semantic_observer_cannot_resurrect_opening_task",
      "first_augment_absorbs_opening_judgment_without_premature_lineup_lock",
      "single_unified_augment_advice_action",
      "unified_advice_includes_optional_hydrated_equipment",
    ],
  }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
