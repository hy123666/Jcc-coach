import fs from "node:fs";
import path from "node:path";
import ts from "../ui/node_modules/typescript/lib/typescript.js";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const files = {
  app: read("ui/src/App.tsx"),
  styles: read("ui/src/styles.css"),
  bridge: read("ui/src/runtimeBridge.ts"),
  runtimeService: read("ui/electron/runtime-service.js"),
  preload: read("ui/electron/preload.js"),
  card: read("ui/src/components/DecisionInputCard.tsx"),
  combobox: read("ui/src/components/CatalogCombobox.tsx"),
  uiContract: read("data/runtime/jcc/runtime-ui-mode-contract.json"),
};
const uiContract = JSON.parse(files.uiContract);

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const hydrationHelperSource = files.app.match(
  /function equipmentRowsFromCanonical[\s\S]*?\n}\n\nfunction EquipmentHolderEditor/,
)?.[0].replace(/\n\nfunction EquipmentHolderEditor$/, "") || "";
const hydrationHelper = hydrationHelperSource
  ? new Function(`${ts.transpileModule(hydrationHelperSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText}\nreturn equipmentRowsFromCanonical;`)()
  : null;

const hydrate = (boardNames, equipped) => hydrationHelper?.(boardNames, equipped) || [];
const item = (canonicalId, ownerUnit, slot) => ({
  canonical_id: canonicalId,
  name: "Same Item",
  owner_unit: ownerUnit,
  ...(slot == null ? {} : { slot }),
});

const slotTwoOnly = hydrate(["Holder A"], [item("slot-2", "Holder A", 2)]);
expect(
  slotTwoOnly[0]?.slots.map((entry) => entry?.canonical_id || null).join(",") === ",slot-2,",
  "holder hydration must place a lone explicit slot-2 item once without copying it into slot 1",
);

const sparseOuterSlots = hydrate(["Holder A"], [item("slot-1", "Holder A", 1), item("slot-3", "Holder A", 3)]);
expect(
  sparseOuterSlots[0]?.slots.map((entry) => entry?.canonical_id || null).join(",") === "slot-1,,slot-3",
  "holder hydration must preserve explicit slots 1 and 3 without duplicating slot 3 into the gap",
);

const duplicateNameCopies = hydrate(["Holder A"], [
  item("explicit-copy", "Holder A", 2),
  item("unslotted-copy", "Holder A"),
]);
expect(
  duplicateNameCopies[0]?.slots.map((entry) => entry?.canonical_id || null).join(",") === "unslotted-copy,explicit-copy,",
  "holder hydration must keep distinct same-name copies and fill the first remaining slot with the unslotted copy",
);

const movedAcrossRows = hydrate(["Holder A", "Holder B"], [
  item("copy-a", "Holder A", 3),
  item("copy-b", "Holder B"),
]);
expect(
  movedAcrossRows.map((row) => `${row.ownerUnit}:${row.slots.map((entry) => entry?.canonical_id || "-").join("/")}`).join("|")
    === "Holder A:-/-/copy-a|Holder B:copy-b/-/-",
  "holder hydration must assign each canonical copy once after copies move between holder rows",
);

for (const action of ["getDecisionInputOptions", "submitDecisionInput", "confirmDecisionSelection"]) {
  expect(files.bridge.includes(`${action}(`), `runtimeBridge must expose ${action}()`);
  expect(files.preload.includes(`"${action}"`) && files.preload.includes(`${action}:`), `preload must expose ${action}`);
  expect(files.card.includes(action), `DecisionInputCard must call ${action}`);
}

