import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadActiveRulesBundle } from "./jcc_active_rules_contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function moduleUrl(file, tag) {
  return `${pathToFileURL(path.join(repoRoot, file)).href}?${tag}`;
}

async function main() {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-item-source-health-"));
  const previousDataRoot = process.env.JCC_RUNTIME_DATA_DIR;
  const previousDisableHost = process.env.JCC_UI_DISABLE_CODEX_EXEC;
  process.env.JCC_RUNTIME_DATA_DIR = dataRoot;
  process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
  try {
    const tag = `item-source-health-${Date.now()}`;
    const store = await import(moduleUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(moduleUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = store.createRuntimePaths(repoRoot, { dataRoot });
    const rules = loadActiveRulesBundle({ repoRoot, runtimePaths });
    const matchSessionId = "verify-mumu-item-source-health";
    const observedAt = new Date().toISOString();

    service.configureRuntimeServicePaths({ dataRoot });
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    await writeJson(runtimePaths.matchContextFile, {
      schema: "jcc-runtime-ui-match-context-v1",
      match_session_id: matchSessionId,
      updated_at: observedAt,
      recent_user_messages: [],
      choice_confirmations: [],
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "jcc-cruise-runtime-live-state-from-mumu-watch-v1",
      match_session_id: matchSessionId,
      observed_at: observedAt,
      source_revision: 5,
      phase: { stage_round: "2-5" },
      economy: { hp: null, gold: 30, level: 4, xp: "2/10" },
      items: {
        item_bench: [],
        equipped_items: [
          {
            name: "视觉误标成己方装备",
            source: "left_item_rail_roi_icon",
            owner_scope: "own_unit",
            assignment_status: "assigned_to_trusted_own_unit",
          },
        ],
        item_bench_candidates: [
          { name: "视觉候选装备", source: "left_item_rail_roi_icon", confidence: 0.91 },
        ],
      },
    });

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "127.0.0.1:7555" } },
      daily_session: { status: "inactive", mode: null },
      match_session: {
        status: "active",
        match_session_id: matchSessionId,
        started_at: observedAt,
        season_version_snapshot: {
          schema: "jcc-match-season-version-snapshot-v1",
          activation_policy: "new_match_only",
          promotion_tuple: runtimePaths.activePromotionTuple,
          rules_source_fingerprint: rules.source_fingerprint,
        },
      },
      match_connection: { status: "connected_to_live_match", source_health: {} },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_event_detector: { source_cursor: { source_revision: 0 } },
      runtime_triggers: { visual_by_stage: {}, choice_pretriggers: {} },
      visual_request_status: { status: "idle" },
      host_cli: { provider: "codex", display_name: "Codex CLI", available: true },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: matchSessionId } },
    });

    await service.persistWatcherSourceObservation({
      match_session_id: matchSessionId,
      source_revision: 5,
      last_observed_at: observedAt,
      latest_source_observation: {
        source_kind: "mumu_gi_logcat",
        source_name: "gi_plugin_jkchess",
        source_command: 4356,
        observed_at: observedAt,
      },
      command_counts: { "4353": 24, "4354": 12, "4356": 1, "4357": 0 },
      equipped_item_count: 0,
      item_bench_count: 0,
      source_diagnostics: {
        schema: "jcc-mumu-watch-source-diagnostics-v1",
        item_source_classification: {
          status: "source_not_emitted",
          reason: "gi_stream_active_with_board_or_shop_commands_but_no_4357_command_seen",
          evidence: { command_4353_count: 24, command_4356_count: 1, command_4357_count: 0 },
        },
        parse_rejection_counts: { malformed_json_payload: 0 },
        equipment_like_unknown_command_counts: {},
        capture_health: { capture_loss_possible: false },
      },
    }, matchSessionId);

    const degradedContext = await service.buildRuntimeHostContext("cruise", null, {
      provider_readonly_tool_mode: "prefetch_complete",
      user_message: "检查当前装备来源健康状态",
    });
    const degraded = degradedContext.structured_item_source_health;
    assert.equal(degraded.schema, "jcc-mumu-structured-item-source-health-v1");
    assert.equal(degraded.degraded, true);
    assert.equal(degraded.overall_status, "degraded_primary_4357_not_observed");
    assert.equal(degraded.item_bench_4357.seen, false);
    assert.equal(degraded.item_bench_4357.current_payload_observed, false);
    assert.equal(degraded.equipped_items_4356.seen, true);
    assert.equal(degraded.equipped_items_4356.current_payload_observed, false);
    assert.equal(degraded.equipped_items_4356.current_payload_nonempty, null);
    assert.equal(degraded.equipped_items_4356.current_structured_rows_nonempty, false);
    assert.equal(degraded.decision_availability.fallback_candidate_count, 1);
    assert.equal(degraded.evidence_boundary.icon_matcher_candidates_are_authoritative, false);
    assert.equal(degraded.evidence_boundary.missing_structured_items_is_visual_failure, false);
    assert.equal(degraded.source_diagnostics.classification, "source_not_emitted");
    assert.equal(degraded.source_diagnostics.capture_health.capture_loss_possible, false);
    assert.deepEqual(degradedContext.cruise_decision_context?.equipment?.effective_item_bench, []);
    assert.deepEqual(degradedContext.cruise_decision_context?.equipment?.effective_equipped_items, []);
    assert.equal(degradedContext.cruise_decision_context?.equipment?.item_bench_candidates_fallback_only?.length, 1);
    assert.match(
      degradedContext.cruise_decision_context?.equipment?.policy || "",
      /conditional wording.*never become hard owned-item facts/i,
    );
    assert.equal(
      degradedContext.cruise_decision_context?.equipment?.structured_source_health?.overall_status,
      "degraded_primary_4357_not_observed",
    );

    const promotionRejectedAt = new Date(Date.parse(observedAt) + 1000).toISOString();
    await service.persistWatcherSourceObservation({
      match_session_id: matchSessionId,
      source_revision: 6,
      last_observed_at: promotionRejectedAt,
      latest_source_observation: {
        source_kind: "mumu_gi_logcat",
        source_name: "gi_plugin_jkchess",
        source_command: 4356,
        observed_at: promotionRejectedAt,
      },
      command_counts: { "4353": 25, "4354": 13, "4356": 2, "4357": 0 },
      equipped_item_count: 0,
      item_bench_count: 0,
      source_diagnostics: {
        schema: "jcc-mumu-watch-source-diagnostics-v1",
        item_source_classification: {
          status: "promotion_gate_rejected",
          reason: "4356_nonempty_but_no_equipment_assigned_to_trusted_own_units",
          evidence: {
            command_4353_count: 25,
            command_4356_count: 2,
            command_4357_count: 0,
            equipped_item_count: 0,
            visible_equipment_unassigned_count: 1,
          },
        },
        parse_rejection_counts: { malformed_json_payload: 0 },
        equipment_like_unknown_command_counts: {},
        capture_health: { capture_loss_possible: false },
      },
    }, matchSessionId);
    const promotionRejectedContext = await service.buildRuntimeHostContext("cruise", null, {
      provider_readonly_tool_mode: "prefetch_complete",
      user_message: "检查当前装备来源健康状态",
    });
    assert.equal(promotionRejectedContext.structured_item_source_health.source_diagnostics.classification, "promotion_gate_rejected");
    assert.deepEqual(promotionRejectedContext.cruise_decision_context?.equipment?.trusted_equipped_items_from_4356_assignment, []);
    assert.equal(promotionRejectedContext.structured_item_source_health.evidence_boundary.icon_matcher_candidates_are_authoritative, false);

    const laterAt = new Date(Date.parse(observedAt) + 2000).toISOString();
    await service.persistWatcherSourceObservation({
      match_session_id: matchSessionId,
      source_revision: 7,
      last_observed_at: laterAt,
      latest_source_observation: {
        source_kind: "mumu_gi_logcat",
        source_name: "gi_plugin_jkchess",
        source_command: 4357,
        observed_at: laterAt,
      },
      command_counts: { "4353": 24, "4354": 12, "4356": 1, "4357": 1 },
      equipped_item_count: 0,
      item_bench_count: 0,
    }, matchSessionId);
    const observedEmptyContext = await service.buildRuntimeHostContext("cruise", null, {
      provider_readonly_tool_mode: "prefetch_complete",
      user_message: "检查当前装备来源健康状态",
    });
    assert.equal(observedEmptyContext.structured_item_source_health.degraded, false);
    assert.equal(
      observedEmptyContext.structured_item_source_health.overall_status,
      "structured_sources_observed_currently_empty",
    );
    assert.equal(observedEmptyContext.structured_item_source_health.item_bench_4357.status, "observed_empty");
    assert.equal(observedEmptyContext.structured_item_source_health.item_bench_4357.current_payload_observed, true);

    const healthyAt = new Date(Date.parse(observedAt) + 3000).toISOString();
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "jcc-cruise-runtime-live-state-from-mumu-watch-v1",
      match_session_id: matchSessionId,
      observed_at: healthyAt,
      source_revision: 8,
      command_counts: { "4353": 30, "4354": 18, "4356": 2, "4357": 2 },
      phase: { stage_round: "2-6" },
      economy: { hp: null, gold: 41, level: 5, xp: "0/20" },
      items: {
        item_bench: [
          { name: "反曲之弓", source: "mumu_4357_item_bench", owner_scope: "item_bench" },
        ],
        trusted_equipped_items: [
          { name: "视觉误入项", source: "left_item_rail_roi_icon", owner_scope: "own_unit" },
        ],
        equipped_items: [
          { name: "泰坦的坚决", source: "mumu_4356_equipment_to_4353_own_unit", owner_scope: "own_unit" },
        ],
        item_bench_candidates: [
          { name: "视觉校验候选", source: "left_item_rail_roi_icon", confidence: 0.99 },
        ],
      },
    });
    await service.persistWatcherSourceObservation({
      match_session_id: matchSessionId,
      source_revision: 8,
      last_observed_at: healthyAt,
      latest_source_observation: {
        source_kind: "mumu_gi_logcat",
        source_name: "gi_plugin_jkchess",
        source_command: 4356,
        observed_at: healthyAt,
      },
      command_counts: { "4353": 30, "4354": 18, "4356": 2, "4357": 2 },
      equipped_item_count: 1,
      item_bench_count: 1,
    }, matchSessionId);
    const healthyContext = await service.buildRuntimeHostContext("cruise", null, {
      provider_readonly_tool_mode: "prefetch_complete",
      user_message: "检查当前装备来源健康状态",
    });
    assert.equal(healthyContext.structured_item_source_health.overall_status, "healthy");
    assert.equal(healthyContext.structured_item_source_health.equipped_items_4356.current_payload_nonempty, true);
    assert.equal(healthyContext.structured_item_source_health.equipped_items_4356.current_payload_observed, true);
    assert.equal(healthyContext.structured_item_source_health.item_bench_4357.current_payload_nonempty, true);
    assert.equal(healthyContext.structured_item_source_health.item_bench_4357.current_payload_observed, true);
    assert.equal(healthyContext.cruise_decision_context.equipment.effective_item_bench.length, 1);
    assert.equal(healthyContext.cruise_decision_context.equipment.effective_equipped_items.length, 1);
    assert.equal(healthyContext.cruise_decision_context.equipment.item_bench_candidates_fallback_only.length, 1);

    const clearedAt = new Date(Date.parse(observedAt) + 4000).toISOString();
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "jcc-cruise-runtime-live-state-from-mumu-watch-v1",
      match_session_id: matchSessionId,
      observed_at: clearedAt,
      source_revision: 9,
      phase: { stage_round: "2-6" },
      economy: { hp: null, gold: 43, level: 5, xp: "2/20" },
      items: { item_bench: [], equipped_items: [], item_bench_candidates: [] },
    });
    await service.persistWatcherSourceObservation({
      match_session_id: matchSessionId,
      source_revision: 9,
      last_observed_at: clearedAt,
      latest_source_observation: {
        source_kind: "mumu_gi_logcat",
        source_name: "gi_plugin_jkchess",
        source_command: 4357,
        observed_at: clearedAt,
      },
      command_counts: { "4353": 31, "4354": 19, "4356": 3, "4357": 3 },
      equipped_item_count: 0,
      item_bench_count: 0,
    }, matchSessionId);
    const clearedContext = await service.buildRuntimeHostContext("cruise", null, {
      provider_readonly_tool_mode: "prefetch_complete",
      user_message: "检查当前装备来源健康状态",
    });
    assert.equal(clearedContext.structured_item_source_health.item_bench_4357.current_payload_nonempty, false);
    assert.equal(clearedContext.structured_item_source_health.item_bench_4357.current_payload_observed, true);
    assert.equal(clearedContext.structured_item_source_health.item_bench_4357.nonempty_seen_ever, true);
    assert.equal(clearedContext.structured_item_source_health.equipped_items_4356.current_payload_nonempty, null);
    assert.equal(clearedContext.structured_item_source_health.equipped_items_4356.current_structured_rows_nonempty, false);
    assert.equal(clearedContext.structured_item_source_health.equipped_items_4356.nonempty_seen_ever, true);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: "jcc-mumu-item-source-health-context-verification-v1",
      checked: [
        "4356_seen_empty_and_4357_missing_is_explicit_structured_source_degradation",
        "4357_seen_empty_is_distinct_from_visual_recognition_failure",
        "healthy_4357_and_trusted_4356_facts_reach_host_context",
        "current_empty_state_does_not_reuse_prior_nonempty_item_payload",
        "icon_matcher_candidates_remain_non_authoritative",
        "visual_owner_scope_cannot_impersonate_trusted_4356_assignment",
        "host_runtime_and_cruise_equipment_context_share_source_health",
        "watcher_source_not_emitted_diagnosis_reaches_host_context_without_promoting_visual_candidates",
        "watcher_promotion_gate_rejection_reaches_host_context_without_promoting_visual_candidates",
      ],
    }, null, 2)}\n`);
  } finally {
    if (previousDataRoot === undefined) delete process.env.JCC_RUNTIME_DATA_DIR;
    else process.env.JCC_RUNTIME_DATA_DIR = previousDataRoot;
    if (previousDisableHost === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
    else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisableHost;
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}

await main();
