import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const DEFAULT_OUT = null;

const DEFAULT_LEVELING_RULES = {
  natural_xp_per_round: 2,
  manual_xp_per_click: 4,
  manual_xp_gold_cost: 4,
  source: "default_jcc_rule",
};

const DEFAULT_XP_TO_NEXT_BY_LEVEL = {
  1: 2,
  2: 6,
  3: 10,
  4: 20,
  5: 36,
  6: 36,
  7: 60,
  8: 80,
  9: 84,
  10: 100,
};

const DEFAULT_SHOP_ODDS_BY_LEVEL = {
  1: [1, 0, 0, 0, 0],
  2: [1, 0, 0, 0, 0],
  3: [0.75, 0.25, 0, 0, 0],
  4: [0.55, 0.30, 0.15, 0, 0],
  5: [0.45, 0.33, 0.20, 0.02, 0],
  6: [0.30, 0.40, 0.25, 0.05, 0],
  7: [0.19, 0.30, 0.35, 0.15, 0.01],
  8: [0.18, 0.25, 0.32, 0.22, 0.03],
  9: [0.10, 0.20, 0.25, 0.35, 0.10],
  10: [0.05, 0.10, 0.20, 0.40, 0.25],
};

const DEFAULT_XP_MODIFIER_CATALOG_FILE = path.resolve(
  import.meta.dirname,
  "..",
  "data",
  "runtime",
  "jcc",
  "xp-policy-modifier-catalog.json",
);

const DEFAULT_RESOURCE_MODIFIER_CATALOG_FILE = path.resolve(
  import.meta.dirname,
  "..",
  "data",
  "runtime",
  "jcc",
  "resource-policy-modifier-catalog.json",
);

const DEFAULT_MUMU_CATALOG_OVERLAY_FILE = path.resolve(
  import.meta.dirname,
  "..",
  "data",
  "runtime",
  "jcc",
  "mumu-catalog-overlay.json",
);