expect(files.app.includes("<DecisionInputCard"), "App must render the structured decision card");
expect(files.app.includes("<EquipmentHolderEditor"), "S18 target/variables area must render the equipped-holder editor");
expect(files.app.includes("equipmentEditor={equipmentCatalogMode ? ("), "equipped-holder editor must be capability-gated by the available item catalog mode");
expect(!files.app.includes('equipmentEditor={activeSeasonId === "s18"'), "equipped-holder editor must remain season-neutral");
expect(files.app.includes('action: "equipment_equipped_update"'), "equipped-holder edits must reuse the fact-only structured equipment action");
expect(files.app.includes('filter(([key]) => !/champion|chess|unit|hero/i.test(key))'), "holder editor must keep champion directory rows out of the equipment candidate list");
expect(files.runtimeService.includes('champions: championOptions'), "item option hydration must expose the active-season champion directory for holder search");
expect(files.app.includes('equipment: { equipped }') && files.app.includes('changed_sections: ["equipped"]'), "equipped-holder edits must replace only the canonical equipped section");
expect(files.app.includes("resolved_decision_snapshot?.live_state_summary?.own_board?.units"), "equipped-holder rows must come from the trusted own-board snapshot");
expect(files.app.includes("...equipped.map((entry)") && files.app.includes('{ ownerUnit: "", slots: [null, null, null] }'), "equipped-holder rows must restore canonical holders and keep a manual fallback when board sensing is missing");
expect(files.app.includes("champion|chess|unit|hero") && files.app.includes("championCatalog"), "holder hero search must merge backend champion catalog groups with trusted own-board names");
expect(files.app.includes("添加持有者") && files.app.includes("onCommitInput={(value) =>"), "holder editor must support an explicit manual holder add fallback");
expect(files.app.includes("runtime.sendCruiseHardDataQuery(text)"), "hard-data queries must use the dedicated capability-owning bridge action");
expect(!files.app.includes('origin_action_id: "cruise_no_big_data"'), "renderer must not stamp hard-data origin capability fields");
expect(!files.app.includes('evidence_policy_id: "active_core_profile_only"'), "renderer must not stamp hard-data evidence capability fields");
expect(files.bridge.includes("sendCruiseHardDataQuery(text: string)"), "runtimeBridge must expose the dedicated hard-data query action");
const genericSendPayload = files.bridge.match(/export type SendMessagePayload = \{([\s\S]*?)\n\};/)?.[1] || "";
expect(!genericSendPayload.includes("origin_action_id") && !genericSendPayload.includes("evidence_policy_id") && !genericSendPayload.includes("hard_data_query"), "generic sendMessage payload must not carry hard-data capability fields");
for (const label of ["基础", "成型", "光明", "辅助", "神器", "纹章", "特殊", "其他"]) {
  expect(files.app.includes(`label: "${label}"`), `equipped-holder catalog must expose ${label} grouping`);
}
expect(files.bridge.includes("holder_intent?: string | null"), "runtimeBridge must preserve equipped holder intent");
expect(files.bridge.includes("choice_window_instance_id?: string"), "runtimeBridge must carry explicit choice-window instance identity");
expect(files.card.includes("下一次装备选择"), "item choice UI must expose an explicit next-choice interaction");
expect(files.card.includes("choice_window_instance_id: choiceWindowInstanceId"), "choice-window identity must flow through item submit and confirmation payloads");
expect(files.card.includes("const beginNewItemChoiceWindow"), "item choice UI must reset a new window explicitly instead of inferring it from changed candidates");
expect(files.bridge.includes("const previewOpenWindowIds = new Map<string, string>()"), "browser preview must retain a stable unsubmitted choice-window identity");
expect(files.bridge.includes('normalizedKind.includes("augment")'), "browser preview must normalize descriptor-specific augment kinds before assigning window identity");
expect(files.card.includes('{ key: "support", label: "辅助装备"') && files.card.includes('{ key: "special", label: "特殊装备"'), "shared equipment inventory editor must expose support and special categories");
expect(files.bridge.includes("resolved_decision_snapshot?:"), "runtimeBridge must type the trusted own-board snapshot");
expect(files.app.includes("decisionInputDrafts") && files.app.includes("decisionInputStages"), "App must own match-lifetime structured-card drafts and selected stages");
expect(files.app.includes("decisionInputDraftSessionRef") && files.app.includes("setDecisionInputDrafts({})"), "structured-card drafts must reset only when the canonical match boundary changes");
expect(files.card.includes("drafts: DecisionInputCardDrafts") && files.card.includes("stageByMode: DecisionInputCardStages"), "DecisionInputCard must consume parent-owned drafts instead of unmount-local state");
expect(!files.card.includes("useState<Record<string, CardDraft>>"), "DecisionInputCard must not keep volatile component-local draft state");
expect(files.card.includes('mode.id === "augment"'), "card must support augment mode");
expect(files.card.includes('mode.id === "item"'), "card must support forge/anvil mode");
expect(files.card.includes("mode.decisionStages"), "card must support descriptor-driven season choice stages");
expect(files.uiContract.includes('"stage_tabs": [') && files.uiContract.includes('"2-1"') && files.uiContract.includes('"4-2"'), "augment contract must expose exact stage tabs");
expect(files.card.includes("tierColor") && files.card.includes("tier_color"), "augment tier must filter catalog candidates and enter structured payload");
expect(files.card.includes("decisionOptions?.candidate_filters?.categories") && files.card.includes('className="decision-category-filter"'), "augment card must render category filters supplied by the active catalog");
expect(files.card.includes("category_ids: selectedCategoryIds") && files.bridge.includes("category_ids?: string[]"), "renderer and bridge must carry category ids to Runtime filtering");
expect(files.uiContract.includes('"candidate_category_filter"') && files.uiContract.includes('"match_any_selected_category"'), "common UI contract must define catalog-driven multi-category OR semantics");
for (const label of ["经济", "战力", "装备", "羁绊", "专属", "其他"]) {
  expect(!files.card.includes(`label: "${label}"`), `common DecisionInputCard must not hardcode active-season augment category ${label}`);
}
expect(!files.card.includes("datalist"), "candidate fields must not use native datalist");
expect(files.card.includes("CatalogCombobox") && files.card.includes("findOption"), "candidate fields must resolve catalog-backed searchable entities through the custom combobox");
expect(files.card.includes("optionMatchesDefaultList") && files.card.includes(": candidateDefault"), "empty combobox lists must stay scoped to current-stage legal defaults");
expect(files.card.includes("candidateSearchResults") && files.card.includes("query,") && files.card.includes('limit: 256'), "typed combobox search must query the global catalog without replacing strict dropdown defaults");
expect(files.card.includes("availability_match") && files.card.includes("按本局上报"), "typed cross-stage and unknown-stage results must expose availability guidance");
expect(files.card.includes("candidateOptionSourceKey"), "descriptor-owned choice modes must consume their declared candidate option source");
expect(files.combobox.includes("role=\"combobox\"") && files.combobox.includes("aria-activedescendant"), "custom combobox must expose keyboard/ARIA semantics");
expect(files.bridge.includes("search_terms?: string[]"), "decision candidates must carry compiled alias search terms into every card surface");
expect(files.combobox.includes("option.searchTerms") && files.combobox.includes("searchTerms?: string[]"), "the shared catalog combobox must filter every mode by compiled aliases");
expect(files.combobox.includes("onCompositionStart") && files.combobox.includes("onCompositionEnd") && files.combobox.includes("!composing"), "custom combobox must be safe for Chinese IME Enter composition");
expect(files.combobox.includes("没有匹配候选"), "custom combobox empty state must be Chinese");
expect(!/slice\(0,\s*maxVisible\)/.test(files.combobox), "custom combobox must not truncate candidate data with maxVisible");
expect(files.styles.includes("--catalog-visible-rows") && files.styles.includes("overflow-y: auto"), "custom combobox may limit dropdown pixels only through internal scrolling");
expect(files.card.includes("candidateInputsAreResolved"), "unresolved free text must not become a final structured choice");

