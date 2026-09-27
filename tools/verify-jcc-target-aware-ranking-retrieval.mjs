import assert from "node:assert/strict";
import {
  compactHostTurnDelta,
  compactSelectedRankingCandidatesForTurn,
  hostContextCapsuleForRequest,
  HOST_TURN_DELTA_MAX_BYTES,
  compactLineupGroups,
  buildRankingQueryEntityCatalog,
  readLiveRankingsSummary,
  readSeasonCatalogSummary,
  rankingDataIdentityFingerprint,
  selectRelevantRankingCandidates,
  rankingCandidateQuality,
  rankingCandidateStrength,
  setRuntimeServiceState,
} from "../ui/electron/runtime-service.js";

setRuntimeServiceState({
  active_mode: "cruise",
  match_session: { status: "active", match_session_id: "verify-space-groove-ranking" },
  match_context: {},
  user_preferences: { rank_tier: "master" },
});

const activeDailyBigData = await readLiveRankingsSummary();
assert.equal(activeDailyBigData.available, true, "active S18 must expose the compatible current Master+ overlay");
assert.deepEqual(Object.keys(activeDailyBigData.tiers || {}), ["0"], "active S18 must expose only the current Master+ ranking tier");
assert.match(String(activeDailyBigData.stat_date || ""), /^\d{8}$/, "active S18 must retain a valid current Master+ stat date");
const currentSeasonCatalog = await readSeasonCatalogSummary();
assert.equal(
  JSON.stringify(currentSeasonCatalog).includes("太空律动"),
  false,
  "active S18 catalog must not be supplemented with an S17 ranking trait",
);
const syntheticSpaceGrooveCandidate = {
  id: "synthetic-space-groove-5",
  display_name: "合成律动5",
  main_traits: ["合成律动5"],
  summary: {
    top4_rate: 0.62,
    top1_rate: 0.18,
    use_rate: 0.04,
    source_interpretation: "national_trait_ranking_primary_strength_evidence",
  },
  quality_packet: {
    schema: "jcc-ranking-quality-packet-v1",
    version: "synthetic-compatible-overlay",
    quality_label: "fixture_only",
  },
  strategy_profile: {
    strength_anchor: {
      anchor_id: "synthetic-space-groove-5",
      metrics: { top4_rate: 0.62, top1_rate: 0.18, use_rate: 0.04 },
    },
    main_carry: { champion_id: "synthetic-nami", champion_name: "娜美" },
    core_units: [
      { champion_id: "synthetic-nami", champion_name: "娜美" },
      { champion_id: "synthetic-lulu", champion_name: "璐璐" },
    ],
    associated_augments: [{ augment_id: "synthetic-augment", augment_name: "合成强化" }],
    recipe_match: { classification: "exact" },
    variants: [{
      variant_id: "synthetic-space-groove-variant",
      lineup_names: ["娜美", "璐璐"],
      main_carry_items: [{ item_id: "synthetic-item", item_name: "合成装备" }],
    }],
  },
};
const dailyBigData = {
  schema: "jcc-live-rankings-host-context-summary-v1",
  available: true,
  ranking_overlay_id: "synthetic-compatible-overlay",
  stat_date: "20990101",
  tiers: {
    "0": {
      label: "master_plus",
      top_lineups: [syntheticSpaceGrooveCandidate],
      lineup_groups: [syntheticSpaceGrooveCandidate],
      reverse_indexes: {},
    },
  },
};
const unavailableSelection = selectRelevantRankingCandidates({
  ...activeDailyBigData,
  available: false,
  ranking_overlay_id: null,
  tiers: {},
}, {
  request_id: "verify-active-s18-ranking-unavailable",
  request_hash: "verify-active-s18-ranking-unavailable",
  mode: "cruise",
  task: { type: "direct_chat" },
  user_message: "查询当前排名",
  user_preferences: { rank_tier: "master" },
  daily_big_data: activeDailyBigData,
  runtime_context: { match_facts: {} },
  context: {},
});
assert.equal(unavailableSelection, null, "a ranking-dependent query must fail closed without a compatible overlay");
const summaryCandidate = syntheticSpaceGrooveCandidate;
const seasonCatalog = {
  traits: [
    { name: "合成卫士", code_id: "fixture-guard", breakpoints: "2|4|6" },
    { name: "合成未来", code_id: "fixture-future", breakpoints: "2|4|6" },
    { name: "合成射手", code_id: "fixture-sniper", breakpoints: "2|4" },
    { name: "合成律动", code_id: "fixture-groove", breakpoints: "1|3|5|7|10" },
    { name: "合成术师", code_id: "fixture-magician", breakpoints: "2|4" },
  ],
};
const syntheticRankingQueryCatalog = buildRankingQueryEntityCatalog(seasonCatalog, null);

