#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildEquipmentCatalog,
  extractUserConfirmedEquipment,
  mergeUserConfirmedEquipment,
  resolveEquipmentFactLayers,
  resolveMaterialEquipmentDecisionContext,
  shouldRequestUserEquipmentContext,
} from "../ui/electron/runtime-equipment-context.js";
import { leftItemRailFallbackDecision } from "../ui/electron/runtime-sensing-policy.js";
import { collectLiveState, scoreLiveState } from "./score-jcc-cruise-strategy.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const overlay = JSON.parse(readFileSync(
  path.join(repoRoot, "data/runtime/jcc/mumu-catalog-overlay.json"),
  "utf8",
).replace(/^\uFEFF/, ""));
const activeProfile = JSON.parse(readFileSync(
  path.join(repoRoot, "data/game-knowledge/jcc/active-profile.json"),
  "utf8",
).replace(/^\uFEFF/, ""));
const activeBundle = JSON.parse(readFileSync(
  path.join(repoRoot, "data/game-knowledge/jcc", activeProfile.bundle_path),
  "utf8",
).replace(/^\uFEFF/, ""));
const catalog = buildEquipmentCatalog(overlay, activeBundle.entity_alias_gateway);

const expectedOverlayItemCount = new Set(Object.values(overlay?.items_by_id || {})
  .map((item) => `${item?.id || ""}:${item?.normalized_name || item?.name || ""}`)
  .filter((value) => !value.endsWith(":"))).size;
assert.equal(catalog.items.length, expectedOverlayItemCount, "equipment parser must preserve the complete current Overlay item catalog");
assert(catalog.items.length > 100, "equipment parser must use the active catalog instead of a tiny hardcoded list");

const questionOnly = extractUserConfirmedEquipment(
  "贾克斯的完美装备是什么？我应该做双泰坦吗？",
  { catalog },
);
assert.equal(questionOnly, null, "theoretical item questions must not become owned-item facts");

const terseWithoutPrompt = extractUserConfirmedEquipment("攻速、拳套、腰带", { catalog });
assert.equal(terseWithoutPrompt, null, "a bare item list must not become owned facts without an active confirmation prompt");
const tersePromptReply = extractUserConfirmedEquipment("攻速、拳套、腰带", {
  catalog,
  allowTerseReport: true,
});
assert(tersePromptReply, "a terse reply to the contextual equipment prompt must be accepted");
assert.deepEqual(tersePromptReply.item_bench.map((item) => item.name), ["反曲之弓", "拳套", "巨人腰带"]);
const voiceTranscriptReply = extractUserConfirmedEquipment("攻速拳套腰带", {
  catalog,
  allowTerseReport: true,
});
assert.deepEqual(
  voiceTranscriptReply?.item_bench.map((item) => item.name),
  ["反曲之弓", "拳套", "巨人腰带"],
  "speech transcription without punctuation must still preserve adjacent item aliases",
);
const mixedReportQuestion = extractUserConfirmedEquipment("我现在有攻速和拳套，这回合该不该合？", { catalog });
assert(mixedReportQuestion, "an explicit equipment report plus a question must update facts for the direct answer owner");
assert.equal(catalog.aliases.get("铲铲")?.name, "金铲铲", "Common aliases must drive the direct equipment parser");
assert.equal(catalog.aliases.has("铲子"), false, "retired JavaScript-only aliases must not remain a second production authority");

const explicitEmptyHolders = extractUserConfirmedEquipment(
  "我没有穿任何装备，现在是攻速腰带、锁子甲、魔抗和一个金铲铲",
  { catalog },
);
assert(explicitEmptyHolders, "an explicit empty-holder snapshot with bench items must be recognized");
assert.equal(explicitEmptyHolders.confirmed_fields.equipped_items, true, "explicitly saying nobody holds items must authoritatively confirm an empty holder assignment");
assert.deepEqual(
  explicitEmptyHolders.item_bench.map((item) => item.name),
  ["反曲之弓", "巨人腰带", "锁子甲", "负极斗篷", "金铲铲"],
  "voice-style attack-speed and spatula aliases must resolve into the current item bench",
);
const explicitEmptyMerged = mergeUserConfirmedEquipment(null, explicitEmptyHolders, {
  matchSessionId: "match-empty-holders",
  stageRound: "2-4",
  observedAt: "2026-07-26T08:56:01.000Z",
});
assert.deepEqual(explicitEmptyMerged.equipped_items, []);
assert.equal(explicitEmptyMerged.confirmed_fields.equipped_items, true);