for (const field of ["choice_kind", "stage_round", "payload_binding", "changed_slots"]) {
  expect(files.card.includes(field), `decision card payload must include ${field}`);
  expect(files.bridge.includes(field), `runtimeBridge payload type must include ${field}`);
}
expect(!/\bstage\?: string/.test(files.bridge), "runtimeBridge must not use the obsolete stage field");
expect(files.card.includes("selected_choice") && files.card.includes("slot: Number(selected.slot)"), "final confirmation must use exact top-level slot/name identity");
expect(files.card.includes('applyResultBinding(result);') && files.card.includes('if (!result.ok)'), "final confirmation must refresh the canonical binding and branch on backend success before showing success");
expect(files.card.includes('onStatus(result.message || "已记录最终选择，后续建议会使用这项选择。")'), "final confirmation must report persistence without promising a Host answer");
expect(files.app.includes('["choice_confirmation_recorded", "choice_confirmation_already_recorded"]'), "App must treat new and duplicate confirmations as state-only completion");
expect(files.app.includes("structuredDecisionBusinessFailureText"), "structured-card business validation failures must not be mislabeled as Host CLI failures");
expect(!files.app.includes("choice_confirmation_followup_not_created"), "renderer must remove retired confirmation follow-up failures");
expect(!files.app.includes("choice_confirmation_followup_recovered"), "renderer must remove retired confirmation follow-up recovery");
expect(files.bridge.includes("adviceOptionalCandidateFields") && files.bridge.includes("finalSelectionRequiredFields"), "renderer mode resolution must preserve advice-time optional and final-selection required fields");
const confirmDisabledExpression = files.card.match(/const confirmDisabled =([\s\S]*?);/)?.[1] || "";
expect(confirmDisabledExpression && !confirmDisabledExpression.includes("draft.dirty"), "locally changed candidates must remain confirmable through atomic no-advice save");
expect(files.card.includes("choice_update") && files.card.includes("submitChoice(false)"), "final confirmation must atomically save latest candidates without requiring model advice or an implicit equipment write");
expect(files.card.includes("current_effective_equipment") && files.card.includes("equipmentFromRuntime"), "shared equipment must hydrate from daemon-owned effective equipment");
expect(files.card.includes("reported?.target_note") && files.card.includes("candidatesToHydrate[0]?.tier_color"), "submitted card hydration must restore target note and augment tier as well as candidates");

