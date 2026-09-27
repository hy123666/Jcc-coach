import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import {
  compactLineupGroups,
  compactHostTurnDelta,
  HOST_TURN_DELTA_MAX_BYTES,
  hostContextCapsuleForRequest,
  readLiveRankingsSummary,
  rankRankingCandidatesForCurrentSnapshot,
  selectRelevantRankingCandidates,
  compactStrategyFitPacketForTurn,
  buildStrategyFitPacket,
  atomicStrategyVariantViews,
  rankingCandidateQuality,
  hostRequestIsStrategicTurn,
  hostRequestNeedsStrategicRanking,
  setRuntimeServiceState,
  validateLiveRankingArtifactIdentity,
} from "../ui/electron/runtime-service.js";

setRuntimeServiceState({
  active_mode: "cruise",
  match_session: { status: "active", match_session_id: "verify-ranking-strategy-runtime" },
  match_context: {},
  user_preferences: { rank_tier: "master" },
});

const runtimePaths = createRuntimePaths(path.resolve(import.meta.dirname, ".."));
const firstArray = (value) => Array.isArray(value) ? value : [];
const activeDailyBigData = await readLiveRankingsSummary();
assert.equal(activeDailyBigData.available, true, "the compatible current Master+ overlay must be readable by Runtime");
assert.deepEqual(Object.keys(activeDailyBigData.tiers || {}), ["0"], "Runtime must expose only the current Master+ ranking tier");
assert.match(String(activeDailyBigData.stat_date || ""), /^\d{8}$/, "the active ranking must retain a valid fetched current-day stat date");
assert.equal(activeDailyBigData.ranking_overlay_id, runtimePaths.activeRankingGenerationId, "Runtime summary must point at the active ranking generation");
const activeStrategyIndex = JSON.parse(await readFile(runtimePaths.liveRankingsStrategyIndexFile, "utf8"));
const activeTraitRows = firstArray(activeStrategyIndex.tiers?.["0"]?.lineup_candidates);
const activeStrengthRows = firstArray(activeStrategyIndex.tiers?.["0"]?.strength_anchors);
const allActiveTraitRows = [...activeTraitRows, ...activeStrengthRows];
const unresolvedActiveTraits = allActiveTraitRows.flatMap((row) => [
  ...firstArray(row.main_trait_list),
  ...firstArray(row.main_trait_list_secondary),
  ...firstArray(row.traits),
]).filter((trait) => !trait?.trait_name || /^未知羁绊/u.test(String(trait.trait_name)));
assert.equal(unresolvedActiveTraits.length, 0, "every production trait semantic must have a readable current-Core name");
assert(
  allActiveTraitRows.flatMap((row) => firstArray(row.main_trait_list || row.traits))
    .every((trait) => trait?.canonical_trait_id && !Object.hasOwn(trait, "family_id")),
  "production trait semantics must use canonical Core identities and must not expose raw family ids",
);
const knownBoundFamily = "846601";
const knownBoundCandidate = activeTraitRows.find((row) => row?.canonical_lineup_identity?.active_traits
  ?.some((trait) => String(trait?.trait_id || "") === "454" && Number(trait?.count) === 10));
assert(knownBoundCandidate?.canonical_lineup_identity?.active_traits?.length,
  `the active Master+ index must retain canonical roster-derived semantics for source row ${knownBoundFamily}`);
const knownBoundVariant = firstArray(knownBoundCandidate?.variants)[0];
assert.equal(knownBoundVariant?.roster_unit_count, 11,
  "the active ten-Rift roster must retain all eleven fielded entities");
assert.equal(knownBoundVariant?.occupied_population, 12,
  "the active ten-Rift roster must count the multi-population Dragon as two slots");
assert.equal(knownBoundVariant?.population, 10,
  "the active ten-Rift roster must be fieldable from base team size ten");
assert.equal(knownBoundVariant?.team_size_bonus, 2);
assert.equal(knownBoundVariant?.effective_team_size, 12);
assert.equal(knownBoundVariant?.population_legal, true);
assert.equal(firstArray(knownBoundVariant?.atomic_roster_members)
  .find((unit) => String(unit?.champion_id || "") === "5458")?.population_cost, 2,
  "the active Dragon member must retain its Core-declared population cost");
const activeForestNine = activeTraitRows.find((row) => row?.source_strength_anchor?.signature?.display_key === "永恒之森9");
assert.equal(activeForestNine?.main_trait_list?.find((trait) => String(trait?.trait_id || "") === "450")?.count, 9,
  "the active Forest-nine candidate must count every Lux form as two selected-trait contributions");
const activeInfernoSeven = activeTraitRows.find((row) => row?.source_strength_anchor?.signature?.display_key === "地狱火7");
assert.equal(activeInfernoSeven?.main_trait_list?.find((trait) => String(trait?.trait_id || "") === "458")?.count, 7,
  "the active Inferno-seven candidate must retain the source-declared Ranking trait state");
assert.equal(activeInfernoSeven?.strength_anchor?.traits?.find((trait) => String(trait?.canonical_trait_id || "") === "458")?.breakpoint, 7,
  "the active strength anchor must not be relabeled from Inferno seven to a lower derived count");
assert(firstArray(activeInfernoSeven?.variants).every((variant) => variant?.trait_state_reconciliation),
  "every active source-declared Ranking variant must carry an explicit trait-state reconciliation receipt");
const activeInfernoFive = activeTraitRows.find((row) => row?.source_strength_anchor?.signature?.display_key === "地狱火5");
assert.equal(activeInfernoFive?.main_trait_list?.find((trait) => String(trait?.trait_id || "") === "458")?.count, 5,
  "the active Inferno-five candidate must retain the source-declared Ranking trait state");
const activeLuxMembers = activeTraitRows.flatMap((candidate) => firstArray(candidate?.variants))
  .flatMap((variant) => firstArray(variant?.atomic_roster_members))
  .filter((unit) => String(unit?.champion_id || "") === "5459");
assert(activeLuxMembers.length > 0, "the active Ranking must contain at least one mapped Lux form");
assert(activeLuxMembers.every((unit) => firstArray(unit?.special_trait_contributions)
  .some((contribution) => contribution?.trait_name && Number(contribution?.value) === 2)),
  "every active Ranking Lux form must expose one readable selected-trait contribution of two");
const knownBoundBreakpointFromId = 10;
assert.equal(
  knownBoundCandidate.source_strength_anchor?.signature?.traits
    ?.find((trait) => String(trait?.canonical_trait_id || "") === "454")
    ?.breakpoint,
  knownBoundBreakpointFromId,
  "official source semantics must bind the Ranking breakpoint to the current Core trait",
);
assert.equal(knownBoundCandidate.provenance?.source_anchor_id, "national:846601:10",
  "raw source identity must remain available only in provenance for audit and update correlation");
const summonInfernoCandidate = activeTraitRows.find((row) => {
  const names = firstArray(row.main_trait_list).map((trait) => trait.trait_name);
  return names.includes("召唤师") && names.includes("地狱火") && names.includes("裁决使");
});
assert(summonInfernoCandidate, "a current Master+ source row must be addressable through canonical source semantics");
const summonInfernoTraitNames = firstArray(summonInfernoCandidate.main_trait_list).map((trait) => trait.trait_name);
assert(summonInfernoTraitNames.includes("召唤师") && summonInfernoTraitNames.includes("地狱火") && summonInfernoTraitNames.includes("裁决使"),
  "the summon/inferno/executioner roster must derive its real traits from the current Core roster");
assert.equal(summonInfernoTraitNames.includes("峡谷野怪"), false,
  "raw family 847001 must never force this roster to display the incorrect 峡谷野怪 semantic");
assert.match(String(summonInfernoCandidate.provenance?.source_anchor_id || ""), /^national:/,
  "the raw source row remains an audit receipt rather than a candidate identity");
const canyonSummary = activeDailyBigData.tiers?.["0"]?.top_traits
  ?.find((row) => row?.main_traits?.some((trait) => (
    String(trait?.canonical_trait_id || trait?.trait_id || "") === "454"
      && Number(trait?.hero_num ?? trait?.breakpoint ?? trait?.count) === 10
  )));
assert.equal(canyonSummary?.display_name, "峡谷野怪10",
  "Runtime must expose the canonical official trait title instead of an unresolved raw family id");
assert.equal(canyonSummary?.unresolved_traits?.length, 0,
  "canonical official trait rows must not be marked unresolved in the Host ranking summary");