function baseRequest(requestId) {
  return {
    request_id: requestId,
    request_hash: requestId,
    mode: "cruise",
    task: { type: "direct_chat" },
    user_preferences: { rank_tier: "master" },
    daily_big_data: dailyBigData,
    season_catalog: seasonCatalog,
    runtime_context: { match_facts: {} },
    context: {},
  };
}

function assertSpaceGrooveSelected(hostRequest, sourceLabel) {
  const selected = selectRelevantRankingCandidates(dailyBigData, hostRequest);
  assert.equal(selected.query_status, "primary_target_matches_found", `${sourceLabel} must produce a primary target ranking match`);
  assert(selected.exact_match_count > 0, `${sourceLabel} must retain at least one exact target match`);
  const candidate = selected.candidates.find((entry) => String(entry.display_name).includes("合成律动5"));
  assert(candidate, `${sourceLabel} must select the synthetic five-trait ranking line`);
  assert.equal(candidate.summary?.source_interpretation, "national_trait_ranking_primary_strength_evidence", `${sourceLabel} must preserve the national Master+ strength authority`);
  assert(Number(candidate.summary?.top4_rate) > 0, `${sourceLabel} must preserve the national Master+ top-four strength metric`);
  assert.equal(candidate.match_type, "primary_target_match");
  assert(candidate.matched_terms.some((term) => term.includes("合成律动")), `${sourceLabel} must expose its matched target term`);
  assert(!selected.query_terms.includes("[objectobject]"), `${sourceLabel} must not stringify structured values into query terms`);
  return { selected, candidate };
}

const directMessageRequest = baseRequest("verify-space-groove-direct-message");
directMessageRequest.user_message = "我这会儿应该是五合成律动的体系了";
const directMessage = assertSpaceGrooveSelected(directMessageRequest, "direct user message only");

const realMultiGroupRequest = baseRequest("verify-current-data-multi-group-query");
realMultiGroupRequest.user_message = "合成卫士配合成未来配合成射手有哪些？另外，五合成律动是配三合成未来还是配合成术师";
realMultiGroupRequest.ranking_query_route_key = "daily:verify-current-data-multi-group-query";
realMultiGroupRequest.ranking_query_catalog = syntheticRankingQueryCatalog;
realMultiGroupRequest.season_catalog = seasonCatalog;
const realMultiGroup = selectRelevantRankingCandidates(dailyBigData, realMultiGroupRequest);
assert.deepEqual(
  realMultiGroup.explicit_group_coverage.map(({ group_id: groupId }) => groupId),
  ["g1", "g2:alt1", "g2:alt2"],
  "current-season natural language must compile the first composition and both explicit alternatives into separate retrieval branches",
);
assert(realMultiGroup.explicit_group_coverage.every(({ status }) => ["exact", "partial_downgrade", "no_match"].includes(status)),
  "every current-season branch must report its own exact, partial, or no-match status");
assert(realMultiGroup.explicit_group_coverage.every(({ source_group_id: sourceGroupId }) => sourceGroupId === "g1" || sourceGroupId === "g2"),
  "expanded alternatives must retain their source query group for Host explanation");

