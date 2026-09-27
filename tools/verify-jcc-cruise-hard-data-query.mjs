#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { handleCodexDynamicToolRequest } from "../ui/electron/host-adapters.js";
import * as runtimeService from "../ui/electron/runtime-service.js";
import { buildStrategyEvidenceKernelPacket } from "../ui/electron/strategy-evidence-kernel.js";

import {
  HARD_DATA_EVIDENCE_POLICY_ID,
  HARD_DATA_ORIGIN_ACTION_ID,
  HARD_DATA_QUERY_REQUEST_KIND,
  buildCruiseHardDataQueryPayload,
  buildHardDataQueryContextForHost,
  buildRuntimeHostContext,
  buildHostTurnDeltaPrompt,
  captureMatchSeasonVersionSnapshot,
  createReadonlyBrokerForHostTurn,
  enforceHostTurnDeltaBudget,
  getRuntimeServiceState,
  hostRequestPersistenceRef,
  prepareHostSessionInvocation,
  resolveRuntimeContextPolicy,
  stripForbiddenStrategyEvidence,
  theorycraftDecisionInputs,
  handleRuntimeAction,
  setRuntimeServiceState,
} from "../ui/electron/runtime-service.js";

const capability = {
  request_kind: HARD_DATA_QUERY_REQUEST_KIND,
  origin_action_id: HARD_DATA_ORIGIN_ACTION_ID,
  evidence_policy_id: HARD_DATA_EVIDENCE_POLICY_ID,
};

const hardDataQueryIndex = {
  schema: "jcc-hard-data-query-index-v1",
  identity: { season_id: "s18", patch_id: "s18_1", core_profile_id: "core-test" },
  entity_reward_tables: [
    { table_id: "augment:10559:rewards", name: "轻量魔法投掷", entity_ref: { kind: "augment", id: "10559", name: "轻量魔法投掷" }, aliases: ["轻量魔法投掷"], groups: [{ label: "6", outcomes: [{ probability: 1, rewards: ["奖励A", "奖励B"] }] }] },
    { table_id: "trait:453:rewards", name: "魔女", entity_ref: { kind: "trait", id: "453", name: "魔女" }, aliases: ["魔女"], groups: [] },
  ],
  season_reward_tables: [
    { table_id: "season:blue-orb", name: "蓝色法球", groups: [] },
    { table_id: "season:gold-orb", name: "金色法球", groups: [] },
  ],
  supplemental_named_reward_tables: [],
  mechanics: {
    progression: { starting_level: 2 },
    shop: { pool_by_cost: { "1": 30 } },
    player_damage: { base_damage_by_stage: { "2": 2 } },
    augment_tier_sequence_probabilities: { rows: [{ first: "silver", probability: 1 }] },
  },
};
const hardDataStaticContext = { core_knowledge: { hard_data_query_index: hardDataQueryIndex } };
const lightRollContext = buildHardDataQueryContextForHost(
  { user_message: "轻量魔法投掷具体能给什么奖励？" },
  hardDataStaticContext,
);
assert.deepEqual(lightRollContext.entity_reward_tables.map((row) => row.entity_ref.id), ["10559"]);
assert.equal(lightRollContext.entity_reward_tables[0].groups[0].outcomes[0].rewards.length, 2, "one probability outcome must preserve its atomic reward bundle");
assert.deepEqual(lightRollContext.season_reward_tables, []);
assert.equal(lightRollContext.mechanics.augment_tier_sequence_probabilities, null);
const orbContext = buildHardDataQueryContextForHost({ user_message: "蓝色法球有哪些奖励？" }, hardDataStaticContext);
assert.deepEqual(orbContext.season_reward_tables.map((row) => row.name), ["蓝色法球"]);
const probabilityContext = buildHardDataQueryContextForHost({ user_message: "强化一选二选三选的刷新概率" }, hardDataStaticContext);
assert.equal(probabilityContext.mechanics.augment_tier_sequence_probabilities.rows.length, 1);
assert.equal(buildHardDataQueryContextForHost({ user_message: "你好" }, hardDataStaticContext), null);

