import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStrategyEvidenceKernelPacket,
  buildStrategyEvidenceStore,
  strategyEvidenceCapabilityManifest,
} from "../ui/electron/strategy-evidence-kernel.js";
import { createHostReadonlyToolBroker } from "../ui/electron/host-readonly-tool-broker.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const framework = JSON.parse(await readFile(path.join(
  repoRoot,
  "data/game-knowledge/jcc/common/strategy-evidence-framework.json",
), "utf8"));

const lineup = {
  executable: true,
  population: 9,
  roster: [
    { name: "五费主C", traits: ["羁绊A"], role: "carry", skill: { summary: "造成伤害" } },
    { name: "四费主坦", traits: ["羁绊A", "羁绊B"], role: "tank", skill: { summary: "获得护盾" } },
  ],
  trait_coverage: [{ name: "羁绊A", count: 2 }],
  semantic_seed: {
    schema: "jcc-semantic-seed-v1",
    seed_id: "seed:test",
    intent: "construct_or_evaluate_lineup",
    domains: ["lineup", "itemization", "formation"],
    objectives: ["cap", "best_fit"],
    selection_owner: "agent",
  },
  candidate_frontier: [
    { branch_id: "seed:test:branch:1", seed_id: "seed:test", selection_owner: "agent", expansion_owner: "runtime_deterministic" },
    { branch_id: "seed:test:branch:2", seed_id: "seed:test", selection_owner: "agent", expansion_owner: "runtime_deterministic" },
  ],
  transitions: [
    { population: 6, roster: [{ name: "低费过渡C" }], equipment_continuity: true, transitions_to: { population: 9 } },
    { population: 8, roster: [{ name: "四费主坦" }], equipment_continuity: true, transitions_to: { population: 9 } },
  ],
};
const decisionMath = {
  executable: true,
  operation: "compose_theorycraft_decision",
  profile: { core_profile_id: "core-s18-test" },
  components: {
    lineup,
    itemization: { executable: true, pareto_frontier: [{ items: ["A", "B", "C"] }] },
    augments: { executable: true, pareto_frontier: [{ id: "augment-1" }] },
  },
};
const hostRequest = {
  request_id: "request-95",
  request_kind: "hard_data_query",
  evidence_policy_id: "active_core_profile_only",
  user_message: "别吃大数据，给我一套上限最高的95阵容，并给6人口和8人口过渡、装备通用方案和强化选择。",
};
const runtimeContext = {
  knowledge_snapshot: { core_profile_id: "core-s18-test", ranking_overlay_id: "unavailable:core-s18-test" },
  game_rule_contract: { schema: "rules" },
  match_session: { match_session_id: "match-test" },
  match_facts: { stage_round: "2-1", equipment: { equipped_items: [] } },
  decision_math_context: decisionMath,
};

const packet = buildStrategyEvidenceKernelPacket({
  framework,
  hostRequest,
  runtimeMode: "cruise",
  runtimeContext,
  providerCapability: "native_dynamic_tools",
});

for (const route of ["lineup_construction", "transition_planning", "itemization", "augment_selection"]) {
  assert.ok(packet.plan.route_ids.includes(route), `missing multi-domain route ${route}`);
}
assert.equal(packet.coverage.status, "complete");
assert.equal(packet.coverage.missing_critical_facets.length, 0);
assert.ok(packet.coverage.receipts.some((row) => row.facet_id === "champion_trait_map" && row.state === "satisfied"));
assert.ok(packet.coverage.receipts.some((row) => row.facet_id === "semantic_seed" && row.state === "satisfied"));
assert.ok(packet.coverage.receipts.some((row) => row.facet_id === "candidate_frontier" && row.state === "satisfied"));
assert.ok(packet.coverage.receipts.some((row) => row.facet_id === "transition_candidates" && row.state === "satisfied"));
assert.ok(packet.coverage.receipts.some((row) => row.facet_id === "equipment_effects_and_fit" && row.state === "satisfied"));
assert.ok(packet.coverage.receipts.some((row) => row.facet_id === "augment_effects_and_fit" && row.state === "satisfied"));
assert.ok(packet.coverage.receipts.filter((row) => row.facet_id.startsWith("ranking_")).every((row) => row.state === "forbidden"));
assert.ok(Object.isFrozen(packet));
assert.ok(Object.isFrozen(packet.plan));
assert.equal(
  Object.keys(packet.prefetch.evidence).length,
  0,
  "native-tools mode must retrieve evidence on demand instead of duplicating it in the prompt",
);
assert.equal(packet.plan.agent_contract.semantic_seed_selection, "agent");
assert.equal(packet.plan.agent_contract.mechanical_expansion, "runtime_deterministic");
assert.ok(packet.plan.semantic_seed_ref, "plan sections must reference semantic evidence instead of copying it");
assert.ok(packet.plan.candidate_frontier_ref, "plan sections must reference candidate evidence instead of copying it");
assert.equal(packet.plan.semantic_seed, undefined);
assert.equal(packet.plan.candidate_frontier, undefined);
for (const receipt of packet.coverage.receipts.filter((row) => row.delivery?.startsWith("prefetched"))) {
  assert(receipt.evidence_keys.some((key) => Object.hasOwn(packet.prefetch.evidence, key)));
}
assert.equal(packet.materialization_policy.history_owner, "native_host_session_memory");
assert.equal(packet.materialization_policy.transcript_system, "forbidden");