const multiLaneSource = firstStrategyCandidate(dailyBigData?.tiers?.["0"]?.lineup_groups || []);
assert(multiLaneSource, "live ranking summary must expose one strategy candidate for multi-lane retrieval verification");
const multiLaneRequest = baseRequest("verify-multi-lane-no-target");
const laneCarry = multiLaneSource.strategy_profile.main_carry;
const laneAugment = multiLaneSource.strategy_profile.associated_augments?.[0];
const laneItem = multiLaneSource.strategy_profile.variants?.[0]?.main_carry_items?.[0];
multiLaneRequest.runtime_context.match_facts.choice_confirmations = laneAugment ? [{
  stage_round: "2-1",
  kind: "augment_choice",
  selected: laneAugment.augment_name || laneAugment.augment_id,
}] : [];
multiLaneRequest.runtime_context.cruise_decision_context = {
  current_board_shop_bench: {
    board_units: [{ name: laneCarry.champion_name, id: laneCarry.champion_id }],
  },
  equipment: {
    effective_item_bench: laneItem ? [{ name: laneItem.item_name, id: laneItem.item_id }] : [],
    effective_equipped_items: [],
  },
};
const multiLaneSelected = selectRelevantRankingCandidates(dailyBigData, multiLaneRequest);
assert.equal(multiLaneSelected.schema, "jcc-decision-evidence-packet-v1");
assert.equal(multiLaneSelected.retrieval_lanes.meta.active, true);
assert.equal(multiLaneSelected.retrieval_lanes.board.active, true);
if (laneAugment) assert.equal(multiLaneSelected.retrieval_lanes.augment.active, true);
if (laneItem) assert.equal(multiLaneSelected.retrieval_lanes.equipment.active, true);
const multiLaneCandidate = multiLaneSelected.candidates.find((candidate) => candidate.id === multiLaneSource.id);
assert(multiLaneCandidate, "board/equipment/augment lanes must recall their shared lineup without a declared target");
assert(multiLaneCandidate.retrieval_evidence?.matched_lanes?.includes("board"), "board evidence lane must remain auditable");
assert.equal(multiLaneCandidate.retrieval_evidence?.fusion, "unweighted_coverage_union", "retrieval lanes must provide coverage only and must not introduce a second business-weight layer");
assert.equal(multiLaneCandidate.retrieval_evidence?.rrf_score, undefined, "weighted RRF scores must not survive after the registered stage weights become the only business ranking layer");
assert(multiLaneSelected.candidates.some((candidate) => candidate.strategy_profile?.strength_anchor), "the recall set must always retain at least one national Master+ strength candidate");
assert.equal(multiLaneSelected.candidates.length, dailyBigData.tiers["0"].lineup_groups.length, "unconstrained retrieval must preserve the complete lightweight Master+ candidate pool before stage-weighted ranking");

const nonAugmentChoiceRequest = baseRequest("verify-non-augment-choice-isolation");
nonAugmentChoiceRequest.runtime_context.match_facts.choice_confirmations = [{
  stage_round: "2-4",
  kind: "god",
  selected: laneAugment?.augment_name || "星神奖励",
}];
nonAugmentChoiceRequest.context.live_state_summary = {
  phase: { stage_round: "2-4" },
  economy: { hp: 90, gold: 30, level: 5, xp: 2 },
};
const nonAugmentChoiceSelected = selectRelevantRankingCandidates(dailyBigData, nonAugmentChoiceRequest);
assert.equal(nonAugmentChoiceSelected.retrieval_lanes.augment.active, false, "season and item choices must not activate the augment retrieval lane");
assert.equal(nonAugmentChoiceSelected.query_terms.includes(String(laneAugment?.augment_name || "星神奖励").replace(/\s+/g, "").toLowerCase()), false, "non-augment choice text must not leak into generic ranking query terms");
assert.equal(nonAugmentChoiceSelected.retrieval_lanes.tempo.active, true, "a coherent stage/economy snapshot must activate soft tempo ranking");

const collisionData = {
  schema: "jcc-live-rankings-host-context-summary-v1",
  available: true,
  stat_date: "20260816",
  tiers: {
    0: {
      label: "master_plus",
      top_lineups: [
        { id: "augment-lineup", display_name: "强化命中阵容", summary: { use_num: 500, top4_rate: 0.6, top1_rate: 0.2 } },
        { id: "item-lineup", display_name: "装备同名阵容", summary: { use_num: 500, top4_rate: 0.6, top1_rate: 0.2 } },
      ],
      lineup_groups: [],
      reverse_indexes: {
        augment: {
          lineups_by_entity_id: { augment_same_name: ["augment-lineup"] },
          names_by_entity_id: { augment_same_name: "同名信号" },
        },
        item: {
          lineups_by_entity_id: { item_same_name: ["item-lineup"] },
          names_by_entity_id: { item_same_name: "同名信号" },
        },
      },
    },
  },
};
const collisionRequest = baseRequest("verify-typed-reverse-index-isolation");
collisionRequest.daily_big_data = collisionData;
collisionRequest.runtime_context.match_facts.choice_confirmations = [{
  stage_round: "2-1",
  kind: "augment_choice",
  selected: "同名信号",
}];
const collisionSelected = selectRelevantRankingCandidates(collisionData, collisionRequest);
const augmentCollisionCandidate = collisionSelected.candidates.find((candidate) => candidate.id === "augment-lineup");
const itemCollisionCandidate = collisionSelected.candidates.find((candidate) => candidate.id === "item-lineup");
assert(augmentCollisionCandidate?.retrieval_evidence?.matched_lanes?.includes("augment"), "augment lane must query the augment reverse index");
assert(!itemCollisionCandidate?.retrieval_evidence?.matched_lanes?.includes("augment"), "augment lane must not cross-match an item reverse index with the same display name");
assert(augmentCollisionCandidate.retrieval_lane_scores?.augment?.reverse_index_hits?.every((hit) => hit.kind === "augment"), "augment audit hits must remain type-pure");