const candidateProfile = JSON.parse(await readFile("data/game-knowledge/jcc/candidates/candidate-profile.json", "utf8"));
const candidateBundle = JSON.parse(await readFile(`data/game-knowledge/jcc/${candidateProfile.bundle_path}`, "utf8"));
const currentCovenContext = buildHardDataQueryContextForHost(
  { user_message: "18.2魔女130、185、250和365层分别有什么奖励？" },
  { core_knowledge: candidateBundle },
);
const currentCovenTable = currentCovenContext.entity_reward_tables.find((table) => table.table_id === "trait:453:rewards");
assert.ok(currentCovenTable);
assert.ok(currentCovenTable.groups.find((group) => group.label === "130").outcomes.some((outcome) => (
  outcome.rewards.map((reward) => reward.title).join("|") === "凯特琳|基础装备|3金币"
)));
assert.ok(currentCovenTable.groups.find((group) => group.label === "365").outcomes.every((outcome) => (
  outcome.rewards.some((reward) => reward.title === "额外12金币")
)));
const currentProgressionContext = buildHardDataQueryContextForHost(
  { user_message: "当前升级经验表" },
  { core_knowledge: candidateBundle },
);
assert.deepEqual(
  Object.fromEntries(["7", "8", "9"].map((level) => [level, currentProgressionContext.mechanics.progression.xp_to_next_level[level]])),
  { "7": 56, "8": 68, "9": 68 },
);
const traitLadderContext = buildHardDataQueryContextForHost(
  { user_message: "8人口拼盘天梯怎么凑最多羁绊？" },
  { core_knowledge: candidateBundle },
).trait_diversity_roster_context;
assert.equal(traitLadderContext.status, "ready");
assert.equal(traitLadderContext.population, 8);
assert.equal(traitLadderContext.support_key, "none");
assert.equal(traitLadderContext.maximum_primary_metric, 10);
assert.equal(traitLadderContext.matching_roster_count, 4);
assert.equal(traitLadderContext.accessibility_fallback_count, 1);
assert.equal(traitLadderContext.stored_roster_count, 5);
assert.equal(traitLadderContext.returned_roster_count, 5);
assert.ok(traitLadderContext.rosters.every((row) => row.champions.length === 8));
assert.deepEqual(traitLadderContext.rosters.map((row) => row.recommendation_tier), [
  "primary", "primary", "primary", "primary", "accessibility_fallback",
]);
assert.ok(traitLadderContext.rosters[0].metrics.high_cost_unit_count >= traitLadderContext.rosters[1].metrics.high_cost_unit_count);
assert.ok(traitLadderContext.common_high_cost_leader_champions.length > 0);
assert.equal(traitLadderContext.rosters[0].next_population_transitions[0].population, 9);
assert.ok(traitLadderContext.rosters[0].next_population_transitions[0].overlap_count >= 7);
assert.equal(traitLadderContext.policy.result_scope, "no_emblem_conservative_baseline");
const emblemTraitLadderContext = buildHardDataQueryContextForHost(
  { user_message: "8人口拼盘天梯，我有法师和迅捷射手纹章" },
  { core_knowledge: candidateBundle },
).trait_diversity_roster_context;
assert.equal(emblemTraitLadderContext.support_key, "none");
assert.equal(emblemTraitLadderContext.maximum_primary_metric, 10);
assert.equal(emblemTraitLadderContext.matching_roster_count, 4);
assert.equal(emblemTraitLadderContext.policy.atomic_rosters_only, true);
assert.equal(emblemTraitLadderContext.policy.no_emblem_branch_only, true);
assert.equal(emblemTraitLadderContext.policy.emblem_input_intentionally_not_optimized, true);
assert.equal(emblemTraitLadderContext.policy.online_fetch_used, false);
const populationFourContext = buildHardDataQueryContextForHost(
  { user_message: "4人口拼盘天梯最多羁绊" },
  { core_knowledge: candidateBundle },
).trait_diversity_roster_context;
assert.equal(populationFourContext.high_cost_role_constraint_status, "unavailable_at_population");
assert.equal(populationFourContext.stored_roster_count, 2);
assert.equal(populationFourContext.rosters[0].next_population_transitions[0].status, "degraded_transition");
const bronzeContext = buildHardDataQueryContextForHost(
  { user_message: "8人口终身黄铜 II 怎么凑羁绊" },
  { core_knowledge: candidateBundle },
).trait_diversity_roster_context;
assert.equal(bronzeContext.objective.objective_id, "bronze_trait_scaling");
assert.equal(bronzeContext.matching_roster_count, 2, "bronze objective must use its own frontier");
assert.equal(bronzeContext.accessibility_fallback_count, 3);
assert.equal(buildHardDataQueryContextForHost(
  { user_message: "并肩作战最多羁绊怎么搭" },
  { core_knowledge: candidateBundle },
), null, "并肩作战 must not enter the companion roster solver");
const overlapTarget = traitLadderContext.rosters[0];
const overlapContext = buildHardDataQueryContextForHost(
  { user_message: "8人口拼盘天梯怎么凑最多羁绊？" },
  { core_knowledge: candidateBundle },
  {
    candidates: [{
      display_name: "测试原子变体",
      strategy_profile: {
        lifecycle_prior: { target_population: 8 },
        variants: [{
          variant_id: "atomic-overlap-test",
          population: 8,
          lineup_ids: overlapTarget.champions.map((champion) => champion.id),
          lineup_names: overlapTarget.champions.map((champion) => champion.name),
        }],
      },
    }],
  },
).trait_diversity_roster_context;
const overlapRow = overlapContext.rosters.find((row) => row.roster_id === overlapTarget.roster_id);
assert.equal(overlapRow.master_plus_overlap[0].overlap_count, 8, "ranking overlap must count each champion once even when both id and name match");

setRuntimeServiceState({
  schema: "jcc-ui-runtime-state-v1",
  active_mode: "cruise",
  match_session: { status: "active", match_session_id: "hard-data-match" },
  response_task: { status: "idle" },
  response_task_revision: 0,
  host_cli: { status: "idle" },
  runtime_events: { latest: [] },
});
const forgedGeneric = await handleRuntimeAction("sendMessage", {
  text: "给奥恩算理论装备",
  mode: "cruise",
  ...capability,
});
assert.equal(forgedGeneric.ok, false);
assert.equal(forgedGeneric.status, "typed_query_external_capability_rejected");

const sealedPayload = buildCruiseHardDataQueryPayload("给奥恩算理论装备");
assert.equal(sealedPayload.request_kind, HARD_DATA_QUERY_REQUEST_KIND);
assert.equal(sealedPayload.origin_action_id, HARD_DATA_ORIGIN_ACTION_ID);
assert.equal(sealedPayload.evidence_policy_id, HARD_DATA_EVIDENCE_POLICY_ID);

setRuntimeServiceState({
  schema: "jcc-ui-runtime-state-v1",
  active_mode: "daily_chat",
  match_session: { status: "idle" },
  response_task: { status: "idle" },
});
const inactiveAction = await handleRuntimeAction("sendCruiseHardDataQuery", { text: "给奥恩算理论装备" });
assert.equal(inactiveAction.status, "hard_data_query_requires_active_match");

const ordinaryCopiedText = resolveRuntimeContextPolicy("cruise", {
  request_kind: "host_question",
  user_message: "别吃大数据：给奥恩算理论装备",
});
assert.equal(ordinaryCopiedText.hard_data_only, false, "visible text must not activate the evidence capability");
assert.equal(ordinaryCopiedText.include_daily_big_data, true, "ordinary Cruise keeps its normal selected-context policy");

const ordinaryLineupQuestion = resolveRuntimeContextPolicy("cruise", {
  request_kind: "host_question",
  user_message: "按照你对当前版本的理解，给我一套有羁绊的95阵容和6人口过渡",
});
assert.equal(ordinaryLineupQuestion.strategy_intent, true);
assert.equal(ordinaryLineupQuestion.decision_math_intent, true,
  "ordinary Cruise lineup questions must retrieve deterministic current-Core evidence too");
assert.equal(ordinaryLineupQuestion.hard_data_only, false);
assert.equal(ordinaryLineupQuestion.include_daily_big_data, true,
  "normal Cruise may combine Core evidence with rankings when a compatible overlay exists");

