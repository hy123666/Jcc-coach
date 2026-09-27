import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeSqliteStore } from "../ui/electron/runtime-state-store.js";
import {
  JccRuntimeDaemon,
  mergeRuntimeServiceCanonicalSnapshot,
} from "../ui/electron/runtime-daemon.js";
import {
  getRuntimeServiceState,
  handleRuntimeAction,
  setRuntimeServiceState,
} from "../ui/electron/runtime-service.js";

const [daemon, service] = await Promise.all([
  readFile("ui/electron/runtime-daemon.js", "utf8"),
  readFile("ui/electron/runtime-service.js", "utf8"),
]);

assert(
  daemon.includes("this.store.commitRuntimeTransition({"),
  "daemon must atomically commit canonical runtime state, response task, revision, and outbox event",
);

for (const key of ["match_session_current", "daily_session_current"]) {
  assert(
    daemon.includes(`this.store.setJson("${key}"`),
    `daemon must remain the canonical writer for ${key}`,
  );
}

assert(
  service.includes("function setRuntimeServiceCanonicalStateWriter(writer)")
    && service.includes("runtimeServiceCanonicalStateWriter(snapshot,"),
  "runtime-service detached completions must use the daemon-injected canonical writer",
);
assert(
  service.includes("function setRuntimeServiceEventWriter(writer)")
    && service.includes("if (runtimeServiceEventWriter)"),
  "runtime-service semantic events must use the daemon's already-open SQLite event writer",
);
assert(
  service.includes('event_type: "watcher_process_stopped"')
    && service.includes("Number(state.watcher?.pid) !== Number(child.pid)"),
  "watcher process close must persist a session-owned canonical stop event instead of writing only a legacy mirror",
);

for (const key of ["ui_runtime_state", "response_task", "match_session_current", "daily_session_current"]) {
  assert(
    !service.includes(`store.setJson("${key}"`),
    `runtime-service added an unauthorized canonical writer for ${key}`,
  );
}

const runtimeSqliteAccessSites = service.match(/const store = openRuntimeSqliteStore\(\);/g) || [];
assert.equal(
  runtimeSqliteAccessSites.length,
  5,
  "runtime-service must retain exactly five reviewed SQLite access sites: Wiki status, Match Wiki snapshot capture, Wiki Host context, recent match summaries, and the daemon-absent diagnostic event fallback",
);
assert(service.includes("store.listWikiPages"), "runtime-service SQLite reads must include the bounded Wiki lookup path");

const canonicalNewMatch = {
  schema: "jcc-ui-runtime-state-v1",
  match_session: { status: "active", match_session_id: "match-new" },
  active_mode: "cruise",
  self_state_refresh: { status: "completed", stage_round: "3-2" },
  response_task_revision: 4,
  response_task: {
    status: "completed",
    response_task_id: "task-new",
    match_session_id: "match-new",
    mode: "cruise",
    revision: 4,
    response: { final_text: "new match answer" },
  },
};
const staleOldMatchSnapshot = {
  ...canonicalNewMatch,
  match_session: { status: "active", match_session_id: "match-old" },
  active_mode: "augment_choice",
  self_state_refresh: { status: "completed", stage_round: "6-1" },
  response_task_revision: 5,
  response_task: {
    status: "completed",
    response_task_id: "task-old",
    match_session_id: "match-old",
    mode: "augment_choice",
    revision: 5,
    response: { final_text: "stale old match answer" },
  },
};
const rejectedOldMatch = mergeRuntimeServiceCanonicalSnapshot(canonicalNewMatch, staleOldMatchSnapshot, {
  source: "background_self_state_roi_ocr_completed",
  event_type: "hud_facts_changed",
});
assert.equal(rejectedOldMatch.applied, false, "old-match detached snapshots must be rejected as a unit");
assert.equal(rejectedOldMatch.reason, "match_session_ownership_mismatch");
assert.deepEqual(rejectedOldMatch.state, canonicalNewMatch, "old-match HUD completion must not restore any old runtime state");