const roleAwareData = {
  schema: "jcc-live-rankings-host-context-summary-v1",
  available: true,
  stat_date: "20260816",
  tiers: {
    0: {
      label: "master_plus",
      top_lineups: [
        {
          id: "nami-carry",
          display_name: "合成律动5",
          match_type: "stale_offline_value_must_not_override_current_query",
          summary: { use_num: 20000, top4_rate: 0.52, top1_rate: 0.13, source_interpretation: "national_trait_ranking_primary_strength_evidence" },
          strategy_profile: {
            strength_anchor: { anchor_id: "space-5", metrics: { use_num: 20000, top4_rate: 0.52, top1_rate: 0.13 } },
            main_carry: { champion_id: "nami", champion_name: "娜美" },
            core_units: [{ champion_id: "nami", champion_name: "娜美" }],
            recipe_match: { classification: "exact" },
          },
        },
        {
          id: "nami-member",
          display_name: "合成术师4",
          summary: { use_num: 3000, top4_rate: 0.71, top1_rate: 0.19, source_interpretation: "winning_lineup_recipe_metrics_without_national_strength_anchor" },
          strategy_profile: {
            main_carry: { champion_id: "lulu", champion_name: "璐璐" },
            core_units: [{ champion_id: "nami", champion_name: "娜美" }, { champion_id: "lulu", champion_name: "璐璐" }],
            recipe_match: { classification: "analogous" },
          },
        },
      ],
      lineup_groups: [],
      reverse_indexes: {},
    },
  },
};
const roleAwareRequest = baseRequest("verify-main-carry-role-intent");
roleAwareRequest.daily_big_data = roleAwareData;
roleAwareRequest.season_catalog = {
  champion_names: ["娜美", "璐璐"],
  champions_by_cost: { 3: [{ name: "璐璐", ranking_ids: ["lulu"] }], 4: [{ name: "娜美", ranking_ids: ["nami"] }] },
  traits: [],
};
roleAwareRequest.user_message = "我想奔着娜美走，玩哪套最好";
const roleAwareSelected = selectRelevantRankingCandidates(roleAwareData, roleAwareRequest);
assert.equal(roleAwareSelected.target_role_intent, "main_carry");
assert.equal(roleAwareSelected.candidates[0].id, "nami-carry", "an exact Nami carry line must outrank a stronger-stat lineup that merely contains Nami");
assert.equal(roleAwareSelected.candidates[0].target_match_role, "main_carry");
assert.equal(roleAwareSelected.candidates[0].match_type, "primary_target_match", "current-query role classification must overwrite any stale derived value stored in the offline candidate");
assert.equal(roleAwareSelected.candidates.some((candidate) => candidate.id === "nami-member"), false, "a member-only lineup must not enter an explicit main-carry target's eligible scoring pool");
const multiChampionRoleRequest = structuredClone(roleAwareRequest);
multiChampionRoleRequest.request_id = "verify-main-carry-role-binding";
multiChampionRoleRequest.request_hash = multiChampionRoleRequest.request_id;
multiChampionRoleRequest.user_message = "围绕娜美主C，璐璐只是挂件，玩哪套？";
const multiChampionRoleSelected = selectRelevantRankingCandidates(roleAwareData, multiChampionRoleRequest);
assert.deepEqual(multiChampionRoleSelected.target_role_terms.sort(), ["nami", "娜美"].sort(), "main-carry role terms must bind only to Nami and exclude the explicitly declared support member");
assert.equal(multiChampionRoleSelected.candidates[0].id, "nami-carry", "a support mention must not promote its carry lineup above the declared Nami carry target");
for (const [text, expectedTerms] of [
  ["娜美副C，璐璐主C", ["lulu", "璐璐"]],
  ["娜美不是主C，璐璐才是主C", ["lulu", "璐璐"]],
  ["不要娜美主C，璐璐主C", ["lulu", "璐璐"]],
  ["我不玩娜美主C，璐璐主C", ["lulu", "璐璐"]],
  ["娜美不适合主C，璐璐主C", ["lulu", "璐璐"]],
  ["娜美和璐璐谁更适合主C？", ["lulu", "nami", "娜美", "璐璐"]],
  ["娜美还是璐璐当主C？", ["lulu", "nami", "娜美", "璐璐"]],
]) {
  const request = structuredClone(roleAwareRequest);
  request.request_id = `verify-role-${text}`;
  request.request_hash = request.request_id;
  request.user_message = text;
  const selected = selectRelevantRankingCandidates(roleAwareData, request);
  assert.deepEqual(selected.target_role_terms.sort(), expectedTerms.sort(), `role binding mismatch for: ${text}`);
}

