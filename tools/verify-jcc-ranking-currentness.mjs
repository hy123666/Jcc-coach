import assert from "node:assert/strict";
import {
  buildRankingSelectionContext,
  evaluateRankingCurrentness,
} from "./jcc_ranking_currentness_evaluator.mjs";

function row(id, useRate, currentDayScore = 0.8) {
  return {
    candidate_id: id,
    stat_date: "20260829",
    current_day_score: currentDayScore,
    metrics: { use_rate: useRate },
  };
}

const result = evaluateRankingCurrentness({
  rows: [row("legacy", 0.01), row("active", 0.20), row("middle", 0.08)],
  trendByCandidate: {
    legacy: {
      observation_count: 5,
      first_stat_date: "20260825",
      latest_stat_date: "20260829",
      directions: { top1_rate: "falling", top4_rate: "falling", use_rate: "falling" },
    },
    active: { observation_count: 5, directions: { top1_rate: "rising", top4_rate: "rising", use_rate: "rising" } },
  },
});
const legacy = result.profiles.find((profile) => profile.candidate_id === "legacy");
const active = result.profiles.find((profile) => profile.candidate_id === "active");
assert.equal(legacy.sample.status, "unavailable");
assert.equal(legacy.sample.band, "unknown");
assert.equal(legacy.interpretation, "legacy_carryover_risk");
assert.equal(active.interpretation, "high_current_signal_unverified_sample");
assert.equal(legacy.authority.does_not_change_current_day_strength, true);
assert.equal(legacy.authority.does_not_change_official_strength_order, true);

const sameStats = evaluateRankingCurrentness({ rows: [row("low", 0.01), row("high", 0.30)] });
assert.notEqual(
  sameStats.profiles.find((profile) => profile.candidate_id === "low").market.band,
  sameStats.profiles.find((profile) => profile.candidate_id === "high").market.band,
);

const missingAdoption = evaluateRankingCurrentness({
  rows: [row("known", 0.1), row("missing", null)],
}).profiles.find((profile) => profile.candidate_id === "missing");
assert.equal(missingAdoption.market.percentile, null);
assert.equal(missingAdoption.market.band, "unknown",
  "missing adoption evidence must remain unknown rather than being described as highest-market adoption");

const partialHistory = evaluateRankingCurrentness({
  rows: [row("partial-history", 0.05)],
  trendByCandidate: {
    "partial-history": {
      observation_count: 3,
      directions: { top1_rate: "falling", top4_rate: "insufficient_history", use_rate: "insufficient_history" },
    },
  },
}).profiles[0];
assert.equal(partialHistory.recency.strength_direction, "falling",
  "one observed falling performance metric must not be hidden by a second metric with insufficient history");
assert.equal(partialHistory.recency.market_direction, "insufficient");

const broadCarryover = evaluateRankingCurrentness({
  rows: [row("still-visible-but-declining", 0.18, 0.82), row("comparison", 0.12, 0.7)],
  trendByCandidate: {
    "still-visible-but-declining": {
      observation_count: 4,
      directions: { top1_rate: "falling", top4_rate: "falling", use_rate: "falling" },
    },
  },
}).profiles.find((profile) => profile.candidate_id === "still-visible-but-declining");
assert.equal(broadCarryover.interpretation, "legacy_carryover_risk",
  "a high official score that is falling in both performance and adoption must be flagged even if its current appearance percentile is not low");

const carryoverSelection = buildRankingSelectionContext({
  officialStrength: 0.84,
  currentness: broadCarryover,
  formationProfile: { estimated_burden_score: 0.9 },
});
assert.equal(carryoverSelection.official_strength, 0.84, "selection context must preserve the official strength fact");
assert(carryoverSelection.selection_strength < 0.7,
  "a declining carryover line must not remain the default open-exploration mainline solely because of historical aggregate strength");
assert(!carryoverSelection.factors.some((factor) => factor.id === "formation_burden"),
  "formation burden is lifecycle evidence and must not receive a second vote in currentness");
assert.equal(carryoverSelection.authority.formation_burden_is_separate_lifecycle_evidence, true);
assert.equal(carryoverSelection.authority.official_strength_order_unchanged, true);

const explicitTargetSelection = buildRankingSelectionContext({
  officialStrength: 0.84,
  currentness: broadCarryover,
  formationProfile: { estimated_burden_score: 0.9 },
  preserveExplicitTarget: true,
});
assert.equal(explicitTargetSelection.selection_strength, 0.84,
  "an explicit user target must remain available at its official strength while the Agent explains currentness and formation risk");
assert.equal(explicitTargetSelection.bounded_adjustment, 0);

