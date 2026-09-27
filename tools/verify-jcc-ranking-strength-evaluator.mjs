import assert from "node:assert/strict";
import { evaluateRankingStrength } from "./jcc_ranking_strength_evaluator.mjs";

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function currentDayRow(candidateId, overrides = {}) {
  return {
    candidate_id: candidateId,
    stat_date: "20260823",
    source: "tencent_master_plus_current_day",
    metrics: {
      top4_rate: 0.62,
      avg_rank: 3.75,
      top1_rate: 0.14,
      use_rate: 0.08,
      sample_size: 800,
      sample_size_authority: "tencent_master_plus_current_day",
      ...overrides,
    },
  };
}

function evaluate(rows, extra = {}) {
  return evaluateRankingStrength({
    current_day_rows: rows,
    ...extra,
  });
}

function rankingFor(result, candidateId) {
  const ranking = result.rankings.find((row) => row.candidate_id === candidateId);
  assert.ok(ranking, `missing evaluated ranking for ${candidateId}`);
  return ranking;
}

function scoringProjection(result) {
  return result.rankings.map((row) => ({
    candidate_id: row.candidate_id,
    current_day_score: row.current_day_score,
    band: row.band,
    percentile: row.percentile,
  }));
}

test("returns byte-stable output for identical data regardless of input order", () => {
  const alpha = currentDayRow("alpha", { top4_rate: 0.68, avg_rank: 3.35 });
  const beta = currentDayRow("beta", { top4_rate: 0.55, avg_rank: 4.15 });
  const firstBytes = Buffer.from(JSON.stringify(evaluate([beta, alpha])));
  const secondBytes = Buffer.from(JSON.stringify(evaluate([alpha, beta])));

  assert.deepEqual(secondBytes, firstBytes);
});

test("preserves raw current-day Tencent Master+ metrics without rewriting them", () => {
  const input = currentDayRow("raw", {
    top4_rate: 0.64321,
    avg_rank: 3.71234,
    top1_rate: 0.17654,
    use_rate: 0.09123,
    sample_size: 987,
  });
  const ranking = rankingFor(evaluate([input]), "raw");

  assert.deepEqual(ranking.raw_current_day_metrics, input.metrics);
});

test("uses sample reliability for shrinkage and confidence without a direct strength bonus", () => {
  const result = evaluate([currentDayRow("sample-policy")]);

  assert.equal(result.scoring_policy.reliability_weight, 0);
  assert.equal(result.scoring_policy.popularity_weight, 0);
  assert.equal(result.scoring_policy.history_weight, 0);
});

test("increases composite strength when top-four stability improves", () => {
  const baseline = rankingFor(evaluate([currentDayRow("baseline")]), "baseline");
  const strongerTopFour = rankingFor(evaluate([currentDayRow("top4", { top4_rate: 0.72 })]), "top4");

  assert.ok(strongerTopFour.current_day_score > baseline.current_day_score);
});

test("increases composite strength when average-rank quality improves", () => {
  const baseline = rankingFor(evaluate([currentDayRow("baseline")]), "baseline");
  const betterAverageRank = rankingFor(evaluate([currentDayRow("avg", { avg_rank: 3.15 })]), "avg");

  assert.ok(betterAverageRank.current_day_score > baseline.current_day_score);
});

test("increases composite strength when top-one ceiling improves", () => {
  const baseline = rankingFor(evaluate([currentDayRow("baseline")]), "baseline");
  const higherTopOne = rankingFor(evaluate([currentDayRow("top1", { top1_rate: 0.24 })]), "top1");

  assert.ok(higherTopOne.current_day_score > baseline.current_day_score);
});

test("increases composite strength when authoritative sample reliability improves", () => {
  const baseline = rankingFor(evaluate([currentDayRow("baseline")]), "baseline");
  const moreReliable = rankingFor(evaluate([currentDayRow("sample", { sample_size: 8_000 })]), "sample");

  assert.ok(moreReliable.current_day_score > baseline.current_day_score);
});

test("keeps popularity separate from composite strength", () => {
  const lowUse = rankingFor(evaluate([currentDayRow("line", { use_rate: 0.01 })]), "line");
  const highUse = rankingFor(evaluate([currentDayRow("line", { use_rate: 0.45 })]), "line");

  assert.equal(highUse.current_day_score, lowUse.current_day_score);
  assert.notDeepEqual(highUse.popularity, lowUse.popularity);
});