setRuntimeServiceState({
  schema: "jcc-ui-runtime-state-v1",
  active_mode: "cruise",
  match_session: {
    status: "active",
    match_session_id: "ordinary-core-lineup-match",
    season_version_snapshot: captureMatchSeasonVersionSnapshot(),
  },
  response_task: { status: "idle" },
  response_task_revision: 0,
  host_cli: { status: "idle" },
  runtime_events: { latest: [] },
});
const ordinaryLineupContext = await buildRuntimeHostContext("cruise", null, {
  request_kind: "host_question",
  user_message: "按照你对当前版本的理解，给我一套有羁绊的95阵容和6人口、8人口过渡",
  mode: "cruise",
});
assert.equal(ordinaryLineupContext.decision_math_context?.operation, "solve_trait_roster_role_coverage");
assert.equal(ordinaryLineupContext.decision_math_context?.executable, true);
assert.equal(ordinaryLineupContext.decision_math_context?.population, 9);
assert.equal(ordinaryLineupContext.decision_math_context?.core_selection?.mode, "deterministic_auto_selection");
assert.deepEqual(ordinaryLineupContext.decision_math_context?.transitions?.map((row) => row.population), [6, 8]);
assert.ok(ordinaryLineupContext.decision_math_context?.roster?.every((unit) => unit.skill?.summary));

const ordinaryLineupCorrectionContext = await buildRuntimeHostContext("cruise", null, {
  request_kind: "host_question",
  user_message: "你这不就是九张五费卡吗？一点羁绊都没有啊",
  mode: "cruise",
});
assert.equal(ordinaryLineupCorrectionContext.context_policy.hard_data_only, false);
assert.equal(ordinaryLineupCorrectionContext.decision_math_context?.operation, "solve_trait_roster_role_coverage");
assert.equal(ordinaryLineupCorrectionContext.decision_math_context?.executable, true);
assert.ok(ordinaryLineupCorrectionContext.decision_math_context?.trait_coverage
  ?.some((trait) => trait.achieved_breakpoint));

const completeHardDataContext = await buildRuntimeHostContext("cruise", null, {
  ...capability,
  user_message: "别吃大数据：给我一套有羁绊的95阵容，并说明6人口和8人口过渡、装备通用及强化选择",
  mode: "cruise",
});
assert.equal(completeHardDataContext.context_policy.hard_data_only, true);
assert.equal(completeHardDataContext.daily_big_data, null);
assert.equal(completeHardDataContext.selected_ranking_candidates, null);
assert.equal(completeHardDataContext.strategy_wiki_context, null);
assert.equal(completeHardDataContext.decision_math_context?.operation, "compose_theorycraft_decision");
assert.equal(completeHardDataContext.decision_math_context?.components?.lineup?.population, 9);
assert.deepEqual(completeHardDataContext.decision_math_context?.components?.lineup?.transitions?.map((row) => row.population), [6, 8]);
assert.equal(completeHardDataContext.decision_math_context?.components?.itemization?.executable, true);
assert.equal(completeHardDataContext.decision_math_context?.components?.augments?.executable, true);
assert.ok(completeHardDataContext.itemization_context?.champion_contexts?.length > 0,
  "theorycraft itemization must follow the deterministic selected carry");
for (const holder of [
  completeHardDataContext.decision_math_context?.components?.lineup?.core_selection?.main_carry,
  completeHardDataContext.decision_math_context?.components?.lineup?.core_selection?.main_tank,
].filter(Boolean)) {
  assert.ok(completeHardDataContext.itemization_context.requested_champions.includes(holder.name),
    `theorycraft itemization must include the selected ${holder.name} holder`);
}
assert.equal(completeHardDataContext.provider_conversation_continuity?.schema, "jcc-provider-conversation-continuity-v1");
assert.equal(completeHardDataContext.decision_math_context?.claim_boundaries?.ranking_strength, false);
assert.deepEqual(
  ["lineup_construction", "transition_planning", "itemization", "augment_selection"]
    .filter((route) => !completeHardDataContext.strategy_evidence_plan?.route_ids?.includes(route)),
  [],
  "a multi-domain theorycraft request must keep every material evidence route",
);
assert.equal(
  completeHardDataContext.strategy_evidence_coverage?.status,
  "complete",
  JSON.stringify(completeHardDataContext.strategy_evidence_coverage, null, 2),
);
assert.deepEqual(completeHardDataContext.strategy_evidence_coverage?.missing_critical_facets, []);
assert.ok(completeHardDataContext.strategy_evidence_coverage?.receipts
  ?.some((row) => row.facet_id === "champion_trait_map" && row.state === "satisfied"));
assert.ok(completeHardDataContext.strategy_evidence_coverage?.receipts
  ?.some((row) => row.facet_id === "transition_candidates" && row.state === "satisfied"));
assert.ok(completeHardDataContext.strategy_evidence_coverage?.receipts
  ?.filter((row) => row.facet_id.startsWith("ranking_") || row.facet_id === "ranking_observations")
  .every((row) => row.state === "forbidden"));
assert.ok(completeHardDataContext.strategy_evidence_prefetch?.evidence);
for (const receipt of completeHardDataContext.strategy_evidence_coverage.receipts
  .filter((row) => row.criticality === "critical" && row.state === "satisfied")) {
  assert(
    receipt.delivery === "prefetched"
      || receipt.delivery === "prefetched_reference"
      || receipt.delivery === "snapshot_bound_tool",
    `critical evidence ${receipt.facet_id} must have a concrete delivery path`,
  );
}
assert.equal(
  JSON.stringify(completeHardDataContext.strategy_evidence_prefetch).includes("national_master_strength"),
  false,
  "no-big-data prefetch must not contain ranking strength evidence",
);

const theoryArtifactHardDataContext = await buildRuntimeHostContext("cruise", null, {
  ...capability,
  user_message: "别吃大数据：给我一套3费主C赌狗阵容，同时推荐理论装备和理论神器",
  mode: "cruise",
});
assert.equal(theoryArtifactHardDataContext.decision_math_context?.operation, "compose_theorycraft_decision");
assert.ok(theoryArtifactHardDataContext.itemization_context?.champion_contexts?.some((entry) => (
  entry?.champion_context?.artifact_candidates?.length > 0
)), "theory artifact candidates must be attached for the auto-selected carry");