const recipeOnly = compactLineupGroups([{
  lineup_group_id: "recipe-only",
  metrics: { use_num: 1000, top1_rate: 0.45, top4_rate: 0.9, avg_rank: 1.8 },
  recipe_match: { classification: "exact" },
  recipe_evidence: { metrics: { use_num: 1000, top1_rate: 0.45, top4_rate: 0.9, avg_rank: 1.8 } },
  variants: [{
    population: 8,
    metrics: { use_num: 800, top1_rate: 0.5, top4_rate: 0.92, avg_rank: 1.7 },
    lineup_ids: ["recipe-unit"],
    transitions: [{
      population: 6,
      lineup_ids: ["recipe-transition-unit"],
      observed_win_rate: 0.77,
      observed_use_rate: 0.44,
    }],
  }],
  main_trait_list: [{ trait_id: "recipe-trait", display_name: "配方羁绊" }],
}], {}, null, { tier: "master_plus" });
assert.equal(recipeOnly[0].summary.top1_rate, null, "winning-lineup metrics without a national anchor must not become a top-one strength metric");
assert.equal(recipeOnly[0].summary.top4_rate, null, "winning-lineup metrics without a national anchor must not become a top-four strength metric");
assert.equal(recipeOnly[0].summary.use_num, null, "winning-lineup sample size must not be labeled as a national sample count");
assert.equal(recipeOnly[0].strategy_profile.recipe_evidence, undefined, "all-tier winning-lineup metrics must not enter the Host-visible strategy profile");
assert.equal(recipeOnly[0].strategy_profile.variants[0].metrics, undefined, "strategy recipe variants must not duplicate recipe metrics outside recipe_evidence");
assert.equal(recipeOnly[0].strategy_profile.variants[0].recipe_metrics, undefined, "all-tier winning-lineup metrics must remain offline and never enter a Host-visible variant");
assert.equal(recipeOnly[0].strategy_profile.variants[0].recipe_quality, undefined, "winning-lineup quality scores must remain offline and never enter a Host-visible variant");
assert.equal(recipeOnly[0].strategy_profile.variants[0].transition_chain.length, 1, "the recipe-only fixture must exercise one published transition");
assert.equal(recipeOnly[0].strategy_profile.variants[0].transition_chain[0].observed_win_rate, undefined, "winning-lineup transition win rates must remain offline");
assert.equal(recipeOnly[0].strategy_profile.variants[0].transition_chain[0].observed_use_rate, undefined, "winning-lineup transition appearance rates must remain offline");
const directTransitionBoundary = compactSelectedRankingCandidatesForTurn({
  candidates: [{
    id: "direct-transition-boundary",
    display_name: "DirectTransitionBoundary",
    strategy_profile: {
      lifecycle_prior: { target_population: 8 },
      variants: [{
        variant_id: "direct-transition-variant",
        population: 8,
        lineup_names: ["主阵容棋子"],
        transition_chain: [{
          population: 6,
          lineup_names: ["过渡棋子"],
          observed_win_rate: 0.77,
          observed_use_rate: 0.44,
        }],
      }],
    },
  }],
}, { includeLineupIds: true, maxCandidates: 1 });
const directTransition = directTransitionBoundary.candidates[0].strategy_profile.canonical_variant.transition_chain[0];
assert.equal(directTransition.observed_win_rate, undefined, "the final Host compaction boundary must strip a directly injected transition win rate");
assert.equal(directTransition.observed_use_rate, undefined, "the final Host compaction boundary must strip a directly injected transition appearance rate");
assert.equal(recipeOnly[0].variants[0].top1_rate, undefined, "top-level recipe variants must not expose recipe metrics as lineup-strength fields");
assert.equal(rankingCandidateStrength({
  summary: { top4_rate: 0.99, source_interpretation: "national_trait_ranking_primary_strength_evidence" },
}), 0, "a descriptive source string without a structured national strength anchor must never create meta strength");
assert.equal(rankingCandidateStrength({
  strategy_profile: { strength_anchor: { metrics: { top4_rate: 0.99, top1_rate: 0.88, use_rate: 0.77 } } },
}), 0, "missing compiled current-day score must not be reconstructed from raw metrics");
assert.equal(rankingCandidateStrength({
  strategy_profile: { strength_anchor: { quality: { current_day_score: 0.61 }, metrics: { use_rate: 0.001 } } },
}), rankingCandidateStrength({
  strategy_profile: { strength_anchor: { quality: { current_day_score: 0.61 }, metrics: { use_rate: 0.99 } } },
}), "appearance-only changes must not change Runtime strength");
const collisionDataReplacement = structuredClone(collisionData);
collisionData.generated_at = "same-cache-time";
collisionDataReplacement.generated_at = "same-cache-time";
collisionDataReplacement.battle_type = "replacement-battle-type";
collisionDataReplacement.tiers[0].top_lineups[0].id = "replacement-lineup";
assert.notEqual(
  rankingDataIdentityFingerprint(collisionDataReplacement),
  rankingDataIdentityFingerprint(collisionData),
  "ranking cache identity must change when promoted content changes under the same generated_at timestamp",
);

