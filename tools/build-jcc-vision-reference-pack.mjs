#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inferItemClass as inferCatalogItemClass } from "./jcc_item_icon_catalog.mjs";
import { activeHardDataPath } from "./jcc_hard_data_target.mjs";

const DEFAULT_ICON_MANIFEST = "data/runtime/jcc/visual-icons/manifest.json";
const DEFAULT_HARD_DATA_DIR = activeHardDataPath(path.resolve(import.meta.dirname, ".."), "normalized");

const MODE_KIND_LIMITS = {
  augment_choice: { augment: 999, item: 0, champion: 0 },
  item_choice: { augment: 0, item: 999, champion: 0 },
  refresh_self_state: { augment: 999, item: 999, champion: 120 },
  cruise: { augment: 80, item: 999, champion: 120 },
};

const TAG_HINTS_BY_MODE = {
  augment_choice: ["economy", "combat", "item", "xp", "reroll", "trait", "augment"],
  item_choice: ["component", "completed", "artifact", "radiant", "emblem", "consumable", "item_reward"],
  refresh_self_state: ["component", "completed", "artifact", "radiant", "emblem", "consumable", "augment"],
  cruise: ["component", "completed", "artifact", "radiant", "emblem", "economy", "combat"],
};

const SUPPORTED_MODES = new Set(Object.keys(MODE_KIND_LIMITS));

