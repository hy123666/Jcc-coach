import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const DEFAULT_HISTORY_KEEP_DATES = 14;
export const DEFAULT_LIVE_RANKINGS_ROOT = path.resolve("data/live-rankings/jcc");
export const HISTORY_SCHEMA = "jcc-live-rankings-history-signal-v1";
export const TREND_SCHEMA = "jcc-live-rankings-trend-summary-v1";

const STAT_DATE_PATTERN = /^\d{8}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BINDING_FIELDS = [
  "season_id",
  "patch_id",
  "core_profile_id",
  "catalog_fingerprint",
  "hard_data_manifest_fingerprint",
  "battle_type",
  "tier",
  "lineup_version_id",
  "ranking_set_id",
];
const TREND_CONTINUITY_FIELDS = [
  "season_id",
  "patch_id",
  "battle_type",
  "tier",
  "lineup_version_id",
  "ranking_set_id",
];
const HISTORY_SIGNAL_LIMITS = {
  top_traits: 64,
  top_heroes: 25,
  top_equips: 25,
  hero_item_signal: 35,
  top_lineups: 25,
  augment_lineup_signal: 60,
};

function assertStatDate(value) {
  const statDate = String(value || "");
  if (!STAT_DATE_PATTERN.test(statDate) || statDateEpochDay(statDate) === null) {
    throw new Error(`live ranking history stat_date must be YYYYMMDD, got ${value}`);
  }
  return statDate;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function assertInsideRoot(root, target, label) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`live ranking history ${label} must stay inside root: ${target}`);
  }
}

function normalizeBinding(binding) {
  const normalized = Object.fromEntries(BINDING_FIELDS.map((field) => [field, String(binding?.[field] ?? "").trim()]));
  if (!normalized.season_id || !normalized.patch_id) throw new Error("live ranking history binding requires season_id and patch_id");
  if (!SHA256_PATTERN.test(normalized.core_profile_id)) throw new Error("live ranking history binding requires a valid core_profile_id");
  if (!SHA256_PATTERN.test(normalized.catalog_fingerprint)) throw new Error("live ranking history binding requires a valid catalog_fingerprint");
  if (!SHA256_PATTERN.test(normalized.hard_data_manifest_fingerprint)) throw new Error("live ranking history binding requires a valid hard_data_manifest_fingerprint");
  if (!normalized.battle_type || !normalized.lineup_version_id || !normalized.ranking_set_id) {
    throw new Error("live ranking history binding requires battle_type, lineup_version_id, and ranking_set_id");
  }
  if (normalized.tier !== "0") throw new Error(`live ranking history binding tier must be 0, got ${normalized.tier || "missing"}`);
  return normalized;
}

export function liveRankingHistoryBinding(signalOrBinding) {
  if (signalOrBinding?.binding) return normalizeBinding(signalOrBinding.binding);
  if (BINDING_FIELDS.every((field) => signalOrBinding?.[field] !== undefined)) return normalizeBinding(signalOrBinding);
  const source = signalOrBinding?.source_identity || {};
  const topLevelBattleType = String(signalOrBinding?.battle_type ?? "").trim();
  const sourceBattleType = String(source.battle_type ?? "").trim();
  const topLevelLineupVersion = String(signalOrBinding?.lineup_version_id ?? "").trim();
  const sourceLineupVersion = String(source.lineup_version_id ?? "").trim();
  if (topLevelBattleType && sourceBattleType && topLevelBattleType !== sourceBattleType) {
    throw new Error("live ranking history battle_type binding mismatch");
  }
  if (topLevelLineupVersion && sourceLineupVersion && topLevelLineupVersion !== sourceLineupVersion) {
    throw new Error("live ranking history lineup_version_id binding mismatch");
  }
  return normalizeBinding({
    season_id: source.runtime_season_id || source.season_id,
    patch_id: source.active_patch_id || source.patch_id,
    core_profile_id: source.core_profile_id,
    catalog_fingerprint: source.catalog_source_fingerprint || source.catalog_fingerprint,
    hard_data_manifest_fingerprint: source.hard_data_manifest_fingerprint || source.hard_data_fingerprint,
    battle_type: sourceBattleType || topLevelBattleType,
    tier: "0",
    lineup_version_id: sourceLineupVersion || topLevelLineupVersion,
    ranking_set_id: source.ranking_set_id,
  });
}

