import { readFile } from "node:fs/promises";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sliceBetween(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle);
  assert(start >= 0, `${label} missing start marker: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `${label} missing end marker: ${endNeedle}`);
  return source.slice(start, end);
}

async function main() {
  const service = await readFile("ui/electron/runtime-service.js", "utf8");
  const app = await readFile("ui/src/App.tsx", "utf8");
  const bridge = await readFile("ui/src/runtimeBridge.ts", "utf8");
  const preload = await readFile("ui/electron/preload.js", "utf8");
  const daemon = await readFile("ui/electron/runtime-daemon.js", "utf8");
  const uiModeContract = JSON.parse(await readFile("data/runtime/jcc/runtime-ui-mode-contract.json", "utf8"));
  const semanticAdmissionEntries = uiModeContract.cruise_mode_policy?.interrupt_policy?.semantic_event_admission_policy || [];
  const semanticAdmissionByCategory = Object.fromEntries(
    semanticAdmissionEntries.map((entry) => [entry.category, entry]),
  );
  const admittedSemanticEventTypes = new Set(
    semanticAdmissionEntries.flatMap((entry) => entry.event_types || []),
  );

  for (const needle of [
    "async function observeRuntimeTick()",
    "async function persistWatcherSourceObservation(summary, expectedMatchSessionId)",
    "event_type: \"watcher_observation\"",
    "jcc-runtime-watcher-source-cursor-v1",
    "detectRuntimeSemanticEvents(rawLiveState",
    "host_model_invoked: false",
    "fact_events_do_not_call_host_model: true",
    "advice_requires_event_gate: true",
    "runtime_semantic_event_detected",
    "function shouldStartAdviceForRuntimeEvent(event, liveState)",
    "function runtimeEventContextCategory(event, liveState)",
    "function runtimeEventAdviceCooldownMs(event, category)",
    "function runtimeEventAdvicePriority(category)",
    "function responseTaskRuntimeEventPriority(task = state.response_task)",
    "startRuntimeEventAdvice(event, rawLiveState, activeLiveState)",
    "choice_window_reserved_for_user_report",
    "confirmed_choices_changed",
    "latest_user_intent_changed",
    "item_material_changed",
    "equipment_fit_changed",
    "board_bench_material_changed",
    "bench_capacity_pressure",
    "line_decision_context_available",
    "shop_decision_context_changed",
    "line_decision_context_changed",
    "streak_decision_context_changed",
    "function buildRuntimeProactiveDecisionSignal",
    "function runtimeEventIsRawMaterialFactEvent(event)",
    "raw_material_fact_event",
    "event_trigger_cooldown",
    "event_category_cooldown",
    "event_already_handled",
    "last_by_category",
    "last_by_trigger",
    "matchChoiceConfirmationsFingerprint(matchContext)",
    "confirmed choice facts are already present on the first semantic snapshot",
    "latestUserIntentFingerprint(matchContext)",
    "latestUserIntentShouldTriggerRuntimeAdvice(latest)",
    "mergedStringArray(latest.tags, latest.intent_tags)",
    "itemMaterialSnapshot(summary, matchContext?.user_confirmed_equipment || null)",
    "boardBenchMaterialSnapshot(summary)",
    "selected: entry.selected || null",
    "const lineUnitFingerprint = (unit) => {",
    "context.strategy_fit_packet = buildStrategyFitPacket({",
    "jcc-strategy-fit-packet-v1",
    "prior_and_candidate_generator_not_command",
    "function buildEconomicDecisionContext({ liveStateSummary, matchFacts, selectedRankingCandidates })",
    "jcc-economic-decision-context-v1",
    "function compactEconomyRulesForDecision(rulesBundle = activeRulesBundle)",
    "economy_management_context",
    "economic_decision_context",
    "function economicDecisionAdviceEligible(snapshot, previous, context)",
    "economic_decision_context_changed",
    "economy_management_context",
    "retryableRuntimeEventAdviceEvents(rawLiveState)",
    "runtime_event_advice_retry_registered",
    "host_coach_response_pending_timeout_reconciled",
    "reconcilePendingHostCoachResponseTask(\"observe_runtime_tick\")",
    "startMatchOcrWarmupWorkers(\"start_match\")",
    "start_match_ocr_warmup",
    "\"tools/run-jcc-host-coach-response.mjs\"",
    "function reconcileRuntimeEventAdviceRunningTasks",
    "runtime_event_advice_running_tasks_reconciled",
    "async function runManualSelfStateRefreshForUserMessage",
    "messageRequestsSelfStateRefresh(text)",
    "generated_by: \"jcc_runtime_manual_self_state_refresh\"",
    "noVisualFallback: true",
    "self_state_roi_ocr_failed_no_visual_fallback",
    "function hasKnownRuntimeValue(value)",
    "function hasEconomyLiveEvidence(economy)",
    "function hasItemLiveEvidence(items)",
    "function hasAugmentLiveEvidence(augments)",
    "function hasPhaseLiveEvidence(phase)",
    "currentChoiceSetEntries(augments)",
    "async function runRuntimeEventAdvicePipelineInBackground",
    "async function transitionOwnedRuntimeEventTask",
    "function responseTaskStillOwnedAtRevision",
    "status: \"preparing\"",
    "event_priority: eventPriority",
    "source: \"runtime_event_response_task_preparing\"",
    "status: \"response_preparing\"",
    "preemptRuntimeEventForHigherPrioritySemanticEvents(adviceEligibleEvents, rawLiveState)",
  ]) {
    assert(service.includes(needle), `runtime-service.js missing observe-only event contract: ${needle}`);
  }
  const startBackgroundRefreshBody = service.slice(
    service.indexOf("function startBackgroundSelfStateRefresh"),
    service.indexOf("async function continuePendingVisualToAdvice"),
  );
  assert(startBackgroundRefreshBody.includes("noVisualFallback: true"), "background self-state refresh must not use slow host-vision fallback and steal the host response lane");
  assert(service.includes("next_coach_plan: nextCoachPlan"), "strategy_fit_packet must include a next_coach_plan evidence packet for proactive cruise coaching");
  const observeBody = sliceBetween(
    service,
    "async function observeRuntimeTick()",
    "async function stopResponse(payload = {})",
    "observeRuntimeTick body",
  );
  assert(observeBody.includes("const retryAdviceEvents = retryableRuntimeEventAdviceEvents(rawLiveState);"), "observeRuntimeTick must retry advice-eligible events that were skipped for transient gates");
  assert(observeBody.includes("const adviceEventsByKey = new Map();"), "observeRuntimeTick must de-duplicate fresh and retry advice events by event key");
  assert(observeBody.includes("semanticEvents.filter((entry) => entry.advice_eligible)"), "observeRuntimeTick must only consider advice-eligible semantic events for advice");
  assert(observeBody.includes("startRuntimeEventAdvice(event, rawLiveState, activeLiveState)"), "observeRuntimeTick must route model work through the semantic event advice gate");
  assert(observeBody.includes('adviceStart.status === "response_preparing"'), "observeRuntimeTick must return immediately after a durable automatic preparing task is created");
  assert(observeBody.includes('status: "response_failed_ready"'), "observeRuntimeTick must report failed responses as delivery-ready instead of consuming them");
  assert(!observeBody.includes("runtime.pollCruiseAdvice()"), "observeRuntimeTick must not reuse the old cruise polling path");
  assert(
    observeBody.indexOf("detectRuntimeSemanticEvents(rawLiveState") < observeBody.indexOf('reconcileRunningHostCoachResponseTask("observe_runtime_tick")'),
    "observeRuntimeTick must absorb live facts and detect semantic events before returning for a running response task",
  );
  assert(
    observeBody.indexOf("preemptRuntimeEventForHigherPrioritySemanticEvents(adviceEligibleEvents, rawLiveState)") < observeBody.indexOf('reconcileRunningHostCoachResponseTask("observe_runtime_tick")'),
    "higher-priority semantic events must get a preemption decision before the in-flight response gate returns",
  );
  const detectorCommitBody = service.slice(
    service.indexOf("state.runtime_event_detector = {", service.indexOf("function detectRuntimeSemanticEvents")),
    service.indexOf("return events.map(runtimeEventPush)", service.indexOf("function detectRuntimeSemanticEvents")),
  );
  assert(detectorCommitBody.includes("...(state.runtime_event_detector || {})"), "semantic detection must preserve the watcher source cursor while updating last_snapshot");
  const observeFailedReadyBlock = observeBody.slice(
    observeBody.indexOf('if (state.response_task?.status === "failed"'),
    observeBody.indexOf('const runningReconciled = await reconcileRunningHostCoachResponseTask("observe_runtime_tick")'),
  );
  assert(!observeFailedReadyBlock.includes("delivered_at:"), "observeRuntimeTick must not mark failed response tasks delivered; deliverReadyResponse owns delivery");
  assert(!observeFailedReadyBlock.includes("response_task_id: null"), "observeRuntimeTick must not clear failed response task ids before delivery");
  const liveStateEvidenceBody = service.slice(
    service.indexOf("function liveStateEvidenceSummary"),
    service.indexOf("async function readCurrentLiveStateSummary"),
  );
  assert(liveStateEvidenceBody.includes("hasPhaseLiveEvidence(liveStateSummary.phase)"), "live_state evidence summary must use strict phase evidence, not object presence");
  assert(liveStateEvidenceBody.includes("hasEconomyLiveEvidence(liveStateSummary.economy)"), "live_state evidence summary must use strict HUD economy evidence");
  assert(liveStateEvidenceBody.includes("hasItemLiveEvidence(liveStateSummary.items)"), "live_state evidence summary must use primary 4357/trusted 4356 item evidence");
  assert(liveStateEvidenceBody.includes("hasAugmentLiveEvidence(liveStateSummary.augments)"), "live_state evidence summary must use real selected/current choice augment evidence");
  const matchConnectionBody = service.slice(
    service.indexOf("function updateMatchConnectionFromLiveState"),
    service.indexOf("async function readCurrentLiveStateSummary"),
  );
  assert(matchConnectionBody.includes("hasPhaseLiveEvidence(phase)"), "match connection must use strict phase evidence");
  assert(matchConnectionBody.includes("hasEconomyLiveEvidence(liveStateSummary.economy)"), "match connection must not connect on empty economy object");
  assert(!matchConnectionBody.includes("hasItemLiveEvidence(liveStateSummary.items)"), "match connection must not connect from items alone; items are evidence only after stage/HUD anchor");
  assert(!matchConnectionBody.includes("hasAugmentLiveEvidence(liveStateSummary.augments)"), "match connection must not connect from choice/augment evidence alone; choice facts are not a stage/HUD anchor");
  assert(!matchConnectionBody.includes("liveStateSummary.own_board?.units?.length"), "match connection must not connect from board units alone when stage/HUD facts are missing");
  assert(!matchConnectionBody.includes("liveStateSummary.own_bench?.units?.length"), "match connection must not connect from bench units alone when stage/HUD facts are missing");
  assert(!matchConnectionBody.includes("liveStateSummary.shop?.units?.length"), "match connection must not connect from shop units alone when stage/HUD facts are missing");
  assert(!matchConnectionBody.includes("hasUsefulObjectFields(liveStateSummary.economy)"), "match connection must not use generic object-presence economy evidence");
  assert(!matchConnectionBody.includes("hasUsefulObjectFields(liveStateSummary.items)"), "match connection must not use generic object-presence item evidence");
  assert(!matchConnectionBody.includes("hasUsefulObjectFields(liveStateSummary.augments)"), "match connection must not use generic object-presence augment evidence");
  const phaseEvidenceBody = service.slice(
    service.indexOf("function hasPhaseLiveEvidence"),
    service.indexOf("function firstUsefulValue"),
  );
  assert(!phaseEvidenceBody.includes("phase.status"), "MuMu S/status alone is view diagnostic and must not connect a live match without stage/round evidence");
  assert(!phaseEvidenceBody.includes("phase.status_name"), "phase status_name alone is not enough to connect a live match");
  assert(phaseEvidenceBody.includes("stage > 0") && phaseEvidenceBody.includes("round > 0"), "numeric stage/round evidence must reject zero/default placeholders");
  const runtimeEventAdviceBody = service.slice(
    service.indexOf("async function startRuntimeEventAdvice"),
    service.indexOf("async function observeRuntimeTick()"),
  );
  const runtimeEventPipelineBody = service.slice(
    service.indexOf("async function runRuntimeEventAdvicePipelineInBackground"),
    service.indexOf("async function startRuntimeEventAdvice"),
  );
  const hostCoachCompletionBody = service.slice(
    service.indexOf("async function completePendingHostCoach"),
    service.indexOf("async function runHostCoachForPipeline"),
  );
  assert(
    hostCoachCompletionBody.includes("pending.request_event?.type === \"advice_response_requested\"")
      && hostCoachCompletionBody.includes("normalizeAdviceResponseRequestEvent(immutableRequestEvent")
      && hostCoachCompletionBody.includes("hostCliAgentRequest: hostRequestOverride || immutableRequestEvent.host_cli_agent_request || pending.request")
      && hostCoachCompletionBody.includes("isValidatedHostResponse(agentResponse, requestEvent.host_cli_agent_request)")
      && !hostCoachCompletionBody.includes("request_id: immutableHostRequest.request_id"),
    "host response merge must preserve the executed task identity rather than restoring an earlier pipeline identity",
  );
  assert(runtimeEventPipelineBody.includes("if (completed?.ok === false)"), "runtime-event host response merge failures must not be marked as completed responses");
  assert(runtimeEventPipelineBody.includes('completed.error || "host coach response merge failed"'), "runtime-event merge failure must preserve the merge error for UI/debugging");
  assert(runtimeEventPipelineBody.includes('status: "failed"') && runtimeEventPipelineBody.includes("transitionOwnedRuntimeEventTask"), "runtime-event merge failure must persist a failed response_task through the owned transition helper");
  assert(runtimeEventAdviceBody.includes('status: "preparing"'), "runtime-event gate must create a preparing response task before pipeline execution");
  assert(runtimeEventAdviceBody.includes("await persistStateAndCanonicalResponseTask({"), "runtime-event preparing task must be canonical before detached work starts");
  assert(runtimeEventAdviceBody.indexOf("await persistStateAndCanonicalResponseTask({") < runtimeEventAdviceBody.indexOf("void runRuntimeEventAdvicePipelineInBackground({"), "canonical preparing persistence must precede detached pipeline launch");
  assert(!runtimeEventAdviceBody.includes('await runNodeTool("tools/run-jcc-cruise-runtime-pipeline.mjs"'), "startRuntimeEventAdvice must not synchronously block on the cruise pipeline");
  assert(runtimeEventPipelineBody.includes("runRuntimePipelineInProcess({"), "detached continuation must own in-process cruise pipeline execution");
  assert(runtimeEventPipelineBody.includes("responseTaskStillOwnedAtRevision(owner)"), "every detached pipeline phase must enforce task/session/revision ownership");
  assert(runtimeEventPipelineBody.includes('? "awaiting_host_cli_agent_response"') && runtimeEventPipelineBody.includes("status: nextStatus"), "disabled host execution must transition the durable task from preparing to awaiting");
  assert(!service.includes('if (["1-2", "1-3"].includes(stage)) return "opening_low_frequency";'), "1-2 and 1-3 must not retain a legacy automatic Host category");
  assert(service.includes('if (isCruiseFixedCheckpointStage(stage)) return "fixed_checkpoint";'), "only registered fixed checkpoints may open the proactive strategic Host lane");
  assert(!service.includes('if (stage === "1-4") return "opening_checkpoint";'), "1-4 must not retain a legacy opening Host checkpoint");
  assert(service.indexOf('if (shouldQuietCruiseForUpcomingChoice({ phase: { stage_round: stage } })) return "choice_quiet_window";') < service.indexOf('if (isCruiseFixedCheckpointStage(stage)) return "fixed_checkpoint";'), "the upcoming choice quiet window must be checked before fixed strategic checkpoints");
  assert(service.includes('if (!event?.advice_eligible) return { ok: false, reason: "event_not_advice_eligible" };'), "event advice gate must reject non-advice events");
  assert(service.includes("function runtimeEventIsInteractionContextOnly(event)"), "interaction context events must share one response-ownership gate");
  assert(service.includes('expired_reason: "interaction_context_only"'), "legacy interaction-context retries must be expired during migration");
  assert(service.includes('reason: "interaction_context_only"'), "interaction-context events must never start an automatic advice task");
  assert(
    service.includes("semanticAdmissionPolicy?.opens_host_answer === false")
      && service.includes('reason: "semantic_category_does_not_open_host_answer"'),
    "event advice gate must enforce the machine contract before a context-only category can open the Host lane",
  );
  assert(
    semanticAdmissionByCategory.choice_window?.opens_host_answer === false
      && semanticAdmissionByCategory.choice_quiet_window?.opens_host_answer === false,
    "choice windows must remain contract-declared context-only so manual/OCR paths own them",
  );
  assert(admittedSemanticEventTypes.has("confirmed_choices_changed") && semanticAdmissionByCategory.confirmed_choice_context, "confirmed choices must have a contract-backed advice category");
  assert(!admittedSemanticEventTypes.has("latest_user_intent_changed"), "latest user intent is owned by the direct response task and must not open a second cruise advice category");
  assert(!admittedSemanticEventTypes.has("target_plan_changed"), "target-plan mutations must remain selected context instead of opening an automatic response lane");
  assert(!admittedSemanticEventTypes.has("item_material_changed"), "item material changes must not have a direct host-advice category");
  assert(admittedSemanticEventTypes.has("equipment_fit_changed") && semanticAdmissionByCategory.equipment_fit_context?.opens_host_answer === false, "derived equipment-fit changes must remain selected evidence until a fixed checkpoint or explicit equipment-advice action owns the answer");
  assert(admittedSemanticEventTypes.has("shop_decision_context_changed") && semanticAdmissionByCategory.shop_decision_context?.opens_host_answer === false, "derived shop decisions must remain fact evidence");
  assert(admittedSemanticEventTypes.has("line_decision_context_changed") && semanticAdmissionByCategory.line_decision_context?.opens_host_answer === false, "derived lineup decisions must enter the persistent fixed-checkpoint obligation instead of opening an independent answer");
  assert(admittedSemanticEventTypes.has("streak_decision_context_changed") && semanticAdmissionByCategory.streak_decision_context?.opens_host_answer === false, "derived streak decisions must remain fact evidence");
  assert(!admittedSemanticEventTypes.has("board_bench_material_changed"), "board/bench material changes must not have a direct host-advice category");
  assert(admittedSemanticEventTypes.has("bench_capacity_pressure") && semanticAdmissionByCategory.bench_pressure, "bench pressure must have a contract-backed advice category");
  assert(service.includes("runtimeSemanticEventPolicyByType.get(event?.type || \"\")"), "runtime event category lookup must consume the machine admission contract");
  assert(
    service.includes('if (runtimeEventIsRawMaterialFactEvent(event))')
      && service.includes('reason: "raw_material_fact_event"'),
    "raw material fact events must be rejected before advice eligibility so old retry/current events cannot occupy the host response lane",
  );
  assert(
    service.includes("if (runtimeEventIsRawMaterialFactEvent(retry.event))")
      && service.includes('expired_reason: "raw_material_fact_event"'),
    "old raw material fact retry entries must be pruned instead of being retried forever",
  );
  assert(
    service.includes('preemptActiveRuntimeEventResponseTask("higher_priority_runtime_event"')
      && service.includes("incoming_event_category: category")
      && service.includes("active_priority: activePriority"),
    "higher-priority runtime events must be able to preempt lower-priority runtime-event host tasks",
  );
  assert(
    service.includes("function preemptStaleRuntimeEventResponseTask(liveState)")
      && service.includes('preemptActiveRuntimeEventResponseTask("runtime_event_context_expired"')
      && service.includes('source: "observe_runtime_tick_stale_event_preemption"'),
    "a stage/fingerprint-expired automatic task must release the Host lane before new semantic priority is evaluated",
  );
  assert(semanticAdmissionByCategory.choice_window?.priority === 100 && semanticAdmissionByCategory.choice_quiet_window?.priority === 100, "choice-stage events must outrank opening advice so the host lane is released at choice windows");
  assert(service.includes('task.status === "preparing"'), "preemption must treat pipeline-preparing automatic tasks as active runtime-event work");
  assert(
    service.includes("incomingPriority < 80")
      && service.includes("nowMs - globalLastStartedMs < AUTO_RUNTIME_EVENT_ADVICE_MIN_INTERVAL_MS"),
    "high-priority user/choice/variable events must not be blocked by the global low-frequency runtime-event cooldown",
  );
  assert(admittedSemanticEventTypes.has("economic_decision_context_changed") && semanticAdmissionByCategory.economy_management_context?.opens_host_answer === false, "derived economic decision changes must remain fixed-checkpoint evidence rather than opening an independent answer");
  assert(semanticAdmissionByCategory.confirmed_choice_context?.cooldown_seconds === 5, "confirmed choice context should have a short cooldown");
  assert(!semanticAdmissionByCategory.item_material_context, "item material facts should not use cooldowned host advice; they are selected-context evidence");
  assert(semanticAdmissionByCategory.equipment_fit_context?.cooldown_seconds === 45, "derived equipment-fit advice must use a long cooldown");
  assert(semanticAdmissionByCategory.shop_decision_context?.cooldown_seconds === 45, "derived shop decisions must use a long cooldown instead of speaking on every refresh");
  assert(semanticAdmissionByCategory.line_decision_context?.cooldown_seconds === 60, "derived lineup decisions must use a long cooldown");
  assert(semanticAdmissionByCategory.streak_decision_context?.cooldown_seconds === 45, "derived streak decisions must use a long cooldown");
  assert(!semanticAdmissionByCategory.line_material_context, "board/bench material facts should not use cooldowned host advice; they are selected-context evidence");
  assert(semanticAdmissionByCategory.economy_management_context?.cooldown_seconds === 60, "economy management context must have a long cooldown to avoid gold-threshold spam");
  assert(semanticAdmissionByCategory.bench_pressure?.cooldown_seconds === 30, "bench pressure should be cooldowned to avoid repeated full-bench nagging");
  assert(service.includes('if (tags.has("choice_question")) return false;'), "choice questions must not echo-trigger background cruise advice");
  assert(service.includes('if (String(latest.mode || "") === "refresh_self_state") return false;'), "refresh self-state messages must not trigger background cruise advice");
  assert(service.includes('"lineup_intent"') && service.includes('"tempo_economy_intent"'), "only strategy-bearing user intent tags should trigger runtime advice");
  assert(service.includes("function mergedStringArray(...values)"), "latest user intent must merge tags and intent_tags instead of trusting one field");
  assert(!service.includes("tags: firstArray(latest.tags, latest.intent_tags)"), "latest user intent must not let an empty tags array hide intent_tags");
  const startMatchBody = service.slice(
    service.indexOf("async function startMatch()"),
    service.indexOf("async function stopMatch()"),
  );
  const resetMatchBody = service.slice(
    service.indexOf("function resetMatchScopedRuntimeState"),
    service.indexOf("function stopMatchStateForCleanRuntimeShutdown"),
  );
  const clearMatchFilesBody = service.slice(
    service.indexOf("async function clearMatchScopedRuntimeFiles"),
    service.indexOf("async function writePreparedMatchSession"),
  );
  assert(startMatchBody.includes('resetMatchScopedRuntimeState("superseded_by_new_match"'), "Start Match must use the canonical match-scope reset");
  assert(resetMatchBody.includes("state.runtime_events = structuredClone(defaultState.runtime_events);"), "canonical match reset must clear previous match semantic event log");
  assert(resetMatchBody.includes("state.runtime_event_detector = null;"), "canonical match reset must clear previous match semantic detector snapshot");
  assert(resetMatchBody.includes("state.runtime_event_advice = structuredClone(defaultState.runtime_event_advice);"), "canonical match reset must clear previous match event advice cooldown, handled, and retry state");
  assert(resetMatchBody.includes("state.self_state_refresh = null;"), "canonical match reset must clear previous match self-state OCR artifact pointers");
  assert(startMatchBody.includes("startMatchOcrWarmupWorkers(\"start_match\")"), "Start Match must start all resident OCR workers before user choice windows");
  assert(startMatchBody.includes("await awaitStartMatchOcrWarmup(ocrWarmup)"), "Start Match must wait for OCR worker ready state instead of merely fire-and-forget prewarm");
  assert(startMatchBody.includes("await clearMatchScopedRuntimeFiles()"), "Start Match must invoke canonical match-file cleanup after prior owners stop");
  assert(
    clearMatchFilesBody.includes("currentWatchDir")
      && clearMatchFilesBody.includes("currentEntries.map")
      && clearMatchFilesBody.includes("rm(path.join(currentWatchDir, entry.name)"),
    "canonical match-file cleanup must remove every prior current-watch artifact, including pending visual requests",
  );
  const pretriggerBody = service.slice(
    service.indexOf("async function maybeStartChoicePretrigger"),
    service.indexOf("async function resolveActiveLiveStateForRuntime"),
  );
  assert(pretriggerBody.includes("if (choiceVisualRuntimeModes.has(state.active_mode || \"\"))"), "choice pretrigger must not mutate state while user is in a manual choice mode");
  assert(pretriggerBody.includes("if (!backgroundPollRuntimeModes.has(state.active_mode || \"\"))"), "choice pretrigger must only run from background poll modes");
  const phaseTriggerBody = service.slice(
    service.indexOf("async function maybeHandleRuntimePhaseTrigger"),
    service.indexOf("async function runPipelineForMessage"),
  );
  assert(phaseTriggerBody.includes("if (choiceVisualRuntimeModes.has(state.active_mode || \"\")) return null;"), "auto choice sensing must not mutate visual state while user is in a manual choice mode");
  assert(phaseTriggerBody.includes("if (!backgroundPollRuntimeModes.has(state.active_mode || \"\")) return null;"), "auto choice sensing must only run from background poll modes");
  assert(!service.includes("at: entry.at || null"), "confirmed choice event fingerprints must ignore timestamps");
  assert(service.includes("const lineUnitFingerprint = (unit) => {"), "board/bench material events must use a strategy-material unit fingerprint");
  const lineUnitFingerprintStart = service.indexOf("const lineUnitFingerprint = (unit) => {");
  const lineUnitFingerprintEnd = service.indexOf("return {", service.indexOf("return {", lineUnitFingerprintStart) + 1);
  const lineUnitFingerprint = service.slice(lineUnitFingerprintStart, lineUnitFingerprintEnd);
  assert(!lineUnitFingerprint.includes("position"), "board/bench material event fingerprint must not trigger on positioning-only changes");
  const boardBenchEventStart = service.indexOf("if (previous && snapshot.board_bench_material_hash");
  const boardBenchEventEnd = service.indexOf('if (previous && snapshot.bench_count', boardBenchEventStart);
  const boardBenchEvent = service.slice(boardBenchEventStart, boardBenchEventEnd);
  assert(boardBenchEvent.includes("const hasLineDecisionContext = Boolean("), "board/bench facts may record whether decision context exists for downstream packets");
  assert(boardBenchEvent.includes("snapshot.latest_user_intent_hash"), "board/bench line context must include latest user intent");
  assert(boardBenchEvent.includes("snapshot.confirmed_choices_hash"), "board/bench line context must include confirmed choices");
  assert(boardBenchEvent.includes("snapshot.bench_count >= 8"), "board/bench line context must include bench pressure");
  assert(boardBenchEvent.includes("advice_eligible: false"), "board/bench material changes must never directly trigger host advice");
  assert(boardBenchEvent.includes("Let user intent, confirmed choices, bench pressure, economy, or stage checkpoints trigger AI advice."), "board/bench event must document that decision events trigger AI advice");
  assert(boardBenchEvent.includes("buy/sell/positioning can be high frequency"), "board/bench event must document the high-frequency anti-spam policy");
  const itemMaterialEventStart = service.indexOf('type: "item_material_changed"');
  const itemMaterialEventEnd = service.indexOf('if (previous && snapshot.board_bench_material_hash', itemMaterialEventStart);
  const itemMaterialEvent = service.slice(itemMaterialEventStart, itemMaterialEventEnd);
  assert(itemMaterialEvent.includes("advice_eligible: false"), "item material changes must never directly trigger host advice");
  assert(itemMaterialEvent.includes("It must enter selected context, not occupy the host response lane by itself."), "item material event must document fact-only selected-context behavior");
  assert(itemMaterialEvent.includes('type: "equipment_fit_changed"'), "item facts with target/choice context must produce a separate derived equipment-fit decision event");
  assert(itemMaterialEvent.includes("fallback_evidence_only"), "derived equipment-fit events must label visual-only item evidence instead of promoting it to hard truth");
  assert(itemMaterialEvent.includes("const hasStructuredItemEvidence"), "proactive equipment-fit advice must distinguish MuMu structured facts from visual fallback candidates");
  assert(itemMaterialEvent.includes("advice_eligible: false"), "equipment evidence changes must never occupy the proactive Host lane, regardless of structured or visual source");
  assert(itemMaterialEvent.includes("fallback_evidence_only") && semanticAdmissionByCategory.equipment_fit_context?.opens_host_answer === false, "fallback-only equipment evidence must remain explicit-advice context without becoming proactive truth");
  const openingMaterialGuard = service.slice(
    service.indexOf('if (\n    [\n      "item_material_changed"'),
    service.indexOf("const cooldownMs = runtimeEventAdviceCooldownMs(category)"),
  );
  for (const eventType of [
    "item_material_changed",
    "board_bench_material_changed",
    "equipment_fit_changed",
    "shop_decision_context_changed",
    "line_decision_context_changed",
    "streak_decision_context_changed",
  ]) {
    assert(openingMaterialGuard.includes(`"${eventType}"`), `opening-stage material guard missing ${eventType}`);
  }
  assert(service.includes('reason: "gold bucket changed; local scorer may use this but it must not directly call host model"'), "gold bucket changes must remain fact-only");
  assert(service.includes('type: "shop_material_changed"') && service.includes('reason: "shop material changed; fact update only"'), "raw shop changes must remain fact-only even when local scoring uses them");
  assert(service.includes("runtimeEventContextJson: JSON.stringify(runtimeEventContext)"), "automatic advice pipelines must pass the exact semantic event focus into the in-process Host request builder");
  assert(
    service.includes('preferredTriggerId: "runtime_event_followup"')
      && service.includes("allowMissingPreferred: true"),
    "automatic advice must consume only the event-owned Host request while allowing an explicit recorded-only outcome",
  );
  assert(service.includes('status: "preferred_host_request_recorded_only"'), "an event-owned task recorded-only by the pipeline must close as no_advice instead of poisoning the Host lane");
  assert(service.includes('status: "no_matching_preferred_host_request"'), "a preferred semantic trigger must fail closed instead of falling back to the latest unrelated host request");
  const pendingFailureCheck = service.indexOf("if (pending?.ok === false)");
  const noAdviceCheck = service.indexOf("if (!pending?.request)", pendingFailureCheck);
  assert(pendingFailureCheck >= 0 && noAdviceCheck > pendingFailureCheck, "runtime event pipelines must surface host-request generation failures before classifying a true no-request result as no_advice");
  assert(service.includes('const stageCategory = adviceStageCategory(stageRound);'), "every proactive category must re-check choice-window stage ownership");
  assert(service.includes('reason: "non_self_current_view"'), "S=2/non-self view must suppress new proactive advice before it reserves the Host lane");
  assert(
    service.includes('hp === 0 && hasExplicitMatchEliminationEvidence(liveState)')
      && service.includes('reason: "match_eliminated"'),
    "HP zero may suppress coaching only with separate explicit elimination evidence",
  );
  assert(service.includes("function coalesceRuntimeEventAdviceRetries"), "retryable proactive advice must coalesce superseded events from the same semantic family");
  assert(service.includes("function pruneRuntimeEventAdviceRetryAudit"), "runtime-event retry audit must remain bounded across a full match");
  assert(service.includes("function releaseRuntimeEventAdviceCooldown"), "failed, no-advice, and stale proactive attempts must release their semantic cooldown instead of suppressing later useful advice");
  assert(
    service.includes("if (!shouldDisplay) {")
      && service.includes("releaseRuntimeEventAdviceCooldown(eventKey);"),
    "stale proactive answers must not consume the cooldown reserved for a visible coach answer",
  );
  assert(service.includes("computed economy context changed; fact update only and must be folded into the next fixed strategic checkpoint"), "derived economy changes must be computed decision evidence folded into the next fixed checkpoint, not raw-gold speech triggers");
  assert(service.includes('type: "economic_decision_context_changed"'), "runtime must emit a derived economic decision event");
  assert(semanticAdmissionByCategory.economy_management_context?.opens_host_answer === false, "derived economy evidence must not independently reserve the Host lane");
  assert(service.includes('advice_eligible: false,') && service.includes('type: "runtime_snapshot_changed"'), "runtime snapshot changes must remain fact-only");
  assert(service.includes('case "observeRuntimeTick": return observeRuntimeTick();'), "runtime action switch must expose observeRuntimeTick");
  assert(app.includes('"watcher_observation"'), "renderer must observe committed watcher revisions");
  assert(app.includes('observe: event?.type === "watcher_observation"'), "watcher observations must request an immediate semantic observation through the canonical reconcile queue");
  assert(app.includes("reconcileCanonicalRuntimeDelivery({"), "renderer must serialize watcher observation and response delivery through one reconcile path");
  assert(app.includes("window.setInterval(tick, 30000)"), "renderer polling must be a 30-second watchdog only");
  assert(!app.includes("window.setInterval(tick, 5000)"), "renderer must not keep the old 5-second observation loop");
  assert(service.includes("async function deliverReadyResponse()"), "runtime-service.js must expose delivery-only response polling");
  assert(service.includes("function manualChoiceFallbackResponseFromTask"), "manual choice OCR success must have a visible fallback response when the host CLI fails or times out");
  assert(service.includes("manual_choice_host_failed_fallback"), "manual choice host failure must be converted into a user-visible fallback instead of hidden pending/failed state");
  assert(service.includes("manual_choice_host_timeout_fallback"), "manual choice host timeout must be converted into a user-visible fallback instead of blocking cruise");
  assert(service.includes("return MANUAL_CHOICE_HOST_PENDING_TIMEOUT_MS;"), "manual choice user questions should use the manual choice timeout while still preserving the answer contract after the window passes");
  assert(service.includes("function releaseManualChoiceModeAfterDelivery"), "manual choice response delivery must release augment/god/item modes back to cruise");
  assert(service.includes("manual_choice_response_delivered_returned_to_cruise"), "manual choice response delivery must be observable when it returns to cruise");
  assert(service.includes("async function ackDeliveredResponse"), "rendered response ack must own final delivery state transitions");
  assert(service.includes("releaseManualChoiceModeAfterDelivery(deliveredTask, reason)"), "ackDeliveredResponse must release manual choice mode after the UI renders completed/failed delivery");
  assert(service.includes("if (currentMatchSessionId && hudMatchSessionId && hudMatchSessionId !== currentMatchSessionId) return null;"), "self-state ROI live-state files without embedded match_session_id must still be accepted from the current state pointer");
  const liveStateBelongsBody = service.slice(
    service.indexOf("function liveStateBelongsToCurrentMatch"),
    service.indexOf("function activeLiveStateStageKey"),
  );
  assert(liveStateBelongsBody.includes("if (!liveStateSessionId) return unscopedLiveStateLooksCurrent(liveState);"), "current live_state without embedded match_session_id must be accepted only through the unscoped current-state evidence gate");
  assert(liveStateBelongsBody.includes("function unscopedLiveStateLooksCurrent"), "unscoped live_state acceptance must be explicit and reviewable");
  assert(liveStateBelongsBody.includes("if (!Number.isFinite(observedAtMs)) return false;"), "unscoped live_state must require a parseable observed_at/updated_at timestamp");
  assert(liveStateBelongsBody.includes("observedAtMs < matchStartedAt"), "unscoped live_state must reject snapshots older than the active match start");
  assert(liveStateBelongsBody.includes("hasPhaseLiveEvidence(liveState.phase)") && liveStateBelongsBody.includes("hasEconomyLiveEvidence(liveState.economy)"), "unscoped live_state must require stage/economy anchors before entering active state");
  assert(liveStateBelongsBody.includes('recordRuntimeEvent("current_match_unscoped_live_state_accepted"'), "accepting unscoped current live_state must be observable in runtime events");
  const deliveryBody = service.slice(
    service.indexOf("async function deliverReadyResponse()"),
    service.indexOf("async function observeRuntimeTick()"),
  );
  assert(deliveryBody.includes('reconcileRunningHostCoachResponseTask("delivery_only")'), "deliverReadyResponse must reconcile running host tasks before reporting pending/idle");
  assert(deliveryBody.includes('reconcilePendingHostCoachResponseTask("delivery_only")'), "deliverReadyResponse must reconcile pending host tasks before reporting pending/idle");
  assert(!deliveryBody.includes("runHostModel("), "deliverReadyResponse must not call host model");
  assert(!deliveryBody.includes("runHostCoachForPipeline("), "deliverReadyResponse must not call host coach");
  assert(!deliveryBody.includes("requestPendingHostCoach("), "deliverReadyResponse must not create host coach requests");
  assert(!deliveryBody.includes("run-jcc-cruise-runtime-pipeline.mjs"), "deliverReadyResponse must not run advice pipeline");
  assert(service.includes('case "deliverReadyResponse": return deliverReadyResponse();'), "runtime action switch must expose deliverReadyResponse");
  const pollBody = service.slice(
    service.indexOf("async function pollCruiseAdvice()"),
    service.indexOf("async function deliverReadyResponse()"),
  );
  assert(pollBody.includes("automatic advice must pass observeRuntimeTick semantic event gates"), "pollCruiseAdvice must document observe-only compatibility policy");
  assert(!pollBody.includes("runHostModel("), "pollCruiseAdvice must not call host model directly");
  assert(!pollBody.includes("runHostCoachForPipeline("), "pollCruiseAdvice must not call host coach directly");
  assert(!pollBody.includes("requestPendingHostCoach("), "pollCruiseAdvice must not create host coach requests");
  assert(!pollBody.includes("latest-cruise-autopoll-pipeline"), "pollCruiseAdvice must not run the old auto-cruise pipeline file");
  assert(!pollBody.includes("maybeHandleRuntimePhaseTrigger("), "pollCruiseAdvice must not start target-stage choice sensing");
  assert(!pollBody.includes("maybeStartOpeningCheckpoint("), "pollCruiseAdvice must not start opening checkpoint advice");
  assert(!pollBody.includes('origin: "auto_cruise"'), "pollCruiseAdvice must not create auto_cruise response tasks");
  assert(service.includes('const ENABLE_STAGE_CHOICE_AUTO_SENSING = process.env.JCC_ENABLE_STAGE_CHOICE_AUTO_SENSING === "1";'), "stage choice auto sensing must be opt-in");

  assert(preload.includes('"observeRuntimeTick"'), "preload must allow observeRuntimeTick");
  assert(preload.includes("observeRuntimeTick: () => invoke(\"observeRuntimeTick\")"), "preload bridge must expose observeRuntimeTick");
  assert(preload.includes('"deliverReadyResponse"'), "preload must allow deliverReadyResponse");
  assert(preload.includes("deliverReadyResponse: () => invoke(\"deliverReadyResponse\")"), "preload bridge must expose deliverReadyResponse");
  assert(bridge.includes("observeRuntimeTick(): Promise"), "runtimeBridge type must expose observeRuntimeTick");
  assert(bridge.includes("async observeRuntimeTick()"), "runtimeBridge mock must implement observeRuntimeTick");
  assert(bridge.includes("deliverReadyResponse(): Promise"), "runtimeBridge type must expose deliverReadyResponse");
  assert(bridge.includes("async deliverReadyResponse()"), "runtimeBridge mock must implement deliverReadyResponse");
  assert(!daemon.includes("observeRuntimeTick: { queueName"), "observe ticks must not enqueue durable daemon tasks");
  assert(!daemon.includes('"observeRuntimeTick",'), "observe ticks must not be in daemonQueuedActions");
  assert(daemon.includes('action !== "observeRuntimeTick" && action !== "deliverReadyResponse"'), "observe and delivery ticks must not write routine ui_action event noise");

  const reconcileBody = app.slice(
    app.indexOf("runtimeReconcileHandlerRef.current = async"),
    app.indexOf("const handleHostModelChange"),
  );
  assert(reconcileBody.includes("reconcileCanonicalRuntimeDelivery({"), "runtime event and watchdog reconciliation must use the canonical delivery coordinator");
  assert(reconcileBody.includes("observe: request.observe"), "canonical reconciliation must opt into observeRuntimeTick only for watcher/watchdog requests");
  assert(reconcileBody.includes("onObserved: handleObservedRuntimeResult"), "automatic observation results must flow through one renderer handler");
  assert(!reconcileBody.includes("runtime.pollCruiseAdvice()"), "automatic reconcile must not call the legacy cruise poll path");
  assert(bridge.includes("await runtime.deliverReadyResponse()"), "canonical delivery coordinator must call deliverReadyResponse");
  assert(app.includes('scheduleDeliveryFollowup("send message hidden fast choice AI-native continuation"'), "manual choice hidden fast OCR evidence must wait through response delivery, not visual polling");
  assert(!app.includes('scheduleVisualFollowup("send message hidden fast choice AI-native continuation"'), "manual choice hidden fast OCR evidence must not be routed back into visual/cruise polling");
  assert(app.includes('scheduleDeliveryFollowup(`enter ${mode} mode hidden fast choice continuation`'), "entering a manual choice mode with hidden fast OCR evidence must use response delivery follow-up");
  assert(app.includes('scheduleDeliveryFollowup("poll cruise response delivery"'), "manual/visual poll follow-up must deliver response_ready instead of waiting for another observe tick");
  assert(app.includes("deliveryExtendedNoticeRef"), "UI delivery follow-up must de-duplicate extended-wait notices");
  assert(app.includes("Math.max(delayMs, 5000)"), "UI delivery follow-up must continue low-frequency polling after the visible 120s wait window while a response task exists");
  assert(app.includes("handleObservedRuntimeResult"), "UI must route observe-only statuses through one canonical observation handler");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "automatic observe tick does not use the old cruise polling path",
      "observeRuntimeTick routes model work only through semantic event advice gate",
      "1-4 yields the Host lane to the upcoming 2-1 user-report choice window",
      "automatic observe ticks are in-flight guarded and not daemon-event noisy",
      "event advice is gated by semantic events and de-duplicated by event key",
    "ordinary economy, HP, stage, bench, shop, and equipment events remain evidence-only; only registered fixed strategic checkpoints and explicit structured-card actions can open Host answers",
      "derived economic decision context remains supporting evidence and cannot independently open a Host answer",
      "advice gate pipeline failures/no-advice results are diagnostic instead of being swallowed as runtime_observed",
      "transiently skipped advice-eligible semantic events are retried instead of being lost after detector snapshot advances",
      "Start Match clears old match-scoped OCR/visual state and waits for resident OCR workers to become hot",
      "runtime snapshot, contextless board/bench churn, shop changes, and gold buckets remain fact-only and cannot directly call the host model",
      "event-triggered host context includes strategy_fit_packet, economy_management_context, and economic_decision_context as selected evidence",
      "pollCruiseAdvice compatibility path cannot create old auto-cruise host requests",
      "stage choice auto sensing is opt-in",
      "runtime action/preload/bridge expose observeRuntimeTick",
      "UI uses watcher revision events for observeRuntimeTick and keeps only a 30s reconciliation watchdog",
      "manual/visual follow-up pollCruiseAdvice remains available outside automatic interval",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