const choiceRewardDoesNotBecomeEquipment = extractUserConfirmedEquipment(
  "锤石：神秘战利品，然后给了我一个小妮蔻复制器",
  { catalog, allowTerseReport: true },
);
assert.equal(choiceRewardDoesNotBecomeEquipment, null, "a star-god reward name must not pollute equipment facts through the generic 战利品 catalog entry");

const snapshot = extractUserConfirmedEquipment(
  "我现在有反曲之弓、拳套和巨人腰带，贾克斯有泰坦的坚决和汲取剑。",
  { catalog },
);
assert(snapshot, "explicit equipment report must be recognized");
assert.equal(snapshot.update_kind, "snapshot");
assert.deepEqual(snapshot.item_bench.map((item) => item.name), ["反曲之弓", "拳套", "巨人腰带"]);
assert.deepEqual(
  snapshot.equipped_items.map((item) => [item.owner_unit, item.name]),
  [["贾克斯", "泰坦的坚决"], ["贾克斯", "汲取剑"]],
);

const first = mergeUserConfirmedEquipment(null, snapshot, {
  matchSessionId: "match-a",
  stageRound: "2-5",
  observedAt: "2026-07-23T10:00:00.000Z",
});
const delta = extractUserConfirmedEquipment("我又拿了一个锁子甲。", { catalog });
assert(delta, "incremental equipment report must be recognized");
assert.equal(delta.update_kind, "delta");
const merged = mergeUserConfirmedEquipment(first, delta, {
  matchSessionId: "match-a",
  stageRound: "2-6",
  observedAt: "2026-07-23T10:01:00.000Z",
});
assert(merged.item_bench.some((item) => item.name === "锁子甲"), "delta report must extend the current user-confirmed inventory");
assert.equal(merged.match_session_id, "match-a");
const benchOnlySnapshot = extractUserConfirmedEquipment("我现在有反曲之弓和拳套。", { catalog });
const benchOnlyMerged = mergeUserConfirmedEquipment(merged, benchOnlySnapshot, {
  matchSessionId: "match-a",
  stageRound: "3-1",
  observedAt: "2026-07-23T10:02:00.000Z",
});
assert.deepEqual(
  benchOnlyMerged.equipped_items.map((item) => [item.owner_unit, item.name]),
  [["贾克斯", "泰坦的坚决"], ["贾克斯", "汲取剑"]],
  "a bench-only snapshot must not erase previously confirmed holder assignments",
);
assert.throws(
  () => mergeUserConfirmedEquipment(first, delta, { matchSessionId: "match-b", stageRound: "2-6" }),
  /match_session_id/i,
  "equipment facts must never cross match sessions",
);

const structured = {
  item_bench_from_4357: [{ name: "暴风之剑", source: "mumu_4357_item_bench" }],
  trusted_equipped_items_from_4356_assignment: [{ name: "无尽之刃", owner_unit: "阿卡丽", source: "mumu_4356_equipped" }],
  item_bench_candidates_fallback_only: [{ name: "无用大棒", confidence: 0.91 }],
};
const structuredFirst = resolveEquipmentFactLayers({
  structuredEquipment: structured,
  userConfirmedEquipment: merged,
  activeMatchSessionId: "match-a",
});
assert.equal(structuredFirst.effective_item_bench[0].name, "暴风之剑");
assert.equal(structuredFirst.effective_equipped_items[0].name, "无尽之刃");
assert.equal(structuredFirst.effective_source_by_field.item_bench, "mumu_4357");
assert.equal(structuredFirst.effective_source_by_field.equipped_items, "trusted_mumu_4356_assignment");