function usage() {
  return [
    "Usage:",
    "  node tools/build-jcc-strategy-tables.mjs [--overrides <file>] [--out <file>]",
    "",
    "Builds stable runtime strategy tables: XP rules, shop odds, and XP modifier catalog.",
    "It intentionally does not pre-enumerate per-game lineup tempo/key-level decisions.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--overrides") options.overrides = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file, fallback = null) {
  if (!file || !existsSync(file)) return fallback;
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function readJsonSync(file, fallback = null) {
  if (!file || !existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function buildChampionCostIndex(catalogOverlay = {}, overrides = {}) {
  const byId = {};
  const byName = {};
  for (const entry of Object.values(catalogOverlay.champions_by_id || {})) {
    const cost = Number(entry?.cost);
    if (!Number.isFinite(cost)) continue;
    const ids = [entry.id, entry.raw_id, entry.base_id, entry.champion_id].filter((value) => value !== undefined && value !== null);
    for (const id of ids) byId[String(id)] = cost;
    const names = [entry.name, entry.normalized_name, entry.cn_name].filter(Boolean);
    for (const name of names) byName[String(name)] = cost;
  }
  return {
    by_id: {
      ...byId,
      ...(overrides.by_id || {}),
    },
    by_name: {
      ...byName,
      ...(overrides.by_name || {}),
    },
    source: Object.keys(catalogOverlay.champions_by_id || {}).length ? "mumu_catalog_overlay" : "empty",
  };
}

function summarizeResourceCatalog(catalog = {}) {
  const rows = [
    ...(Array.isArray(catalog.confirmed_modifiers) ? catalog.confirmed_modifiers : []),
    ...(Array.isArray(catalog.pending_confirmation) ? catalog.pending_confirmation : []),
  ];
  const byDomain = {};
  const byEffectClass = {};
  const byTriggerTiming = {};
  const confirmedKeysByDomain = {};
  for (const row of rows) {
    const domains = Array.isArray(row.resource_domains) ? row.resource_domains : [];
    for (const domain of domains) {
      byDomain[domain] = (byDomain[domain] || 0) + 1;
      if (row.promotion_state === "confirmed") {
        confirmedKeysByDomain[domain] ||= [];
        confirmedKeysByDomain[domain].push(row.key);
      }
    }
    for (const effectClass of row.effect_classes || []) {
      byEffectClass[effectClass] = (byEffectClass[effectClass] || 0) + 1;
    }
    for (const timing of row.trigger_timing || []) {
      byTriggerTiming[timing] = (byTriggerTiming[timing] || 0) + 1;
    }
  }
  return {
    row_count: rows.length,
    confirmed_count: Array.isArray(catalog.confirmed_modifiers) ? catalog.confirmed_modifiers.length : 0,
    pending_count: Array.isArray(catalog.pending_confirmation) ? catalog.pending_confirmation.length : 0,
    by_domain: byDomain,
    by_effect_class: byEffectClass,
    by_trigger_timing: byTriggerTiming,
    confirmed_keys_by_domain: confirmedKeysByDomain,
  };
}

function isXpDomainModifier(modifier) {
  return Array.isArray(modifier?.resource_domains) && modifier.resource_domains.includes("xp");
}

function isConfirmedResourceModifier(modifier) {
  return modifier?.promotion_state === "confirmed";
}

function buildAugmentSemanticProfileIndex(semanticFeatureIndex = {}) {
  const rows = (Array.isArray(semanticFeatureIndex?.entities) ? semanticFeatureIndex.entities : [])
    .filter((entry) => entry?.entity_kind === "augment" && entry?.augment_profile);
  const byId = {};
  const byName = {};
  for (const row of rows) {
    const profile = row.augment_profile;
    for (const id of [row.entity_id, profile.augment_id].filter(Boolean)) byId[String(id)] = profile;
    for (const name of [row.name, profile.name].filter(Boolean)) byName[String(name).trim().toLowerCase()] = profile;
  }
  return {
    schema: "jcc-augment-semantic-profile-index-v1",
    source_core_profile_id: semanticFeatureIndex?.identity?.core_profile_id || null,
    profile_count: rows.length,
    by_id: byId,
    by_name: byName,
    policy: {
      active_core_profile_only: true,
      no_name_classification_fallback: true,
      runtime_axes_are_not_persisted_here: true,
    },
  };
}

function normalizeAugmentNameKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[!！]/g, "")
    .trim()
    .toLowerCase();
}

function filterResourceModifiersForActiveCore(rows, augmentProfiles) {
  if (!augmentProfiles?.profile_count) return rows;
  return rows.filter((row) => {
    if (row?.kind !== "augment") return true;
    return (Array.isArray(row.match) ? row.match : [])
      .map(normalizeAugmentNameKey)
      .some((name) => Boolean(augmentProfiles.by_name?.[name]));
  });
}

function buildStrategyTables(overrides = {}) {
  const runtimeModifierCatalog = overrides.runtime_resource_modifier_catalog
    || overrides.runtime_xp_modifier_catalog
    || readJsonSync(DEFAULT_RESOURCE_MODIFIER_CATALOG_FILE, null)
    || readJsonSync(DEFAULT_XP_MODIFIER_CATALOG_FILE, {})
    || {};
  const catalogOverlay = overrides.mumu_catalog_overlay
    || readJsonSync(DEFAULT_MUMU_CATALOG_OVERLAY_FILE, {})
    || {};
  const semanticFeatureIndex = overrides.semantic_feature_index || {};
  const augmentSemanticProfiles = buildAugmentSemanticProfileIndex(semanticFeatureIndex);
  const confirmedModifiers = filterResourceModifiersForActiveCore(Array.isArray(runtimeModifierCatalog.confirmed_modifiers)
    ? runtimeModifierCatalog.confirmed_modifiers
    : [], augmentSemanticProfiles);
  const pendingModifiers = filterResourceModifiersForActiveCore(Array.isArray(runtimeModifierCatalog.pending_confirmation)
    ? runtimeModifierCatalog.pending_confirmation
    : [], augmentSemanticProfiles);
  return {
    schema: "jcc-strategy-tables-v1",
    generated_at: new Date().toISOString(),
    policy: {
      static_tables_only: true,
      dynamic_lineup_tempo_policy: "derive_from_live_state_target_plan_and_rankings_at_runtime",
      no_per_match_lineup_tempo_enumeration: true,
    },
    leveling_rules: {
      ...DEFAULT_LEVELING_RULES,
      ...(overrides.leveling_rules || {}),
      xp_to_next_by_level: {
        ...DEFAULT_XP_TO_NEXT_BY_LEVEL,
        ...(overrides.xp_to_next_by_level || overrides.leveling_rules?.xp_to_next_by_level || {}),
      },
    },
    shop_odds_by_level: {
      ...DEFAULT_SHOP_ODDS_BY_LEVEL,
      ...(overrides.shop_odds_by_level || {}),
    },
    champion_cost_index: buildChampionCostIndex(catalogOverlay, overrides.champion_cost_index || {}),
    resource_modifier_catalog: {
      schema: runtimeModifierCatalog.schema || "jcc-resource-policy-modifier-catalog-v1",
      taxonomy: runtimeModifierCatalog.taxonomy || null,
      confirmed_modifiers: confirmedModifiers,
      pending_confirmation: pendingModifiers,
    },
    resource_policy_index: summarizeResourceCatalog({
      confirmed_modifiers: confirmedModifiers,
      pending_confirmation: pendingModifiers,
    }),
    augment_semantic_profiles: augmentSemanticProfiles,
    xp_modifier_catalog: [
      ...confirmedModifiers.filter(isXpDomainModifier),
      ...pendingModifiers.filter(isXpDomainModifier),
      ...(Array.isArray(overrides.xp_modifier_catalog)
        ? overrides.xp_modifier_catalog.filter((modifier) => isXpDomainModifier(modifier) && isConfirmedResourceModifier(modifier))
        : []),
    ],
    value_index_policy: {
      unit_values: "computed from target_plan, hard-data entity weights, daily rankings, live own-state, and user-confirmed scouting notes at runtime",
      item_values: "computed from target_plan, hard-data item fit, board holders, and available components at runtime",
      deny_values: "computed from user-confirmed scouting notes and player economy/level at runtime; runtime does not fabricate opponent board facts",
    },
    version_filter_policy: {
      augment_resource_modifiers_require_active_core_profile_membership: Boolean(augmentSemanticProfiles.profile_count),
      non_augment_common_modifiers_remain_available: true,
      no_foreign_season_augment_modifier_fallback: true,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const overrides = await readJson(options.overrides, {});
  const result = buildStrategyTables(overrides || {});
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) await writeFile(options.out, json, "utf8");
  process.stdout.write(json);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export { buildStrategyTables, DEFAULT_LEVELING_RULES, DEFAULT_SHOP_ODDS_BY_LEVEL };