export function liveRankingHistoryBindingSha256(signalOrBinding) {
  return createHash("sha256").update(JSON.stringify(liveRankingHistoryBinding(signalOrBinding))).digest("hex");
}

function liveRankingTrendContinuityIdentity(signalOrBinding) {
  const binding = liveRankingHistoryBinding(signalOrBinding);
  return Object.fromEntries(TREND_CONTINUITY_FIELDS.map((field) => [field, binding[field]]));
}

function sameTrendContinuityIdentity(left, right) {
  const leftIdentity = liveRankingTrendContinuityIdentity(left);
  const rightIdentity = liveRankingTrendContinuityIdentity(right);
  return TREND_CONTINUITY_FIELDS.every((field) => leftIdentity[field] === rightIdentity[field]);
}

function resolveBindingPaths(options = {}, bindingInput) {
  const root = path.resolve(options.rootDir || DEFAULT_LIVE_RANKINGS_ROOT);
  const binding = liveRankingHistoryBinding(bindingInput || options.binding || options.signal);
  const bindingSha256 = liveRankingHistoryBindingSha256(binding);
  const bindingDir = path.join(root, "history", "by-binding", bindingSha256);
  const signalsDir = path.join(bindingDir, "signals");
  if (options.signalsDir) {
    const requestedSignalsDir = path.resolve(options.signalsDir);
    assertInsideRoot(root, requestedSignalsDir, "signals directory");
    if (requestedSignalsDir !== signalsDir) {
      throw new Error(`live ranking history signals directory must match binding-scoped path: ${signalsDir}`);
    }
  }
  return { root, binding, bindingSha256, bindingDir, signalsDir };
}

function signalFilePath(signalsDir, statDate) {
  const filePath = path.resolve(signalsDir, `${assertStatDate(statDate)}.json`);
  if (path.dirname(filePath) !== signalsDir) {
    throw new Error(`resolved history signal path escaped signals directory: ${filePath}`);
  }
  return filePath;
}

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceTraitFamilyId(value) {
  const traitId = String(value || "").trim();
  return traitId.length >= 6 ? traitId.slice(0, 6) : traitId;
}

function canonicalTraitAliasMap(rows = []) {
  const aliases = new Map();
  for (const row of rows) {
    if (row?.source_dictionary_status !== "resolved_official_frontend_dictionary") continue;
    const canonicalId = String(row?.canonical_trait_id || row?.check_id || "").trim();
    const sourceId = sourceTraitFamilyId(row?.source_trait_id || row?.trait_id);
    if (canonicalId && sourceId) aliases.set(sourceId, canonicalId);
  }
  return aliases;
}

function canonicalTraitKeys(rows = [], aliases = null) {
  return new Set((Array.isArray(rows) ? rows : [])
    .map((row) => normalizeLiveRankingTraitTrendKey(row?.key, row?.main_traits, aliases))
    .filter(Boolean));
}

function rawTraitSourceKey(row) {
  const parts = (Array.isArray(row?.main_traits) ? row.main_traits : [])
    .map((trait) => {
      const sourceId = sourceTraitFamilyId(trait?.source_trait_id || trait?.trait_id);
      const breakpoint = finiteNumber(trait?.hero_num ?? trait?.chess_num ?? trait?.count ?? trait?.breakpoint);
      return sourceId && breakpoint !== null ? `${sourceId}:${breakpoint}` : null;
    })
    .filter(Boolean)
    .sort();
  return [...new Set(parts)].join("|");
}