const provisionalIntentRequest = baseRequest("verify-space-groove-provisional-intent");
provisionalIntentRequest.runtime_context.match_facts.latest_target_intent = {
  text: "当前方向收敛到五合成律动",
  authority: "provisional_user_intent",
};
assertSpaceGrooveSelected(provisionalIntentRequest, "latest target intent only");

const durableTargetRequest = baseRequest("verify-space-groove-durable-target");
durableTargetRequest.context.target_plan = { summary: "目标是五合成律动，娜美主C" };
assertSpaceGrooveSelected(durableTargetRequest, "durable target plan only");

const durableTargetNameRequest = baseRequest("verify-space-groove-durable-target-name");
durableTargetNameRequest.context.target_plan = { name: "5合成律动" };
assertSpaceGrooveSelected(durableTargetNameRequest, "durable target name only");

const matchFactsTargetNameRequest = baseRequest("verify-space-groove-match-facts-target-name");
matchFactsTargetNameRequest.runtime_context.match_facts.target_plan = { target_name: "五合成律动" };
assertSpaceGrooveSelected(matchFactsTargetNameRequest, "match facts durable target name only");

const conflictingHistoryRequest = baseRequest("verify-space-groove-current-over-history");
conflictingHistoryRequest.user_message = "我现在明确玩五合成律动，只查合成律动";
conflictingHistoryRequest.runtime_context.match_facts.latest_user_intent = {
  text: "之前考虑重装战士、牧羊人、幻灵战队、法官、挑战者",
};
conflictingHistoryRequest.runtime_context.match_facts.latest_target_intent = {
  text: "之前目标是重装战士、牧羊人、幻灵战队、法官、挑战者",
  authority: "provisional_user_intent",
};
conflictingHistoryRequest.context.target_plan = {
  summary: "旧目标是重装战士、牧羊人、幻灵战队、法官、挑战者",
};
const conflictingHistory = assertSpaceGrooveSelected(conflictingHistoryRequest, "current target against conflicting history");
assert(String(conflictingHistory.selected.candidates[0]?.display_name).includes("合成律动5"), "the current explicit target must remain the first ranking candidate even when historical context matches more trait terms");
assert(conflictingHistory.selected.primary_query_terms.some((term) => term.includes("合成律动")), "the selected ranking packet must preserve current-message target authority");

