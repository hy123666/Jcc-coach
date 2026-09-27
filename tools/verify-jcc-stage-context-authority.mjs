import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createActiveCoreProfileSnapshot } from "./jcc_test_core_profile_fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fileUrl(file, tag) {
  return `${pathToFileURL(path.resolve(root, file)).href}?${tag}`;
}

async function withRuntimeEnv(fn) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-stage-context-authority-"));
  const previousDisable = process.env.JCC_UI_DISABLE_CODEX_EXEC;
  const previousDataDir = process.env.JCC_RUNTIME_DATA_DIR;
  process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
  process.env.JCC_RUNTIME_DATA_DIR = tempRoot;
  try {
    return await fn(tempRoot);
  } finally {
    if (previousDisable === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
    else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisable;
    if (previousDataDir === undefined) delete process.env.JCC_RUNTIME_DATA_DIR;
    else process.env.JCC_RUNTIME_DATA_DIR = previousDataDir;
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}

async function main() {
  await withRuntimeEnv(async (tempRoot) => {
    const tag = `stage-authority-${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root, { dataRoot: tempRoot });
    const activeVersionSnapshot = createActiveCoreProfileSnapshot(root, { runtimePaths });
    service.configureRuntimeServicePaths({ dataRoot: tempRoot });
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });

    const matchSessionId = "verify-stage-context-match";
    const now = Date.now();
    const startAt = new Date(now - 10 * 60 * 1000).toISOString();
    const staleObservedAt = new Date(now - 9 * 60 * 1000).toISOString();
    const freshObservedAt = new Date(now - 10 * 1000).toISOString();
    const oldMessageAt = new Date(now - 8 * 60 * 1000).toISOString();
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-stage-context-live-state-v1",
      match_session_id: matchSessionId,
      observed_at: staleObservedAt,
      phase: { stage_round: "1-1", current_round_text: "1-1" },
      economy: { hp: null, gold: null, level: null, xp: null },
      own_board: { units: [] },
      own_bench: { units: [] },
      shop: { units: [] },
    });

    await writeJson(runtimePaths.matchContextFile, {
      schema: "jcc-runtime-ui-match-context-v1",
      match_session_id: matchSessionId,
      updated_at: freshObservedAt,
      match_variables: { encounter: "verify", god_options: [], stargazing: null },
      recent_user_messages: [
        {
          text: "old lineup question",
          mode: "lineup_card",
          stage_round: "1-1",
          observed_at: oldMessageAt,
          source: "runtime_ui_user_message",
        },
      ],
      choice_confirmations: [],
    });

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: {
        status: "active",
        match_session_id: matchSessionId,
        started_at: startAt,
        season_version_snapshot: activeVersionSnapshot,
      },
      match_connection: {
        status: "connected_to_live_match",
        last_live_state_match_session_id: matchSessionId,
        last_live_state_at: staleObservedAt,
        evidence: { phase: { stage_round: "1-1" } },
        initial_cruise_greeting_at: startAt,
      },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {}, choice_pretriggers: {} },
      visual_request_status: { status: "idle" },
      self_state_refresh: {
        status: "completed_self_state_roi_ocr",
        last_source: "self_state_roi_ocr",
        last_stage_round: "6-1",
        last_stage_round_source: "self_state_roi_ocr",
        last_completed_at: freshObservedAt,
        last_economy: { gold: 54, level: 8, xp: { value: 0, to_next: 68, display: "0/68" } },
        last_economy_sources: { gold: "self_state_roi_ocr", level: "self_state_roi_ocr", xp: "self_state_roi_ocr" },
      },
      host_cli: { provider: "codex", display_name: "Codex CLI", available: true },
      host_sessions: {
        daily: { status: "idle" },
        match: { status: "idle", match_session_id: matchSessionId },
      },
    });

    const result = await service.handleRuntimeAction("sendMessage", {
      mode: "cruise",
      text: "现在怎么打？",
    }, {});
    assert.equal(result.status, "awaiting_host_cli_agent_response");
    const compact = service.summarizeHostRequest(result.host_request);
    const latest = compact.runtime_context?.match_facts?.latest_user_intent;
    const recent = compact.runtime_context?.match_facts?.recent_user_messages || [];
    assert.equal(compact.runtime_context?.game_state_brief?.stage_round, "6-1");
    assert.equal(compact.live_state_summary?.phase?.stage_round, "6-1");
    assert.equal(latest?.stage_round, "6-1");
    assert.equal(recent.length, 0, "provider-native conversation history must not be replayed in the current Host request");
    const capsule = service.hostContextCapsuleForRequest(result.host_request, { routeKey: `match:${matchSessionId}` });
    const delta = service.compactHostTurnDelta(result.host_request, capsule);
    assert.equal(delta.runtime_context?.match_facts?.recent_user_messages, undefined, "current-turn delta must not carry prior chat history");
    const staleHostRequest = {
      mode: "cruise",
      runtime_context: {
        game_rule_contract: {
          schema: "jcc-game-rule-contract-v1",
          stage_round: "1-1",
          must_not: ["stale contract should not survive"],
        },
        game_state_brief: {
          schema: "jcc-runtime-game-state-brief-v1",
          stage_round: "1-1",
          situation: "stale incoming request brief",
        },
        game_rule_brief_text: "GAME_RULE_BRIEF:\n- current_stage: 1-1\n",
      },
      context: {
        live_state_summary: {
          phase: { stage_round: "1-1" },
        },
        game_rule_contract: {
          schema: "jcc-game-rule-contract-v1",
          stage_round: "1-1",
        },
        game_state_brief: {
          schema: "jcc-runtime-game-state-brief-v1",
          stage_round: "1-1",
        },
      },
    };
    const rebuilt = await service.buildRuntimeHostContext("cruise", null, staleHostRequest);
    assert.equal(rebuilt.game_state_brief?.stage_round, "6-1");
    assert.equal(rebuilt.game_rule_contract?.stage_round, "6-1");
    assert.match(rebuilt.game_rule_brief_text || "", /current_stage: 6-1/);
    assert.doesNotMatch(rebuilt.game_rule_brief_text || "", /current_stage: 1-1/);
    assert.equal(rebuilt.current_turn_contract?.stage_round, "6-1");
    const firstTurnContract = rebuilt.current_turn_contract;

    service.setRuntimeServiceState({
      ...service.getRuntimeServiceState(),
      self_state_refresh: {
        ...service.getRuntimeServiceState().self_state_refresh,
        status: "completed_self_state_roi_ocr",
        last_stage_round: "6-2",
        last_stage_round_source: "self_state_roi_ocr",
        last_completed_at: new Date(now + 1000).toISOString(),
      },
    });
    const nextTurn = await service.buildRuntimeHostContext("cruise", null, staleHostRequest);
    assert.equal(nextTurn.current_turn_contract?.stage_round, "6-2");
    assert.equal(nextTurn.game_rule_contract?.stage_round, "6-2");
    assert.equal(nextTurn.game_state_brief?.stage_round, "6-2");
    assert.match(nextTurn.game_rule_brief_text || "", /current_stage: 6-2/);
    assert.doesNotMatch(nextTurn.game_rule_brief_text || "", /current_stage: 6-1/);
    assert.notEqual(nextTurn.current_turn_contract, firstTurnContract, "each host call must receive a newly built current-turn object");
    assert.equal(
      nextTurn.current_turn_contract?.rules_source_fingerprint,
      firstTurnContract?.rules_source_fingerprint,
      "stage changes must rebuild the turn contract without changing the bound rules fingerprint",
    );

    const validVersionedState = service.getRuntimeServiceState();
    service.setRuntimeServiceState({
      ...validVersionedState,
      match_session: {
        ...validVersionedState.match_session,
        season_version_snapshot: null,
      },
    });
    await assert.rejects(
      () => service.buildRuntimeHostContext("cruise", null, staleHostRequest),
      /Active season\/patch changed after this match started/,
      "active matches without a complete version snapshot must fail closed",
    );
    service.setRuntimeServiceState({
      ...validVersionedState,
      match_session: {
        ...validVersionedState.match_session,
        season_version_snapshot: {
          ...validVersionedState.match_session.season_version_snapshot,
          promotion_tuple: {
            ...validVersionedState.match_session.season_version_snapshot.promotion_tuple,
            hard_data_manifest: "data/core-patches/jcc/mismatched/manifest.json",
          },
        },
      },
    });
    await assert.rejects(
      () => service.buildRuntimeHostContext("cruise", null, staleHostRequest),
      /Active season\/patch changed after this match started/,
      "an in-progress match must reject a changed hard-data manifest even when season and patch ids match",
    );
    service.setRuntimeServiceState({
      ...validVersionedState,
      match_session: {
        ...validVersionedState.match_session,
        season_version_snapshot: {
          ...validVersionedState.match_session.season_version_snapshot,
          rules_source_fingerprint: "0".repeat(64),
        },
      },
    });
    await assert.rejects(
      () => service.buildRuntimeHostContext("cruise", null, staleHostRequest),
      /Active season\/patch changed after this match started/,
      "an in-progress match must reject in-place rule-source drift even when the promotion tuple is unchanged",
    );
    service.setRuntimeServiceState(validVersionedState);

    service.setRuntimeServiceState({
      ...service.getRuntimeServiceState(),
      response_task: { status: "idle" },
      self_state_refresh: {
        status: "completed_self_state_roi_stage_ocr",
        last_source: "self_state_roi_ocr",
        last_stage_round: "6-1",
        last_stage_round_source: "self_state_roi_ocr",
        last_completed_at: new Date().toISOString(),
        last_stage_round_observed_at: new Date().toISOString(),
        last_economy_observed_at: new Date().toISOString(),
        last_economy: { hp: 77, gold: 12, level: 7, xp: "4/56" },
        last_economy_sources: { hp: "self_state_roi_ocr", gold: "self_state_roi_ocr", level: "self_state_roi_ocr", xp: "self_state_roi_ocr" },
        last_missing_economy_fields: ["hp", "gold", "level", "xp"],
        last_self_state_roi_scope: "stage_only",
      },
    });
    const stageOnlyResult = await service.handleRuntimeAction("sendMessage", {
      mode: "cruise",
      text: "stage only authority check",
    }, {});
    const stageOnlyCompact = service.summarizeHostRequest(stageOnlyResult.host_request);
    assert.equal(stageOnlyCompact.runtime_context?.game_state_brief?.stage_round, "6-1");
    assert.equal(stageOnlyCompact.runtime_context?.match_facts?.latest_hud_self_state?.economy?.gold, null);
    assert.equal(stageOnlyCompact.live_state_summary?.economy?.gold, null);

    service.setRuntimeServiceState({
      ...service.getRuntimeServiceState(),
      response_task: { status: "idle" },
      self_state_refresh: {
        ...service.getRuntimeServiceState().self_state_refresh,
        last_stage_round_observed_at: new Date().toISOString(),
        last_economy_observed_at: staleObservedAt,
      },
    });
    const staleEconomyResult = await service.handleRuntimeAction("sendMessage", {
      mode: "cruise",
      text: "stage only stale economy check",
    }, {});
    const staleEconomyCompact = service.summarizeHostRequest(staleEconomyResult.host_request);
    assert.equal(staleEconomyCompact.runtime_context?.game_state_brief?.stage_round, "6-1");
    assert.equal(staleEconomyCompact.runtime_context?.match_facts?.latest_hud_self_state?.economy?.gold, null);
    assert.equal(staleEconomyCompact.live_state_summary?.economy?.gold, null);

    service.setRuntimeServiceState({
      ...service.getRuntimeServiceState(),
      response_task: { status: "idle" },
      self_state_refresh: {
        status: "completed_self_state_roi_ocr",
        last_source: "self_state_roi_ocr",
        last_stage_round: null,
        last_stage_round_source: null,
        last_previous_stage_round_evidence: "5-1",
        last_completed_at: freshObservedAt,
        last_economy: { gold: 50 },
        last_economy_sources: { gold: "self_state_roi_ocr" },
        last_missing_economy_fields: ["hp", "level", "xp"],
        last_self_state_roi_scope: "full_self_state",
      },
    });
    const missingStageResult = await service.handleRuntimeAction("sendMessage", {
      mode: "cruise",
      text: "missing stage authority check",
    }, {});
    const missingStageCompact = service.summarizeHostRequest(missingStageResult.host_request);
    assert.notEqual(missingStageCompact.runtime_context?.game_state_brief?.stage_round, "5-1");
    assert.equal(missingStageCompact.runtime_context?.match_facts?.latest_hud_self_state?.stage_round, null);
    assert.equal(missingStageCompact.runtime_context?.match_facts?.latest_hud_self_state?.economy?.gold, null);

    const cachedFactsObservedAt = new Date().toISOString();
    await writeJson(runtimePaths.matchContextFile, {
      schema: "jcc-runtime-ui-match-context-v1",
      match_session_id: matchSessionId,
      updated_at: cachedFactsObservedAt,
      latest_authoritative_facts: {
        schema: "jcc-runtime-authoritative-match-facts-v1",
        match_session_id: matchSessionId,
        updated_at: cachedFactsObservedAt,
        stage_round: "5-1",
        economy: { gold: 99 },
      },
    });
    service.setRuntimeServiceState({
      ...service.getRuntimeServiceState(),
      response_task: { status: "idle" },
      self_state_refresh: {
        status: "completed_self_state_roi_stage_ocr",
        last_source: "self_state_roi_ocr",
        last_stage_round: "6-2",
        last_stage_round_source: "self_state_roi_ocr",
        last_completed_at: cachedFactsObservedAt,
        last_stage_round_observed_at: cachedFactsObservedAt,
        last_economy: {},
        last_economy_sources: {},
        last_missing_economy_fields: ["hp", "gold", "level", "xp"],
        last_self_state_roi_scope: "stage_only",
      },
    });
    const cachedFactsResult = await service.handleRuntimeAction("sendMessage", {
      mode: "cruise",
      text: "cached authoritative facts check",
    }, {});
    const cachedFactsCompact = service.summarizeHostRequest(cachedFactsResult.host_request);
    assert.equal(cachedFactsCompact.runtime_context?.match_facts?.latest_authoritative_facts?.stage_round, "6-2");
    assert.equal(cachedFactsCompact.runtime_context?.match_facts?.latest_authoritative_facts?.economy?.gold, undefined);
  });

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-stage-context-authority-verifier-v1",
    checked: [
      "new_user_messages_use_latest_known_self_state_stage",
      "host_context_corrects_stale_recent_user_message_stage",
      "game_state_brief_uses_latest_known_self_state_stage",
    "stale_incoming_host_request_brief_and_contract_are_rebuilt",
    "consecutive_host_calls_rebuild_current_turn_contract",
    "missing_or_manifest_mismatched_match_version_snapshot_fails_closed",
    "in_place_rule_source_drift_fails_closed",
      "stage_only_self_state_does_not_promote_economy_without_same_frame_anchor",
      "stage_only_self_state_does_not_revalidate_stale_full_economy",
      "full_self_state_missing_stage_does_not_reuse_previous_stage",
      "cached_authoritative_facts_do_not_override_current_hud_missing_fields",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