const sourceFamilyAudit = activeStrategyIndex.tiers?.["0"]?.data_quality?.source_family_audit;
assert(sourceFamilyAudit, "the active strategy index must retain a bounded raw source-family audit receipt");
assert.equal(sourceFamilyAudit.production_semantic_binding_disabled, true,
  "raw source-family ids must never become production semantic authority");
assert(sourceFamilyAudit?.strategy_source_family_count > 0,
  "the source audit must retain strategy-row identity counts for update correlation");
assert.equal(sourceFamilyAudit.strategy_source_family_count, sourceFamilyAudit.strategy_source_family_ids?.length,
  "the strategy source-family audit count must match its source identity list");
assert(sourceFamilyAudit?.snapshot_source_family_count >= sourceFamilyAudit?.strategy_source_family_count,
  "the snapshot source-family audit may be wider than the strategy subset but cannot be narrower");
assert.deepEqual(sourceFamilyAudit?.forbidden_roles,
  ["user_visible_trait_name", "query_key", "candidate_merge_key", "agent_semantic_identity"],
  "the source audit must explicitly forbid every semantic use of raw source-family ids");
assert.equal(Object.hasOwn(activeStrategyIndex.tiers?.["0"]?.data_quality || {}, "trait_identity_binding"), false,
  "the production strategy index must not publish a legacy raw-family binding object");
assert.equal(Object.hasOwn(runtimePaths, "liveRankingsSnapshotFile"), false, "match runtime paths must not expose the raw ranking snapshot");
assert.equal(Object.hasOwn(runtimePaths, "liveRankingsTrendSummaryFile"), false,
  "match runtime paths must not expose retained history or trend-summary files");
const unavailableSelection = selectRelevantRankingCandidates({
  ...activeDailyBigData,
  available: false,
  ranking_overlay_id: null,
  tiers: {},
}, {
  request_id: "verify-ranking-unavailable",
  request_hash: "verify-ranking-unavailable",
  mode: "cruise",
  task: { type: "direct_chat" },
  user_message: "查询当前排名阵容",
  user_preferences: { rank_tier: "master" },
  runtime_context: { match_facts: {} },
  context: {},
});
assert.equal(unavailableSelection, null, "ranking-dependent retrieval must fail closed when the compatible overlay is unavailable");

const carry = { champion_id: "synthetic-carry", champion_name: "合成主C", cost: 4 };
const augmentName = "合成强化";
const itemName = "合成主C装备";
const richCandidate = {
  id: "synthetic-rich-lineup",
  display_name: "合成兼容阵容",
  main_traits: ["合成羁绊4"],
  summary: {
    top1_rate: 0.18,
    top4_rate: 0.63,
    use_rate: 0.04,
    source_interpretation: "national_trait_ranking_primary_strength_evidence",
  },
  strategy_profile: {
    strength_anchor: {
      anchor_id: "synthetic-strength",
      metrics: { top1_rate: 0.18, top4_rate: 0.63, use_rate: 0.04 },
      quality: {
        current_day_score: 0.731,
        floor_score: 0.67,
        ceiling_score: 0.79,
        reliability_score: 0.35,
      },
      trend_evidence: {
        observation_count: 3,
        current_stat_date: "20990101",
        top4_rate_direction: "rising",
        may_affect_current_day_score: false,
        may_affect_current_day_order: false,
      },
    },
    main_carry: carry,
    formation_profile: {
      schema: "jcc-lineup-formation-profile-v1",
      authority: "parallel_to_national_strength_not_a_strength_adjustment",
      target_population: 8,
      burden_band: "medium",
      estimated_burden_score: 0.51,
      evidence_coverage: 0.8,
      unknowns: ["required_star_targets_not_explicit"],
    },
    core_units: [carry, { champion_id: "synthetic-tank", champion_name: "合成前排" }],
    associated_augments: [{ augment_id: "synthetic-augment", augment_name: augmentName }],
    recipe_match: { classification: "exact" },
    variants: [{
      variant_id: "synthetic-rich-variant",
      population: 8,
      lineup_names: [carry.champion_name, "合成前排"],
      main_carry_items: [{ item_id: "synthetic-item", item_name: itemName }],
      transitions: [{ population: 6, lineup_names: ["合成过渡"] }],
      formation_profile: {
        schema: "jcc-lineup-formation-profile-v1",
        authority: "parallel_to_national_strength_not_a_strength_adjustment",
        target_population: 8,
        burden_band: "medium",
        estimated_burden_score: 0.51,
        evidence_coverage: 0.8,
        unknowns: ["required_star_targets_not_explicit"],
      },
    }],
  },
};
const fillerCandidates = Array.from({ length: 99 }, (_, index) => ({
  id: `synthetic-filler-${index + 1}`,
  display_name: `合成候选${index + 1}`,
  main_traits: [`合成羁绊${index + 1}`],
  summary: { top1_rate: 0.1, top4_rate: 0.5, use_rate: 0.001 },
  strategy_profile: {
    main_carry: { champion_id: `filler-${index + 1}`, champion_name: `候选主C${index + 1}` },
    core_units: [],
    variants: [{ variant_id: `filler-variant-${index + 1}`, lineup_names: [`候选主C${index + 1}`] }],
  },
}));
const fixtureLineups = [richCandidate, ...fillerCandidates];
const dailyBigData = {
  schema: "jcc-live-rankings-host-context-summary-v1",
  available: true,
  ranking_overlay_id: "synthetic-compatible-overlay",
  stat_date: "20990101",
  tiers: {
    "0": {
      label: "master_plus",
      top_lineups: fixtureLineups.slice(0, 25),
      lineup_groups: fixtureLineups,
      reverse_indexes: {
        augment: { lineups_by_entity_id: { "synthetic-augment": [richCandidate.id] }, names_by_entity_id: { "synthetic-augment": augmentName } },
        champion: { lineups_by_entity_id: { [carry.champion_id]: [richCandidate.id] }, names_by_entity_id: { [carry.champion_id]: carry.champion_name } },
        item: { lineups_by_entity_id: { "synthetic-item": [richCandidate.id] }, names_by_entity_id: { "synthetic-item": itemName } },
        trait: { lineups_by_entity_id: {}, names_by_entity_id: {} },
      },
      hero_profiles: [],
    },
  },
};
const strategyIndex = {
  tiers: {
    "0": {
      lineup_candidates: [{
        lineup_group_id: richCandidate.id,
        variants: richCandidate.strategy_profile.variants,
      }],
    },
  },
};
const liveSummaryBytes = Buffer.byteLength(JSON.stringify(dailyBigData));
assert(liveSummaryBytes < 2_500_000, `cached runtime ranking summary must remain bounded, got ${liveSummaryBytes} bytes`);
const runtimeSource = await readFile("ui/electron/runtime-service.js", "utf8");
const summaryStart = runtimeSource.indexOf("async function readLiveRankingsSummary");
const summaryEnd = runtimeSource.indexOf("function readHostRuntimeContextPolicyContract", summaryStart);
assert(summaryStart >= 0 && summaryEnd > summaryStart);
assert.equal(runtimeSource.slice(summaryStart, summaryEnd).includes("snapshot.json"), false, "live match ranking summary must not parse the raw ranking snapshot");
const directPipelineStart = runtimeSource.indexOf("async function runPipelineForMessage");
const directPipelineEnd = runtimeSource.indexOf("async function requestPendingHostCoach", directPipelineStart);
assert(directPipelineStart >= 0 && directPipelineEnd > directPipelineStart);
assert.equal(
  runtimeSource.slice(directPipelineStart, directPipelineEnd).includes("liveRankings: liveRankingsStrategyIndexFile"),
  true,
  "direct match coaching must use the active detailed Ranking strategy index, not the summary-only rank signal",
);
const masterTier = dailyBigData?.tiers?.["0"];
assert.equal(masterTier?.label, "master_plus");
assert.equal(masterTier.lineup_groups.length, 100, "synthetic compatible overlay must retain its complete Master+ fixture pool");
assert.equal(masterTier.lineup_groups.some((candidate) => Object.hasOwn(candidate, "trend")), false,
  "raw historical trend records must not enter live-match ranking candidates");
assert.equal(Object.hasOwn(dailyBigData, "latest_diff"), false, "historical day-over-day diff must not enter live-match Host context");
assert.equal(Object.hasOwn(dailyBigData, "previous_stat_date"), false, "previous ranking dates must not enter live-match Host context");

