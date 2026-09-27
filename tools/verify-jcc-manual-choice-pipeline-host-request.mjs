import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`node ${args.join(" ")} exited ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function choiceNames(value) {
  return asArray(value).map((entry) => entry?.name || entry?.text || entry?.raw_text).filter(Boolean);
}

function collectStrings(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectStrings(entry, out);
  }
  return out;
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-manual-choice-host-request-"));
  try {
    const liveStateFile = path.join(tempRoot, "live-state.json");
    const contextFile = path.join(tempRoot, "match-context.json");
    const adviceStateFile = path.join(tempRoot, "advice-lifecycle.json");
    const outFile = path.join(tempRoot, "pipeline-result.json");
    const now = "2026-06-24T02:01:08.000Z";

    const choices = [
      { name: "User Report A", display_text: "User Report A", slot: 1, confidence: "user_confirmed_report" },
      { name: "User Report B", display_text: "User Report B", slot: 2, confidence: "user_confirmed_report" },
      { name: "User Report C", display_text: "User Report C", slot: 3, confidence: "user_confirmed_report" },
    ];
    const pollutingVisualChoices = [
      { name: "Visual Pollution A", raw_text: "Visual Pollution A", source: "choice_text_ocr", confidence: 0.99 },
      { name: "Visual Pollution B", raw_text: "Visual Pollution B", source: "host_multimodal_visual", confidence: 0.99 },
      { name: "Visual Pollution C", raw_text: "Visual Pollution C", source: "rapidocr_worker", confidence: 0.99 },
    ];

    await writeFile(liveStateFile, `${JSON.stringify({
      schema: "jcc-cruise-live-state-verify-v1",
      match_session_id: "verify-manual-choice-match",
      phase: { status: "planning", stage_round: "2-1" },
      economy: { hp: 100, gold: 2, level: 3, xp: "0/6" },
      own_board: { units: [{ name: "艾希" }, { name: "纳尔" }] },
      own_bench: { units: [{ name: "莉莉娅" }] },
      shop: { units: [{ name: "凯南" }, { name: "阿木木" }] },
      items: { item_bench: [{ name: "暴风大剑" }, { name: "锁子甲" }, { name: "负极斗篷" }] },
      augments: {
        current_choice_set: {
          source: "choice_text_ocr",
          observed_at: now,
          choices: pollutingVisualChoices,
        },
      },
      visual: {
        augments: { choices: pollutingVisualChoices },
      },
      match_variables: {},
    }, null, 2)}\n`, "utf8");

    await writeFile(contextFile, `${JSON.stringify({
      schema: "jcc-runtime-match-context-v1",
      match_session_id: "verify-manual-choice-match",
      match_variables: {},
      recent_user_messages: [
        { text: "这把先看发牌，偏向法系或永恒之森，但不要硬锁。", observed_at: "2026-06-24T01:59:00.000Z" },
        { text: "选哪个？要不要刷新？", mode: "augment_choice", observed_at: now },
      ],
      observed_choice_options_by_stage: {
        "2-1": {
          kind: "augment",
          source: "choice_text_ocr",
          choices: pollutingVisualChoices,
          observed_at: now,
        },
      },
      reported_choice_sets_by_mode: {
        augment_choice: {
          schema: "jcc-runtime-user-reported-choice-set-v1",
          mode: "augment_choice",
          kind: "augment",
          match_session_id: "verify-manual-choice-match",
          choice_stage_round: "2-1",
          revision: 1,
          source: "current_match_user_report",
          expected_candidate_count: 3,
          candidates: choices,
          observed_at: now,
          current_match_only: true,
        },
      },
      choice_confirmations: [],
      missing_choice_prompts: [],
    }, null, 2)}\n`, "utf8");

    await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", liveStateFile,
      "--context", contextFile,
      "--advice-state", adviceStateFile,
      "--out", outFile,
      "--mode", "augment_choice",
      "--user-message", "选哪个？要不要刷新？",
      "--force-response-reason", "manual_augment_choice_user_request",
      "--now", now,
      "--retain-full-state",
    ]);

    const result = JSON.parse(await readFile(outFile, "utf8"));
    const response = asArray(result.response_events).find((entry) => entry.type === "advice_response_requested");
    assert(response, "manual user-reported augment choice must create an advice_response_requested event for the host model");
    assert(response.status === "awaiting_host_cli_agent_response", "manual augment response must wait for host CLI AI-native answer");
    assert(response.final_response_required === true, "manual augment response must require final host model rendering");
    assert(response.user_visible_text === null, "pipeline/scorer draft must not be treated as final visible advice");
    assert(response.mode === "augment_choice", "manual augment response must stay in augment_choice mode");
    assert(response.output_reason === "manual_augment_choice_user_request", "manual augment response must preserve user-question priority");

    const hostRequest = response.host_cli_agent_request;
    assert(hostRequest?.provider === "current_cli_agent_main_model", "host request must target the current CLI main model");
    assert(hostRequest?.context?.active_user_message === "选哪个？要不要刷新？", "host request must carry the active manual user question");
    assert(hostRequest?.context?.live_state_summary?.stage_round === "2-1", "host request must carry the current stage");
    assert(hostRequest?.context?.game_rule_contract?.current_choice_checkpoint?.kind === "augment", "2-1 host request must mark current augment checkpoint");
    assert(hostRequest?.context?.game_state_brief?.stage_round === "2-1", "host request must carry the compact game state brief");
    assert(hostRequest.context.game_state_brief.current_choice_checkpoint?.kind === "augment", "2-1 brief must mark the current augment checkpoint before generation");
    assert(
      hostRequest.context.game_rule_brief_text?.includes("GAME_RULE_BRIEF:"),
      "manual choice host request must include the plain-language front-loaded game rule brief",
    );
    assert(
      /visible_choice_required_answer:.*augment/i.test(hostRequest.context.game_rule_brief_text)
        && /keep|reroll|refresh/i.test(hostRequest.context.game_rule_brief_text),
      "manual choice host request must front-load the active choice contract so the model answers the choice, not generic cruise advice",
    );
    assert(hostRequest.context.game_rule_contract.visible_choice_window?.candidate_count === 3, "manual choice request must carry the exact three visible candidates");
    assert(
      hostRequest.context.game_rule_brief_text.includes("current_stage: 2-1")
        && hostRequest.context.game_rule_brief_text.includes("unknown_final_selected_choices: augment 2-1"),
      "manual choice game rule brief must front-load current stage and observed unknown augment choices",
    );
    assert(
      hostRequest.context.game_state_brief.current_stage_rule_semantics?.some((line) => line.includes("2-1") && line.includes("choice checkpoint")),
      "manual choice game state brief must explain that 2-1 is a current choice checkpoint before model generation",
    );
    assert(
      hostRequest.context.game_rule_brief_text.includes("current_stage_rule_semantics:"),
      "manual choice GAME_RULE_BRIEF must front-load current-stage semantics in plain language",
    );
    assert(
      hostRequest.context.game_state_brief.forbidden_waiting_for?.some((entry) => entry.kind === "augment" && entry.stage_round === "2-1"),
      "2-1 brief must forbid telling the user to wait for the current augment checkpoint",
    );
    assert(
      hostRequest.context.game_rule_contract.must_not?.some((line) => line.includes("2-1") && line.includes("augment")),
      "2-1 host request must forbid telling the user to wait for the current augment",
    );

    const requestChoiceNames = [
      ...choiceNames(hostRequest.context.live_state_summary.augment_choice_candidates),
      ...collectStrings(hostRequest.context.ranked_augment_recommendation),
      ...collectStrings(hostRequest.task?.evidence),
      ...collectStrings(hostRequest.context.augment_choices),
      ...collectStrings(hostRequest.context.match_context?.reported_choice_sets_by_mode),
      ...collectStrings(hostRequest.context.match_context?.observed_choice_options_by_stage),
    ];
    for (const expected of ["User Report A", "User Report B", "User Report C"]) {
      assert(
        requestChoiceNames.some((value) => value.includes(expected)),
        `host request must include user-reported augment candidate ${expected}; saw ${JSON.stringify(requestChoiceNames)}`,
      );
    }
    assert(
      !requestChoiceNames.some((value) => value.includes("Visual Pollution")),
      `host request must quarantine OCR/visual candidate pollution; saw ${JSON.stringify(requestChoiceNames)}`,
    );
    assert(
      hostRequest.context.augment_choices?.source === "current_match_user_report",
      "host mode choice context must preserve current_match_user_report provenance",
    );
    assert(
      hostRequest.context.ranked_augment_recommendation
        || asArray(hostRequest.task?.evidence).some((entry) => entry?.type === "augments.choice_candidates")
        || asArray(hostRequest.context.augment_choices?.candidates).length === 3
        || asArray(hostRequest.context.match_context?.reported_choice_sets_by_mode?.augment_choice?.candidates).length === 3,
      "host request must include augment choice evidence for AI-native reasoning",
    );
    assert(
      Object.keys(hostRequest.context.match_context?.match_variables || {}).length === 0,
      "S18 manual augment request must not synthesize retired season variables",
    );
    assert(
      asArray(hostRequest.context.match_context?.recent_user_messages).some((entry) => String(entry?.text || entry).includes("永恒之森")),
      "host request must include recent match-session user intent",
    );
    assert(
      hostRequest.context.active_rules_bundle == null,
      "per-turn manual choice request must not replay the static active rules bundle already loaded in the provider session",
    );
    assert(
      /keep|reroll|refresh/i.test(hostRequest.context.game_rule_contract.visible_choice_window?.required_answer || ""),
      "visible choice window must carry the active Common choice answer contract",
    );
    assert(
      hostRequest.context.current_turn_contract?.rules_source_fingerprint?.length === 64,
      "manual choice turn must bind the static provider-session rules by fingerprint instead of replaying them",
    );

    const unknownStageLiveStateFile = path.join(tempRoot, "live-state-unknown-stage.json");
    const unknownStageContextFile = path.join(tempRoot, "match-context-unknown-stage.json");
    const unknownStageOutFile = path.join(tempRoot, "pipeline-result-unknown-stage.json");
    await writeFile(unknownStageLiveStateFile, `${JSON.stringify({
      schema: "jcc-cruise-live-state-verify-v1",
      match_session_id: "verify-manual-choice-stage-unknown-match",
      phase: { status: "augment_choice", stage_round: null },
      economy: { hp: null, gold: null, level: null, xp: null },
      augments: {
        current_choice_set: {
          source: "choice_text_ocr",
          observed_at: now,
          choices: pollutingVisualChoices,
        },
      },
    }, null, 2)}\n`, "utf8");
    await writeFile(unknownStageContextFile, `${JSON.stringify({
      schema: "jcc-runtime-match-context-v1",
      match_session_id: "verify-manual-choice-stage-unknown-match",
      reported_choice_sets_by_mode: {
        augment_choice: {
          schema: "jcc-runtime-user-reported-choice-set-v1",
          mode: "augment_choice",
          kind: "augment",
          match_session_id: "verify-manual-choice-stage-unknown-match",
          choice_stage_round: null,
          revision: 1,
          source: "current_match_user_report",
          expected_candidate_count: 3,
          candidates: choices,
          observed_at: now,
          current_match_only: true,
        },
      },
    }, null, 2)}\n`, "utf8");

    await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", unknownStageLiveStateFile,
      "--context", unknownStageContextFile,
      "--advice-state", path.join(tempRoot, "advice-lifecycle-unknown-stage.json"),
      "--out", unknownStageOutFile,
      "--mode", "augment_choice",
      "--user-message", "閫夊摢涓紵瑕佷笉瑕佸埛鏂帮紵",
      "--force-response-reason", "manual_augment_choice_user_request",
      "--now", now,
      "--retain-full-state",
    ]);
    const unknownStageResult = JSON.parse(await readFile(unknownStageOutFile, "utf8"));
    const unknownStageResponse = asArray(unknownStageResult.response_events).find((entry) => entry.type === "advice_response_requested");
    assert(unknownStageResponse, "manual user-reported augment choice must request host response even when HUD stage is missing");
    const unknownStageHostRequest = unknownStageResponse.host_cli_agent_request;
    assert(
      unknownStageHostRequest.context.game_rule_contract?.visible_choice_window?.kind === "augment",
      "manual augment host request must mark visible_choice_window=augment when the user reports three candidates but HUD stage is missing",
    );
    assert(
      unknownStageHostRequest.context.game_state_brief?.visible_choice_window?.kind === "augment",
      "manual augment game_state_brief must preserve the visible choice window as current evidence",
    );
    assert(
      unknownStageHostRequest.context.game_rule_brief_text.includes("visible augment choice window")
        && unknownStageHostRequest.context.game_rule_brief_text.includes("Answer this choice directly"),
      "manual augment GAME_RULE_BRIEF must tell the model to answer the visible choice directly even if stage is unknown",
    );
    assert(
      unknownStageHostRequest.context.game_rule_contract.must?.some((line) => line.includes("visible augment choice window") && line.includes("Answer")),
      "manual augment game_rule_contract must make current-match user-reported candidates enough for answer generation",
    );

    console.log(JSON.stringify({
      ok: true,
      schema: "jcc-user-reported-choice-pipeline-host-request-verifier-v1",
      response_id: response.response_id,
      output_reason: response.output_reason,
      stage_round: hostRequest.context.live_state_summary.stage_round,
      unknown_stage_visible_choice_window: unknownStageHostRequest.context.game_rule_contract.visible_choice_window?.kind || null,
      candidates: requestChoiceNames,
      current_choice_checkpoint: hostRequest.context.game_rule_contract.current_choice_checkpoint,
      coach_rules_brief: hostRequest.context.coach_rules_brief,
      coach_signature_contract: hostRequest.context.coach_signature_contract,
      game_state_brief: hostRequest.context.game_state_brief,
      match_variables: hostRequest.context.match_context.match_variables,
      recent_user_messages: hostRequest.context.match_context.recent_user_messages,
    }, null, 2));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