const completeHardDataRequest = {
  ...capability,
  provider_readonly_tool_mode: "native_dynamic_tools",
  request_id: "complete-hard-data-tool-turn",
  response_task_id: "complete-hard-data-tool-turn",
  response_task_revision: 3,
  user_message: "别吃大数据：给我一套有羁绊的95阵容，并说明6人口和8人口过渡、装备通用及强化选择",
  mode: "cruise",
  runtime_context: {
    ...completeHardDataContext,
    strategy_evidence_plan: {
      ...completeHardDataContext.strategy_evidence_plan,
      provider_capability: "native_dynamic_tools",
    },
  },
  context: { runtime_context: completeHardDataContext, live_state_summary: {} },
};
const readonlyBroker = createReadonlyBrokerForHostTurn(completeHardDataRequest, {
  capsule: { capsule_id: "test", fingerprint: "test", route_key: "match:ordinary-core-lineup-match" },
});
assert(readonlyBroker, "Codex no-big-data turn must expose one snapshot-bound readonly broker");
const commonKnowledge = await readonlyBroker.call("jcc.query_knowledge", {
  operation: "get_common_knowledge", question: "经济",
});
assert.equal(commonKnowledge.ok, true, "Core-only Common retrieval must not require a Ranking binding");
const forbiddenRanking = await readonlyBroker.call("jcc.query_knowledge", { operation: "search_lineups", limit: 1 });
assert.equal(forbiddenRanking.result.error_code, "source_forbidden", "Common access must not widen source permissions");
const explicitRoster = await readonlyBroker.call("jcc.calculate", {
  question: "搭上去", operation: "solve_trait_roster_role_coverage", population: 9,
  main_carry: "乐芙兰", main_tank: "赫卡里姆",
  target_traits: [{ trait: "永恒之森", count: 7 }],
  emblems: [{ trait: "永恒之森", count: 1 }],
});
assert.equal(explicitRoster.result.operation, "solve_trait_roster_role_coverage");
assert.equal(explicitRoster.result.executable, true);
assert.equal(explicitRoster.result.evidence_policy, "active_core_profile_only_no_rankings");
const noBigDataProviderActiveTurn = {
  turnId: "turn-no-big-data",
  acceptsReadonlyTools: true,
  cancelled: false,
  readonlyToolHandler: (toolName, args) => readonlyBroker.call(toolName, args),
};
const noBigDataProviderSessionState = {
  providerSessionId: "thread-no-big-data",
  readonlyToolMode: "native_dynamic_tools",
  activeTurn: noBigDataProviderActiveTurn,
};
const noBigDataProviderToolResponse = await handleCodexDynamicToolRequest({
  jsonrpc: "2.0",
  id: 1,
  method: "item/tool/call",
  params: {
    callId: "no-big-data-provider-call",
    threadId: "thread-no-big-data",
    turnId: "turn-no-big-data",
    namespace: "jcc",
    tool: "query_knowledge",
    arguments: {
      route_ids: ["lineup_construction", "transition_planning"],
      facets: ["champion_trait_map", "transition_candidates"],
    },
  },
}, () => noBigDataProviderSessionState);
assert.equal(
  noBigDataProviderToolResponse.result.success,
  true,
  noBigDataProviderToolResponse.result.contentItems[0].text,
);
const noBigDataProviderToolPayload = JSON.parse(noBigDataProviderToolResponse.result.contentItems[0].text);
assert.equal(noBigDataProviderToolPayload.source_policy, HARD_DATA_EVIDENCE_POLICY_ID);
assert.equal(JSON.stringify(noBigDataProviderToolPayload).includes("ranking_observations"), false);

const choiceSet = {
  schema: "jcc-runtime-reported-choice-set-v1",
  match_session_id: "ordinary-core-lineup-match",
  mode: "augment_choice",
  kind: "augment",
  choice_stage_round: "3-2",
  report_id: "augment-report-r1",
  revision: 1,
  candidates: [{ slot: 1, name: "强化A" }, { slot: 2, name: "强化B" }, { slot: 3, name: "强化C" }],
};
setRuntimeServiceState({
  schema: "jcc-ui-runtime-state-v1",
  active_mode: "augment_choice",
  match_session: {
    status: "active",
    match_session_id: "ordinary-core-lineup-match",
    season_version_snapshot: captureMatchSeasonVersionSnapshot(),
  },
  match_context: {
    match_session_id: "ordinary-core-lineup-match",
    reported_choice_sets_by_scope: { "augment_choice:augment:3-2": choiceSet },
    reported_choice_sets_by_mode: { augment_choice: choiceSet },
    reported_choice_sets: [choiceSet],
  },
  response_task: {
    status: "running",
    response_task_id: "bound-tool-turn",
    mode: "augment_choice",
    match_session_id: "ordinary-core-lineup-match",
    origin: "structured_card_action",
    event_key: "augment-choice:3-2",
    revision: 3,
    runtime_event_context: { decision_action_fingerprint: "decision-action-v1" },
  },
  response_task_revision: 3,
  host_cli: { provider: "codex", status: "ready" },
  runtime_events: { latest: [] },
});
const boundToolBaseRequest = {
  request_id: "bound-tool-turn",
  response_task_id: "bound-tool-turn",
  response_task_revision: 3,
  provider_readonly_tool_mode: "native_dynamic_tools",
  mode: "augment_choice",
  user_message: "这三个强化怎么选？",
  runtime_event_context: { decision_action_fingerprint: "decision-action-v1" },
  choices: {
    source: "current_match_user_report",
    kind: "augment",
    stage_round: "3-2",
    report_id: "augment-report-r1",
    choice_set_revision: 1,
    candidates: choiceSet.candidates,
  },
};
const boundToolContext = await buildRuntimeHostContext("augment_choice", null, boundToolBaseRequest);
const oversizedBoundToolContext = structuredClone(boundToolContext);
oversizedBoundToolContext.strategy_evidence_prefetch.evidence.synthetic_optional_padding = "x".repeat(300_000);
const boundToolRequest = {
  ...boundToolBaseRequest,
  runtime_context: oversizedBoundToolContext,
  context: { runtime_context: oversizedBoundToolContext, live_state_summary: {} },
};
const boundToolInvocation = prepareHostSessionInvocation(boundToolRequest);
assert.ok(boundToolInvocation.turn_prompt_bytes <= (2 * 1024 * 1024) - (32 * 1024));
assert.equal(boundToolInvocation.readonly_tool_reserved_bytes, 256 * 1024);
const boundToolBroker = createReadonlyBrokerForHostTurn(boundToolRequest, boundToolInvocation);
assert(boundToolBroker, "a native-tool turn must retain enough shared budget for one useful call");
const ordinaryRoster = await boundToolBroker.call("jcc.calculate", {
  question: "搭上去", operation: "solve_trait_roster_role_coverage", population: 9,
  main_carry: "乐芙兰", main_tank: "赫卡里姆",
  target_traits: [{ trait: "永恒之森", count: 7 }],
  emblems: [{ trait: "永恒之森", count: 1 }],
});
assert.equal(ordinaryRoster.result.operation, "solve_trait_roster_role_coverage");
assert.equal(ordinaryRoster.result.executable, true);
await boundToolBroker.call("jcc.calculate", { question: "五阶段输了，对面剩3个棋子扣多少血" });