for (const category of ["components", "completed", "radiant", "artifacts", "emblems"]) {
  expect(files.card.includes(`\"${category}\"`), `shared equipment editor must include ${category}`);
}
expect(files.card.includes("Backspace"), "equipment editor must remove one whole token on Backspace");
expect(files.card.includes("submitEquipment(category, [], false, true, requestGeneration)"), "one-click clear must submit an explicit empty category without opening advice and must fence late acknowledgements");
expect(files.card.includes("submitEquipment(category, nextEntries, false, true, requestGeneration)"), "equipment token edits must persist across modes without opening a Host answer and must fence late acknowledgements");
expect(files.card.includes("changed_sections"), "equipment module updates must state exactly which categories changed");
expect(!files.card.includes("equipment_${category}_advice"), "equipment category-level advice buttons must be removed");
expect(files.card.includes("确认装备"), "equipment module must expose an explicit whole-snapshot fact confirmation");
expect(files.card.includes('requestAdvice ? "equipment_all_advice" : "equipment_all_update"'), "whole equipment confirmation must use a fact-only action distinct from whole-equipment advice");
expect(files.card.includes("submitEquipment(undefined, undefined, false, false)"), "confirm equipment must submit the full snapshot without opening a Host answer");
expect(files.card.includes("equipmentHydrated") && files.card.includes("setEquipmentHydrated(false)") && files.card.includes("setEquipmentHydrated(true)"), "confirm equipment must wait for daemon-owned equipment hydration instead of confirming an uninitialized empty draft");
expect(files.card.includes("disabled={busy !== null || !equipmentHydrated}"), "confirm equipment must depend on equipment hydration without depending on the surrounding choice binding");
expect(files.card.includes("整体装备建议"), "equipment module must retain only whole-equipment advice");
expect(files.card.includes("request_advice: requestAdvice") && files.card.includes('requestAdvice ? "choice_advice" : undefined'), "the unified choice button must explicitly request one advice owner");
expect((files.card.match(/>\s*获取建议\s*<\/button>/g) || []).length === 1 && !files.card.includes("只看当前选择") && !files.card.includes("整体获取建议"), "choice cards must expose exactly one context-complete advice action without redundant variants");
expect(files.card.includes('onClick={() => submitChoice()} disabled={busy !== null || !binding}'), "unified choice advice must not wait for equipment hydration");
expect(files.card.includes("...(requestAdvice && equipmentHydrated ? {") && files.card.includes("equipmentCategories.map((category) => category.key)"), "unified choice advice must include the hydrated visible equipment snapshot while no-advice candidate saves remain equipment-independent");
expect(files.card.includes('<section className="equipment-editor"'), "every structured choice mode, including item mode, must expose the shared equipment editor");
expect(files.card.includes("equipmentFacets") && files.card.includes('input.trim() || !showFacets || facet === "all"'), "equipment dropdown facets must never restrict explicit typed search");
expect(files.card.includes("browse_facets") && files.card.includes("optionBrowseFacets"), "equipment facets must use curated browse facets instead of raw stat/effect tags");
expect(!files.card.includes('tags: ["armor", "health", "magic_resist"'), "frontline facet must not be inferred from incidental defensive stat tags");
expect(files.bridge.includes("browse_facets?: string[]") && files.bridge.includes("primary_role?: string"), "runtime bridge must preserve curated item usage taxonomy");
expect(files.combobox.includes("metaChips") && files.combobox.includes("catalog-option-subtitle") && files.combobox.includes("aria-label={option.meta"), "catalog dropdown must render readable structured metadata with an accessible full label");
expect(!files.combobox.includes("<em>{option.meta}</em>"), "catalog dropdown must not squeeze all metadata into one truncated badge");
expect(files.styles.includes(".catalog-option-label") && files.styles.includes(".catalog-option-subtitle") && files.styles.includes(".catalog-option-chip"), "catalog dropdown styles must support two-line reward options and separate metadata chips");
expect(files.card.includes("inherited_candidates"), "descriptor-owned choice cards must restore canonical inherited candidates");
expect(files.card.includes("mode.refreshReportPrefix"), "partial reroll guidance must come from the active mode descriptor instead of a second report composer");
expect(files.card.includes("changedSlots") && files.card.includes("Array.from(new Set"), "partial reroll must preserve unchanged slots and identify changed slots");
expect(files.card.includes("slotCount") && files.card.includes("completed_item_forge") && files.card.includes("slots: 5"), "item mode must support four/five candidate slots");

