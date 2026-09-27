import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  archiveLiveRankingSignal,
  buildCompactLiveRankingHistorySignal,
  buildLiveRankingTrendSummary,
  buildLiveRankingTrendSummaryIncludingSignal,
  liveRankingHistoryBinding,
  liveRankingHistoryBindingSha256,
  listLiveRankingHistorySignals,
  normalizeLiveRankingTraitTrendKey,
  pruneLiveRankingHistory,
} from "./jcc_live_rankings_history.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "jcc-ranking-history-"));

assert.equal(normalizeLiveRankingTraitTrendKey("84660104_10"), "846601:10",
  "legacy raw trait ids must normalize to the same family/breakpoint key used by the strategy index");
assert.equal(
  normalizeLiveRankingTraitTrendKey("84700102_3;83910102_3"),
  "839101:3|847001:3",
  "multi-trait history keys must normalize and sort deterministically before trend joins",
);
const canonicalTraitAliases = new Map([["839101", "351"], ["847001", "458"]]);
assert.equal(
  normalizeLiveRankingTraitTrendKey("84700102_3;83910102_3", [], canonicalTraitAliases),
  "351:3|458:3",
  "legacy raw-family history must join the current canonical trait identity",
);

const BASE_BINDING_SOURCE = {
  runtime_season_id: "s18",
  active_patch_id: "14.16",
  core_profile_id: "a".repeat(64),
  catalog_source_fingerprint: "b".repeat(64),
  hard_data_manifest_fingerprint: "c".repeat(64),
  battle_type: "31",
  lineup_version_id: "v6",
  ranking_set_id: "set-18",
};

