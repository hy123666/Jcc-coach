import { readFile } from "node:fs/promises";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const pickWhich = "\u9009\u54ea\u4e2a";
  const ownedAugmentTextPanelLabel = "\u8bfb\u53d6\u5df2\u9009\u5f3a\u5316";
  const ownedAugmentTextPanelPreset =
    "\u6211\u5df2\u70b9\u5f00\u5df2\u62e5\u6709\u5f3a\u5316\u7b26\u6587\uff0c\u8bfb\u53d6\u8fd9\u4e2a\u5f3a\u5316";
  const ownedAugmentTextPanelHint =
    "\u5148\u5728\u6e38\u620f\u91cc\u70b9\u5f00\u53f3\u4fa7\u201c\u5df2\u62e5\u6709\u5f3a\u5316\u7b26\u6587\u201d\u9762\u677f";
  const contract = JSON.parse(await readFile("data/runtime/jcc/runtime-ui-mode-contract.json", "utf8"));
  const commonModes = contract.modes || {};
  const modes = commonModes;

  assert(contract.schema === "jcc-runtime-ui-mode-contract-v1", "schema mismatch");
  assert(contract.match_scoped === true, "mode contract must be match scoped");
  assert(contract.default_chat_prefill === pickWhich, "chat prefill mismatch");
  const cardLifecycle = contract.structured_card_lifecycle_policy || {};
  assert(cardLifecycle.candidate_revision_policy?.includes("current canonical"), "candidate-bearing card actions must require the current canonical report");
  assert(cardLifecycle.final_confirm_rebase_policy?.includes("exact slot plus ref or name"), "final-confirm rebase must require exact candidate identity");
  assert(cardLifecycle.equipment_binding_policy?.includes("stale binding"), "fact-only equipment updates must survive stale surrounding card bindings");
  assert(cardLifecycle.truthful_success_policy?.includes("canonical persistence"), "card success must require canonical persistence");
  assert(cardLifecycle.confirmation_response_policy?.includes("response_task null"), "final confirmation must remain state-only");
  assert(cardLifecycle.observer_dedupe_policy?.includes("cannot emit or retry a sibling"), "explicit card follow-up must suppress semantic observer siblings");

  assert(!modes.opponent_power, "opponent_power mode must not exist in product UI contract");
  assert(!modes.opponent_positioning, "opponent_positioning mode must not exist in product UI contract");
  assert(contract.product_decisions?.opponent_board_modes_removed, "opponent board removal decision must be explicit");
  assert(
    /not provide reliable opponent board unit identity/i.test(contract.product_decisions.opponent_board_modes_removed.reason || ""),
    "opponent removal reason must mention unreliable MuMu opponent board identity",
  );

  assert(!commonModes.god_sequence, "common UI contract must not hardcode the S17 star-god mode");
  assert(modes.manual_match_variables?.placement === "top_panel", "manual variables must be top panel");
  assert(modes.manual_match_variables?.fields?.includes("target_plan"), "common manual variables must retain the season-neutral target plan");
  for (const seasonField of ["encounter", "stargazing", "psionic_weapon_1", "psionic_weapon_2", "current_god_final"]) {
    assert(!modes.manual_match_variables?.fields?.includes(seasonField), `common manual variables must not hardcode active-season field ${seasonField}`);
  }
  assert(/active-season capability/i.test(modes.manual_match_variables?.season_field_policy || ""), "season variable fields must come from active-season capability data");

  assert(modes.augment_choice?.choice_kind === "augment_choice", "augment mode mismatch");
  assert(modes.augment_choice?.data_sources?.includes("current_match_user_report"), "augment mode must use current-match user reports");
  assert(!modes.augment_choice?.data_sources?.includes("active_choice_poll"), "augment mode must not poll visual choice candidates");
  assert(modes.augment_choice?.choice_poll_policy?.candidate_input_policy === "current_match_user_report", "augment candidate intake must be user-reported");
  assert(modes.augment_choice?.choice_poll_policy?.user_report_contract?.no_ocr_or_vision_fallback === true, "augment candidate intake must not fall back to OCR or vision");
  assert(modes.augment_choice?.choice_poll_policy?.stop_on_fields?.includes("augments.choices"), "augment polling must stop after choices are found");
  assert((modes.augment_choice?.renderer?.primary_presets || []).length === 0, "augment mode must use the structured card instead of a composer prefill action");
  assert(modes.augment_choice?.card_report_policy?.report_surface === "structured_search_card", "augment mode must expose a structured search card");
  assert(modes.augment_choice?.card_report_policy?.stage_tabs?.join(",") === "2-1,3-2,4-2", "augment card must expose exact stage tabs");
  assert(modes.augment_choice?.card_report_policy?.equipment_editor?.shared_across_modes_and_stages === true, "augment card must use shared equipment context");
  const ownedAugmentPanel = modes.augment_choice?.manual_owned_augment_text_panel || {};
  assert(ownedAugmentPanel.placement === "augment_choice_mode_secondary_preset", "owned augment text panel must be a secondary preset in augment mode");
  assert(ownedAugmentPanel.label === ownedAugmentTextPanelLabel, "owned augment text panel label mismatch");
  assert(ownedAugmentPanel.prefill === ownedAugmentTextPanelPreset, "owned augment text panel prefill mismatch");
  assert(/immediate_operational_action/.test(ownedAugmentPanel.interaction_policy || ""), "owned augment text panel must remain an explicit immediate operation, not a candidate-report prefill");
  assert(ownedAugmentPanel.user_hint === ownedAugmentTextPanelHint, "owned augment text panel user hint mismatch");
  assert(ownedAugmentPanel.user_hint_delivery === "ui_only_not_sent_to_runtime_or_host", "owned augment text panel hint must be UI-only");
  assert(!ownedAugmentPanel.prefill.includes(ownedAugmentPanel.user_hint), "owned augment text panel prefill must not include UI-only hint");
  assert(ownedAugmentPanel.trigger?.includes("user_clicks_owned_augment_detail_panel"), "owned augment text panel must require the user-opened in-game detail panel");
  assert(ownedAugmentPanel.worker === "resident_rapidocr_text_panel_roi", "owned augment text panel must use the resident OCR worker path");
  assert(ownedAugmentPanel.writes?.includes("match_context.choice_confirmations"), "owned augment text panel must write match-context confirmations");
  assert(
    ownedAugmentPanel.stage_binding_policy?.includes("row1=2-1")
      && ownedAugmentPanel.stage_binding_policy?.includes("row2=3-2")
      && ownedAugmentPanel.stage_binding_policy?.includes("row3=4-2")
      && !ownedAugmentPanel.stage_binding_policy?.includes("row4="),
    "owned augment text panel must use exactly the three standard augment checkpoints",
  );
  assert(ownedAugmentPanel.pollution_policy?.includes("Do not run from cruise"), "owned augment text panel must not run from cruise");
  assert(ownedAugmentPanel.pollution_policy?.includes("Do not use side-rail icon matching"), "owned augment text panel must not use icon matching as selected augment truth");

  assert(modes.item_choice?.choice_kind === "item_choice_panel", "item mode mismatch");
  assert(modes.item_choice?.choice_poll_policy?.candidate_input_policy === "current_match_user_report", "item candidate intake must be user-reported");
  assert(modes.item_choice?.choice_poll_policy?.user_report_contract?.no_ocr_or_vision_fallback === true, "item candidate intake must not fall back to OCR or vision");
  assert(/cruise must not/i.test(modes.item_choice?.choice_poll_policy?.manual_trigger_policy || ""), "item candidate reporting must remain user-triggered");
  assert((modes.item_choice?.renderer?.primary_presets || []).length === 0, "item mode must use the structured card instead of a composer prefill action");
  assert(modes.item_choice?.card_report_policy?.report_surface === "structured_search_card", "item mode must expose a structured search card");
  assert(modes.item_choice?.card_report_policy?.candidate_counts_by_kind?.completed_item_forge === 5, "completed-item forge card must expose five slots");

  for (const field of ["phase.stage_round", "economy.hp", "economy.gold", "economy.level", "economy.xp"]) {
    assert(modes.refresh_self_state?.writes?.includes(field), `refresh self state must include ${field}`);
  }
  assert(modes.daily_chat?.visible_when?.includes("no_active_match"), "daily chat must be outside active match");
  assert(modes.daily_chat?.must_not_write?.includes("current_match.live_state"), "daily chat must not write current match live_state");
  const dailyRankingAction = modes.daily_chat?.renderer?.ranking_recommendation_action;
  assert(dailyRankingAction?.label === "大数据推荐", "daily chat must expose the Master+ ranking recommendation action");
  assert(dailyRankingAction?.request_kind === "ranking_recommendation_query", "daily ranking action must declare its request kind");
  assert(dailyRankingAction?.source_policy === "master_plus_ranking_and_compiled_recipe_evidence", "daily ranking action must use the typed Master+ policy");
  assert(dailyRankingAction?.default_count === 5 && dailyRankingAction?.max_count === 16, "daily ranking action must declare bounded display counts");
  assert(dailyRankingAction?.toggle_behavior === "second_click_returns_to_normal_daily_chat", "daily ranking action must be reversible");
  assert(modes.postgame_review?.visible_when?.includes("match_stopped"), "postgame review must be available after match stop");
  assert(modes.postgame_review?.must_not_write?.includes("current_match.live_state"), "postgame review must not write current match live_state");
  assert(modes.lineup_card?.outputs?.includes("lineup_handoff"), "lineup card must request a minimal Provider handoff");
  assert(modes.lineup_card?.outputs?.includes("runtime_materialized_lineup_card"), "Runtime must still materialize the final lineup card");
  assert(!modes.lineup_card?.outputs?.includes("lineup_display_slots.positioning"), "lineup card must not expose opponent positioning output");
  const lineupPresets = modes.lineup_card?.renderer?.primary_presets || [];
  assert(lineupPresets.length === 1, "lineup mode must expose one focused materialization action");
  assert(lineupPresets[0]?.label === "上限阵容图", "lineup mode must expose only the ceiling-lineup materialization action");

  assert(contract.fallback_classifier_policy?.enabled === false, "active choice candidate fallback classifier must be disabled");
  assert((contract.fallback_classifier_policy?.supported_choice_kinds || []).length === 0, "active choice candidate fallback classifier must support no choice kinds");

  const cruise = contract.cruise_mode_policy || {};
  assert(cruise.mode_id === "cruise", "cruise mode id mismatch");
  assert(cruise.default_active === true, "cruise mode must be default active");
  assert(cruise.strategy_scorer === "tools/score-jcc-cruise-strategy.mjs", "cruise strategy scorer missing");
  assert(cruise.runtime_pipeline === "tools/run-jcc-cruise-runtime-pipeline.mjs", "cruise runtime pipeline missing");
  assert(cruise.not_an_endless_stream === true, "cruise mode must not be endless visible stream");
  assert(!cruise.event_sources?.includes("opponents.snapshots_added_or_updated"), "cruise mode must not consume opponent snapshots");
  const cruisePresets = cruise.renderer?.primary_presets || [];
  for (const label of ["上限阵容", "经济节奏", "阵容方向", "查大数据", "强化适配", "装备/D牌"]) {
    assert(cruisePresets.some((preset) => preset.label === label), `cruise professional preset missing: ${label}`);
  }
  assert(cruisePresets.every((preset) => preset.prompt && preset.description), "cruise professional presets must include prompts and novice-friendly descriptions");
  assert(!JSON.stringify(cruisePresets).includes("S17") && !JSON.stringify(cruisePresets).includes("星神"), "common cruise presets must remain major-season neutral");
  for (const internalInstruction of [
    "不要把排名第一阵容冒充为我的目标阵容",
    "请区分直接统计证据与规则推导",
    "当前用户段位偏好对应的大数据",
    "缺少未确认选择时仍先回答当前问题",
  ]) {
    assert(!JSON.stringify(cruisePresets).includes(internalInstruction), `editable presets must not expose internal Host policy: ${internalInstruction}`);
  }

  const triggers = cruise.proactive_advice_triggers || [];
  for (const required of [
    "direction_commit_or_exit",
    "lineup_convergence_checkpoint",
    "cap_gap_check",
  ]) {
    assert(triggers.some((trigger) => trigger.id === required), `cruise trigger missing: ${required}`);
  }
  assert(triggers.length === 3, "Cruise Host admission must contain only registered fixed strategic triggers");
  for (const forbidden of ["contest_or_deny_units", "scout_request", "contest_density_check"]) {
    assert(!triggers.some((trigger) => trigger.id === forbidden), `removed cruise trigger must not exist: ${forbidden}`);
    assert(!Object.hasOwn(cruise.interrupt_policy?.cooldown_seconds_by_trigger || {}, forbidden), `removed trigger cooldown must not exist: ${forbidden}`);
  }
  assert(!triggers.some((trigger) => trigger.id === "opening_economy_short_advice"), "retired opening economy advice must not remain as a scorer trigger");
  assert(!Object.hasOwn(cruise.interrupt_policy || {}, "opening_economy_delivery_policy"), "retired opening economy Host delivery policy must be absent");
  assert(!JSON.stringify(triggers).includes("opponents.snapshot"), "cruise triggers must not require opponent snapshots");
  assert(cruise.interrupt_policy?.minimum_value_score_to_speak >= 0.7, "cruise interrupt threshold too low");

  assert(contract.streaming_advice_policy?.final_state_requires_confirmation === true, "streaming advice must require confirmation");
  assert(!contract.streaming_advice_policy?.lobby_power_scan, "streaming policy must not expose lobby_power_scan");
  assert(!contract.streaming_advice_policy?.opponent_positioning, "streaming policy must not expose opponent_positioning");

  const outputLoop = JSON.parse(await readFile(cruise.agent_output_loop, "utf8"));
  assert(outputLoop.schema === "jcc-cruise-agent-output-loop-contract-v1", "output loop schema mismatch");
  assert(outputLoop.cruise_mode_policy?.listen_continuously === true, "output loop must listen continuously");
  assert(outputLoop.cruise_mode_policy?.speak_continuously === false, "output loop must not speak continuously");
  assert(outputLoop.ai_native_output_policy?.host_model_contract?.backend_fallback_text_is_not_final === true, "backend fallback must not be final user text");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "opponent_power/opponent_positioning removed from product UI contract",
      "cruise does not consume opponent snapshots or scout triggers",
      "choice/self/daily/postgame/lineup modes remain available",
      "structured-card revision, final-confirm identity, equipment binding, and answer ownership are fail-closed",
      "streaming policy no longer exposes lobby or opponent positioning outputs",
    ],
    modes: Object.keys(modes),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
