import { readFile } from "node:fs/promises";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const itemPrompt = "\u8bf7\u62a5\u5019\u9009\u88c5\u5907/\u953b\u9020\u5668\uff0c\u5e76\u8865\u5f53\u524d\u88c5\u5907\u3001\u6563\u4ef6\u548c\u6301\u6709\u4eba\u3002";
const itemHint = "\u8bf7\u628a\u5019\u9009\u88c5\u5907/\u953b\u9020\u5668\u3001\u5f53\u524d\u88c5\u5907\u3001\u6563\u4ef6\u548c\u6301\u6709\u4eba\u4e00\u8d77\u62a5\u51fa\u6765\u3002";
const lineupPrompt = "\u628a\u5f53\u524d\u8ba8\u8bba\u7684\u76ee\u6807\u9635\u5bb9\u6574\u7406\u5230\u9635\u5bb9\u56fe\uff0c\u5e76\u5199\u6e05\u6838\u5fc3\u88c5\u5907\u3001\u7ad9\u4f4d\u3001\u8fc7\u6e21\u548c\u5173\u952e\u8282\u70b9\u3002";
const refreshPrompt = "\u5237\u65b0\u540e\u662f\uff1a";

async function main() {
  const app = await readFile("ui/src/App.tsx", "utf8");
  const bridge = await readFile("ui/src/runtimeBridge.ts", "utf8");
  const contract = JSON.parse(await readFile("data/runtime/jcc/runtime-ui-mode-contract.json", "utf8"));
  const hardDataAction = contract.cruise_mode_policy?.renderer?.hard_data_action;
  const dailyCoreTheoryAction = contract.modes?.daily_chat?.renderer?.core_theory_action;
  const dailyRankingAction = contract.modes?.daily_chat?.renderer?.ranking_recommendation_action;
  const popularRecipeAction = contract.cruise_mode_policy?.renderer?.popular_recipe_action;
  const factCaptureAction = contract.cruise_mode_policy?.renderer?.fact_capture_action;

  for (const [name, value] of [
    ["item prompt", itemPrompt],
    ["item hint", itemHint],
    ["lineup prompt", lineupPrompt],
    ["refresh prompt", refreshPrompt],
  ]) {
    assert(app.includes(value), `${name} missing from App composer source`);
  }

  assert(bridge.includes("candidateInputPolicy") && bridge.includes("userReportPrompt") && bridge.includes("refreshReportPrefix"), "runtime bridge must project generic user-report mode metadata");
  for (const [mode, definition] of Object.entries(contract.modes || {})) {
    if (definition?.choice_poll_policy?.candidate_input_policy !== "current_match_user_report") continue;
    assert(definition.choice_poll_policy.user_report_contract?.report_prompt, `${mode} must declare a report prompt`);
    assert(definition.choice_poll_policy.user_report_contract?.refresh_report_prefix, `${mode} must declare a refresh prefix`);
  }
  assert(app.includes('mode?.candidateInputPolicy === "current_match_user_report"'), "composer must detect user-report modes generically");
  assert(app.includes("const reportPrompt = mode.userReportPrompt?.trim()"), "composer must source report copy from the active mode descriptor");
  assert(!app.includes('activeMode === "god"'), "common composer must not hardcode a season-specific choice branch");
  assert(app.includes("const textareaRef = useRef<HTMLTextAreaElement | null>(null);"), "composer must hold a textarea ref for focus");
  assert(app.includes("textareaRef.current?.focus();"), "prefill controls must focus the composer");
  assert(app.includes("textareaRef.current?.setSelectionRange(next.length, next.length);"), "prefill controls must move the caret to the end");
  assert(app.includes("setDraft(next);"), "prefill controls must update the draft");
  assert(app.includes('prefillPreset(mode?.primaryPresets[0]?.prompt || currentPrompt)'), "user-report candidate chip must prefill the active descriptor template without auto-send");
  assert(app.includes('onClick={() => prefillPreset(preset.prompt)}'), "all ordinary mode presets must prefill the editable composer");
  assert(app.includes('onClick={() => prefillPreset(mode?.prompt || currentPrompt)}'), "fallback mode presets must prefill the editable composer");
  assert(!app.includes('preset.interaction === "prefill_only"'), "ordinary prompt presets must not retain an auto-send branch");
  for (const [modeId, definition] of Object.entries(contract.modes || {})) {
    for (const preset of definition?.renderer?.primary_presets || []) {
      assert(preset?.interaction === "prefill_only", `${modeId} preset ${preset?.label || "unknown"} must be editable before send`);
    }
  }
  for (const preset of contract.cruise_mode_policy?.renderer?.primary_presets || []) {
    assert(preset?.interaction === "prefill_only", `cruise preset ${preset?.label || "unknown"} must be editable before send`);
  }
  assert(app.includes("prefillPreset(refreshReportPrompt);"), "refresh-result chip must prefill the active descriptor prefix");
  assert(app.includes("\u62a5\u5237\u65b0\u7ed3\u679c"), "refresh-result chip label missing");
  assert(!app.includes("onClick={onAugmentReroll}"), "refresh-result chip must not auto-trigger reroll handling");
  assert(!app.includes("onAugmentReroll"), "composer must not receive a reroll prop");
  assert(!app.includes("onPreset={"), "composer must not dispatch chips through an auto-send preset prop");
  assert(!app.includes("onPreset:"), "composer prop types must not expose an auto-send preset prop");
  assert(!app.includes("onPreset("), "composer must not call an auto-send preset prop");
  assert(!app.includes('sendPreset(refreshReportComposerPrompt)'), "refresh-result prefix must not be sent by a chip");
  assert(!app.includes('sendPreset(itemChoiceComposerPrompt)'), "item report prompt must not be sent by a chip");
  assert(!app.includes('sendPreset(lineupComposerPrompt)'), "lineup prompt must not be sent by a chip");
  assert(app.includes("sendPreset(ownedAugmentTextPanelPreset)"), "the explicit owned-augment OCR operation should remain a one-click immediate action");
  assert(hardDataAction?.request_kind === "hard_data_query", "Cruise must declare one typed hard-data request kind");
  assert(hardDataAction?.origin_action_id === "cruise_no_big_data", "hard-data capability must identify the explicit UI action");
  assert(hardDataAction?.evidence_policy_id === "active_core_profile_only", "hard-data capability must declare its closed evidence policy");
  assert(hardDataAction?.toggle_behavior === "second_click_returns_to_normal_cruise", "hard-data action must be a reversible toggle");
  assert(factCaptureAction?.toggle_behavior === "second_click_returns_to_normal_cruise", "fact-capture action must be a reversible toggle");
  assert(app.includes("runtime.sendCruiseHardDataQuery(text)"), "typed hard-data drafts must use the dedicated Runtime capability action");
  assert(!app.includes('origin_action_id: "cruise_no_big_data"'), "Renderer must not stamp the hard-data origin capability");
  assert(!app.includes('evidence_policy_id: "active_core_profile_only"'), "Renderer must not stamp the hard-data evidence policy");
  assert(bridge.includes("sendCruiseHardDataQuery(text: string)"), "renderer bridge must expose the dedicated text-only hard-data action");
  assert(dailyCoreTheoryAction?.label === "别吃大数据", "daily chat must expose the Core-only theory action");
  assert(dailyCoreTheoryAction?.request_kind === "daily_core_theory_query", "daily Core-only action must declare its typed request kind");
  assert(dailyCoreTheoryAction?.origin_action_id === "daily_no_big_data", "daily Core-only action must identify its explicit origin");
  assert(dailyCoreTheoryAction?.evidence_policy_id === "active_core_profile_only", "daily Core-only action must close its evidence policy");
  assert(dailyCoreTheoryAction?.toggle_behavior === "second_click_returns_to_normal_daily_chat", "daily Core-only action must be a reversible toggle");
  assert(app.includes("runtime.sendDailyCoreTheoryQuery(text)"), "daily Core-only drafts must use the dedicated Runtime capability action");
  assert(dailyRankingAction?.label === "大数据推荐", "daily chat must expose the ranking recommendation action");
  assert(dailyRankingAction?.request_kind === "ranking_recommendation_query", "daily ranking action must declare a typed request kind");
  assert(dailyRankingAction?.default_count === 5 && dailyRankingAction?.max_count === 16, "daily ranking action must expose bounded count defaults");
  assert(app.includes("ranking_requested_count"), "ranking recommendation count must reach Runtime");
  assert(app.includes("ranking_recommendation: true"), "ranking recommendation must use the typed capability flag");
  assert(bridge.includes("ranking_query_route_key"), "Runtime bridge must expose the optional Ranking route identity");
  assert(app.includes("resolveDailyRankingRecommendationAction"), "App must resolve the daily ranking action from the contract");
  assert(bridge.includes("sendDailyCoreTheoryQuery(text: string)"), "renderer bridge must expose the daily Core-only action");
  assert(app.includes("resolveDailyCoreTheoryAction"), "App must resolve the daily Core-only action from the contract");
  assert(popularRecipeAction?.label === "查热门阵容", "Cruise popular-recipe action must use the compact query label");
  assert(popularRecipeAction?.request_kind === "popular_recipe_query", "Cruise popular-recipe action must declare a dedicated request kind");
  assert(popularRecipeAction?.origin_action_id === "cruise_popular_recipe_query", "popular-recipe capability must identify the explicit UI action");
  assert(popularRecipeAction?.evidence_policy_id === "popular_recipe_catalog_only", "popular-recipe capability must declare its recipe-only evidence policy");
  assert(popularRecipeAction?.placement === "cruise_actions_last", "popular-recipe action must stay at the end of Cruise shortcuts");
  assert(popularRecipeAction?.toggle_behavior === "second_click_returns_to_normal_cruise", "popular-recipe action must be a reversible toggle");
  assert(app.includes("runtime.sendCruisePopularRecipeQuery(text)"), "typed popular-recipe drafts must use the dedicated Runtime capability action");
  assert(bridge.includes("sendCruisePopularRecipeQuery(text: string)"), "renderer bridge must expose the dedicated text-only popular-recipe action");
  assert(app.includes("const resetToCruiseComposer = () =>"), "action toggles must provide a normal Cruise reset path");
  assert(app.includes("const toggleActionMode = ("), "action toggles must share one reversible preset implementation");
  assert(app.includes("if (draftRequestKind === requestKind)"), "clicking an active action must return to normal Cruise");
  assert(
    app.indexOf("{mode?.popularRecipeAction && (") > app.indexOf("{!usesUserReportedChoices && mode?.primaryPresets.map"),
    "popular-recipe action must render after ordinary Cruise presets",
  );
  assert(!app.includes('origin_action_id: "cruise_popular_recipe_query"'), "Renderer must not stamp the popular-recipe origin capability");
  assert(!app.includes('evidence_policy_id: "popular_recipe_catalog_only"'), "Renderer must not stamp the popular-recipe evidence policy");
  const genericSendPayload = bridge.match(/export type SendMessagePayload = \{([\s\S]*?)\n\};/)?.[1] || "";
  assert(!genericSendPayload.includes("origin_action_id") && !genericSendPayload.includes("evidence_policy_id") && !genericSendPayload.includes("hard_data_query") && !genericSendPayload.includes("popular_recipe_query"), "generic sendMessage must not expose typed capability fields");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "choice modes clearly ask users to report candidates",
      "active-season and common choice modes source report copy from one descriptor contract",
      "candidate/report-result chips prefill and focus composer without auto-send",
      "existing explicit send remains behind the Send button or unchanged send chips",
      "Cruise no-big-data is a typed UI capability and cannot be activated by copied visible text",
      "Cruise popular recipes is a typed recipe-only capability rendered after ordinary presets",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
