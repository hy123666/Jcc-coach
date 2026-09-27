import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const serviceUrl = `${pathToFileURL(path.join(root, "ui/electron/runtime-service.js")).href}?lineup-contract-${Date.now()}`;
const service = await import(serviceUrl);

function coachResponse(hostRequest, response) {
  return {
    schema: "jcc-host-cli-coach-response-v1",
    generated_by: "current_cli_agent_main_model",
    request_id: hostRequest.request_id,
    request_hash: hostRequest.request_hash,
    mode: hostRequest.mode,
    ...response,
  };
}

const rankingCandidateId = "jax-ranking-line";
const rankingVariantId = "jax-ranking-v1";
const rankingLineupNames = ["贾克斯", "潘森", "阿卡丽", "菲奥娜", "千珏", "慎", "奥恩"];
const rankingCoordinates = rankingLineupNames.map((name, index) => ({
  row: index < 2 ? 1 : index < 5 ? 2 : 4,
  col: index < 2 ? index + 2 : index < 5 ? index - 1 : index - 3,
  name,
}));

function lineupHandoff(targetIdentity = "推荐贾克斯阵容") {
  return {
    candidate_id: rankingCandidateId,
    variant_id: rankingVariantId,
    target_source: "ranking",
    target_identity: targetIdentity,
    adjustments: ["根据当前局面调整装备持有者"],
    equipment_priority: ["贾克斯优先泰坦的坚决"],
    positioning_intent: "前排承伤，贾克斯放在中后排输出。",
  };
}

const hostRequest = {
  mode: "lineup_card",
  request_id: "verify-lineup-card-response",
  request_hash: "verify-lineup-card-response-hash",
  user_message: "给我一个推荐阵容图，并写清核心装备和站位。先给我当前过渡板。",
  season_catalog: {
    champion_names: ["贾克斯", "潘森", "阿卡丽", "菲奥娜", "千珏", "慎", "奥恩"],
  },
  selected_ranking_candidates: {
    candidates: [{
      candidate_id: rankingCandidateId,
      selected_variant_id: rankingVariantId,
      name: "新星特攻队贾克斯",
      champion_names: rankingLineupNames,
      canonical_variant: {
        variant_id: rankingVariantId,
        population: rankingLineupNames.length,
        lineup_names: rankingLineupNames,
        positioning_template: { coordinates: rankingCoordinates },
        equipment_plan: [{ unit: "贾克斯", items: ["泰坦的坚决", "饮血剑"] }],
        main_carry: "贾克斯",
        main_tank: "慎",
        core_traits: ["幻灵战队4", "挑战者4"],
        formation_burden: "中等：六级追三星后上八",
        cap: "八人口补两星四费",
        floor: "六人口完成前后排两星",
      },
    }],
  },
  runtime_context: {
    game_state_brief: {
      stage_round: "5-2",
      latest_user_intent: { text: "给我一个推荐阵容图，并写清核心装备和站位。" },
    },
    match_facts: {
      choice_confirmations: [{ kind: "augment", stage_round: "2-1", selected: "摘星之志" }],
    },
  },
};

const proseOnly = service.normalizeHostCoachResponse(coachResponse(hostRequest, {
    final_text: "推荐走贾克斯主C。",
    confidence: "medium",
  }), hostRequest);
assert.equal(proseOnly.final_text, "推荐走贾克斯主C。");
assert.equal(proseOnly.pinned_result, null, "missing handoff may skip the card but must preserve readable text");
assert(proseOnly.soft_quality_diagnostics.includes("lineup_card_not_supplied"));

const incompleteLegacyCard = service.normalizeHostCoachResponse(coachResponse(hostRequest, {
    final_text: "推荐走贾克斯主C。",
    confidence: "medium",
    pinned_result: {
      slot: "lineup",
      title: "不完整阵容图",
      units: [
        { row: 1, col: 2, name: "慎" },
        { row: 1, col: 4, name: "奥恩" },
        { row: 4, col: 4, name: "贾克斯" },
      ],
      loadouts: [{ unit: "贾克斯", items: ["泰坦的坚决"] }],
      moves: ["3-2 升 6 找贾克斯。"],
    },
  }), hostRequest);
assert.equal(incompleteLegacyCard.final_text, "推荐走贾克斯主C。");
assert.equal(incompleteLegacyCard.pinned_result, null, "an unpublishable card must degrade independently from final_text");