const canonicalSameMatch = {
  ...canonicalNewMatch,
  match_session: { status: "active", match_session_id: "match-same" },
  active_mode: "cruise",
  self_state_refresh: { status: "completed", stage_round: "3-2" },
  response_task_revision: 5,
  response_task: {
    status: "completed",
    response_task_id: "task-current",
    match_session_id: "match-same",
    mode: "cruise",
    revision: 5,
    response: { final_text: "current answer" },
  },
};
const staleTaskFreshHud = {
  ...canonicalSameMatch,
  active_mode: "season_choice_sequence",
  self_state_refresh: { status: "completed", stage_round: "3-5" },
  response_task_revision: 4,
  response_task: {
    status: "running",
    response_task_id: "task-stale",
    match_session_id: "match-same",
    mode: "cruise",
    revision: 4,
  },
};
const mergedFreshHud = mergeRuntimeServiceCanonicalSnapshot(canonicalSameMatch, staleTaskFreshHud, {
  source: "background_self_state_roi_ocr_completed",
  event_type: "hud_facts_changed",
});
assert.equal(mergedFreshHud.applied, true);
assert.equal(mergedFreshHud.state.self_state_refresh.stage_round, "3-5", "same-match HUD facts may advance independently");
assert.equal(mergedFreshHud.state.response_task.response_task_id, "task-current", "older task revisions must not replace canonical response ownership");
assert.equal(mergedFreshHud.state.response_task_revision, 5);
assert.equal(mergedFreshHud.state.active_mode, "cruise", "detached facts must not switch the current UI mode");

const canonicalAfterDelivery = {
  ...canonicalSameMatch,
  response_task: {
    ...canonicalSameMatch.response_task,
    status: "delivered",
    response_task_id: null,
    previous_response_task_id: "task-current",
    delivered_at: "2026-07-22T06:00:00.000Z",
  },
};
const newerTaskSnapshot = {
  ...canonicalAfterDelivery,
  active_mode: "augment_choice",
  runtime_triggers: { stale_detached_marker: true },
  response_task_revision: 6,
  response_task: {
    status: "completed",
    response_task_id: "task-next",
    match_session_id: "match-same",
    mode: "cruise",
    revision: 6,
    response: { final_text: "new answer" },
  },
};
const mergedNewerTask = mergeRuntimeServiceCanonicalSnapshot(canonicalAfterDelivery, newerTaskSnapshot, {
  source: "runtime_event_host_response_completed",
  event_type: "runtime_event_response_task_completed",
});
assert.equal(mergedNewerTask.applied, true);
assert.equal(mergedNewerTask.state.response_task.response_task_id, "task-next", "the next owned response revision must remain deliverable");
assert.equal(mergedNewerTask.state.response_task_revision, 6);
assert.equal(mergedNewerTask.state.active_mode, "cruise", "host completion must not restore the mode captured when work started");
assert.equal(
  mergedNewerTask.state.runtime_triggers,
  canonicalSameMatch.runtime_triggers,
  "host completion must not replace unrelated runtime trigger state from its launch snapshot",
);

const canonicalRunningTask = {
  ...canonicalSameMatch,
  response_task_revision: 7,
  response_task: {
    status: "running",
    response_task_id: "task-owner-a",
    match_session_id: "match-same",
    mode: "cruise",
    origin: "user",
    revision: 7,
  },
};
for (const incomingRevision of [8, 9]) {
  const detachedOtherTask = {
    ...canonicalRunningTask,
    response_task_revision: incomingRevision,
    response_task: {
      status: "completed",
      response_task_id: "task-owner-b",
      match_session_id: "match-same",
      mode: "cruise",
      origin: "user",
      revision: incomingRevision,
      response: { final_text: "late answer from another owner" },
    },
  };
  const rejectedOtherOwner = mergeRuntimeServiceCanonicalSnapshot(canonicalRunningTask, detachedOtherTask, {
    source: "direct_host_response_completed",
    event_type: "user_intent_direct_response_completed",
  });
  assert.equal(rejectedOtherOwner.applied, false);
  assert.equal(rejectedOtherOwner.reason, "canonical_response_task_still_undelivered");
  assert.equal(rejectedOtherOwner.state.response_task.response_task_id, "task-owner-a");
}

const sameOwnerCompletion = mergeRuntimeServiceCanonicalSnapshot(canonicalRunningTask, {
  ...canonicalRunningTask,
  response_task_revision: 8,
  response_task: {
    ...canonicalRunningTask.response_task,
    status: "completed",
    revision: 8,
    response: { final_text: "owned answer" },
  },
}, {
  source: "direct_host_response_completed",
  event_type: "user_intent_direct_response_completed",
});
assert.equal(sameOwnerCompletion.applied, true);
assert.equal(sameOwnerCompletion.state.response_task.response_task_id, "task-owner-a");

