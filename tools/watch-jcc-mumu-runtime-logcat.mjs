import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";
import { attachMumuBoardGrid, isMumuGiXYOnCalibratedBoard } from "./jcc-mumu-board-grid.mjs";
import { normalizeMumuHeroId } from "./jcc-mumu-hero-id.mjs";

function usage() {
  return [
    "Usage:",
    "  node tools/watch-jcc-mumu-runtime-logcat.mjs [--adb <adb.exe>] [--device <adb-serial>] [--out-dir <dir>] [--match-session-id <id>] [--duration-ms <ms>]",
    "",
    "Streams adb logcat from now and extracts MuMu gi_plugin_jkchess payloads plus phase markers,",
    "and compact unknown nemuinit command counts. It does not save screenshots or full raw logs.",
    "By default it starts from the device's current logcat timestamp; use --include-logcat-backlog only for debug replay.",
    "",
    "4354 shop_units auto-establishes the self-view anchor for the current match session.",
    "Self-view anchoring is derived only from S=1 plus visible non-empty 4354 shop evidence.",
    "Only fresh 4353-minus-4352 after visible shop anchoring can promote own board; 4358 S codes are phase/status evidence only.",
    "",
    "This watcher only emits structured MuMu source facts and revisions; runtime-service owns scheduling.",
    "--logcat-fixture reads a saved logcat text fixture instead of spawning adb.",
  ].join("\n");
}

const SHOP_SELF_VIEW_ANCHOR_TTL_MS = 90_000;
const OWN_EQUIPMENT_ASSIGN_MAX_DISTANCE_PX = 95;