const userSecond = resolveEquipmentFactLayers({
  structuredEquipment: {
    item_bench_from_4357: [],
    trusted_equipped_items_from_4356_assignment: [],
    item_bench_candidates_fallback_only: [{ name: "无用大棒", confidence: 0.91 }],
  },
  userConfirmedEquipment: merged,
  activeMatchSessionId: "match-a",
});
assert(userSecond.effective_item_bench.some((item) => item.name === "反曲之弓"));
assert.equal(userSecond.effective_source_by_field.item_bench, "user_confirmed");
assert.equal(userSecond.visual_candidates_are_authoritative, false);

const staleUserConfirmation = resolveEquipmentFactLayers({
  structuredEquipment: {
    item_bench_from_4357: [],
    trusted_equipped_items_from_4356_assignment: [],
    item_bench_candidates_fallback_only: [{ name: "visual-only-candidate", confidence: 0.91 }],
  },
  userConfirmedEquipment: merged,
  activeMatchSessionId: "match-b",
});
assert.equal(staleUserConfirmation.has_current_match_user_confirmation, false);
assert.deepEqual(staleUserConfirmation.effective_item_bench, []);
assert.deepEqual(staleUserConfirmation.effective_equipped_items, []);
assert.deepEqual(staleUserConfirmation.effective_source_by_field, {
  item_bench: "unavailable",
  equipped_items: "unavailable",
});
assert.equal(staleUserConfirmation.user_confirmation_rejection_reason, "match_session_id_mismatch");

const unscopedUserConfirmation = resolveEquipmentFactLayers({
  structuredEquipment: {
    item_bench_from_4357: [],
    trusted_equipped_items_from_4356_assignment: [],
  },
  userConfirmedEquipment: {
    ...merged,
    match_session_id: null,
  },
  activeMatchSessionId: "match-a",
});
assert.equal(unscopedUserConfirmation.has_current_match_user_confirmation, false);
assert.equal(unscopedUserConfirmation.user_confirmation_rejection_reason, "missing_match_session_id");

const partialStructured = resolveEquipmentFactLayers({
  structuredEquipment: {
    item_bench_from_4357: [{ name: "反曲之弓", source: "mumu_4357_item_bench" }],
    trusted_equipped_items_from_4356_assignment: [],
    item_bench_candidates_fallback_only: [],
    structured_source_health: {
      item_bench_4357: { seen: true, current_payload_nonempty: true },
      equipped_items_4356: { seen: false, current_payload_nonempty: null },
    },
  },
  userConfirmedEquipment: null,
});
assert.deepEqual(partialStructured.missing_reliable_fields, ["equipped_items"]);
assert.equal(partialStructured.reliable_field_coverage.item_bench, true);
assert.equal(partialStructured.reliable_field_coverage.equipped_items, false);

const partialUserConfirmed = resolveEquipmentFactLayers({
  structuredEquipment: {
    item_bench_from_4357: [],
    trusted_equipped_items_from_4356_assignment: [],
    item_bench_candidates_fallback_only: [{ name: "无用大棒", confidence: 0.91 }],
  },
  userConfirmedEquipment: mergeUserConfirmedEquipment(null, benchOnlySnapshot, {
    matchSessionId: "match-a",
    stageRound: "3-1",
    observedAt: "2026-07-23T10:02:00.000Z",
  }),
  activeMatchSessionId: "match-a",
});
assert.deepEqual(partialUserConfirmed.missing_reliable_fields, ["equipped_items"]);
assert.equal(partialUserConfirmed.effective_source_by_field.item_bench, "user_confirmed");