const sameOwnerGap = mergeRuntimeServiceCanonicalSnapshot(canonicalRunningTask, {
  ...canonicalRunningTask,
  response_task_revision: 9,
  response_task: {
    ...canonicalRunningTask.response_task,
    status: "completed",
    revision: 9,
    response: { final_text: "owned but skipped a revision" },
  },
}, {
  source: "direct_host_response_completed",
  event_type: "user_intent_direct_response_completed",
});
assert.equal(sameOwnerGap.applied, true, "daemon must rebase a same-owner detached completion instead of losing it to a local revision gap");
assert.equal(sameOwnerGap.reason, "same_response_task_rebased");
assert.equal(sameOwnerGap.state.response_task_revision, 8, "daemon owns the canonical next revision");
assert.equal(sameOwnerGap.state.response_task.response.final_text, "owned but skipped a revision");

const rejectedStatusRegression = mergeRuntimeServiceCanonicalSnapshot(sameOwnerCompletion.state, {
  ...sameOwnerCompletion.state,
  response_task_revision: 99,
  response_task: {
    ...sameOwnerCompletion.state.response_task,
    status: "running",
    revision: 99,
    response: undefined,
  },
}, {
  source: "late_running_snapshot",
  event_type: "runtime_event_response_task_running",
});
assert.equal(rejectedStatusRegression.applied, false);
assert.equal(rejectedStatusRegression.reason, "response_task_status_regression");

const confirmationTerminal = mergeRuntimeServiceCanonicalSnapshot(canonicalRunningTask, {
  ...canonicalRunningTask,
  response_task_revision: 9,
  response_task: {
    status: "choice_confirmation_recorded",
    response_task_id: null,
    previous_response_task_id: "task-owner-a",
    match_session_id: "match-same",
    mode: "cruise",
    origin: "user_choice_confirmation",
    revision: 9,
  },
}, {
  source: "sendMessage",
  event_type: "choice_confirmation_recorded",
});
assert.equal(confirmationTerminal.applied, true, "confirmation-only terminal state must replace the same owner's preparing/running task");
assert.equal(confirmationTerminal.state.response_task.status, "choice_confirmation_recorded");

const fastChoiceNoChoiceTerminal = mergeRuntimeServiceCanonicalSnapshot(canonicalRunningTask, {
  ...canonicalRunningTask,
  response_task_revision: 9,
  response_task: {
    ...canonicalRunningTask.response_task,
    status: "fast_choice_text_no_choice",
    revision: 9,
    completed_at: "2026-07-22T06:02:00.000Z",
  },
}, {
  source: "sendMessage",
  event_type: "manual_choice_fast_text_no_choice",
});
assert.equal(fastChoiceNoChoiceTerminal.applied, true, "fast OCR no-choice must settle immediately instead of remaining running until timeout");
assert.equal(fastChoiceNoChoiceTerminal.state.response_task.status, "fast_choice_text_no_choice");

const automaticRunningTask = {
  ...canonicalRunningTask,
  response_task: {
    ...canonicalRunningTask.response_task,
    origin: "runtime_event",
  },
};
const userPreemptsAutomatic = mergeRuntimeServiceCanonicalSnapshot(automaticRunningTask, {
  ...automaticRunningTask,
  response_task_revision: 2,
  response_task: {
    status: "preparing",
    response_task_id: "task-user-priority",
    match_session_id: "match-same",
    mode: "cruise",
    origin: "user",
    revision: 2,
    started_at: "2026-07-22T06:01:00.000Z",
  },
}, {
  source: "sendMessage",
  event_type: "user_response_task_preparing",
});
assert.equal(userPreemptsAutomatic.applied, true);
assert.equal(userPreemptsAutomatic.reason, "user_response_task_supersedes_automatic");
assert.equal(userPreemptsAutomatic.state.response_task.response_task_id, "task-user-priority");
assert.equal(userPreemptsAutomatic.state.response_task_revision, 8);