function parseArgs(argv) {
  const options = {
    adb: process.env.JCC_ADB || ".omx/bin/adb.exe",
    device: null,
    outDir: ".omx/runtime-evidence/mumu-gi-live/current-watch",
    durationMs: 0,
    summaryIntervalMs: 3000,
    clearLogcatFirst: false,
    includeLogcatBacklog: false,
    catalogOverlay: "data/runtime/jcc/mumu-catalog-overlay.json",
    logcatFixture: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--adb") options.adb = argv[++index];
    else if (arg === "--device") options.device = argv[++index];
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--match-session-id") options.matchSessionId = argv[++index];
    else if (arg === "--duration-ms") options.durationMs = Number(argv[++index]);
    else if (arg === "--summary-interval-ms") options.summaryIntervalMs = Number(argv[++index]);
    else if (arg === "--clear-logcat-first") options.clearLogcatFirst = true;
    else if (arg === "--include-logcat-backlog") options.includeLogcatBacklog = true;
    else if (arg === "--catalog-overlay") options.catalogOverlay = argv[++index];
    else if (arg === "--no-catalog-overlay") options.catalogOverlay = null;
    else if (arg === "--logcat-fixture") options.logcatFixture = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function runProcess(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function getDeviceLogcatSinceTime(options) {
  const args = options.device
    ? ["-s", options.device, "shell", "date", "+%m-%d_%H:%M:%S.000"]
    : ["shell", "date", "+%m-%d_%H:%M:%S.000"];
  const result = await runProcess(options.adb, args);
  const value = result.stdout.trim().split(/\r?\n/).at(-1)?.trim();
  if (result.code === 0 && /^\d{2}-\d{2}_\d{2}:\d{2}:\d{2}\.\d{3}$/.test(value || "")) {
    return value.replace("_", " ");
  }
  return null;
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function unitFromGiHero(entry, area) {
  const hero = normalizeMumuHeroId(entry?.i);
  return {
    ...hero,
    x: numberOrNull(entry?.x),
    y: numberOrNull(entry?.y),
    position: {
      source: "mumu_gi_xy",
      x: numberOrNull(entry?.x),
      y: numberOrNull(entry?.y),
      area,
    },
    area,
    confidence: 0.9,
    semantic_status: "mumu_structured_candidate",
    evidence_source: "gi_plugin_jkchess",
  };
}

function shopUnitFromGiBuy(entry, index) {
  const hero = normalizeMumuHeroId(entry?.i);
  return {
    slot_index: index,
    ...hero,
    rect: {
      left: numberOrNull(entry?.l),
      top: numberOrNull(entry?.t),
      right: numberOrNull(entry?.r),
      bottom: numberOrNull(entry?.b),
    },
    confidence: 0.9,
    semantic_status: "mumu_structured_candidate",
    evidence_source: "gi_plugin_jkchess",
  };
}

function equipFromGi(entry, index, area) {
  return {
    slot_index: index,
    item_id: numberOrNull(entry?.i),
    equip_id: numberOrNull(entry?.i),
    rect: {
      left: numberOrNull(entry?.l),
      top: numberOrNull(entry?.t),
      right: numberOrNull(entry?.r),
      bottom: numberOrNull(entry?.b),
    },
    area,
    confidence: 0.85,
    semantic_status: "mumu_structured_candidate",
    evidence_source: "gi_plugin_jkchess",
  };
}

function carouselUnitFromGi(entry, index) {
  const hero = normalizeMumuHeroId(entry?.i);
  return {
    slot_index: index,
    ...hero,
    item_id: numberOrNull(entry?.e),
    equip_id: numberOrNull(entry?.e),
    position: {
      source: "mumu_gi_xy",
      x: numberOrNull(entry?.x),
      y: numberOrNull(entry?.y),
      area: "carousel",
    },
    confidence: 0.85,
    semantic_status: "mumu_structured_candidate",
    evidence_source: "gi_plugin_jkchess",
  };
}

function unitKey(unit) {
  const id = unit?.base_hero_id ?? unit?.hero_id ?? unit?.champion_id;
  return `${id}:${unit?.x}:${unit?.y}`;
}

function splitCurrentViewScope(rawBoardUnits, benchUnits) {
  const benchKeys = new Set((benchUnits || []).map(unitKey));
  let benchOverlapCount = 0;
  const filteredUnits = [];
  for (const unit of rawBoardUnits || []) {
    if (benchKeys.has(unitKey(unit))) {
      benchOverlapCount += 1;
      continue;
    }
    if (!isMumuGiXYOnCalibratedBoard(unit)) continue;
    filteredUnits.push({
      ...unit,
      area: "board",
      position: {
        ...(unit.position || {}),
        area: "board",
      },
    });
  }
  return { filtered_units: filteredUnits, bench_overlap_count: benchOverlapCount };
}

function emptyState(matchSessionId) {
  const now = new Date().toISOString();
  return {
    schema: "jcc-mumu-runtime-watch-state-v1",
    match_session_id: matchSessionId || `mumu-${now.replace(/[:.]/g, "-")}`,
    watch_started_at: now,
    last_observed_at: null,
    source_revision: 0,
    latest_source_observation: null,
    match: {
      status: "unknown",
      starts: [],
      ends: [],
    },
    phase: {
      mumu_status_code: null,
      status_history: [],
    },
    local: {
      local_player_scope_status: "unproven",
      self_view_anchor_established_at: null,
      self_view_anchor_last_seen_at: null,
      evidence: [],
      conclusion: "4352/4353 payloads are structured unit lists. The local self-view anchor is visible 4354 shop data; 4358 S codes are phase/status evidence only and must not promote own board by themselves.",
    },
    current_view: {
      raw_units: [],
      filtered_units: [],
      bench_overlap_count: 0,
      derived_traits: [],
      derived_trait_policy: null,
      scope_status: "unverified_current_view_or_combat_scope",
      last_updated_at: null,
    },
    board: {
      local_board_units_candidate: [],
      stale_local_board_units_reference: null,
      local_board_derived_traits: [],
      promotion_status: "blocked_until_4354_shop_self_view_anchor",
      last_promoted_at: null,
      last_promotion_evidence: null,
    },
    bench: {
      bench_units: [],
      stale_bench_units_reference: null,
      field_status: null,
    },
    shop: {
      shop_units: [],
      last_updated_at: null,
      last_non_empty_seen_at: null,
    },
    carousel: {
      active: "unknown",
      available_units: [],
    },
    items: {
      item_bench: [],
      equipped_items: [],
      visible_equipment_unassigned: [],
    },
    augment: {
      status_code_4_seen: false,
      status_code_4_active: false,
      last_status_code_4_at: null,
    },
    catalogs: {
      mumu_catalog_overlay_loaded: false,
      mumu_catalog_overlay_counts: null,
    },
    command_counts: {},
    nemuinit_name_counts: {},
    recent_interesting_lines: [],
    source_diagnostics: {
      schema: "jcc-mumu-watch-source-diagnostics-v1",
      line_counts: {
        total_lines_seen: 0,
        nemuinit_start_lines_seen: 0,
        gi_plugin_lines_parsed: 0,
        gi_plugin_lines_rejected: 0,
      },
      parse_rejection_counts: {
        nemuinit_start_regex_miss: 0,
        malformed_json_payload: 0,
      },
      command_presence: {
        has_4353: false,
        has_4356: false,
        has_4357: false,
        has_equipment_like_unknown_command: false,
      },
      unknown_command_counts: {},
      equipment_like_unknown_command_counts: {},
      payload_shape_counts_by_command: {},
      suspicious_unparsed_equipment_lines: [],
      capture_health: {
        bytes_read: 0,
        last_line_observed_at: null,
        last_gi_line_observed_at: null,
        logcat_process_exit_code: null,
        logcat_process_signal: null,
        capture_loss_possible: false,
        capture_loss_reason: null,
      },
      item_source_classification: {
        status: "waiting_for_gi_stream",
        reason: "no_relevant_gi_command_observed",
        evidence: {},
      },
    },
    pollution_guard: {
      started_from_logcat_now: true,
      logcat_backlog_included: false,
      logcat_backlog_policy: "unset",
      source_mode: "live",
      logcat_since_time: null,
      full_raw_log_saved: false,
      screenshots_saved: false,
      cross_match_fusion_allowed: false,
      self_view_anchor_manual: false,
      self_view_anchor_shop_4354: false,
    },
  };
}

function parseNemuinitStart(line) {
  const match = /start name:\s*([^,]+),\s*operation:\s*(\d+)(?:\s+(\{.*\}))?,\s*id:\s*(\d+)/.exec(line);
  if (!match) return null;
  let payload = {};
  if (match[3]) {
    try {
      payload = JSON.parse(match[3]);
    } catch {
      payload = { parse_error_raw: match[3] };
    }
  }
  return {
    name: match[1],
    command: Number(match[2]),
    payload,
    nemuinit_message_id: Number(match[4]),
  };
}

const KNOWN_GI_COMMANDS = new Set([4096, 8192, 4352, 4353, 4354, 4355, 4356, 4357, 4358]);
const EQUIPMENT_LIKE_LINE = /GiEquipList|equip(?:ment)?List|operation:\s*(?:4356|4357)|cmd:\s*0x110[45]|\"el\"\s*:/i;
const EQUIPMENT_PAYLOAD_LINE = /GiEquipList|equip(?:ment)?List|\"el\"\s*:/i;

function pushBounded(values, value, limit = 20) {
  values.push(value);
  if (values.length > limit) values.splice(0, values.length - limit);
}

function incrementNestedCounter(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function recordSourceLineDiagnostics(state, line, parsed) {
  const diagnostics = state.source_diagnostics;
  const observedAt = new Date().toISOString();
  diagnostics.line_counts.total_lines_seen += 1;
  diagnostics.capture_health.bytes_read += Buffer.byteLength(line, "utf8") + 1;
  diagnostics.capture_health.last_line_observed_at = observedAt;
  const looksLikeNemuStart = /NemuInit:.*start name:/i.test(line);
  if (looksLikeNemuStart) diagnostics.line_counts.nemuinit_start_lines_seen += 1;

  if (!parsed) {
    if (looksLikeNemuStart) diagnostics.parse_rejection_counts.nemuinit_start_regex_miss += 1;
    if (looksLikeNemuStart && EQUIPMENT_PAYLOAD_LINE.test(line)) {
      diagnostics.line_counts.gi_plugin_lines_rejected += 1;
      pushBounded(diagnostics.suspicious_unparsed_equipment_lines, {
        observed_at: observedAt,
        line: line.slice(0, 1200),
      });
    }
    return;
  }

  if (parsed.name !== "gi_plugin_jkchess") return;
  diagnostics.line_counts.gi_plugin_lines_parsed += 1;
  diagnostics.capture_health.last_gi_line_observed_at = observedAt;
  const command = Number(parsed.command);
  if (command === 4353) diagnostics.command_presence.has_4353 = true;
  if (command === 4356) diagnostics.command_presence.has_4356 = true;
  if (command === 4357) diagnostics.command_presence.has_4357 = true;

  const payload = parsed.payload || {};
  if (payload.parse_error_raw) diagnostics.parse_rejection_counts.malformed_json_payload += 1;
  if (command === 4356 || command === 4357) {
    const key = String(command);
    diagnostics.payload_shape_counts_by_command[key] ||= {
      el_array: 0,
      el_non_empty: 0,
      el_empty: 0,
      el_missing: 0,
      parse_error_raw: 0,
    };
    const shapes = diagnostics.payload_shape_counts_by_command[key];
    if (Array.isArray(payload.el)) {
      shapes.el_array += 1;
      if (payload.el.length) shapes.el_non_empty += 1;
      else shapes.el_empty += 1;
    } else {
      shapes.el_missing += 1;
    }
    if (payload.parse_error_raw) shapes.parse_error_raw += 1;
  } else if (!KNOWN_GI_COMMANDS.has(command)) {
    incrementNestedCounter(diagnostics.unknown_command_counts, String(command));
    if (Array.isArray(payload.el) || EQUIPMENT_LIKE_LINE.test(line)) {
      diagnostics.command_presence.has_equipment_like_unknown_command = true;
      incrementNestedCounter(diagnostics.equipment_like_unknown_command_counts, String(command));
    }
  }
}

function refreshItemSourceClassification(state) {
  const diagnostics = state.source_diagnostics;
  const commandCounts = state.command_counts || {};
  const shape4356 = diagnostics.payload_shape_counts_by_command["4356"] || {};
  const shape4357 = diagnostics.payload_shape_counts_by_command["4357"] || {};
  const giStreamActive = ["4352", "4353", "4354", "4358"].some((command) => Number(commandCounts[command] || 0) > 0);
  const evidence = {
    command_4353_count: Number(commandCounts["4353"] || 0),
    command_4356_count: Number(commandCounts["4356"] || 0),
    command_4357_count: Number(commandCounts["4357"] || 0),
    command_4356_non_empty_count: Number(shape4356.el_non_empty || 0),
    command_4357_non_empty_count: Number(shape4357.el_non_empty || 0),
    equipped_item_count: state.items.equipped_items.length,
    visible_equipment_unassigned_count: state.items.visible_equipment_unassigned.length,
    item_bench_count: state.items.item_bench.length,
  };
  let status = "waiting_for_gi_stream";
  let reason = "no_relevant_gi_command_observed";
  if (diagnostics.capture_health.capture_loss_possible) {
    status = "capture_loss_possible";
    reason = diagnostics.capture_health.capture_loss_reason || "logcat_stream_interrupted";
  } else if (
    Number(diagnostics.parse_rejection_counts.malformed_json_payload || 0) > 0
    || diagnostics.suspicious_unparsed_equipment_lines.length > 0
  ) {
    status = "parse_rejection";
    reason = "equipment_like_source_line_or_payload_was_not_parsed_cleanly";
  } else if (diagnostics.command_presence.has_equipment_like_unknown_command) {
    status = "changed_command_id_suspected";
    reason = "unknown_gi_command_carried_equipment_like_payload";
  } else if (
    Number(shape4356.el_non_empty || 0) > 0
    && state.items.equipped_items.length === 0
    && state.items.visible_equipment_unassigned.length > 0
  ) {
    status = "promotion_gate_rejected";
    reason = "4356_visible_equipment_not_assigned_to_trusted_own_units";
  } else if (Number(commandCounts["4357"] || 0) > 0) {
    status = "item_source_ready";
    reason = state.items.item_bench.length > 0
      ? "4357_populated_left_item_rail"
      : "4357_observed_empty_left_item_rail";
  } else if (giStreamActive) {
    status = "source_not_emitted";
    reason = "gi_stream_active_with_board_or_shop_commands_but_no_4357_command_seen";
  }
  diagnostics.item_source_classification = { status, reason, evidence };
  return diagnostics;
}

async function loadCatalogOverlay(file) {
  if (!file) return null;
  try {
    const catalog = JSON.parse(await readFile(file, "utf8"));
    catalog.__traits_by_code = buildTraitsByCode(catalog);
    return catalog;
  } catch {
    return null;
  }
}

function splitCodeList(value) {
  return String(value ?? "")
    .split("|")
    .map((code) => code.trim())
    .filter((code) => code && code !== "-1" && code !== "0");
}

function buildTraitsByCode(catalog) {
  const byCode = new Map();
  for (const trait of Object.values(catalog?.traits_by_id || {})) {
    const code = String(trait?.code_id || "");
    if (!code) continue;
    const previous = byCode.get(code);
    if (!previous || Number(trait.id || 0) < Number(previous.id || 0)) byCode.set(code, trait);
  }
  return byCode;
}

function traitFromCode(catalog, code) {
  const trait = catalog?.__traits_by_code?.get(String(code));
  if (!trait) return null;
  return {
    code: String(code),
    trait_id: String(trait.id),
    name: trait.name,
    breakpoints: splitCodeList(trait.breakpoints),
    icon_url: trait.icon_url || null,
  };
}

function decorateChampion(unit, catalog) {
  if (!catalog) return unit;
  const id = String(unit?.base_hero_id ?? unit?.hero_id ?? unit?.champion_id ?? "");
  const entry = catalog.champions_by_id?.[id];
  if (!entry) return unit;
  const traitCodes = [...new Set([
    ...splitCodeList(entry.class_or_trait_codes),
    ...splitCodeList(entry.shop_or_pool_code),
  ])];
  const traits = traitCodes.map((code) => traitFromCode(catalog, code)).filter(Boolean);
  return {
    ...unit,
    name: entry.name,
    champion_name: entry.name,
    cost: entry.cost,
    trait_codes: traitCodes,
    traits,
    icon_url: entry.icon_url,
    catalog_source: entry.source,
  };
}

function decorateItem(item, catalog) {
  if (!catalog) return item;
  const id = String(item?.item_id ?? item?.equip_id ?? "");
  const entry = catalog.items_by_id?.[id];
  if (!entry) return item;
  const grantsTraits = splitCodeList(entry.formula)
    .map((code) => traitFromCode(catalog, code))
    .filter(Boolean);
  return {
    ...item,
    name: entry.name,
    item_name: entry.name,
    grants_trait_codes: grantsTraits.length > 0
      ? grantsTraits.map((trait) => trait.code)
      : item.grants_trait_codes,
    grants_traits: grantsTraits.length > 0
      ? grantsTraits
      : item.grants_traits,
    icon_url: entry.icon_url,
    catalog_source: entry.source,
  };
}

function decorateUnits(units, catalog) {
  return (units || []).map((unit) => decorateChampion(unit, catalog));
}

function decorateItems(items, catalog) {
  return (items || []).map((item) => decorateItem(item, catalog));
}

function deriveTraits(units, items = []) {
  const counts = new Map();
  const evidence = new Map();
  const traitsByCode = new Map();
  const add = (trait, detail) => {
    const code = String(trait?.code || "");
    if (!code) return;
    counts.set(code, (counts.get(code) || 0) + 1);
    if (!evidence.has(code)) evidence.set(code, []);
    evidence.get(code).push(detail);
    traitsByCode.set(code, trait);
  };
  for (const unit of units || []) {
    for (const trait of unit.traits || []) {
      add(trait, {
        source: "unit",
        unit_id: String(unit.champion_id ?? unit.hero_id ?? unit.raw_hero_id ?? ""),
        unit_name: unit.name || unit.champion_name || null,
      });
    }
  }
  for (const item of items || []) {
    for (const trait of item.grants_traits || []) {
      add(trait, {
        source: "trait_item",
        item_id: String(item.item_id ?? item.equip_id ?? ""),
        item_name: item.name || item.item_name || null,
      });
    }
  }
  return [...counts.entries()]
    .map(([code, count]) => {
      const trait = traitsByCode.get(code);
      const breakpoints = (trait?.breakpoints || [])
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      return {
        code,
        trait_id: trait?.trait_id || null,
        name: trait?.name || code,
        count,
        active_breakpoint: breakpoints.filter((value) => count >= value).at(-1) || null,
        next_breakpoint: breakpoints.find((value) => count < value) || null,
        breakpoints,
        evidence: evidence.get(code) || [],
        source: "derived_from_mumu_current_view_units_and_trait_items",
        confidence: 0.88,
      };
    })
    .sort((left, right) => (right.active_breakpoint || 0) - (left.active_breakpoint || 0) || right.count - left.count || left.name.localeCompare(right.name, "zh-Hans-CN"));
}

function currentViewTraitItems(state) {
  return (state.items.equipped_items || []).filter((item) => item?.owner_scope === "own_unit");
}

function refreshCurrentViewDerivedTraits(state) {
  const scopedTraitItems = currentViewTraitItems(state);
  state.current_view.derived_traits = deriveTraits(state.current_view.filtered_units, scopedTraitItems);
  state.current_view.derived_trait_policy = {
    primary_source: "mumu_4353_current_view_units",
    item_bonus_source: "scoped_current_view_trait_items_only",
    ocr_trait_text_role: "fallback_or_consistency_check_only",
    caveat: "Visible or S=2 equipment is not counted into traits unless 4356 is assigned to trusted own 4353 units under S=1 + 4354 shop anchor.",
  };
}

function rectCenter(rect) {
  const left = numberOrNull(rect?.left);
  const right = numberOrNull(rect?.right);
  const top = numberOrNull(rect?.top);
  const bottom = numberOrNull(rect?.bottom);
  if ([left, right, top, bottom].some((value) => value == null)) return null;
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

function unitPoint(unit) {
  const x = numberOrNull(unit?.position?.x ?? unit?.x);
  const y = numberOrNull(unit?.position?.y ?? unit?.y);
  if (x == null || y == null) return null;
  return { x, y };
}

function pointDistance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function trustedOwnUnitsForEquipment(state) {
  if (state.phase.mumu_status_code !== 1) return [];
  if (!canPromoteSelfViewBoard(state)) return [];
  return state.board.local_board_units_candidate || [];
}

function unitIdentity(unit) {
  return {
    assigned_unit_key: unitKey(unit),
    assigned_unit_name: unit?.name || unit?.champion_name || null,
    assigned_unit_base_hero_id: unit?.base_hero_id ?? unit?.hero_id ?? unit?.champion_id ?? null,
    assigned_unit_star_level_hint: unit?.star_level_hint ?? null,
    assigned_unit_position: unit?.position || null,
  };
}

function assignVisibleEquipmentToOwnUnits(state, rawItems, catalog, event) {
  const decorated = decorateItems(rawItems, catalog);
  const ownUnits = trustedOwnUnitsForEquipment(state);
  const assigned = [];
  const unassigned = [];

  for (const item of decorated) {
    const center = rectCenter(item.rect);
    let best = null;
    if (center && ownUnits.length > 0) {
      for (const unit of ownUnits) {
        const point = unitPoint(unit);
        if (!point) continue;
        const distance = pointDistance(center, point);
        if (!best || distance < best.distance) best = { unit, distance };
      }
    }
    if (best && best.distance <= OWN_EQUIPMENT_ASSIGN_MAX_DISTANCE_PX) {
      assigned.push({
        ...item,
        ...unitIdentity(best.unit),
        source: "mumu_4356_equipment_to_4353_own_unit",
        area: "own_unit_equipment",
        owner_scope: "own_unit",
        assignment_status: "assigned",
        assignment_distance_px: Number(best.distance.toFixed(1)),
        confidence: Math.min(Number(item.confidence ?? 0.85), 0.86),
        semantic_status: "mumu_structured_own_unit_equipped_item_candidate",
      });
    } else {
      unassigned.push({
        ...item,
        source: "mumu_4356_visible_equipment_unassigned",
        area: "visible_equipment_unassigned",
        owner_scope: "unassigned_visible_equipment",
        assignment_status: "unassigned",
        assignment_block_reason: ownUnits.length > 0
          ? "no_trusted_own_unit_coordinate_match"
          : "missing_s1_shop_anchored_own_4353_units",
        semantic_status: "mumu_structured_visible_equipment_unassigned_candidate",
      });
    }
  }

  if (ownUnits.length > 0) {
    state.items.equipped_items = assigned;
    state.items.equipped_items_source_revision = event.source_revision;
  }
  state.items.visible_equipment_unassigned = unassigned;
  state.items.equipped_item_assignment_policy = {
    primary_source: "mumu_4356_equipment_rectangles",
    own_unit_source: "s1_plus_fresh_4354_shop_anchored_4353_units",
    max_distance_px: OWN_EQUIPMENT_ASSIGN_MAX_DISTANCE_PX,
    s2_policy: "diagnostic_visible_equipment_only_never_own_equipped_items",
  };
}

function pushRecent(state, line) {
  state.recent_interesting_lines.push(line.slice(0, 1000));
  if (state.recent_interesting_lines.length > 80) state.recent_interesting_lines.shift();
}

function eventBase(state, type) {
  const now = new Date().toISOString();
  state.last_observed_at = now;
  return {
    schema: "jcc-mumu-runtime-watch-event-v1",
    type,
    match_session_id: state.match_session_id,
    observed_at: now,
  };
}

function recordSourceObservation(state, event, source) {
  const revision = Number(state.source_revision || 0) + 1;
  const observation = {
    source_revision: revision,
    observed_at: event.observed_at,
    ...source,
  };
  state.source_revision = revision;
  state.latest_source_observation = observation;
  Object.assign(event, observation);
  return revision;
}

function restoreSourceObservationCursor(state, previousState) {
  if (!previousState || previousState.match_session_id !== state.match_session_id) return;
  const previousRevision = Number(previousState.source_revision);
  if (!Number.isSafeInteger(previousRevision) || previousRevision < 0) return;
  state.source_revision = previousRevision;
  if (Number(previousState.latest_source_observation?.source_revision) === previousRevision) {
    state.latest_source_observation = previousState.latest_source_observation;
  }
}

function mumuPhaseName(statusCode) {
  if (statusCode === 4) return "augment_select";
  if (statusCode === 5) return "transition_or_unstable";
  if (statusCode === 1) return "planning_or_actionable";
  if (statusCode === 2) return "observing_other_view_or_non_self_current_view";
  if (statusCode == null) return "unknown";
  return "unknown";
}

function hasSelfViewAnchor(state) {
  return state.pollution_guard.self_view_anchor_shop_4354 === true;
}

function isReplayLikeSourceMode(value) {
  const mode = String(value || "").toLowerCase();
  return mode.includes("replay") || mode.includes("observer") || mode.includes("spectator");
}

function shopAnchorFreshForCurrentView(state) {
  const shopAt = Date.parse(state.shop.last_non_empty_seen_at || state.shop.last_updated_at || state.local.self_view_anchor_established_at || "");
  const viewAt = Date.parse(state.current_view.last_updated_at || "");
  if (!Number.isFinite(shopAt) || !Number.isFinite(viewAt)) return false;
  return viewAt >= shopAt && viewAt - shopAt <= SHOP_SELF_VIEW_ANCHOR_TTL_MS;
}

function establishSelfViewAnchorFromShop(state, observedAt) {
  if (!Array.isArray(state.shop.shop_units) || state.shop.shop_units.length <= 0) return;
  if (state.phase.mumu_status_code !== 1) {
    state.local.local_player_scope_status = "blocked_shop_anchor_requires_s1";
    state.local.evidence.push({
      at: observedAt,
      type: "mumu_4354_shop_self_view_anchor_blocked",
      confidence: 0,
      caveat: "Visible shop only anchors self view when 4358 reports S=1.",
      status_code: state.phase.mumu_status_code,
    });
    if (state.local.evidence.length > 80) state.local.evidence.shift();
    return;
  }
  if (isReplayLikeSourceMode(state.pollution_guard.source_mode)) {
    state.local.local_player_scope_status = "blocked_replay_or_observer_shop_anchor";
    state.local.evidence.push({
      at: observedAt,
      type: "mumu_4354_shop_self_view_anchor_blocked",
      confidence: 0,
      caveat: "Replay/observer-like sources may expose a shop that is not the local actionable player view.",
    });
    if (state.local.evidence.length > 80) state.local.evidence.shift();
    return;
  }
  state.pollution_guard.self_view_anchor_shop_4354 = true;
  state.local.local_player_scope_status = "shop_visible_self_view_anchor";
  state.local.self_view_anchor_established_at ||= observedAt;
  state.local.self_view_anchor_last_seen_at = observedAt;
  state.local.evidence.push({
    at: observedAt,
    type: "mumu_4354_shop_self_view_anchor",
    confidence: 0.95,
    caveat: "The player's shop is visible only on the local actionable view; S codes remain phase/status evidence, not self-board proof.",
  });
  if (state.local.evidence.length > 80) state.local.evidence.shift();
}

function canPromoteSelfViewBoard(state) {
  const benchCount = state.bench.bench_units.length;
  const hasBenchScopeEvidence = benchCount === 0 || state.current_view.bench_overlap_count > 0;
  const anchorAt = Date.parse(state.local.self_view_anchor_established_at || "");
  const currentViewAt = Date.parse(state.current_view.last_updated_at || "");
  const currentViewFreshForAnchor = !Number.isFinite(anchorAt) || (Number.isFinite(currentViewAt) && currentViewAt >= anchorAt);
  const currentShopVisible = Array.isArray(state.shop.shop_units) && state.shop.shop_units.length > 0;
  return state.phase.mumu_status_code === 1
    && hasSelfViewAnchor(state)
    && currentShopVisible
    && shopAnchorFreshForCurrentView(state)
    && currentViewFreshForAnchor
    && hasBenchScopeEvidence
    && state.current_view.filtered_units.length > 0;
}

function holdLocalBoardAsStaleReference(state, observedAt, reason, promotionBlockReason) {
  const currentBoard = state.board.local_board_units_candidate || [];
  if (currentBoard.length > 0) {
    state.board.stale_local_board_units_reference = {
      units: structuredClone(currentBoard),
      last_observed_at: state.current_view.last_updated_at || state.board.last_promoted_at || null,
      held_at: observedAt || null,
      reason,
      promotion_block_reason: promotionBlockReason || null,
    };
  }
  state.board.local_board_units_candidate = [];
  state.board.local_board_derived_traits = [];
}

function refreshLocalBoardPromotion(state, observedAt, reason) {
  const reasonAllowsPromotion = reason === "4353_current_view_update";
  if (reasonAllowsPromotion && canPromoteSelfViewBoard(state)) {
    state.board.local_board_units_candidate = state.current_view.filtered_units.map((unit) => {
      const boardUnit = {
        ...unit,
        area: "board",
        position: {
          ...(unit.position || {}),
          area: "board",
        },
        semantic_status: "mumu_structured_self_view_anchor_candidate",
        confidence: Math.min(Number(unit.confidence ?? 0.9), 0.88),
      };
      return attachMumuBoardGrid(boardUnit);
    });
    state.board.local_board_derived_traits = structuredClone(state.current_view.derived_traits || []);
    state.board.promotion_status = "candidate_promoted_by_shop_self_view_anchor";
    state.board.last_promoted_at = observedAt;
    state.board.last_promotion_evidence = {
      reason,
      phase_status_code: state.phase.mumu_status_code,
      phase_name: mumuPhaseName(state.phase.mumu_status_code),
      raw_current_view_count: state.current_view.raw_units.length,
      bench_count: state.bench.bench_units.length,
      bench_overlap_count: state.current_view.bench_overlap_count,
      filtered_board_count: state.current_view.filtered_units.length,
      shop_anchor_fresh: shopAnchorFreshForCurrentView(state),
      shop_anchor_ttl_ms: SHOP_SELF_VIEW_ANCHOR_TTL_MS,
      current_view_last_updated_at: state.current_view.last_updated_at || null,
      self_view_anchor_established_at: state.local.self_view_anchor_established_at || null,
      self_view_anchor_last_seen_at: state.local.self_view_anchor_last_seen_at || null,
      caveat: "Valid only after 4354 shop data proves the local actionable view and current_view carries bench-overlap evidence; S codes alone never promote current_view into own board.",
    };
    state.board.stale_local_board_units_reference = null;
  } else if (hasSelfViewAnchor(state)) {
    const shopAnchorFresh = shopAnchorFreshForCurrentView(state);
    const promotionBlockReason = !shopAnchorFresh
      ? "shop_self_view_anchor_stale_or_missing_current_shop"
      : state.bench.bench_units.length > 0 && state.current_view.bench_overlap_count <= 0
        ? "current_view_lacks_bench_overlap_scope_evidence"
        : null;
    holdLocalBoardAsStaleReference(state, observedAt, reason, promotionBlockReason);
    state.board.promotion_status = state.phase.mumu_status_code === 5
      ? "held_during_transition_status_5"
      : "waiting_for_stable_self_view_units";
    state.board.last_promotion_evidence = {
      reason,
      shop_anchor_fresh: shopAnchorFresh,
      shop_anchor_ttl_ms: SHOP_SELF_VIEW_ANCHOR_TTL_MS,
      bench_overlap_count: state.current_view.bench_overlap_count,
      promotion_block_reason: promotionBlockReason,
      current_view_last_updated_at: state.current_view.last_updated_at || null,
      self_view_anchor_established_at: state.local.self_view_anchor_established_at || null,
      self_view_anchor_last_seen_at: state.local.self_view_anchor_last_seen_at || null,
    };
  } else {
    holdLocalBoardAsStaleReference(state, observedAt, reason, "self_view_anchor_missing");
    state.board.promotion_status = "blocked_until_4354_shop_self_view_anchor";
  }
}

function mergeGi(state, parsed, catalog) {
  const command = parsed.command;
  state.command_counts[String(command)] = (state.command_counts[String(command)] || 0) + 1;
  const event = eventBase(state, "mumu_gi_message");
  Object.assign(event, {
    source: "adb_logcat_nemuinit_gi_plugin_jkchess",
    command,
    command_hex: `0x${command.toString(16)}`,
    payload: parsed.payload,
    nemuinit_message_id: parsed.nemuinit_message_id,
  });
  const sourceRevision = recordSourceObservation(state, event, {
    source_kind: "mumu_gi_logcat",
    source_name: "gi_plugin_jkchess",
    source_command: command,
    source_command_hex: event.command_hex,
    source_message_id: parsed.nemuinit_message_id,
  });

  if (command === 4096) {
    state.match.status = "in_game";
    state.match.starts.push(event.observed_at);
  } else if (command === 8192) {
    state.match.status = "ended";
    state.match.ends.push(event.observed_at);
  } else if (command === 4352) {
    const nextBenchUnits = Array.isArray(parsed.payload?.wl)
      ? parsed.payload.wl.map((entry) => unitFromGiHero(entry, "bench"))
      : [];
    const phaseAllowsBenchUpdate = state.phase.mumu_status_code == null || state.phase.mumu_status_code === 1;
    if (phaseAllowsBenchUpdate) {
      state.bench.bench_units = decorateUnits(nextBenchUnits, catalog);
      state.bench.source_revision = sourceRevision;
      state.bench.stale_bench_units_reference = null;
      state.bench.field_status = {
        status: "candidate",
        source_revision: sourceRevision,
        observed_at: event.observed_at,
        promotion_policy: "s1_structured_bench_observation",
      };
    } else {
      if (state.bench.bench_units.length > 0) {
        state.bench.stale_bench_units_reference = {
          units: structuredClone(state.bench.bench_units),
          last_observed_at: state.bench.field_status?.observed_at || null,
          held_at: event.observed_at,
          reason: "bench_update_outside_s1",
        };
      }
      state.bench.bench_units = [];
      state.bench.field_status = {
        status: "held_or_waiting",
        source_revision: sourceRevision,
        observed_at: event.observed_at,
        promotion_policy: "s1_structured_bench_observation",
        reason: "bench_update_outside_s1",
      };
    }
    const currentViewScope = splitCurrentViewScope(state.current_view.raw_units, state.bench.bench_units);
    state.current_view.filtered_units = decorateUnits(currentViewScope.filtered_units, catalog);
    state.current_view.bench_overlap_count = currentViewScope.bench_overlap_count;
    state.current_view.source_revision = sourceRevision;
    refreshCurrentViewDerivedTraits(state);
    refreshLocalBoardPromotion(state, event.observed_at, "4352_bench_update");
  } else if (command === 4353) {
    state.current_view.raw_units = decorateUnits(Array.isArray(parsed.payload?.hl)
      ? parsed.payload.hl.map((entry) => unitFromGiHero(entry, "current_view"))
      : [], catalog);
    state.current_view.last_updated_at = event.observed_at;
    state.current_view.source_revision = sourceRevision;
    const currentViewScope = splitCurrentViewScope(state.current_view.raw_units, state.bench.bench_units);
    state.current_view.filtered_units = decorateUnits(currentViewScope.filtered_units, catalog);
    state.current_view.bench_overlap_count = currentViewScope.bench_overlap_count;
    refreshCurrentViewDerivedTraits(state);
    refreshLocalBoardPromotion(state, event.observed_at, "4353_current_view_update");
  } else if (command === 4354) {
    state.shop.shop_units = decorateUnits(Array.isArray(parsed.payload?.bl) ? parsed.payload.bl.map(shopUnitFromGiBuy) : [], catalog);
    state.shop.last_updated_at = event.observed_at;
    state.shop.source_revision = sourceRevision;
    if (state.shop.shop_units.length > 0) state.shop.last_non_empty_seen_at = event.observed_at;
    establishSelfViewAnchorFromShop(state, event.observed_at);
    refreshLocalBoardPromotion(state, event.observed_at, "4354_shop_units_update");
  } else if (command === 4355) {
    state.carousel.active = true;
    state.carousel.source_revision = sourceRevision;
    state.carousel.available_units = decorateUnits(
      Array.isArray(parsed.payload?.hl) ? parsed.payload.hl.map(carouselUnitFromGi) : [],
      catalog,
    );
  } else if (command === 4356) {
    assignVisibleEquipmentToOwnUnits(
      state,
      Array.isArray(parsed.payload?.el)
        ? parsed.payload.el.map((entry, index) => equipFromGi(entry, index, "visible_equipment"))
        : [],
      catalog,
      event,
    );
    state.items.visible_equipment_source_revision = sourceRevision;
    refreshCurrentViewDerivedTraits(state);
  } else if (command === 4357) {
    state.items.item_bench = decorateItems(
      Array.isArray(parsed.payload?.el)
        ? parsed.payload.el.map((entry, index) => equipFromGi(entry, index, "inventory_equipment"))
        : [],
      catalog,
    ).map((item) => ({
      ...item,
      source: "mumu_4357_item_bench",
      area: "inventory_equipment",
      owner_scope: "item_bench",
      semantic_status: "mumu_structured_left_item_rail_candidate",
    }));
    state.items.item_bench_source_revision = sourceRevision;
  } else if (command === 4358) {
    const statusCode = numberOrNull(parsed.payload?.s);
    state.phase.mumu_status_code = statusCode;
    state.phase.source_revision = sourceRevision;
    state.phase.status_history.push({ at: event.observed_at, status_code: statusCode, source_revision: sourceRevision });
    if (state.phase.status_history.length > 80) state.phase.status_history.shift();
    state.augment.status_code_4_active = statusCode === 4;
    if (statusCode === 4) {
      state.augment.status_code_4_seen = true;
      state.augment.last_status_code_4_at = event.observed_at;
    }
    refreshLocalBoardPromotion(state, event.observed_at, "4358_phase_update");
  }
  return event;
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await retryTransientFileOperation(() => rename(temp, file));
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function isTransientWindowsFileLock(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(code)
    || /operation not permitted|resource busy|being used|access is denied|directory not empty/i.test(message);
}

async function retryTransientFileOperation(operation, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 14);
  const baseDelayMs = Math.max(1, Number(options.baseDelayMs) || 35);
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs) || 500);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientWindowsFileLock(error) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)));
    }
  }
  throw lastError;
}

