import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createActiveCoreProfileSnapshot } from "./jcc_test_core_profile_fixture.mjs";
import {
  closeHostAgentSession,
  detectHostAgent,
  runHostAgentRequest,
} from "../ui/electron/host-adapters.js";
import { HOST_SESSION_WARMUP_NATIVE_OUTPUT_SCHEMA } from "../ui/electron/host-coach-response-contract.js";
import { restoreHostEvidence, RANKING_ATOMIC_FIELDS } from "../ui/electron/host-evidence-materialization.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function byteSize(value) {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
}

function largestSectionBytes(value, limit = 8) {
  return Object.entries(value || {})
    .map(([key, section]) => ({ key, bytes: byteSize(section) }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit);
}

function collectForbiddenKeys(value, forbidden, pathPrefix = "$") {
  if (!value || typeof value !== "object") return [];
  const hits = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${pathPrefix}.${key}`;
    if (forbidden.has(key)) hits.push(childPath);
    hits.push(...collectForbiddenKeys(child, forbidden, childPath));
  }
  return hits;
}

function championByName(catalog, name) {
  return Object.values(catalog?.champions_by_cost || {}).flat().find((entry) => entry.name === name) || null;
}

function fileUrl(file, tag) {
  return `${pathToFileURL(path.resolve(file)).href}?${tag}`;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function emitReport(report) {
  const arg = process.argv.find((value) => value.startsWith("--report="));
  const index = process.argv.indexOf("--report");
  const target = arg?.slice(9) || (index >= 0 ? process.argv[index + 1] : null);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (target) {
    const file = path.resolve(target);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, "utf8");
  }
  process.stdout.write(text);
}

async function verifyLiveHostTurnDeltas(service, liveFixtures, tempRoot) {
  const selected = [liveFixtures.cruise, liveFixtures.augment].filter(Boolean);
  assert(selected.length === 2, "live Host benchmark requires cruise and augment fixtures");
  const detected = await detectHostAgent({
    provider: "codex",
    model: process.env.JCC_CODEX_MODEL || null,
    reasoning_effort: process.env.JCC_CODEX_REASONING_EFFORT || "low",
  });
  assert(detected.available === true, detected.error || "Codex CLI is unavailable");
  const hostSessionKey = `runtime-mode-live-benchmark:${Date.now()}`;
  const hostCwd = path.join(tempRoot, "live-host-cwd");
  await mkdir(hostCwd, { recursive: true });
  let hostSessionId = null;
  const reports = [];
  let warmupReport = null;
  try {
    const first = selected[0];
    const warmupStartedAt = Date.now();
    const warmup = await runHostAgentRequest(
      detected,
      service.buildHostSessionWarmupPrompt(first.request, first.capsule),
      {
        parseJson: true,
        jsonResponseKind: "session_warmup",
        outputSchema: HOST_SESSION_WARMUP_NATIVE_OUTPUT_SCHEMA,
        repoRoot: process.cwd(),
        hostCwd,
        timeoutMs: 180000,
        hostSessionKey,
        taskId: "runtime-mode-live-benchmark:warmup",
      },
    );
    assert(warmup.ok === true, warmup.error || "live Host warmup failed");
    assert(warmup.response?.schema === "jcc-host-session-bootstrap-ack-v1", "live Host warmup returned the wrong schema");
    assert(warmup.response?.accepted === true, "live Host warmup was not accepted");
    hostSessionId = warmup.session_id || warmup.thread_id || null;
    warmupReport = {
      elapsed_ms: Date.now() - warmupStartedAt,
      request_bytes: Buffer.byteLength(service.buildHostSessionWarmupPrompt(first.request, first.capsule), "utf8"),
      native_output_schema_applied: warmup.native_output_schema_applied === true,
    };

    for (const fixture of selected) {
      const prompt = service.buildHostTurnDeltaPrompt(fixture.request, fixture.capsule);
      const outputSchema = service.hostCoachNativeOutputSchemaForRequest(fixture.request);
      if (fixture.ui_mode === "augment") {
        assert(service.hostRequestRequiresAugmentRefreshDecision(fixture.request) === true, "augment fixture was not recognized as a structured advice turn");
        assert(Boolean(outputSchema?.properties?.choice_recommendation), "augment fixture native schema omitted choice_recommendation");
      }
      const startedAt = Date.now();
      const timing = { dispatched_at: null, accepted_at: null, first_token_at: null };
      const result = await runHostAgentRequest(detected, prompt, {
        parseJson: true,
        jsonResponseKind: "coach",
        allowContractCorrection: false,
        outputSchema,
        repoRoot: process.cwd(),
        hostCwd,
        timeoutMs: 180000,
        hostSessionKey,
        hostSessionId,
        taskId: `runtime-mode-live-benchmark:${fixture.ui_mode}`,
        onProviderTurnDispatched: (info) => { timing.dispatched_at = info.date; },
        onProviderTurnStarted: (info) => { timing.accepted_at = info.accepted_at; },
        onProviderFirstToken: (info) => { timing.first_token_at = info.date; },
      });
      const elapsedMs = Date.now() - startedAt;
      const summary = service.summarizeHostRequest(fixture.request);
      const turnReport = {
        ui_mode: fixture.ui_mode, ok: false, elapsed_ms: elapsedMs,
        request_chars: prompt.length, request_bytes: Buffer.byteLength(prompt, "utf8"),
        provider_elapsed_ms: timing.dispatched_at ? Date.now() - Date.parse(timing.dispatched_at) : null,
        timing, response: result.response ?? null,
        choice_recommendation: result.response?.choice_recommendation ?? result.response?.choiceRecommendation ?? null,
        expected_candidates: fixture.request.runtime_context?.current_match_user_report ?? summary.choices ?? null,
        expected_response_shape: summary.expected_response_shape ?? null,
        evaluator: fixture.request.runtime_context?.cruise_decision_context?.augment_choice_evaluation
          ?? fixture.request.runtime_context?.augment_choice_evaluation ?? null,
        native_output_schema_applied: result.native_output_schema_applied === true,
        error: result.error ?? null,
      };
      reports.push(turnReport);
      assert(result.ok === true, result.error || `${fixture.ui_mode} live Host turn failed`);
      let normalized;
      try {
        normalized = service.normalizeHostCoachResponse(result.response, fixture.request);
      } catch (error) {
        const finalText = result.response?.final_text || result.response?.finalText || result.response?.text || "";
        turnReport.error = error.message;
        throw new Error(`${error.message}; choice_recommendation=${JSON.stringify(turnReport.choice_recommendation)}; live_host_final_text=${JSON.stringify(finalText.slice(0, 1600))}`);
      }
      assert(normalized.request_id === fixture.request.request_id, `${fixture.ui_mode} response request_id drifted`);
      assert(normalized.request_hash === fixture.request.request_hash, `${fixture.ui_mode} response request_hash drifted`);
      assert(elapsedMs <= 60000, `${fixture.ui_mode} live Host turn exceeded 60 seconds: ${elapsedMs}ms`);
      if (fixture.ui_mode === "augment") {
        assert(
          Array.isArray(normalized.choice_recommendation?.candidate_ranking)
            && normalized.choice_recommendation.candidate_ranking.length === 3
            && normalized.choice_recommendation.refresh_action,
          `augment live Host turn omitted its recommendation; native_schema=${result.native_output_schema_applied === true}; response_keys=${Object.keys(result.response || {}).join(",")}`,
        );
      }
      hostSessionId = result.session_id || result.thread_id || hostSessionId;
      Object.assign(turnReport, {
        ok: true,
        ui_mode: fixture.ui_mode,
        elapsed_ms: elapsedMs,
        request_bytes: Buffer.byteLength(prompt, "utf8"),
        response_bytes: byteSize(result.response),
        native_output_schema_applied: result.native_output_schema_applied === true,
      });
    }
    return {
      ok: true,
      provider: "codex",
      session_policy: "one_start_match_one_persistent_host_session",
      warmup: warmupReport,
      turns: reports,
    };
  } catch (error) {
    error.live_host = { ok: false, provider: "codex", warmup: warmupReport, turns: reports, error: error.message };
    throw error;
  } finally {
    await closeHostAgentSession(hostSessionKey).catch(() => {});
  }
}

async function main() {
  const suiteStartedAt = performance.now();
  let phaseStartedAt = suiteStartedAt;
  const localTimings = [];
  const finishLocalPhase = (phase) => {
    const now = performance.now();
    const timing = { phase, elapsed_ms: Math.round(now - phaseStartedAt) };
    localTimings.push(timing);
    phaseStartedAt = now;
    process.stderr.write(`[mode-benchmark] ${phase}: ${timing.elapsed_ms}ms\n`);
  };
  const repoRoot = process.cwd();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-mode-bench-"));
  const isolatedEnv = {
    JCC_UI_DISABLE_CODEX_EXEC: "1",
    JCC_RUNTIME_DATA_DIR: tempRoot,
    JCC_DISABLE_RESIDENT_AUGMENT_CHOICE_OCR: "1",
    JCC_DISABLE_RESIDENT_GOD_CHOICE_OCR: "1",
    JCC_DISABLE_RESIDENT_ITEM_CHOICE_OCR: "1",
    JCC_DISABLE_RESIDENT_SELF_STATE_ROI_OCR: "1",
    JCC_DISABLE_RESIDENT_OWNED_AUGMENT_TEXT_PANEL_OCR: "1",
    JCC_DISABLE_LEFT_ITEM_RAIL_ROI_ICON: "1",
    JCC_ALLOW_COLD_CHOICE_OCR_FALLBACK: "0",
    JCC_ALLOW_COLD_SELF_STATE_ROI_OCR_FALLBACK: "0",
    JCC_UI_BACKGROUND_SELF_STATE_REFRESH_INTERVAL_MS: "999999",
  };
  const previousEnv = Object.fromEntries(Object.keys(isolatedEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, isolatedEnv);
  let service = null;

  try {
    const tag = `bench=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const rulesModule = await import(fileUrl("tools/jcc_active_rules_contract.mjs", tag));
    service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(repoRoot);
    const activeRulesBundle = rulesModule.loadActiveRulesBundle({ repoRoot, runtimePaths });
    const seasonVersionSnapshot = createActiveCoreProfileSnapshot(repoRoot, { runtimePaths });
    const noopWindow = { close() {}, minimize() {} };

    await service.handleRuntimeAction("saveUserPreferences", {
      rank_tier: "master",
      operation_speed: "normal_can_pivot_next_round",
      default_goal: "safe_top_four",
    }, noopWindow);

    const dailyStrategy = await service.handleRuntimeAction("sendMessage", {
      mode: "chat",
      text: "围绕奥恩、洛和霞，能给我一套当前赛季阵容吗？",
    }, noopWindow);
    assert(dailyStrategy.ok === true, "daily strategy message should build host request");
    assert(dailyStrategy.status === "awaiting_host_cli_agent_response", "benchmark must not call real host CLI");
    const strategyRequest = dailyStrategy.host_request;
    assert(strategyRequest.runtime_context?.host_session_kind === "daily", "strategy daily chat should use daily route");
    assert(strategyRequest.runtime_context?.context_policy?.include_user_preferences === true, "strategy daily chat should include preferences");
    assert(strategyRequest.runtime_context?.context_policy?.include_daily_big_data === true, "strategy daily chat should include big data");
    assert(strategyRequest.runtime_context?.context_policy?.include_season_catalog === true, "strategy daily chat should include season catalog");
    if (strategyRequest.runtime_context?.strategy_evidence_plan?.provider_capability === "native_dynamic_tools") {
      assert(!strategyRequest.season_catalog, "native-tools turn must query Core entities instead of attaching the catalog");
      assert(!strategyRequest.daily_big_data, "native-tools turn must query Ranking instead of attaching daily data");
    } else {
      const activeChampionNames = Object.values(strategyRequest.season_catalog?.champions_by_cost || {}).flat();
      assert(activeChampionNames.length > 0, "prefetch turn must expose active champions");
      assert(strategyRequest.daily_big_data?.available === true, "prefetch turn must expose active compatible rankings");
      assert(strategyRequest.daily_big_data?.ranking_scope?.fallback_to_other_tiers === false, "prefetch turn must forbid ranking-tier fallback");
    }

    const dailyGreeting = await service.handleRuntimeAction("sendMessage", {
      mode: "chat",
      text: "你好",
    }, noopWindow);
    assert(dailyGreeting.ok === true, "daily greeting should build host request");
    const greetingPolicy = dailyGreeting.host_request.runtime_context?.context_policy;
    assert(greetingPolicy?.include_user_preferences === false, "plain greeting should not attach user preferences");
    assert(greetingPolicy?.include_daily_big_data === false, "plain greeting should not attach big data");
    assert(greetingPolicy?.include_season_catalog === false, "plain greeting should not attach season catalog");

    const greetingSummary = service.summarizeHostRequest(dailyGreeting.host_request);
    const strategySummary = service.summarizeHostRequest(strategyRequest);
    await service.handleRuntimeAction("saveUserPreferences", {
      rank_tier: "diamond",
      operation_speed: "normal_can_pivot_next_round",
      default_goal: "safe_top_four",
    }, noopWindow);
    const diamondStrategy = await service.handleRuntimeAction("sendMessage", {
      mode: "chat",
      text: "按我当前段位的大数据，给我今天的上分阵容方向。",
    }, noopWindow);
    const diamondStrategySummary = service.summarizeHostRequest(diamondStrategy.host_request);
    if (diamondStrategy.host_request?.runtime_context?.strategy_evidence_plan?.provider_capability !== "native_dynamic_tools") {
      assert(
        diamondStrategy.host_request?.daily_big_data?.ranking_scope?.required_ranking_label === "master_plus",
        "diamond user preference must still query only Master+ ranking evidence",
      );
      assert(
        (diamondStrategy.host_request?.daily_big_data?.ranking_scope?.selected_tier_ids || [])
          .every((tierId) => tierId === "0"),
        "diamond user preference must not select Platinum-Diamond or all-tier ranking evidence",
      );
    }
    await service.handleRuntimeAction("saveUserPreferences", {
      rank_tier: "master",
      operation_speed: "normal_can_pivot_next_round",
      default_goal: "safe_top_four",
    }, noopWindow);
    const currentPreferenceGreeting = await service.handleRuntimeAction("sendMessage", {
      mode: "chat",
      text: "你好",
    }, noopWindow);
    const dailyStrategyCapsule = service.hostContextCapsuleForRequest(strategyRequest, {
      routeKey: "daily:benchmark",
      provider: "codex",
      model: "benchmark-model",
    });
    const dailyGreetingCapsule = service.hostContextCapsuleForRequest(currentPreferenceGreeting.host_request, {
      routeKey: "daily:benchmark",
      provider: "codex",
      model: "benchmark-model",
    });
    const strategyPrompt = service.buildHostTurnDeltaPrompt(strategyRequest, dailyStrategyCapsule);
    assert(
      dailyGreetingCapsule.fingerprint === dailyStrategyCapsule.fingerprint,
      "daily greeting and strategy turns must share one mode-independent static capsule",
    );
    assert(byteSize(greetingSummary) < 12000, "plain greeting selected context should stay compact");
    assert(
      Buffer.byteLength(strategyPrompt, "utf8") <= service.HOST_TURN_DELTA_MAX_BYTES,
      `serialized strategy turn should stay under the current-turn safety budget; got ${Buffer.byteLength(strategyPrompt, "utf8")} bytes; precompact=${byteSize(strategySummary)} bytes; largest=${JSON.stringify(largestSectionBytes(strategySummary))}; selected=${JSON.stringify(largestSectionBytes(strategySummary.selected_ranking_candidates))}; candidates=${JSON.stringify((strategySummary.selected_ranking_candidates?.candidates || []).map((candidate) => ({ id: candidate.id, bytes: byteSize(candidate) })))}; runtime=${JSON.stringify(largestSectionBytes(strategySummary.runtime_context))}`,
    );

    const previousState = (await service.handleRuntimeAction("getState", {}, noopWindow)).state;
    service.setRuntimeServiceState({
      ...previousState,
      match_session: {
        status: "active",
        match_session_id: "bench-match-session",
        season_version_snapshot: seasonVersionSnapshot,
      },
      active_mode: "cruise",
    });

    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    await writeFile(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), `${JSON.stringify({
      schema: "jcc-cruise-live-state-benchmark-v1",
      match_session_id: "bench-match-session",
      phase: { status: "planning", stage_round: "3-2" },
      economy: {
        gold: { value: 42, source: "benchmark" },
        hp: { value: 68, source: "benchmark" },
        level: { value: 6, source: "benchmark" },
        xp: { value: 14, to_next: 36, display: "14/36", source: "benchmark" },
      },
      own_board: {
        units: [
          { name: "奥恩", cost: 1, star: 2, items: ["石像鬼石板甲"] },
          { name: "洛", cost: 1, star: 2, items: [] },
          { name: "霞", cost: 1, star: 1, items: ["无尽之刃"] },
        ],
      },
      shop: {
        units: [
          { name: "慎", cost: 2 },
          { name: "阿萝拉", cost: 4 },
        ],
      },
    }, null, 2)}\n`, "utf8");

    const matchModeCases = [
      { uiMode: "cruise", text: "我现在该留哪些牌？", shouldAttachStrategy: true },
      {
        uiMode: "augment",
        text: "三个强化选项是：存心失利 / 花到上头 / 打捞桶；装备没变。选哪个？要不要刷新？",
        shouldAttachStrategy: true,
        expectedChoiceCount: 3,
      },
      {
        uiMode: "item",
        text: "五个装备选项是：无尽之刃 / 鬼索的狂暴之刃 / 正义之手 / 石像鬼石板甲 / 巨人杀手；选哪个？",
        shouldAttachStrategy: true,
        expectedChoiceCount: 5,
        itemChoiceKind: "completed_item_forge",
      },
      { uiMode: "lineup", text: "根据我方棋盘给我一个站位调整建议。", shouldAttachStrategy: true },
      { uiMode: "lineup", text: "给我一个霞主C的推荐阵容图。", shouldAttachStrategy: true },
      { uiMode: "vars", text: "确认本局变量。", shouldAttachStrategy: false },
    ];

    finishLocalPhase("initialization_daily_cases_and_match_fixture");

    const modeResults = [];
    const liveFixtures = {};
    let matchStaticFingerprint = null;
    let boundedStaticGrowthChecked = false;
    for (const {
      uiMode,
      text,
      shouldAttachStrategy,
      expectedChoiceCount = null,
      itemChoiceKind = null,
    } of matchModeCases) {
      const modeSet = await service.handleRuntimeAction("setMode", { mode: uiMode }, noopWindow);
      assert(modeSet.ok === true, `${uiMode} setMode should succeed`);
      const runtimeMode = service.uiToRuntimeMode[uiMode];
      const usesUserReportedChoiceSet = ["augment", "item"].includes(uiMode);
      let request;
      if (usesUserReportedChoiceSet) {
        const stageRound = uiMode === "augment" ? "3-2" : "4-2";
        const choiceKind = uiMode === "augment" ? "augment" : "item";
        const optionRequests = uiMode === "augment"
          ? await Promise.all(["打捞桶+", "飞升", "星界赐福 II"].map((query) => service.handleRuntimeAction("getDecisionInputOptions", {
              mode: runtimeMode,
              choice_kind: choiceKind,
              stage_round: stageRound,
              tier_color: "gold",
              query,
              limit: 1,
            }, noopWindow)))
          : [await service.handleRuntimeAction("getDecisionInputOptions", {
              mode: runtimeMode,
              choice_kind: choiceKind,
              stage_round: stageRound,
              ...(itemChoiceKind ? { item_choice_kind: itemChoiceKind } : {}),
              limit: expectedChoiceCount,
            }, noopWindow)];
        const options = optionRequests[0];
        const optionCandidates = uiMode === "augment"
          ? optionRequests.map((entry) => entry.options.candidates[0]).filter(Boolean)
          : options.options.candidates.slice(0, expectedChoiceCount);
        assert(optionCandidates.length === expectedChoiceCount, `${uiMode} must resolve the expected active S18 catalog candidates`);
        const candidates = optionCandidates.map((candidate, index) => ({
          slot: index + 1,
          name: candidate.name,
          ref: candidate.ref,
          tier: candidate.tier,
          tier_color: candidate.tier_color,
          reward_text: candidate.reward_text,
          god_name: candidate.god_name,
          item_category: candidate.item_category,
          item_subtype: candidate.item_subtype,
        }));
        const result = await service.handleRuntimeAction("submitDecisionInput", {
          mode: runtimeMode,
          choice_kind: choiceKind,
          stage_round: stageRound,
          ...(uiMode === "augment" ? { tier: "gold" } : {}),
          ...(itemChoiceKind ? { item_choice_kind: itemChoiceKind } : {}),
          payload_binding: options.payload_binding,
          candidates,
          request_advice: true,
          advice_action: "global_advice",
        }, noopWindow);
        assert(result.ok === true, `${uiMode} structured card should build host request`);
        assert(
          result.status === "decision_input_recorded" && result.response_task?.response_task_id,
          `${uiMode} structured card should create one advice owner under disabled host CLI: ${JSON.stringify({ status: result.status, message: result.message, error: result.error, response_task: result.response_task, candidate_count: candidates.length })}`,
        );
        const recordedChoiceSet = result.state?.match_context?.reported_choice_sets_by_mode?.[runtimeMode] || null;
        assert(recordedChoiceSet?.source === "structured_decision_input_card", `${uiMode} must persist a structured-card report`);
        assert(recordedChoiceSet?.candidate_count === expectedChoiceCount, `${uiMode} must persist all reported candidates`);
        const contextPack = { schema: "jcc-runtime-context-pack-v1", scope: "mode", mode_id: runtimeMode };
        const hostRequestSeed = {
          request_id: `benchmark-${runtimeMode}`,
          request_hash: `benchmark-${runtimeMode}-hash`,
          mode: runtimeMode,
          user_message: text,
          task: {
            type: "runtime_event_followup",
            trigger_id: "runtime_event_followup",
            structured_card_action: true,
          },
          choices: {
            schema: "jcc-host-choice-candidates-v1",
            source: "current_match_user_report",
            kind: choiceKind,
            stage_round: stageRound,
            candidates: recordedChoiceSet.candidates,
          },
          context: {
            mode: runtimeMode,
            choices: {
              schema: "jcc-host-choice-candidates-v1",
              source: "current_match_user_report",
              mode: runtimeMode,
              kind: choiceKind,
              stage_round: stageRound,
              candidates: recordedChoiceSet.candidates,
            },
          },
          context_pack: contextPack,
        };
        request = {
          ...hostRequestSeed,
          runtime_context: await service.buildRuntimeHostContext(runtimeMode, contextPack, hostRequestSeed),
        };
      } else if (uiMode === "vars") {
        const contextPack = { schema: "jcc-runtime-context-pack-v1", scope: "mode", mode_id: runtimeMode };
        const hostRequestSeed = {
          request_id: `benchmark-${runtimeMode}`,
          request_hash: `benchmark-${runtimeMode}-hash`,
          mode: runtimeMode,
          user_message: text,
          context_pack: contextPack,
        };
        request = {
          ...hostRequestSeed,
          runtime_context: await service.buildRuntimeHostContext(runtimeMode, contextPack, hostRequestSeed),
        };
      } else {
        const result = await service.handleRuntimeAction("sendMessage", { mode: uiMode, text }, noopWindow);
        assert(result.ok === true, `${uiMode} sendMessage should build host request`);
        assert(
          result.status === "awaiting_host_cli_agent_response",
          `${uiMode} should expose host request under disabled host CLI; result=${JSON.stringify({ ok: result.ok, status: result.status, message: result.message, error: result.error })}`,
        );
        request = result.host_request;
      }
      const policy = request.runtime_context?.context_policy || {};
      assert(request.runtime_context?.host_session_kind === "match", `${uiMode} should use match route`);
      assert(request.context_pack?.scope === "mode", `${uiMode} should use lazy mode context pack`);
      assert(request.runtime_context?.match_session?.match_session_id === "bench-match-session", `${uiMode} should carry match session`);
      if (shouldAttachStrategy) {
        assert(policy.include_user_preferences === true, `${uiMode} should include preferences`);
        assert(policy.include_daily_big_data === true, `${uiMode} should include big data`);
        assert(policy.include_season_catalog === true, `${uiMode} should include season catalog`);
      }
      const summary = service.summarizeHostRequest(request);
      if (uiMode === "cruise") {
        assert(!("_captured_live_state_summary" in (request.runtime_context || {})),
          "the internal captured live-state snapshot must not leak into the Host request");
        const liveStage = request.context?.live_state_summary?.phase?.stage_round?.value
          ?? request.context?.live_state_summary?.phase?.stage_round
          ?? null;
        const decisionStage = request.runtime_context?.decision_snapshot?.stage_round || null;
        assert(decisionStage === liveStage,
          `one Host turn must build its decision snapshot and exposed live state from the same captured frame; decision=${decisionStage} live=${liveStage}`);
      }
      if (usesUserReportedChoiceSet) {
        assert(
          ["current_match_user_report", "game_state_brief.unknown_final_choices.observed_options"].includes(summary.choices?.source),
          `${uiMode} host request must expose the canonical structured-card candidates; choices=${JSON.stringify(summary.choices)}`,
        );
        assert(summary.choices?.candidates?.length === expectedChoiceCount, `${uiMode} host request must include every reported candidate; choices=${JSON.stringify(summary.choices)}`);
      }
      const routeKey = `match:bench-match-session`;
      const capsule = service.hostContextCapsuleForRequest(request, {
        routeKey,
        provider: "codex",
        model: "benchmark-model",
      });
      const promptBytes = Buffer.byteLength(service.buildHostTurnDeltaPrompt(request, capsule), "utf8");
      assert(capsule.budget?.max_tokens === 50_000, `${uiMode} static capsule must declare the 50K-token product allowance`);
      assert(capsule.budget?.max_bytes === 256 * 1024, `${uiMode} static capsule must declare the 256KB serialized safety ceiling`);
      assert(capsule.budget?.observed_bytes <= capsule.budget?.max_bytes, `${uiMode} static capsule must stay within its production ceiling`);
      const metaMapTierSizes = Object.values(capsule.static_context?.daily_big_data?.tiers || {}).map((tier) => (
        Array.isArray(tier?.lineup_families) ? tier.lineup_families.length : 0
      ));
      for (const tier of Object.values(capsule.static_context?.daily_big_data?.tiers || {})) {
        assert((Array.isArray(tier?.lineup_families) ? tier.lineup_families : []).length <= 12, `${uiMode} meta map must cap each ranking tier at 12 lineup families`);
      }
      assert(capsule.static_context?.daily_big_data?.available === true, `${uiMode} capsule must preserve the active Master+ ranking status`);
      assert(metaMapTierSizes.every((size) => size <= 12), `${uiMode} ranking-family cap must remain enforced while rankings are unavailable`);
      if (!boundedStaticGrowthChecked) {
        const repeatedItems = Array.from({ length: 500 }, (_, index) => `stress-item-${index}-${"x".repeat(100)}`);
        const stressSeasonCatalog = {
          ...(request.season_catalog || request.context?.season_catalog || request.runtime_context?.season_catalog || {}),
          champion_names: Array.from({ length: 2000 }, (_, index) => `stress-champion-${index}-${"英".repeat(200)}`),
          champions_by_cost: Object.fromEntries(Array.from({ length: 20 }, (_, cost) => [
            String(cost + 1),
            Array.from({ length: 200 }, (_, index) => ({ name: `cost-${cost + 1}-champion-${index}-${"棋".repeat(200)}` })),
          ])),
          traits: Array.from({ length: 1000 }, (_, index) => ({
            name: `stress-trait-${index}-${"羁".repeat(200)}`,
            code_id: index,
            breakpoints: Array.from({ length: 100 }, (_, breakpoint) => breakpoint + 1),
          })),
        };
        const stressRulesBundle = {
          ...activeRulesBundle,
          patch_rule_overrides: {
            schema: "jcc-patch-rule-overrides-stress-v1",
            summary: "规".repeat(100_000),
            rules: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
              `rule-${index}-${"键".repeat(100)}`,
              { summary: "值".repeat(5000), raw: "x".repeat(10_000) },
            ])),
          },
        };
        const stressCapsule = service.hostContextCapsuleForRequest(request, {
          routeKey: `${routeKey}:bounded-growth`,
          provider: "codex",
          model: "benchmark-model",
          staticContextSource: {
            active_rules_bundle: stressRulesBundle,
            user_preferences: {
              ...(request.user_preferences || request.context?.user_preferences || {}),
              raw_unbounded_preference: "偏".repeat(500_000),
              nested_unbounded_preference: { raw: "好".repeat(500_000) },
            },
            user_strategy_memory: {
              schema: "jcc-runtime-user-memory-v1",
              strategy_rows: Array.from({ length: 100 }, (_, index) => ({
                approved: true,
                text: `strategy-${index}-${"策".repeat(2000)}`,
                weight: 1,
              })),
              strategy_conflict_notices: Array.from({ length: 100 }, (_, index) => `conflict-${index}-${"冲".repeat(1000)}`),
            },
            daily_big_data: request.daily_big_data || request.context?.daily_big_data || request.runtime_context?.daily_big_data || null,
            season_catalog: stressSeasonCatalog,
            item_browse_taxonomy: {
              schema: "jcc-item-browse-taxonomy-stress-v1",
              classified_item_count: repeatedItems.length,
              items_by_browse_facet: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`facet-${index}`, repeatedItems])),
              items_by_primary_role: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`role-${index}`, repeatedItems])),
              policy: "stress-input-must-not-expand-the-static-capsule",
            },
            strategy_wiki_context: {
              schema: "jcc-strategy-wiki-host-context-v1",
              pages: Array.from({ length: 100 }, (_, index) => ({
                title: `wiki-${index}`,
                category: "universal_gameplay_strategy",
                summary: "维".repeat(5000),
              })),
            },
            version_identity: activeRulesBundle.version_identity || null,
            rules_source_fingerprint: activeRulesBundle.source_fingerprint || null,
          },
        });
        assert(stressCapsule.budget?.observed_bytes <= stressCapsule.budget?.max_bytes, "oversized static sources must stay inside the serialized safety ceiling");
        assert(stressCapsule.static_context?.user_strategy_memory?.strategy_rows?.length === 12, "static capsule must retain at most 12 approved personal strategy rules");
        assert(stressCapsule.static_context?.strategy_wiki_context?.pages?.length === 8, "static capsule must retain at most eight scoped Wiki summaries");
        assert(stressCapsule.static_context?.item_browse_taxonomy?.browse_facets?.length === 24, "static capsule must bound taxonomy facets independently of source growth");
        assert(stressCapsule.static_context?.item_browse_taxonomy?.primary_roles?.length === 24, "static capsule must bound taxonomy roles independently of source growth");
        assert(stressCapsule.static_context?.season_catalog?.champion_names?.length === 160, "static capsule must bound season champion names independently of source growth");
        assert(stressCapsule.static_context?.season_catalog?.traits?.length === 120, "static capsule must bound season traits independently of source growth");
        assert(stressCapsule.static_context?.rules?.patch_rule_overrides?.rules?.length === 24, "static capsule must bound patch rule overrides independently of source growth");
        assert(!JSON.stringify(stressCapsule).includes("raw_unbounded_preference"), "static capsule must whitelist user preference fields");
        boundedStaticGrowthChecked = true;
      }
      if (matchStaticFingerprint === null) matchStaticFingerprint = capsule.fingerprint;
      else assert(capsule.fingerprint === matchStaticFingerprint, `${uiMode} must reuse the same match static capsule across mode changes`);
      const bootstrapPrompt = service.buildHostSessionBootstrapPrompt(request, capsule);
      const turnDelta = service.compactHostTurnDelta(request, capsule);
      const turnDeltaPrompt = service.buildHostTurnDeltaPrompt(request, capsule);
      const bootstrapPromptBytes = Buffer.byteLength(bootstrapPrompt, "utf8");
      const turnDeltaPromptBytes = Buffer.byteLength(turnDeltaPrompt, "utf8");
      assert(bootstrapPrompt.includes("\"item_browse_taxonomy\":"), `${uiMode} bootstrap must include the curated equipment taxonomy once`);
      if (usesUserReportedChoiceSet) {
        assert(
          ["current_match_user_report", "game_state_brief.unknown_final_choices.observed_options"].includes(turnDelta.choices?.source),
          `${uiMode} turn delta must retain canonical structured-card provenance`,
        );
        assert(turnDelta.choices?.candidates?.length === expectedChoiceCount, `${uiMode} turn delta must retain current reported candidates`);
        const serializedTurnDelta = JSON.stringify(turnDelta).toLowerCase();
        for (const forbiddenChoiceSource of [
          "benchmark_host_visual",
          "rapidocr",
          "choice_text_ocr",
          "choice_roi_ocr",
          "host_multimodal_fallback",
        ]) {
          assert(!serializedTurnDelta.includes(forbiddenChoiceSource), `${uiMode} turn delta must not carry ${forbiddenChoiceSource}`);
        }
      }
      const restoredDelta = restoreHostEvidence(JSON.parse(turnDeltaPrompt.split("INPUT_JSON:\n").at(-1)));
      const canonicalWorkingSet = restoredDelta.runtime_context?.strategy_fit_packet?.candidate_working_set || [];
      assert(canonicalWorkingSet.length <= 10, `${uiMode} final Agent pool must contain at most 10 complete candidates`);
      const originalCandidates = request.runtime_context?.strategy_fit_packet?.candidate_working_set || [];
      for (const candidate of canonicalWorkingSet) {
        const original = originalCandidates.find((row) => (row.candidate_id || row.line_id) === (candidate.candidate_id || candidate.line_id)
          && row.selected_variant_id === candidate.selected_variant_id);
        assert(original, `${uiMode} retained candidate must have an exact current-turn source`);
        for (const key of RANKING_ATOMIC_FIELDS) {
          if (original[key] !== undefined && original[key] !== null) {
            assert(candidate[key] !== undefined && candidate[key] !== null, `${uiMode} retained candidate must restore ${key}`);
          }
        }
      }
      if (canonicalWorkingSet.length) {
        assert(
          turnDelta.selected_ranking_candidates?.schema === "jcc-ranking-candidate-working-set-reference-v1",
          `${uiMode} must expose selected_ranking_candidates as references when the canonical working set is attached`,
        );
        assert(
          turnDelta.selected_ranking_candidates?.candidates === undefined,
          `${uiMode} must not duplicate complete Ranking candidates outside strategy_fit_packet`,
        );
        for (const candidate of canonicalWorkingSet) {
          assert(candidate.canonical_variant, `${uiMode} canonical working-set candidates must retain one complete atomic variant`);
        }
      }
      const forbiddenTurnDeltaKeys = new Set([
        "static_context",
        "season_catalog",
        "item_browse_taxonomy",
        "daily_big_data",
        "strategy_wiki_context",
        "base_game_rules",
        "season_normal_rules",
        "season_special_rules",
        "patch_strategy_overrides",
        "patch_rule_overrides",
        "coach_signature_contract",
        "host_instruction_contract_fingerprint",
        "active_rules_bundle",
        "game_rule_contract",
        "economy_management_context",
        "recent_user_messages",
        "tempo_questions_for_host_model",
        "adb_target",
        "last_watcher_stdout",
        "last_watcher_error",
        "debug_evidence_dir",
        "image_reference",
        "source_command",
        "source_diagnostics",
        "parse_rejection_counts",
        "unknown_command_counts",
        "payload_shape_counts_by_command",
      ]);
      const forbiddenTurnDeltaHits = collectForbiddenKeys(turnDelta, forbiddenTurnDeltaKeys);
      assert(
        forbiddenTurnDeltaHits.length === 0,
        `${uiMode} turn delta repeated static/history keys: ${forbiddenTurnDeltaHits.join(", ")}`,
      );
      assert(turnDelta.capsule_ref?.fingerprint, `${uiMode} turn delta must reference the loaded static capsule`);
      assert(turnDelta.request_id, `${uiMode} turn delta must keep request identity`);
      assert(turnDelta.mode === request.mode, `${uiMode} turn delta must keep the active mode`);
      assert(turnDelta.runtime_context?.current_turn_contract, `${uiMode} turn delta must keep current-turn authority`);
      assert(!("context_pack" in turnDelta), `${uiMode} turn delta must not resend the static mode context pack`);
      assert(!("instructions" in turnDelta), `${uiMode} turn delta must not resend fixed host instructions`);
      const currentHud = turnDelta.live_state_summary;
      if (currentHud?.phase?.stage_round || Object.values(currentHud?.economy || {}).some((value) => value !== null && value !== undefined)) {
        const repeatedHud = turnDelta.runtime_context?.match_facts?.latest_hud_self_state;
        assert(
          !repeatedHud?.stage_round
            && !Object.values(repeatedHud?.economy || {}).some((value) => value !== null && value !== undefined),
          `${uiMode} turn delta must not repeat current HUD facts inside match_facts`,
        );
      }
      assert(!JSON.stringify(summary).includes("83110103_6"), `${uiMode} summary should not expose raw trait ids`);
      const summaryBytes = byteSize(summary);
      modeResults.push({
        ui_mode: uiMode,
        runtime_mode: request.mode,
        policy,
        summary_bytes: summaryBytes,
        largest_sections: largestSectionBytes(summary),
        runtime_context_sections: largestSectionBytes(summary.runtime_context),
        has_live_state: Boolean(summary.live_state_summary),
        prompt_bytes: promptBytes,
        capsule_bytes: byteSize(capsule),
        capsule_static_sections: largestSectionBytes(capsule.static_context),
        capsule_rules_sections: largestSectionBytes(capsule.static_context?.rules),
        capsule_base_rule_sections: largestSectionBytes(capsule.static_context?.rules?.base_game_rules),
        capsule_signature_sections: largestSectionBytes(capsule.static_context?.rules?.coach_signature_contract),
        capsule_special_rule_sections: largestSectionBytes(capsule.static_context?.rules?.season_special_rules),
        bootstrap_prompt_bytes: bootstrapPromptBytes,
        turn_delta_prompt_bytes: turnDeltaPromptBytes,
        materialized_payload_bytes: byteSize(turnDelta),
        restored_payload_bytes: byteSize(restoredDelta),
        materialization: turnDelta.runtime_context?.host_evidence_materialization || null,
        turn_delta_largest_sections: largestSectionBytes(turnDelta),
        turn_delta_runtime_context_sections: largestSectionBytes(turnDelta.runtime_context),
        turn_delta_cruise_context_sections: largestSectionBytes(turnDelta.runtime_context?.cruise_decision_context),
        turn_delta_strategy_fit_sections: largestSectionBytes(turnDelta.runtime_context?.strategy_fit_packet),
      });
      // Production provider turns use bootstrapPrompt once, then turnDeltaPrompt
      // for every subsequent turn in the same native provider session.
      const turnDeltaBudget = service.hostRequestIsStrategicTurn(turnDelta)
        ? service.HOST_STRATEGIC_TURN_DELTA_TARGET_BYTES
        : service.HOST_PERSISTENT_TURN_DELTA_TARGETS[request.mode]
          || service.HOST_TURN_DELTA_TARGET_BYTES;
      assert(
        turnDeltaPromptBytes < turnDeltaBudget,
        `${uiMode} persistent-session turn delta ${turnDeltaPromptBytes} bytes should stay under ${turnDeltaBudget}; static context belongs only in the ${bootstrapPromptBytes}-byte bootstrap; largest=${JSON.stringify(largestSectionBytes(turnDelta))}; runtime=${JSON.stringify(largestSectionBytes(turnDelta.runtime_context))}; cruise=${JSON.stringify(largestSectionBytes(turnDelta.runtime_context?.cruise_decision_context))}; fit=${JSON.stringify(largestSectionBytes(turnDelta.runtime_context?.strategy_fit_packet))}`,
      );
      for (const forbiddenStaticSection of ["\"season_catalog\":{", "\"item_browse_taxonomy\":{", "\"daily_big_data\":{", "\"strategy_wiki_context\":{", "\"base_game_rules\":{"]) {
        assert(!turnDeltaPrompt.includes(forbiddenStaticSection), `${uiMode} turn delta must not repeat static section ${forbiddenStaticSection}`);
      }
      if (uiMode === "cruise" || uiMode === "augment") {
        liveFixtures[uiMode] = {
          ui_mode: uiMode,
          request,
          capsule,
        };
      }
      finishLocalPhase(`mode_${modeResults.length}_${uiMode}`);
    }

    const autoLineupCard = await service.handleRuntimeAction("sendMessage", {
      mode: "cruise",
      text: "请在阵容图卡片里面帮我做这套阵容的最高上限。",
    }, noopWindow);
    assert(autoLineupCard.host_request?.mode === "lineup_card", "an explicit card request from cruise must route to lineup_card automatically");
    assert(autoLineupCard.host_request?.pinned_result_required === true, "lineup-card auto route must require a structured pinned result");

    const ordinaryLineupDiscussion = await service.handleRuntimeAction("sendMessage", {
      mode: "cruise",
      text: "你确定 6 幻灵战队加 4 挑战者吗？",
    }, noopWindow);
    assert(ordinaryLineupDiscussion.host_request?.mode === "cruise", "ordinary trait/lineup discussion must remain direct cruise chat");
    assert(ordinaryLineupDiscussion.host_request?.pinned_result_required === false, "ordinary lineup discussion must not require a pinned card");

    finishLocalPhase("lineup_routing_cases");
    const localSuiteElapsedMs = Math.round(performance.now() - suiteStartedAt);
    const liveHost = hasFlag("--live-host")
      ? await verifyLiveHostTurnDeltas(service, liveFixtures, tempRoot)
      : null;
    await emitReport({
      ok: true,
      schema: "jcc-runtime-mode-host-request-benchmark-v1",
      local_timings: {
        clock: "performance.now",
        scope: "serial_local_preparation_and_assertions_excludes_live_host_and_cleanup",
        total_ms: localSuiteElapsedMs,
        phases: localTimings,
      },
      checked: [
        "daily_strategy_selected_context",
        "daily_greeting_minimal_context",
        "all_user_ranks_preserve_master_plus_only_policy_while_rankings_unavailable",
        "match_all_modes_lazy_context_pack",
        "choice_modes_use_real_current_match_user_reports",
        "choice_turn_deltas_exclude_ocr_and_host_visual_provenance",
        "current_season_catalog_guardrails",
        "bounded_selected_context_size",
        "one_time_static_bootstrap_and_bounded_turn_deltas",
        "bounded_static_growth_inputs",
        "provider_response_uses_local_normalization_without_correction_turn",
        "mode_independent_static_capsule_fingerprint",
        "explicit_lineup_card_auto_routing",
        "ordinary_lineup_discussion_not_forced_to_card",
        ...(liveHost ? ["real_host_cli_runtime_sized_turns"] : ["no_real_host_cli_call"]),
      ],
      daily: {
        greeting_summary_bytes: byteSize(greetingSummary),
        strategy_summary_bytes: byteSize(strategySummary),
        strategy_largest_sections: largestSectionBytes(strategySummary),
        strategy_policy: strategyRequest.runtime_context.context_policy,
      },
      modes: modeResults,
      live_host: liveHost,
    });
  } finally {
    await service?.handleRuntimeAction("shutdown", { reason: "verify_mode_host_request_benchmark_cleanup" }, null).catch(() => {});
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

main().catch(async (error) => {
  await emitReport({ ok: false, schema: "jcc-runtime-mode-host-request-benchmark-v1", error: error.message, live_host: error.live_host ?? null });
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
