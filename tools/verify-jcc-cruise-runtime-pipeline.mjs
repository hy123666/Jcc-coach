import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const activeRankingPointer = JSON.parse(await readFile(
  path.resolve(import.meta.dirname, "..", "data", "live-rankings", "jcc", "active-generation.json"),
  "utf8",
));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => resolve({
      code: 1,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: error.message || String(error),
    }));
    child.on("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    }));
  });
}

function hasMojibakeText(value) {
  const text = String(value || "");
  const markerCodes = [0xfffd, 0x951b, 0x9286, 0x9225, 0x934a, 0x9348, 0x5a34, 0x9423, 0x6769, 0x7441, 0x741b, 0x95b2, 0x7ed7, 0x95c1];
  return markerCodes.some((code) => text.includes(String.fromCharCode(code)))
    || /\?{3,}/.test(text);
}

function mojibakePaths(value, currentPath = "$", output = []) {
  if (typeof value === "string") {
    if (hasMojibakeText(value)) {
      const suspectCodes = [...value]
        .filter((character) => [0xfffd, 0x951b, 0x9286, 0x9225, 0x934a, 0x9348, 0x5a34, 0x9423, 0x6769, 0x7441, 0x741b, 0x95b2, 0x7ed7, 0x95c1].includes(character.codePointAt(0)))
        .map((character) => `U+${character.codePointAt(0).toString(16).toUpperCase()}`);
      output.push(`${currentPath}=${JSON.stringify(value.slice(0, 180))}[${suspectCodes.join(",")}]`);
    }
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => mojibakePaths(entry, `${currentPath}[${index}]`, output));
    return output;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, entry]) => mojibakePaths(entry, `${currentPath}.${key}`, output));
  }
  return output;
}

