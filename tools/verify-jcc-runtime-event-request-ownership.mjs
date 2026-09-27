#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requestPendingHostCoach } from "../ui/electron/runtime-service.js";
import {
  persistPipelineResult,
  runPipeline,
} from "./run-jcc-cruise-runtime-pipeline.mjs";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-event-owner-"));

async function runPipelineInMemory(options) {
  const result = await runPipeline(options);
  await persistPipelineResult(result, options);
  return result;
}

async function main() {
  const liveStateFile = path.join(tempRoot, "live-state.json");
  const contextFile = path.join(tempRoot, "context.json");
  const adviceStateFile = path.join(tempRoot, "advice-state.json");
  const outFile = path.join(tempRoot, "pipeline.json");
  const runtimeEventContext = {
    schema: "jcc-runtime-event-followup-context-v1",
    event_key: "fixed_checkpoint:3-3:test",
    event_type: "line_decision_context_changed",
    event_category: "line_decision_context",
    stage_round: "3-3",
    decision_trigger_id: "direction_commit_or_exit",
    fixed_checkpoint_id: "post_3_2_narrowing",
    reason: "the registered 3-3 strategic checkpoint owns one merged Host response",
  };
  await writeFile(liveStateFile, `${JSON.stringify({
    schema: "jcc-live-state-v1",
    match_session_id: "verify-runtime-event-owner",
    phase: { stage_round: "3-3" },
    economy: { hp: 54, gold: 29, level: 6, xp: "8/20" },
    own_board: { units: [
      { name: "AlphaCarry", cost: 2, star: 2 },
      { name: "Frontline", cost: 2, star: 2 },
    ] },
    own_bench: { units: [
      { name: "AlphaCarry", cost: 2, star: 1 },
      { name: "Bench2", cost: 1, star: 1 },
      { name: "Bench3", cost: 1, star: 1 },
      { name: "Bench4", cost: 1, star: 1 },
      { name: "Bench5", cost: 1, star: 1 },
      { name: "Bench6", cost: 1, star: 1 },
      { name: "Bench7", cost: 1, star: 1 },
      { name: "Bench8", cost: 1, star: 1 },
    ] },
    shop: { units: [
      { name: "AlphaCarry", cost: 2, star: 1 },
      { name: "Frontline", cost: 2, star: 1 },
    ] },
    items: { item_bench: [{ name: "Sword" }, { name: "Bow" }], equipped_items: [] },
  }, null, 2)}\n`, "utf8");
  await writeFile(contextFile, `${JSON.stringify({
    target_plan: { name: "Alpha Line", unit_names: ["AlphaCarry", "Frontline"] },
    minimum_value_score_to_speak: 0.5,
  }, null, 2)}\n`, "utf8");

  const pipeline = await runPipelineInMemory({
    liveState: liveStateFile,
    context: contextFile,
    adviceState: adviceStateFile,
    out: outFile,
    mode: "cruise",
    forceResponseReason: "runtime_event:line_decision_context_changed:line_decision_context",
    runtimeEventContextJson: JSON.stringify(runtimeEventContext),
  });
  const scorerTasks = pipeline.score?.advice_tasks || [];
  const requests = (pipeline.response_events || []).filter((event) => event.type === "advice_response_requested");
  const recordedOnly = (pipeline.response_events || []).filter((event) => event.type === "advice_response_recorded_only");
  assert(scorerTasks.length >= 1, "the fixed checkpoint must produce at least one integrated strategic task");
  assert.equal(requests.length, 1, "one fixed strategic obligation must create only one Host request");
  const ownedRequests = requests.filter((event) => event.trigger_id === "runtime_event_followup");
  assert.equal(ownedRequests.length, 1, "one runtime event must produce exactly one event-owned Host request");
  assert.equal(
    ownedRequests[0].host_cli_agent_request?.context?.runtime_event_context?.event_key,
    runtimeEventContext.event_key,
    "the event-owned Host request must carry the exact semantic event focus",
  );
  assert(recordedOnly.every((event) => event.trigger_id !== "runtime_event_followup"), "the fixed strategic owner must not be downgraded to recorded-only evidence");
  assert.notEqual(requests.at(-1)?.trigger_id, undefined);

  const directAdviceStateFile = path.join(tempRoot, "direct-advice-state.json");
  const directOutFile = path.join(tempRoot, "direct-pipeline.json");
  const directPipeline = await runPipelineInMemory({
    liveState: liveStateFile,
    context: contextFile,
    adviceState: directAdviceStateFile,
    out: directOutFile,
    mode: "cruise",
    userMessage: "Should I slam the Sword now or wait?",
    forceResponseReason: "runtime_event:line_decision_context_changed:line_decision_context",
    runtimeEventContextJson: JSON.stringify(runtimeEventContext),
  });
  const directRequests = (directPipeline.response_events || []).filter((event) => event.type === "advice_response_requested");
  const directRecordedOnly = (directPipeline.response_events || []).filter((event) => event.type === "advice_response_recorded_only");
  assert.equal(directRequests.length, 1, "direct user message plus runtime event must still create only one Host request");
  assert.equal(
    directRequests[0]?.trigger_id,
    "user_message_response",
    "direct user message response must own the Host request before runtime_event_followup",
  );
  assert(
    directRecordedOnly.some((event) => event.trigger_id === "runtime_event_followup" && event.reason === "direct_user_message_response_owns_response"),
    "runtime_event_followup must be recorded_only when a direct user message owns the response",
  );
  const recordedOnlyPending = await requestPendingHostCoach(directOutFile, {
    preferredTriggerId: "runtime_event_followup",
    allowMissingPreferred: true,
  });
  assert.equal(recordedOnlyPending.ok, true);
  assert.equal(recordedOnlyPending.status, "preferred_host_request_recorded_only");
  assert.equal(recordedOnlyPending.request, null);
  const strictMissingPending = await requestPendingHostCoach(directOutFile, {
    preferredTriggerId: "runtime_event_followup",
  });
  assert.equal(strictMissingPending.ok, false, "callers that did not opt into recorded-only outcomes must still fail closed");
  assert.equal(strictMissingPending.status, "no_matching_preferred_host_request");

  const activeModeLiveStateFile = path.join(tempRoot, "active-mode-live-state.json");
  const activeModeContextFile = path.join(tempRoot, "active-mode-context.json");
  const activeModeAdviceStateFile = path.join(tempRoot, "active-mode-advice-state.json");
  const activeModeOutFile = path.join(tempRoot, "active-mode-pipeline.json");
  await writeFile(activeModeLiveStateFile, `${JSON.stringify({
    schema: "jcc-live-state-v1",
    match_session_id: "verify-active-mode-owner",
    phase: { stage_round: "3-2" },
    economy: { hp: 54, gold: 29, level: 6, xp: "8/20" },
    own_board: { units: [{ name: "AlphaCarry", cost: 2, star: 2 }] },
    shop: { units: [{ name: "AlphaCarry", cost: 2, star: 1 }] },
    items: { item_bench: [{ name: "Sword" }, { name: "Bow" }, { name: "fixture-emblem-a" }] },
    augments: {
      current_choice_set: {
        source: "choice_text_ocr",
        choices: [
          { name: "augment-a", confidence: 0.9 },
          { name: "augment-b", confidence: 0.9 },
          { name: "augment-c", confidence: 0.9 },
        ],
      },
    },
  }, null, 2)}\n`, "utf8");
  await writeFile(activeModeContextFile, `${JSON.stringify({
    match_context: {
      match_session_id: "verify-active-mode-owner",
      reported_choice_sets_by_mode: {
        augment_choice: {
          schema: "jcc-runtime-user-reported-choice-set-v1",
          mode: "augment_choice",
          kind: "augment",
          match_session_id: "verify-active-mode-owner",
          choice_stage_round: "3-2",
          revision: 1,
          source: "current_match_user_report",
          expected_candidate_count: 3,
          candidates: [
            { name: "augment-a", slot: 1 },
            { name: "augment-b", slot: 2 },
            { name: "augment-c", slot: 3 },
          ],
          current_match_only: true,
        },
      },
    },
  }, null, 2)}\n`, "utf8");
  const activeModePipeline = await runPipelineInMemory({
    liveState: activeModeLiveStateFile,
    context: activeModeContextFile,
    adviceState: activeModeAdviceStateFile,
    out: activeModeOutFile,
    mode: "augment_choice",
    forceResponseReason: "explicit_structured_augment_card_advice",
    runtimeEventContextJson: JSON.stringify({
      schema: "jcc-runtime-event-followup-context-v1",
      event_key: "structured_card_advice:augment_choice:3-2:verify",
      event_type: "reported_choices_changed",
      event_category: "choice_advice",
      stage_round: "3-2",
      decision_trigger_id: "augment_choice_advice",
      explicit_user_card_action: true,
      user_message_kind: "structured_choice_advice",
      advice_action: "choice_advice",
    }),
  });
  const activeModeRequests = (activeModePipeline.response_events || []).filter((event) => event.type === "advice_response_requested");
  const activeModeRecordedOnly = (activeModePipeline.response_events || []).filter((event) => event.type === "advice_response_recorded_only");
  assert.equal(activeModeRequests.length, 1, "active explicit mode must create at most one Host request");
  assert.equal(activeModeRequests[0]?.trigger_id, "runtime_event_followup", "the explicit structured augment-card action must own the one Host request");
  assert(
    activeModeRecordedOnly.every((event) => event.trigger_id !== "runtime_event_followup"),
    "the explicit structured-card owner must not be downgraded to recorded_only",
  );

  console.log(JSON.stringify({
    ok: true,
    scorer_task_count: scorerTasks.length,
    request_count: requests.length,
    owned_trigger: ownedRequests[0].trigger_id,
    checked: [
      "multiple scorer tasks can coexist as evidence",
      "only one Host request is generated",
      "runtime event has exactly one owned Host request",
      "owned request carries exact semantic event focus",
      "direct user message owns before runtime event follow-up",
      "recorded-only runtime follow-up closes cleanly only for the explicit automatic caller",
      "runtime event follow-up owns before scorer siblings",
      "explicit structured-card action owns before ordinary proactive tasks",
    ],
  }, null, 2));
}

main()
  .finally(() => rm(tempRoot, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