const authoritativeEmptyStructured = resolveEquipmentFactLayers({
  structuredEquipment: {
    item_bench_from_4357: [],
    trusted_equipped_items_from_4356_assignment: [],
    item_bench_candidates_fallback_only: [],
    structured_source_health: {
      item_bench_4357: { seen: true, current_payload_observed: true, current_payload_nonempty: false },
      equipped_items_4356: { seen: false, current_payload_nonempty: null },
    },
  },
  userConfirmedEquipment: merged,
  activeMatchSessionId: "match-a",
});
assert.deepEqual(
  authoritativeEmptyStructured.effective_item_bench,
  [],
  "a current authoritative 4357 empty payload must clear stale user-confirmed bench items",
);
assert.equal(authoritativeEmptyStructured.effective_source_by_field.item_bench, "mumu_4357_authoritative_empty");

const historicalStructuredSeenOnly = resolveEquipmentFactLayers({
  structuredEquipment: {
    item_bench_from_4357: [],
    trusted_equipped_items_from_4356_assignment: [],
    item_bench_candidates_fallback_only: [],
    structured_source_health: {
      item_bench_4357: { seen: true, current_payload_observed: false, current_payload_nonempty: false },
      equipped_items_4356: { seen: true, current_payload_observed: false, current_payload_nonempty: null },
    },
  },
  userConfirmedEquipment: merged,
  activeMatchSessionId: "match-a",
});
assert.equal(
  historicalStructuredSeenOnly.effective_source_by_field.item_bench,
  "user_confirmed",
  "historical command presence must not masquerade as a current authoritative empty payload",
);
assert.equal(historicalStructuredSeenOnly.effective_source_by_field.equipped_items, "user_confirmed");

const missingActiveMatchScope = resolveEquipmentFactLayers({
  structuredEquipment: {},
  userConfirmedEquipment: merged,
});
assert.equal(missingActiveMatchScope.has_current_match_user_confirmation, false);
assert.equal(missingActiveMatchScope.user_confirmation_rejection_reason, "missing_active_match_session_id");
assert.deepEqual(missingActiveMatchScope.effective_item_bench, []);

assert.deepEqual(leftItemRailFallbackDecision({
  liveState: { items: { item_bench: [] } },
  force: true,
  userConfirmedEquipmentReady: true,
}), {
  structured_4357_ready: false,
  user_confirmed_equipment_ready: true,
  explicit_request: true,
  should_run: false,
  reason: "user_confirmed_equipment_available",
}, "user-confirmed equipment must satisfy the direct question without waiting for visual candidates");

const basePromptInput = {
  matchActive: true,
  activeMode: "cruise",
  stageRound: "3-1",
  responseTaskInFlight: false,
  choiceWindowReserved: false,
  observingOtherView: false,
  targetContext: { text: "新星特攻队阿卡丽" },
  confirmedChoices: [{ choice: "猛将的荣耀" }],
  equipment: resolveEquipmentFactLayers({
    structuredEquipment: {
      item_bench_from_4357: [],
      trusted_equipped_items_from_4356_assignment: [],
      item_bench_candidates_fallback_only: [],
    },
    userConfirmedEquipment: null,
  }),
  previousPrompts: [],
  nowMs: Date.parse("2026-07-23T10:05:00.000Z"),
  itemDecisionRequired: true,
};
assert.equal(shouldRequestUserEquipmentContext(basePromptInput).should_prompt, true);
assert.equal(shouldRequestUserEquipmentContext({ ...basePromptInput, targetContext: null }).should_prompt, false);
assert.equal(
  shouldRequestUserEquipmentContext({ ...basePromptInput, itemDecisionRequired: false }).should_prompt,
  false,
  "a durable target alone must not create an equipment prompt without a recent material decision",
);
assert.equal(shouldRequestUserEquipmentContext({ ...basePromptInput, responseTaskInFlight: true }).should_prompt, false);
assert.equal(shouldRequestUserEquipmentContext({ ...basePromptInput, choiceWindowReserved: true }).should_prompt, false);
assert.equal(shouldRequestUserEquipmentContext({ ...basePromptInput, observingOtherView: true }).should_prompt, false);
assert.equal(shouldRequestUserEquipmentContext({ ...basePromptInput, equipment: userSecond }).should_prompt, false);
assert.equal(
  shouldRequestUserEquipmentContext({ ...basePromptInput, equipment: partialStructured }).should_prompt,
  true,
  "a structured item bench without holder assignment must still ask only for the missing holder field when the decision depends on it",
);
assert.deepEqual(
  shouldRequestUserEquipmentContext({ ...basePromptInput, equipment: partialStructured }).missing_fields,
  ["equipped_items"],
);
assert.equal(
  shouldRequestUserEquipmentContext({ ...basePromptInput, equipment: partialUserConfirmed }).should_prompt,
  true,
  "a bench-only user confirmation must remain immediately usable while allowing a later material holder-only question",
);
assert.deepEqual(
  shouldRequestUserEquipmentContext({ ...basePromptInput, equipment: partialUserConfirmed }).missing_fields,
  ["equipped_items"],
);
const promptedOnce = shouldRequestUserEquipmentContext({
  ...basePromptInput,
  previousPrompts: [{
    fingerprint: shouldRequestUserEquipmentContext(basePromptInput).fingerprint,
    asked_at: "2026-07-23T10:04:30.000Z",
  }],
});
assert.equal(promptedOnce.should_prompt, false, "same material context must not repeatedly prompt");
const unresolvedPromptAtEarlierStage = shouldRequestUserEquipmentContext({
  ...basePromptInput,
  stageRound: "4-1",
  previousPrompts: [{
    fingerprint: "different-stage-fingerprint",
    asked_at: "2026-07-23T09:00:00.000Z",
    answered_at: null,
  }],
});
assert.equal(unresolvedPromptAtEarlierStage.should_prompt, false, "an unanswered equipment prompt must suppress later-stage repeats");