async function appendJsonl(file, events) {
  if (!events.length) return;
  await writeFile(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
    encoding: "utf8",
    flag: "a",
  });
}

function buildCruiseLiveState(state) {
  const observedAt = state.last_observed_at || new Date().toISOString();
  const sourceDiagnostics = refreshItemSourceClassification(state);
  return {
    schema: "jcc-cruise-runtime-live-state-from-mumu-watch-v1",
    match_session_id: state.match_session_id,
    observed_at: observedAt,
    updated_at: observedAt,
    source_revision: state.source_revision || 0,
    command_counts: { ...(state.command_counts || {}) },
    phase: {
      status: state.phase.mumu_status_code,
      status_name: mumuPhaseName(state.phase.mumu_status_code),
      stage_round: state.phase.stage_round || null,
    },
    economy: {
      hp: null,
      gold: null,
      level: null,
      xp: null,
    },
    board: {
      local_board_units_candidate: state.board.local_board_units_candidate || [],
      stale_local_board_units_reference: state.board.stale_local_board_units_reference || null,
      field_status: state.board.last_promotion_evidence
        ? {
          status: state.board.promotion_status === "candidate_promoted_by_shop_self_view_anchor" ? "candidate" : "held_or_waiting",
          promotion_policy: "shop_self_view_anchor_plus_fresh_current_view",
          shop_anchor_fresh: Boolean(state.board.last_promotion_evidence.shop_anchor_fresh),
          bench_overlap_count: state.board.last_promotion_evidence.bench_overlap_count ?? null,
        }
        : null,
    },
    bench: {
      bench_units: state.bench.bench_units || [],
      stale_bench_units_reference: state.bench.stale_bench_units_reference || null,
      field_status: state.bench.field_status || null,
    },
    shop: {
      shop_units: state.shop.shop_units || [],
    },
    items: {
      item_bench: state.items.item_bench || [],
      equipped_items: state.items.equipped_items || [],
    },
    traits: {
      active_traits: state.board.local_board_derived_traits || [],
      active_trait_policy: {
        primary_source: "last_promoted_mumu_4353_self_view_units",
        promotion_policy: "same_atomic_snapshot_as_board.local_board_units_candidate",
        ocr_trait_text_role: "fallback_or_consistency_check_only",
        caveat: "Traits are retained from the last shop-anchored S=1 own-board promotion and are not refreshed from S=2 or unanchored current-view rows.",
      },
    },
    source: {
      kind: "mumu_runtime_watch",
      source_only: true,
      source_revision: state.source_revision || 0,
      latest_source_observation: state.latest_source_observation || null,
      observed_at: observedAt,
      updated_at: observedAt,
      promotion_status: state.board.promotion_status,
      self_view_anchor_manual: state.pollution_guard.self_view_anchor_manual,
      self_view_anchor_shop_4354: state.pollution_guard.self_view_anchor_shop_4354,
      item_source_diagnostics: {
        schema: sourceDiagnostics.schema,
        item_source_classification: sourceDiagnostics.item_source_classification,
        command_presence: sourceDiagnostics.command_presence,
        payload_shape_counts_by_command: sourceDiagnostics.payload_shape_counts_by_command,
        parse_rejection_counts: sourceDiagnostics.parse_rejection_counts,
        unknown_command_counts: sourceDiagnostics.unknown_command_counts,
        equipment_like_unknown_command_counts: sourceDiagnostics.equipment_like_unknown_command_counts,
        capture_health: {
          bytes_read: sourceDiagnostics.capture_health.bytes_read,
          last_line_observed_at: sourceDiagnostics.capture_health.last_line_observed_at,
          last_gi_line_observed_at: sourceDiagnostics.capture_health.last_gi_line_observed_at,
          capture_loss_possible: sourceDiagnostics.capture_health.capture_loss_possible,
          capture_loss_reason: sourceDiagnostics.capture_health.capture_loss_reason,
        },
        retention_policy: "bounded_summary_only_no_raw_log_or_screenshot",
      },
    },
  };
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeCruiseLiveState(state, outDir) {
  const file = path.join(outDir, "cruise-live-state.json");
  await writeJson(file, buildCruiseLiveState(state));
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const outDir = path.resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  const eventsFile = path.join(outDir, "events.jsonl");
  const stateFile = path.join(outDir, "state.json");
  const summaryFile = path.join(outDir, "summary.json");
  const previousState = await readJsonOrNull(stateFile);
  const state = emptyState(options.matchSessionId);
  restoreSourceObservationCursor(state, previousState);
  state.runtime = {
    adb_device_id: options.device || null,
    adb_path: options.adb || null,
    device_selection_policy: options.device
      ? "autodiscovery_wrapper_or_explicit_debug_serial_required"
      : "adb_default_only_for_fixture_or_debug",
    source_mode: options.logcatFixture
      ? "fixture"
      : (options.includeLogcatBacklog ? "debug_backlog" : "live"),
    source_only: true,
  };
  state.pollution_guard.source_mode = state.runtime.source_mode;

  const catalogOverlay = await loadCatalogOverlay(options.catalogOverlay);
  state.catalogs.mumu_catalog_overlay_loaded = Boolean(catalogOverlay);
  state.catalogs.mumu_catalog_overlay_counts = catalogOverlay?.counts || null;
  await writeFile(eventsFile, "", "utf8");
  await writeJson(stateFile, state);

  let buffer = "";
  let pendingEvents = [];
  let stopping = false;
  let flushing = false;
  let flushAgain = false;

  async function flush() {
    if (flushing) {
      flushAgain = true;
      return;
    }
    flushing = true;
    try {
      do {
        flushAgain = false;
        await appendJsonl(eventsFile, pendingEvents);
        pendingEvents = [];
        const sourceDiagnostics = refreshItemSourceClassification(state);
        await writeCruiseLiveState(state, outDir);
        const summary = {
          match_session_id: state.match_session_id,
          last_observed_at: state.last_observed_at,
          source_only: true,
          source_revision: state.source_revision || 0,
          latest_source_observation: state.latest_source_observation || null,
          match_status: state.match.status,
          phase_status_code: state.phase.mumu_status_code,
          phase_name: mumuPhaseName(state.phase.mumu_status_code),
          stage_round: state.phase.stage_round || null,
          command_counts: state.command_counts,
          nemuinit_name_counts: state.nemuinit_name_counts,
          current_view_count: state.current_view.filtered_units.length,
          raw_current_view_count: state.current_view.raw_units.length,
          local_board_candidate_count: state.board.local_board_units_candidate.length,
          local_board_promotion_status: state.board.promotion_status,
          local_board_last_promotion_evidence: state.board.last_promotion_evidence,
          bench_count: state.bench.bench_units.length,
          shop_count: state.shop.shop_units.length,
          carousel_count: state.carousel.available_units.length,
          equipped_item_count: state.items.equipped_items.length,
          item_bench_count: state.items.item_bench.length,
          source_diagnostics: sourceDiagnostics,
          augment_status_code_4_seen: state.augment.status_code_4_seen,
          augment_status_code_4_active: state.augment.status_code_4_active,
          augment_last_status_code_4_at: state.augment.last_status_code_4_at,
        };
        await writeJson(stateFile, state);
        await writeJson(summaryFile, summary);
        process.stdout.write(JSON.stringify(summary) + "\n");
      } while (flushAgain);
    } finally {
      flushing = false;
    }
  }

  function handleLine(line) {
    const nemu = parseNemuinitStart(line);
    recordSourceLineDiagnostics(state, line, nemu);
    if (!nemu || nemu.name !== "gi_plugin_jkchess") return;
    pushRecent(state, line);
    state.nemuinit_name_counts[nemu.name] = (state.nemuinit_name_counts[nemu.name] || 0) + 1;
    pendingEvents.push(mergeGi(state, nemu, catalogOverlay));
  }

  if (options.logcatFixture) {
    const fixture = await readFile(options.logcatFixture, "utf8");
    for (const line of fixture.split(/\r?\n/)) {
      if (line.trim()) handleLine(line);
    }
    await flush();
    return;
  }

  if (options.clearLogcatFirst) {
    await new Promise((resolve) => {
      const clearerArgs = options.device ? ["-s", options.device, "logcat", "-c"] : ["logcat", "-c"];
      const clearer = spawn(options.adb, clearerArgs, {
        cwd: path.resolve("."),
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      clearer.on("error", resolve);
      clearer.on("close", resolve);
    });
    state.pollution_guard.logcat_cleared_before_start = true;
  }

  let logcatSinceTime = null;
  if (!options.includeLogcatBacklog) logcatSinceTime = await getDeviceLogcatSinceTime(options);
  const adbArgs = options.device ? ["-s", options.device, "logcat"] : ["logcat"];
  let logcatBacklogPolicy = "explicit_backlog";
  if (!options.includeLogcatBacklog && logcatSinceTime) {
    adbArgs.push("-T", logcatSinceTime);
    logcatBacklogPolicy = "since_device_time";
  } else if (!options.includeLogcatBacklog) {
    adbArgs.push("-T", "1");
    logcatBacklogPolicy = "bounded_recent_one_line";
  }
  state.pollution_guard.logcat_backlog_included = options.includeLogcatBacklog;
  state.pollution_guard.logcat_backlog_policy = logcatBacklogPolicy;
  state.pollution_guard.logcat_since_time = logcatSinceTime;

  const adb = spawn(options.adb, adbArgs, {
    cwd: path.resolve("."),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  adb.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) handleLine(line);
  });

  adb.stderr.on("data", (chunk) => {
    const message = chunk.toString("utf8").trim();
    if (message) {
      state.source_diagnostics.capture_health.stderr_tail = message.slice(-1200);
      console.error(message);
    }
  });

  const interval = setInterval(() => {
    flush().catch((error) => {
      console.error(error.message || error);
    });
  }, options.summaryIntervalMs);

  function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    if (adb.exitCode == null) adb.kill();
    flush()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(error.message || error);
        process.exit(1);
      });
  }

  if (options.durationMs > 0) setTimeout(stop, options.durationMs);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  adb.on("error", (error) => {
    state.source_diagnostics.capture_health.capture_loss_possible = true;
    state.source_diagnostics.capture_health.capture_loss_reason = "logcat_process_error";
    state.source_diagnostics.capture_health.error_message = String(error?.message || error).slice(0, 1200);
    console.error(error.message || String(error));
    stop();
  });
  adb.on("close", (code, signal) => {
    state.source_diagnostics.capture_health.logcat_process_exit_code = code;
    state.source_diagnostics.capture_health.logcat_process_signal = signal || null;
    if (!stopping && code !== 0) {
      state.source_diagnostics.capture_health.capture_loss_possible = true;
      state.source_diagnostics.capture_health.capture_loss_reason = "logcat_process_exited_unexpectedly";
    }
    stop();
  });
}
main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