const sourceCandidate = richCandidate;
const request = {
  request_id: "verify-ranking-main-carry-search",
  request_hash: "verify-ranking-main-carry-search",
  mode: "cruise",
  task: { type: "direct_chat" },
  user_message: carry.champion_name,
  user_preferences: { rank_tier: "master" },
  daily_big_data: dailyBigData,
  season_catalog: {
    champion_names: [carry.champion_name],
    champions_by_cost: {
      [String(carry.cost || "unknown")]: [{
        name: carry.champion_name,
        ranking_ids: [carry.champion_id],
        ids: [carry.champion_id],
      }],
    },
    traits: [],
  },
  runtime_context: { match_facts: {} },
  context: {},
};

const selected = selectRelevantRankingCandidates(dailyBigData, request);
const selectedWorkingSetBytes = Buffer.byteLength(JSON.stringify(selected));
assert(selectedWorkingSetBytes <= 512 * 1024, `pre-hydration ranking working set must remain lightweight, got ${selectedWorkingSetBytes} bytes`);

const preBoundPool = Array.from({ length: 11 }, (_, index) => {
  const candidate = structuredClone(activeTraitRows[0]);
  candidate.id = `snapshot-scoring-fixture-${String(index).padStart(2, "0")}`;
  candidate.candidate_evidence_id = `evidence:${candidate.id}`;
  const variant = structuredClone(candidate.variants[0]);
  variant.variant_id = `${candidate.id}:variant`;
  variant.candidate_evidence_id = `evidence:${variant.variant_id}`;
  if (index < 10) {
    variant.atomic_roster_members = variant.atomic_roster_members.map((unit, slot) => ({
      ...unit, champion_id: `${candidate.id}:unit:${slot}`, champion_name: `Fixture ${index} unit ${slot}`,
    }));
    variant.lineup_names = variant.atomic_roster_members.map((unit) => unit.champion_name);
    variant.lineup_ids = variant.atomic_roster_members.map((unit) => unit.champion_id);
  }
  candidate.variants = [variant];
  return candidate;
});
assert.equal(preBoundPool.length, 11, "ranking fixture must expose an eleventh legal candidate");
for (const candidate of preBoundPool) {
  if (candidate?.strength_anchor?.quality) candidate.strength_anchor.quality.current_day_score = 0.5;
  if (candidate?.strategy_profile?.strength_anchor?.quality) {
    candidate.strategy_profile.strength_anchor.quality.current_day_score = 0.5;
  }
}
const eleventh = preBoundPool[10];
eleventh.strength_anchor.quality.current_day_score = 1;
const eleventhRoster = firstArray(eleventh?.variants?.[0]?.atomic_roster_members)
  .map((entry) => ({ name: entry?.champion_name || entry?.name || entry }))
  .filter((entry) => entry.name);
const snapshotRanked = rankRankingCandidatesForCurrentSnapshot(dailyBigData, {
  candidates: preBoundPool,
  requested_display_count: 5,
}, {
  liveStateSummary: {
    phase: { stage_round: "4-2" },
    economy: { hp: 60, gold: 30, level: 8 },
    own_board: { units: eleventhRoster },
    own_bench: { units: [] },
    shop: { units: [] },
  },
  matchFacts: {},
  rulesBundle: {
    base_game_rules: { economy_management: {} },
    patch_strategy_overrides: {},
  },
});
assert.equal(snapshotRanked.candidates.length, 11, "scoring must preserve the full pool for subsequent pages");
assert(snapshotRanked.candidates.slice(0, 10).some((candidate) => candidate.candidate_id === eleventh.id),
  "snapshot scoring must run before the ten-candidate boundary so the prior eleventh candidate can enter");
assert(snapshotRanked.candidates.every((candidate) => candidate.fit_weights && Number.isFinite(candidate.combined_fit_score)),
  "every retained candidate must carry the registered five-component snapshot score");
const lobbyRanked = rankRankingCandidatesForCurrentSnapshot(dailyBigData, { candidates: preBoundPool });
assert.deepEqual(lobbyRanked.candidates.map((candidate) => candidate.id), preBoundPool.map((candidate) => candidate.id),
  "a lobby without verified Match state must preserve its source Ranking order");

const strategicCheckpointPacket = buildStrategyFitPacket({
  liveStateSummary: {
    phase: { stage_round: "2-2" },
    economy: { hp: 80, gold: 50, level: 4, xp: { value: 0, to_next: 10 } },
  },
  matchFacts: {},
  dailyBigData,
  selectedRankingCandidates: {
    ...selected,
    candidates: activeTraitRows.slice(0, 12),
    candidate_working_set_count: Math.min(12, activeTraitRows.length),
    candidate_working_set_limit: Math.min(12, activeTraitRows.length),
  },
  gameRuleContract: { stage_round: "2-2" },
  gameStateBrief: { stage_round: "2-2" },
  cruiseDecisionContext: {
    current_board_shop_bench: { board_units: [], bench_units: [], shop_units: [] },
    equipment: {},
    economic_decision_context: {},
  },
  activeRulesBundle: {
    base_game_rules: { economy_management: {} },
    patch_strategy_overrides: {},
  },
});
assert.equal(strategicCheckpointPacket.strategic_checkpoint?.checkpoint_id, "direction_exploration",
  "2-2 strategy packets must carry the registered exploration checkpoint");
assert.equal(strategicCheckpointPacket.next_coach_plan?.proactive_focus_policy?.max_decisions_per_answer, 8,
  "a fixed strategy checkpoint must not inherit the ordinary one-or-two-decision answer cap");
assert(strategicCheckpointPacket.candidate_working_set.length >= 5
  && strategicCheckpointPacket.candidate_working_set.length <= 10,
  "a fixed strategy checkpoint must retain a bounded complete candidate working set");
assert(strategicCheckpointPacket.candidate_working_set[0]?.canonical_variant,
  "a fixed strategy checkpoint must retain complete atomic variant evidence");
assert(strategicCheckpointPacket.candidate_lines.every((candidate) => !candidate.canonical_variant),
  "candidate references must not duplicate complete atomic candidate evidence");
assert(strategicCheckpointPacket.candidate_working_set_source_count >= strategicCheckpointPacket.candidate_working_set_count,
  "candidate source count must remain audit metadata rather than inflate the working set");
const compactStrategicCheckpointPacket = compactStrategyFitPacketForTurn(strategicCheckpointPacket, {
  mode: "cruise",
  currentStageRound: "2-2",
});
assert.equal(compactStrategicCheckpointPacket.strategic_checkpoint?.checkpoint_id, "direction_exploration",
  "strategic checkpoint identity must survive the Host turn compaction path");
assert(compactStrategicCheckpointPacket.candidate_working_set.length >= 5
  && compactStrategicCheckpointPacket.candidate_working_set.length <= 10,
  "strategic Host turn compaction must preserve the bounded complete candidate working set");
const referencesOnlyPacket = compactStrategyFitPacketForTurn({
  candidate_lines: [{ candidate_id: "reference-only", display_name: "Reference only" }],
  candidate_frontier: [{ candidate_id: "reference-only", display_name: "Reference only" }],
  candidate_working_set_count: 8,
  candidate_working_set_limit: 8,
}, { mode: "cruise", currentStageRound: "2-2", strategic: true });
assert.equal(referencesOnlyPacket.candidate_working_set.length, 0,
  "reference-only candidate surfaces must never be promoted into the complete Host workset");
assert.equal(referencesOnlyPacket.candidate_working_set_available, false,
  "reference-only packets must expose unavailable complete evidence explicitly");

const browseRequest = {
  ...request,
  request_id: "verify-ranking-working-set-contract",
  request_hash: "verify-ranking-working-set-contract",
  user_message: "给我5套当前强势阵容",
  ranking_query_route_key: "daily:verify-ranking-working-set-contract",
  ranking_requested_count: 5,
};
const browseSelected = selectRelevantRankingCandidates(dailyBigData, browseRequest);
assert.equal(browseSelected.requested_display_count, 5, "Ranking retrieval must preserve the user's requested display count");
assert(browseSelected.candidate_working_set_count >= 5, "Ranking retrieval must prepare a wider working set than the requested display count");
assert.equal(browseSelected.agent_selected_display_count, null, "Agent owns final candidate selection; Runtime must not preselect the displayed count");
const browseDelta = compactHostTurnDelta({
  ...browseRequest,
  selected_ranking_candidates: browseSelected,
}, hostContextCapsuleForRequest(browseRequest, { routeKey: browseRequest.ranking_query_route_key }));
assert.equal(browseDelta.selected_ranking_candidates.requested_display_count, 5,
  "Host input must receive the requested display count");