setRuntimeServiceState({
  ...getRuntimeServiceState(),
  response_task: {
    ...getRuntimeServiceState().response_task,
    status: "running",
    response_task_id: "bound-tool-turn",
    revision: 4,
    runtime_event_context: { decision_action_fingerprint: "decision-action-v1" },
  },
});
await boundToolBroker.call("jcc.calculate", { question: "同一任务正常持久化递增后再算一次" });

setRuntimeServiceState({
  ...getRuntimeServiceState(),
  match_context: {
    match_session_id: "ordinary-core-lineup-match",
    reported_choice_sets_by_scope: {
      "augment_choice:augment:3-2": { ...choiceSet, report_id: "augment-report-r2", revision: 2 },
    },
    reported_choice_sets_by_mode: { augment_choice: { ...choiceSet, report_id: "augment-report-r2", revision: 2 } },
    reported_choice_sets: [{ ...choiceSet, report_id: "augment-report-r2", revision: 2 }],
  },
});
await assert.rejects(
  boundToolBroker.call("jcc.calculate", { question: "旧卡片 revision 不得继续读取" }),
  /readonly_tool_choice_revision_expired/,
);

setRuntimeServiceState({
  ...getRuntimeServiceState(),
  match_context: {
    match_session_id: "ordinary-core-lineup-match",
    reported_choice_sets_by_scope: { "augment_choice:augment:3-2": choiceSet },
    reported_choice_sets_by_mode: { augment_choice: choiceSet },
    reported_choice_sets: [choiceSet],
  },
  response_task: {
    ...getRuntimeServiceState().response_task,
    status: "running",
    response_task_id: "bound-tool-turn",
    revision: 5,
    runtime_event_context: { decision_action_fingerprint: "decision-action-v2" },
  },
});
const decisionExpiredBroker = createReadonlyBrokerForHostTurn(boundToolRequest, boundToolInvocation);
await assert.rejects(
  decisionExpiredBroker.call("jcc.calculate", { question: "旧决策 action 不得继续读取" }),
  /readonly_tool_decision_action_expired/,
);

const ownerBaseTask = {
  status: "running",
  response_task_id: "bound-tool-turn",
  mode: "augment_choice",
  match_session_id: "ordinary-core-lineup-match",
  origin: "structured_card_action",
  event_key: "augment-choice:3-2",
  revision: 6,
  runtime_event_context: { decision_action_fingerprint: "decision-action-v1" },
};
for (const [field, value] of [
  ["origin", "runtime_event"],
  ["event_key", "different-event"],
  ["match_session_id", "different-match"],
]) {
  setRuntimeServiceState({
    ...getRuntimeServiceState(),
    response_task: { ...ownerBaseTask, [field]: value },
  });
  const ownerExpiredBroker = createReadonlyBrokerForHostTurn(boundToolRequest, boundToolInvocation);
  await assert.rejects(
    ownerExpiredBroker.call("jcc.query_knowledge", {}),
    /readonly_tool_response_task_expired/,
    `changing response owner ${field} must expire even an empty query`,
  );
}

setRuntimeServiceState({
  ...getRuntimeServiceState(),
  response_task: { ...ownerBaseTask, mode: "cruise" },
});
const modeExpiredBroker = createReadonlyBrokerForHostTurn(boundToolRequest, boundToolInvocation);
const emptyQueryActiveTurn = {
  turnId: "turn-empty-query",
  acceptsReadonlyTools: true,
  cancelled: false,
  readonlyToolHandler: (toolName, args) => modeExpiredBroker.call(toolName, args),
};
const emptyQuerySessionState = { providerSessionId: "thread-empty-query", readonlyToolMode: "native_dynamic_tools", activeTurn: emptyQueryActiveTurn };
const emptyQueryResponse = await handleCodexDynamicToolRequest({
  jsonrpc: "2.0",
  id: 2,
  method: "item/tool/call",
  params: {
    callId: "empty-query-after-owner-change",
    threadId: "thread-empty-query",
    turnId: "turn-empty-query",
    namespace: "jcc",
    tool: "query_knowledge",
    arguments: {},
  },
}, () => emptyQuerySessionState);
assert.equal(emptyQueryResponse.result.success, false);
assert.match(emptyQueryResponse.result.contentItems[0].text, /readonly_tool_response_task_expired/);

setRuntimeServiceState({
  ...getRuntimeServiceState(),
  response_task: {
    status: "running",
    response_task_id: "replacement-tool-turn",
    mode: "augment_choice",
    match_session_id: "ordinary-core-lineup-match",
    origin: "structured_card_action",
    event_key: "augment-choice:3-2",
    revision: 1,
    runtime_event_context: { decision_action_fingerprint: "decision-action-v1" },
  },
});
const responseExpiredBroker = createReadonlyBrokerForHostTurn(boundToolRequest, boundToolInvocation);
await assert.rejects(
  responseExpiredBroker.call("jcc.calculate", { question: "被替换的回答任务不得继续读取" }),
  /readonly_tool_response_task_expired/,
);

// Direct requests have distinct request/task IDs. Seal the Runtime owner before
// the first evidence build; canonical reuse must never acquire a new owner.
const unownedPacket = buildStrategyEvidenceKernelPacket({ framework: { routes: [] }, hostRequest: { request_id: "ui-direct:unowned" } });
assert.equal(unownedPacket.evidence_snapshot.identity.request_id, "ui-direct:unowned");
assert.equal(unownedPacket.evidence_snapshot.identity.response_task_id, null,
  "a request ID is content identity, never implicit response-task authority");
const directTask = { status: "awaiting_host_cli_agent_response", response_task_id: "direct-runtime-task",
  mode: "lineup_card", match_session_id: "ordinary-core-lineup-match", origin: "user", event_key: null, revision: 145 };