async function main() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "jcc-cruise-runtime-pipeline-"));
  try {
    const liveState = {
      match_session_id: "pipeline-match",
      phase: { stage_round: "3-2", status: 1 },
      economy: { gold: 19, hp: 54, level: 6 },
      board: {
        local_board_units_candidate: [
          {
            id: 11471,
            base_id: 1471,
            name: "Diana",
            star: 2,
            position: {
              source: "mumu_gi_xy",
              x: 803,
              y: 582,
              area: "board",
              board_grid: {
                source: "mumu_gi_xy_calibrated_board_grid",
                row: 1,
                row_from_top: 1,
                col: 4,
                col_from_left: 4,
                col_from_right: 4,
                confidence: 0.96,
              },
            },
          },
          { id: 11452, base_id: 1452, name: "Leona", star: 1 },
          { id: 11453, base_id: 1453, name: "Nasus", star: 1 }
        ]
      },
      field_status: {
        "board.local_board_units_candidate": {
          status: "candidate",
          promotion_policy: "shop_self_view_anchor_plus_fresh_current_view",
          shop_anchor_fresh: true,
          bench_overlap_count: 1,
        },
      },
      bench: {
        bench_units: [
          { id: 11471, base_id: 1471, name: "Diana" },
          { id: 11471, base_id: 1471, name: "Diana" },
          { id: 11452, base_id: 1452, name: "Leona" },
          { id: 11460, base_id: 1460, name: "Illaoi" },
          { id: 11461, base_id: 1461, name: "Aurora" },
          { id: 11462, base_id: 1462, name: "Poppy" },
          { id: 11463, base_id: 1463, name: "Teemo" },
          { id: 11464, base_id: 1464, name: "Nasus" }
        ]
      },
      shop: {
        shop_units: [
          { id: 11471, base_id: 1471, name: "Diana" },
          { id: 11452, base_id: 1452, name: "Leona" },
          { id: 11452, base_id: 1452, name: "Leona" },
          { id: 11499, base_id: 1499, name: "Jinx" },
          { id: 11501, base_id: 1501, name: "Morgana" }
        ]
      },
      items: {
        item_bench: [
          { id: 1001, name: "B. F. Sword", source: "mumu_4357_item_bench", promotion_policy: "structured_4357_left_item_rail_primary" },
          { id: 1005, name: "Recurve Bow", source: "mumu_4357_item_bench", promotion_policy: "structured_4357_left_item_rail_primary" },
          { id: 92001, name: "fixture-emblem-a", source: "mumu_4357_item_bench", promotion_policy: "structured_4357_left_item_rail_primary" },
          { id: 92002, name: "fixture-emblem-b", source: "mumu_4357_item_bench", promotion_policy: "structured_4357_left_item_rail_primary" },
          { id: 92003, name: "fixture-remover", source: "mumu_4357_item_bench", promotion_policy: "structured_4357_left_item_rail_primary" }
        ],
        item_bench_candidates: [
          { id: 1007, name: "Giant Belt icon validation", source: "left_item_rail_roi_icon" }
        ]
      },
      augments: {
        selected_augments: [{ name: "raw-unconfirmed-selected-augment", observed_at: "2026-01-01T00:00:00.000Z", source: "vision_model" }],
        choice_candidates: [
          { name: "fixture-choice-a", at: "2026-01-01T00:00:00.000Z", confidence: 0.9 },
          { name: "fixture-choice-b", at: "2026-01-01T00:00:00.000Z", confidence: 0.9 },
          { name: "fixture-choice-c", at: "2026-01-01T00:00:00.000Z", confidence: 0.9 },
          { name: "fixture-choice-d", at: "2026-01-01T00:00:10.000Z", confidence: 0.9 },
          { name: "fixture-choice-e", at: "2026-01-01T00:00:10.000Z", confidence: 0.9 },
          { name: "鐗╁敖鍏剁敤+", at: "2026-01-01T00:00:10.000Z", confidence: 0.9 }
        ]
      },
      visual: {
        frame_id: "frame-non-self-current-view-diagnostic",
        augments: {
          choices: [
            { name: "host_choice_a", confidence: 0.91, source: "host_multimodal_visual_fixture" },
            { name: "host_choice_b", confidence: 0.9, source: "host_multimodal_visual_fixture" },
            { name: "host_choice_c", confidence: 0.9, source: "host_multimodal_visual_fixture" }
          ]
        },
        items: {
          item_bench: [
            { id: 777001, name: "should-not-override-own-item-bench", owner_scope: "non_self_current_view_diagnostic" }
          ],
          equipped_items: [
            { id: 777002, name: "should-not-override-own-equipped-items", owner_scope: "non_self_current_view_diagnostic" },
            {
              id: 777005,
              name: "host vision equipped candidate without mumu gate",
              source: "vision_model",
              owner_scope: "self",
              assignment_status: "assigned",
              phase_gate: { promotion_allowed_after_roi_calibration: false }
            }
          ]
        },
      },
      strategy: {
        streak_plan: { type: "lose_streak", active: true, current_streak: 3 }
      }
    };
    const context = {
      target_plan: {
        id: "phantom-diana",
        name: "Phantom Diana",
        core_unit_ids: [11471, 1471],
        unit_ids: [11471, 1471, 11452, 1452, 11460, 1460, 11461, 1461],
        unit_names: ["Diana", "Leona", "Illaoi", "Aurora"]
      },
      match_variables: {
        emblem_choice_encounter: {
          offered_emblems: ["fixture-emblem-a", "fixture-emblem-b", "fixture-emblem-c"],
          remover_consumable_count: 1
        }
      },
      match_context: {
        match_session_id: "pipeline-match",
        reported_choice_sets_by_mode: {
          augment_choice: {
            schema: "jcc-runtime-user-reported-choice-set-v1",
            mode: "augment_choice",
            kind: "augment",
            match_session_id: "pipeline-match",
            choice_stage_round: "3-2",
            revision: 1,
            source: "current_match_user_report",
            expected_candidate_count: 3,
            candidates: [
              { name: "reported-choice-d", slot: 1, confidence: "user_confirmed_report" },
              { name: "reported-choice-e", slot: 2, confidence: "user_confirmed_report" },
              { name: "reported-choice-f", slot: 3, confidence: "user_confirmed_report" }
            ],
            observed_at: "2026-01-01T00:00:10.000Z",
            current_match_only: true
          }
        },
        choice_confirmations: [
          {
            kind: "augment",
            choice_stage_round: "2-1",
            choice: "confirmed-context-augment",
            source: "user_confirmed_runtime_ui_or_chat",
            confirmed_at: "2026-01-01T00:00:00.000Z"
          },
          {
            kind: "augment",
            choice_stage_round: "3-2",
            choice: { name: "confirmed-owned-panel-augment", entity_id: 9002 },
            source: "user_triggered_owned_augment_text_panel_ocr",
            confirmed_at: "2026-01-01T00:00:05.000Z"
          },
          {
            kind: "augment",
            match_session_id: "previous-match",
            choice_stage_round: "4-2",
            choice: "stale-cross-match-augment",
            source: "user_confirmed_runtime_ui_or_chat",
            confirmed_at: "2026-01-01T00:00:10.000Z"
          }
        ]
      }
    };
    const liveFile = path.join(tmp, "live.json");
    const contextFile = path.join(tmp, "context.json");
    const lifecycleFile = path.join(tmp, "advice-lifecycle.json");
    const outFile = path.join(tmp, "pipeline.json");
    await writeFile(liveFile, JSON.stringify(liveState, null, 2), "utf8");
    await writeFile(contextFile, JSON.stringify(context, null, 2), "utf8");
    const initialStrategicEvent = JSON.stringify({
      event_key: "pipeline-match|line_decision_context_changed|initial",
      event_type: "line_decision_context_changed",
      event_category: "line_decision_context",
      decision_trigger_id: "lineup_convergence_checkpoint",
      fixed_checkpoint_id: "direction_exploration",
      stage_round: "2-2",
      semantic_labels: ["lineup_convergence_checkpoint"],
    });

    const redactedLifecycleFile = path.join(tmp, "advice-lifecycle-redacted.json");
    const redactedOutFile = path.join(tmp, "pipeline-redacted.json");
    const redacted = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", liveFile,
      "--context", contextFile,
      "--advice-state", redactedLifecycleFile,
      "--out", redactedOutFile,
      "--runtime-event-context-json", initialStrategicEvent,
      "--now", "2026-01-01T00:00:00.000Z",
    ]);
    assert(redacted.code === 0, `redacted pipeline failed\n${redacted.stdout}\n${redacted.stderr}`);
    const firstOutResult = JSON.parse(await readFile(redactedOutFile, "utf8"));
    assert(firstOutResult.schema === "jcc-cruise-runtime-pipeline-result-redacted-v1", "--out must be redacted by default");
    assert(firstOutResult.storage_policy?.full_live_state_saved === false, "redacted --out must not save full live_state");
    const redactedStdout = JSON.parse(redacted.stdout);
    assert(redactedStdout.schema === "jcc-cruise-runtime-pipeline-output-ref-v1", "stdout must be metadata-only by default");
    assert(redactedStdout.storage_policy === "metadata_only_stdout", "stdout must not carry the full redacted pipeline result");

    const first = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", liveFile,
      "--context", contextFile,
      "--advice-state", lifecycleFile,
      "--out", outFile,
      "--retain-full-state",
      "--runtime-event-context-json", initialStrategicEvent,
      "--now", "2026-01-01T00:00:00.000Z",
    ]);
    assert(first.code === 0, `first pipeline failed\n${first.stdout}\n${first.stderr}`);
    const firstResult = JSON.parse(await readFile(outFile, "utf8"));
    assert(firstResult.schema === "jcc-cruise-runtime-pipeline-result-v1", "pipeline schema mismatch");
    assert(!firstResult.standardized_live_state?.opponents?.snapshots?.length, "pipeline must not standardize visual current-view facts as opponent snapshots");
    assert(!firstResult.standardized_live_state?.items?.item_bench?.some((item) => String(item.id) === "777001"), "opponent visual item bench must not pollute own item bench");
    assert(!firstResult.standardized_live_state?.items?.equipped_items?.some((item) => String(item.id) === "777002"), "opponent visual equipped items must not pollute own equipped items");
    assert(!firstResult.standardized_live_state?.items?.equipped_items?.some((item) => String(item.id) === "777005"), "host vision equipped candidates must not enter own equipped_items without 4356->4353 own-unit gate");
    assert(!firstResult.standardized_live_state?.augments?.selected_augments?.some((augment) => augment.name === "raw-unconfirmed-selected-augment"), "raw visual selected_augments must not become final selected augment facts");
    assert(firstResult.standardized_live_state?.augments?.selected_augment_candidates?.some((augment) => augment.name === "raw-unconfirmed-selected-augment" && augment.provenance?.status === "requires_confirmation"), "raw visual selected_augments should be retained only as requires-confirmation candidates");
    assert(firstResult.standardized_live_state?.augments?.selected_augments?.some((augment) => augment.name === "confirmed-context-augment" && augment.choice_stage_round === "2-1"), "match_context choice confirmation must become final selected augment fact");
    assert(firstResult.standardized_live_state?.augments?.selected_augments?.some((augment) => augment.name === "confirmed-owned-panel-augment" && augment.choice_stage_round === "3-2" && augment.source === "user_triggered_owned_augment_text_panel_ocr"), "owned-panel OCR confirmation must become final selected augment fact when stage-bound");
    assert(!firstResult.standardized_live_state?.augments?.selected_augments?.some((augment) => augment.name === "stale-cross-match-augment"), "cross-match choice confirmation must not become final selected augment fact");
    assert(firstOutResult.storage_policy?.full_estimator_context_saved === false, "redacted --out must not save full estimator context");
    assert(!Object.hasOwn(firstOutResult, "standardized_live_state"), "redacted --out must not embed standardized_live_state");
    assert(!Object.hasOwn(firstOutResult, "estimator_context"), "redacted --out must not embed estimator_context");
    assert(firstOutResult.standardized_live_state_summary?.counts?.board_units === 3, "redacted --out must retain compact live_state summary");
    assert(firstOutResult.standardized_live_state_summary?.samples?.board_units?.[0]?.name === "Diana", "redacted --out must retain compact live_state samples");
    assert(firstResult.match_session_id === "pipeline-match", "match session mismatch");
    assert(firstResult.standardized_live_state?.schema === "jcc-runtime-live-state-standard-v1", "standardized live_state missing");
    assert(firstResult.standardized_live_state.own_board.units.every((unit) => unit.provenance?.source === "mumu_bridge_shop_self_view_anchor"), "board unit provenance missing");
    const dianaBoardUnit = firstResult.standardized_live_state.own_board.units.find((unit) => unit.name === "Diana");
    assert(dianaBoardUnit?.position?.board_grid?.row === 1, "own_board board_grid row should survive standardization");
    assert(dianaBoardUnit?.position?.board_grid?.col === 4, "own_board board_grid col should survive standardization");
    const dianaHostSummaryUnit = firstResult.response_events
      ?.find((event) => event.type === "advice_response_requested" && event.host_cli_agent_request?.context?.live_state_summary)
      ?.host_cli_agent_request
      ?.context
      ?.live_state_summary
      ?.own_board
      ?.units
      ?.find((unit) => unit.name === "Diana");
    assert(dianaHostSummaryUnit?.board_grid?.row === 1, `host live_state_summary should expose own_board board_grid row: ${JSON.stringify(firstResult.response_events
      ?.filter((event) => event.type === "advice_response_requested")
      .map((event) => ({
        trigger_id: event.host_cli_agent_request?.context?.cruise_decision_context?.decision_trigger_id || null,
        live_state_summary: event.host_cli_agent_request?.context?.live_state_summary?.own_board || null,
      })) || [])}`);
    assert(dianaHostSummaryUnit?.board_grid?.col === 4, "host live_state_summary should expose own_board board_grid col");
    assert(!firstResult.standardized_live_state.own_bench.units.some((unit) => unit.position?.board_grid), "bench units must not gain board_grid");
    assert(!firstResult.standardized_live_state.shop.units.some((unit) => unit.position?.board_grid), "shop units must not gain board_grid");
    assert(firstResult.standardized_live_state.economy.gold.source === "economy_small_roi_interim", "economy provenance missing");
    assert(firstResult.estimator_context?.context?.combat_cap_estimator, "estimator context missing");
    assert(firstResult.score?.advice_tasks?.length > 0, "first pipeline should emit advice tasks");
    assert(firstResult.lifecycle?.active_tasks?.length === firstResult.score.advice_tasks.length, "lifecycle active tasks mismatch");
    assert(firstResult.lifecycle.active_tasks.every((task) => task.expires_at), "active task expiry missing");
    assert(firstResult.events.some((event) => event.type === "advice_task_created"), "created events missing");
    assert(firstResult.response_events.some((event) => event.type === "advice_response_requested"), "response request event missing");
    assert(firstResult.response_events.some((event) => event.response_draft?.title && event.ai_native_policy?.allow_model_to_rephrase), "ai-native response draft missing");
    const firstAdviceResponse = firstResult.response_events.find((event) => event.type === "advice_response_requested");
    assert(firstAdviceResponse?.ai_native_policy?.output_model === "host_cli_main_model_required", "AI-native coach output must require the host CLI main model");
    const outputContract = JSON.parse(await readFile("data/runtime/jcc/cruise-agent-output-loop-contract.json", "utf8"));
    assert(outputContract.ai_native_output_policy?.host_model_contract?.final_user_visible_semantic_advice_must_come_from_host_model === true, "output contract must require host CLI model semantic advice");
    assert(outputContract.ai_native_output_policy?.host_model_contract?.runtime_may_attach_canonical_fact_appendix === true, "output contract must allow Runtime to attach sealed canonical facts without rewriting Host advice");
    assert(outputContract.ai_native_output_policy?.host_model_contract?.backend_latest_backend_draft_must_not_be_displayed_as_final === true, "output contract must forbid backend draft as final text");
    assert(outputContract.ai_native_output_policy?.host_model_contract?.watcher_latest_advice_must_remain_null_until_host_response === true, "output contract must keep watcher latest_advice null until host response");
    assert(outputContract.ai_native_output_policy?.host_model_contract?.ui_must_read_final_response_from?.includes("advice_response.coach_response.user_visible_text"), "UI contract must point at host coach final text");
    assert(outputContract.ai_native_output_policy?.host_model_contract?.ui_must_not_read_final_response_from?.includes("cruise_pipeline.latest_backend_draft"), "UI contract must not read latest_backend_draft as final");
    assert(firstAdviceResponse?.ai_native_policy?.structured_envelope_required === true, "structured envelope requirement missing");
    assert(firstAdviceResponse?.ai_native_policy?.require_model_rendering === true, "host model rendering requirement missing");
    assert(firstAdviceResponse?.ai_native_policy?.fallback_is_not_final_answer === true, "fallback text must not be treated as final answer");
    assert(firstAdviceResponse?.final_response_required === true, "final coach response must be generated by host CLI model");
    assert(firstAdviceResponse?.status === "awaiting_host_cli_agent_response", "response event should wait for host CLI model response");
    assert(firstAdviceResponse?.user_visible_text === null, "pipeline must not expose fallback text as final user_visible_text");
    assert(firstAdviceResponse?.host_cli_agent_request?.provider === "current_cli_agent_main_model", "host CLI coach request missing");
    assert(firstAdviceResponse?.host_cli_agent_request?.request_id === firstAdviceResponse.response_id, "host CLI coach request must be bound to response_id");
    assert(firstAdviceResponse?.host_cli_agent_request?.request_hash, "host CLI coach request hash missing");
    assert(firstAdviceResponse?.host_cli_agent_request?.context?.live_state_summary?.items?.item_bench_count === 5, "host live_state summary must expose item bench count");
    assert(Array.isArray(firstAdviceResponse?.host_cli_agent_request?.context?.live_state_summary?.items?.item_bench), "host live_state summary must expose compact item bench entries");
    assert(firstAdviceResponse.host_cli_agent_request.context.live_state_summary.items.item_bench.some((item) => item.name === "B. F. Sword"), "host live_state summary must carry item names");
    assert(firstAdviceResponse.host_cli_agent_request.context.live_state_summary.augments.selected_augments.some((augment) => augment.name === "confirmed-owned-panel-augment"), "host live_state summary must expose confirmed selected augments");
    assert(!firstAdviceResponse.host_cli_agent_request.context.live_state_summary.augments.selected_augments.some((augment) => augment.name === "raw-unconfirmed-selected-augment"), "host live_state summary must not expose raw selected augment candidates as final facts");
    assert(!Object.hasOwn(firstAdviceResponse, "fallback_visible_text"), "normal advice response event must not expose fallback_visible_text");
    assert(!Object.hasOwn(firstAdviceResponse.response_draft, "fallback_visible_text"), "response draft must not expose fallback_visible_text");
    assert(
      !hasMojibakeText(JSON.stringify(firstAdviceResponse.host_cli_agent_request)),
      `host CLI coach request must not carry mojibake text: ${mojibakePaths(firstAdviceResponse.host_cli_agent_request).slice(0, 8).join(" | ")}`,
    );
    assert(firstAdviceResponse?.ai_native_policy?.rendering_policy?.agent_can_merge_fields === true, "rendering policy must allow merging fields");
    assert(firstAdviceResponse?.ai_native_policy?.rendering_policy?.why_and_evidence_expandable === true, "rendering policy must make why/evidence expandable");
    assert(firstAdviceResponse?.ai_native_policy?.rendering_policy?.do_not_render_as_table_by_default === true, "rendering policy must avoid table rendering by default");
    const strategicLiveFile = path.join(tmp, "strategic-live.json");
    const strategicContextFile = path.join(tmp, "strategic-context.json");
    const strategicOutFile = path.join(tmp, "strategic-pipeline.json");
    await writeFile(strategicLiveFile, JSON.stringify({
      ...liveState,
      match_session_id: "pipeline-strategic-match",
      phase: { stage_round: "3-5", status: 1 },
      economy: { gold: 42, hp: 71, level: 7 },
    }, null, 2), "utf8");
    await writeFile(strategicContextFile, JSON.stringify({
      ...context,
       live_rankings_context: {
         ranking_overlay_id: activeRankingPointer.generation_id,
        lineup_groups: [{
          lineup_group_id: "fixture-atomic-pipeline-line",
          main_trait_list: [{ trait_name: "Fixture Trait", breakpoint: 4 }],
          core_units: [
            { champion_id: "fixture-carry", champion_name: "Fixture Carry" },
            { champion_id: "fixture-tank", champion_name: "Fixture Tank" },
            { champion_id: "fixture-support", champion_name: "Fixture Support" },
            { champion_id: "fixture-unit-4", champion_name: "Fixture Unit 4" },
            { champion_id: "fixture-unit-5", champion_name: "Fixture Unit 5" },
            { champion_id: "fixture-unit-6", champion_name: "Fixture Unit 6" },
            { champion_id: "fixture-unit-7", champion_name: "Fixture Unit 7" },
            { champion_id: "fixture-unit-8", champion_name: "Fixture Unit 8" },
          ],
          main_carry: { champion_id: "fixture-carry", champion_name: "Fixture Carry", cost: 3 },
          primary_tank: { champion_id: "fixture-tank", champion_name: "Fixture Tank", cost: 4 },
          main_carry_item_packages: [{
            population: 8,
            item_names: ["Fixture Damage Item", "Fixture Mana Item"],
          }],
          variants: [{
            variant_id: "fixture-atomic-8",
            atomic_roster_id: "fixture-atomic-roster-8",
            candidate_evidence_id: "fixture-atomic-evidence-8",
            roster_is_atomic: true,
            population: 8,
            lineup_names: [
              "Fixture Carry",
              "Fixture Tank",
              "Fixture Support",
              "Fixture Unit 4",
              "Fixture Unit 5",
              "Fixture Unit 6",
              "Fixture Unit 7",
              "Fixture Unit 8",
            ],
            core_units: [
              { champion_id: "fixture-carry", champion_name: "Fixture Carry" },
              { champion_id: "fixture-tank", champion_name: "Fixture Tank" },
              { champion_id: "fixture-support", champion_name: "Fixture Support" },
              { champion_id: "fixture-unit-4", champion_name: "Fixture Unit 4" },
              { champion_id: "fixture-unit-5", champion_name: "Fixture Unit 5" },
              { champion_id: "fixture-unit-6", champion_name: "Fixture Unit 6" },
              { champion_id: "fixture-unit-7", champion_name: "Fixture Unit 7" },
              { champion_id: "fixture-unit-8", champion_name: "Fixture Unit 8" },
            ],
            transitions: [{
              semantic_role: "published_transition",
              population: 5,
              lineup_names: ["Fixture Carry", "Fixture Frontline"],
            }],
          }],
          formation_profile: { target_population: 8, formation_burden: "medium" },
          lifecycle_prior: { archetype: "level_8_operation", target_population: 8 },
          recipe_match: { classification: "exact" },
        }],
      },
    }, null, 2), "utf8");
    const strategicEvent = JSON.stringify({
      event_key: "pipeline-strategic-match|line_decision_context_changed|lineup",
      event_type: "line_decision_context_changed",
      event_category: "line_decision_context",
      decision_trigger_id: "lineup_convergence_checkpoint",
      fixed_checkpoint_id: "three_cost_reroll_or_operation",
      stage_round: "3-5",
      semantic_labels: ["provisional_commit"],
      coach_content_agenda: {
        schema: "jcc-proactive-coach-content-agenda-v1",
        required_decisions: ["name_primary_and_backup"],
      },
    });
    const strategic = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", strategicLiveFile,
      "--context", strategicContextFile,
      "--live-rankings", "data/live-rankings/jcc/current/lineup-strategy-index.json",
      "--runtime-event-context-json", strategicEvent,
      "--advice-state", path.join(tmp, "strategic-lifecycle.json"),
      "--out", strategicOutFile,
      "--retain-full-state",
      "--now", "2026-01-01T00:00:08.000Z",
    ]);
    assert(strategic.code === 0, `strategic pipeline failed\n${strategic.stdout}\n${strategic.stderr}`);
    const strategicResult = JSON.parse(await readFile(strategicOutFile, "utf8"));
    const strategicResponse = strategicResult.response_events.find((event) => event.type === "advice_response_requested"
      && event.host_cli_agent_request?.context?.cruise_decision_context?.decision_trigger_id === "lineup_convergence_checkpoint");
    const strategicDecisionContext = strategicResponse?.host_cli_agent_request?.context?.cruise_decision_context;
    assert(strategicDecisionContext?.decision_trigger_id === "lineup_convergence_checkpoint", `strategic pipeline request must preserve the lineup trigger: ${JSON.stringify({
      responseEvents: strategicResult.response_events.map((event) => ({
        type: event.type,
        task_id: event.task_id,
        trigger_id: event.trigger_id,
        decision_trigger_id: event.host_cli_agent_request?.context?.cruise_decision_context?.decision_trigger_id || null,
        fixed_checkpoint_id: event.host_cli_agent_request?.task?.fixed_checkpoint_id || null,
      })),
      activeTasks: strategicResult.lifecycle.active_tasks.map((task) => ({
        task_id: task.task_id,
        trigger_id: task.trigger_id,
        decision_trigger_id: task.decision_trigger_id || null,
        fixed_checkpoint_id: task.fixed_checkpoint_id || null,
        event_key: task.event_key || null,
      })),
      scoreTasks: strategicResult.score.advice_tasks.map((task) => ({
        task_id: task.task_id,
        trigger_id: task.trigger_id,
        decision_trigger_id: task.decision_trigger_id || null,
        fixed_checkpoint_id: task.fixed_checkpoint_id || null,
      })),
    })}`);
    assert(strategicDecisionContext?.strategy_fit_packet?.source === "pipeline_strategic_request", "strategic pipeline request must not fall back to pipeline_minimal");
    assert(strategicDecisionContext?.strategy_fit_packet?.big_data_support?.strength_metrics_are_deterministic === true, `strategic pipeline must declare deterministic Ranking facts: ${JSON.stringify(strategicResult.response_events.map((event) => ({ type: event.type, trigger_id: event.trigger_id, decision_trigger_id: event.host_cli_agent_request?.context?.cruise_decision_context?.decision_trigger_id, source: event.host_cli_agent_request?.context?.cruise_decision_context?.strategy_fit_packet?.source })))}`);
    assert(strategicDecisionContext?.strategy_fit_packet?.candidate_working_set_count >= 5
      && strategicDecisionContext?.strategy_fit_packet?.candidate_working_set_count <= 10,
      `strategic pipeline must carry a bounded complete Ranking working set: ${JSON.stringify({
        count: strategicDecisionContext?.strategy_fit_packet?.candidate_working_set_count,
        source_count: strategicDecisionContext?.strategy_fit_packet?.candidate_working_set_source_count,
        ids: strategicDecisionContext?.strategy_fit_packet?.candidate_working_set?.map((candidate) => candidate.candidate_id),
      })}`);
    assert(strategicDecisionContext?.strategy_fit_packet?.candidate_working_set_source_count
      >= strategicDecisionContext?.strategy_fit_packet?.candidate_working_set_count,
      "strategic pipeline must preserve source count as audit metadata");
    assert(strategicResponse?.host_cli_agent_request?.context?.coach_content_agenda, "strategic pipeline must carry the coach content agenda");
    assert(strategicResponse?.host_cli_agent_request?.context?.ranking_working_set_hint >= 5
      && strategicResponse?.host_cli_agent_request?.context?.ranking_working_set_hint <= 10,
      "strategic pipeline must request a bounded Ranking working-set hint");
    assert(
      /complete checkpoint agenda/i.test(strategicResponse?.host_cli_agent_request?.expected_response_shape?.final_text || ""),
      "runtime_event_followup with a strategic decision trigger must receive the strategic response contract",
    );
    assert(
      strategicResponse?.host_cli_agent_request?.task?.decision_trigger_id === "lineup_convergence_checkpoint",
      "strategic decision identity must survive task compaction",
    );
    const atomicPipelineCandidate = strategicDecisionContext.strategy_fit_packet.candidate_working_set
      .find((candidate) => candidate.candidate_id === "fixture-atomic-pipeline-line");
    assert(atomicPipelineCandidate, "strategic pipeline must preserve the detailed atomic candidate supplied by the active Ranking context");
    assert(atomicPipelineCandidate.core_units.length === 8, "strategic pipeline must preserve the complete candidate roster evidence");
    assert(atomicPipelineCandidate.variants[0].lineup_names.length === 8, `strategic pipeline must preserve the candidate population variant roster: ${JSON.stringify(atomicPipelineCandidate.variants)}`);
    assert(atomicPipelineCandidate.variants[0].transitions[0].population === 5, "strategic pipeline must preserve the candidate transition path");
    assert(atomicPipelineCandidate.main_carry_item_packages[0].item_names.length === 2, "strategic pipeline must preserve candidate item evidence");
    const activeStrategyIndex = JSON.parse(await readFile("data/live-rankings/jcc/current/lineup-strategy-index.json", "utf8"));
    const activeCompleteCandidate = Object.values(activeStrategyIndex.tiers || {})
      .flatMap((tier) => tier?.lineup_candidates || [])
      .find((candidate) => candidate?.core_units?.length >= 8
        && candidate?.variants?.some((variant) => variant?.lineup_names?.length >= 8));
    assert(activeCompleteCandidate?.lineup_group_id, "the active detailed Ranking strategy index must expose a complete candidate identity");
    const activeIndexCandidate = strategicDecisionContext.strategy_fit_packet.candidate_working_set
      .find((candidate) => candidate.candidate_id === activeCompleteCandidate.lineup_group_id);
    assert(activeIndexCandidate, "strategic pipeline must consume the active detailed Ranking strategy index");
    assert(activeIndexCandidate.core_units?.length >= 8, "active Ranking candidates must carry their complete atomic roster");
    assert(activeIndexCandidate.variants?.some((variant) => variant.lineup_names?.length >= 8), "active Ranking candidates must carry a complete population variant");
    const pendingStrategicLifecycleFile = path.join(tmp, "pending-strategic-lifecycle.json");
    const pendingStrategicLifecycle = JSON.parse(await readFile(path.join(tmp, "strategic-lifecycle.json"), "utf8"));
    pendingStrategicLifecycle.output_history = [];
    await writeFile(pendingStrategicLifecycleFile, JSON.stringify(pendingStrategicLifecycle, null, 2), "utf8");
    const ordinaryEvent = JSON.stringify({
      event_key: "pipeline-strategic-match|shop_decision_context_changed|ordinary",
      event_type: "shop_decision_context_changed",
      event_category: "shop_decision_context",
      decision_trigger_id: "shop_hold_sell_interest",
      stage_round: "3-5",
      semantic_labels: ["shop_decision_context"],
    });
    const ordinaryOutFile = path.join(tmp, "ordinary-event-pipeline.json");
    const ordinary = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", strategicLiveFile,
      "--context", strategicContextFile,
      "--live-rankings", "data/live-rankings/jcc/current/lineup-strategy-index.json",
      "--runtime-event-context-json", ordinaryEvent,
      "--advice-state", pendingStrategicLifecycleFile,
      "--out", ordinaryOutFile,
      "--retain-full-state",
      "--now", "2026-01-01T00:00:09.000Z",
    ]);
    assert(ordinary.code === 0, `ordinary event pipeline failed\n${ordinary.stdout}\n${ordinary.stderr}`);
    const ordinaryResult = JSON.parse(await readFile(ordinaryOutFile, "utf8"));
    const strategicTaskSurvivesOrdinaryEvent = ordinaryResult.lifecycle.active_tasks
      .some((task) => task.fixed_checkpoint_id === "three_cost_reroll_or_operation" && task.event_key !== ordinaryEvent.event_key);
    const ordinaryTaskWasNotCreated = !ordinaryResult.lifecycle.active_tasks
      .some((task) => task.event_key === "pipeline-strategic-match|shop_decision_context_changed|ordinary");
    assert(strategicTaskSurvivesOrdinaryEvent, "an ordinary runtime event must not overwrite an active strategic checkpoint task");
    assert(ordinaryTaskWasNotCreated, "an ordinary runtime event must remain fact-only and must not create a Host task");
    const ordinaryResponse = ordinaryResult.response_events.find((event) => event.type === "advice_response_requested");
    assert(
      !ordinaryResponse || ordinaryResponse.host_cli_agent_request?.task?.fixed_checkpoint_id === "three_cost_reroll_or_operation",
      "an ordinary runtime event must not own the visible response; a pending strategic checkpoint may remain the owner",
    );
    const capLiveFile = path.join(tmp, "cap-live.json");
    const capContextFile = path.join(tmp, "cap-context.json");
    const capOutFile = path.join(tmp, "cap-pipeline.json");
    await writeFile(capLiveFile, JSON.stringify({
      ...liveState,
      match_session_id: "pipeline-cap-match",
      phase: { stage_round: "5-3", status: 1 },
      economy: { gold: 58, hp: 64, level: 8 },
    }, null, 2), "utf8");
    await writeFile(capContextFile, JSON.stringify({
      target_plan: { name: "峡谷野怪10", status: "confirmed" },
      match_context: { match_session_id: "pipeline-cap-match", target_plan: { name: "峡谷野怪10", status: "confirmed" } },
    }, null, 2), "utf8");
    const capEvent = JSON.stringify({
      event_key: "pipeline-cap-match|line_decision_context_changed|cap",
      event_type: "line_decision_context_changed",
      event_category: "line_decision_context",
      decision_trigger_id: "cap_gap_check",
      fixed_checkpoint_id: "second_ceiling_floor_review",
      fixed_checkpoint_stage_round: "5-3",
      stage_round: "5-3",
      semantic_labels: ["cap_gap_check"],
    });
    const cap = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", capLiveFile,
      "--context", capContextFile,
      "--live-rankings", "data/live-rankings/jcc/current/lineup-strategy-index.json",
      "--runtime-event-context-json", capEvent,
      "--advice-state", path.join(tmp, "cap-lifecycle.json"),
      "--out", capOutFile,
      "--retain-full-state",
      "--now", "2026-01-01T00:00:09.000Z",
    ]);
    assert(cap.code === 0, `cap pipeline failed\n${cap.stdout}\n${cap.stderr}`);
    const capResult = JSON.parse(await readFile(capOutFile, "utf8"));
    const capResponse = capResult.response_events.find((event) => event.type === "advice_response_requested"
      && event.host_cli_agent_request?.context?.cruise_decision_context?.decision_trigger_id === "cap_gap_check");
    const capDecisionContext = capResponse?.host_cli_agent_request?.context?.cruise_decision_context;
    assert(capDecisionContext?.decision_trigger_id === "cap_gap_check", "stage-five pipeline request must preserve the cap trigger");
    assert(capDecisionContext?.strategy_fit_packet?.next_coach_plan?.priority === "cap_and_floor_first", `stage-five pipeline request must prioritize cap/floor discussion: ${JSON.stringify({
      decisionKeys: Object.keys(capDecisionContext || {}),
      packetKeys: Object.keys(capDecisionContext?.strategy_fit_packet || {}),
      packetPlan: capDecisionContext?.strategy_fit_packet?.next_coach_plan || null,
      responseCount: capResult.response_events.length,
      activeTaskCount: capResult.lifecycle.active_tasks.length,
    })}`);
    assert(capDecisionContext?.strategy_fit_packet?.next_coach_plan?.required_decisions?.some((entry) => entry.includes("target_cap_gap")), "stage-five pipeline request must carry cap-gap decisions");
    assert(firstResult.lifecycle.mode === "cruise", "lifecycle should return to cruise mode");
    assert(firstResult.lifecycle.previous_advice_state?.emitted_tasks?.length > 0, "previous advice state missing emitted tasks");
    const pipelineSource = await readFile("tools/run-jcc-cruise-runtime-pipeline.mjs", "utf8");
    assert(pipelineSource.includes("taskWasTouchedThisRun"), "background cruise output should only speak tasks touched in the current run");
    assert(
      pipelineSource.includes('typeof value === "string" ? value.trim() : value')
        && pipelineSource.includes('if (normalized === "") return null'),
      "pipeline numeric normalization must reject whitespace-only text before Number coercion",
    );
    assert(!firstResult.score.advice_tasks.some((task) => task.trigger_id === "emblem_choice_planning"), "automatic emblem planning must not open a Host task");
    assert(firstResult.score.suppressed_tasks.some((task) => task.trigger_id === "emblem_choice_planning"
      && task.suppression_reason === "automatic_cruise_task_is_fact_only_supporting_evidence"), "three-emblem encounter must remain fact-only evidence");
    const suppressedAugmentTask = firstResult.score.suppressed_tasks.find((task) => task.trigger_id === "augment_choice_advice");
    assert(suppressedAugmentTask, "automatic augment advice should remain available as fact-only evidence");
    assert(
      suppressedAugmentTask.suppression_reason === "automatic_cruise_task_is_fact_only_supporting_evidence",
      "automatic augment advice must not open the Host lane",
    );
    assert(suppressedAugmentTask.actions.some((action) => action.startsWith("choose_augment:")
      || action.startsWith("prefer_augment:")
      || action.startsWith("reroll_or_hold_backup:")
      || action === "full_reroll_current_set"), "suppressed augment evidence should retain concrete choice actions");
    assert(!suppressedAugmentTask.short_advice.includes("涓€娉㈠甫璧颁咯"), "pipeline augment evidence must not mix stale previous choice set");
    const staleContextFile = path.join(tmp, "stale-context.json");
    const staleLifecycleFile = path.join(tmp, "stale-advice-lifecycle.json");
    await writeFile(staleContextFile, JSON.stringify({
      match_context: {
        match_session_id: "previous-match",
        choice_confirmations: [
          {
            kind: "augment",
            choice_stage_round: "2-1",
            choice: "stale-nested-context-augment",
            source: "user_confirmed_runtime_ui_or_chat",
            confirmed_at: "2026-01-01T00:00:00.000Z"
          }
        ]
      }
    }, null, 2), "utf8");
    const staleContextRun = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", liveFile,
      "--context", staleContextFile,
      "--advice-state", staleLifecycleFile,
      "--out", path.join(tmp, "stale-pipeline.json"),
      "--retain-full-state",
      "--now", "2026-01-01T00:00:00.000Z",
    ]);
    assert(staleContextRun.code === 0, `stale context pipeline failed\n${staleContextRun.stdout}\n${staleContextRun.stderr}`);
    const staleContextResult = JSON.parse(await readFile(path.join(tmp, "stale-pipeline.json"), "utf8"));
    assert(!staleContextResult.standardized_live_state?.augments?.selected_augments?.some((augment) => augment.name === "stale-nested-context-augment"), "cross-match nested match_context confirmations must not become final selected augment facts");
    const augmentResponse = firstResult.response_events.find((event) => event.trigger_id === "augment_choice_advice");
    assert(firstAdviceResponse?.host_cli_agent_request?.request_id === firstAdviceResponse.response_id, "pending host request must be bound to response_id");
    const hostRequestFile = path.join(tmp, "host-coach-request.json");
    const hostResponseFile = path.join(tmp, "host-coach-response.json");
    const hostCoachResultFile = path.join(tmp, "host-coach-result.json");
    await writeFile(hostRequestFile, JSON.stringify(firstAdviceResponse, null, 2), "utf8");
    await writeFile(hostResponseFile, JSON.stringify({
      schema: "jcc-host-cli-coach-response-v1",
      generated_by: "current_cli_agent_main_model",
      request_id: firstAdviceResponse.host_cli_agent_request.request_id,
      request_hash: firstAdviceResponse.host_cli_agent_request.request_hash,
      final_text: "HOST_MODEL_FINAL: keep forge as backup and reroll the weaker two slots before locking the choice.",
      recommended_action: "reroll_or_hold_backup",
      confidence: "medium",
      followup_question: null,
    }, null, 2), "utf8");
    const unboundHostResponseFile = path.join(tmp, "host-coach-response-unbound.json");
    await writeFile(unboundHostResponseFile, JSON.stringify({
      schema: "jcc-host-cli-coach-response-v1",
      final_text: "UNBOUND_HOST_RESPONSE_SHOULD_BE_REJECTED",
      confidence: "medium",
    }, null, 2), "utf8");
    const unboundHostCoach = await runNode([
      "tools/run-jcc-host-coach-response.mjs",
      "--request", hostRequestFile,
      "--agent-response", unboundHostResponseFile,
    ]);
    assert(unboundHostCoach.code === 0, "host coach response may omit optional transport provenance echoes");
    const unboundHostCoachResult = JSON.parse(unboundHostCoach.stdout);
    assert(unboundHostCoachResult.advice_response?.coach_response?.request_id === firstAdviceResponse.host_cli_agent_request.request_id,
      "Runtime must attach the sealed request identity when the Agent omits optional echoes");
    const mojibakeHostResponseFile = path.join(tmp, "host-coach-response-mojibake.json");
    await writeFile(mojibakeHostResponseFile, JSON.stringify({
      schema: "jcc-host-cli-coach-response-v1",
      generated_by: "current_cli_agent_main_model",
      request_id: firstAdviceResponse.host_cli_agent_request.request_id,
      request_hash: firstAdviceResponse.host_cli_agent_request.request_hash,
      final_text: "????",
      confidence: "medium",
    }, null, 2), "utf8");
    const mojibakeHostCoach = await runNode([
      "tools/run-jcc-host-coach-response.mjs",
      "--request", hostRequestFile,
      "--agent-response", mojibakeHostResponseFile,
    ]);
    assert(mojibakeHostCoach.code !== 0, "host coach response must reject question-mark mojibake final text");
    const hostCoach = await runNode([
      "tools/run-jcc-host-coach-response.mjs",
      "--request", hostRequestFile,
      "--agent-response", hostResponseFile,
      "--out", hostCoachResultFile,
    ]);
    assert(hostCoach.code === 0, `host coach response merge failed\n${hostCoach.stdout}\n${hostCoach.stderr}`);
    const hostCoachResult = JSON.parse(await readFile(hostCoachResultFile, "utf8"));
    assert(hostCoachResult.advice_response?.user_visible_text?.includes("HOST_MODEL_FINAL"), "host model final coach text should become user_visible_text");
    assert(hostCoachResult.advice_response?.coach_response?.provenance?.generated_by === "current_cli_agent_main_model", "host model final text provenance missing");
    assert(!hasMojibakeText(hostCoachResult.advice_response?.user_visible_text), "host model final coach text must not contain mojibake");
    const pendingCoachDir = path.join(tmp, "pending-coach");
    const pendingCoachResponseFile = path.join(tmp, "pending-coach-response.json");
    await writeFile(pendingCoachResponseFile, JSON.stringify({
      schema: "jcc-host-cli-coach-response-v1",
      generated_by: "current_cli_agent_main_model",
      request_id: firstAdviceResponse.host_cli_agent_request.request_id,
      request_hash: firstAdviceResponse.host_cli_agent_request.request_hash,
      final_text: "HOST_MODEL_PENDING_FINAL: use current board evidence and item bench before spending gold.",
      recommended_action: "refresh_self_state_then_decide",
      confidence: "medium",
      followup_question: null,
    }, null, 2), "utf8");
    const pendingCoach = await runNode([
      "tools/run-jcc-pending-host-coach-response.mjs",
      "--pipeline", outFile,
      "--out-dir", pendingCoachDir,
      "--request-index", "0",
      "--agent-response", pendingCoachResponseFile,
    ]);
    assert(pendingCoach.code === 0, `pending host coach response failed\n${pendingCoach.stdout}\n${pendingCoach.stderr}`);
    const pendingCoachResult = JSON.parse(pendingCoach.stdout);
    assert(pendingCoachResult.advice_response?.user_visible_text?.includes("HOST_MODEL_PENDING_FINAL"), "pending host coach runner must publish host model final text");
    const latestPendingCoach = JSON.parse(await readFile(path.join(pendingCoachDir, "latest-host-coach-response.json"), "utf8"));
    assert(latestPendingCoach.status === "completed", "pending host coach runner must publish latest response ref");
    const requestIdCoachDir = path.join(tmp, "pending-coach-request-id");
    const laterAdviceResponse = {
      ...firstAdviceResponse,
      response_id: "verify-later-response-id",
      trigger_id: "verify_later_stale_choice",
      host_cli_agent_request: {
        ...firstAdviceResponse.host_cli_agent_request,
        request_id: "verify-later-response-id",
        request_hash: "verify-later-response-hash",
      },
    };
    const multiRequestPipelineFile = path.join(tmp, "pipeline-multiple-host-requests.json");
    await writeFile(multiRequestPipelineFile, JSON.stringify({
      schema: "verify-multiple-host-requests-v1",
      response_events: [
        firstAdviceResponse,
        laterAdviceResponse,
      ],
    }, null, 2), "utf8");
    const requestIdCoach = await runNode([
      "tools/run-jcc-pending-host-coach-response.mjs",
      "--pipeline", multiRequestPipelineFile,
      "--out-dir", requestIdCoachDir,
      "--request-id", firstAdviceResponse.host_cli_agent_request.request_id,
      "--agent-response", hostResponseFile,
    ]);
    assert(requestIdCoach.code === 0, `pending host coach request-id selection failed\n${requestIdCoach.stdout}\n${requestIdCoach.stderr}`);
    const requestIdCoachResult = JSON.parse(requestIdCoach.stdout);
    assert(requestIdCoachResult.advice_response?.response_id === firstAdviceResponse.response_id, "pending host coach runner must merge the explicitly requested response, not the latest event");
    assert(firstResult.standardized_live_state.confidence_policy?.data_source_contract?.mumu_4357_item_bench?.fields?.includes("items.item_bench"), "data source contract missing 4357 item_bench field");
    assert(firstResult.standardized_live_state.confidence_policy?.data_source_contract?.left_item_rail_roi_icon?.fields?.includes("items.item_bench_candidates"), "data source contract missing left rail icon candidate field");
    assert(firstResult.standardized_live_state.match_variables.values?.emblem_choice_encounter, "emblem choice variable missing from standardized live_state");

    const fullOutFile = path.join(tmp, "pipeline-full.json");
    const retainedFull = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", liveFile,
      "--context", contextFile,
      "--advice-state", lifecycleFile,
      "--out", fullOutFile,
      "--retain-full-state",
      "--now", "2026-01-01T00:00:02.000Z",
    ]);
    assert(retainedFull.code === 0, `retain-full pipeline failed\n${retainedFull.stdout}\n${retainedFull.stderr}`);
    const retainedFullOut = JSON.parse(await readFile(fullOutFile, "utf8"));
    assert(retainedFullOut.schema === "jcc-cruise-runtime-pipeline-result-v1", "--retain-full-state must preserve full output schema");
    assert(retainedFullOut.standardized_live_state?.schema === "jcc-runtime-live-state-standard-v1", "--retain-full-state must be explicit for full live_state file output");

    const pollutedLiveFile = path.join(tmp, "polluted-live.json");
    await writeFile(pollutedLiveFile, JSON.stringify({
      match_session_id: "pipeline-polluted-match",
      phase: { stage_round: "3-2", status: 1 },
      economy: { gold: 19, hp: 54, level: 6 },
      board: {
        units: [
          { id: 11999, base_id: 1999, name: "PollutedOpponentCarry", star: 3 },
          { id: 11998, base_id: 1998, name: "PollutedOpponentFront", star: 3 },
        ],
      },
      shop: {
        shop_units: [
          { id: 11471, base_id: 1471, name: "Diana" },
        ],
      },
      field_status: {
        "board.units": {
          status: "blocked",
          promotion_policy: "requires_local_player_or_view_scope_binding",
        },
      },
    }, null, 2), "utf8");
    const pollutedOutFile = path.join(tmp, "polluted-pipeline.json");
    const polluted = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", pollutedLiveFile,
      "--context", contextFile,
      "--advice-state", path.join(tmp, "polluted-lifecycle.json"),
      "--out", pollutedOutFile,
      "--retain-full-state",
      "--now", "2026-01-01T00:00:03.000Z",
    ]);
    assert(polluted.code === 0, `polluted pipeline failed\n${polluted.stdout}\n${polluted.stderr}`);
    const pollutedResult = JSON.parse(await readFile(pollutedOutFile, "utf8"));
    const pollutedText = JSON.stringify(pollutedResult.score);
    assert(pollutedResult.standardized_live_state.own_board.units.length === 0, "standardized scorer input must reject raw board.units without shop self-view proof");
    assert(!pollutedText.includes("PollutedOpponentCarry"), "scorer must not consume polluted raw board.units alias");

    const gatedLiveFile = path.join(tmp, "gated-live.json");
    await writeFile(gatedLiveFile, JSON.stringify({
      match_session_id: "pipeline-gated-match",
      phase: { stage_round: "3-2", status: 1 },
      economy: { gold: 19, hp: 54, level: 6 },
      board: {
        local_board_units_candidate: [
          { id: 11471, base_id: 1471, name: "Diana", star: 2 },
        ],
        units: [
          { id: 11999, base_id: 1999, name: "PollutedOpponentCarry", star: 3 },
        ],
      },
      field_status: {
        "board.local_board_units_candidate": {
          status: "candidate",
          promotion_policy: "shop_self_view_anchor_plus_fresh_current_view",
          shop_anchor_fresh: true,
          bench_overlap_count: 1,
        },
      },
    }, null, 2), "utf8");
    const gatedOutFile = path.join(tmp, "gated-pipeline.json");
    const gated = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", gatedLiveFile,
      "--context", contextFile,
      "--advice-state", path.join(tmp, "gated-lifecycle.json"),
      "--out", gatedOutFile,
      "--retain-full-state",
      "--now", "2026-01-01T00:00:03.500Z",
    ]);
    assert(gated.code === 0, `gated pipeline failed\n${gated.stdout}\n${gated.stderr}`);
    const gatedResult = JSON.parse(await readFile(gatedOutFile, "utf8"));
    assert(gatedResult.standardized_live_state.own_board.units.length === 1, "shop-anchored local_board_units_candidate should enter own_board");
    assert(!JSON.stringify(gatedResult.score).includes("PollutedOpponentCarry"), "gated local board must still ignore polluted board.units alias");

    const second = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", liveFile,
      "--context", contextFile,
      "--advice-state", lifecycleFile,
      "--out", outFile,
      "--retain-full-state",
      "--now", "2026-01-01T00:00:04.000Z",
    ]);
    assert(second.code === 0, `second pipeline failed\n${second.stdout}\n${second.stderr}`);
    const secondResult = JSON.parse(await readFile(outFile, "utf8"));
    assert(!secondResult.response_events.some((event) => event.type === "advice_response_requested"), `repeated pipeline run must not create a duplicate Host request: ${JSON.stringify({
        output_history: secondResult.lifecycle.output_history,
        response_events: secondResult.response_events,
        active_tasks: secondResult.lifecycle.active_tasks.map((task) => ({ task_id: task.task_id, trigger_id: task.trigger_id, fixed_checkpoint_id: task.fixed_checkpoint_id, event_key: task.event_key })),
      })}`);
    assert(secondResult.events.some((event) => event.type === "advice_task_suppressed"
      && event.suppression_reason === "automatic_cruise_task_is_fact_only_supporting_evidence"), "suppressed events missing");
    assert(secondResult.lifecycle.active_tasks.some((task) => task.fixed_checkpoint_id === "direction_exploration"), "pending strategic obligation must survive a cooldown-only run");
    assert(!secondResult.events.some((event) => event.type === "advice_task_created"
      && event.trigger_id === "runtime_event_followup"), "cooldown-only run must not create a duplicate strategic task");

    const userMessageOutFile = path.join(tmp, "user-message-pipeline.json");
    const userMessage = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", liveFile,
      "--context", contextFile,
      "--advice-state", lifecycleFile,
      "--out", userMessageOutFile,
      "--user-message", "I want to hard force Diana if possible",
      "--retain-full-state",
      "--now", "2026-01-01T00:00:05.000Z",
    ]);
    assert(userMessage.code === 0, `user-message pipeline failed\n${userMessage.stdout}\n${userMessage.stderr}`);
    const userMessageResult = JSON.parse(await readFile(userMessageOutFile, "utf8"));
    assert(userMessageResult.events.some((event) => event.type === "user_message_received"), "user message event missing");
    assert(userMessageResult.lifecycle.active_task_context?.user_message?.includes("Diana"), "user message not retained in active task context");
    assert(userMessageResult.lifecycle.match_context?.user_constraints?.some((entry) => entry.message.includes("Diana")), "user message not retained in match context");

    const confirmOutFile = path.join(tmp, "confirm-pipeline.json");
    const confirm = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", liveFile,
      "--context", contextFile,
      "--advice-state", lifecycleFile,
      "--out", confirmOutFile,
      "--confirm-task-id", firstResult.lifecycle.active_tasks[0].task_id,
      "--retain-full-state",
      "--now", "2026-01-01T00:00:06.000Z",
    ]);
    assert(confirm.code === 0, `confirm pipeline failed\n${confirm.stdout}\n${confirm.stderr}`);
    const confirmResult = JSON.parse(await readFile(confirmOutFile, "utf8"));
    assert(confirmResult.events.some((event) => event.type === "advice_task_confirmed"), "confirm event missing");
    assert(confirmResult.lifecycle.confirmed_tasks?.length >= 1, "confirmed task not retained");
    assert(confirmResult.lifecycle.match_context?.confirmed_actions?.some((entry) => entry.task_id === firstResult.lifecycle.active_tasks[0].task_id), "confirmed action not retained in match context");

    const removedMode = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", liveFile,
      "--context", contextFile,
      "--advice-state", lifecycleFile,
      "--mode", "opponent_power",
      "--now", "2026-01-01T00:00:07.000Z",
    ]);
    assert(removedMode.code !== 0, "removed opponent_power mode must be rejected by the cruise pipeline CLI");
    assert(/Unsupported runtime mode: opponent_power/.test(removedMode.stderr || removedMode.stdout), "removed opponent_power mode should fail with explicit unsupported-mode text");

    const expiredOutFile = path.join(tmp, "expired-pipeline.json");
    const expired = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", liveFile,
      "--context", contextFile,
      "--advice-state", lifecycleFile,
      "--out", expiredOutFile,
      "--retain-full-state",
      "--now", "2026-01-01T00:01:20.000Z",
    ]);
    assert(expired.code === 0, `expiry pipeline failed\n${expired.stdout}\n${expired.stderr}`);
    const expiredResult = JSON.parse(await readFile(expiredOutFile, "utf8"));
    assert(expiredResult.events.some((event) => event.type === "advice_task_expired"), "expiry event missing");
    assert(expiredResult.lifecycle.expired_tasks?.length >= 1, "expired task not retained");

    const persisted = JSON.parse(await readFile(lifecycleFile, "utf8"));
    assert(persisted.schema === "jcc-cruise-advice-lifecycle-state-v1", "persisted lifecycle schema mismatch");
    assert(persisted.match_session_id === "pipeline-match", "persisted match session mismatch");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "pipeline builds estimator context from live_state",
        "pipeline scores cruise strategy",
        "pipeline standardizes live_state provenance/confidence fields",
        "pipeline creates advice_task lifecycle entries",
        "pipeline creates ai-native advice response requests",
        "pipeline carries data source contract and manual match variables",
        "three-emblem encounter/item-bench candidates trigger planning advice",
        "active tasks merge/update instead of duplicating",
        "repeated run uses previous advice cooldown",
        "user message is retained as active task context",
        "user constraints and confirmations are retained in match context",
        "task confirmation is persisted",
        "runtime mode switching is persisted",
        "removed opponent_power mode is rejected",
        "task ttl expiry is persisted",
        "strategic pipeline requests carry Ranking working set and lineup agenda",
        "stage-five pipeline requests carry cap/floor agenda",
      ],
      first_triggers: firstResult.score.advice_tasks.map((task) => task.trigger_id),
      suppressed_triggers: secondResult.score.suppressed_tasks.map((task) => task.trigger_id),
    }, null, 2));
  } finally {
    if (process.env.JCC_KEEP_VERIFY_ARTIFACTS === "1") console.error(`kept verifier artifacts: ${tmp}`);
    else await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