expect(files.app.includes("sortMatchModesForDecisionRail"), "mode rail must keep item mode last");
expect(files.app.includes("suppressStructuredMissingChoicePrompts"), "structured confirmation must suppress redundant missing-choice chat prompts");
expect(files.app.includes("structuredDecisionActive") && files.app.includes("matchActive && !structuredDecisionActive"), "old composer candidate controls must be hidden while a decision card is active");
expect(files.app.includes('onClick={() => prefillPreset(preset.prompt)}'), "ordinary descriptor presets must prefill instead of auto-send");
expect(!files.app.includes('preset.interaction === "prefill_only"'), "ordinary prompt preset behavior must not branch back to auto-send in App");
for (const [modeId, mode] of Object.entries(uiContract.modes || {})) {
  for (const preset of mode?.renderer?.primary_presets || []) {
    expect(preset?.interaction === "prefill_only", `${modeId} primary preset ${preset?.label || "unknown"} must require explicit send`);
  }
}
for (const preset of uiContract.cruise_mode_policy?.renderer?.primary_presets || []) {
  expect(preset?.interaction === "prefill_only", `cruise primary preset ${preset?.label || "unknown"} must require explicit send`);
}
expect(uiContract.renderer_prompt_preset_policy?.ordinary_prompt_presets === "prefill_editable_composer_and_require_explicit_send", "UI contract must declare one editable preset policy across modes");
const lineupDirectionPreset = uiContract.cruise_mode_policy?.renderer?.primary_presets
  ?.find((preset) => preset?.label === "阵容方向");
expect(lineupDirectionPreset?.interaction === "prefill_only", "lineup direction must prefill so the player can add an optional target before sending");
expect(!files.app.includes('|| mode.id === "lineup"'), "lineup prefill behavior must come from the descriptor instead of an App fallback");
expect(files.app.includes('task?.mode === "lineup_card" ? 300000 : 120000'), "lineup delivery polling must honor the registered five-minute deep timeout");

expect(files.styles.includes(".decision-input-card"), "styles must define the structured card");
expect(files.app.includes('className="equipment-holder-field"') && files.app.includes("装备 {slotIndex + 1}"), "each holder must expose one hero row followed by three labelled equipment rows");
expect(files.styles.includes(".equipment-holder-field") && files.styles.includes("grid-template-columns: 58px minmax(0, 1fr)"), "equipped-holder fields must use a stable vertical label/control layout");
expect(!files.styles.includes("repeat(3, minmax(118px, 1fr))") && !files.styles.includes("min-width: 470px"), "equipped-holder UI must not force the old horizontal scrolling table");
expect(files.styles.includes("height: 100px;") && files.styles.includes("height: 78px;"), "match composer must show multiple readable lines on desktop and compact layouts");
expect(files.styles.includes("52vh"), "decision card must receive roughly half-height priority");
expect(!files.styles.includes(".decision-input-card .pinned-card"), "decision card must not nest pinned-card styling");
expect(files.styles.includes(".equipment-editor") && files.styles.includes("grid-template-columns: minmax(0, 1fr);"), "shared equipment categories must use a full-width one-column layout");
expect(files.combobox.includes("setOpen(true)") && files.combobox.includes("setActiveIndex(0)"), "dropdown arrow must deterministically open the complete candidate list");
expect(files.uiContract.includes('"choice_kind": "item_choice_panel"'), "item mode UI kind must be owned by the current common UI contract");

if (failures.length) {
  console.error("Decision input UI verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  checked: [
    "descriptor-driven common and active-season structured cards",
    "match-lifetime draft persistence across temporary mode unmounts",
    "exact stage/tier catalog identity",
    "immutable payload binding and changed-slot reporting",
    "exact nonblank catalog-backed final confirmation",
    "shared equipment hydration, whole-token deletion, and explicit clear",
    "sparse holder slots and distinct canonical equipment copies",
    "choice/module/whole-card advice ownership",
    "partial reroll without auto-send",
    "open-ended preset prefill and lineup five-minute delivery window",
  ],
}, null, 2));