function sampleSignal(statDate, marker = "first", sourceOverrides = {}) {
  const sourceIdentity = { ...BASE_BINDING_SOURCE, ...sourceOverrides };
  return {
    schema_version: 1,
    generated_at: "2026-08-14T00:00:00.000Z",
    stat_date: statDate,
    battle_type: sourceIdentity.battle_type,
    lineup_version_id: sourceIdentity.lineup_version_id,
    source_identity: sourceIdentity,
    tiers: {
      "0": {
        label: "master_plus",
        top_traits: [{ key: "trait", main_traits: [{ trait_id: "1", hero_num: "2" }], top1_rate: 0.1, top4_rate: 0.5, use_rate: 0.2, signal_score: 1 }],
        top_heroes: [{ hero_id: marker, top1_rate: 0.1, top4_rate: 0.5, avg_rank: 4.1, use_rate: 0.2, signal_score: 1 }],
        top_equips: [{ equip_id: "e1", top1_rate: 0.1, top4_rate: 0.5, avg_rank: 4.1, use_rate: 0.2, top_3_hero: ["h1", "h2", "h3", "h4"], signal_score: 1 }],
        hero_item_signal: [{
          hero_id: "h1",
          source: "equip_rank.top_3_hero",
          interpretation: "rank_prior_not_perfect_item_combo",
          signal_score: 1,
          items: Array.from({ length: 12 }, (_, index) => ({ equip_id: `e${index}`, signal_score: index })),
        }],
        top_lineups: [{ id: "lineup-1", main_trait_list: ["t1"], avg_rank: 4.1, top1_rate: 0.1, top4_rate: 0.5, use_rate: 0.2, use_num: 100, signal_score: 1 }],
        augment_lineup_signal: [{
          augment_id: "a1",
          source: "lineup_group.info.list.rune_id_group",
          interpretation: "lineup_association_prior_not_independent_augment_winrate",
          not_independent_winrate: true,
          lineup_count: 99,
          total_use_num: 1000,
          weighted_top1_rate: 0.1,
          weighted_top4_rate: 0.5,
          weighted_avg_rank: 4.1,
          weighted_use_rate: 0.2,
          signal_score: 1,
          associated_lineups: Array.from({ length: 80 }, (_, index) => ({
            lineup_group_id: `g${index}`,
            lineup: Array.from({ length: 80 }, (_unused, slot) => `unit-${slot}`),
          })),
        }],
      },
      "1": {
        label: "platinum_to_diamond",
        top_traits: [{ key: "forbidden-lower-tier" }],
        top_heroes: [{ hero_id: "forbidden-lower-tier" }],
        top_equips: [],
        hero_item_signal: [],
        top_lineups: [{ id: "forbidden-lower-tier" }],
        augment_lineup_signal: [],
      },
    },
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function jsonText(value) {
  return JSON.stringify(value);
}

function hasKeyDeep(value, key) {
  if (!value || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  return Object.values(value).some((child) => hasKeyDeep(child, key));
}

try {
  const firstSignal = sampleSignal("20260801");
  const binding = liveRankingHistoryBinding(firstSignal);
  const bindingSha256 = liveRankingHistoryBindingSha256(binding);
  assert.deepEqual(binding, {
    season_id: "s18",
    patch_id: "14.16",
    core_profile_id: "a".repeat(64),
    catalog_fingerprint: "b".repeat(64),
    hard_data_manifest_fingerprint: "c".repeat(64),
    battle_type: "31",
    tier: "0",
    lineup_version_id: "v6",
    ranking_set_id: "set-18",
  });
  assert.match(bindingSha256, /^[a-f0-9]{64}$/);

  const compact = buildCompactLiveRankingHistorySignal(firstSignal);
  assert.equal(compact.stat_date, "20260801");
  assert.deepEqual(compact.binding, binding, "compact history must carry the complete ranking binding");
  assert.equal(compact.binding_sha256, bindingSha256);
  assert.deepEqual(Object.keys(compact.tiers), ["0"], "compact history must retain only Master+ evidence");
  assert.equal(compact.tiers["0"].augment_lineup_signal[0].associated_lineups, undefined);
  assert.equal(compact.tiers["0"].augment_lineup_signal[0].associated_lineup_rows_retained, 0);
  assert.equal(compact.tiers["0"].hero_item_signal[0].items.length, 8);
  assert.ok(!jsonText(compact).includes("unit-79"), "compact signal must not retain large nested lineup arrays");
  assert.equal(hasKeyDeep(compact.tiers, "associated_lineups"), false, "compact tier payload must omit associated_lineups keys");

  const wideSignal = sampleSignal("20260731");
  wideSignal.tiers["0"].top_traits = Array.from({ length: 50 }, (_, index) => ({
    key: `trait-${index}`,
    main_traits: [{ trait_id: String(100000 + index), hero_num: 2 }],
    top1_rate: 0.1,
    top4_rate: 0.5,
    use_rate: 0.01,
  }));
  assert.equal(buildCompactLiveRankingHistorySignal(wideSignal).tiers["0"].top_traits.length, 50,
    "history must retain the complete current Master+ trait pool rather than only the first 25 rows");

  const missingMetricFirst = sampleSignal("20260729");
  missingMetricFirst.tiers["0"].top_traits[0].top1_rate = null;
  missingMetricFirst.tiers["0"].top_traits[0].top4_rate = "";
  missingMetricFirst.tiers["0"].top_traits[0].use_rate = undefined;
  const observedMetricLater = sampleSignal("20260730");
  observedMetricLater.tiers["0"].top_traits[0].top1_rate = 0.2;
  observedMetricLater.tiers["0"].top_traits[0].top4_rate = 0.6;
  observedMetricLater.tiers["0"].top_traits[0].use_rate = 0.1;
  const missingMetricTrend = buildLiveRankingTrendSummary([
    buildCompactLiveRankingHistorySignal(missingMetricFirst),
    buildCompactLiveRankingHistorySignal(observedMetricLater),
  ]).tiers["0"].top_traits[0];
  assert.deepEqual(missingMetricTrend.directions, {
    top1_rate: "insufficient_history",
    top4_rate: "insufficient_history",
    use_rate: "insufficient_history",
  }, "missing metrics must not be coerced to zero and turned into invented rising trends");

  for (let date = 1; date <= 16; date += 1) {
    await archiveLiveRankingSignal({
      rootDir: root,
      signal: sampleSignal(`202608${String(date).padStart(2, "0")}`),
      keepDates: 14,
    });
  }
  const retained = await listLiveRankingHistorySignals({ rootDir: root });
  assert.deepEqual(retained.map((entry) => entry.stat_date), [
    "20260803",
    "20260804",
    "20260805",
    "20260806",
    "20260807",
    "20260808",
    "20260809",
    "20260810",
    "20260811",
    "20260812",
    "20260813",
    "20260814",
    "20260815",
    "20260816",
  ]);
  assert(retained.every((entry) => entry.binding_sha256 === bindingSha256));
  const bindingRoot = path.join(root, "history", "by-binding", bindingSha256);
  assert(retained.every((entry) => entry.file_path.startsWith(path.join(bindingRoot, "signals"))));
  const trendSummary = await readJson(path.join(bindingRoot, "latest-trend-summary.json"));
  assert.equal(trendSummary.schema, "jcc-live-rankings-trend-summary-v1");
  assert.deepEqual(trendSummary.binding, binding);
  assert.equal(trendSummary.binding_sha256, bindingSha256);
  assert.equal(trendSummary.policy.role, "auxiliary_diagnostics_only");
assert.equal(trendSummary.policy.may_affect_current_day_score, false);
assert.equal(trendSummary.policy.may_affect_current_day_order, false);
assert.equal(JSON.stringify(trendSummary.tiers).includes("signal_score"), false,
  "compiled trend evidence must expose raw metric movement rather than a prior-day derived score");
  assert.equal(trendSummary.policy.live_match_use, "compiled_current_binding_auxiliary_evidence_only; verified_trait_continuity_receipt_required; direct_history_reads_forbidden");
  assert.equal(trendSummary.policy.trait_continuity_bridge, "not_used");
  assert.deepEqual(trendSummary.retained_stat_dates, retained.map((entry) => entry.stat_date));
  assert.deepEqual(Object.keys(trendSummary.tiers), ["0"], "trend summary must retain only Master+ evidence");
  assert.equal(trendSummary.tiers["0"].top_lineups[0].observation_count, 14, "trend summary must compare retained compact signals without loading raw snapshots");
  assert.equal(trendSummary.tiers["0"].top_lineups[0].observations.length, 14);
  assert.deepEqual(trendSummary.tiers["0"].top_lineups[0].observations.map(row => row.stat_date), trendSummary.retained_stat_dates);

  const sameDateFile = path.join(bindingRoot, "signals", "20260816.json");
  await archiveLiveRankingSignal({ rootDir: root, signal: sampleSignal("20260816", "overwrite"), keepDates: 14 });
  const overwritten = await readJson(sameDateFile);
  assert.deepEqual(Object.keys(overwritten.tiers), ["0"]);
  assert.equal(overwritten.tiers["0"].top_heroes[0].hero_id, "overwrite");
  assert.equal((await listLiveRankingHistorySignals({ rootDir: root })).length, 14, "same-date archive must overwrite rather than add a second file");

  const otherBindingSignal = sampleSignal("20260816", "other-binding", { active_patch_id: "14.17" });
  const otherBinding = liveRankingHistoryBinding(otherBindingSignal);
  const otherBindingSha256 = liveRankingHistoryBindingSha256(otherBinding);
  await archiveLiveRankingSignal({ rootDir: root, signal: otherBindingSignal, keepDates: 14 });
  assert.notEqual(otherBindingSha256, bindingSha256);
  assert.equal((await listLiveRankingHistorySignals({ rootDir: root, binding })).length, 14);
  assert.equal((await listLiveRankingHistorySignals({ rootDir: root, binding: otherBinding })).length, 1);
  assert.throws(
    () => buildLiveRankingTrendSummary([compact, buildCompactLiveRankingHistorySignal(otherBindingSignal)]),
    /binding mismatch/,
    "trend reducer must reject signals from different ranking bindings",
  );

  const continuityRoot = path.join(root, "continuity");
  const priorCoreSignal = sampleSignal("20260830", "prior-core");
  priorCoreSignal.tiers["0"].top_traits = [{
    key: "839101:3|847001:3",
    main_traits: [
      { trait_id: "83910102", hero_num: 3 },
      { trait_id: "84700102", hero_num: 3 },
    ],
    top1_rate: 0.2,
    top4_rate: 0.7,
    use_rate: 0.01,
  }];
  await archiveLiveRankingSignal({ rootDir: continuityRoot, signal: priorCoreSignal, keepDates: 14 });
  const currentCoreSignal = sampleSignal("20260831", "current-core", {
    core_profile_id: "d".repeat(64),
    catalog_source_fingerprint: "e".repeat(64),
    hard_data_manifest_fingerprint: "f".repeat(64),
  });
  currentCoreSignal.tiers["0"].top_traits = [{
    key: "351:3|458:3",
    main_traits: [
      { trait_id: "83910102", source_trait_id: "83910102", canonical_trait_id: "351", hero_num: 3 },
      { trait_id: "84700102", source_trait_id: "84700102", canonical_trait_id: "458", hero_num: 3 },
    ],
    top1_rate: 0.3,
    top4_rate: 0.8,
    use_rate: 0.02,
  }];
  const continuityTrend = await buildLiveRankingTrendSummaryIncludingSignal(currentCoreSignal, {
    rootDir: continuityRoot,
    keepDates: 14,
  });
  assert.deepEqual(
    continuityTrend.retained_stat_dates,
    ["20260830", "20260831"],
    "a parser-only Core identity change must preserve a compatible prior-day trait trend baseline",
  );
  assert.equal(continuityTrend.policy.never_mix_bindings, true,
    "continuity must preserve strict binding storage and reducer isolation");
  assert.equal(continuityTrend.policy.trait_continuity_bridge, "verified_source_semantic_receipt",
    "cross-Core continuity must be explicit and limited to canonical trait evidence");
  assert.equal(continuityTrend.continuity_bridges[0].overlap_ratio, 1,
    "cross-Core continuity must prove the complete source row set rather than accept partial overlap");
  assert.equal(continuityTrend.tiers["0"].top_traits[0].observation_count, 2);
  assert.equal(continuityTrend.tiers["0"].top_traits[0].windows["1d"].available, true);
  assert.equal(continuityTrend.tiers["0"].top_heroes[0].observation_count, 1,
    "cross-Core continuity must not mix hero evidence across strict bindings");

  const partialContinuityRoot = path.join(root, "partial-continuity");
  await archiveLiveRankingSignal({ rootDir: partialContinuityRoot, signal: priorCoreSignal, keepDates: 14 });
  const partialCoreSignal = structuredClone(currentCoreSignal);
  partialCoreSignal.stat_date = "20260901";
  partialCoreSignal.tiers["0"].top_traits.push({
    key: "999:2",
    main_traits: [{ trait_id: "89999902", source_trait_id: "89999902", canonical_trait_id: "999", hero_num: 2 }],
    top1_rate: 0.2,
    top4_rate: 0.6,
    use_rate: 0.01,
  });
  const partialContinuityTrend = await buildLiveRankingTrendSummaryIncludingSignal(partialCoreSignal, {
    rootDir: partialContinuityRoot,
    keepDates: 14,
  });
  assert.deepEqual(partialContinuityTrend.retained_stat_dates, ["20260901"],
    "a partial canonical overlap must not bridge a different Core binding");

  const sparseTrend = buildLiveRankingTrendSummary([
    buildCompactLiveRankingHistorySignal(sampleSignal("20260801")),
    buildCompactLiveRankingHistorySignal(sampleSignal("20260803")),
  ]).tiers["0"].top_traits[0];
  assert.equal(sparseTrend.windows["1d"].available, false,
    "a one-day window requires the exact previous statistical date");
  assert.deepEqual(sparseTrend.consecutive.use_rate, { direction: "insufficient_history", steps: 0 },
    "consecutive trend evidence must stop at a missing statistical date");

  const cliRoot = path.join(root, "cli-prune");
  for (let date = 1; date <= 3; date += 1) {
    await archiveLiveRankingSignal({
      rootDir: cliRoot,
      signal: sampleSignal(`2026090${date}`),
      keepDates: 14,
      prune: false,
    });
  }
  const pruned = await pruneLiveRankingHistory({ rootDir: cliRoot, binding, keepDates: 2 });
  assert.deepEqual(pruned.deleted_dates, ["20260901"]);
  assert.deepEqual((await listLiveRankingHistorySignals({ rootDir: cliRoot })).map((entry) => entry.stat_date), ["20260902", "20260903"]);

  await assert.rejects(
    () => archiveLiveRankingSignal({ rootDir: root, signal: sampleSignal("../20260817"), keepDates: 14 }),
    /YYYYMMDD/,
  );
  await assert.rejects(
    () => archiveLiveRankingSignal({ rootDir: root, signal: sampleSignal("20260832"), keepDates: 14 }),
    /YYYYMMDD/,
    "history must reject impossible calendar dates instead of allowing Date.UTC normalization",
  );
  await assert.rejects(
    () => pruneLiveRankingHistory({ rootDir: root, signalsDir: path.dirname(root), keepDates: 1 }),
    /must stay inside root/,
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-live-rankings-history-verifier-v1",
    checked: [
      "retention_keeps_latest_14_distinct_dates",
      "same_date_archive_overwrites_idempotently",
      "compact_signal_excludes_raw_snapshot_and_associated_lineups",
      "compact_signal_carries_complete_ranking_binding",
      "history_storage_is_scoped_by_binding_sha256",
      "trend_reducer_rejects_mismatched_bindings",
      "compatible_core_recompile_bridges_only_canonical_trait_trend_evidence",
      "compact_signal_and_trend_retain_master_plus_only",
      "trend_summary_compiled_from_retained_compact_signals",
      "trend_is_auxiliary_and_cannot_affect_current_day_score_or_order",
      "path_safety_rejects_escaped_stat_dates_and_signals_dir",
      "invalid_calendar_dates_are_rejected_before_history_write",
    ],
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