const aliasRanking = { candidates: [{ candidate_id: "atomic-line", canonical_variant: { roster: [{ name: "A" }, { name: "B" }] } }] };
const aliasPacket = buildStrategyEvidenceKernelPacket({
  framework,
  hostRequest: { request_id: "alias-materialization", user_message: "当前版本热门阵容和大数据装备强化怎么看" },
  runtimeMode: "daily_chat",
  runtimeContext: {
    knowledge_snapshot: { core_profile_id: "core-s18-test", ranking_overlay_id: "ranking-test" },
    game_rule_contract: { schema: "rules" },
    selected_ranking_candidates: aliasRanking,
  },
  providerCapability: "prefetch_complete",
});
const rankingReceipts = aliasPacket.coverage.receipts.filter((row) => (
  ["ranking_observations", "ranking_lineup_candidates", "ranking_item_observations", "ranking_augment_associations"].includes(row.facet_id)
  && row.state === "satisfied"
));
assert(rankingReceipts.length >= 2, "ranking aliases must be exercised by the verifier");
assert.equal(new Set(rankingReceipts.map((row) => row.evidence_identity)).size, 1, "aliases must share one evidence identity");
assert.equal(new Set(rankingReceipts.flatMap((row) => row.evidence_keys)).size, 1, "aliases must share one canonical evidence key");
const rankingEvidenceKey = rankingReceipts[0].evidence_keys[0];
assert.equal(Object.keys(aliasPacket.prefetch.evidence).filter((key) => key === rankingEvidenceKey).length, 1);
assert.deepEqual(aliasPacket.prefetch.evidence[rankingEvidenceKey], aliasRanking, "atomic candidates must remain complete");
const rankingMaterialization = aliasPacket.materialization_policy.entries.find((entry) => entry.evidence_key === rankingEvidenceKey);
assert.equal(rankingMaterialization.contains_atomic_candidates, true);
assert(rankingReceipts.some((row) => row.delivery === "prefetched_reference"), "non-canonical aliases must be references");
assert.equal(JSON.stringify(aliasPacket).match(/atomic-line/g)?.length, 1, "one packet must fully materialize aliased evidence only once");

const aliasStore = buildStrategyEvidenceStore({
  evidencePacket: aliasPacket,
  hostRequest: { request_id: "alias-materialization" },
  runtimeContext: { selected_ranking_candidates: aliasRanking },
});
for (const receipt of rankingReceipts) {
  assert.strictEqual(aliasStore[receipt.facet_id], aliasRanking, "receipts may resolve aliases to the same in-memory atomic value");
}

const revisedPacket = buildStrategyEvidenceKernelPacket({
  framework,
  hostRequest: { ...hostRequest, response_task_revision: 8 },
  runtimeMode: "cruise",
  runtimeContext: {
    ...runtimeContext,
    response_task_identity: {
      response_task_id: "request-95",
      response_task_revision: 8,
      decision_action_fingerprint: "action-v2",
    },
    choice_context_identity: {
      choice_kind: "augment",
      stage_round: "3-2",
      report_id: "report-2",
      choice_set_revision: 2,
    },
  },
  providerCapability: "native_dynamic_tools",
});
assert.notEqual(
  revisedPacket.evidence_snapshot.evidence_snapshot_id,
  packet.evidence_snapshot.evidence_snapshot_id,
  "response/card revision changes must create a distinct immutable evidence snapshot",
);

const capability = strategyEvidenceCapabilityManifest(framework, "native_dynamic_tools");
assert.deepEqual(capability.tools, ["jcc.query_knowledge", "jcc.calculate"]);

