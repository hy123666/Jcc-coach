import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-host-selected-context-"));
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

function factName(entry) {
  return entry?.name || entry?.champion_name || entry?.unit_name || entry?.hero_name || null;
}

function byName(rows, name) {
  return (Array.isArray(rows) ? rows : []).find((entry) => factName(entry) === name);
}

function collectKeyPaths(value, targetKey, currentPath = "$", paths = [], seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return paths;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectKeyPaths(entry, targetKey, `${currentPath}[${index}]`, paths, seen));
    return paths;
  }
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = `${currentPath}.${key}`;
    if (key === targetKey) paths.push(nextPath);
    collectKeyPaths(entry, targetKey, nextPath, paths, seen);
  }
  return paths;
}

async function main() {
  const contextPolicy = JSON.parse(await readFile(path.join(root, "data/runtime/jcc/host-request-context-policy-contract.json"), "utf8"));
  for (const required of [
    "runtime_context.strategy_evidence_snapshot",
    "runtime_context.strategy_evidence_plan",
    "runtime_context.strategy_evidence_coverage",
    "runtime_context.strategy_evidence_prefetch",
  ]) {
    assert(
      contextPolicy.provider_neutral_selected_context_contract?.always_include_for_match_answers?.includes(required),
      `${required} must be required for Match answers`,
    );
  }
  assert(
    contextPolicy.provider_neutral_selected_context_contract?.numeric_fact_authority?.includes("Missing HUD values remain missing"),
    "selected-context contract must reject missing HUD values before numeric coercion",
  );
  assert(
    contextPolicy.provider_neutral_selected_context_contract?.numeric_fact_authority?.includes("economy.hp <= 0"),
    "selected-context contract must exclude active-match non-positive HP without explicit elimination",
  );
  await withRuntimeEnv(async (tempRoot) => {
    const tag = `selected-context-${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const rulesModule = await import(fileUrl("tools/jcc_active_rules_contract.mjs", tag));
    const isolatedRankingRoot = path.join(tempRoot, "isolated-live-rankings");
    await mkdir(isolatedRankingRoot, { recursive: true });
    const runtimePaths = storeModule.createRuntimePaths(root, {
      dataRoot: tempRoot,
      liveRankingsRoot: isolatedRankingRoot,
    });
    const activeRulesBundle = rulesModule.loadActiveRulesBundle({ repoRoot: root, runtimePaths });
    const activeCoreProfileSnapshot = createActiveCoreProfileSnapshot(root, { runtimePaths });
    service.configureRuntimeServicePaths({
      dataRoot: tempRoot,
      liveRankingsRoot: isolatedRankingRoot,
    });
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    await writeJson(runtimePaths.userSettingsFile, {
      schema: "jcc-runtime-user-settings-v1",
      rank_tier: "diamond",
      operation_speed: "normal_can_pivot_next_round",
      default_goal: "balanced",
      source: "stale_legacy_json_mirror",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-selected-context-live-state-v1",
      match_session_id: "verify-selected-context-match",
      observed_at: "2026-07-05T08:00:00.000Z",
      source_freshness: { status: "fresh" },
      phase: { stage_round: "2-5", status: 1 },
      economy: { hp: 93, gold: 18, level: 4, xp: "4/10", streak: 1 },
      own_board: {
        units: [
          {
            champion_name: "崔斯特",
            cost: 1,
            star: 2,
            position: { row: 4, col: 4 },
            semantic_status: "mumu_structured_self_view_anchor_candidate",
            source: "mumu_bridge_shop_self_view_anchor",
            promotion_policy: "shop_self_view_anchor_plus_fresh_current_view",
          },
          {
            champion_name: "潘森",
            cost: 2,
            star: 1,
            position: { row: 2, col: 3 },
            semantic_status: "mumu_structured_self_view_anchor_candidate",
            source: "mumu_bridge_shop_self_view_anchor",
            promotion_policy: "shop_self_view_anchor_plus_fresh_current_view",
          },
        ],
        field_status: {
          status: "candidate",
          promotion_policy: "shop_self_view_anchor_plus_fresh_current_view",
          shop_anchor_fresh: true,
        },
      },
      own_bench: {
        units: [
          { champion_name: "霞", cost: 4, star: 1 },
          { champion_name: "洛", cost: 4, star: 1 },
        ],
      },
      shop: {
        units: [
          { champion_name: "崔斯特", cost: 1 },
          { champion_name: "纳尔", cost: 2 },
        ],
      },
      traits: { active_traits: [{ name: "观星", tier: 2 }] },
      items: {
        item_bench: [
          { item_id: "1037", name: "反曲之弓", source: "mumu_4357_item_bench", slot: 0 },
          { item_id: "1011", name: "巨人腰带", source: "mumu_4357_item_bench", slot: 1 },
        ],
        item_bench_candidates: [
          {
            item_id: "fallback-bow",
            name: "\u53cd\u66f2\u4e4b\u5f13",
            source: "left_item_rail_roi_icon",
            confidence: 0.91,
            evidence_role: "fallback_validation_only",
            observed_at: "2026-07-05T08:00:00.000Z",
          },
        ],
        equipped_items: [
          {
            item_id: "3085",
            name: "鬼索的狂暴之刃",
            source: "mumu_4356_equipment_to_4353_own_unit",
            owner_scope: "own_unit",
            owner_unit: "崔斯特",
            assignment_status: "assigned",
            assigned_unit_id: "tf-verify",
            promotion_policy: "s1_4354_shop_anchor_4356_rect_to_4353_own_unit",
          },
        ],
        visible_equipment_unassigned: [
          { item_id: "3089", name: "珠光护手", source: "mumu_4356_visible_equipment_unassigned" },
        ],
      },
      source: {
        item_source_diagnostics: {
          item_source_classification: { status: "live_verified", reason: "fixture" },
          parse_rejection_counts: { malformed: 3 },
          unknown_command_counts: { "9999": 2 },
          payload_shape_counts_by_command: { "4356": { array: 1 } },
        },
      },
    });

    const matchContextFixture = {
      schema: "jcc-runtime-ui-match-context-v1",
      match_session_id: "verify-selected-context-match",
      updated_at: "2026-07-05T08:00:01.000Z",
      match_variables: {
        encounter: "Silver Scrapes",
        god_options: ["韦鲁斯 爱神", "阿狸 财富之神"],
        stargazing: "泉水",
      },
      target_plan: {
        source: "user_confirmed_runtime_ui",
        confidence: "high",
        text: "我想优先看观星霞，但如果大数据和来牌不支持可以转",
      },
      recent_user_messages: [
        {
          text: "我想优先看观星霞，但如果大数据和来牌不支持可以转",
          mode: "cruise",
          source: "user",
          tags: ["lineup_intent", "tempo_economy_intent"],
          at: "2026-07-05T08:00:02.000Z",
          stage_round: "2-2",
        },
      ],
      observed_choice_options_by_stage: {
        "2-1:augment": {
          kind: "augment",
          choice_stage_round: "2-1",
          choices: [
            { name: "高级贷款", slot: 0 },
            { name: "宇宙大爆炸", slot: 1 },
            { name: "贪财", slot: 2 },
          ],
        },
      },
      choice_confirmations: [
        {
          kind: "augment",
          choice_stage_round: "2-1",
          selected: "贪财",
          source: "user_message_explicit_stage_choice_confirmation",
          at: "2026-07-05T08:00:03.000Z",
        },
      ],
      missing_choice_prompts: [
        {
          kind: "god",
          choice_stage_round: "2-4",
          asked_at: "2026-07-05T08:00:04.000Z",
        },
      ],
    };

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu-7555" } },
      daily_session: { status: "inactive", mode: null },
      match_session: {
        status: "active",
        match_session_id: "verify-selected-context-match",
        started_at: "2026-07-05T08:00:00.000Z",
        season_version_snapshot: activeCoreProfileSnapshot,
      },
      match_context: matchContextFixture,
      match_connection: {
        status: "connected_to_live_match",
        last_live_state_match_session_id: "verify-selected-context-match",
        last_live_state_at: "2026-07-05T08:00:00.000Z",
        initial_cruise_greeting_at: "2026-07-05T08:00:00.000Z",
      },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {}, choice_pretriggers: {} },
      visual_request_status: { status: "idle" },
      self_state_refresh: {
        status: "completed_self_state_roi_ocr",
        last_source: "self_state_roi_ocr",
        last_completed_at: "2026-07-05T08:00:00.000Z",
      },
      host_cli: { provider: "kimi", display_name: "Kimi Code CLI", available: true, selected_model: "kimi-k2.7-code" },
      host_sessions: {
        daily: { status: "idle" },
        match: { status: "idle", match_session_id: "verify-selected-context-match" },
      },
      user_preferences: {
        schema: "jcc-runtime-user-settings-v1",
        default_goal: "balanced",
        rank_tier: "challenger",
        operation_speed: "normal_can_pivot_next_round",
        source: "user_confirmed_menu_setting",
        updated_at: "2026-08-06T06:38:10.000Z",
      },
    });

    const result = await service.handleRuntimeAction("sendMessage", {
      mode: "cruise",
      text: "巡航中：我现在该留哪些牌？",
    }, {});
    assert.equal(result.status, "awaiting_host_cli_agent_response");
    const hostRequest = result.host_request;
    assert(hostRequest, "sendMessage in disabled-host mode must expose host_request");
    const compact = service.summarizeHostRequest(hostRequest);
    const selectedContextTurnDelta = service.compactHostTurnDelta(
      hostRequest,
      service.hostContextCapsuleForRequest(hostRequest, {
        routeKey: "match:selected-context",
        provider: "kimi",
      }),
    );
    const live = compact.live_state_summary;
    const runtimeContext = compact.runtime_context;
    const decision = runtimeContext?.cruise_decision_context;
    const strategyFit = runtimeContext?.strategy_fit_packet;

    assert(runtimeContext?.strategy_evidence_snapshot?.evidence_snapshot_id, "Match strategy request must carry one immutable evidence snapshot");
    assert(runtimeContext?.strategy_evidence_plan?.route_ids?.length, "Match strategy request must carry a multi-route evidence plan");
    assert(runtimeContext?.strategy_evidence_coverage?.receipts?.length, "Match strategy request must carry facet coverage receipts");
    assert(runtimeContext?.strategy_evidence_prefetch?.evidence, "Match strategy request must carry keyed prefetched evidence");
    for (const receipt of runtimeContext.strategy_evidence_coverage.receipts.filter((row) => row.state === "satisfied")) {
      const present = receipt.evidence_keys?.some((key) => Object.hasOwn(runtimeContext.strategy_evidence_prefetch.evidence, key));
      assert(present, `prefetch-only provider must deliver satisfied evidence for ${receipt.facet_id}`);
    }

    assert.equal(live?.phase?.stage_round, "2-5", "host request must include normalized phase.stage_round");
    assert.equal(live?.economy?.hp, 93, "host request must include HUD hp");
    assert.equal(live?.economy?.gold, 18, "host request must include HUD gold");
    assert.equal(live?.economy?.level, 4, "host request must include HUD level");
    assert.equal(live?.economy?.xp, "4/10", "host request must include HUD xp");
    assert.equal(
      selectedContextTurnDelta.runtime_context?.match_facts?.latest_hud_self_state?.economy?.gold,
      null,
      "turn delta must not duplicate HUD economy inside match_facts when live_state_summary owns the current HUD facts",
    );
    for (const diagnosticKey of ["item_source_diagnostics", "parse_rejection_counts", "unknown_command_counts", "payload_shape_counts_by_command"]) {
      const paths = collectKeyPaths(selectedContextTurnDelta, diagnosticKey);
      assert.equal(paths.length, 0, `${diagnosticKey} must stay in bounded Runtime diagnostics and out of ordinary Host turns; found at ${paths.join(", ")}`);
    }
    assert(byName(live?.own_board?.units, "崔斯特"), "host request must include trusted own board units");
    assert(byName(live?.own_bench?.units, "霞"), "host request must include own bench units");
    assert(byName(live?.shop?.units, "纳尔"), "host request must include shop units");
    assert(!live?.current_view?.units_candidate?.length, "host summary must not expose raw current_view unit candidates as facts");
    assert.equal(live?.items?.item_bench?.[0]?.source, "mumu_4357_item_bench", "host request must preserve 4357 item rail source");
    assert.equal(live?.items?.equipped_items?.[0]?.source, "mumu_4356_equipment_to_4353_own_unit", "host request must preserve trusted 4356 equipped assignment");

    assert.equal(runtimeContext?.match_facts?.match_variables?.encounter, "Silver Scrapes", "match variables must enter runtime_context.match_facts");
    assert(runtimeContext?.match_facts?.latest_user_intent?.text, "latest user intent must enter match facts");
    assert.equal(runtimeContext?.match_facts?.choice_confirmations?.[0]?.selected, "贪财", "confirmed choices must enter match facts");
    assert(runtimeContext?.match_facts?.observed_choice_options_by_stage?.["2-1:augment"], "observed OCR candidates must enter match facts as evidence");
    assert(runtimeContext?.game_state_brief?.stage_round === "2-5", "game_state_brief must carry current stage");
    assert(runtimeContext?.active_rules_bundle, "active rules bundle must be selected into host request");
    assert(runtimeContext?.game_rule_contract, "game rule contract must be selected into host request");
    assert(runtimeContext?.coach_rules_brief, "coach rules brief must be selected into host request");
    assert.equal(compact.daily_big_data?.available, false, "S18 cruise context must explicitly report the missing compatible ranking overlay");
    assert.equal(compact.user_preferences?.rank_tier, "master", "legacy challenger preferences must normalize to the real master-plus product tier");
    assert.deepEqual(
      Object.keys(compact.daily_big_data?.tiers || {}),
      [],
      "ranking-unavailable requests must not fall back to prior-season or lower-tier samples",
    );
    assert(
      (compact.selected_ranking_candidates?.candidates || []).length === 0,
      "ranking-unavailable requests must fail closed without selected candidates",
    );
    assert(compact.season_catalog?.champion_count > 0, "cruise host request must include current season catalog");
    assert(compact.strategy_wiki_context, "strategy wiki context envelope must be present for cruise strategy requests");
    assert(decision?.current_board_shop_bench?.board_units?.length >= 1, "cruise decision context must include current board/shop/bench");
    assert(decision?.equipment?.item_bench_from_4357?.length === 2, "cruise decision context must use 4357 item bench");
    assert(decision?.equipment?.trusted_equipped_items_from_4356_assignment?.length === 1, "cruise decision context must use trusted 4356 equipped items");
    assert(decision?.equipment?.item_bench_candidates_fallback_only?.length === 1, "cruise decision context must preserve labelled icon candidates as fallback-only item evidence");
    assert.equal(decision.equipment.item_bench_candidates_fallback_only[0].source, "left_item_rail_roi_icon");
    const capsule = service.hostContextCapsuleForRequest(hostRequest, { routeKey: "match:verify-selected-context-match" });
    assert.deepEqual(
      Object.keys(capsule.static_context?.daily_big_data?.tiers || {}),
      [],
      "the provider-session capsule must not preload an incompatible prior-season ranking tier",
    );
    assert(
      capsule.static_context?.rules?.base_game_rules?.economy_management?.schema === "jcc-economy-management-base-v1",
      "economy doctrine must be loaded once into the provider-native session capsule",
    );
    const commonEntries = (capsule.static_context?.common_host_knowledge?.sections || [])
      .flatMap((section) => section.entries || []);
    assert(
      commonEntries.some((entry) => entry.id === "standard.game_objective" && entry.win_condition),
      "the provider-session capsule must include the Common win condition",
    );
    assert(
      commonEntries.some((entry) => entry.id === "standard.star_upgrade" && entry.copies_per_merge === 3),
      "the provider-session capsule must include the Common three-copy star-up rule",
    );

    const matchState = service.getRuntimeServiceState();
    service.setRuntimeServiceState({
      ...matchState,
      daily_session: { status: "active", mode: "daily_chat", generation: 9 },
      match_session: { status: "idle", match_session_id: null },
      match_connection: { status: "idle" },
      active_mode: "daily_chat",
      host_sessions: {
        ...matchState.host_sessions,
        daily: { status: "idle", route_key: "daily:9" },
      },
    });
    const lobbySeed = {
      schema: "jcc-host-cli-agent-request-v1",
      request_id: "verify-master-plus-first-lobby-turn",
      request_hash: "verify-master-plus-first-lobby-turn",
      mode: "daily_chat",
      task: { type: "daily_chat", answer_owner: "direct_user_message" },
      user_message: "聊一下当前上分思路。",
    };
    const lobbyRuntimeContext = await service.buildRuntimeHostContext("daily_chat", null, lobbySeed);
    assert.equal(
      lobbyRuntimeContext.game_state_brief,
      null,
      "lobby daily chat must not receive a Match-only unknown-stage brief",
    );
    assert.equal(
      lobbyRuntimeContext.match_facts,
      null,
      "lobby daily chat must not receive current-match facts",
    );
    assert.equal(
      lobbyRuntimeContext.live_state_summary,
      undefined,
      "lobby daily chat must not receive live-state facts",
    );
    const lobbyRequest = {
      ...lobbySeed,
      user_preferences: lobbyRuntimeContext.user_preferences,
      daily_big_data: lobbyRuntimeContext.daily_big_data,
      runtime_context: lobbyRuntimeContext,
      context: { runtime_context: lobbyRuntimeContext },
    };
    const compactLobby = service.summarizeHostRequest(lobbyRequest);
    assert.equal(
      compactLobby.user_preferences?.rank_tier,
      "master",
      "the first strategy question in a new lobby must receive the normalized SQLite-owned rank without asking the user again",
    );
    assert.deepEqual(
      Object.keys(compactLobby.daily_big_data?.tiers || {}),
      [],
      "the first lobby strategy answer must preserve ranking-unavailable instead of using an older segment",
    );
    const lobbyCapsule = service.hostContextCapsuleForRequest(lobbyRequest, { routeKey: "daily:9" });
    assert.equal(lobbyCapsule.static_context?.user_preferences?.rank_tier, "master");
    assert.equal(lobbyCapsule.static_context?.daily_big_data?.available, false);
    assert.deepEqual(Object.keys(lobbyCapsule.static_context?.daily_big_data?.tiers || {}), []);
    assert.equal(JSON.stringify(compact).includes('"runtime_season_id":"s17"'), false, "S18 selected context must not expose an S17 ranking identity");

    const turnDelta = service.compactHostTurnDelta(hostRequest, capsule);
    assert.equal(
      turnDelta.runtime_context?.cruise_decision_context?.economy_management_context,
      undefined,
      "ordinary turns must not resend the static economy doctrine",
    );
    assert(decision?.economic_decision_context?.schema === "jcc-economic-decision-context-v1", "computed economy context must be selected into cruise decision context");
    assert(strategyFit?.schema === "jcc-strategy-fit-packet-v1", "strategy_fit_packet must be first-class selected context");
    assert(strategyFit?.latest_user_intent_fit?.target_alignment, "strategy_fit_packet must evaluate user target alignment instead of ignoring intent");
    assert(Array.isArray(strategyFit?.candidate_lines), "strategy_fit_packet must carry candidate line evidence");
    assert(
      !compact.missing_critical_facts.some((entry) => /god|stargazing|psionic|encounter/i.test(String(entry.field || ""))),
      `S18 must not synthesize retired S17 missing facts; got ${JSON.stringify(compact.missing_critical_facts)}`,
    );

    const prompt = service.buildHostTurnDeltaPrompt(hostRequest, capsule);
    assert(prompt.includes("cruise_decision_context"), "host turn delta must carry cruise_decision_context");
    assert(prompt.includes("strategy_fit_packet"), "host turn delta must carry strategy_fit_packet");

    assert(existsSync(runtimePaths.matchContextFile), "match context must be durable on disk for later host calls");
  });

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "cruise host request receives HUD phase/economy fields as normalized JSON",
      "selected context keeps missing HUD values missing and excludes unconfirmed active HP zero",
      "own board, bench, shop, and item facts are selected into live_state_summary",
      "4357 item rail and trusted 4356 equipment assignment remain primary structured evidence",
      "match variables, latest user intent, observed choices, and confirmed choices enter match_facts",
      "active rules, game rule contract, explicit ranking-unavailable status, season catalog, strategy wiki, economy context, and strategy_fit_packet enter host selected context",
      "Common win condition and star-up baseline remain in the provider-session capsule",
      "the first lobby strategy turn inherits SQLite rank preferences and preserves ranking-unavailable scope",
      "missing facts are descriptor-owned and S18 does not synthesize retired S17 choices",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
