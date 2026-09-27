import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function byTrigger(tasks, triggerId) {
  return tasks.find((task) => task.trigger_id === triggerId);
}

async function score(liveState, tempDir, name) {
  const liveStateFile = path.join(tempDir, `${name}.json`);
  await writeFile(liveStateFile, JSON.stringify(liveState, null, 2), "utf8");
  const result = await runNode([
    "tools/score-jcc-cruise-strategy.mjs",
    "--live-state",
    liveStateFile,
    "--include-suppressed",
  ]);
  assert(result.code === 0, `scorer failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

async function pipeline(liveState, tempDir, name, runtimeEventContext = null) {
  const liveStateFile = path.join(tempDir, `${name}.json`);
  const contextFile = path.join(tempDir, `${name}-context.json`);
  const pipelineOut = path.join(tempDir, `${name}-pipeline.json`);
  const lifecycleOut = path.join(tempDir, `${name}-lifecycle.json`);
  await writeFile(liveStateFile, JSON.stringify(liveState, null, 2), "utf8");
  await writeFile(contextFile, JSON.stringify({
    match_context: {
      match_session_id: liveState.match_session_id,
      reported_choice_sets_by_mode: {
        augment_choice: {
          ...liveState.augments.current_choice_set,
          match_session_id: liveState.match_session_id,
          expected_candidate_count: 3,
          candidates: liveState.augments.current_choice_set.choices,
        },
      },
    },
  }, null, 2), "utf8");
  const result = await runNode([
    "tools/run-jcc-cruise-runtime-pipeline.mjs",
    "--live-state",
    liveStateFile,
    "--context",
    contextFile,
    "--advice-state",
    lifecycleOut,
    "--mode",
    "augment_choice",
    ...(runtimeEventContext ? ["--runtime-event-context-json", JSON.stringify(runtimeEventContext)] : []),
    "--out",
    pipelineOut,
  ]);
  assert(result.code === 0, `pipeline failed: ${result.stderr || result.stdout}`);
  return JSON.parse(await readFile(pipelineOut, "utf8"));
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-augment-reroll-"));
  try {
    const previousSet = {
      at: "2026-06-11T10:00:00.000Z",
      revision: 1,
      source: "current_match_user_report",
      choices: [
        { name: "自我毁灭", source: "current_match_user_report" },
        { name: "鲜血祭品", source: "current_match_user_report" },
        { name: "神赐锻炉", source: "current_match_user_report" },
      ],
    };
    const currentSet = {
      at: "2026-06-11T10:00:18.000Z",
      revision: 2,
      source: "current_match_user_report",
      choices: [
        { name: "神赐锻炉", slot: 0, source: "current_match_user_report" },
        { name: "DD街区", slot: 1, source: "current_match_user_report" },
        { name: "清晰头脑", slot: 2, source: "current_match_user_report" },
      ],
    };
    const liveState = {
      match_session_id: "augment-reroll-state",
      phase: { stage_round: "3-2", status: 4 },
      economy: { gold: null, hp: null, level: 6, xp: "14/36" },
      board: { board_units: [{ name: "古拉加斯", id: 11400 }] },
      items: { item_bench: [] },
      augments: {
        selected_augments: [{ name: "自我毁灭", source: "user_confirmed" }],
        current_choice_set: currentSet,
        previous_choice_sets: [previousSet],
        choice_set_history: [previousSet, currentSet],
        reroll_policy: {
          normal_total_visible_options: 6,
          special_double_reroll_visible_options: 9,
          current_visible_set_replaces_pending_choices: true,
          history_is_decision_evidence_not_current_choices: true,
        },
      },
    };

    const scored = await score(liveState, tempDir, "host-live");
    const augmentTask = byTrigger(scored.advice_tasks, "augment_choice_advice");
    assert(augmentTask, "latest current-match user report should create supporting scorer evidence");
    const taskText = `${augmentTask.short_advice} ${augmentTask.actions.join(" ")}`;
    assert(taskText.includes("神赐锻炉") || taskText.includes("DD街区") || taskText.includes("清晰头脑"), "advice must use the latest reported choice-set revision");
    assert(!taskText.includes("鲜血祭品"), "previous visible set must not become current advice");
    assert(augmentTask.evidence.some((entry) => entry.type === "augments.choice_history"), "choice history evidence missing");
    assert(augmentTask.actions.some((action) => action.startsWith("choose_augment:")
      || action.startsWith("prefer_augment:")
      || action === "full_reroll_current_set"
      || action.startsWith("reroll_or_hold_backup:")), "augment advice must output choose/prefer/reroll action");

    const factOnly = await pipeline(liveState, tempDir, "fact-only-pipeline");
    assert(!(factOnly.response_events || []).some((event) => event.type === "advice_response_requested"),
      "reported choice facts and augment mode alone must not open the automatic Host lane");

    // Simulate the Runtime-owned event emitted by an explicit card advice action.
    // Scorer evidence and mode selection do not grant this authority.
    const cardEvent = {
      event_key: `structured_card_advice:augment_choice:${liveState.match_session_id}:${currentSet.revision}`,
      event_type: "reported_choices_changed",
      event_category: "choice_advice",
      explicit_user_card_action: true,
      match_session_id: liveState.match_session_id,
      stage_round: liveState.phase.stage_round,
      source_mode: "augment_choice",
      advice_action: "choice_advice",
      reported_choice_set: {
        ...currentSet,
        match_session_id: liveState.match_session_id,
        mode: "augment_choice",
        kind: "augment",
        choice_stage_round: liveState.phase.stage_round,
        expected_candidate_count: 3,
        candidates: currentSet.choices,
      },
    };
    const pipe = await pipeline(liveState, tempDir, "card-advice-pipeline", cardEvent);
    const responses = (pipe.response_events || []).filter((event) => event.type === "advice_response_requested");
    assert(responses.length === 1, "explicit card advice must request exactly one Host answer");
    const response = responses[0];
    assert(response.trigger_id === "runtime_event_followup", "the explicit card event must own the answer, not a scorer task");
    assert(response.mode === "augment_choice", "card advice must retain augment mode");
    const followup = response.followup_sensing_request || response.response_draft?.followup_sensing_request;
    assert(!followup, "reported augment rerolls must not open an OCR or multimodal follow-up sensing request");

    const legacyOnly = {
      match_session_id: "augment-reroll-legacy-only",
      phase: { stage_round: "3-2", status: 4 },
      economy: { gold: 30, hp: 80, level: 6 },
      board: { board_units: [{ name: "古拉加斯" }] },
      augments: {
        verified_choice_candidates: [
          { name: "神赐锻炉", source: "legacy_text_engine" },
          { name: "DD街区", source: "rapidocr_worker" },
          { name: "清晰头脑", source: "legacy_debug_ocr" },
        ],
        choice_candidates: [
          { name: "神赐锻炉", source: "legacy_text_engine" },
          { name: "DD街区", source: "rapidocr_worker" },
          { name: "清晰头脑", source: "legacy_debug_ocr" },
        ],
      },
    };
    const legacyScored = await score(legacyOnly, tempDir, "legacy-only");
    assert(!byTrigger(legacyScored.advice_tasks, "augment_choice_advice"), "legacy text/OCR-only choices must not create visible augment advice");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "latest current-match user report creates supporting scorer evidence",
        "fact-only choice reports do not open the automatic Host lane",
        "explicit card advice creates one runtime-event-owned augment answer",
        "prior report revisions remain evidence only",
        "reported rerolls do not create OCR or multimodal follow-up sensing",
        "legacy text/OCR-only candidates do not create augment advice",
      ],
      action: augmentTask.actions[0],
      latest_report_revision: currentSet.revision,
    }, null, 2));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