const transition = service.normalizeHostCoachResponse(coachResponse(hostRequest, {
  final_text: "先给你当前过渡板，后续根据来牌补完整成型。",
  confidence: "medium",
  lineup_handoff: lineupHandoff("当前过渡阵容图"),
  pinned_result: {
    slot: "transition",
    title: "当前过渡阵容图",
    units: [
      { row: 1, col: 2, name: "慎" },
      { row: 1, col: 4, name: "奥恩" },
      { row: 4, col: 4, name: "贾克斯" },
      { row: 4, col: 5, name: "阿卡丽" },
    ],
    loadouts: [{ unit: "贾克斯", items: ["泰坦的坚决"] }],
    moves: ["这是过渡板，空位按后续大数据候选和当前来牌补。"],
  },
}), hostRequest);

assert.equal(transition.pinned_result.units.length, 7);

const structured = service.normalizeHostCoachResponse(coachResponse(hostRequest, {
  final_text: "推荐走贾克斯主C，按摘星之志追三节奏。",
  confidence: "medium",
  lineup_handoff: lineupHandoff("摘星贾克斯推荐阵容"),
  pinned_result: {
    slot: "lineup",
    title: "摘星贾克斯推荐阵容",
    units: [
      { row: 1, col: 2, name: "慎" },
      { row: 1, col: 4, name: "奥恩" },
      { row: 2, col: 3, name: "潘森" },
      { row: 2, col: 5, name: "千珏" },
      { row: 4, col: 3, name: "菲奥娜" },
      { row: 4, col: 4, name: "贾克斯" },
      { row: 4, col: 5, name: "阿卡丽" },
    ],
    loadouts: [
      { unit: "贾克斯", items: ["泰坦的坚决", "泰坦的坚决", "饮血剑"], note: "主C" },
    ],
    moves: ["2费赌狗节奏，3-2 升 6 后找贾克斯2星，稳住后卡50慢D三星。"],
  },
}), hostRequest);

assert.equal(structured.pinned_result.title, "摘星贾克斯推荐阵容");
assert.equal(structured.pinned_result.units.length, 7);
assert.equal(structured.pinned_result.loadouts[0].unit, "贾克斯");
assert(structured.pinned_result.moves[0].includes("当前局面"));

const finalTargetHostRequest = {
  ...hostRequest,
  lineup_card_intent: "final_target",
  selected_ranking_candidates: { candidates: [{
    candidate_id: "complete-final-target",
    selected_variant_id: "complete-final-target-v1",
    canonical_variant: {
      variant_id: "complete-final-target-v1",
      population: structured.pinned_result.units.length,
      lineup_names: structured.pinned_result.units.map((unit) => unit.name),
      positioning_template: { coordinates: rankingCoordinates },
      equipment_plan: [{ unit: "贾克斯", items: ["泰坦的坚决", "饮血剑"] }],
      main_carry: "贾克斯",
      main_tank: "慎",
      core_traits: ["幻灵战队4", "挑战者4"],
      formation_burden: "中等：六级追三星后上八",
      cap: "八人口补两星四费",
      floor: "六人口完成前后排两星",
    },
  }] },
};
const incompleteTarget = service.normalizeHostCoachResponse(coachResponse(finalTargetHostRequest, {
    final_text: "完整目标阵容。",
    pinned_result: structured.pinned_result,
  }), finalTargetHostRequest);
assert.equal(incompleteTarget.final_text, "完整目标阵容。");
assert.equal(incompleteTarget.pinned_result, null, "missing canonical card facts must not reject independent strategy text");

const completeFinalTarget = service.normalizeHostCoachResponse(coachResponse(finalTargetHostRequest, {
  final_text: "完整目标阵容，贾克斯主C并说明成型上下限。",
  lineup_handoff: {
    ...lineupHandoff("完整贾克斯目标"),
    candidate_id: "complete-final-target",
    variant_id: "complete-final-target-v1",
  },
  pinned_result: {
    ...structured.pinned_result,
    candidate_id: "complete-final-target",
    selected_variant_id: "complete-final-target-v1",
    strategy: {
      candidate_id: "complete-final-target",
      selected_variant_id: "complete-final-target-v1",
      main_carry: "贾克斯",
      main_tank: "慎",
      core_traits: "幻灵战队4 + 挑战者4",
      formation_burden: "中等：六级追三星后上八",
      cap: "八人口补两星四费",
      floor: "六人口完成前后排两星",
    },
  },
}), finalTargetHostRequest);
assert.equal(completeFinalTarget.pinned_result.target_identity, "完整贾克斯目标");