const evidenceStore = Object.fromEntries(packet.coverage.receipts
  .filter((row) => row.state === "satisfied")
  .map((row) => [row.facet_id, { facet: row.facet_id }]));
const broker = createHostReadonlyToolBroker({
  evidencePacket: packet,
  evidenceStore,
  calculate: async (question) => ({ executable: true, question }),
});
const queryResult = await broker.call("jcc.query_knowledge", {
  route_ids: ["lineup_construction"],
  facets: ["champion_trait_map", "ranking_observations"],
  entity_names: ["五费主C"],
});
assert.equal(queryResult.evidence_snapshot_id, packet.evidence_snapshot.evidence_snapshot_id);
assert.ok(queryResult.receipts.some((row) => row.facet_id === "champion_trait_map"));
assert.ok(!Object.hasOwn(queryResult.evidence, "ranking_observations"));
assert.deepEqual(queryResult.requested_entity_names, ["五费主C"]);
const calculation = await broker.call("jcc.calculate", { question: "五阶段输了，对面剩3个棋子扣多少血" });
assert.equal(calculation.result.executable, true);
assert.equal(calculation.evidence_snapshot_id, packet.evidence_snapshot.evidence_snapshot_id);

const boundedBroker = createHostReadonlyToolBroker({
  evidencePacket: packet,
  evidenceStore,
  maxTotalCalls: 6,
  maxCallsPerTool: 6,
  calculate: async (question) => ({ executable: true, question }),
});
for (let call = 0; call < 6; call += 1) {
  await boundedBroker.call("jcc.calculate", { question: `call-${call}` });
}
await assert.rejects(
  boundedBroker.call("jcc.calculate", { question: "call-7" }),
  /tool call budget exceeded/,
);

const incomplete = buildStrategyEvidenceKernelPacket({
  framework,
  hostRequest: { request_id: "missing", user_message: "帮我搭一套95阵容" },
  runtimeMode: "daily_chat",
  runtimeContext: { knowledge_snapshot: { core_profile_id: "core-s18-test" }, game_rule_contract: { schema: "rules" } },
});
assert.equal(incomplete.coverage.status, "partial");
assert.ok(incomplete.coverage.missing_critical_facets.includes("legal_roster_solution"));

const lobbyMeta = buildStrategyEvidenceKernelPacket({
  framework,
  hostRequest: { request_id: "lobby-meta", user_message: "聊一下当前上分思路" },
  runtimeMode: "daily_chat",
  runtimeContext: {
    knowledge_snapshot: { core_profile_id: "core-s18-test" },
    game_rule_contract: { schema: "rules" },
    selected_ranking_candidates: { candidates: [{ display_name: "版本运营" }] },
  },
  providerCapability: "native_dynamic_tools",
});
assert.ok(lobbyMeta.plan.route_ids.includes("lobby_meta_strategy"), "lobby meta questions should use the lobby strategy route");
assert.ok(!lobbyMeta.plan.route_ids.includes("current_match_strategy"), "lobby meta questions must not use current-match strategy route");
assert.ok(!lobbyMeta.coverage.missing_critical_facets.includes("current_match_state"), "lobby meta route must not require current match facts");

const nativeLobbyMeta = buildStrategyEvidenceKernelPacket({
  framework,
  hostRequest: { request_id: "native-lobby-meta", user_message: "聊一下当前上分思路" },
  runtimeMode: "daily_chat",
  runtimeContext: {
    knowledge_snapshot: {
      core_profile_id: "core-s18-test",
      ranking_overlay_id: "ranking-s18-master-plus-test",
    },
    current_turn_contract: {
      source_policy: {
        live_rankings: { active_for_turn: true },
      },
    },
    daily_big_data: {
      available: true,
      ranking_overlay_id: "ranking-s18-master-plus-test",
      ranking_strength_available: true,
      ranking_scope: {
        required_ranking_label: "master_plus",
        selected_tier_ids: ["0"],
      },
    },
    game_rule_contract: { schema: "rules" },
  },
  providerCapability: "native_dynamic_tools",
});
const nativeRankingReceipt = nativeLobbyMeta.coverage.receipts.find((row) => row.facet_id === "ranking_observations");
assert.equal(nativeLobbyMeta.coverage.status, "complete", "retrievable native Ranking evidence must satisfy lobby coverage");
assert.equal(nativeRankingReceipt?.state, "satisfied", "an unprefetched native Ranking source is available, not degraded");
assert.equal(nativeRankingReceipt?.delivery, "snapshot_bound_tool", "native Ranking evidence must be retrieved through the bound tool");
assert.equal(nativeRankingReceipt?.source_domain, "ranking");
assert.equal(nativeRankingReceipt?.reason, null);
assert.equal(Object.keys(nativeLobbyMeta.prefetch.evidence).length, 0, "native Ranking evidence must not be redundantly prefetched");

