import assert from "node:assert/strict";
import {
  rankingCandidateQuality,
} from "../ui/electron/runtime-service.js";

const stable = rankingCandidateQuality({
  summary: {
    use_num: 840,
    use_rate: 0.11,
    top1_rate: 0.19,
    top4_rate: 0.67,
    avg_rank: 2.9,
  },
});

const highCeiling = rankingCandidateQuality({
  summary: {
    use_num: 16,
    use_rate: 0.008,
    top1_rate: 0.41,
    top4_rate: 0.38,
    avg_rank: 4.2,
  },
});

const smallPromising = rankingCandidateQuality({
  summary: {
    use_num: 60,
    use_rate: 0.04,
    top1_rate: 0.19,
    top4_rate: 0.67,
    avg_rank: 2.9,
  },
});

const percentEncoded = rankingCandidateQuality({
  summary: {
    use_num: 300,
    use_rate: 8,
    top1_rate: 19,
    top4_rate: 67,
    avg_rank: 3.1,
  },
});

assert.equal(stable.quality_label, "stable_strong", "high-sample, consistent ranking evidence should be stable");
assert.equal(highCeiling.quality_label, "high_ceiling_low_stability", "low-sample high top1 evidence should remain a ceiling signal");
assert.notEqual(smallPromising.quality_label, "stable_strong", "60 games must not be promoted to stable meta evidence");
assert.equal(percentEncoded.quality_label, "stable_strong", "percentage-form rates must normalize before quality classification");
assert(highCeiling.stability_score < stable.stability_score, "high-ceiling low-sample evidence must not outrank stable evidence on stability");
assert(highCeiling.ceiling_score > stable.ceiling_score - 0.15, "ceiling should remain a separate axis from stability");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-ranking-quality-packet-verification-v1",
  stable,
  high_ceiling: highCeiling,
  small_promising: smallPromising,
  percent_encoded: percentEncoded,
}, null, 2));
