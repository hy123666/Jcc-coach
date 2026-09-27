function finite(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRate(value) {
  const parsed = finite(value);
  if (parsed === null) return null;
  return parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
}

function round(value, digits = 6) {
  return value === null || value === undefined ? null : Number(Number(value).toFixed(digits));
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function percentileRank(values, value) {
  const finiteValues = values.filter((entry) => entry !== null).sort((left, right) => left - right);
  if (value === null) return null;
  if (finiteValues.length <= 1) return finiteValues.length ? 1 : null;
  const belowOrEqual = finiteValues.filter((entry) => entry <= value).length;
  return round((belowOrEqual - 1) / (finiteValues.length - 1));
}

function sampleEvidence(metrics) {
  const sampleSize = finite(metrics?.sample_size ?? metrics?.use_num);
  if (sampleSize === null || sampleSize <= 0) {
    return {
      status: "unavailable",
      band: "unknown",
      sample_size: null,
      source: null,
      reliability: "unknown",
    };
  }
  const band = sampleSize >= 1000 ? "large" : sampleSize >= 250 ? "medium" : sampleSize >= 30 ? "small" : "tiny";
  return {
    status: "observed",
    band,
    sample_size: sampleSize,
    source: metrics?.sample_size_authority || null,
    reliability: band,
  };
}

function direction(trend, axis) {
  const value = String(trend?.directions?.[axis] || trend?.[`${axis}_direction`] || "insufficient").toLowerCase();
  return value === "insufficient_history" ? "insufficient" : value;
}

function strengthDirection(trend) {
  const directions = [direction(trend, "top1_rate"), direction(trend, "top4_rate")]
    .filter((value) => value !== "insufficient" && value !== "unknown");
  if (!directions.length) return "insufficient";
  if (directions.every((value) => ["rising", "up", "improving"].includes(value))) return "rising";
  if (directions.every((value) => ["falling", "down", "declining", "collapsing"].includes(value))) return "falling";
  return "mixed";
}

function marketDirection(trend) {
  const value = direction(trend, "use_rate");
  if (["rising", "up", "improving"].includes(value)) return "rising";
  if (["falling", "down", "declining"].includes(value)) return "falling";
  return value === "insufficient" ? "insufficient" : "mixed";
}

function deltaDirection(value) {
  if (value === null) return "insufficient";
  if (Math.abs(value) < 0.002) return "stable";
  return value > 0 ? "rising" : "falling";
}

function windowStrengthDirection(window) {
  const directions = [window.top1_rate_delta_pp, window.top4_rate_delta_pp]
    .map(deltaDirection)
    .filter((value) => value !== "insufficient");
  if (!directions.length) return "insufficient";
  if (directions.every((value) => value === "rising")) return "rising";
  if (directions.every((value) => value === "falling")) return "falling";
  return "mixed";
}

function recommendationTrend(trend, windows) {
  const window = windows[0] || null;
  return {
    strength: window ? windowStrengthDirection(window) : strengthDirection(trend),
    market: window ? deltaDirection(window.use_rate_delta_pp) : marketDirection(trend),
    windowDays: window?.days || null,
  };
}

function trendWindow(trend, days) {
  const row = trend?.windows?.[`${days}d`] || null;
  if (!row?.available) return null;
  return {
    days,
    baseline_stat_date: row.baseline_stat_date || null,
    latest_stat_date: row.latest_stat_date || null,
    use_rate_delta_pp: finite(row?.deltas?.use_rate),
    use_rate_relative_growth: finite(row?.relative_changes?.use_rate),
    top4_rate_delta_pp: finite(row?.deltas?.top4_rate),
    top4_rate_relative_growth: finite(row?.relative_changes?.top4_rate),
    top1_rate_delta_pp: finite(row?.deltas?.top1_rate),
    top1_rate_relative_growth: finite(row?.relative_changes?.top1_rate),
  };
}

function currentnessInterpretation({ score, marketBand, strengthTrend, marketTrend, sampleStatus, observationCount, windows }) {
  const highSignal = score !== null && score >= 0.68;
  const oneDay = windows.find((window) => window.days === 1) || null;
  const rapidAdoption = oneDay !== null
    && (oneDay.use_rate_delta_pp ?? 0) >= 0.002
    && (oneDay.use_rate_relative_growth ?? 0) >= 0.12;
  if (highSignal && strengthTrend === "falling" && marketTrend === "falling" && observationCount >= 3) {
    return "legacy_carryover_risk";
  }
  if (highSignal && marketBand === "low" && strengthTrend === "rising" && observationCount >= 2) {
    return "emerging_low_adoption_signal";
  }
  if (highSignal && ["low", "medium"].includes(marketBand)
    && marketTrend === "rising"
    && strengthTrend !== "falling"
    && rapidAdoption) {
    return "rising_discovery_signal";
  }
  if (highSignal && marketTrend === "rising" && strengthTrend === "falling") {
    return "performance_softening_with_adoption_rise";
  }
  if (highSignal && sampleStatus === "unavailable") return "high_current_signal_unverified_sample";
  if (highSignal) return "current_high_signal";
  return "current_signal_needs_context";
}

export function evaluateRankingCurrentness({ rows = [], trendByCandidate = {} } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) throw new TypeError("rows must be a non-empty array");
  const useRates = rows.map((row) => normalizeRate(row?.metrics?.use_rate));
  const profiles = rows.map((row, index) => {
    const candidateId = String(row?.candidate_id || "").trim();
    if (!candidateId) throw new Error(`rows[${index}] is missing candidate_id`);
    const metrics = row?.metrics || {};
    const useRate = useRates[index];
    const trend = trendByCandidate?.[candidateId] || null;
    const sample = sampleEvidence(metrics);
    const observationCount = Math.max(1, Number(trend?.observation_count) || 1);
    const marketPercentile = percentileRank(useRates, useRate);
    const marketBand = marketPercentile === null
      ? "unknown"
      : marketPercentile >= 0.8 ? "high"
        : marketPercentile >= 0.4 ? "medium"
          : "low";
    const currentDayScore = finite(row?.current_day_score ?? metrics?.current_day_score);
    const windows = [1, 3, 7].map((days) => trendWindow(trend, days)).filter(Boolean);
    const recommendation = recommendationTrend(trend, windows);
    const strengthTrend = recommendation.strength;
    const marketTrend = recommendation.market;
    const interpretation = currentnessInterpretation({
      score: currentDayScore,
      marketBand,
      strengthTrend,
      marketTrend,
      sampleStatus: sample.status,
      observationCount,
      windows,
    });
    return {
      candidate_id: candidateId,
      sample,
      market: {
        use_rate: useRate,
        percentile: marketPercentile,
        band: marketBand,
        role: "current_day_adoption_and_contest_signal_not_strength",
      },
      recency: {
        observation_count: observationCount,
        strength_direction: strengthTrend,
        market_direction: marketTrend,
        first_stat_date: trend?.first_stat_date || null,
        latest_stat_date: trend?.latest_stat_date || row?.stat_date || null,
        windows,
        recommendation_window_days: recommendation.windowDays,
        consecutive: trend?.consecutive || null,
      },
      interpretation,
      flags: [
        sample.status === "unavailable" ? "sample_count_unavailable" : null,
        interpretation === "legacy_carryover_risk" ? "do_not_make_default_mainline" : null,
        interpretation === "emerging_low_adoption_signal" ? "worth_agent_review_as_information_gap" : null,
        interpretation === "rising_discovery_signal" ? "bounded_discovery_priority_boost" : null,
      ].filter(Boolean),
      authority: {
        does_not_change_current_day_strength: true,
        does_not_change_official_strength_order: true,
        selection_context_only: true,
      },
    };
  });
  return {
    schema: "jcc-ranking-currentness-v1",
    authority: "deterministic_context_layer_separate_from_current_day_strength_gradient",
    profiles,
  };
}

export function buildRankingSelectionContext({
  officialStrength,
  currentness = null,
  formationProfile = null,
  preserveExplicitTarget = false,
} = {}) {
  const official = finite(officialStrength);
  const interpretation = String(currentness?.interpretation || "current_signal_needs_context");
  const burden = finite(formationProfile?.estimated_burden_score);
  const sampleStatus = String(currentness?.sample?.status || "unavailable");
  const factors = [];
  let adjustment = 0;

  if (preserveExplicitTarget) {
    factors.push({
      id: "explicit_target_preserved",
      adjustment: 0,
      reason: "currentness may explain risk but must not silently replace a user-confirmed or explicitly queried target",
    });
  } else {
    if (interpretation === "legacy_carryover_risk") {
      adjustment -= 0.14;
      factors.push({ id: "legacy_carryover_risk", adjustment: -0.14 });
    } else if (interpretation === "performance_softening_with_adoption_rise") {
      adjustment -= 0.1;
      factors.push({ id: "performance_softening_with_adoption_rise", adjustment: -0.1 });
    } else if (interpretation === "high_current_signal_unverified_sample") {
      adjustment -= 0.03;
      factors.push({ id: "unverified_trait_group_sample", adjustment: -0.03 });
    } else if (interpretation === "emerging_low_adoption_signal") {
      adjustment += 0.03;
      factors.push({ id: "emerging_low_adoption_signal", adjustment: 0.03 });
    } else if (interpretation === "rising_discovery_signal") {
      adjustment += 0.04;
      factors.push({ id: "rising_discovery_signal", adjustment: 0.04 });
    }

    if (sampleStatus === "unavailable" && !factors.some((factor) => factor.id === "unverified_trait_group_sample")) {
      adjustment -= 0.02;
      factors.push({ id: "trait_group_sample_unavailable", adjustment: -0.02 });
    }
  }

  const boundedAdjustment = round(clamp(adjustment, -0.25, 0.05));
  const selectionStrength = official === null ? null : round(clamp(official + boundedAdjustment));
  return {
    schema: "jcc-ranking-selection-context-v1",
    official_strength: official,
    selection_strength: selectionStrength,
    bounded_adjustment: boundedAdjustment,
    interpretation,
    formation_burden_score: burden,
    sample_status: sampleStatus,
    factors,
    authority: {
      official_strength_unchanged: true,
      official_strength_order_unchanged: true,
      formation_burden_is_separate_lifecycle_evidence: true,
      open_exploration_selection_context_only: !preserveExplicitTarget,
      agent_may_override_with_live_evidence: true,
    },
  };
}