assert(browseDelta.selected_ranking_candidates.candidate_working_set_count >= 5,
  "Host input must receive the wider candidate working set count");
assert.equal(browseDelta.selected_ranking_candidates.agent_selected_display_count, null,
  "Host input must leave final display selection to the Agent");

const currentnessCandidates = Array.from({ length: 14 }, (_, index) => ({
  id: `currentness-candidate-${index + 1}`,
  display_name: `时效候选${index + 1}`,
  main_traits: [`时效羁绊${index + 1}`],
  summary: {
    top1_rate: 0.25 - index / 100,
    top4_rate: 0.7 - index / 100,
    use_rate: 0.05 - index / 1000,
    quality_packet: {
      current_day_score: 0.9 - index / 100,
      currentness: {
        interpretation: index === 12
          ? "emerging_low_adoption_signal"
          : index === 13
            ? "legacy_carryover_risk"
            : "current_high_signal",
        authority: {
          does_not_change_current_day_strength: true,
          does_not_change_official_strength_order: true,
          selection_context_only: true,
        },
      },
    },
  },
  strategy_profile: {
    strength_anchor: {
      anchor_id: `currentness-anchor-${index + 1}`,
      quality: {
        current_day_score: 0.9 - index / 100,
        currentness: {
          interpretation: index === 12
            ? "emerging_low_adoption_signal"
            : index === 13
              ? "legacy_carryover_risk"
              : "current_high_signal",
          authority: {
            does_not_change_current_day_strength: true,
            does_not_change_official_strength_order: true,
            selection_context_only: true,
          },
        },
      },
    },
    main_carry: { champion_name: `时效主C${index + 1}` },
    canonical_variant: { lineup_names: [`时效主C${index + 1}`, `时效前排${index + 1}`] },
  },
}));
const currentnessDailyBigData = {
  schema: "jcc-live-rankings-host-context-summary-v1",
  available: true,
  ranking_overlay_id: "currentness-overlay",
  stat_date: "20990102",
  tiers: {
    "0": {
      label: "master_plus",
      top_lineups: currentnessCandidates,
      lineup_groups: currentnessCandidates,
      hero_profiles: [],
    },
  },
};
const currentnessBrowse = selectRelevantRankingCandidates(currentnessDailyBigData, {
  ...browseRequest,
  request_id: "verify-ranking-currentness-frontier",
  request_hash: "verify-ranking-currentness-frontier",
  ranking_query_route_key: "daily:verify-ranking-currentness-frontier",
  ranking_requested_count: 1,
  user_message: "给我1套当前值得关注的阵容",
  season_catalog: { champion_names: [], champions_by_cost: {}, traits: [] },
});
assert(currentnessBrowse.candidates.some((candidate) => candidate.id === "currentness-candidate-13"),
  "the bounded Agent working set must retain an emerging low-adoption candidate outside the official top slice");
assert(currentnessBrowse.candidates.some((candidate) => candidate.id === "currentness-candidate-14"),
  "the bounded Agent working set must retain a high-score carryover-risk comparison candidate");
assert.equal(currentnessBrowse.candidate_frontier_policy?.may_change_official_strength_ranking, false,
  "currentness coverage may widen Agent evidence but must not rewrite the official strength gradient");
assert.equal(currentnessBrowse.candidate_frontier_policy?.may_reorder_agent_working_set_for_evidence_coverage, true,
  "the bounded Agent working set may reorder candidates for currentness coverage while preserving official positions");
assert.equal(currentnessBrowse.agent_selected_display_count, null,
  "the Agent, not Runtime, must decide whether a currentness signal deserves final recommendation");
const currentnessDelta = compactHostTurnDelta({
  mode: "daily_chat",
  request_kind: "host_question",
  request_id: "verify-ranking-currentness-frontier-turn",
  request_hash: "verify-ranking-currentness-frontier-turn",
  user_message: "给我1套当前值得关注的阵容",
  ranking_query_route_key: "daily:verify-ranking-currentness-frontier-turn",
  selected_ranking_candidates: currentnessBrowse,
  runtime_context: {},
}, hostContextCapsuleForRequest({
  mode: "daily_chat",
  request_kind: "host_question",
  request_id: "verify-ranking-currentness-frontier-turn",
  request_hash: "verify-ranking-currentness-frontier-turn",
  user_message: "给我1套当前值得关注的阵容",
  ranking_query_route_key: "daily:verify-ranking-currentness-frontier-turn",
}, { routeKey: "daily:verify-ranking-currentness-frontier-turn" }));
assert.equal(currentnessDelta.selected_ranking_candidates?.candidate_frontier_policy?.may_change_official_strength_ranking, false,
  "the Host turn must receive the separate currentness-frontier authority boundary");
assert(currentnessDelta.selected_ranking_candidates?.candidates?.some((candidate) =>
  candidate.ranking_quality?.currentness_context?.interpretation === "emerging_low_adoption_signal"),
"the Host turn must receive the emerging currentness label instead of losing it during compaction");

const unknownSampleQuality = rankingCandidateQuality({
  summary: {
    top1_rate: 0.4,
    top4_rate: 0.9,
    use_rate: 0.01,
    quality_packet: {
      current_day_score: 0.9,
      floor_score: 0.8,
      ceiling_score: 0.95,
      reliability_score: 0.35,
      classification: "stable_high_ceiling",
      sample_band: "unknown",
      currentness: { sample: { status: "unavailable", band: "unknown" } },
    },
  },
});
assert.equal(unknownSampleQuality.quality_label, "current_strength_unverified_sample",
  "a high current-day score with unavailable sample count must not be labeled stable_strong");
assert.equal(unknownSampleQuality.sample_confidence, null,
  "sample confidence must remain unknown when the national trait group does not expose an observed count");

const variantViews = atomicStrategyVariantViews({
  id: "variant-formation-fixture",
  strategy_profile: {
    formation_profile: { burden_band: "high", estimated_burden_score: 0.9 },
    variants: [{
      variant_id: "lower-burden-variant",
      lineup_names: ["变体主C", "变体主坦"],
      formation_profile: { burden_band: "low", estimated_burden_score: 0.2 },
    }],
  },
});
assert.equal(variantViews[0].candidate.strategy_profile.formation_profile.estimated_burden_score, 0.2,
  "an atomic variant must carry its own formation burden instead of inheriting a sibling or group profile");

const directStrategyText = "结合当前阶段和本局条件，判断该继续、过渡还是转阵；有目标就校验，没有就给出 2-3 个可走方向和转向条件。我的目标或偏好（可留空）：";
const directStrategyCandidates = Array.from({ length: 12 }, (_, index) => ({
  candidate_id: `direct-strategy-candidate-${index + 1}`,
  candidate_evidence_id: `direct-strategy-evidence-${index + 1}`,
  selected_variant_id: `direct-strategy-variant-${index + 1}`,
  id: `direct-strategy-candidate-${index + 1}`,
  display_name: `主动请求候选${index + 1}`,
  main_traits: [`候选羁绊${index + 1}`],
  roster_is_atomic: true,
  atomic_roster_id: `direct-strategy-roster-${index + 1}`,
  atomic_roster_members: [
    { champion_id: `carry-${index + 1}`, champion_name: `主C${index + 1}`, occupies_population: true },
    { champion_id: `tank-${index + 1}`, champion_name: `前排${index + 1}`, occupies_population: true },
    { champion_id: `support-${index + 1}`, champion_name: `辅助${index + 1}`, occupies_population: true },
  ],
  strategy_profile: {
    main_carry: { champion_name: `主C${index + 1}` },
    canonical_variant: {
      variant_id: `direct-strategy-variant-${index + 1}`,
      candidate_evidence_id: `direct-strategy-evidence-${index + 1}`,
      roster_is_atomic: true,
      atomic_roster_id: `direct-strategy-roster-${index + 1}`,
      atomic_roster_members: [
        { champion_id: `carry-${index + 1}`, champion_name: `主C${index + 1}`, occupies_population: true },
        { champion_id: `tank-${index + 1}`, champion_name: `前排${index + 1}`, occupies_population: true },
        { champion_id: `support-${index + 1}`, champion_name: `辅助${index + 1}`, occupies_population: true },
      ],
      lineup_names: [`主C${index + 1}`, `前排${index + 1}`, `辅助${index + 1}`],
    },
  },
}));
const directStrategyRequest = {
  mode: "cruise",
  request_kind: "host_question",
  request_id: "verify-direct-strategy-turn",
  request_hash: "verify-direct-strategy-turn",
  user_message: directStrategyText,
  runtime_context: {
    schema: "jcc-runtime-host-request-context-v1",
    active_mode: "cruise",
    coach_content_agenda: {
      schema: "jcc-proactive-coach-content-agenda-v1",
      primary_focus: "lineup_direction_first",
      required_decisions: ["name_complete_ranking_backed_candidate_directions"],
    },
    strategy_fit_packet: {
      schema: "jcc-strategy-fit-packet-v1",
      candidate_working_set_count: 10,
      candidate_working_set: directStrategyCandidates,
      candidate_lines: directStrategyCandidates.slice(0, 3),
    },
  },
  selected_ranking_candidates: {
    schema: "jcc-live-rankings-selected-candidates-v1",
    ranking_overlay_id: activeDailyBigData.ranking_overlay_id,
    candidate_working_set_count: 10,
    candidate_working_set_limit: 10,
    candidates: directStrategyCandidates,
  },
};
assert.equal(hostRequestNeedsStrategicRanking(directStrategyRequest), true,
  "a natural-language lineup question in Cruise must request Ranking evidence");