test("applies sample shrinkage only when sample_size has current-day Tencent authority", () => {
  const strongMetrics = {
    top4_rate: 0.78,
    avg_rank: 2.9,
    top1_rate: 0.3,
    sample_size: 12,
  };
  const authoritative = rankingFor(evaluate([
    currentDayRow("line", {
      ...strongMetrics,
      sample_size_authority: "tencent_master_plus_current_day",
    }),
  ]), "line");
  const nonAuthoritative = rankingFor(evaluate([
    currentDayRow("line", {
      ...strongMetrics,
      sample_size_authority: "recipe_evidence",
    }),
  ]), "line");
  const missing = rankingFor(evaluate([
    currentDayRow("line", {
      ...strongMetrics,
      sample_size: undefined,
      sample_size_authority: undefined,
    }),
  ]), "line");

  assert.ok(authoritative.current_day_score < missing.current_day_score, "a small authoritative sample must shrink an otherwise strong estimate");
  assert.equal(nonAuthoritative.current_day_score, missing.current_day_score, "non-authoritative sample counts must not trigger shrinkage");
});

test("does not borrow recipe samples when the national sample is missing", () => {
  const withoutRecipeSample = currentDayRow("line", {
    sample_size: undefined,
    sample_size_authority: undefined,
  });
  const withRecipeSample = {
    ...structuredClone(withoutRecipeSample),
    recipe_evidence: { sample_size: 50_000, use_num: 50_000 },
  };
  const absent = rankingFor(evaluate([withoutRecipeSample]), "line");
  const recipeOnly = rankingFor(evaluate([withRecipeSample]), "line");

  assert.equal(recipeOnly.current_day_score, absent.current_day_score);
  assert.equal(recipeOnly.raw_current_day_metrics.sample_size, undefined);
});

test("trend metadata cannot alter current-day score, band, percentile, or order", () => {
  const rows = [
    currentDayRow("alpha", { top4_rate: 0.69, avg_rank: 3.3 }),
    currentDayRow("beta", { top4_rate: 0.58, avg_rank: 4.0 }),
  ];
  const withoutTrend = evaluate(rows);
  const withAdversarialTrend = evaluate(rows, {
    trend_by_candidate: {
      alpha: { direction: "collapsing", score_delta: -1_000_000, percentile: 0 },
      beta: { direction: "surging", score_delta: 1_000_000, percentile: 100 },
    },
  });

  assert.deepEqual(scoringProjection(withAdversarialTrend), scoringProjection(withoutTrend));
});

test("breaks exact scoring ties by stable candidate identity", () => {
  const result = evaluate([
    currentDayRow("zeta"),
    currentDayRow("alpha"),
    currentDayRow("mu"),
  ]);

  assert.deepEqual(result.rankings.map((row) => row.candidate_id), ["alpha", "mu", "zeta"]);
});

test("rejects historical rows as scoring input", () => {
  assert.throws(
    () => evaluate([currentDayRow("current")], {
      historical_rows: [currentDayRow("history", { sample_size: 100_000 })],
    }),
    /historical|history/i,
  );
});

test("rejects historical provenance inside the current-day row collection", () => {
  const historicalRow = currentDayRow("history");
  historicalRow.source = "compact_historical_signal";
  historicalRow.stat_date = "20260822";

  assert.throws(
    () => evaluate([historicalRow]),
    /current.day|historical|history|source/i,
  );
});

test("rejects malformed or internally inconsistent current-day metrics", () => {
  assert.throws(() => evaluate([currentDayRow("negative-rate", { top4_rate: -0.01 })]), /top4_rate/u);
  assert.throws(() => evaluate([currentDayRow("oversized-rate", { top1_rate: 101 })]), /top1_rate/u);
  assert.throws(() => evaluate([currentDayRow("bad-rank", { avg_rank: 8.5 })]), /avg_rank/u);
  assert.throws(() => evaluate([currentDayRow("inconsistent", { top4_rate: 0.4, top1_rate: 0.5 })]), /cannot exceed/u);
});

for (const { name, run } of tests) {
  await run();
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-ranking-strength-evaluator-verification-v1",
  tests: tests.map(({ name }) => name),
}, null, 2)}\n`);