setRuntimeServiceState({ ...getRuntimeServiceState(), active_mode: "lineup_card",
  match_context: { match_session_id: "ordinary-core-lineup-match" },
  response_task: directTask, response_task_revision: 145 });
const directOwner = runtimeService.captureResponseTaskOwner(directTask.response_task_id, directTask.mode, directTask.match_session_id);
assert(directOwner);
const directBase = { request_id: "ui-direct:separate-request-id", request_hash: "direct-request-hash",
  mode: "lineup_card", user_message: "Inspect the final lineup.", provider_readonly_tool_mode: "native_dynamic_tools" };
const directRuntimeContext = await buildRuntimeHostContext("lineup_card", null, directBase, directOwner);
const directRequest = { ...directBase, runtime_context: directRuntimeContext };
const directIdentity = directRequest.runtime_context.strategy_evidence_snapshot.identity;
assert.equal(directIdentity.request_id, directBase.request_id);
assert.equal(directIdentity.response_task_id, directTask.response_task_id);
assert.equal(directIdentity.response_task_revision, 145);
assert.equal(directIdentity.response_task_origin, "user");
assert.equal(directIdentity.response_task_mode, "lineup_card");
assert.equal(directIdentity.response_task_match_session_id, directTask.match_session_id);
const directSnapshotBefore = structuredClone(directRequest.runtime_context.strategy_evidence_snapshot);
const directRef = hostRequestPersistenceRef(directRequest, directTask.response_task_id);
setRuntimeServiceState({ ...getRuntimeServiceState(), response_task: { ...directTask, host_request: directRef } });
const directInvocation = prepareHostSessionInvocation(directRequest);
const directBroker = createReadonlyBrokerForHostTurn(directRequest, directInvocation);
assert(directBroker, "owner-sealed direct lineup exposes its existing native broker");
await directBroker.call("jcc.query_knowledge", { operation: "get_lineup", entity_names: ["not-in-fixture"] });
setRuntimeServiceState({ ...getRuntimeServiceState(), response_task: { ...directTask, host_request: directRef,
  status: "running", revision: 147, provider_invocation_task_id: `${directTask.response_task_id}:rule-correction` } });
await directBroker.call("jcc.query_knowledge", { operation: "get_lineup", entity_names: ["not-in-fixture"] });
assert.deepEqual(directRequest.runtime_context.strategy_evidence_snapshot, directSnapshotBefore,
  "revision advance must validate the original seal, not rebuild evidence identity");
setRuntimeServiceState({ ...getRuntimeServiceState(), response_task: { ...directTask, response_task_id: "replacement-direct-task", revision: 148 } });
await assert.rejects(() => buildRuntimeHostContext("lineup_card", null, directBase, directOwner),
  /host_context_response_owner_expired/, "an expired owner cannot seal a newly built request");
await assert.rejects(() => directBroker.call("jcc.query_knowledge", {}), /readonly_tool_response_task_expired/);
assert.deepEqual(directRequest.runtime_context.strategy_evidence_snapshot, directSnapshotBefore);

// A completed Match retains its historical ID, but owns no active Host turn.
// Keep the former task otherwise unchanged to isolate the Match-status guard.
const completedMatch = { ...getRuntimeServiceState().match_session, status: "completed" };
setRuntimeServiceState({ ...getRuntimeServiceState(), match_session: completedMatch,
  response_task: { ...directTask, status: "running", revision: 147, host_request: directRef } });
await assert.rejects(() => buildRuntimeHostContext("lineup_card", null, directBase, directOwner),
  /host_context_response_owner_expired/, "a formerly active Match owner expires when that Match completes");
await assert.rejects(() => directBroker.call("jcc.query_knowledge", {}), /readonly_tool_match_snapshot_expired/);
const reviewTask = { status: "preparing", response_task_id: "postgame-review-task",
  mode: "postgame_review", match_session_id: null, origin: "user", event_key: null, revision: 149 };
setRuntimeServiceState({ ...getRuntimeServiceState(), active_mode: "postgame_review",
  response_task: reviewTask, response_task_revision: 149 });
const reviewOwner = runtimeService.captureResponseTaskOwner(reviewTask.response_task_id, reviewTask.mode, null);
assert(reviewOwner);
assert.equal(reviewOwner.match_session_id, null);
assert.equal(getRuntimeServiceState().match_session.match_session_id, directTask.match_session_id,
  "the completed Match ID must remain present to reproduce the real review failure");
const reviewContext = await buildRuntimeHostContext("postgame_review", null,
  { request_id: "ui-direct:postgame-review", mode: "postgame_review", user_message: "Review the completed match." }, reviewOwner);
assert.equal(reviewContext.active_mode, "postgame_review");
assert.equal(reviewContext.response_task_identity.response_task_id, reviewTask.response_task_id);
assert.equal(reviewContext.response_task_identity.response_task_match_session_id, null);
assert.equal(reviewContext.response_task_identity.response_task_revision, 149);
const reviewRequest = {
  request_id: "ui-direct:postgame-review", mode: "postgame_review",
  provider_readonly_tool_mode: "native_dynamic_tools",
  runtime_context: {
    ...reviewContext,
    strategy_evidence_plan: {
      ...reviewContext.strategy_evidence_plan,
      provider_capability: "native_dynamic_tools",
    },
  },
};
const reviewBroker = createReadonlyBrokerForHostTurn(reviewRequest, prepareHostSessionInvocation(reviewRequest));
assert(reviewBroker, "the newly sealed review must expose its native tools");
const reviewResult = await reviewBroker.call("jcc.query_knowledge", { operation: "get_lineup", candidate_id: "not-in-fixture" });
assert.equal(reviewResult.result.status, "not_found", "review query must execute, not fail freshness checks");
const reviewIdentity = reviewContext.strategy_evidence_snapshot.identity;
assert.equal(reviewIdentity.match_session_id, directTask.match_session_id, "retain historical evidence provenance");
assert.equal(reviewIdentity.execution_match_session_id, null);
assert.equal(directIdentity.execution_match_session_id, directTask.match_session_id);
setRuntimeServiceState({ ...getRuntimeServiceState(), response_task: { ...reviewTask, status: "running", revision: 150 } });
await reviewBroker.call("jcc.query_knowledge", { operation: "get_lineup", candidate_id: "not-in-fixture" });
setRuntimeServiceState({ ...getRuntimeServiceState(), match_session: {
  ...completedMatch, status: "active", match_session_id: "new-match-after-review",
} });
await assert.rejects(() => reviewBroker.call("jcc.query_knowledge", {}), /readonly_tool_match_snapshot_expired/,
  "a new Match expires review tools even if the review task and revision are unchanged");

