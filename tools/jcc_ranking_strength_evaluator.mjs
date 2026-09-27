const CURRENT_DAY_SOURCE = "tencent_master_plus_current_day";
const SAMPLE_AUTHORITY = "tencent_master_plus_current_day";
const PRIOR_SAMPLE_SIZE = 120;

function finite(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function rounded(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function normalizeRate(value, label) {
  const parsed = finite(value);
  if (parsed === null) return null;
  if (parsed < 0 || parsed > 100) throw new Error(`${label} must be between 0 and 1 or 0 and 100`);
  return parsed > 1 ? parsed / 100 : parsed;
}

function authoritativeSample(metrics) {
  if (metrics?.sample_size_authority !== SAMPLE_AUTHORITY) return null;
  const sample = finite(metrics?.sample_size);
  return sample !== null && sample > 0 ? sample : null;
}

function shrink(value, prior, sampleSize) {
  if (value === null || sampleSize === null) return value;
  const weight = sampleSize / (sampleSize + PRIOR_SAMPLE_SIZE);
  return value * weight + prior * (1 - weight);
}

function metricAxes(metrics) {
  const top4 = normalizeRate(metrics?.top4_rate, "top4_rate");
  const top1 = normalizeRate(metrics?.top1_rate, "top1_rate");
  const avgRank = finite(metrics?.avg_rank);
  if (avgRank !== null && (avgRank < 1 || avgRank > 8)) throw new Error("avg_rank must be between 1 and 8");
  if (top1 !== null && top4 !== null && top1 > top4) throw new Error("top1_rate cannot exceed top4_rate");
  const sampleSize = authoritativeSample(metrics);
  const adjustedTop4 = shrink(top4, 0.5, sampleSize);
  const adjustedTop1 = shrink(top1, 0.125, sampleSize);
  const adjustedAvgRank = shrink(avgRank, 4.5, sampleSize);
  const rankQuality = adjustedAvgRank === null ? 0.5 : clamp(1 - (adjustedAvgRank - 1) / 7);
  const floor = clamp((adjustedTop4 ?? 0.5) * 0.68 + rankQuality * 0.32);
  const ceiling = clamp(clamp((adjustedTop1 ?? 0.125) / 0.35) * 0.72 + (adjustedTop4 ?? 0.5) * 0.28);
  const reliability = sampleSize === null ? 0.35 : clamp(sampleSize / (sampleSize + 250));
  const currentDayScore = clamp(floor * 0.68 + ceiling * 0.32);
  const useRate = normalizeRate(metrics?.use_rate, "use_rate");
  return {
    adjusted: {
      top4_rate: adjustedTop4 === null ? null : rounded(adjustedTop4),
      top1_rate: adjustedTop1 === null ? null : rounded(adjustedTop1),
      avg_rank: adjustedAvgRank === null ? null : rounded(adjustedAvgRank),
      sample_shrinkage_applied: sampleSize !== null,
      prior_sample_size: sampleSize !== null ? PRIOR_SAMPLE_SIZE : null,
    },
    floor_score: rounded(floor),
    ceiling_score: rounded(ceiling),
    reliability_score: rounded(reliability),
    current_day_score: rounded(currentDayScore),
    popularity: {
      use_rate: useRate,
      score: useRate === null ? null : rounded(clamp(useRate / 0.1)),
      role: "separate_heat_and_contest_signal_not_strength",
    },
    sample_size: sampleSize,
  };
}

function bandForPercentile(percentile) {
  if (percentile >= 0.9) return "s";
  if (percentile >= 0.7) return "a";
  if (percentile >= 0.4) return "b";
  if (percentile >= 0.15) return "c";
  return "d";
}

function classification(axes) {
  if (axes.reliability_score < 0.3) return axes.ceiling_score >= 0.65 ? "conditional_high_ceiling" : "insufficient_evidence";
  if (axes.floor_score >= 0.64 && axes.ceiling_score >= 0.62) return "stable_high_ceiling";
  if (axes.floor_score >= 0.62) return "stable_top_four_line";
  if (axes.ceiling_score >= 0.67) return "high_ceiling_entry_dependent";
  return "situational_line";
}

function assertCurrentDayRow(row, index) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new TypeError(`current_day_rows[${index}] must be an object`);
  if (row.source !== CURRENT_DAY_SOURCE) {
    throw new Error(`current-day ranking row ${index} has historical or unsupported source ${String(row.source)}`);
  }
  const id = String(row.candidate_id || "").normalize("NFKC").trim();
  if (!id) throw new Error(`current_day_rows[${index}] is missing candidate_id`);
  if (!/^\d{8}$/u.test(String(row.stat_date || ""))) throw new Error(`current-day ranking row ${id} has invalid stat_date`);
  return id;
}

export function evaluateRankingStrength({
  current_day_rows,
  trend_by_candidate = {},
  ...unsupported
} = {}) {
  if (Object.hasOwn(unsupported, "historical_rows")) {
    throw new Error("historical_rows are forbidden as current-day strength input");
  }
  if (!Array.isArray(current_day_rows) || current_day_rows.length === 0) {
    throw new TypeError("current_day_rows must be a non-empty array");
  }
  const seen = new Set();
  const evaluated = current_day_rows.map((row, index) => {
    const candidateId = assertCurrentDayRow(row, index);
    if (seen.has(candidateId)) throw new Error(`duplicate current-day candidate ${candidateId}`);
    seen.add(candidateId);
    const axes = metricAxes(row.metrics || {});
    return {
      candidate_id: candidateId,
      stat_date: row.stat_date,
      source: CURRENT_DAY_SOURCE,
      raw_current_day_metrics: structuredClone(row.metrics || {}),
      current_day_score: axes.current_day_score,
      floor_score: axes.floor_score,
      ceiling_score: axes.ceiling_score,
      reliability_score: axes.reliability_score,
      classification: classification(axes),
      adjusted_metrics: axes.adjusted,
      popularity: axes.popularity,
      trend_evidence: trend_by_candidate?.[candidateId] || null,
      provenance: {
        current_day_only: true,
        sample_authority_used: axes.sample_size === null ? null : SAMPLE_AUTHORITY,
        history_can_change_score: false,
        popularity_can_change_score: false,
      },
    };
  });
  evaluated.sort((left, right) => right.current_day_score - left.current_day_score
    || left.candidate_id.localeCompare(right.candidate_id));
  const distinctScores = [...new Set(evaluated.map((row) => row.current_day_score))].sort((left, right) => right - left);
  const denominator = Math.max(1, distinctScores.length - 1);
  const rankings = evaluated.map((row, index) => {
    const scoreIndex = distinctScores.indexOf(row.current_day_score);
    const percentile = distinctScores.length === 1 ? 1 : rounded(1 - scoreIndex / denominator);
    return {
      ...row,
      order: index + 1,
      percentile,
      band: bandForPercentile(percentile),
    };
  });
  return {
    schema: "jcc-current-day-strength-gradient-v1",
    authority: "deterministic_current_day_tencent_master_plus_only",
    scoring_policy: {
      floor_weight: 0.68,
      ceiling_weight: 0.32,
      reliability_weight: 0,
      popularity_weight: 0,
      history_weight: 0,
      sample_shrinkage_prior_size: PRIOR_SAMPLE_SIZE,
    },
    rankings,
  };
}

export const CURRENT_DAY_RANKING_SOURCE = CURRENT_DAY_SOURCE;
export const CURRENT_DAY_SAMPLE_AUTHORITY = SAMPLE_AUTHORITY;
