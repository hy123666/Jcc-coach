import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
process.env.JCC_DISABLE_RESIDENT_AUGMENT_CHOICE_OCR = "1";
process.env.JCC_DISABLE_RESIDENT_ITEM_CHOICE_OCR = "1";
process.env.JCC_DISABLE_RESIDENT_SELF_STATE_ROI_OCR = "1";

const service = await import(`../ui/electron/runtime-service.js?final-lineup-ui=${Date.now()}`);
const lineupContract = await import(`../ui/electron/lineup-card-contract.js?final-lineup-contract=${Date.now()}`);
const runtimeModeContract = JSON.parse(await readFile(new URL("../data/runtime/jcc/runtime-ui-mode-contract.json", import.meta.url), "utf8"));
const runtimeBridgeSource = await readFile(new URL("../ui/src/runtimeBridge.ts", import.meta.url), "utf8");
const appSource = await readFile(new URL("../ui/src/App.tsx", import.meta.url), "utf8");

assert.equal(runtimeModeContract.modes?.lineup_card?.final_confirmation_action?.prompt, "确认最终阵容：");
assert.deepEqual(
  runtimeModeContract.modes?.lineup_card?.final_confirmation_action?.lineup_target_sources,
  ["candidate", "chat_discovery", "user_custom"],
);
assert.match(runtimeBridgeSource, /definition\.final_confirmation_action/);
assert.doesNotMatch(runtimeBridgeSource, /renderer\.final_confirmation_action/);
assert.match(appSource, /activeMode === "cruise" && finalLineupConfirmationLabel/);
assert.match(appSource, /aria-pressed=\{lineupConfirmationRequested\}/);
assert.match(appSource, /toggleFinalLineupConfirmation/);
assert.match(appSource, /requestMetadata\?\.lineupConfirmationRequested\s*\? "lineup"/);

assert.equal(
  service.messageRequestsFinalLineupConfirmation("确认最终阵容：我这把玩三召唤师三地狱火拼多多，把最终阵容放到卡片里。"),
  true,
  "the confirmation preset must be recognized as an explicit final-lineup confirmation",
);
assert.equal(
  service.messageRequestsFinalLineupConfirmation("给我看看这把有哪些阵容方向。"),
  false,
  "ordinary lineup exploration must not become final confirmation",
);

const request = service.buildDirectHostRequest(
  "确认最终阵容：我这把玩三召唤师三地狱火拼多多，把最终阵容放到卡片里。",
  "lineup_card",
  { schema: "test-context-pack" },
  { lineupConfirmationRequested: true },
);
assert.equal(request.mode, "lineup_card");
assert.equal(request.lineup_confirmation_requested, true);
assert.equal(request.lineup_confirmation_source, "ui_toggle");
assert.equal(request.lineup_card_intent, "final_target");
assert.match(request.user_message, /^确认最终阵容：/);
assert(request.expected_response_shape.lineup_handoff, "lineup confirmation must request only a minimal mechanical handoff");
assert.equal(request.expected_response_shape.pinned_result, undefined);
assert.deepEqual(request.lineup_target_sources_supported, ["candidate", "chat_discovery", "user_custom"]);

const customCard = {
  schema: "jcc-internal-lineup-plan-v1",
  slot: "lineup",
  title: "用户自定义最终阵容",
  target_source: "user_custom",
  target_identity: "三召唤师三地狱火三裁决使",
  units: Array.from({ length: 7 }, (_, index) => ({ name: `单位${index + 1}`, row: 1, col: index + 1 })),
  moves: ["按当前确认目标站位"],
  equipment_status: "not_provided_in_evidence",
  strategy: {
    target_source: "user_custom",
    target_identity: "三召唤师三地狱火三裁决使",
    main_carry: "主C",
    main_tank: "主坦",
    core_traits: ["召唤师3", "地狱火3", "裁决使3"],
    formation_burden: "medium",
    cap: "补两星五费并优化站位",
    floor: "保持核心羁绊与主C装备",
  },
};
assert.equal(lineupContract.lineupPinnedResultIsPublishable(customCard, request), true);

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-final-lineup-confirmation-ui-verification-v1",
  checked: [
    "confirmation_preset_is_explicit",
    "mode_contract_is_consumed_from_the_mode_definition",
    "cruise_exposes_a_reversible_confirmation_toggle",
    "sealed_toggle_metadata_routes_to_the_lineup_card_backend",
    "ordinary_exploration_is_not_confirmation",
    "ui_confirmation_routes_to_final_lineup_card",
    "user_text_remains_the_lineup_identity_input",
    "minimal_lineup_handoff_is_requested",
    "custom_final_target_source_is_publishable",
  ],
}, null, 2));
