import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";

const CONTRACT_PATH = path.resolve("data/live-rankings/jcc/runtime-strategy-signal-contract.json");
const CONTEXT_PATH = path.resolve("data/live-rankings/jcc/current/runtime-strategy-context.json");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasArg(name) {
  return process.argv.includes(name);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function resolvePath(filePath) {
  const value = String(filePath || "");
  const prefix = "active_hard_data_manifest:";
  if (!value.startsWith(prefix)) return path.resolve(value);
  const manifestPath = path.resolve(createRuntimePaths(path.resolve(".")).activeHardDataManifest);
  return path.resolve(path.dirname(manifestPath), value.slice(prefix.length));
}

function normalizeTierPart(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value).trim();
}

function selectTierPart(contract) {
  const cliTier = normalizeTierPart(argValue("--tier-part"));
  if (cliTier) return cliTier;

  const envTier = normalizeTierPart(process.env.JCC_USER_TIER_PART) || normalizeTierPart(process.env.JCC_TIER_PART);
  if (envTier) return envTier;

  const rankLabel = normalizeTierPart(argValue("--rank-label"));
  if (rankLabel) {
    const mapped = contract.tier_selection?.rank_label_map?.[rankLabel.toLowerCase()] || contract.tier_selection?.rank_label_map?.[rankLabel];
    if (mapped) return mapped;
  }

  return String(contract.tier_selection?.default_tier_part || "0");
}

function routeIdsFrom(contract) {
  return Object.keys(contract?.route_signal_policy || {}).sort();
}

function pickSections(tierSignal, sections) {
  return Object.fromEntries(sections.map((section) => [section, tierSignal[section] || []]));
}

function buildContext({ contract, signal, audit, manifest, selectedTierPart }) {
  const selectedTier = signal.tiers?.[selectedTierPart];
  if (!selectedTier) {
    throw new Error(`rank signal tier ${selectedTierPart} is unavailable`);
  }

  const routeContexts = {};
  for (const routeId of routeIdsFrom(contract)) {
    const policy = contract.route_signal_policy?.[routeId];
    if (!policy) throw new Error(`contract missing route policy ${routeId}`);
    routeContexts[routeId] = {
      route_id: routeId,
      signal_sections: policy.signal_sections,
      strategy_use: policy.strategy_use,
      precedence: policy.precedence,
      signals: pickSections(selectedTier, policy.signal_sections),
    };
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    contract_id: contract.contract_id,
    stat_date: signal.stat_date,
    battle_type: signal.battle_type,
    selected_tier_part: selectedTierPart,
    selected_tier_label: selectedTier.label,
    source_files: {
      contract: "data/live-rankings/jcc/runtime-strategy-signal-contract.json",
      rank_signal: contract.data_sources.rank_signal,
      audit: contract.data_sources.audit,
      manifest: contract.data_sources.manifest,
    },
    audit_status: audit.status,
    manifest_current: manifest.current,
    precedence: contract.precedence,
    usage_policy: contract.usage_policy,
    route_contexts: routeContexts,
  };
}

function summarize(context) {
  return {
    status: "pass",
    context_artifact_path: "data/live-rankings/jcc/current/runtime-strategy-context.json",
    contract_id: context.contract_id,
    stat_date: context.stat_date,
    selected_tier_part: context.selected_tier_part,
    selected_tier_label: context.selected_tier_label,
    route_ids: Object.keys(context.route_contexts).sort(),
    route_count: Object.keys(context.route_contexts).length,
    precedence: context.precedence,
  };
}

const contract = await readJson(CONTRACT_PATH);
const runtimePaths = createRuntimePaths(path.resolve("."));
if (!runtimePaths.activeRankingGenerationId) throw new Error("compatible_master_plus_rankings_unavailable");
const signal = await readJson(runtimePaths.liveRankingsRankSignalFile);
const audit = await readJson(runtimePaths.liveRankingsAuditFile);
const manifest = await readJson(runtimePaths.liveRankingsManifestFile);

if (!["pass", "partial"].includes(audit.status) || (audit.status === "partial" && audit.strength_status !== "available")) {
  throw new Error(`live rankings audit is not publishable: ${audit.status}`);
}

const selectedTierPart = selectTierPart(contract);
const supportedTiers = Object.keys(contract.tier_selection?.supported_tier_parts || {});
if (!supportedTiers.includes(selectedTierPart)) {
  throw new Error(`unsupported tier part ${selectedTierPart}; supported=${supportedTiers.join(",")}`);
}

const context = buildContext({ contract, signal, audit, manifest, selectedTierPart });

if (!hasArg("--summary-only")) {
  await writeFile(CONTEXT_PATH, `${JSON.stringify(context, null, 2)}\n`);
}

console.log(JSON.stringify(summarize(context), null, 2));