function traitContinuityReceipt(priorSignal, currentSignal) {
  const currentRows = currentSignal?.tiers?.["0"]?.top_traits || [];
  const aliases = canonicalTraitAliasMap(currentRows.flatMap((row) => row?.main_traits || []));
  const priorRows = priorSignal?.tiers?.["0"]?.top_traits || [];
  const priorKeys = canonicalTraitKeys(priorRows, aliases);
  const currentKeys = canonicalTraitKeys(currentRows, aliases);
  const priorRawKeys = priorRows.map(rawTraitSourceKey).filter(Boolean).sort();
  const currentRawKeys = currentRows.map(rawTraitSourceKey).filter(Boolean).sort();
  const completeRawIdentity = priorRawKeys.length === priorRows.length
    && currentRawKeys.length === currentRows.length
    && priorRawKeys.length > 0
    && JSON.stringify(priorRawKeys) === JSON.stringify(currentRawKeys);
  const completeCanonicalTranslation = priorKeys.size === priorRows.length
    && currentKeys.size === currentRows.length
    && priorKeys.size === currentKeys.size
    && [...currentKeys].every((key) => priorKeys.has(key));
  const sourceSignature = createHash("sha256").update(JSON.stringify(currentRawKeys)).digest("hex");
  return {
    schema: "jcc-live-rankings-trait-continuity-receipt-v1",
    accepted: completeRawIdentity && completeCanonicalTranslation,
    proof: "same_complete_raw_trait_rows_and_bijective_current_core_translation",
    source_trait_signature_sha256: sourceSignature,
    overlap_count: completeCanonicalTranslation ? currentKeys.size : 0,
    overlap_ratio: completeCanonicalTranslation ? 1 : 0,
    current_trait_count: currentKeys.size,
    prior_trait_count: priorKeys.size,
    complete_raw_identity: completeRawIdentity,
    complete_canonical_translation: completeCanonicalTranslation,
  };
}

function bridgeTraitHistorySignal(priorSignal, currentSignal, continuity) {
  const currentBinding = liveRankingHistoryBinding(currentSignal);
  const currentBindingSha256 = liveRankingHistoryBindingSha256(currentBinding);
  return {
    ...priorSignal,
    binding: currentBinding,
    binding_sha256: currentBindingSha256,
    continuity_bridge: {
      schema: "jcc-live-rankings-trait-continuity-bridge-v1",
      source_binding: priorSignal.binding,
      source_binding_sha256: priorSignal.binding_sha256,
      target_binding: currentBinding,
      target_binding_sha256: currentBindingSha256,
      scope: "top_traits_only",
      proof: continuity.proof,
      source_trait_signature_sha256: continuity.source_trait_signature_sha256,
      overlap_count: continuity.overlap_count,
      overlap_ratio: continuity.overlap_ratio,
      current_trait_count: continuity.current_trait_count,
      prior_trait_count: continuity.prior_trait_count,
    },
    tiers: {
      "0": {
        label: priorSignal?.tiers?.["0"]?.label || "master_plus",
        top_traits: priorSignal?.tiers?.["0"]?.top_traits || [],
        top_heroes: [],
        top_equips: [],
        hero_item_signal: [],
        top_lineups: [],
        augment_lineup_signal: [],
      },
    },
  };
}

export function normalizeLiveRankingTraitTrendKey(value, mainTraits = [], canonicalAliases = null) {
  const fromRows = (Array.isArray(mainTraits) ? mainTraits : [])
    .map((row) => {
      const dictionaryResolved = row?.source_dictionary_status === "resolved_official_frontend_dictionary";
      const traitId = String(
        dictionaryResolved
          ? row?.canonical_trait_id || row?.check_id || ""
          : row?.trait_id || row?.source_trait_id || "",
      ).trim();
      const breakpoint = finiteNumber(row?.hero_num ?? row?.chess_num ?? row?.count ?? row?.breakpoint);
      if (!traitId || breakpoint === null) return null;
      const canonical = dictionaryResolved && Boolean(row?.canonical_trait_id || row?.check_id);
      const sourceFamilyId = sourceTraitFamilyId(traitId);
      const identity = canonical ? traitId : canonicalAliases?.get(sourceFamilyId) || sourceFamilyId;
      return `${identity}:${breakpoint}`;
    })
    .filter(Boolean)
    .sort();
  if (fromRows.length) return [...new Set(fromRows)].join("|");

  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = raw.split(/[;|]/u).map((part) => {
    const token = String(part || "").trim();
    const match = token.match(/^(\d+)(?::|_)(\d+(?:\.\d+)?)$/u);
    if (!match) return token;
    const familyId = sourceTraitFamilyId(match[1]);
    return `${canonicalAliases?.get(familyId) || familyId}:${Number(match[2])}`;
  }).filter(Boolean).sort();
  return [...new Set(normalized)].join("|");
}

function cloneMetricRow(row, fields) {
  const result = {};
  for (const field of fields) {
    if (row?.[field] === undefined) continue;
    result[field] = field.endsWith("_rate") || field === "avg_rank" || field === "signal_score" || field === "use_num" || field === "total_use_num"
      ? finiteNumber(row[field])
      : row[field];
  }
  return result;
}