assert.equal(hostRequestIsStrategicTurn(directStrategyRequest), true,
  "a natural-language lineup question in Cruise must receive the strategic turn budget");
assert.equal(hostRequestIsStrategicTurn({
  mode: "cruise",
  request_kind: "host_question",
  user_message: "现在要不要升人口，还是继续吃利息",
}), false, "a pure economy question must not consume the strategic lineup route");
assert.equal(hostRequestIsStrategicTurn({
  mode: "cruise",
  request_kind: "host_question",
  user_message: "整体装备建议，散件怎么合",
}), false, "a pure equipment question must not consume the strategic lineup route");
const directStrategyDelta = compactHostTurnDelta(
  directStrategyRequest,
  hostContextCapsuleForRequest(directStrategyRequest, { routeKey: "match:verify-direct-strategy-turn" }),
);
assert(directStrategyDelta.runtime_context.coach_content_agenda,
  "the direct strategic turn must carry the coach content agenda");
assert(
  Math.max(
    firstArray(directStrategyDelta.selected_ranking_candidates?.candidates).length,
    firstArray(directStrategyDelta.selected_ranking_candidates?.candidate_refs).length,
  ) >= 5
    && Math.max(
      firstArray(directStrategyDelta.selected_ranking_candidates?.candidates).length,
      firstArray(directStrategyDelta.selected_ranking_candidates?.candidate_refs).length,
    ) <= 10,
  "the direct strategic turn must preserve the bounded canonical Ranking working set",
);
assert(firstArray(directStrategyDelta.runtime_context.strategy_fit_packet?.candidate_working_set).length >= 5
  && firstArray(directStrategyDelta.runtime_context.strategy_fit_packet?.candidate_working_set).length <= 10,
  "the direct strategic turn must preserve the bounded internal strategy working set");

const cruiseWorkingSetFixture = {
  schema: "jcc-strategy-fit-packet-v1",
  candidate_working_set_count: 10,
  candidate_working_set: Array.from({ length: 10 }, (_, index) => ({
    candidate_id: `cruise-line-${index + 1}`,
    selected_variant_id: `variant-${index + 1}`,
    atomic_roster_members: [`单位${index + 1}`],
    roster_is_atomic: true,
    canonical_variant: { variant_id: `variant-${index + 1}`, roster_is_atomic: true, lineup_names: [`单位${index + 1}`] },
    main_carry: { name: `主C${index + 1}` },
  })),
  candidate_lines: Array.from({ length: 10 }, (_, index) => ({
    line_id: `cruise-line-${index + 1}`,
    line: `巡航候选${index + 1}`,
    main_carry: { name: `主C${index + 1}` },
    combined_fit_score: 0.8 - index / 100,
  })),
};
const earlyCruiseWorkingSet = compactStrategyFitPacketForTurn(cruiseWorkingSetFixture, {
  mode: "cruise",
  currentStageRound: "2-3",
});
assert(earlyCruiseWorkingSet.candidate_working_set.length >= 5
  && earlyCruiseWorkingSet.candidate_working_set.length <= 10,
  "Cruise must expose a bounded working set to the Agent in early stages");
assert.equal(earlyCruiseWorkingSet.candidate_lines.length, 3,
  "Cruise may keep three early-stage presentation directions while preserving the wider working set");
assert.equal(earlyCruiseWorkingSet.display_candidate_limit, 3,
  "Cruise display guidance must remain separate from the Agent working set");
const lateCruiseWorkingSet = compactStrategyFitPacketForTurn(cruiseWorkingSetFixture, {
  mode: "cruise",
  currentStageRound: "4-2",
});
assert(lateCruiseWorkingSet.candidate_working_set.length >= 5
  && lateCruiseWorkingSet.candidate_working_set.length <= 10,
  "Cruise must preserve the bounded working set after the early exploration stage");
assert.equal(lateCruiseWorkingSet.candidate_lines.length, 2,
  "Cruise late-stage presentation guidance may narrow to two directions without shrinking Agent evidence");

const fullPoolSelected = selectRelevantRankingCandidates(dailyBigData, {
  ...request,
  request_id: "verify-ranking-full-pool-budget",
  request_hash: "verify-ranking-full-pool-budget",
  user_message: "",
  season_catalog: { champion_names: [], champions_by_cost: {}, traits: [] },
});
const fullPoolWorkingSetBytes = Buffer.byteLength(JSON.stringify(fullPoolSelected));
assert.equal(fullPoolSelected.candidates.length, masterTier.lineup_groups.length,
  "an active-match empty query must retain the complete lightweight Master+ pool before stage scoring");
assert(fullPoolWorkingSetBytes <= 512 * 1024,
  `the complete pre-hydration Master+ pool must remain under 512KB, got ${fullPoolWorkingSetBytes} bytes`);
const selectedByCarry = selected.candidates.find((candidate) =>
  candidate?.strategy_profile?.main_carry?.champion_id === carry.champion_id
);
assert(selectedByCarry, "main-carry name and id must retrieve the offline lineup strategy profile");
assert.equal(selectedByCarry.strategy_profile.formation_profile.burden_band, "medium",
  "formation burden profile must survive Runtime ranking retrieval");
assert.equal(selectedByCarry.strategy_profile.strength_anchor.quality.current_day_score, 0.731,
  "Start Match retrieval must consume the compiled deterministic current-day strength score");
assert.equal(selectedByCarry.strategy_profile.strength_anchor.trend_evidence.may_affect_current_day_score, false,
  "Start Match may receive only the compiled zero-weight same-binding trend evidence");
assert(selectedByCarry.strategy_profile.associated_augments.length > 0, "augment associations must survive runtime retrieval");
assert.equal(selectedByCarry.strategy_profile.complete_variant_detail_ref, undefined,
  "the pre-hydration pool must carry a detail reference through candidate identity rather than embedding complete recipe detail");