const contextNowMs = Date.parse("2026-07-23T10:05:00.000Z");
assert.equal(resolveMaterialEquipmentDecisionContext({
  targetContext: { name: "新星特攻队阿卡丽", direction_changed_at: "2026-07-23T10:04:00.000Z" },
  nowMs: contextNowMs,
}).required, true, "a recent target direction change is a material equipment context");
assert.equal(resolveMaterialEquipmentDecisionContext({
  targetContext: { name: "新星特攻队阿卡丽", direction_changed_at: "2026-07-23T09:30:00.000Z" },
  nowMs: contextNowMs,
}).required, false, "an old durable target must not keep reopening equipment prompts");
assert.equal(resolveMaterialEquipmentDecisionContext({
  targetContext: { name: "新星特攻队阿卡丽", updated_at: "2026-07-23T10:04:30.000Z" },
  nowMs: contextNowMs,
}).required, false, "a generic match-context update must not masquerade as a target-direction change");
assert.equal(resolveMaterialEquipmentDecisionContext({
  targetContext: { name: "新星特攻队阿卡丽" },
  latestChoice: { confirmed_at: "2026-07-23T10:04:30.000Z" },
  nowMs: contextNowMs,
}).required, true, "a recent confirmed choice may materially change item fit for the target");
assert.equal(resolveMaterialEquipmentDecisionContext({
  explicitItemDecisionRequired: true,
  nowMs: contextNowMs,
}).required, true, "a registered item decision event is material without relying on target recency");

const scoreFromUserConfirmedEquipment = scoreLiveState({
  match_session_id: "match-a",
  phase: { stage_round: "3-1", status: 1 },
  economy: { hp: 30, gold: 30, level: 6, xp: "0/36" },
  board: { board_units: [{ id: "carry", name: "阿卡丽", star: 2 }] },
  items: { item_bench: [], equipped_items: [] },
}, {
  target_plan: { name: "新星特攻队阿卡丽", unit_ids: ["carry"] },
  equipment_context: userSecond,
  minimum_value_score_to_speak: 0.5,
});
const userEquipmentTask = scoreFromUserConfirmedEquipment.advice_tasks
  .find((task) => task.trigger_id === "item_slam_or_greed");
assert(userEquipmentTask, "proactive scorer must consume effective user-confirmed equipment when structured items are absent");
assert(userEquipmentTask.actions.includes("slam_now"), "low-HP equipment posture must expose a standardized slam_now candidate action");