function compactTraits(rows) {
  return (rows || []).slice(0, HISTORY_SIGNAL_LIMITS.top_traits).map((row) => ({
    key: normalizeLiveRankingTraitTrendKey(row.key, row.main_traits) || null,
    main_traits: Array.isArray(row.main_traits) ? row.main_traits.slice(0, 4) : [],
    top1_rate: finiteNumber(row.top1_rate),
    top4_rate: finiteNumber(row.top4_rate),
    use_rate: finiteNumber(row.use_rate),
    signal_score: finiteNumber(row.signal_score),
  }));
}

function compactHeroes(rows) {
  return (rows || []).slice(0, HISTORY_SIGNAL_LIMITS.top_heroes).map((row) => cloneMetricRow(row, [
    "hero_id",
    "top1_rate",
    "top4_rate",
    "avg_rank",
    "use_rate",
    "signal_score",
  ]));
}

function compactEquips(rows) {
  return (rows || []).slice(0, HISTORY_SIGNAL_LIMITS.top_equips).map((row) => ({
    equip_id: row.equip_id || null,
    top1_rate: finiteNumber(row.top1_rate),
    top4_rate: finiteNumber(row.top4_rate),
    avg_rank: finiteNumber(row.avg_rank),
    use_rate: finiteNumber(row.use_rate),
    top_3_hero: Array.isArray(row.top_3_hero) ? row.top_3_hero.slice(0, 3).map(String) : [],
    signal_score: finiteNumber(row.signal_score),
  }));
}

function compactHeroItemSignal(rows) {
  return (rows || []).slice(0, HISTORY_SIGNAL_LIMITS.hero_item_signal).map((row) => ({
    hero_id: row.hero_id || null,
    source: row.source || null,
    interpretation: row.interpretation || null,
    signal_score: finiteNumber(row.signal_score),
    item_count: Array.isArray(row.items) ? row.items.length : 0,
    items: (row.items || []).slice(0, 8).map((item) => cloneMetricRow(item, [
      "equip_id",
      "top1_rate",
      "top4_rate",
      "avg_rank",
      "use_rate",
      "use_count",
      "hero_slot",
      "signal_score",
    ])),
  }));
}

function compactLineups(rows) {
  return (rows || []).slice(0, HISTORY_SIGNAL_LIMITS.top_lineups).map((row) => cloneMetricRow(row, [
    "id",
    "main_trait_list",
    "main_c_chess_id",
    "avg_rank",
    "top1_rate",
    "top4_rate",
    "use_rate",
    "use_num",
    "signal_score",
  ]));
}

function compactAugmentLineupSignal(rows) {
  return (rows || []).slice(0, HISTORY_SIGNAL_LIMITS.augment_lineup_signal).map((row) => ({
    augment_id: row.augment_id || null,
    source: row.source || null,
    interpretation: row.interpretation || null,
    not_independent_winrate: Boolean(row.not_independent_winrate),
    lineup_count: finiteNumber(row.lineup_count),
    associated_lineup_rows_retained: 0,
    total_use_num: finiteNumber(row.total_use_num),
    weighted_top1_rate: finiteNumber(row.weighted_top1_rate),
    weighted_top4_rate: finiteNumber(row.weighted_top4_rate),
    weighted_avg_rank: finiteNumber(row.weighted_avg_rank),
    weighted_use_rate: finiteNumber(row.weighted_use_rate),
    signal_score: finiteNumber(row.signal_score),
  }));
}

export function buildCompactLiveRankingHistorySignal(signal, options = {}) {
  const statDate = assertStatDate(options.statDate || signal?.stat_date);
  const binding = liveRankingHistoryBinding(signal);
  const bindingSha256 = liveRankingHistoryBindingSha256(binding);
  const tiers = {};
  for (const [tierPart, tier] of Object.entries(signal?.tiers || {})) {
    if (String(tierPart) !== "0") continue;
    tiers[tierPart] = {
      label: tier?.label || null,
      top_traits: compactTraits(tier?.top_traits),
      top_heroes: compactHeroes(tier?.top_heroes),
      top_equips: compactEquips(tier?.top_equips),
      hero_item_signal: compactHeroItemSignal(tier?.hero_item_signal),
      top_lineups: compactLineups(tier?.top_lineups),
      augment_lineup_signal: compactAugmentLineupSignal(tier?.augment_lineup_signal),
    };
  }
  return {
    schema: HISTORY_SCHEMA,
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source_schema_version: signal?.schema_version ?? null,
    stat_date: statDate,
    binding,
    binding_sha256: bindingSha256,
    compact_policy: {
      source: "rank-signal",
      excludes: ["snapshot", "raw", "associated lineup arrays"],
      keep_distinct_dates: positiveInteger(options.keepDates, DEFAULT_HISTORY_KEEP_DATES),
      scope: "exact_ranking_binding_only",
    },
    tiers,
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempFile, `${JSON.stringify(value)}\n`, "utf8");
    await rename(tempFile, filePath);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}