const unavailableNativeLobbyMeta = buildStrategyEvidenceKernelPacket({
  framework,
  hostRequest: { request_id: "native-lobby-meta-unavailable", user_message: "聊一下当前上分思路" },
  runtimeMode: "daily_chat",
  runtimeContext: {
    knowledge_snapshot: {
      core_profile_id: "core-s18-test",
      ranking_overlay_id: "unavailable:core-s18-test",
    },
    current_turn_contract: {
      source_policy: {
        live_rankings: { active_for_turn: false },
      },
    },
    daily_big_data: {
      available: false,
      unavailable_reason: "compatible_master_plus_rankings_unavailable",
    },
    game_rule_contract: { schema: "rules" },
  },
  providerCapability: "native_dynamic_tools",
});
const unavailableRankingReceipt = unavailableNativeLobbyMeta.coverage.receipts.find((row) => row.facet_id === "ranking_observations");
assert.equal(unavailableNativeLobbyMeta.coverage.status, "partial", "a native tool must not invent an unavailable Ranking source");
assert.equal(unavailableRankingReceipt?.state, "degraded");
assert.equal(unavailableRankingReceipt?.delivery, null);

const mismatchedNativeLobbyMeta = buildStrategyEvidenceKernelPacket({
  framework,
  hostRequest: { request_id: "native-lobby-meta-mismatch", user_message: "聊一下当前上分思路" },
  runtimeMode: "daily_chat",
  runtimeContext: {
    knowledge_snapshot: {
      core_profile_id: "core-s18-test",
      ranking_overlay_id: "ranking-bound-to-turn",
    },
    current_turn_contract: {
      source_policy: {
        live_rankings: { active_for_turn: true },
      },
    },
    daily_big_data: {
      available: true,
      ranking_overlay_id: "ranking-from-another-snapshot",
      ranking_strength_available: true,
    },
    game_rule_contract: { schema: "rules" },
  },
  providerCapability: "native_dynamic_tools",
});
const mismatchedRankingReceipt = mismatchedNativeLobbyMeta.coverage.receipts.find((row) => row.facet_id === "ranking_observations");
assert.equal(mismatchedNativeLobbyMeta.coverage.status, "partial", "a foreign Ranking overlay must fail closed");
assert.equal(mismatchedRankingReceipt?.state, "degraded");

const postgame = buildStrategyEvidenceKernelPacket({
  framework,
  hostRequest: { request_id: "postgame-review", user_message: "复盘上一局为什么第四" },
  runtimeMode: "postgame_review",
  runtimeContext: {
    knowledge_snapshot: { core_profile_id: "core-s18-test" },
    game_rule_contract: { schema: "rules" },
    recent_match_decision_summaries: [{ match_session_id: "closed-1", result_rank: 4 }],
  },
  providerCapability: "native_dynamic_tools",
});
assert.ok(postgame.plan.route_ids.includes("postgame_review_strategy"), "postgame questions should use the review route");
assert.ok(!postgame.plan.route_ids.includes("current_match_strategy"), "postgame review must not use current-match strategy route");
assert.ok(postgame.coverage.receipts.some((row) => row.facet_id === "recent_match_decision_summaries"), "postgame review should require historical summaries");
assert.ok(!postgame.coverage.missing_critical_facets.includes("recent_match_decision_summaries"), "postgame summaries should be available to the review route");

const fallbackBudgetFailure = buildStrategyEvidenceKernelPacket({
  framework,
  hostRequest,
  runtimeMode: "cruise",
  runtimeContext,
  providerCapability: "prefetch_complete",
  maxPrefetchBytes: 64,
});
assert.equal(fallbackBudgetFailure.coverage.status, "partial");
assert(
  fallbackBudgetFailure.coverage.receipts.some((row) => row.criticality === "critical" && row.reason === "prefetch_budget_exceeded"),
  "a no-tool provider must not claim satisfied coverage when evidence is absent from the payload",
);

console.log(JSON.stringify({ ok: true, schema: "jcc-strategy-evidence-kernel-verification-v1" }));