const recipeEvidenceFixture = compactLineupGroups([{
  lineup_group_id: "recipe-evidence-fixture",
  main_trait_list: [{ trait_id: "fixture-trait" }],
  strength_anchor: {
    anchor_id: "fixture-strength",
    metrics: { top1_rate: 0.2, top4_rate: 0.65, use_rate: 0.02 },
    quality: { current_day_score: 0.7 },
    trend_evidence: { may_affect_current_day_score: false, may_affect_current_day_order: false },
  },
  recipe_match: { source_role: "popular_recipe", recipe_id: "popular:fixture", classification: "compatible" },
  recipe_evidence: {
    source_role: "popular_recipe",
    recipe_id: "popular:fixture",
    display_name: "兼容配方证据",
    classification: "compatible",
    use_as: "bounded_recipe_enrichment",
    allowed_fields: ["roles", "items", "augments", "variants", "transitions", "positioning", "playbook", "lineup_code"],
    may_replace_roster: false,
    may_merge_variants: false,
    may_inherit_strength: false,
  },
  main_carry: { champion_id: "fixture-carry", champion_name: "兼容主C", cost: 4 },
  core_units: [{ champion_id: "fixture-carry", champion_name: "兼容主C" }],
  formation_profile: {
    schema: "jcc-lineup-formation-profile-v1",
    authority: "parallel_to_national_strength_not_a_strength_adjustment",
    target_population: 8,
    burden_band: "medium",
    estimated_burden_score: 0.4,
    evidence_coverage: 0.7,
    unknowns: [],
  },
  variants: [{
    variant_id: "recipe-evidence-variant",
    population: 8,
    lineup_ids: ["fixture-carry"],
    lineup_names: ["兼容主C"],
    core_unit_ids: ["fixture-carry"],
    main_carry: { champion_id: "fixture-carry", champion_name: "兼容主C" },
    playbook: { early_game: "兼容配方过渡说明" },
    lineup_code: "fixture-code",
    formation_profile: {
      schema: "jcc-lineup-formation-profile-v1",
      authority: "parallel_to_national_strength_not_a_strength_adjustment",
      target_population: 8,
      burden_band: "medium",
      estimated_burden_score: 0.4,
      evidence_coverage: 0.7,
      unknowns: [],
    },
    recipe_evidence: {
      classification: "compatible",
      use_as: "bounded_recipe_enrichment",
      allowed_fields: ["roles", "items", "augments", "variants", "transitions", "positioning", "playbook", "lineup_code"],
      may_replace_roster: false,
      may_merge_variants: false,
      may_inherit_strength: false,
    },
  }],
}], {}, null, {}, {}, [], { completeStrategyProfiles: true })[0];
assert.equal(recipeEvidenceFixture.strategy_profile.recipe_evidence.use_as, "bounded_recipe_enrichment",
  "compatible recipe evidence scope must survive Runtime compaction");
assert.equal(recipeEvidenceFixture.strategy_profile.variants[0].playbook.early_game, "兼容配方过渡说明",
  "compatible recipe playbook must reach the current-turn strategy package");
assert.equal(recipeEvidenceFixture.strategy_profile.variants[0].lineup_code, "fixture-code",
  "compatible recipe lineup code must remain an attachment, not roster identity");

const analogousEvidenceFixture = compactLineupGroups([{
  lineup_group_id: "analogous-evidence-fixture",
  main_trait_list: [{ trait_id: "fixture-trait" }],
  strength_anchor: { anchor_id: "fixture-strength-analogous", metrics: {}, quality: { current_day_score: 0.5 } },
  recipe_match: { source_role: "popular_recipe", recipe_id: "popular:analogous", classification: "analogous" },
  recipe_evidence: {
    source_role: "popular_recipe",
    recipe_id: "popular:analogous",
    classification: "analogous",
    use_as: "bounded_reference_only",
    allowed_fields: ["role_hints", "hero_item_lookup"],
    may_replace_roster: false,
    may_merge_variants: false,
    may_inherit_strength: false,
  },
  main_carry: { champion_id: "fixture-carry", champion_name: "相似主C", cost: 3 },
  core_units: [{ champion_id: "fixture-carry", champion_name: "相似主C" }],
  associated_augments: [],
  variants: [{
    variant_id: "analogous-evidence-variant",
    population: 7,
    lineup_ids: ["fixture-carry"],
    lineup_names: ["相似主C"],
    core_unit_ids: ["fixture-carry"],
    main_carry: { champion_id: "fixture-carry", champion_name: "相似主C" },
    transitions: [],
    playbook: null,
    lineup_code: null,
    associated_augments: [],
    recipe_evidence: {
      classification: "analogous",
      use_as: "bounded_reference_only",
      allowed_fields: ["role_hints", "hero_item_lookup"],
      may_replace_roster: false,
      may_merge_variants: false,
      may_inherit_strength: false,
    },
  }],
}], {}, null, {}, {}, [], { completeStrategyProfiles: true })[0];
assert.deepEqual(analogousEvidenceFixture.strategy_profile.recipe_evidence.allowed_fields,
  ["role_hints", "hero_item_lookup"],
  "analogous recipe evidence must remain reference-only after Runtime compaction");
assert.equal(analogousEvidenceFixture.strategy_profile.variants[0].playbook, null,
  "analogous recipe playbook must not be inherited as a full recipe");

const sourceAugmentName = sourceCandidate.strategy_profile.associated_augments[0].augment_name;
const augmentSelected = selectRelevantRankingCandidates(dailyBigData, {
  ...request,
  request_id: "verify-ranking-augment-search",
  request_hash: "verify-ranking-augment-search",
  user_message: sourceAugmentName,
});
assert(augmentSelected.candidates.some((candidate) => candidate?.id === sourceCandidate.id),
  "the complete reverse index must retrieve the lineup that publishes the associated augment");

const sourceItemName = sourceCandidate.strategy_profile.variants[0].main_carry_items[0].item_name;
const itemSelected = selectRelevantRankingCandidates(dailyBigData, {
  ...request,
  request_id: "verify-ranking-item-search",
  request_hash: "verify-ranking-item-search",
  user_message: sourceItemName,
});
assert(itemSelected.candidates.some((candidate) => candidate?.id === sourceCandidate.id),
  "the complete item reverse index must retrieve the lineup without embedding every item package in the search pool");

const transitionOnlyName = "测试变阵路线";
const transitionSelected = selectRelevantRankingCandidates({
  available: true,
  tiers: {
    "0": {
      label: "master_plus",
      top_lineups: [],
      lineup_groups: [{
        id: "transition-only",
        display_name: "基础阵容",
        main_traits: ["基础羁绊"],
        summary: { avg_rank: 4, top1_rate: 0.1, top4_rate: 0.5, use_rate: 0.01, use_num: 100 },
        strategy_profile: {
          variants: [{ transitions: [{ population: 9, lineup_names: [transitionOnlyName] }] }],
        },
      }],
    },
  },
}, {
  ...request,
  request_id: "verify-ranking-transition-search",
  request_hash: "verify-ranking-transition-search",
  user_message: transitionOnlyName,
  season_catalog: { champion_names: [], champions_by_cost: {}, traits: [] },
});
assert.equal(transitionSelected.candidates[0]?.id, "transition-only", "transition-only lineup names must retrieve their parent lineup");

const reverseIndexedAugmentName = "测试强化关联";
const reverseIndexed = selectRelevantRankingCandidates({
  available: true,
  tiers: {
    "0": {
      label: "master_plus",
      top_lineups: [],
      lineup_groups: [{
        id: "reverse-index-lineup",
        display_name: "测试阵容",
        main_traits: ["测试羁绊"],
        summary: { avg_rank: 3.5, top1_rate: 0.2, top4_rate: 0.65, use_rate: 0.02, use_num: 500 },
      }],
      reverse_indexes: {
        augment: {
          lineups_by_entity_id: { "augment-test": ["reverse-index-lineup"] },
          names_by_entity_id: { "augment-test": reverseIndexedAugmentName },
        },
        champion: { lineups_by_entity_id: {}, names_by_entity_id: {} },
        item: { lineups_by_entity_id: {}, names_by_entity_id: {} },
        trait: { lineups_by_entity_id: {}, names_by_entity_id: {} },
      },
      hero_profiles: [],
    },
  },
}, {
  ...request,
  request_id: "verify-ranking-reverse-index-search",
  request_hash: "verify-ranking-reverse-index-search",
  user_message: `我选了${reverseIndexedAugmentName}，适合什么阵容`,
  season_catalog: { champion_names: [], champions_by_cost: {}, traits: [] },
});
assert.equal(reverseIndexed.candidates[0]?.id, "reverse-index-lineup", "augment reverse index must retrieve its precompiled lineup");
assert.equal(reverseIndexed.candidates[0]?.reverse_index_hits?.[0]?.kind, "augment", "selected evidence must identify the reverse-index entity kind");