const canonicalDailyState = {
  schema: "jcc-ui-runtime-state-v1",
  daily_session: { status: "active", mode: "daily_chat", generation: 2 },
  match_session: { status: "idle", match_session_id: null },
  response_task_revision: 3,
  response_task: {
    status: "idle",
    response_task_id: null,
    mode: "daily_chat",
    daily_session_generation: 2,
    revision: 3,
  },
};
const staleDailySnapshot = {
  ...canonicalDailyState,
  daily_session: { status: "active", mode: "daily_chat", generation: 1 },
  response_task_revision: 4,
  response_task: {
    status: "completed",
    response_task_id: "daily-old",
    mode: "daily_chat",
    daily_session_generation: 1,
    revision: 4,
    response: { final_text: "old daily answer" },
  },
};
const rejectedOldDaily = mergeRuntimeServiceCanonicalSnapshot(canonicalDailyState, staleDailySnapshot, {
  source: "daily_host_response_completed",
  event_type: "response_task_changed",
});
assert.equal(rejectedOldDaily.applied, false, "a reset daily session must reject detached answers from the previous generation");
assert.equal(rejectedOldDaily.reason, "daily_session_generation_mismatch");

const canonicalBeforeNewMatch = {
  ...canonicalSameMatch,
  host_sessions: {
    match: {
      route_key: "match:match-same",
      match_session_id: "match-same",
      provider_session_id: "provider-old",
    },
  },
};
const incomingNewMatchBoundary = {
  ...canonicalBeforeNewMatch,
  match_session: { status: "active", match_session_id: "match-next" },
  host_sessions: {
    match: {
      route_key: "match:match-next",
      match_session_id: "match-next",
      provider_session_id: null,
      status: "idle",
    },
  },
  response_task: { status: "idle", response_task_id: null, mode: null },
};
const mergedMatchBoundary = mergeRuntimeServiceCanonicalSnapshot(canonicalBeforeNewMatch, incomingNewMatchBoundary, {
  source: "start_match_boundary",
  event_type: "match_session_boundary_started",
  event_payload: {
    previous_match_session_id: "match-same",
    match_session_id: "match-next",
  },
});
assert.equal(mergedMatchBoundary.applied, true, "Start Match must be able to persist the new canonical match boundary before old-route shutdown");
assert.equal(mergedMatchBoundary.state.match_session.match_session_id, "match-next");
assert.equal(mergedMatchBoundary.state.host_sessions.match.route_key, "match:match-next");
assert.equal(mergedMatchBoundary.state.response_task_revision, canonicalBeforeNewMatch.response_task_revision + 1);

const rejectedForgedBoundary = mergeRuntimeServiceCanonicalSnapshot(canonicalBeforeNewMatch, incomingNewMatchBoundary, {
  source: "start_match_boundary",
  event_type: "match_session_boundary_started",
  event_payload: {
    previous_match_session_id: "some-other-match",
    match_session_id: "match-next",
  },
});
assert.equal(rejectedForgedBoundary.applied, false);
assert.equal(rejectedForgedBoundary.reason, "match_session_boundary_ownership_mismatch");