const TREND_SECTION_SPECS = {
  top_traits: { key: "key", metrics: ["top1_rate", "top4_rate", "use_rate"] },
  top_heroes: { key: "hero_id", metrics: ["top1_rate", "top4_rate", "avg_rank", "use_rate"] },
  top_equips: { key: "equip_id", metrics: ["top1_rate", "top4_rate", "avg_rank", "use_rate"] },
  top_lineups: { key: "id", metrics: ["top1_rate", "top4_rate", "avg_rank", "use_rate", "use_num"] },
  augment_lineup_signal: { key: "augment_id", metrics: ["weighted_top1_rate", "weighted_top4_rate", "weighted_avg_rank", "weighted_use_rate", "total_use_num"] },
};

function trendDirection(metric, delta, observationCount) {
  if (observationCount < 2 || !Number.isFinite(delta)) return "insufficient_history";
  const epsilon = metric.includes("rate") ? 0.002 : metric.includes("rank") ? 0.05 : 1;
  if (Math.abs(delta) < epsilon) return "stable";
  const lowerIsBetter = metric.includes("avg_rank");
  return (delta > 0) !== lowerIsBetter ? "rising" : "falling";
}

function statDateEpochDay(value) {
  const text = String(value || "");
  if (!/^\d{8}$/u.test(text)) return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (!Number.isFinite(timestamp)
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day) return null;
  return Math.floor(timestamp / 86_400_000);
}

function trendWindows(observations, metrics) {
  const latest = observations.at(-1) || null;
  const latestDay = statDateEpochDay(latest?.stat_date);
  const windows = {};
  for (const windowDays of [1, 3, 7]) {
    const baseline = latestDay === null ? null : observations.find((observation) => {
      const day = statDateEpochDay(observation?.stat_date);
      return day !== null && latestDay - day === windowDays;
    }) || null;
    const deltas = Object.fromEntries(metrics.map((metric) => {
      const current = finiteNumber(latest?.metrics?.[metric]);
      const prior = finiteNumber(baseline?.metrics?.[metric]);
      return [metric, current !== null && prior !== null ? current - prior : null];
    }));
    const relative = Object.fromEntries(metrics.map((metric) => {
      const delta = finiteNumber(deltas[metric]);
      const prior = finiteNumber(baseline?.metrics?.[metric]);
      return [metric, delta !== null && prior !== null && prior !== 0 ? delta / Math.abs(prior) : null];
    }));
    windows[`${windowDays}d`] = {
      window_days: windowDays,
      baseline_stat_date: baseline?.stat_date || null,
      latest_stat_date: latest?.stat_date || null,
      deltas,
      relative_changes: relative,
      available: Boolean(baseline && latest),
    };
  }
  return windows;
}

function consecutiveDirection(observations, metric) {
  const values = observations
    .map((observation) => ({
      day: statDateEpochDay(observation?.stat_date),
      value: finiteNumber(observation?.metrics?.[metric]),
    }))
    .filter((entry) => entry.day !== null && entry.value !== null);
  if (values.length < 2) return { direction: "insufficient_history", steps: 0 };
  const contiguous = [values.at(-1)];
  for (let index = values.length - 2; index >= 0; index -= 1) {
    if (contiguous.at(-1).day - values[index].day !== 1) break;
    contiguous.push(values[index]);
  }
  contiguous.reverse();
  if (contiguous.length < 2) return { direction: "insufficient_history", steps: 0 };
  const changes = contiguous.slice(1).map((entry, index) => entry.value - contiguous[index].value);
  const lastDirection = changes.at(-1) > 0 ? "rising" : changes.at(-1) < 0 ? "falling" : "stable";
  let steps = 0;
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const direction = changes[index] > 0 ? "rising" : changes[index] < 0 ? "falling" : "stable";
    if (direction !== lastDirection) break;
    steps += 1;
  }
  return { direction: lastDirection, steps };
}