const discovery = evaluateRankingCurrentness({
  rows: [row("discovery", 0.0196, 0.8), row("crowded", 0.12, 0.79), row("low", 0.005, 0.6)],
  trendByCandidate: {
    discovery: {
      observation_count: 2,
      directions: { top1_rate: "stable", top4_rate: "stable", use_rate: "rising" },
      windows: {
        "1d": {
          available: true,
          baseline_stat_date: "20260828",
          latest_stat_date: "20260829",
          deltas: { use_rate: 0.0035, top4_rate: -0.0007, top1_rate: -0.0018 },
          relative_changes: { use_rate: 0.2174, top4_rate: -0.0009, top1_rate: -0.0059 },
        },
      },
    },
  },
}).profiles.find((profile) => profile.candidate_id === "discovery");
assert.equal(discovery.interpretation, "rising_discovery_signal");
const discoverySelection = buildRankingSelectionContext({ officialStrength: 0.8, currentness: discovery });
assert.equal(discoverySelection.official_strength, 0.8);
assert(discoverySelection.factors.some((factor) => factor.id === "rising_discovery_signal" && factor.adjustment === 0.04));
assert(discoverySelection.factors.some((factor) => factor.id === "trait_group_sample_unavailable" && factor.adjustment === -0.02));
assert.equal(discoverySelection.bounded_adjustment, 0.02);
assert.equal(discoverySelection.selection_strength, 0.82);

const recentDecline = evaluateRankingCurrentness({
  rows: [row("recent-decline", 0.18, 0.82), row("comparison", 0.12, 0.7)],
  trendByCandidate: {
    "recent-decline": {
      observation_count: 8,
      directions: { top1_rate: "rising", top4_rate: "rising", use_rate: "rising" },
      windows: {
        "1d": {
          available: true,
          baseline_stat_date: "20260828",
          latest_stat_date: "20260829",
          deltas: { use_rate: -0.004, top4_rate: -0.006, top1_rate: -0.003 },
          relative_changes: { use_rate: -0.02, top4_rate: -0.01, top1_rate: -0.01 },
        },
        "7d": {
          available: true,
          baseline_stat_date: "20260822",
          latest_stat_date: "20260829",
          deltas: { use_rate: 0.05, top4_rate: 0.04, top1_rate: 0.03 },
          relative_changes: { use_rate: 0.4, top4_rate: 0.08, top1_rate: 0.12 },
        },
      },
    },
  },
}).profiles.find((profile) => profile.candidate_id === "recent-decline");
assert.equal(recentDecline.recency.recommendation_window_days, 1);
assert.equal(recentDecline.recency.strength_direction, "falling");
assert.equal(recentDecline.recency.market_direction, "falling");
assert.equal(recentDecline.interpretation, "legacy_carryover_risk",
  "a 1d decline must not be overwritten by rising whole-history or 7d directions");

const threeDayFallback = evaluateRankingCurrentness({
  rows: [row("three-day-decline", 0.18, 0.82), row("comparison", 0.12, 0.7)],
  trendByCandidate: {
    "three-day-decline": {
      observation_count: 8,
      directions: { top1_rate: "rising", top4_rate: "rising", use_rate: "rising" },
      windows: {
        "1d": { available: false },
        "3d": {
          available: true,
          baseline_stat_date: "20260826",
          latest_stat_date: "20260829",
          deltas: { use_rate: -0.003, top4_rate: -0.004, top1_rate: -0.005 },
          relative_changes: { use_rate: -0.02, top4_rate: -0.01, top1_rate: -0.02 },
        },
        "7d": {
          available: true,
          baseline_stat_date: "20260822",
          latest_stat_date: "20260829",
          deltas: { use_rate: 0.05, top4_rate: 0.04, top1_rate: 0.03 },
          relative_changes: { use_rate: 0.4, top4_rate: 0.08, top1_rate: 0.12 },
        },
      },
    },
  },
}).profiles.find((profile) => profile.candidate_id === "three-day-decline");
assert.equal(threeDayFallback.recency.recommendation_window_days, 3);
assert.equal(threeDayFallback.interpretation, "legacy_carryover_risk",
  "the evaluator must use 3d when 1d is unavailable, before considering 7d or whole history");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-ranking-currentness-verification-v1",
  verified: [
    "missing_sample_is_unknown_not_small",
    "historical_carryover_risk_is_explicit_selection_context",
    "currentness_cannot_change_official_strength_order",
    "open_exploration_can_demote_historical_high_burden_carryover_without_rewriting_official_strength",
    "explicit_target_is_not_silently_replaced_by_currentness_adjustment",
    "rising_discovery_gets_bounded_selection_boost_without_rewriting_official_strength",
    "most_recent_available_window_controls_recommendation_trend",
    "three_day_window_precedes_seven_day_and_whole_history_when_one_day_is_unavailable",
  ],
}, null, 2));
