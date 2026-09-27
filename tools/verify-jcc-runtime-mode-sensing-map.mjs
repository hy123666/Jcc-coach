import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildWorkerPlan as buildWorkerPlanImpl } from "./build-jcc-runtime-worker-plan.mjs";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { loadActiveRulesBundle } from "./jcc_active_rules_contract.mjs";
import { createActiveCoreProfileSnapshot } from "./jcc_test_core_profile_fixture.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertUserReportedChoice(pathConfig, expected) {
  assert(pathConfig?.enabled === true, `${expected.label} must enable current-match user reporting`);
  assert(pathConfig.source === "current_match_user_report", `${expected.label} must use current-match user reports`);
  assert(pathConfig.target === expected.target, `${expected.label} must target ${expected.target}`);
  assert(pathConfig.no_ocr_or_vision_fallback === true, `${expected.label} must not fall back to OCR or vision`);
  assert(pathConfig.fallback === "none" || pathConfig.role === "current_match_user_report_only", `${expected.label} must fail closed outside user reports`);
}

async function main() {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const activePaths = createRuntimePaths(repoRoot);
  const rulesBundle = loadActiveRulesBundle({ repoRoot, runtimePaths: activePaths });
  const seasonVersionSnapshot = createActiveCoreProfileSnapshot(repoRoot, {
    runtimePaths: activePaths,
  });
  const buildWorkerPlan = (options) => buildWorkerPlanImpl({
    seasonVersionSnapshot,
    expectedCoreProfileId: activePaths.activeCoreProfileId,
    ...options,
  });
  const map = JSON.parse(await readFile(path.resolve("data/runtime/jcc/runtime-mode-sensing-map.json"), "utf8"));
  assert(map.default_backend.multimodal_agent_sensing === "tools/run-jcc-multimodal-runtime-observation.mjs", "multimodal runtime observation must be the default hard-visual backend");
  assert(map.default_backend.vision_request_builder === "tools/run-jcc-vision-model-observation.mjs", "vision request builder must remain the lower-level converter");
  assert(map.default_backend.host_cli_agent_response === "provided_by_codex_cli_or_compatible_multimodal_cli_agent", "host CLI agent response must be the product multimodal source");
  assert(map.default_backend.text_ocr_worker === "resident-rapidocr-worker", "text OCR must be modeled as one resident worker");
  assert(map.default_backend.roi_crop_task_contract === "docs/runtime-ocr-redesign.md", "ROI crop-task contract must be documented");
  assert(map.default_backend.frame_policy === "transient_only_delete_after_structured_extraction", "frame policy must stay transient");
  assert(!("legacy_text_ocr_debug" in map.default_backend), "default backend must not keep legacy OCR as the product text path");
  assert(map.global_policies.detached_model_service_policy?.includes("not_used_in_product_runtime"), "product runtime must not require a detached model service");
  assert(map.default_backend.icon_asset_reference === "data/runtime/jcc/visual-icons/manifest.json", "icon assets must remain available as reference data");
  assert(map.global_policies.vision_model_primary_for_hard_visual_tasks === false, "host multimodal vision must be fallback, not product hot-path primary");
  assert(map.global_policies.product_hot_path_primary === "mumu_structured_sources_plus_hud_roi_ocr_plus_current_match_user_reported_choice_candidates", "product hot path must combine MuMu facts, HUD ROI OCR, and user-reported choice candidates");
  assert(map.global_policies.vision_model_invocation_policy?.includes("fallback_for_missing_or_ambiguous"), "vision model must be fallback for missing or ambiguous evidence");
  assert(map.global_policies.hard_visual_ocr_policy?.includes("scoped_roi_only"), "OCR must be scoped ROI only outside explicit calibration");
  assert(/4357 remains the (?:opportunistic )?primary structured left item rail source/.test(map.global_policies.icon_matcher_policy || ""), "icon matcher policy must make 4357 the opportunistic primary left item rail source when emitted");
  assert(/fallback\/validation(?: candidates)? only/.test(map.global_policies.icon_matcher_policy || ""), "icon matcher policy must restrict left rail icons to fallback/validation candidates");
  assert(map.global_policies.vision_model_must_output_structured_json_only === true, "vision model must output structured JSON only");
  assert(map.global_policies.no_fullscreen_ocr_by_default === true, "fullscreen OCR must not be default");
  assert(map.global_policies.auto_mode_must_not_infer_choice_panels_from_text_alone === true, "auto mode must be fail-closed");
  assert(map.global_policies.opponent_board_policy?.includes("not a product path"), "opponent board product-removal policy missing");
  assert(map.global_policies.unit_attached_equipment_phase_gate?.stable_status_codes?.includes(1), "unit-attached equipment must be gated to stable planning/actionable phase");
  assert(map.global_policies.unit_attached_equipment_phase_gate?.observing_status_codes?.includes(2), "unit-attached equipment must treat s=2 as observing/non-self evidence");
  assert(map.global_policies.unit_attached_equipment_phase_gate?.promotion_rule?.includes("must never update own equipped items"), "s=2 unit-attached equipment must not update own equipped items");
  assert(map.global_policies.unit_attached_equipment_phase_gate?.promotion_rule?.includes("never creates opponent unit facts"), "s=2 unit-attached equipment must not create opponent facts");
  assert(map.global_policies.view_scope_policy?.s1?.includes("S=1 plus a fresh non-empty 4354 shop anchor"), "view scope policy must require S=1 plus fresh non-empty shop for own promotion");
  assert(map.global_policies.view_scope_policy?.s2?.includes("non-self current view"), "view scope policy must define S=2 as non-self observing");
  assert(map.global_policies.view_scope_policy?.mumu_4353?.includes("own-unit candidate"), "view scope policy must keep 4353 as own-unit candidate only");
  assert(map.global_policies.view_scope_policy?.mumu_4357?.includes("primary"), "view scope policy must make 4357 primary left item rail source");
  assert(map.global_policies.view_scope_policy?.mumu_4356?.includes("unassigned diagnostics"), "view scope policy must quarantine ungated 4356");

  assert(!map.modes.augment_choice.vision_model, "augment choice must not retain host visual fallback");
  assert(!map.modes.augment_choice.text_roi_fast_path, "augment choice must not retain active OCR intake");
  assertUserReportedChoice(map.modes.augment_choice.user_report_contract, {
    label: "augment choice",
    target: "augments.current_choice_set",
  });
  assert(map.modes.augment_choice.must_not_write.includes("augments.selected_augments_without_confirmation"), "augment final state must require confirmation");
  assert(map.modes.augment_choice.choice_set_policy?.latest_visible_set_replaces_pending_current_choices === true, "augment current choice set must be latest visible set only");
  assert(map.modes.augment_choice.choice_set_policy?.previous_sets_are_strategy_evidence_not_current_options === true, "augment previous sets must not be current options");
  const ownedAugmentTextPanel = map.modes.augment_choice.owned_augment_text_panel_roi || {};
  assert(ownedAugmentTextPanel.enabled === true, "owned augment text-panel OCR must be enabled after user-calibrated ROI is available");
  assert(ownedAugmentTextPanel.trigger === "manual_augment_mode_owned_augment_panel_preset_only", "owned augment text-panel OCR must be manual augment-mode only");
  assert(ownedAugmentTextPanel.target === "runtime_triggers.owned_augment_text_panel_ocr", "owned augment text-panel OCR must target diagnostic runtime evidence only");
  assert(ownedAugmentTextPanel.role === "diagnostic_only_never_choice_confirmation", "owned augment text-panel OCR must remain diagnostic-only");
  assert(ownedAugmentTextPanel.source === "user_triggered_owned_augment_text_panel_ocr", "owned augment text-panel OCR must use a distinct source");
  assert(ownedAugmentTextPanel.stage_binding_policy?.includes("slot0=2-1") && ownedAugmentTextPanel.stage_binding_policy?.includes("slot2=4-2"), "owned augment text-panel OCR must use fixed augment-row stage binding");
  assert(ownedAugmentTextPanel.stage_binding_policy?.includes("ignore every non-augment row"), "owned augment text-panel OCR must ignore season-specific non-augment rows");
  assert(ownedAugmentTextPanel.cruise_policy?.includes("must not trigger"), "cruise must consume but not trigger owned augment text-panel OCR");
  assert((ownedAugmentTextPanel.must_not_write || []).includes("current_choice_set"), "owned augment text-panel OCR must not overwrite current choice candidates");
  assert((ownedAugmentTextPanel.must_not_write || []).includes("match_context.choice_confirmations"), "owned augment text-panel OCR must not write canonical choice confirmations");
  assert((ownedAugmentTextPanel.must_not_write || []).includes("non_augment_rows"), "owned augment text-panel OCR must not promote non-augment rows");

  const seasonChoiceModes = (rulesBundle?.season_special_rules?.mechanics?.choice_mechanics || [])
    .map((entry) => String(entry?.mode || "").trim())
    .filter(Boolean);
  for (const mode of seasonChoiceModes) {
    assert(!map.modes[mode], `common sensing map must not embed descriptor-owned mode: ${mode}`);
    const seasonChoicePlan = await buildWorkerPlan({ mode, event: "season_choice_sensing_test", matchSessionId: "jcc-test-match" });
    assert(seasonChoicePlan.mode_sensing_policy?.source === "compiled_active_rules_choice_mode_contract", "active-season choice sensing must come from the season descriptor");
    assertUserReportedChoice(seasonChoicePlan.mode_sensing_policy?.user_report_contract, {
      label: "active-season choice",
      target: `match_context.reported_choice_sets_by_mode.${mode}.candidates`,
    });
  }
  if (seasonChoiceModes.length === 0) {
    let rejected = false;
    try {
      await buildWorkerPlan({ mode: "retired_season_choice_mode", event: "season_choice_sensing_test", matchSessionId: "jcc-test-match" });
    } catch (error) {
      rejected = /Unknown mode for worker plan/.test(error?.message || String(error));
    }
    assert(rejected, "a season with no descriptor-owned choice must reject an unregistered retired mode");
  }

  assert(!map.modes.item_choice.vision_model, "item choice must not retain host visual fallback");
  assert(!map.modes.item_choice.text_roi_fast_path, "item choice must not retain active OCR intake");
  assertUserReportedChoice(map.modes.item_choice.user_report_contract, {
    label: "item choice",
    target: "items.choice_options",
  });
  assert(/manual/i.test(map.modes.item_choice.manual_trigger_policy || ""), "item choice reporting must be manually triggered, not cruise-auto triggered");
  assert(!map.modes.item_choice.icon_match, "item choice must not retain an unused icon-matching path");

  assert(!map.modes.refresh_self_state.vision_model, "self refresh must not retain host multimodal product sensing");
  assert(map.modes.refresh_self_state.text_ocr?.some((entry) => entry.target === "economy.hp"), "self refresh must retain narrow HUD OCR");
  const numericAuthority = map.modes.refresh_self_state.numeric_authority_policy || {};
  assert(numericAuthority.missing_before_numeric_coercion?.includes("null could become zero"), "missing HUD fields must be rejected before JavaScript numeric coercion");
  assert(numericAuthority.requested_field_without_result?.includes("field_status"), "requested HUD fields without results must retain explicit diagnostics");
  assert(numericAuthority.same_frame_hud_anchor?.includes("phase.stage_round"), "economy OCR must require a same-frame stage HUD anchor before promotion");
  assert(numericAuthority.same_frame_hud_anchor?.includes("cannot be combined with a later stage-only observation"), "loading-screen numbers must not be legitimized by a later stage-only read");
  assert(numericAuthority.field_level_promotion?.includes("valid sibling fields"), "HUD authority must promote valid fields independently");
  assert(numericAuthority.active_match_hp_zero?.includes("invalid/missing"), "active-match HP zero must remain missing without elimination evidence");
  assert(numericAuthority.persisted_invalid_cleanup?.includes("preserving valid sibling"), "persisted false-zero cleanup must preserve valid sibling economy facts");
  assert(map.modes.refresh_self_state.production_policy?.includes("explicit user refresh/equipment request"), "item icon candidates must remain explicit-request only");
  const selfIconEntries = map.modes.refresh_self_state.icon_match;
  const leftItemRail = selfIconEntries.find((entry) => entry.source === "left_item_rail_roi_icon");
  assert(leftItemRail?.enabled === true && leftItemRail.target === "items.item_bench_candidates", "left item rail icon matcher must write scoped validation/fallback candidates only");
  assert(leftItemRail.role === "fallback_and_validation_left_item_rail_roi_icon_only", "left item rail icon role must not be primary product item_bench");
  assert(leftItemRail.primary_source === "mumu_4357_item_bench", "left item rail icon matcher must name 4357 as primary source");
  assert(leftItemRail.promotion_policy?.includes("never_fill_items_item_bench"), "left item rail icon matcher must never fill items.item_bench");
  assert(leftItemRail.roi_script === "tools/roi_left_item_rail.py", "left item rail must use the ROI crop task script");
  assert(leftItemRail.icon_matcher === "tools/match-jcc-left-item-rail-icons.mjs", "left item rail must use the scoped item icon matcher");
  assert(leftItemRail.aggregator === "tools/jcc_left_item_rail_field_aggregator.mjs", "left item rail must use the scoped field aggregator");
  assert(leftItemRail.runner === "tools/run-jcc-left-item-rail-roi-icon.mjs", "left item rail must expose one formal runner");
  assert((leftItemRail.must_not_enable_for || []).includes("items.item_bench"), "left item rail icon source must not be enabled for primary item_bench");
  assert((leftItemRail.must_not_write || []).includes("items.item_bench"), "left item rail icon source must not write primary item_bench");
  assert((leftItemRail.must_not_enable_for || []).includes("items.equipped_items"), "left item rail source must not be reused for unit-equipped items");
  assert(selfIconEntries.length === 1, "refresh_self_state must not retain disabled obsolete icon-matching entries");

  const selfTextOcrEntries = map.modes.refresh_self_state.text_ocr || [];
  const selfTextRoles = new Set(selfTextOcrEntries.map((entry) => entry.role));
  assert(selfTextRoles.has("hud_stage_round_fast_path"), "self refresh OCR must include the HUD stage-round fast path");
  assert(selfTextRoles.has("hud_economy_fast_path"), "self refresh OCR must include the HUD economy fast path");
  assert(selfTextOcrEntries.every((entry) => entry.ocr_worker === "resident-rapidocr-worker"), "self refresh OCR must use the resident OCR worker");
  assert(selfTextOcrEntries.every((entry) => entry.aggregator === "tools/jcc_ocr_field_aggregator.py"), "self refresh OCR must use the unified field aggregator");
  assert(selfTextOcrEntries.every((entry) => entry.scope_limit === "phase_and_economy_only"), "self refresh OCR must be limited to phase/economy fields");
  assert(selfTextOcrEntries.every((entry) => typeof entry.roi_script === "string" && entry.roi_script.startsWith("tools/roi_")), "self refresh OCR must be sourced from ROI crop-task scripts");
  const selfTextTargets = new Set(selfTextOcrEntries.map((entry) => entry.target));
  for (const target of ["phase.stage_round", "economy.gold", "economy.level", "economy.xp", "economy.hp"]) {
    assert(selfTextTargets.has(target), `self refresh OCR must target ${target}`);
  }
  assert(!selfTextTargets.has("economy.hp_candidate"), "self refresh OCR must promote confirmed local HP, not an old hp_candidate field");

  assert(!map.modes.opponent_power, "opponent_power must not exist in product mode sensing map");
  assert(!map.modes.opponent_positioning, "opponent_positioning must not exist in product mode sensing map");
  assert(map.icon_matcher_status.product_tools?.includes("tools/run-jcc-left-item-rail-roi-icon.mjs"), "icon matcher status must list the left item rail product runner");
  assert(map.icon_matcher_status.product_tools?.includes("tools/match-jcc-left-item-rail-icons.mjs"), "icon matcher status must list the scoped product matcher");
  assert(!map.icon_matcher_status.product_tools?.some((tool) => tool.includes("legacy")), "icon matcher product tools must not include legacy/debug matchers");
  assert(
    !(map.icon_matcher_status.debug_tools || []).some((tool) => /legacy|debug/i.test(tool)),
    "icon matcher status must not retain deleted legacy/debug tool references",
  );
  assert(!/broad legacy matchers remain/i.test(map.icon_matcher_status.current_status || ""), "icon matcher status must describe only the current formal chain");
  assert(/4357 is the (?:opportunistic )?primary product source/.test(map.icon_matcher_status.current_status || ""), "icon matcher status should name 4357 as the opportunistic primary source when emitted");
  assert(map.icon_matcher_status.current_status.includes("must not populate items.item_bench"), "icon matcher status should forbid item_bench promotion");
  console.log(JSON.stringify({
    ok: true,
    checked: [
      "mode sensing map combines MuMu structured facts, HUD ROI OCR, and current-match user-reported choices",
      "text OCR is modeled as crop tasks plus one resident OCR worker",
      "active choice modes require user reports and have no OCR or vision fallback",
      "season-specific choice sensing is compiled from active major-season rules instead of the common mode map",
      "self phase/economy HUD fields use ROI scripts plus unified aggregator",
      "economy promotion requires a same-frame stage HUD anchor",
      "missing HUD values remain missing and field-level diagnostics survive",
      "self HP target is economy.hp, not a legacy hp_candidate",
      "opponent board unit sensing is removed from product mode map",
      "self-state and active-choice production paths do not use host multimodal vision",
      "deleted broad icon matchers are absent from mode configuration",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