function buildTrendSection(signals, tierId, section, spec) {
  const latestRows = signals.at(-1)?.tiers?.[tierId]?.[section] || [];
  const canonicalAliases = section === "top_traits"
    ? canonicalTraitAliasMap(latestRows.flatMap((row) => row?.main_traits || []))
    : null;
  return latestRows.map((latestRow) => {
    const identity = section === "top_traits"
      ? normalizeLiveRankingTraitTrendKey(latestRow?.[spec.key], latestRow?.main_traits, canonicalAliases)
      : String(latestRow?.[spec.key] || "");
    const observations = signals.map((signal) => {
      const row = (signal?.tiers?.[tierId]?.[section] || []).find((candidate) => {
        const candidateIdentity = section === "top_traits"
          ? normalizeLiveRankingTraitTrendKey(candidate?.[spec.key], candidate?.main_traits, canonicalAliases)
          : String(candidate?.[spec.key] || "");
        return candidateIdentity === identity;
      });
      if (!row) return null;
      return {
        stat_date: signal.stat_date,
        metrics: Object.fromEntries(spec.metrics.map((metric) => [metric, finiteNumber(row?.[metric])])),
      };
    }).filter(Boolean);
    const metricObservations = Object.fromEntries(spec.metrics.map((metric) => [metric, observations
      .filter((observation) => Number.isFinite(observation?.metrics?.[metric]))]));
    const earliest = observations[0] || null;
    const latest = observations.at(-1) || null;
    const deltas = Object.fromEntries(spec.metrics.map((metric) => {
      const valid = metricObservations[metric];
      return [metric, valid.length >= 2 ? valid.at(-1).metrics[metric] - valid[0].metrics[metric] : null];
    }));
    return {
      [spec.key]: section === "top_traits" ? identity || null : latestRow?.[spec.key] || null,
      observation_count: observations.length,
      observations,
      first_stat_date: earliest?.stat_date || null,
      latest_stat_date: latest?.stat_date || null,
      latest: latest?.metrics || null,
      deltas,
      windows: trendWindows(observations, spec.metrics),
      consecutive: Object.fromEntries(spec.metrics.map((metric) => [metric, consecutiveDirection(observations, metric)])),
      directions: Object.fromEntries(spec.metrics.map((metric) => [
        metric,
        trendDirection(metric, deltas[metric], metricObservations[metric].length),
      ])),
    };
  });
}

export function buildLiveRankingTrendSummary(signals) {
  const ordered = [...(signals || [])].sort((left, right) => String(left?.stat_date || "").localeCompare(String(right?.stat_date || "")));
  const latest = ordered.at(-1) || null;
  const binding = latest ? liveRankingHistoryBinding(latest) : null;
  const bindingSha256 = binding ? liveRankingHistoryBindingSha256(binding) : null;
  for (const signal of ordered) {
    const candidateBindingSha256 = liveRankingHistoryBindingSha256(signal);
    if (candidateBindingSha256 !== bindingSha256 || signal.binding_sha256 !== bindingSha256) {
      throw new Error(`live ranking history reducer binding mismatch: expected ${bindingSha256}, got ${signal.binding_sha256 || candidateBindingSha256}`);
    }
  }
  const tierIds = Object.keys(latest?.tiers || {});
  return {
    schema: TREND_SCHEMA,
    generated_at: new Date().toISOString(),
    binding,
    binding_sha256: bindingSha256,
    current_stat_date: latest?.stat_date || null,
    retained_stat_dates: ordered.map((signal) => signal.stat_date),
    policy: {
      role: "auxiliary_diagnostics_only",
      source: "retained_compact_history_signals",
      never_mix_tiers: true,
      never_mix_bindings: true,
      trait_continuity_bridge: ordered.some((signal) => signal?.continuity_bridge)
        ? "verified_source_semantic_receipt"
        : "not_used",
      may_affect_current_day_score: false,
      may_affect_current_day_order: false,
      live_match_use: "compiled_current_binding_auxiliary_evidence_only; verified_trait_continuity_receipt_required; direct_history_reads_forbidden",
    },
    continuity_bridges: ordered
      .filter((signal) => signal?.continuity_bridge)
      .map((signal) => ({ stat_date: signal.stat_date, ...signal.continuity_bridge })),
    tiers: Object.fromEntries(tierIds.map((tierId) => [tierId, {
      label: latest?.tiers?.[tierId]?.label || null,
      ...Object.fromEntries(Object.entries(TREND_SECTION_SPECS).map(([section, spec]) => [
        section,
        buildTrendSection(ordered, tierId, section, spec),
      ])),
    }])),
  };
}