setRuntimeServiceState({
  schema: "jcc-ui-runtime-state-v1",
  active_mode: "cruise",
  match_session: {
    status: "active",
    match_session_id: "new-match-after-tool-turn",
    season_version_snapshot: captureMatchSeasonVersionSnapshot(),
  },
  response_task: { status: "idle" },
  response_task_revision: 0,
  host_cli: { status: "idle" },
  runtime_events: { latest: [] },
});
await assert.rejects(
  readonlyBroker.call("jcc.calculate", { question: "再算一次" }),
  /readonly_tool_match_snapshot_expired/,
  "a broker from the previous Match must fail closed",
);

const typedPolicy = resolveRuntimeContextPolicy("cruise", {
  ...capability,
  user_message: "别吃大数据：给奥恩算理论装备",
});
assert.equal(typedPolicy.hard_data_only, true);
assert.equal(typedPolicy.include_daily_big_data, false);
assert.equal(typedPolicy.include_strategy_wiki, false);
assert.equal(typedPolicy.ranking_evidence, "forbidden_for_this_turn");
assert.ok(typedPolicy.forbidden_sources.includes("hero_item_signal"));

const stripped = stripForbiddenStrategyEvidence({
  ...capability,
  daily_big_data: { secret: true },
  selected_ranking_candidates: { candidates: [{ id: "ranked" }] },
  strategy_wiki_context: { pages: [{ title: "rank-derived" }] },
  context_pack: { scope: "mode", mode_id: "cruise", strategy_data_sources: ["daily_big_data"] },
  context: {
    strategy_context: { ranked: true },
    runtime_context: {
      cruise_decision_context: { ranked: true },
      strategy_fit_packet: { ranked: true },
      absorbed_cruise_obligation: { ranked: true },
    },
  },
  runtime_context: {
    daily_big_data: { secret: true },
    selected_ranking_candidates: { candidates: [{ id: "ranked" }] },
    strategy_wiki_context: { pages: [{ title: "rank-derived" }] },
    cruise_decision_context: { ranked: true },
    strategy_fit_packet: { ranked: true },
    absorbed_cruise_obligation: { ranked: true },
  },
});
for (const key of ["daily_big_data", "selected_ranking_candidates", "strategy_wiki_context"]) {
  assert.equal(stripped[key], undefined, `${key} must be stripped at request root`);
  assert.equal(stripped.runtime_context[key], undefined, `${key} must be stripped from runtime context`);
}
assert.equal(stripped.runtime_context.cruise_decision_context, undefined);
assert.equal(stripped.runtime_context.strategy_fit_packet, undefined);
assert.equal(stripped.runtime_context.absorbed_cruise_obligation, undefined);
assert.equal(stripped.context.runtime_context.cruise_decision_context, undefined);
assert.deepEqual(stripped.context_pack, {
  scope: "mode",
  mode_id: "cruise",
  match_session_id: null,
  evidence_policy_id: HARD_DATA_EVIDENCE_POLICY_ID,
});

const oversized = {
  schema: "jcc-host-current-turn-delta-v1",
  ...capability,
  request_id: "hard-data-test",
  request_hash: "hard-data-test",
  mode: "cruise",
  user_message: "x".repeat(7000),
  strategy_context: { optional: "x".repeat(30000) },
  selected_ranking_candidates: null,
  live_state_summary: { board: "x".repeat(7000) },
  runtime_context: {
    current_turn_contract: {
      source_policy: {
        evidence_policy: HARD_DATA_EVIDENCE_POLICY_ID,
        forbidden_sources: ["daily_big_data", "strategy_wiki"],
      },
    },
    decision_math_context: { output: "x".repeat(7000) },
  },
};
const budgeted = enforceHostTurnDeltaBudget(oversized, 25000);
assert.equal(budgeted.request_kind, HARD_DATA_QUERY_REQUEST_KIND);
assert.equal(budgeted.evidence_policy_id, HARD_DATA_EVIDENCE_POLICY_ID);
assert.equal(budgeted.origin_action_id, HARD_DATA_ORIGIN_ACTION_ID);
assert.equal(budgeted.selected_ranking_candidates, null);
assert.equal(budgeted.runtime_context.current_turn_contract.source_policy.evidence_policy, HARD_DATA_EVIDENCE_POLICY_ID);

const persistedHardRef = hostRequestPersistenceRef(oversized, "hard-data-task");
assert.equal(persistedHardRef.schema, "jcc-host-request-ref-v1");
assert.equal(persistedHardRef.request_kind, HARD_DATA_QUERY_REQUEST_KIND);
assert.equal(persistedHardRef.evidence_policy_id, HARD_DATA_EVIDENCE_POLICY_ID);
assert.equal(persistedHardRef.origin_action_id, HARD_DATA_ORIGIN_ACTION_ID);
assert.equal(JSON.stringify(persistedHardRef).includes("daily_big_data"), false);

const s18Descriptor = JSON.parse(await readFile("data/game-knowledge/jcc/seasons/s18/season-descriptor.json", "utf8"));
const adaptedInputs = theorycraftDecisionInputs({
  own_board: { units: [{ name: "奥恩", star: 2 }] },
  active_traits: [{ name: "重装战士", count: 2 }],
}, {
  target_plan: { primary_carry: "奥恩" },
  choice_confirmations: [{ kind: "augment", selected_name: "飞升" }],
}, { seasonDescriptor: s18Descriptor });
assert.deepEqual(adaptedInputs.augments, ["飞升"]);
assert.equal(adaptedInputs.star, 2);
assert.deepEqual(adaptedInputs.defaulted_inputs.find((entry) => entry.field === "nature_sprite_effect"), {
  field: "nature_sprite_effect",
  default: null,
  season_scope: "s18",
  disclosure: "The active-season nature sprite effect was not confirmed and was omitted from the calculation.",
});
const confirmedSeasonInput = theorycraftDecisionInputs({ season_mechanics: ["181074"] }, {}, {
  seasonDescriptor: s18Descriptor,
});
assert.equal(confirmedSeasonInput.defaulted_inputs.some((entry) => entry.field === "nature_sprite_effect"), false);
const seasonWithoutDecisionMathInputs = theorycraftDecisionInputs({}, {}, {
  seasonDescriptor: { season_id: "s99", extensions: {} },
});
assert.equal(seasonWithoutDecisionMathInputs.defaulted_inputs.some((entry) => entry.season_scope), false);

