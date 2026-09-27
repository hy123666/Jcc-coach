import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { classifyRankingCapabilityStatus } from "./jcc_live_rankings_capability_status.mjs";
import { NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA } from "./jcc_ranking_recipe_storage.mjs";

const API_ORIGIN = "https://mlol.qt.qq.com";
const DEFAULT_MAX_AGE_HOURS = 18;
const LOOKBACK_DAYS = 7;
const MASTER_PLUS_TIER_ID = "0";

function parseArgs(argv) {
  const args = {
    today: null,
    maxAgeHours: DEFAULT_MAX_AGE_HOURS,
    offlineOk: false,
    localOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--today") args.today = argv[index + 1];
    if (arg === "--max-age-hours") args.maxAgeHours = Number(argv[index + 1]);
    if (arg === "--offline-ok") args.offlineOk = true;
    if (arg === "--local-only") args.localOnly = true;
  }
  return args;
}

function parseYmd(value) {
  if (!value) return new Date();
  if (!/^\d{8}$/.test(value)) throw new Error(`--today must be YYYYMMDD, got ${value}`);
  return new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))));
}

function ymd(date) {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function postJson(pathname, body) {
  const response = await fetch(`${API_ORIGIN}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://jcc.qq.com",
      Referer: "https://jcc.qq.com/zmjkzone/page/datarank/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}`);
  return JSON.parse(await response.text());
}

async function findLatestStatDate(today) {
  for (let offset = 0; offset < LOOKBACK_DAYS; offset += 1) {
    const statDate = ymd(new Date(today.getTime() - offset * 24 * 60 * 60 * 1000));
    const result = await postJson("/go/jgame/get_main_trait_strength_trend", {
      tier_part: MASTER_PLUS_TIER_ID,
      stat_date: statDate,
      battle_type: "31",
    });
    if (Array.isArray(result.data) && result.data.length > 0) return statDate;
  }
  throw new Error(`No non-empty ranking data found within ${LOOKBACK_DAYS} days`);
}

function hoursSince(isoString) {
  const time = Date.parse(isoString || "");
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return (Date.now() - time) / (60 * 60 * 1000);
}

const args = parseArgs(process.argv.slice(2));
const runtimePaths = createRuntimePaths(path.resolve("."));
const SNAPSHOT_PATH = path.join(runtimePaths.liveRankingsCurrentDir, "snapshot.json");
const AUDIT_PATH = runtimePaths.liveRankingsAuditFile;
const MANIFEST_PATH = runtimePaths.liveRankingsManifestFile;
const STRATEGY_INDEX_PATH = runtimePaths.liveRankingsStrategyIndexFile;
const activeRankingAvailable = Boolean(runtimePaths.activeRankingGenerationId);
if (args.localOnly) {
  console.log(JSON.stringify({
    status: activeRankingAvailable ? "live_rankings_ready" : "live_rankings_unavailable",
    ranking_overlay_id: runtimePaths.activeRankingGenerationId || null,
    stat_date: runtimePaths.activeRankingGenerationPointer?.stat_date || null,
    reason: activeRankingAvailable ? null : "compatible_master_plus_rankings_unavailable",
    network_attempted: false,
  }, null, 2));
  process.exit(0);
}
const today = parseYmd(args.today);
const snapshot = await readJsonIfExists(SNAPSHOT_PATH);
const audit = await readJsonIfExists(AUDIT_PATH);
const manifest = await readJsonIfExists(MANIFEST_PATH);
const strategyIndex = await readJsonIfExists(STRATEGY_INDEX_PATH);
const cachedComplete = Boolean(
  activeRankingAvailable
  && snapshot
  && ["pass", "partial"].includes(audit?.status)
  && (audit?.status !== "partial" || audit?.strength_status === "available")
  && manifest?.current?.files?.includes("lineup-strategy-index.json")
  && strategyIndex?.schema === NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA
  && String(strategyIndex?.content_fingerprint || "").trim(),
);

let latestStatDate = null;
try {
  latestStatDate = await findLatestStatDate(today);
} catch (error) {
  if (!cachedComplete) {
    console.warn(JSON.stringify({
      status: "live_rankings_unavailable",
      reason: "tencent_master_plus_probe_unavailable",
      ranking_overlay_id: null,
      stat_date: null,
      error_code: String(error?.message || "").startsWith("No non-empty ranking data found")
        ? "no_current_version_rows"
        : "source_probe_failed",
    }, null, 2));
    process.exit(0);
  }
  if (!args.offlineOk) throw error;
  console.warn(JSON.stringify({
    status: "using_cached_live_rankings",
    reason: "latest_probe_failed_offline_ok",
    error: error.message,
    cached_stat_date: snapshot.stat_date,
  }, null, 2));
  process.exit(0);
}

const reasons = [];
if (!snapshot) reasons.push("missing_snapshot");
if (!audit) reasons.push("missing_audit");
const capabilityStatus = classifyRankingCapabilityStatus(audit);
if (!["ready", "ready_with_source_lag"].includes(capabilityStatus.overall_status)
  || capabilityStatus.strength_status !== "available") {
  reasons.push("audit_not_publishable");
}
if (!manifest) reasons.push("missing_manifest");
if (!manifest?.current?.files?.includes("lineup-strategy-index.json")) reasons.push("legacy_manifest_missing_strategy_index");
if (!strategyIndex) reasons.push("missing_strategy_index");
else if (strategyIndex.schema !== NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA) reasons.push("legacy_strategy_index_schema");
else if (!String(strategyIndex.content_fingerprint || "").trim()) reasons.push("strategy_index_fingerprint_missing");
if (snapshot && snapshot.stat_date !== latestStatDate) {
  reasons.push(`newer_stat_date_available:${latestStatDate}`);
}
if (snapshot && hoursSince(snapshot.captured_at) > args.maxAgeHours) {
  reasons.push(`snapshot_older_than_${args.maxAgeHours}_hours`);
}

if (reasons.length) {
  console.log(JSON.stringify({
    status: "live_rankings_refresh_required",
    reasons,
    cached_stat_date: snapshot?.stat_date || null,
    latest_stat_date: latestStatDate,
    ranking_overlay_id: runtimePaths.activeRankingGenerationId || null,
    update_entrypoint: "Runtime 更新今日数据 or tools/run-jcc-version-pipeline.mjs rankings",
  }, null, 2));
  process.exit(0);
}

const verify = spawnSync("node", ["tools/verify-jcc-live-rankings.mjs"], { stdio: "inherit" });
if (verify.error) throw verify.error;
if (verify.status !== 0) process.exit(verify.status ?? 1);

console.log(JSON.stringify({
  status: "live_rankings_ready",
  stat_date: snapshot.stat_date,
  latest_stat_date: latestStatDate,
  captured_at: snapshot.captured_at,
}, null, 2));