export async function buildLiveRankingTrendSummaryIncludingSignal(signal, options = {}) {
  const current = buildCompactLiveRankingHistorySignal(signal, options);
  const entries = await listLiveRankingHistorySignals({
    ...options,
    binding: current.binding,
  });
  const retained = [];
  for (const entry of entries) retained.push(await readJson(entry.file_path));
  if (options.allowTraitContinuityBridge !== false) {
    const allEntries = await listLiveRankingHistorySignals({ rootDir: options.rootDir || DEFAULT_LIVE_RANKINGS_ROOT });
    const priorByDate = new Map();
    for (const entry of allEntries) {
      if (entry.binding_sha256 === current.binding_sha256 || entry.stat_date >= current.stat_date) continue;
      const prior = await readJson(entry.file_path);
      if (!sameTrendContinuityIdentity(prior, current)) continue;
      const continuity = traitContinuityReceipt(prior, current);
      if (!continuity.accepted) continue;
      const existing = priorByDate.get(prior.stat_date);
      if (!existing || continuity.overlap_ratio > existing.continuity.overlap_ratio) {
        priorByDate.set(prior.stat_date, { prior, continuity });
      }
    }
    for (const { prior, continuity } of priorByDate.values()) {
      retained.push(bridgeTraitHistorySignal(prior, current, continuity));
    }
  }
  const byDate = new Map(retained.map((entry) => [entry.stat_date, entry]));
  byDate.set(current.stat_date, current);
  const ordered = [...byDate.values()]
    .sort((left, right) => left.stat_date.localeCompare(right.stat_date))
    .slice(-positiveInteger(options.keepDates, DEFAULT_HISTORY_KEEP_DATES));
  return buildLiveRankingTrendSummary(ordered);
}

async function writeLatestTrendSummary(options = {}, entries = null) {
  const paths = resolveBindingPaths(options, options.binding);
  const selectedEntries = entries || await listLiveRankingHistorySignals({ ...options, binding: paths.binding });
  const signals = [];
  for (const entry of selectedEntries) signals.push(await readJson(entry.file_path));
  const summary = buildLiveRankingTrendSummary(signals);
  const filePath = path.join(paths.bindingDir, "latest-trend-summary.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeJson(filePath, summary);
  return { file_path: filePath, summary };
}

async function listBindingDirectories(root) {
  const byBindingDir = path.join(root, "history", "by-binding");
  const entries = await readdir(byBindingDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory() && SHA256_PATTERN.test(entry.name))
    .map((entry) => ({ binding_sha256: entry.name, binding_dir: path.join(byBindingDir, entry.name) }))
    .sort((left, right) => left.binding_sha256.localeCompare(right.binding_sha256));
}

async function listSignalsForPaths(paths) {
  const { binding, bindingSha256, signalsDir } = paths;
  const entries = await readdir(signalsDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const signals = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^\d{8}\.json$/.test(entry.name)) continue;
    const statDate = entry.name.slice(0, 8);
    const filePath = signalFilePath(signalsDir, statDate);
    const signal = await readJson(filePath);
    if (liveRankingHistoryBindingSha256(signal) !== bindingSha256 || signal.binding_sha256 !== bindingSha256) {
      throw new Error(`live ranking history signal binding mismatch at ${filePath}`);
    }
    signals.push({ stat_date: statDate, file_path: filePath, binding, binding_sha256: bindingSha256 });
  }
  return signals.sort((left, right) => left.stat_date.localeCompare(right.stat_date));
}

