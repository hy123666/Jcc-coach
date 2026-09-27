import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createActiveCoreProfileSnapshot } from "./jcc_test_core_profile_fixture.mjs";

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fileUrl(file, tag) {
  return `${pathToFileURL(path.resolve(root, file)).href}?${tag}`;
}

function championByName(catalog, name) {
  return Object.values(catalog?.champions_by_cost || {}).flat().find((entry) => entry.name === name) || null;
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-electron-host-request-smoke-"));
  const previousDisable = process.env.JCC_UI_DISABLE_CODEX_EXEC;
  const previousDataDir = process.env.JCC_RUNTIME_DATA_DIR;
  let service = null;
  process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
  process.env.JCC_RUNTIME_DATA_DIR = tempRoot;
  try {
    const tag = `electron-host-request-smoke=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const rulesModule = await import(fileUrl("tools/jcc_active_rules_contract.mjs", tag));
    const {
      buildHostSessionBootstrapPrompt,
      buildHostTurnDeltaPrompt,
      captureMatchWikiSnapshot,
      compactHostTurnDelta,
      configureRuntimeServicePaths,
      getRuntimeServiceState,
      handleRuntimeAction,
      hostContextCapsuleForRequest,
      setRuntimeServiceState,
      summarizeHostRequest,
    } = service;
    const runtimePaths = storeModule.createRuntimePaths(root);
    const activeRulesBundle = rulesModule.loadActiveRulesBundle({ repoRoot: root, runtimePaths });
    const activeCoreProfileSnapshot = createActiveCoreProfileSnapshot(root, { runtimePaths });
    assert(
      path.resolve(runtimePaths.runtimeDataRoot) === path.resolve(tempRoot),
      "electron host request smoke must use an isolated temp runtime data dir",
    );
    assert(activeCoreProfileSnapshot.promotion_tuple?.season_id === "s18", "smoke must run against the active S18 Core Profile");
    assert(activeRulesBundle.season_special_rules?.mechanics?.choice_mechanics?.length === 0, "S18 must not compile an S17 season-only choice mode");
    assert(!activeRulesBundle.season_special_rules?.mechanics?.manual_variable_fields?.length, "S18 must not compile S17 manual variables");
    for (const mode of [
      "daily_chat",
      "postgame_review",
      "user_preferences",
      "strategy_wiki",
      "cruise",
      "augment_choice",
      "item_choice",
      "lineup_card",
      "refresh_self_state",
      "manual_match_variables",
    ]) {
      const promptRequest = {
        schema: "jcc-host-prompt-mode-smoke-v1",
        mode,
        user_message: "verify canonical mode prompt",
        runtime_context: {
          season_host_mode_addons: activeRulesBundle.season_special_rules?.host_mode_addons || {},
          season_host_mode_aliases: activeRulesBundle.season_special_rules?.host_mode_aliases || {},
        },
      };
      const promptCapsule = hostContextCapsuleForRequest(promptRequest, {
        routeKey: `smoke:${mode}`,
        provider: "codex",
      });
      const prompt = buildHostSessionBootstrapPrompt(promptRequest, promptCapsule);
      assert(prompt.includes("Current Turn Context: Read INPUT_JSON.runtime_context.current_turn_contract first"), `${mode} prompt must retain canonical current-turn authority instructions`);
      assert(prompt.includes("Authority Order:"), `${mode} prompt must retain canonical authority ordering`);
      assert(!prompt.includes("Active Mode -"), `${mode} bootstrap must not pin a later-turn mode add-on`);
      const turnPrompt = buildHostTurnDeltaPrompt(promptRequest, promptCapsule);
      assert(turnPrompt.includes("Active Mode -"), `${mode} turn delta must include its mode add-on through the canonical builder`);
      assert(!prompt.includes("S17 Star-God Choice Sequence"), `${mode} prompt must not inherit an S17 season-only mode add-on`);
    }
    assert(
      path.resolve(runtimePaths.currentWatchDir).startsWith(path.resolve(tempRoot)),
      "electron host request smoke must not write current-watch files into product runtime data",
    );
    const { currentWatchDir } = runtimePaths;
    let output = null;
    const stateResult = await handleRuntimeAction("getState", {}, { close() {}, minimize() {} });
    const previousState = globalThis.structuredClone
      ? structuredClone(stateResult.state)
      : JSON.parse(JSON.stringify(stateResult.state));
    const prompts = [
      "围绕奥恩、洛和霞，能给我一套当前赛季阵容吗？",
      "\u7ed9\u6211\u9635\u5bb9\u6210\u5458\u5c31\u884c\u3002",
      "\u7ed9\u6211\u9635\u5bb9\u6210\u5458\u5c31\u884c\u5176\u4ed6\u6210\u5458\u5462\uff1f\u5177\u4f53\u540d\u79f0\u7ed9\u6211\u3002",
    ];
    let request = null;
    for (const text of prompts) {
      const result = await handleRuntimeAction("sendMessage", { text, mode: "chat" }, { close() {}, minimize() {} });
      assert(result.ok === true, `sendMessage should build a host request without calling Codex: ${text}`);
      assert(result.status === "awaiting_host_cli_agent_response", `disabled Codex path should expose host request: ${text}`);
      request = result.host_request;
      assert(request?.mode === "daily_chat", "daily chat should remain daily_chat");
      assert(request.runtime_context?.context_policy?.include_user_preferences === true, `lineup prompt should include user preferences: ${text}`);
      assert(request.runtime_context?.context_policy?.include_daily_big_data === true, `lineup prompt should include daily big data: ${text}`);
      assert(request.runtime_context?.context_policy?.include_season_catalog === true, `lineup prompt should include season catalog: ${text}`);
    }
    assert(request, "smoke should produce at least one host request");
    assert(request.user_preferences?.rank_tier, "host request should carry rank tier");
    const nativeTools = request.runtime_context?.strategy_evidence_plan?.provider_capability === "native_dynamic_tools";
    if (nativeTools) {
      assert(!request.daily_big_data, "native-tools host request must query Active Ranking instead of attaching it");
      assert(!request.season_catalog, "native-tools host request must query Core entities instead of attaching the catalog");
    } else {
      assert(request.daily_big_data?.available === true, "host request should explicitly carry current Active Ranking availability");
      assert(request.daily_big_data?.ranking_overlay_id === runtimePaths.activeRankingGenerationId, "host request must expose the current compatible Ranking overlay");
      assert(Object.keys(request.daily_big_data?.tiers || {}).length > 0, "host request must expose current-season ranking tiers");
      assert(request.daily_big_data?.ranking_scope?.fallback_to_other_tiers === false, "host request must fail closed instead of falling back to another ranking tier");
      assert(request.season_catalog?.champion_count > 40, "host request should carry current-season champion pool");
    }
    const compactRequest = summarizeHostRequest(request);
    const compactText = JSON.stringify(compactRequest.daily_big_data || {});
    assert(!compactText.includes("raw_key"), "compact host request must not expose raw ranking keys");
    assert(!/83\d{6,}_\d/.test(compactText), "compact host request must not expose backend trait-key ids");
    assert(!compactText.includes("\u672a\u77e5\u7f81\u7eca"), "compact host request must not expose unresolved trait placeholders");

    if (!nativeTools) {
      for (const name of ["奥恩", "洛", "霞"]) {
        const entry = championByName(request.season_catalog, name);
        assert(entry, `current-season catalog should include ${name}`);
        assert(entry.cost === 1, `${name} should be an S18 1-cost champion`);
      }
      assert(championByName(request.season_catalog, "慎")?.cost === 2, "慎 should use its active S18 cost");
      for (const oldName of ["潘森", "古拉加斯", "派克"]) {
        assert(!championByName(request.season_catalog, oldName), `${oldName} should not be available in current season catalog`);
      }
    } else {
      assert(request.runtime_context?.knowledge_snapshot?.core_profile_id, "native-tools request should pin a Core snapshot");
      assert(request.runtime_context?.strategy_evidence_plan?.provider_capability === "native_dynamic_tools", "native-tools request should preserve provider capability");
    }

    const wikiResult = await handleRuntimeAction("buildWikiCurationRequest", {
      trigger: "manual_one_click",
      limit: 20,
    }, { close() {}, minimize() {} });
    assert(wikiResult.ok === true, "one-click wiki curation should build a host request without live model");
    assert(wikiResult.status === "awaiting_host_cli_agent_response", "disabled host model path should return awaiting status for wiki curation");
    assert(wikiResult.wiki_curation_request?.schema === "jcc-wiki-curation-host-request-v1", "wiki curation should return the wiki host request schema");
    assert(wikiResult.wiki_curation_request?.target_wiki_namespaces?.[0]?.categories?.length === 3, "wiki curation request should include the three strategy wiki categories");
    assert(wikiResult.result?.source_event_ids?.length >= 3, "wiki curation should record immutable source events");

    setRuntimeServiceState({
      ...previousState,
      match_session: {
        status: "active",
        match_session_id: "verify-match-session",
        season_version_snapshot: activeCoreProfileSnapshot,
      },
      active_mode: "cruise",
    });
    await mkdir(currentWatchDir, { recursive: true });
    await writeFile(path.join(currentWatchDir, "cruise-live-state.json"), `${JSON.stringify({
      schema: "jcc-cruise-live-state-verify-v1",
      match_session_id: "verify-match-session",
      phase: { status: "planning", stage_round: "2-1" },
      shop: { units: [] },
      own_board: { units: [] },
    }, null, 2)}\n`, "utf8");
    const wikiStore = storeModule.createRuntimeSqliteStore(root, { dataRoot: tempRoot }).open();
    try {
      wikiStore.upsertWikiPage({
        page_id: "verify-published-economy-wiki",
        namespace: "personal_strategy",
        category: "universal_gameplay_strategy",
        scope: "cross_season",
        season_id: null,
        patch_id: null,
        title: "Verify economy tempo prior",
        status: "published",
        summary: "When tempo pressure is low, preserve the next interest threshold before buying marginal units.",
        body_md: "Use this only as a soft prior. Current HP, stage, streak, board strength, and choice results override the wiki page.",
        tags: ["economy", "tempo"],
        source_event_ids: ["verify-source-event"],
        confidence: "medium",
      });
    } finally {
      wikiStore.close();
    }
    configureRuntimeServicePaths({ dataRoot: tempRoot });
    setRuntimeServiceState({
      ...getRuntimeServiceState(),
      match_session: {
        ...getRuntimeServiceState().match_session,
        season_version_snapshot: {
          ...getRuntimeServiceState().match_session.season_version_snapshot,
          wiki_snapshot: captureMatchWikiSnapshot(),
        },
      },
    });
    const variablesResult = await handleRuntimeAction("saveManualVariables", {
      seasonVariables: {},
      target: "verify_s18_current_comp",
    }, { close() {}, minimize() {} });
    assert(variablesResult.ok === true, "saveManualVariables should write match context");
    assert(variablesResult.match_context_file, "saveManualVariables should expose match_context_file");
    const matchResult = await handleRuntimeAction("sendMessage", {
      text: "这把当前阵容成员怎么补？",
      mode: "cruise",
    }, { close() {}, minimize() {} });
    assert(matchResult.ok === true, "active match sendMessage should build host request without Codex");
    assert(matchResult.host_request?.runtime_context?.host_session_kind === "match", "active match host request should use match session");
    assert(matchResult.host_request?.runtime_context?.coach_rules_brief?.schema === "jcc-runtime-coach-rules-brief-v2", "active match host request should include the canonical coach-facing rules brief");
    assert(matchResult.host_request?.runtime_context?.coach_signature_contract?.schema === "jcc-host-coach-signature-contract-v1", "active match host request should include coach signature/metric contract");
    assert(
      matchResult.host_request.runtime_context.coach_signature_contract.signatures?.cruise_advice?.required_semantics?.some((line) => line.includes("Do not say to wait")),
      "coach signature contract should teach cruise advice not to wait for current/past choice checkpoints",
    );
    assert(
      matchResult.host_request.runtime_context.coach_rules_brief.timing?.choice_mechanics
        ?.find((entry) => entry.mechanic_id === "augment_choice")?.stages?.includes("2-1"),
      "coach rules brief should teach 2-1 augment timing through the season descriptor",
    );
    assert(
      !matchResult.host_request.runtime_context.coach_rules_brief.timing?.choice_mechanics
        ?.some((entry) => entry.mechanic_id === "star_god_choice" || entry.mode === "god_sequence"),
      "coach rules brief must not carry an S17 season-only choice mechanic",
    );
    assert(matchResult.host_request?.runtime_context?.game_rule_contract?.stage_round === "2-1", "active match host request should include current-stage game rule contract");
    assert(matchResult.host_request?.runtime_context?.game_state_brief?.stage_round === "2-1", "active match host request should include current-stage game state brief");
    const currentTurnContract = matchResult.host_request?.runtime_context?.current_turn_contract;
    assert(currentTurnContract?.schema === "jcc-runtime-current-turn-contract-v1", "active match host request should bind the response to a current-turn contract");
    assert(currentTurnContract?.match_session_id === "verify-match-session", "current-turn contract should bind the active match session");
    assert(currentTurnContract?.active_mode === "cruise", "current-turn contract should bind the active mode");
    assert(currentTurnContract?.stage_round === "2-1", "current-turn contract should bind the current stage");
    assert(Boolean(currentTurnContract?.rules_source_fingerprint), "current-turn contract should bind the exact active-rules source fingerprint");
    assert(currentTurnContract?.version_identity?.runtime_season_id === activeCoreProfileSnapshot.promotion_tuple.season_id, "current-turn contract should carry the active Core Profile major-season identity");
    assert(currentTurnContract?.version_identity?.runtime_patch_id === activeCoreProfileSnapshot.promotion_tuple.active_patch_id, "current-turn contract should carry the active Core Profile minor-patch identity");
    assert(currentTurnContract?.source_policy?.caller_supplied_derived_contract_reuse === false, "current-turn contracts must be rebuilt rather than reused from caller input");
    assert(matchResult.host_request.runtime_context.game_state_brief.current_choice_checkpoint?.kind === "augment", "2-1 brief should mark augment as the current choice checkpoint");
    assert(matchResult.host_request.runtime_context.game_rule_contract.current_choice_checkpoint?.kind === "augment", "2-1 contract should mark augment as the current choice checkpoint");
    assert(
      matchResult.host_request.runtime_context.game_rule_contract.must_not?.some((line) => line.includes("2-1") && line.includes("augment")),
      "2-1 contract must forbid telling the user to wait for the current augment checkpoint",
    );
    assert(matchResult.host_request?.runtime_context?.context_policy?.include_user_preferences === true, "active match should include user preferences");
    assert(matchResult.host_request?.runtime_context?.context_policy?.include_daily_big_data === true, "active match should include daily big data");
    assert(matchResult.host_request?.runtime_context?.context_policy?.include_season_catalog === true, "active match should include season catalog");
    assert(matchResult.host_request?.runtime_context?.context_policy?.include_strategy_wiki === true, "active match should include published strategy wiki context");
    const matchCapsule = hostContextCapsuleForRequest(matchResult.host_request, { routeKey: "match:verify-match-session" });
    assert(
      matchCapsule.static_context?.hard_data?.promotion_tuple?.core_profile_id === activeCoreProfileSnapshot.core_profile_id,
      "match capsule must bind the active S18 Core Profile",
    );
    assert(matchCapsule.static_context?.daily_big_data?.available === true, "match capsule must retain the captured compatible Ranking overlay");
    assert(matchCapsule.static_context?.daily_big_data?.ranking_overlay_id === runtimePaths.activeRankingGenerationId, "match capsule must bind the immutable Ranking generation captured by Start Match");
    assert(
      matchCapsule.static_context?.strategy_wiki_context?.pages?.some((page) => page.title === "Verify economy tempo prior"),
      "active match provider session capsule should carry published strategy wiki pages once",
    );
    assert(!matchResult.host_request?.context?.live_state_summary?.match_variables?.encounter, "S18 live facts must not contain the retired S17 encounter variable");
    assert(!matchResult.host_request?.context?.live_state_summary?.match_variables?.god_options, "S18 live facts must not contain retired S17 god options");
    assert(matchResult.host_request?.context?.live_state_summary?.effective_target_context?.authority === "provisional_user_intent", "season-neutral open target preference should remain provisional in the effective live-state target context");
    assert(matchResult.host_request?.context?.live_state_summary?.effective_target_context?.text === "verify_s18_current_comp", "season-neutral open target preference should enter the active match host request without becoming a durable target");
    assert(matchResult.host_request?.context?.live_state_summary?.target_plan == null, "live-state target_plan must remain reserved for a durable target");
    assert(matchResult.host_request?.runtime_context?.match_facts?.latest_target_intent?.text === "verify_s18_current_comp", "manual target preference should be stored in latest_target_intent");
    assert(matchResult.host_request?.runtime_context?.match_facts?.target_plan == null, "manual target preference must not overwrite or create a durable target_plan");
    assert(matchResult.host_request?.task?.trigger_id === "user_message_response", "manual user message should select the user_message_response host task instead of a background cruise task");
    const compactMatchRequest = summarizeHostRequest(matchResult.host_request);
    assert(compactMatchRequest.runtime_context?.coach_rules_brief?.schema === "jcc-runtime-coach-rules-brief-v2", "compact match host request should retain coach_rules_brief");
    assert(compactMatchRequest.runtime_context?.coach_signature_contract == null, "compact match host request must not duplicate the signature contract already compiled into canonical host instructions");
    assert(compactMatchRequest.runtime_context?.game_rule_brief_text?.includes("GAME_RULE_BRIEF:"), "compact match host request should retain the front-loaded game_rule_brief_text");
    const matchDelta = compactHostTurnDelta(matchResult.host_request, matchCapsule);
    assert(matchDelta.strategy_wiki_context === undefined, "ordinary match turns must not resend static strategy Wiki pages");
    assert(matchDelta.live_state_summary?.phase?.stage_round === "2-1", "ordinary match turns must retain current live facts in the dynamic delta");
    assert(matchDelta.runtime_context?.match_facts, "ordinary match turns must retain canonical match facts in the dynamic delta");
    assert(compactMatchRequest.runtime_context.game_rule_brief_text.includes("current_stage: 2-1"), "2-1 compact host request should front-load the current stage");
    assert(compactMatchRequest.runtime_context.game_rule_brief_text.includes("situation: Currently at 2-1 augment choice"), "2-1 compact host request should identify the standard augment checkpoint");
    assert(compactMatchRequest.runtime_context.game_rule_brief_text.includes("unknown_final_selected_choices: augment 2-1"), "2-1 compact host request should disclose the missing final augment choice without inventing candidates");
    assert(compactMatchRequest.runtime_context.game_rule_brief_text.includes("context_priority:"), "2-1 compact host request should front-load evidence priority");
    assert(compactMatchRequest.runtime_context.game_rule_brief_text.includes("never_wait_for_now_or_past: augment 2-1"), "2-1 compact host request should front-load the forbidden wait checkpoint");
    assert(compactMatchRequest.runtime_context.game_rule_brief_text.includes("current_stage_rule_semantics:"), "compact match host request should front-load plain-language stage semantics");
    assert(
      compactMatchRequest.runtime_context.game_state_brief.current_stage_rule_semantics?.some((line) => line.includes("2-1") && line.includes("choice checkpoint")),
      "compact match host request should explain the current 2-1 choice checkpoint semantically",
    );
    assert(compactMatchRequest.runtime_context?.game_rule_contract?.stage_round === "2-1", "compact match host request should retain game_rule_contract");
    assert(compactMatchRequest.runtime_context?.game_state_brief?.stage_round === "2-1", "compact match host request should retain game_state_brief");
    assert(compactMatchRequest.runtime_context?.current_turn_contract?.stage_round === "2-1", "compact match host request should retain current_turn_contract");
    assert(
      compactMatchRequest.runtime_context.current_turn_contract.rules_source_fingerprint === currentTurnContract.rules_source_fingerprint,
      "compact match host request should retain the exact current-turn rules fingerprint",
    );
    assert(
      !Object.prototype.hasOwnProperty.call(compactMatchRequest.context_pack || {}, "mode_context"),
      "compact host request must not inject full context_pack.mode_context every turn",
    );
    assert(
      Object.prototype.hasOwnProperty.call(compactMatchRequest.context_pack || {}, "mode_context_summary"),
      "compact host request should retain only the small mode_context_summary",
    );

    await writeFile(path.join(currentWatchDir, "cruise-live-state.json"), `${JSON.stringify({
      schema: "jcc-cruise-live-state-verify-v1",
      match_session_id: "verify-match-session",
      phase: { status: "planning", stage_round: "2-2" },
      shop: { units: [] },
      own_board: { units: [] },
    }, null, 2)}\n`, "utf8");
    const postAugmentResult = await handleRuntimeAction("sendMessage", {
      text: "\u73b0\u5728\u600e\u4e48\u8fc7\u6e21\uff1f",
      mode: "cruise",
    }, { close() {}, minimize() {} });
    setRuntimeServiceState(previousState);
    assert(postAugmentResult.ok === true, "post-augment active match sendMessage should build a host request");
    const postAugmentContract = postAugmentResult.host_request?.runtime_context?.game_rule_contract;
    const postAugmentBrief = postAugmentResult.host_request?.runtime_context?.game_state_brief;
    assert(postAugmentContract?.stage_round === "2-2", "post-augment contract should use the host request live_state stage");
    assert(postAugmentBrief?.stage_round === "2-2", "post-augment brief should use the host request live_state stage");
    assert(
      postAugmentBrief.unknown_final_choices?.some((entry) => entry.kind === "augment" && entry.stage_round === "2-1"),
      "2-2 brief should tell the model that the 2-1 augment final selection is unknown",
    );
    assert(
      postAugmentBrief.forbidden_waiting_for?.some((entry) => entry.kind === "augment" && entry.stage_round === "2-1"),
      "2-2 brief should forbid waiting for the past 2-1 augment",
    );
    assert(
      postAugmentContract.past_choice_checkpoints?.some((entry) => entry.kind === "augment" && entry.stage_round === "2-1"),
      "2-2 contract should mark 2-1 augment as a past choice checkpoint",
    );
    assert(
      postAugmentContract.unknown_final_choices?.some((entry) => entry.kind === "augment" && entry.stage_round === "2-1"),
      "2-2 contract should mark 2-1 augment final selection as unknown until confirmed",
    );
    assert(
      postAugmentContract.must_not?.some((line) => line.includes("2-1") && line.includes("already past")),
      "2-2 contract must explicitly forbid waiting for 2-1 augment",
    );
    const compactPostAugmentRequest = summarizeHostRequest(postAugmentResult.host_request);
    assert(compactPostAugmentRequest.runtime_context?.game_rule_brief_text?.includes("current_stage: 2-2"), "2-2 compact host request should front-load the current stage");
    assert(compactPostAugmentRequest.runtime_context.game_rule_brief_text.includes("unknown_final_selected_choices: augment 2-1"), "2-2 compact host request should front-load missing 2-1 final selection");
    assert(compactPostAugmentRequest.runtime_context.game_rule_brief_text.includes("never_wait_for_now_or_past: augment 2-1"), "2-2 compact host request should front-load that 2-1 is already past");
    assert(
      compactPostAugmentRequest.runtime_context.game_state_brief.current_stage_rule_semantics?.some((line) => line.includes("2-1") && line.includes("already past")),
      "2-2 compact host request should explain that 2-1 is already past before model generation",
    );
    const compactChoiceRequest = summarizeHostRequest({
      mode: "augment_choice",
      user_message: "\u9009\u54ea\u4e2a\uff1f\u8981\u4e0d\u8981\u5237\u65b0\uff1f",
      context: {},
      runtime_context: {
        schema: "jcc-runtime-host-request-context-v1",
        game_rule_brief_text: [
          "GAME_RULE_BRIEF:",
          "- current_stage: 2-1",
          "- never_wait_for_now_or_past: augment 2-1",
          "- unknown_final_selected_choices: augment 2-1 observed=\u9ad8\u7ea7\u8d37\u6b3e/\u6cea\u6d41\u6210\u6cb3/\u7269\u5c3d\u5176\u7528",
        ].join("\n"),
        game_state_brief: {
          schema: "jcc-runtime-game-state-brief-v1",
          stage_round: "2-1",
          unknown_final_choices: [{
            kind: "augment",
            stage_round: "2-1",
            observed_options: ["\u9ad8\u7ea7\u8d37\u6b3e", "\u6cea\u6d41\u6210\u6cb3", "\u7269\u5c3d\u5176\u7528"],
          }],
          forbidden_waiting_for: [{ kind: "augment", stage_round: "2-1" }],
        },
      },
    });
    assert(
      compactChoiceRequest.choices == null,
      "unconfirmed OCR summary evidence must not be promoted into authoritative structured choice candidates",
    );
    assert(
      compactChoiceRequest.runtime_context.game_rule_brief_text.includes("observed=\u9ad8\u7ea7\u8d37\u6b3e/\u6cea\u6d41\u6210\u6cb3/\u7269\u5c3d\u5176\u7528"),
      "compact host request should also front-load observed choice names in the rule brief",
    );
    const conflictingDraftCompact = summarizeHostRequest({
      mode: "cruise",
      task: {
        task_id: "verify-conflicting-draft",
        trigger_id: "early_direction_conversation",
        short_advice: "\u5148\u522b\u5b9a\u6b7b\u9635\u5bb9\uff0c\u7b49 2-1 \u6d77\u514b\u65af\u518d\u51b3\u5b9a\u8fde\u80dc\u8fd8\u662f\u4fdd\u7ecf\u6d4e\u3002",
        reason_summary: "\u9700\u8981\u7b49 2-1 \u5f3a\u5316\u51fa\u6765\u540e\u518d\u770b\u3002",
      },
      runtime_context: {
        schema: "jcc-runtime-host-request-context-v1",
        game_rule_contract: postAugmentContract,
        game_state_brief: postAugmentBrief,
      },
    });
    assert(
      conflictingDraftCompact.task?.rule_conflict_warnings?.some((entry) => entry.stage_round === "2-1" && entry.kind === "augment"),
      "compact host request must mark backend draft text that tells the model to wait for a past 2-1 augment",
    );
    assert(
      conflictingDraftCompact.task?.short_advice === undefined
        && conflictingDraftCompact.task?.reason_summary === undefined,
      "compact host request must remove conflicting backend draft wording instead of asking the model to ignore it",
    );
    assert(
      conflictingDraftCompact.task?.draft_policy?.includes("removed before host generation"),
      "compact host request must explain that conflicting backend draft wording was removed before host generation",
    );

    output = {
      ok: true,
      schema: "jcc-electron-host-request-smoke-v1",
      provider_evidence_mode: nativeTools ? "native_dynamic_tools" : "prefetch_complete",
      policy: request.runtime_context.context_policy,
      user_preferences: request.user_preferences,
      daily_big_data: {
        available: request.daily_big_data?.available ?? matchCapsule.static_context?.daily_big_data?.available ?? null,
        stat_date: request.daily_big_data?.stat_date ?? matchCapsule.static_context?.daily_big_data?.stat_date ?? null,
        ranking_scope: request.daily_big_data?.ranking_scope ?? matchCapsule.static_context?.daily_big_data?.ranking_scope ?? null,
      },
      compact_daily_big_data_sample: compactRequest.daily_big_data?.tiers?.["0"]?.top_traits?.slice(0, 2) || [],
      season_catalog: {
        champion_count: request.season_catalog?.champion_count ?? matchCapsule.static_context?.season_catalog?.champion_count ?? null,
        core: request.season_catalog
          ? ["奥恩", "洛", "霞"].map((name) => championByName(request.season_catalog, name))
          : [],
      },
      wiki_curation_smoke: {
        status: wikiResult.status,
        source_event_ids: wikiResult.result.source_event_ids,
        categories: wikiResult.wiki_curation_request.target_wiki_namespaces[0].categories,
      },
      active_match_smoke: {
        host_session_kind: matchResult.host_request.runtime_context.host_session_kind,
        policy: matchResult.host_request.runtime_context.context_policy,
        game_rule_contract: compactMatchRequest.runtime_context.game_rule_contract,
        game_state_brief: compactMatchRequest.runtime_context.game_state_brief,
        signature_compiled_in_host_instructions: compactMatchRequest.runtime_context.coach_signature_contract == null,
        post_augment_contract: postAugmentContract,
        post_augment_brief: postAugmentBrief,
        conflicting_draft_warning: conflictingDraftCompact.task.rule_conflict_warnings,
        match_variables: matchResult.host_request.context.live_state_summary.match_variables,
        target_context: matchResult.host_request.context.live_state_summary.target_plan,
      },
      runtime_data_dir: tempRoot,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await service?.handleRuntimeAction("shutdown", { reason: "verify_electron_host_request_smoke_cleanup" }, null).catch(() => {});
    if (previousDisable === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
    else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisable;
    if (previousDataDir === undefined) delete process.env.JCC_RUNTIME_DATA_DIR;
    else process.env.JCC_RUNTIME_DATA_DIR = previousDataDir;
    await rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 6,
      retryDelay: 75,
    });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