const scoreFromVisualCandidatesOnly = scoreLiveState({
  match_session_id: "match-a",
  phase: { stage_round: "3-1", status: 1 },
  economy: { hp: 30, gold: 30, level: 6, xp: "0/36" },
  board: { board_units: [{ id: "carry", name: "阿卡丽", star: 2 }] },
  items: { item_bench: [], equipped_items: [] },
}, {
  target_plan: { name: "新星特攻队阿卡丽", unit_ids: ["carry"] },
  equipment_context: resolveEquipmentFactLayers({
    structuredEquipment: {
      item_bench_from_4357: [],
      trusted_equipped_items_from_4356_assignment: [],
      item_bench_candidates_fallback_only: [{ name: "反曲之弓" }, { name: "拳套" }],
    },
  }),
  minimum_value_score_to_speak: 0.5,
});
assert.equal(
  scoreFromVisualCandidatesOnly.advice_tasks.some((task) => task.trigger_id === "item_slam_or_greed"),
  false,
  "visual candidates alone must not open the proactive equipment answer lane",
);

const scoreFromStaleRawUserEquipment = scoreLiveState({
  match_session_id: "match-current",
  phase: { stage_round: "3-1", status: 1 },
  economy: { hp: 30, gold: 30, level: 6, xp: "0/36" },
  board: { board_units: [{ id: "carry", name: "Current Carry", star: 2 }] },
  items: { item_bench: [], equipped_items: [] },
}, {
  target_plan: { name: "Current Line", unit_ids: ["carry"] },
  match_context: {
    user_confirmed_equipment: {
      match_session_id: "match-old",
      item_bench: [{ name: "Stale Sword" }],
      equipped_items: [{ name: "Stale Armor", owner_unit: "Old Holder" }],
    },
  },
  minimum_value_score_to_speak: 0.5,
});
assert.equal(
  scoreFromStaleRawUserEquipment.advice_tasks.some((task) => task.trigger_id === "item_slam_or_greed"),
  false,
  "direct scorer use must reject raw user equipment from another match",
);
assert.equal(scoreFromStaleRawUserEquipment.live_state_summary.item_bench, 0);
const staleRawCollected = collectLiveState({
  match_session_id: "match-current",
  items: { item_bench: [], equipped_items: [] },
}, {
  match_context: {
    user_confirmed_equipment: {
      match_session_id: "match-old",
      item_bench: [{ name: "Stale Sword" }],
      equipped_items: [{ name: "Stale Armor", owner_unit: "Old Holder" }],
    },
  },
});
assert.deepEqual(staleRawCollected.itemBench, []);
assert.deepEqual(staleRawCollected.equippedItems, []);