export async function listLiveRankingHistorySignals(options = {}) {
  const root = path.resolve(options.rootDir || DEFAULT_LIVE_RANKINGS_ROOT);
  if (options.binding) return listSignalsForPaths(resolveBindingPaths(options, options.binding));
  if (options.signalsDir) {
    assertInsideRoot(root, path.resolve(options.signalsDir), "signals directory");
    throw new Error("live ranking history signalsDir requires an exact binding");
  }
  const results = [];
  for (const directory of await listBindingDirectories(root)) {
    const signalFiles = await readdir(path.join(directory.binding_dir, "signals"), { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const firstSignalFile = signalFiles.find((entry) => entry.isFile() && /^\d{8}\.json$/.test(entry.name));
    if (!firstSignalFile) continue;
    const firstSignal = await readJson(path.join(directory.binding_dir, "signals", firstSignalFile.name));
    const binding = liveRankingHistoryBinding(firstSignal);
    if (liveRankingHistoryBindingSha256(binding) !== directory.binding_sha256) {
      throw new Error(`live ranking history binding directory mismatch: ${directory.binding_dir}`);
    }
    results.push(...await listSignalsForPaths(resolveBindingPaths({ rootDir: root }, binding)));
  }
  return results.sort((left, right) => left.binding_sha256.localeCompare(right.binding_sha256) || left.stat_date.localeCompare(right.stat_date));
}

async function pruneBindingHistory(options, binding) {
  const keepDates = positiveInteger(options.keepDates, DEFAULT_HISTORY_KEEP_DATES);
  const paths = resolveBindingPaths(options, binding);
  const signals = await listSignalsForPaths(paths);
  const excess = signals.slice(0, Math.max(0, signals.length - keepDates));
  const deleted = [];
  for (const signal of excess) {
    const filePath = signalFilePath(paths.signalsDir, signal.stat_date);
    await rm(filePath, { force: true });
    deleted.push(signal.stat_date);
  }
  return {
    ok: true,
    keep_dates: keepDates,
    retained_dates: signals.slice(excess.length).map((signal) => signal.stat_date),
    deleted_dates: deleted,
    binding: paths.binding,
    binding_sha256: paths.bindingSha256,
    signals_dir: paths.signalsDir,
  };
}

export async function pruneLiveRankingHistory(options = {}) {
  if (options.binding) return pruneBindingHistory(options, options.binding);
  const entries = await listLiveRankingHistorySignals(options);
  const bindings = new Map(entries.map((entry) => [entry.binding_sha256, entry.binding]));
  const results = [];
  for (const binding of bindings.values()) results.push(await pruneBindingHistory(options, binding));
  return {
    ok: true,
    keep_dates: positiveInteger(options.keepDates, DEFAULT_HISTORY_KEEP_DATES),
    retained_dates: results.flatMap((result) => result.retained_dates),
    deleted_dates: results.flatMap((result) => result.deleted_dates),
    bindings: results,
  };
}

export async function archiveLiveRankingSignal(signalOrOptions, maybeOptions = {}) {
  const options = signalOrOptions?.signal || signalOrOptions?.rankSignalPath || signalOrOptions?.currentSignalPath
    ? signalOrOptions
    : { ...maybeOptions, signal: signalOrOptions };
  const root = path.resolve(options.rootDir || DEFAULT_LIVE_RANKINGS_ROOT);
  const signal = options.signal || await readJson(options.rankSignalPath || options.currentSignalPath || path.join(root, "current", "rank-signal.json"));
  const compactSignal = buildCompactLiveRankingHistorySignal(signal, options);
  const paths = resolveBindingPaths(options, compactSignal.binding);
  const filePath = signalFilePath(paths.signalsDir, compactSignal.stat_date);
  await mkdir(paths.signalsDir, { recursive: true });
  await writeJson(filePath, compactSignal);
  const keepDates = positiveInteger(options.keepDates, DEFAULT_HISTORY_KEEP_DATES);
  const scopedOptions = { ...options, binding: compactSignal.binding };
  const availableSignals = await listLiveRankingHistorySignals(scopedOptions);
  const trendSummary = await buildLiveRankingTrendSummaryIncludingSignal(signal, {
    ...options,
    rootDir: root,
    keepDates,
  });
  const trendFilePath = path.join(paths.bindingDir, "latest-trend-summary.json");
  await writeJson(trendFilePath, trendSummary);
  const pruned = options.prune === false
    ? { ok: true, keep_dates: keepDates, retained_dates: availableSignals.map((entry) => entry.stat_date), deleted_dates: [], binding: paths.binding, binding_sha256: paths.bindingSha256, signals_dir: paths.signalsDir }
    : await pruneLiveRankingHistory(scopedOptions);
  return {
    ok: true,
    stat_date: compactSignal.stat_date,
    binding: paths.binding,
    binding_sha256: paths.bindingSha256,
    file_path: filePath,
    pruned,
    trend_summary_file: trendFilePath,
    normalized_master_plus_history_dates: [],
  };
}