const prompt = buildHostTurnDeltaPrompt({
  ...capability,
  request_id: "hard-data-prompt",
  request_hash: "hard-data-prompt",
  mode: "cruise",
  user_message: "给奥恩算理论装备",
  runtime_context: {
    context_policy: typedPolicy,
    current_turn_contract: {
      source_policy: { evidence_policy: HARD_DATA_EVIDENCE_POLICY_ID },
    },
  },
}, {
  capsule_id: "capsule",
  fingerprint: "fingerprint",
  route_key: "match:test",
});
assert.match(prompt, /explicit Cruise no-big-data action/);
assert.match(prompt, /forbids using it/);
assert.match(prompt, /Normal completed items are the default optimization pool/);
assert.match(prompt, /descriptor-declared optional decision-math inputs/);

const completeTheorycraftPrompt = buildHostTurnDeltaPrompt({
  ...capability,
  request_id: "complete-hard-data-prompt",
  request_hash: "complete-hard-data-prompt",
  mode: "cruise",
  user_message: "给我一套95阵容，并说明过渡、装备和强化",
  runtime_context: completeHardDataContext,
}, {
  capsule_id: "capsule",
  fingerprint: "fingerprint",
  route_key: "match:test",
});
assert.match(completeTheorycraftPrompt, /Do not claim that only champion names were supplied/);
assert.match(completeTheorycraftPrompt, /answer every requested component/);
assert.match(completeTheorycraftPrompt, /without asking the user to choose a carry or tank first/);
assert.match(completeTheorycraftPrompt, /strategy_evidence_plan/);
assert.match(completeTheorycraftPrompt, /multiple routes/);
assert.match(completeTheorycraftPrompt, /"strategy_evidence_coverage"/);
assert.match(completeTheorycraftPrompt, /"strategy_evidence_prefetch"/);
const nativeTheorycraftPrompt = buildHostTurnDeltaPrompt(completeHardDataRequest, {
  capsule_id: "capsule",
  fingerprint: "fingerprint",
  route_key: "match:test",
});
assert.match(nativeTheorycraftPrompt, /jcc\.query_knowledge and jcc\.calculate/);

const contract = JSON.parse(await readFile("data/runtime/jcc/host-request-context-policy-contract.json", "utf8"));
assert.equal(contract.hard_data_query_policy.evidence_policy_id, HARD_DATA_EVIDENCE_POLICY_ID);
assert.equal(contract.hard_data_query_policy.origin_action_id, HARD_DATA_ORIGIN_ACTION_ID);
assert.ok(contract.hard_data_query_policy.forbidden_sources.includes("winning_lineup_recipes_and_strategy_packages"));
const [runtimeSource, daemonSource, preloadSource, clientSource] = await Promise.all([
  readFile("ui/electron/runtime-service.js", "utf8"),
  readFile("ui/electron/runtime-daemon.js", "utf8"),
  readFile("ui/electron/preload.js", "utf8"),
  readFile("ui/electron/runtime-daemon-client.js", "utf8"),
]);
assert.match(runtimeSource, /case "sendCruiseHardDataQuery": return sendCruiseHardDataQuery\(body\)/);
assert.match(daemonSource, /"sendCruiseHardDataQuery"/);
assert.match(preloadSource, /sendCruiseHardDataQuery: \(text\) => invoke\("sendCruiseHardDataQuery", \{ text \}\)/);
assert.match(clientSource, /async sendCruiseHardDataQuery\(text\)/);
assert.doesNotMatch(runtimeSource, /seasonId\s*===\s*["']s18["']/);
assert.doesNotMatch(runtimeSource, /S18 sprite effects are season-scoped inputs/);
assert.doesNotMatch(runtimeSource, /S18 sprite effect was not confirmed/);

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-cruise-hard-data-query-verification-v1",
  checked: [
    "typed UI capability only",
    "generic sendMessage rejects forged hard-data capability fields",
    "dedicated Runtime action seals the registered capability internally",
    "ordinary copied text does not activate",
    "ranking and Wiki evidence stripped",
    "context pack reduced to identity",
    "hard-data identity survives emergency budget reduction",
    "metadata-only persistence retains the evidence capability identity",
    "descriptor-driven optional season inputs and disclosures enter the calculation adapter",
    "typed entity reward retrieval selects only the named official entity",
    "multi-item reward outcomes remain atomic",
    "orb and augment-probability queries load only their requested tables",
    "unrelated chat does not attach the hard-data query index",
    "trait-diversity lookup uses one no-emblem population shard and objective-specific frontiers",
    "4/5-cost ordering, accessibility fallback, common units, and population transitions remain atomic",
    "并肩作战 is excluded and emblem text receives only the declared conservative baseline",
    "Master+ overlap counts one champion once inside one canonical variant",
    "confirmed season input suppresses its default disclosure and undeclared seasons remain unchanged",
    "shared Runtime contains no S18 decision-math branch or sprite instruction",
    "Host prompt overrides persistent ranking memory for this turn",
    "Host prompt must consume executable current-Core multi-domain evidence",
    "native-tool turns reserve an adaptive 256 KiB minimum inside the complete 1 MiB target / 2 MiB maximum current-turn prompt and tool ledger",
    "same response-task revision advances remain valid while task replacement expires old tools",
    "choice report/revision and decision-action changes expire old tools inside the same Match",
    "response owner mode, Match, origin, and event identity changes expire empty and nonempty tool calls",
    "sealed no-big-data evidence reaches the real Codex item/tool/call handler without Ranking/Wiki",
    "direct request ID is not response task identity; first enrichment seals the explicit Runtime owner",
    "sealed direct get_lineup survives correction revision advance and rejects replaced owners without snapshot rewriting",
    "completed Match retaining its ID accepts a null-Match postgame review owner but expires the former active owner",
    "review tools preserve historical Match provenance, survive owner revision advance, and expire on Start Match without task replacement",
  ],
}, null, 2)}\n`);
