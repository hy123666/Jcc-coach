#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  configureRuntimeServicePaths,
  getRuntimeServiceState,
  handleRuntimeAction,
  setRuntimeServiceState,
} from "../ui/electron/runtime-service.js";
import { createActiveCoreProfileSnapshot } from "./jcc_test_core_profile_fixture.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const dataRoot = await mkdtemp(path.join(tmpdir(), "jcc-chat-is-not-choice-confirmation-"));
const repoRoot = path.resolve(import.meta.dirname, "..");
const activeVersionSnapshot = createActiveCoreProfileSnapshot(repoRoot);
const matchSessionId = "verify-chat-is-not-choice-confirmation";
const previousDisableExec = process.env.JCC_UI_DISABLE_CODEX_EXEC;

try {
  process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
  configureRuntimeServicePaths({ dataRoot });
  setRuntimeServiceState({
    schema: "jcc-ui-runtime-state-v1",
    match_session: {
      status: "active",
      match_session_id: matchSessionId,
      started_at: new Date().toISOString(),
      season_version_snapshot: activeVersionSnapshot,
    },
    daily_session: { status: "active", mode: "daily_chat" },
    active_mode: "cruise",
    runtime_triggers: {
      visual_by_stage: {},
      choice_pretriggers: {},
      missing_choice_prompts: {
        "3-2:augment": {
          key: "3-2:augment",
          kind: "augment",
          label: "3-2 augment",
          choice_stage_round: "3-2",
          asked_at: new Date().toISOString(),
        },
      },
      choice_confirmations: [],
    },
    response_task: { status: "idle", revision: 0 },
    match_context: {
      schema: "jcc-runtime-ui-match-context-v1",
      match_session_id: matchSessionId,
      choice_confirmations: [],
      reported_choice_sets_by_mode: {
        augment_choice: { mode: "augment_choice", report_id: "existing-augment-report", candidates: ["A", "B", "C"] },
      },
      reported_choice_sets: [
        { mode: "augment_choice", report_id: "existing-augment-report", candidates: ["A", "B", "C"] },
      ],
    },
  });
  const initialReportedByMode = JSON.stringify(getRuntimeServiceState().match_context.reported_choice_sets_by_mode);
  const initialReportedHistory = JSON.stringify(getRuntimeServiceState().match_context.reported_choice_sets);

  const liveStateFile = path.join(dataRoot, "runtime-evidence", "mumu-gi-live", "current-watch", "cruise-live-state.json");
  await mkdir(path.dirname(liveStateFile), { recursive: true });
  await writeFile(liveStateFile, JSON.stringify({
    schema: "jcc-live-state-fixture-v1",
    match_session_id: matchSessionId,
    observed_at: new Date().toISOString(),
    phase: { stage_round: "3-6", stage: 3, round: 6 },
    economy: { hp: 61, gold: 50, level: 7, xp: "0/36" },
  }, null, 2), "utf8");

  const targetMessage = "我这会儿应该是五太空律动的体系了";
  const targetResult = await handleRuntimeAction("sendMessage", {
    text: targetMessage,
    mode: "cruise",
  }, null);
  assert(targetResult.ok === true, `target-direction chat should be accepted: ${targetResult.error || targetResult.status}`);
  assert(targetResult.status !== "choice_confirmation_recorded", "target-direction chat must not be swallowed as a choice confirmation");

  let current = getRuntimeServiceState();
  assert(!(current.match_context?.choice_confirmations || []).length, "target-direction chat must not create canonical choice confirmations");
  assert(JSON.stringify(current.match_context?.reported_choice_sets_by_mode) === initialReportedByMode, "target-direction chat must not change canonical candidate sets by mode");
  assert(JSON.stringify(current.match_context?.reported_choice_sets) === initialReportedHistory, "target-direction chat must not change canonical candidate history");
  assert(
    current.match_context?.recent_user_messages?.some((entry) => entry.text === targetMessage),
    "target-direction chat must remain available to the Host as user intent",
  );
  assert(current.runtime_triggers?.missing_choice_prompts?.["3-2:augment"], "a nonblocking descriptor-backed reminder may remain pending until the card confirms it");

  const explicitChoiceSentence = "3-2我选了飞升，这把继续看厚前排阵容";
  const explicitResult = await handleRuntimeAction("sendMessage", {
    text: explicitChoiceSentence,
    mode: "cruise",
  }, null);
  assert(explicitResult.ok === true, `choice-like chat should remain a normal Host turn: ${explicitResult.error || explicitResult.status}`);
  assert(explicitResult.status !== "choice_confirmation_recorded", "even explicit choice-like chat must not bypass the structured card");

  current = getRuntimeServiceState();
  assert(!(current.match_context?.choice_confirmations || []).length, "ordinary chat must never append canonical final choices");
  assert(JSON.stringify(current.match_context?.reported_choice_sets_by_mode) === initialReportedByMode, "ordinary chat must never change canonical choice candidates by mode");
  assert(JSON.stringify(current.match_context?.reported_choice_sets) === initialReportedHistory, "ordinary chat must never append canonical choice history");
  assert(
    current.match_context?.recent_user_messages?.some((entry) => entry.text === explicitChoiceSentence),
    "choice-like chat must remain visible as conversational context",
  );

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-choice-confirmation-behavior-verifier-v2",
    checked: [
      "target_direction_chat_does_not_confirm_pending_season_choice",
      "explicit_choice_like_chat_does_not_bypass_structured_card",
      "chat_still_updates_host_conversation_context",
    ],
  }, null, 2));
} finally {
  if (previousDisableExec === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
  else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisableExec;
  await handleRuntimeAction("shutdown", { reason: "choice_confirmation_verifier_cleanup" }, null).catch(() => {});
  await rm(dataRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 }).catch(() => {});
}