const canonicalWarmupState = {
  ...incomingNewMatchBoundary,
  response_task_revision: mergedMatchBoundary.state.response_task_revision,
  response_task: mergedMatchBoundary.state.response_task,
};
const incomingWarmSession = {
  ...canonicalWarmupState,
  host_sessions: {
    ...canonicalWarmupState.host_sessions,
    match: {
      ...canonicalWarmupState.host_sessions.match,
      status: "ready",
      provider_session_id: "provider-match-next",
      context_fingerprint: "capsule-next",
    },
  },
};
const mergedWarmSession = mergeRuntimeServiceCanonicalSnapshot(canonicalWarmupState, incomingWarmSession, {
  source: "host_session_state_changed",
  event_type: "host_session_state_changed",
  event_payload: {
    route_kind: "match",
    route_key: "match:match-next",
    reason: "warmup_completed",
  },
});
assert.equal(mergedWarmSession.applied, true, "native provider session descriptors must enter canonical SQLite state");
assert.equal(mergedWarmSession.state.host_sessions.match.provider_session_id, "provider-match-next");
assert.equal(mergedWarmSession.state.host_sessions.match.context_fingerprint, "capsule-next");
assert.deepEqual(mergedWarmSession.state.response_task, canonicalWarmupState.response_task, "host-session persistence must not steal response-task ownership");

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-atomic-state-"));
const store = createRuntimeSqliteStore(process.cwd(), { dataRoot }).open();
try {
  const initialState = {
    schema: "jcc-ui-runtime-state-v1",
    match_session: { status: "active", match_session_id: "match-atomic" },
    response_task_revision: 7,
    response_task: {
      status: "completed",
      response_task_id: "task-atomic",
      revision: 7,
      response: { final_text: "atomic answer" },
    },
  };
  const transition = store.commitRuntimeTransition({
    state: initialState,
    responseTask: initialState.response_task,
    eventType: "response_task_changed",
    eventPayload: { source: "contract_test" },
  });
  assert.equal(transition.revision, 7, "atomic transition must preserve the response task revision");
  assert.equal(store.getJson("ui_runtime_state")?.response_task?.response_task_id, "task-atomic");
  assert.equal(store.getJson("response_task")?.revision, 7);
  assert.equal(store.getJson("response_task_revision"), 7);
  assert.equal(transition.event?.event_type, "response_task_changed");
  assert.equal(transition.event?.payload?.response_task_id, "task-atomic");

  assert.throws(() => store.commitRuntimeTransition({
    state: {
      ...initialState,
      response_task: {
        status: "failed",
        response_task_id: "task-conflict",
        revision: 7,
      },
    },
    eventType: "response_task_changed",
  }), /conflicting runtime transition/);
  assert.equal(
    store.getJson("response_task")?.response_task_id,
    "task-atomic",
    "same-revision conflicting task must not overwrite canonical state",
  );

  const eventCountBeforeRollback = store.listRecentEvents(100).length;
  assert.throws(() => store.commitRuntimeTransition({
    state: {
      ...initialState,
      response_task_revision: 8,
      response_task: {
        status: "failed",
        response_task_id: "task-rollback",
        revision: 8,
      },
    },
    eventType: "response_task_changed",
    eventPayload: { source: "rollback_contract_test" },
    failpoint: "after_state_write",
  }), /after_state_write/);
  assert.equal(
    store.getJson("ui_runtime_state")?.response_task?.response_task_id,
    "task-atomic",
    "failed transition must roll back ui_runtime_state",
  );
  assert.equal(
    store.getJson("response_task")?.response_task_id,
    "task-atomic",
    "failed transition must roll back response_task",
  );
  assert.equal(
    store.listRecentEvents(100).length,
    eventCountBeforeRollback,
    "failed transition must not publish a durable event",
  );
} finally {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
}

const daemonDataRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-detached-writer-"));
const runtimeDaemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: daemonDataRoot }).start();
try {
  const emitted = [];
  const unsubscribe = runtimeDaemon.onRuntimeEvent((event) => emitted.push(event));
  const currentState = {
    schema: "jcc-ui-runtime-state-v1",
    match_session: { status: "active", match_session_id: "match-live" },
    match_connection: { status: "waiting_for_live_state", last_live_state_match_session_id: null },
    active_mode: "cruise",
    response_task_revision: 0,
    response_task: { status: "idle", response_task_id: null, revision: 0 },
  };
  runtimeDaemon.persistResult("fixture_current_match", { ok: true, state: currentState });
  setRuntimeServiceState({
    ...currentState,
    match_context: { match_session_id: "match-live" },
  });
  const semanticEventResult = await handleRuntimeAction("saveManualVariables", {
    target: "verify injected event writer",
  }, null);
  assert.equal(semanticEventResult.ok, true, "semantic event fixture must complete through Runtime service");
  assert(
    runtimeDaemon.store.listRecentEvents(50).some((event) => event.event_type === "runtime_semantic_event_detected"),
    "Runtime semantic events must enter the daemon's already-open SQLite store",
  );
  setRuntimeServiceState({
    ...currentState,
    active_mode: "lineup_card",
    uncommitted_test_marker: "must-survive-detached-write",
  });
  await runtimeDaemon.persistRuntimeServiceCanonicalSnapshot({
    ...currentState,
    self_state_refresh: { status: "completed", stage_round: "3-5" },
    match_context: {
      latest_hud_self_state: { phase: { stage_round: "3-5" } },
      latest_authoritative_facts: { stage_round: "3-5", economy: {} },
    },
  }, {
    source: "background_self_state_roi_ocr_completed",
    event_type: "hud_facts_changed",
  });
  assert.equal(
    getRuntimeServiceState().uncommitted_test_marker,
    "must-survive-detached-write",
    "a detached canonical write must not replace newer in-process runtime state",
  );
  assert.equal(getRuntimeServiceState().active_mode, "lineup_card");
  setRuntimeServiceState(currentState);
  const emittedAfterCanonicalSeed = emitted.length;

  runtimeDaemon.store.appendEvent("response_task_changed", {
    source: "diagnostic_direct_append_fixture",
    response_task_id: "fake-direct-task",
    response_task_revision: 99,
  });
  assert.equal(
    emitted.length,
    emittedAfterCanonicalSeed,
    "direct diagnostic append must not notify daemon runtime-event subscribers",
  );
  assert.notEqual(runtimeDaemon.store.getJson("response_task")?.response_task_id, "fake-direct-task");

  await runtimeDaemon.persistRuntimeServiceCanonicalSnapshot({
    ...currentState,
    match_session: { status: "active", match_session_id: "match-old" },
    match_connection: { status: "connected_to_live_match", last_live_state_match_session_id: "match-old" },
    active_mode: "refresh_self_state",
    self_state_refresh: { status: "completed", stage_round: "6-1" },
  }, {
    source: "background_self_state_roi_ocr_completed",
    event_type: "hud_facts_changed",
  });
  const afterStaleHud = runtimeDaemon.store.getJson("ui_runtime_state");
  assert.equal(afterStaleHud.match_session.match_session_id, "match-live");
  assert.equal(afterStaleHud.active_mode, "cruise");
  assert.notEqual(afterStaleHud.match_connection?.last_live_state_match_session_id, "match-old");
  assert.equal(runtimeDaemon.store.getJson("match_session_current")?.match_session_id, "match-live");
  assert(
    runtimeDaemon.store.listRecentEvents(50).some((event) => event.event_type === "runtime_service_detached_snapshot_rejected"),
    "daemon must persist diagnostic evidence when it rejects an old-match detached snapshot",
  );

  const beforeOwnedResponseRevision = Number(runtimeDaemon.store.getJson("response_task")?.revision || 0);
  await runtimeDaemon.persistRuntimeServiceCanonicalSnapshot({
    ...currentState,
    active_mode: "augment_choice",
    response_task_revision: 1,
    response_task: {
      status: "completed",
      response_task_id: "task-live",
      match_session_id: "match-live",
      mode: "cruise",
      revision: 1,
      response: { final_text: "current owned response" },
    },
  }, {
    source: "runtime_event_host_response_completed",
    event_type: "response_task_changed",
  });
  const afterOwnedResponse = runtimeDaemon.store.getJson("ui_runtime_state");
  assert.equal(afterOwnedResponse.response_task.response_task_id, "task-live");
  assert.equal(
    afterOwnedResponse.response_task.revision,
    beforeOwnedResponseRevision + 1,
    "daemon must assign the next canonical revision instead of trusting the detached caller revision",
  );
  assert.equal(afterOwnedResponse.active_mode, "cruise");
  assert(
    emitted.some((event) => event.event_type === "response_task_changed" && event.payload?.response_task_id === "task-live"),
    "owned canonical response transition must notify daemon subscribers",
  );
  unsubscribe();
} finally {
  runtimeDaemon.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await rm(daemonDataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-single-writer-canonical-state-contract-v1",
  checked: [
    "daemon_writes_canonical_runtime_keys",
    "service_uses_daemon_injected_canonical_writer",
    "service_uses_daemon_injected_event_writer",
    "watcher_close_persists_session_owned_canonical_event",
    "no_additional_service_canonical_writers",
    "service_sqlite_access_inventory_locked",
    "old_match_detached_snapshot_is_rejected",
    "same_match_hud_merge_preserves_newer_response_task",
    "newer_response_task_merge_preserves_current_mode",
    "newer_response_task_merge_preserves_unrelated_runtime_slices",
    "daily_session_generation_rejects_pre_reset_detached_answers",
    "detached_writer_preserves_newer_in_process_state",
    "detached_writer_rejects_old_match_in_real_sqlite_daemon",
    "direct_diagnostic_event_does_not_broadcast_or_mutate_canonical_response",
    "state_task_revision_and_outbox_commit_atomically",
    "same_revision_conflict_is_rejected",
    "failed_atomic_transition_rolls_back_without_event",
  ],
}, null, 2)}\n`);