const heroProfileName = "测试英雄";
const heroArtifactName = "测试神器";
const heroProfileSelected = selectRelevantRankingCandidates({
  available: true,
  tiers: {
    "0": {
      label: "master_plus",
      top_lineups: [],
      lineup_groups: [],
      reverse_indexes: {
        augment: { lineups_by_entity_id: {}, names_by_entity_id: {} },
        champion: { lineups_by_entity_id: {}, names_by_entity_id: {} },
        item: { lineups_by_entity_id: {}, names_by_entity_id: {} },
        trait: { lineups_by_entity_id: {}, names_by_entity_id: {} },
      },
      hero_profiles: [{
        champion_id: "hero-test",
        champion_name: heroProfileName,
        market_prior: { metrics: { use_rate: 0.2 }, interpretation: "market_popularity_prior_not_live_contest_fact" },
        highest_top1_package: {
          item_ids: ["artifact-test"],
          item_names: [heroArtifactName],
          item_tags: { "artifact-test": ["artifact"] },
          metrics: { top1_rate: 0.3, use_rate: 0.01 },
        },
        most_popular_package: {
          item_ids: ["standard-test"],
          item_names: ["测试常用装"],
          metrics: { top1_rate: 0.15, use_rate: 0.2 },
        },
        interpretation: "hero_ranking_is_popularity_contest_pressure_and_item_preference_not_lineup_strength",
      }],
    },
  },
}, {
  ...request,
  request_id: "verify-ranking-hero-profile-search",
  request_hash: "verify-ranking-hero-profile-search",
  user_message: `${heroProfileName}最适配的${heroArtifactName}是什么`,
  season_catalog: {
    champion_names: [heroProfileName],
    champions_by_cost: { "5": [{ name: heroProfileName, ranking_ids: ["hero-test"], ids: ["hero-test"] }] },
    traits: [],
  },
});
assert.equal(heroProfileSelected.hero_profiles[0]?.champion_id, "hero-test", "direct hero/item request must retrieve the precompiled hero profile");
assert.equal(heroProfileSelected.hero_profiles[0]?.highest_top1_package?.item_names?.[0], heroArtifactName, "artifact package must survive direct hero-profile retrieval");

const hundredthLineupName = "第100个完整索引阵容";
const hundredCandidates = Array.from({ length: 100 }, (_, index) => ({
  lineup_group_id: `synthetic-${index + 1}`,
  metrics: { avg_rank: 4, top1_rate: 0.1, top4_rate: 0.5, use_rate: 0.01, use_num: 100 },
  variants: [{ lineup_names: [index === 99 ? hundredthLineupName : `普通阵容${index + 1}`] }],
}));
const hundredCompactGroups = compactLineupGroups(hundredCandidates, {}, null, { tier: "0", label: "master_plus" });
assert.equal(hundredCompactGroups.length, 100, "runtime query source must retain the complete typed index beyond 80 lineups");
const annotatedGroups = compactLineupGroups([{
  lineup_group_id: "semantic-annotation-runtime",
  strength_anchor: {
    anchor_id: "national:semantic-annotation-runtime",
    traits: [],
    metrics: { top4_rate: 0.61, top1_rate: 0.15, avg_rank: 3.8, use_rate: 0.02 },
    quality: { current_day_score: 0.66 },
  },
  semantic_annotation: {
    lineup_id: "semantic-annotation-runtime",
    confidence: "high",
    formation_burden: "medium",
    flexibility: "high",
    strategy_style: "flexible_transition",
    condition_flags: [],
    rationale_codes: ["new_current_day_recipe"],
  },
  variants: [{ variant_id: "semantic-annotation-runtime:v1", lineup_names: ["测试棋子"] }],
}], {}, null, { tier: "0", label: "master_plus" });
assert.equal(annotatedGroups[0].strategy_profile.semantic_annotation.strategy_style, "flexible_transition",
  "the fully hydrated primary Start Match candidate must expose validated semantic maintenance annotations");
const specialPopulationGroup = compactLineupGroups([{
  lineup_group_id: "special-population-runtime",
  strength_anchor: { anchor_id: "national:special-population", traits: [], metrics: {} },
  variants: [{
    variant_id: "special-population-runtime:v1",
    population: 10,
    roster_unit_count: 11,
    occupied_population: 12,
    base_team_size: 10,
    team_size_bonus: 2,
    effective_team_size: 12,
    population_legal: true,
    team_size_modifiers: [{
      source_kind: "active_trait_breakpoint",
      trait_id: "rift",
      trait_name: "Rift",
      active_breakpoint: 10,
      team_size_bonus: 2,
      activation_occupied_population: 10,
      source_effect: "+2 maximum team size",
    }],
    lineup_ids: ["dragon"],
    lineup_names: ["Dragon"],
    atomic_roster_members: [{
      source_unit_id: "dragon-source",
      entity_kind: "canonical_champion",
      champion_id: "dragon",
      champion_name: "Dragon",
      population_cost: 2,
      special_trait_contributions: [{ trait_id: "rift", trait_name: "Rift", value: 2 }],
      occupies_population: true,
    }],
  }],
}], {}, null, { tier: "0", label: "master_plus" });
const projectedSpecialPopulation = specialPopulationGroup[0].strategy_profile.variants[0];
assert.equal(projectedSpecialPopulation.occupied_population, 12,
  "complete Ranking delivery must retain occupied population rather than reverting to entity count");
assert.equal(projectedSpecialPopulation.effective_team_size, 12,
  "complete Ranking delivery must retain active trait-granted team size");
assert.equal(projectedSpecialPopulation.atomic_roster_members[0].population_cost, 2,
  "complete Ranking delivery must retain per-unit population cost");
assert.equal(projectedSpecialPopulation.atomic_roster_members[0].special_trait_contributions[0]?.value, 2,
  "complete Ranking delivery must retain special trait contribution evidence");
const hundredthSelected = selectRelevantRankingCandidates({
  available: true,
  tiers: { "0": { label: "master_plus", top_lineups: [], lineup_groups: hundredCompactGroups } },
}, {
  ...request,
  request_id: "verify-ranking-hundredth-search",
  request_hash: "verify-ranking-hundredth-search",
  user_message: hundredthLineupName,
  season_catalog: { champion_names: [], champions_by_cost: {}, traits: [] },
});
assert(hundredthSelected.candidates.some((candidate) => candidate.id === "synthetic-100"), "a query term unique to the 100th lineup must remain in the eligible pool");
assert.equal(hundredthSelected.candidates.length, 100, "lookup must preserve the complete lightweight pool until the single stage-weighted ranking truncates it");

const validRankingSourceIdentity = {
  runtime_season_id: "s99",
  active_patch_id: "s99_1",
  game_mode_id: "jcc-mode99",
  package_id: "jcc-mode99-package",
  patch_version: "99.1",
  upstream_season_id: "100",
  battle_type: "31",
  lineup_version_id: "v6",
  core_profile_id: "a".repeat(64),
  hard_data_manifest_fingerprint: "b".repeat(64),
  catalog_source_fingerprint: "c".repeat(64),
};
const validIdentity = {
  manifest: { source_identity: validRankingSourceIdentity, current: { stat_date: "20260814", files: ["rank-signal.json", "audit.json", "lineup-strategy-index.json"] } },
  audit: { status: "pass", source_identity: validRankingSourceIdentity, coverage: { tiers: { "0": {} } } },
  rankSignal: { stat_date: "20260814", source_identity: validRankingSourceIdentity, battle_type: "31", lineup_version_id: "v6", tiers: { "0": { label: "master_plus" } } },
  strategyIndex: {
    schema: "jcc-live-ranking-strategy-index-v3",
    content_fingerprint: "synthetic-complete-promoted-index-fingerprint",
    stat_date: "20260814",
    tiers: { "0": { label: "master_plus" } },
    source_identity: validRankingSourceIdentity,
  },
  activeIdentity: {
    runtime_season_id: "s99",
    active_patch_id: "s99_1",
    game_mode_id: "jcc-mode99",
    package_id: "jcc-mode99-package",
    upstream_identity: { version: "99.1", season: "100" },
    ranking_source_identity: { battle_type: "31", lineup_version_id: "v6" },
    core_profile_id: validRankingSourceIdentity.core_profile_id,
    hard_data_manifest_fingerprint: validRankingSourceIdentity.hard_data_manifest_fingerprint,
    catalog_source_fingerprint: validRankingSourceIdentity.catalog_source_fingerprint,
  },
};
assert.equal(validateLiveRankingArtifactIdentity(validIdentity).ok, true);
assert.equal(validateLiveRankingArtifactIdentity({
  ...validIdentity,
  strategyIndex: { ...validIdentity.strategyIndex, schema: "jcc-live-ranking-strategy-index-v1" },
}).reason, "ranking_strategy_index_schema_mismatch");
assert.equal(validateLiveRankingArtifactIdentity({
  ...validIdentity,
  strategyIndex: { ...validIdentity.strategyIndex, content_fingerprint: null },
}).reason, "ranking_strategy_index_fingerprint_missing");
assert.equal(validateLiveRankingArtifactIdentity({ ...validIdentity, audit: null }).reason, "ranking_audit_not_passed");
assert.equal(validateLiveRankingArtifactIdentity({
  ...validIdentity,
  strategyIndex: { ...validIdentity.strategyIndex, stat_date: "20260813" },
}).reason, "ranking_stat_date_mismatch");
assert.equal(validateLiveRankingArtifactIdentity({
  ...validIdentity,
  strategyIndex: {
    ...validIdentity.strategyIndex,
    source_identity: { ...validIdentity.strategyIndex.source_identity, active_patch_id: "s99_0" },
  },
}).reason, "ranking_runtime_patch_mismatch");
assert.equal(validateLiveRankingArtifactIdentity({
  ...validIdentity,
  activeIdentity: { ...validIdentity.activeIdentity, core_profile_id: "d".repeat(64) },
}).reason, "ranking_core_profile_mismatch");
assert.equal(validateLiveRankingArtifactIdentity({
  ...validIdentity,
  rankSignal: { ...validIdentity.rankSignal, battle_type: "99" },
}).reason, "ranking_battle_type_mismatch");
assert.equal(validateLiveRankingArtifactIdentity({
  ...validIdentity,
  rankSignal: { ...validIdentity.rankSignal, battle_type: null },
}).reason, "ranking_battle_type_missing");
assert.equal(validateLiveRankingArtifactIdentity({
  ...validIdentity,
  strategyIndex: {
    ...validIdentity.strategyIndex,
    source_identity: { ...validIdentity.strategyIndex.source_identity, lineup_version_id: "v5" },
  },
}).reason, "ranking_lineup_version_mismatch");
assert.equal(validateLiveRankingArtifactIdentity({
  ...validIdentity,
  rankSignal: { ...validIdentity.rankSignal, lineup_version_id: null },
}).reason, "ranking_lineup_version_missing");
assert.equal(validateLiveRankingArtifactIdentity({
  ...validIdentity,
  rankSignal: { ...validIdentity.rankSignal, tiers: { "255": { label: "master_plus" } } },
}).reason, "ranking_tier_partition_mismatch");
assert.equal(validateLiveRankingArtifactIdentity({
  ...validIdentity,
  strategyIndex: { ...validIdentity.strategyIndex, tiers: { "0": { label: "all_tiers" } } },
}).reason, "ranking_master_plus_label_mismatch");
assert.equal(validateLiveRankingArtifactIdentity({
  ...validIdentity,
  audit: { ...validIdentity.audit, coverage: { tiers: { "0": {}, "255": {} } } },
}).reason, "ranking_tier_partition_mismatch");