function usage() {
  return [
    "Usage:",
    "  node tools/build-jcc-vision-reference-pack.mjs --mode <mode> [--live-state <state.json>] [--icon-manifest <manifest.json>] [--hard-data-dir <normalized-dir>] [--out <pack.json>]",
    "",
    "Builds a compact icon/name candidate reference pack for the multimodal runtime agent.",
    "This is not a matcher and does not inspect the game frame. It prepares reference data the model can pair visually against the current frame.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    iconManifest: DEFAULT_ICON_MANIFEST,
    hardDataDir: DEFAULT_HARD_DATA_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--live-state") options.liveState = argv[++index];
    else if (arg === "--icon-manifest") options.iconManifest = argv[++index];
    else if (arg === "--hard-data-dir") options.hardDataDir = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readJsonIfExists(file, fallback) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function valuesOf(record) {
  if (!record || typeof record !== "object") return [];
  if (Array.isArray(record)) return record;
  return Object.values(record);
}

function normalize(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function hardDataById(rows) {
  const map = new Map();
  for (const row of asArray(rows)) {
    if (!row?.id) continue;
    map.set(String(row.id), row);
  }
  return map;
}

function unitIds(unit) {
  const ids = new Set();
  for (const value of [
    unit?.id,
    unit?.raw_id,
    unit?.hero_id,
    unit?.champion_id,
    unit?.base_hero_id,
    unit?.raw_hero_id,
  ]) {
    if (value == null || value === "") continue;
    const text = String(value);
    ids.add(text);
    const number = Number(text);
    if (Number.isFinite(number) && number >= 10000) {
      ids.add(String((number % 10000) + 10000));
    }
  }
  return [...ids];
}

function unitName(unit, hardMaps) {
  for (const value of unitIds(unit)) {
    const champion = hardMaps?.champions?.get(String(value));
    if (champion?.name) return champion.name;
  }
  return unit?.champion_name || unit?.hero_name || unit?.name || null;
}

function compactLiveUnit(unit, hardMaps, sourceScope, unitIndex) {
  const ids = unitIds(unit);
  const champion = ids.map((id) => hardMaps?.champions?.get(String(id))).find(Boolean);
  return {
    unit_index: unitIndex,
    source_scope: sourceScope,
    name: unitName(unit, hardMaps),
    ids,
    hero_id: unit?.hero_id ?? unit?.champion_id ?? unit?.base_hero_id ?? unit?.id ?? champion?.id ?? null,
    raw_hero_id: unit?.raw_hero_id ?? unit?.raw_id ?? null,
    star_level_hint: unit?.star_level_hint ?? unit?.star ?? null,
    screen_position: unit?.position || (unit?.x != null && unit?.y != null ? { x: unit.x, y: unit.y } : null),
    area: unit?.area || sourceScope,
    slot: unit?.slot ?? null,
    trait_codes: unit?.trait_codes || champion?.trait_codes || null,
    traits: asArray(unit?.traits || champion?.traits).map((trait) => ({
      id: String(trait?.id ?? trait ?? ""),
      name: trait?.name || null,
    })).filter((trait) => trait.id || trait.name),
    visual_task_hint: "If identifying unit-attached equipment, inspect the visible row directly below this unit's HP bar and return at most three item candidates for this unit.",
  };
}

function collectLiveUnits(liveState, hardMaps) {
  const state = liveState?.live_state || liveState || {};
  const buckets = [
    ["current_view.raw_units", state.current_view?.raw_units],
    ["current_view.filtered_units", state.current_view?.filtered_units],
    ["current_view.units", state.current_view?.units],
    ["board.board_units", state.board?.board_units],
    ["board.local_board_units_candidate", state.board?.local_board_units_candidate],
    ["bench.bench_units", state.bench?.bench_units],
    ["bench.local_bench_units_candidate", state.bench?.local_bench_units_candidate],
  ];
  const seen = new Set();
  const units = [];
  for (const [sourceScope, rows] of buckets) {
    for (const unit of asArray(rows)) {
      const position = unit?.position || {};
      const key = [
        sourceScope,
        unit?.raw_id ?? unit?.raw_hero_id ?? unit?.id ?? unit?.hero_id ?? unit?.champion_id ?? "",
        unit?.slot ?? "",
        unit?.x ?? position.x ?? "",
        unit?.y ?? position.y ?? "",
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      units.push(compactLiveUnit(unit, hardMaps, sourceScope, units.length));
    }
  }
  return units;
}

function collectLiveUnitIds(liveState) {
  const state = liveState?.live_state || liveState || {};
  const units = [
    ...asArray(state.current_view?.raw_units),
    ...asArray(state.current_view?.filtered_units),
    ...asArray(state.current_view?.units),
    ...asArray(state.board?.board_units),
    ...asArray(state.board?.local_board_units_candidate),
    ...asArray(state.bench?.bench_units),
    ...asArray(state.bench?.local_bench_units_candidate),
  ];
  const ids = new Set();
  for (const unit of units) {
    for (const value of [
      unit?.id,
      unit?.raw_id,
      unit?.hero_id,
      unit?.champion_id,
      unit?.base_hero_id,
      unit?.raw_hero_id,
    ]) {
      if (value == null || value === "") continue;
      const text = String(value);
      ids.add(text);
      const number = Number(text);
      if (Number.isFinite(number) && number >= 10000) {
        ids.add(String((number % 10000) + 10000));
      }
    }
  }
  return ids;
}

function inferItemClass(row, template) {
  return inferCatalogItemClass(row, template);
}

function inferAugmentClass(row) {
  const tags = new Set([...(row?.tags || []), ...(row?.effect_parse?.tags || [])].map(String));
  const classes = [];
  for (const tag of ["economy", "combat", "xp", "reroll", "item", "trait", "scaling", "risk", "health"]) {
    if (tags.has(tag)) classes.push(tag);
  }
  const text = `${row?.name || ""} ${row?.desc || ""}`.toLowerCase();
  if (/(gold|economy|interest|bank|金币|经济|利息|存款|基金)/i.test(text)) classes.push("economy");
  if (/(xp|experience|level|经验|升级)/i.test(text)) classes.push("xp");
  if (/(item|anvil|artifact|component|装备|锻造|神器|散件|成装)/i.test(text)) classes.push("item");
  return [...new Set(classes)];
}

function tierColor(tier, template) {
  const hard = template?.hard_data_tier_color;
  if (hard) return hard;
  const normalized = String(tier ?? "").trim().toLowerCase();
  if (["1", "silver", "white"].includes(normalized)) return "silver";
  if (["2", "gold", "golden"].includes(normalized)) return "gold";
  if (["3", "prismatic", "colorful", "rainbow"].includes(normalized)) return "prismatic";
  return null;
}

function enrichTemplate(template, hardMaps) {
  const id = String(template.id);
  const hard =
    template.kind === "item" ? hardMaps.items.get(id)
      : template.kind === "augment" ? hardMaps.augments.get(id)
        : template.kind === "champion" ? hardMaps.champions.get(id) : null;
  const name = hard?.name || template.name || null;
  const base = {
    kind: template.kind,
    id,
    name,
    icon_path: template.local_path,
    icon_url: template.icon_url || null,
    local_exists: template.local_exists === true,
    visual_reference_role: "candidate_icon_for_multimodal_pairing",
  };
  if (template.kind === "item") {
    return {
      ...base,
      item_class: inferItemClass(hard, template),
      tags: hard?.tags || [],
      stats: hard?.stats || null,
      text_hint: hard?.basic_desc || hard?.type || null,
    };
  }
  if (template.kind === "augment") {
    return {
      ...base,
      tier: hard?.tier || null,
      tier_color: tierColor(hard?.tier, template),
      classes: inferAugmentClass(hard),
      round_hints: template.round_hints || [],
      text_hint: hard?.desc ? hard.desc.slice(0, 120) : null,
    };
  }
  if (template.kind === "champion") {
    return {
      ...base,
      cost: hard?.cost ?? null,
      traits: asArray(hard?.traits).map((trait) => ({ id: String(trait.id ?? ""), name: trait.name })).filter((trait) => trait.id || trait.name),
    };
  }
  return base;
}

function scoreCandidate(candidate, { mode, liveUnitIds }) {
  let score = 0;
  const hints = TAG_HINTS_BY_MODE[mode] || [];
  if (candidate.kind === "champion" && liveUnitIds.has(candidate.id)) score += 100;
  if (candidate.kind === "item") {
    if (["item_choice", "refresh_self_state"].includes(mode)) score += 20;
    if (hints.includes(candidate.item_class)) score += 10;
    if (candidate.item_class === "component") score += 2;
    if (candidate.item_class === "completed") score += 3;
    if (candidate.item_class === "artifact" || candidate.item_class === "radiant") score += 4;
    if (candidate.item_class === "emblem" || candidate.item_class === "consumable") score += 5;
  }
  if (candidate.kind === "augment") {
    if (["augment_choice", "refresh_self_state"].includes(mode)) score += 20;
    for (const cls of candidate.classes || []) {
      if (hints.includes(cls)) score += 4;
    }
    if (candidate.tier_color) score += 1;
  }
  if (candidate.kind === "champion" && ["refresh_self_state", "cruise"].includes(mode)) score += 10;
  return score;
}

function selectCandidates(templates, hardMaps, options) {
  const modeLimits = MODE_KIND_LIMITS[options.mode] || MODE_KIND_LIMITS.cruise;
  const liveUnitIds = collectLiveUnitIds(options.liveState);
  const byKind = {};
  for (const template of templates) {
    if (!template?.kind || !template?.id || !template?.local_path || template.local_exists !== true) continue;
    if (!["item", "augment", "champion"].includes(template.kind)) continue;
    const candidate = enrichTemplate(template, hardMaps);
    const score = scoreCandidate(candidate, { mode: options.mode, liveUnitIds });
    if (!byKind[candidate.kind]) byKind[candidate.kind] = [];
    byKind[candidate.kind].push({ ...candidate, reference_priority: score });
  }
  const selected = {};
  for (const [kind, rows] of Object.entries(byKind)) {
    const limit = modeLimits[kind] ?? 0;
    selected[kind] = rows
      .sort((a, b) => b.reference_priority - a.reference_priority || a.id.localeCompare(b.id, "en"))
      .slice(0, limit);
  }
  return selected;
}

function buildVisualGroups(candidates) {
  const groups = [];
  for (const [kind, rows] of Object.entries(candidates)) {
    const byUrl = new Map();
    for (const row of rows || []) {
      const key = row.icon_url || row.icon_path;
      if (!byUrl.has(key)) byUrl.set(key, []);
      byUrl.get(key).push(row);
    }
    for (const [icon, entries] of byUrl.entries()) {
      if (entries.length <= 1) continue;
      groups.push({
        kind,
        icon,
        status: "same_visual_group",
        entries: entries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          tier_color: entry.tier_color || null,
          round_hints: entry.round_hints || [],
        })),
        disambiguation_rule: kind === "augment"
          ? "visible text first, then tier color/stage/history/user confirmation; otherwise keep possible_ids"
          : "use visible text, unit/shop context, or user confirmation; otherwise keep possible_ids",
      });
    }
  }
  return groups;
}

function inspectionTargetsForMode(mode) {
  const targets = {
    augment_choice: [
      "augments.choices",
      "augments.reroll_state_if_visible",
    ],
    item_choice: [
      "items.choice_options",
    ],
    refresh_self_state: [
      "economy.hp",
      "economy.gold",
      "economy.level",
      "economy.xp",
      "items.item_bench",
      "items.equipped_items",
      "augments.selected_augments",
      "visible_special_effect_text",
    ],
    cruise: [
      "high_value_missing_visual_context",
      "economy.hp",
      "economy.gold",
      "economy.level",
      "economy.xp",
      "items.item_bench",
      "items.equipped_items",
      "augments.selected_augments",
    ],
  };
  return targets[mode] || targets.cruise;
}

function groundingPolicyForMode(mode) {
  const base = [
    "Use only visible current-frame evidence plus provided MuMu 4353/current_view anchors.",
    "Candidate libraries define the allowed answer space; do not invent names or IDs.",
    "For same-icon groups, keep possible_ids unless visible text, tier color, stage/history, or user confirmation resolves the exact ID.",
    "For unit equipment, identify at most three item slots under each listed unit HP bar; do not infer best-in-slot or expected items from strategy context.",
    "If visibility is weak, emit needs_confirmation=true or omit the field.",
  ];
  if (mode === "augment_choice") {
    return [
      ...base,
      "For augment choices, read the current three visible cards only. Prior choices and helper-log text are history, not current truth.",
      "If reroll/refresh state is visible, report it separately; do not merge old and new card sets.",
    ];
  }
  if (mode === "refresh_self_state") {
    return [
      ...base,
      "Self board/bench unit identity comes from MuMu bridge; report only visual fields such as economy, inventory, selected augments, and visible unit equipment.",
    ];
  }
  return base;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.mode) throw new Error(`Missing --mode\n${usage()}`);
  if (!SUPPORTED_MODES.has(options.mode)) {
    throw new Error(`Unsupported --mode ${options.mode}. Supported: ${[...SUPPORTED_MODES].join(", ")}`);
  }
  const iconManifest = await readJson(options.iconManifest);
  const liveState = options.liveState ? await readJson(options.liveState) : {};
  const hardMaps = {
    items: hardDataById(await readJsonIfExists(path.join(options.hardDataDir, "items.json"), [])),
    augments: hardDataById(await readJsonIfExists(path.join(options.hardDataDir, "augments.json"), [])),
    champions: hardDataById(await readJsonIfExists(path.join(options.hardDataDir, "champions.json"), [])),
  };
  const templates = valuesOf(iconManifest.templates);
  const candidates = selectCandidates(templates, hardMaps, { ...options, liveState });
  const liveUnits = collectLiveUnits(liveState, hardMaps).slice(0, 24);
  const inspectionTargets = inspectionTargetsForMode(options.mode);
  const output = {
    ok: true,
    schema: "jcc-vision-reference-pack-v1",
    mode: options.mode,
    source_manifest: options.iconManifest,
    hard_data_dir: options.hardDataDir,
    role: "candidate_icon_and_name_reference_for_multimodal_agent",
    not_a_matcher: true,
    policy: {
      product_use: "Provide these icon/name candidates alongside the current full frame so the multimodal runtime agent can visually pair UI elements with known JCC entities.",
      forbidden_use: "Do not treat this pack as a local template-match result or verified observation.",
      ambiguity: "Same-icon or visually similar candidates must remain possible_ids unless visible text, tier color, MuMu context, history, or user confirmation disambiguates them.",
    },
    inspection_targets: inspectionTargets,
    live_context: {
      source: "match_scoped_live_state",
      current_view_units: liveUnits,
      current_view_unit_count: liveUnits.length,
      unit_anchor_policy: "MuMu 4353/current_view unit anchors constrain where unit equipment should be inspected. They are not a request for the model to identify board/bench units.",
    },
    response_constraints: {
      allowed_entity_sources: ["candidate_libraries", "visible_text", "mumu_unit_anchors", "user_confirmed_history"],
      no_invention: true,
      unresolved_policy: "Return possible_ids and needs_confirmation=true when icon/text evidence does not uniquely identify an entity.",
      image_bytes_forbidden: true,
      board_bench_output_forbidden: true,
      required_output_style: "structured_json_only",
      grounding_policy: groundingPolicyForMode(options.mode),
    },
    counts: {
      item: candidates.item?.length || 0,
      augment: candidates.augment?.length || 0,
      champion: candidates.champion?.length || 0,
    },
    candidates,
    visual_groups: buildVisualGroups(candidates),
  };
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (options.out) await writeFile(options.out, text, "utf8");
  else process.stdout.write(text);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