const atomicTargetRequest = {
  ...finalTargetHostRequest,
  request_id: "atomic-target-request",
  request_hash: "atomic-target-request",
  user_message: "把已确认的贾克斯阵容放到阵容图里。",
  selected_ranking_candidates: { candidates: [{
    candidate_id: "jax-atomic-line",
    selected_variant_id: "jax-8",
    display_name: "原子贾克斯阵容",
    strategy_profile: {
      canonical_variant: {
        variant_id: "jax-8",
          population: 7,
          lineup_names: ["慎", "奥恩", "潘森", "千珏", "菲奥娜", "贾克斯", "阿卡丽"],
          positioning_template: { coordinates: rankingCoordinates },
          equipment_plan: [{ unit: "贾克斯", items: ["泰坦的坚决", "饮血剑"] }],
          main_carry: "贾克斯",
          main_tank: "慎",
          core_traits: ["幻灵战队4", "挑战者4"],
          formation_burden: "中等：六级追三星后上八",
          cap: "八人口补两星四费",
          floor: "六人口完成前后排两星",
      },
    },
  }] },
};
const atomicTargetValid = service.normalizeHostCoachResponse(coachResponse(atomicTargetRequest, {
  final_text: "完整目标阵容。",
  lineup_handoff: {
    ...lineupHandoff("原子贾克斯阵容"),
    candidate_id: "jax-atomic-line",
    variant_id: "jax-8",
  },
  pinned_result: {
    ...completeFinalTarget.pinned_result,
    candidate_id: "jax-atomic-line",
    selected_variant_id: "jax-8",
  },
}), atomicTargetRequest);
assert.equal(atomicTargetValid.pinned_result.candidate_id, "jax-atomic-line", "candidate_id must bind a final card to one atomic Ranking candidate");
const mixedAtomicCard = service.normalizeHostCoachResponse(coachResponse(atomicTargetRequest, {
    final_text: "完整目标阵容。",
    pinned_result: {
      ...completeFinalTarget.pinned_result,
      candidate_id: "jax-atomic-line",
      selected_variant_id: "jax-8",
      units: completeFinalTarget.pinned_result.units.map((unit) => unit.name === "阿卡丽" ? { ...unit, name: "贾克斯" } : unit),
    },
  }), atomicTargetRequest);
assert.equal(mixedAtomicCard.final_text, "完整目标阵容。");
assert.equal(mixedAtomicCard.pinned_result, null, "a mixed candidate card must be rejected without discarding independent text");
assert(
  mixedAtomicCard.soft_quality_diagnostics.some((diagnostic) => [
    "lineup_card_materialization_failed",
    "lineup_card_not_publishable",
    "provider_pinned_result_ignored",
  ].includes(diagnostic)),
  "a rejected card should retain a local degradation diagnostic without retrying the Provider",
);

const providerBoardVariant = service.normalizeHostCoachResponse(coachResponse(hostRequest, {
  final_text: "按当前上下文生成完整成型站位。",
  confidence: "medium",
  lineup_handoff: lineupHandoff("Provider board variant"),
  pinned_result: {
    slot: "lineup",
    title: "Provider board variant",
    board: {
      units: [
        { row: 1, column: 2, champion: "慎" },
        { row: 1, column: 4, champion: "奥恩" },
        { row: 2, column: 3, champion: "潘森" },
        { row: 2, column: 5, champion: "千珏" },
        { row: 4, column: 3, champion: "菲奥娜" },
        { row: 4, column: 4, champion: "贾克斯" },
        { row: 4, column: 5, champion: "阿卡丽" },
      ],
    },
    core_units: [{ champion: "贾克斯", equipment: ["泰坦的坚决", "汲取剑"] }],
    moves: ["根据对手站位左右换边。"],
  },
}), hostRequest);
assert.equal(providerBoardVariant.pinned_result.units.length, 7, "Runtime materialization must recover the canonical roster from the handoff");

assert.equal(service.messageExplicitlyRequestsLineupCard("请在阵容图卡片里给我最高上限"), true);
assert.equal(service.messageExplicitlyRequestsLineupCard("你确定 6 幻灵战队加 4 挑战者吗？"), false, "trait breakpoint discussion must remain normal strategy chat");
assert.equal(service.messageExplicitlyRequestsLineupCard("这套阵容怎么站位？"), false, "ordinary positioning advice must not be forced into the card renderer");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-lineup-card-response-contract-verifier-v1",
  checked: [
    "lineup_card_prose_only_response_is_delivered_without_card",
    "lineup_card_incomplete_legacy_payload_degrades_card_only",
    "lineup_card_transition_board_can_publish_with_explicit_flexible_slots",
    "lineup_card_structured_publishable_pinned_result_is_accepted",
    "final_target_missing_semantics_degrades_card_only",
    "provider_board_units_variant_is_normalized",
    "explicit_card_intent_is_separate_from_strategy_discussion",
  ],
}, null, 2));