const stableQuality = rankingCandidateQuality({ summary: { use_num: 1200, top1_rate: 0.18, top4_rate: 0.68, avg_rank: 2.7 } });
assert.equal(stableQuality.quality_label, "stable_strong", "broad, consistent ranking evidence must be marked stable");
const ceilingQuality = rankingCandidateQuality({ summary: { use_num: 18, top1_rate: 0.34, top4_rate: 0.39, avg_rank: 3.8 } });
assert.equal(ceilingQuality.quality_label, "high_ceiling_low_stability", "tiny high-win sample must remain conditional high ceiling evidence");
assert(ceilingQuality.stability_score < stableQuality.stability_score, "low-sample ceiling evidence must not outrank stable evidence on stability");
assert.equal(stableQuality.version, null, "legacy quality helper should remain backward compatible");
assert(summaryCandidate?.quality_packet, "live ranking summary should expose a quality packet on compact ranking entries");
assert.equal(summaryCandidate.quality_packet.schema, "jcc-ranking-quality-packet-v1", "live ranking summary should expose the quality packet schema");

directMessageRequest.selected_ranking_candidates = directMessage.selected;
const capsule = hostContextCapsuleForRequest(directMessageRequest, { routeKey: "match:verify-space-groove-ranking" });
const delta = compactHostTurnDelta(directMessageRequest, capsule);
assert(Buffer.byteLength(JSON.stringify(delta), "utf8") <= HOST_TURN_DELTA_MAX_BYTES, "production current-turn evidence must stay within the configured complete-strategy hard ceiling");
const deltaCandidate = delta.selected_ranking_candidates?.candidates?.find((candidate) => String(candidate.display_name).includes("合成律动5"));
assert(deltaCandidate, "the exact target ranking candidate must survive the compact production turn delta");
assert.equal(deltaCandidate.summary?.use_rate, directMessage.candidate.summary?.use_rate, "the compact turn delta must preserve the national Master+ appearance rate");
assert.equal(deltaCandidate.summary?.use_num, undefined, "the Host delta must not substitute winning-lineup sample counts for missing national counts");
assert.equal(deltaCandidate.ranking_quality, undefined, "the Host turn candidate must not expose sample-derived quality fields when national sample count is unavailable");
assert.notEqual(deltaCandidate.summary, "[object Object]");
assert.deepEqual(
  Object.keys(capsule.static_context?.daily_big_data?.tiers?.["0"]?.lineup_families?.[0]?.national_strength || {}).sort(),
  ["top1_rate", "top4_rate", "use_rate"],
  "the once-per-session Host national lineup strength map must contain only top-one, top-four, and appearance rates",
);
const serializedDelta = JSON.stringify(delta);
for (const forbiddenRecipeMetricKey of ["recipe_metrics", "recipe_quality", "recipe_evidence_boundary", "observed_win_rate", "observed_use_rate", "weighted_reciprocal_rank_fusion", "rrf_score"]) {
  assert(!serializedDelta.includes(`\"${forbiddenRecipeMetricKey}\"`), `production Host delta must not expose ${forbiddenRecipeMetricKey}`);
}

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-target-aware-ranking-retrieval-verification-v1",
  target: deltaCandidate.display_name,
  sample_size: deltaCandidate.summary.use_num,
  verified_single_sources: [
    "direct_user_message",
    "latest_target_intent",
    "durable_target_plan_summary",
    "durable_target_plan_name",
    "match_facts_target_name",
  ],
  verified_conflict_priority: "current_explicit_target_over_historical_multi_trait_context",
  verified_quality_profiles: [stableQuality.quality_label, ceilingQuality.quality_label],
  verified_multi_lane_no_target: multiLaneCandidate.display_name,
  verified_synthetic_overlay_query_branches: realMultiGroup.explicit_group_coverage.map((entry) => ({
    group_id: entry.group_id,
    status: entry.status,
    candidate_id: entry.candidate_id || null,
  })),
}, null, 2));

function firstStrategyCandidate(candidates) {
  return candidates.find((candidate) => (
    candidate?.id
    && candidate?.strategy_profile?.main_carry?.champion_name
  )) || null;
}