const disguisedTierSelection = selectRelevantRankingCandidates({
  available: true,
  tiers: { "255": { label: "master_plus", top_lineups: [], lineup_groups: hundredCompactGroups } },
}, request);
assert.deepEqual(disguisedTierSelection.ranking_scope.selected_tier_ids, [], "a nonzero tier cannot enter runtime by spoofing the Master+ label");

request.selected_ranking_candidates = selected;
const capsule = hostContextCapsuleForRequest(request, { routeKey: "match:verify-ranking-strategy-runtime" });
const delta = compactHostTurnDelta(request, capsule);
const compactBytes = Buffer.byteLength(JSON.stringify(delta.selected_ranking_candidates));
assert(compactBytes <= HOST_TURN_DELTA_MAX_BYTES, `selected ranking evidence must stay within the complete-strategy hard ceiling, got ${compactBytes} bytes`);
assert(delta.selected_ranking_candidates.candidates.some((candidate) => candidate.strategy_profile?.main_carry?.champion_name === carry.champion_name));
const primaryStrategyProfile = delta.selected_ranking_candidates.candidates[0]?.strategy_profile;
assert.equal(primaryStrategyProfile?.detail_level, "complete_current_turn_strategy_package");
const rawPrimaryCandidate = strategyIndex.tiers["0"].lineup_candidates.find((candidate) => candidate.lineup_group_id === selected.candidates[0].id);
assert(rawPrimaryCandidate, "the selected primary must resolve back to the complete offline strategy index");
assert.equal(1 + (primaryStrategyProfile?.sibling_variants?.length || 0), rawPrimaryCandidate.variants.length, "the primary turn package must hydrate every final variant from the selected winning-lineup group after scoring");
const turnVariants = [primaryStrategyProfile.canonical_variant, ...(primaryStrategyProfile.sibling_variants || [])];
assert.deepEqual(turnVariants.map((variant) => variant.variant_id).sort(), rawPrimaryCandidate.variants.map((variant) => variant.variant_id).sort(), "hydration must preserve every atomic final-variant identity without cross-variant synthesis");
const rawObservedAtomicVariant = rawPrimaryCandidate.variants.find((variant) =>
  Number.isFinite(Number(variant?.atomic_roster_statistics?.use_num)));
if (rawObservedAtomicVariant) {
  const turnObservedAtomicVariant = turnVariants.find((variant) => variant.variant_id === rawObservedAtomicVariant.variant_id);
  assert.equal(
    turnObservedAtomicVariant?.atomic_roster_observation?.observed_match_count,
    rawObservedAtomicVariant.atomic_roster_statistics.use_num,
    "the exact atomic roster observation count must survive Host hydration without becoming a trait-group sample size",
  );
  assert.equal(
    turnObservedAtomicVariant?.atomic_roster_observation?.authority,
    "exact_atomic_roster_observation_not_trait_group_total",
  );
}
for (const secondaryCandidate of delta.selected_ranking_candidates.candidates.slice(1)) {
  const secondaryProfile = secondaryCandidate.strategy_profile;
  assert.equal(secondaryProfile?.detail_level, "summary_with_atomic_canonical_variant", "secondary candidates must stay compact while retaining one atomic roster summary");
  assert.equal(Array.isArray(secondaryProfile?.canonical_variant?.lineup_names), true, "secondary candidates must retain their complete selected roster names");
  assert.equal("transition_chain" in (secondaryProfile?.canonical_variant || {}), false, "secondary candidates must not repeat the primary candidate's full transition chain");
  assert.equal("positioning_template" in (secondaryProfile?.canonical_variant || {}), false, "secondary candidates must not repeat full positioning templates");
}
const forbiddenLineupStrengthKeys = new Set(["avg_rank", "use_num", "sample_size", "lineup_rank", "stability_score", "ceiling_score"]);
function assertNationalStrengthMetricBoundary(value, path = "selected_ranking_candidates") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbiddenLineupStrengthKeys.has(key), false, `${path}.${key} must not enter the Host decision payload`);
    assertNationalStrengthMetricBoundary(child, `${path}.${key}`);
  }
}
assertNationalStrengthMetricBoundary(delta.selected_ranking_candidates);
for (const candidate of delta.selected_ranking_candidates.candidates) {
  const strengthAnchor = candidate.strategy_profile?.strength_anchor;
  if (!strengthAnchor) continue;
  assert.deepEqual(Object.keys(strengthAnchor.metrics || {}).sort(), ["top1_rate", "top4_rate", "use_rate"], "Host lineup strength must expose only national Master+ top-one, top-four, and appearance rates");
  assert.equal("quality" in strengthAnchor, false, "internal quality labels must not leak as user-visible lineup strength evidence");
}

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-live-ranking-strategy-runtime-verifier-v1",
  master_plus_lineups: masterTier.lineup_groups.length,
  searched_main_carry: carry.champion_name,
  searched_augment: augmentName,
  searched_item: itemName,
  selected_candidate: selectedByCarry.display_name,
  compact_turn_bytes: compactBytes,
  selected_working_set_bytes: selectedWorkingSetBytes,
  full_pool_working_set_bytes: fullPoolWorkingSetBytes,
  verified: [
    "all_master_plus_groups_searchable",
    "complete_typed_index_searchable_beyond_80_with_compact_turn_output",
    "main_carry_identity_searchable",
    "augment_associations_retained",
    "main_carry_item_packages_retained",
    "augment_name_searchable",
    "main_carry_item_name_searchable",
    "transition_route_searchable",
    "augment_reverse_index_consumed",
    "direct_hero_item_profile_searchable",
    "compact_host_turn_evidence",
    "complete_primary_compact_atomic_secondary_packages",
    "current_core_trait_family_bindings_are_resolved_and_raw_breakpoints_preserved",
    "ranking_requested_display_count_is_separate_from_agent_working_set",
    "cached_runtime_summary_budget",
    "raw_history_excluded_compiled_zero_weight_trend_allowed",
    "no_raw_snapshot_parse_on_match_hot_path",
    "audit_and_identity_fail_closed",
    "battle_type_and_lineup_version_fail_closed",
    "master_plus_tier_key_and_label_fail_closed",
  ],
}, null, 2));