const runtimeSource = readFileSync(path.join(repoRoot, "ui/electron/runtime-service.js"), "utf8");
const appSource = readFileSync(path.join(repoRoot, "ui/src/App.tsx"), "utf8");
const uiModeContract = JSON.parse(readFileSync(
  path.join(repoRoot, "data/runtime/jcc/runtime-ui-mode-contract.json"),
  "utf8",
).replace(/^\uFEFF/, ""));
const sensingMap = JSON.parse(readFileSync(
  path.join(repoRoot, "data/runtime/jcc/runtime-mode-sensing-map.json"),
  "utf8",
).replace(/^\uFEFF/, ""));
const itemizationContract = JSON.parse(readFileSync(
  path.join(repoRoot, "data/runtime/jcc/itemization-decision-contract.json"),
  "utf8",
).replace(/^\uFEFF/, ""));
assert(runtimeSource.includes("user_confirmed_equipment"), "runtime host and match facts must include user-confirmed equipment");
assert(!runtimeSource.includes("maybePromptForMissingEquipmentContext"), "automatic cruise must not contain a missing-equipment prompt lane");
assert(runtimeSource.includes("structured_equipment_advice"), "explicit structured equipment advice must remain a supported action");
assert(
  runtimeSource.includes("!recordedUserMessageContext?.user_confirmed_equipment_update"),
  "a user equipment report must not start the visual icon fallback",
);
assert(
  runtimeSource.includes("userConfirmedEquipmentReady: userEquipmentResolution.has_current_match_user_confirmation === true"),
  "manual self-state refresh must also skip icon matching after current-match user confirmation",
);
const proactiveDecisionLoopIndex = runtimeSource.lastIndexOf("for (const event of adviceEligibleEvents)");
assert(proactiveDecisionLoopIndex >= 0, "the observe loop must still admit explicit structured actions");
assert(!appSource.includes("status === \"equipment_context_confirmation_prompt\""), "UI must not render a dead automatic equipment prompt lane");
assert(!appSource.includes('label: "更新装备"'), "the product must not add a redundant permanent equipment preset");
assert.deepEqual(
  uiModeContract.cruise_mode_policy.interrupt_policy.equipment_context_confirmation_policy.source_precedence,
  ["mumu_4357_and_trusted_4356", "current_match_user_confirmation", "explicit_visual_or_icon_candidate_fallback"],
);
assert.equal(
  uiModeContract.cruise_mode_policy.interrupt_policy.equipment_context_confirmation_policy.response_policy,
  "status_prompt_only_no_host_answer_lane",
);
assert.equal(
  uiModeContract.cruise_mode_policy.interrupt_policy.equipment_context_confirmation_policy.field_policy.never_wait_for_structured_source,
  true,
);
assert.equal(
  uiModeContract.cruise_mode_policy.interrupt_policy.equipment_context_confirmation_policy.field_policy.never_wait_for_visual_candidate,
  true,
);
assert.match(
  uiModeContract.cruise_mode_policy.interrupt_policy.equipment_context_confirmation_policy.user_reply_answer_owner,
  /one direct Host answer/i,
);
assert.match(
  uiModeContract.cruise_mode_policy.interrupt_policy.equipment_context_confirmation_policy.ui_policy,
  /shared structured editor/i,
);
assert.match(
  uiModeContract.cruise_mode_policy.interrupt_policy.equipment_context_confirmation_policy.ui_policy,
  /narrow equipment-choice\/forge card/i,
);
assert.match(
  uiModeContract.cruise_mode_policy.interrupt_policy.equipment_context_confirmation_policy.ui_policy,
  /not a permanent free-form equipment-report mode/i,
);
assert.deepEqual(
  sensingMap.global_policies.owned_equipment_fact_precedence,
  [
    "trusted_mumu_4357_item_bench_and_4356_to_4353_assignment",
    "current_match_explicit_user_confirmation",
    "explicit_visual_or_icon_candidate_fallback",
  ],
);
assert.deepEqual(
  itemizationContract.source_precedence.slice(0, 3),
  [
    "trusted_mumu_4357_item_bench_and_4356_to_4353_assignment",
    "current_match_explicit_user_confirmation",
    "explicit_visual_or_icon_candidate_fallback",
  ],
);
assert.equal(itemizationContract.information_resolution_policy.never_wait_for_structured_source, true);
assert.equal(itemizationContract.information_resolution_policy.never_wait_for_visual_candidate, true);
assert.match(
  sensingMap.global_policies.structured_item_freshness_policy,
  /Historical 4356\/4357 command presence is source-health evidence only/i,
);
assert.equal(
  itemizationContract.information_resolution_policy.historical_command_presence_is_not_current_field_authority,
  true,
);
assert.equal(
  itemizationContract.information_resolution_policy.authoritative_empty_requires_current_payload_observed,
  true,
);

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-user-confirmed-equipment-context-verification-v1",
  checked: [
    "catalog-backed explicit equipment parsing",
    "terse item-list reply only after a contextual prompt",
    "theoretical item questions remain questions",
    "snapshot and delta merge with match isolation",
    "structured then user-confirmed then visual source priority",
    "contextual no-spam equipment prompt gate",
    "recent material equipment-decision context gate",
    "runtime answer-lane and matcher isolation",
    "direct scorer stale-match isolation",
    "resolver fail-closed active-match scope",
    "machine-contract source precedence",
    "current payload freshness boundary",
    "shared equipment editor with a narrow forge-choice mode",
  ],
}, null, 2));
