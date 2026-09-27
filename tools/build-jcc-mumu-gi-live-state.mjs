import { readFile, writeFile } from "node:fs/promises";
import { attachMumuBoardGrid, isMumuGiXYOnCalibratedBoard } from "./jcc-mumu-board-grid.mjs";
import { normalizeMumuHeroId } from "./jcc-mumu-hero-id.mjs";

function usage() {
  return [
    "Usage:",
    "  node tools/build-jcc-mumu-gi-live-state.mjs --events <jsonl> [--out <json>]",
    "",
    "Builds a match-scoped live_state candidate from normalized MuMu gi_plugin_jkchess events.",
    "4354 shop_units auto-establishes the self-view anchor for the current match session.",
  ].join("\n");
}

const SHOP_SELF_VIEW_ANCHOR_TTL_MS = 90_000;
const OWN_EQUIPMENT_ASSIGN_MAX_DISTANCE_PX = 95;

function parseArgs(argv) {
  const options = { catalogOverlay: "data/runtime/jcc/mumu-catalog-overlay.json", sourceMode: "event_input" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--events") options.events = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--match-session-id") options.matchSessionId = argv[++index];
    else if (arg === "--source-mode") options.sourceMode = argv[++index];
    else if (arg === "--catalog-overlay") options.catalogOverlay = argv[++index];
    else if (arg === "--no-catalog-overlay") options.catalogOverlay = null;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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
    chosen_rects: Array.isArray(entry?.c)
      ? entry.c.map((rect) => ({
          left: numberOrNull(rect?.l),
          top: numberOrNull(rect?.t),
          right: numberOrNull(rect?.r),
          bottom: numberOrNull(rect?.b),
        }))
      : [],
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

function normalizeRawEvent(event) {
  if (event.schema === "jcc-mumu-gi-runtime-event-v1") return event;
  if (event.type === "opponent_snapshot_requested" || event.action === "analyze_opponent_snapshot") return null;
  if (event.type === "self_view_returned" || event.action === "return_to_self_view") return null;
  if (event.type && event.type !== "mumu_gi_message") return null;
  const cmd = Number(event.cmd ?? event.command);
  const payload = event.payload ?? event.raw_payload ?? {};
  if (!Number.isInteger(cmd)) return null;
  const base = {
    schema: "jcc-mumu-gi-runtime-event-v1",
    source: "mumu_nemuinit_gi_plugin_jkchess",
    command: cmd,
    command_hex: `0x${cmd.toString(16)}`,
    match_session_id: event.match_session_id ?? null,
    source_mode: event.source_mode ?? event.runtime_source_mode ?? event.capture_kind ?? null,
    received_at: event.observed_at ?? new Date().toISOString(),
    raw_payload: payload,
    promotion_policy: "candidate_until_bridge_access_and_local_scope_proven",
  };
  if (cmd === 4096) {
    return {
      ...base,
      type: "match_start",
      match_patch: { status: "in_game", game_start_time: base.received_at },
      promotion_policy: "match_session_boundary",
    };
  }
  if (cmd === 8192) {
    return {
      ...base,
      type: "match_end",
      match_patch: { status: "ended", game_end_time: base.received_at },
      promotion_policy: "match_session_boundary",
    };
  }
  if (cmd === 4352) {
    return {
      ...base,
      type: "bench_units_candidate",
      bench_patch: {
        bench_units: Array.isArray(payload?.wl) ? payload.wl.map((entry) => unitFromGiHero(entry, "bench")) : [],
      },
    };
  }
  if (cmd === 4353) {
    return {
      ...base,
      type: "current_view_units_candidate",
      current_view_patch: {
        current_view_units: Array.isArray(payload?.hl) ? payload.hl.map((entry) => unitFromGiHero(entry, "current_view")) : [],
      },
      promotion_policy: "candidate_until_current_view_and_local_scope_proven",
    };
  }
  if (cmd === 4354) {
    return {
      ...base,
      type: "shop_units_candidate",
      shop_patch: {
        shop_units: Array.isArray(payload?.bl) ? payload.bl.map(shopUnitFromGiBuy) : [],
      },
    };
  }
  if (cmd === 4355) {
    return {
      ...base,
      type: "carousel_units_candidate",
      carousel_patch: {
        active: true,
        available_units: Array.isArray(payload?.hl) ? payload.hl.map(carouselUnitFromGi) : [],
      },
    };
  }
  if (cmd === 4356 || cmd === 4357) {
    const area = cmd === 4356 ? "visible_equipment" : "inventory_equipment";
    return {
      ...base,
      type: cmd === 4356 ? "equipped_items_candidate" : "item_bench_candidate",
      items_patch: {
        [cmd === 4356 ? "equipped_items" : "item_bench"]: Array.isArray(payload?.el)
          ? payload.el.map((entry, index) => equipFromGi(entry, index, area))
          : [],
      },
      promotion_policy: cmd === 4357
        ? "structured_4357_left_item_rail_primary"
        : "assign_only_to_shop_anchored_s1_own_4353_units_by_coordinate",
    };
  }
  if (cmd === 4358) {
    return {
      ...base,
      type: "game_status_candidate",
      phase_patch: {
        mumu_status_code: numberOrNull(payload?.s),
        phase: "unknown",
      },
      promotion_policy: "candidate_until_status_enum_calibrated",
    };
  }
  return {
    ...base,
    type: "unknown_mumu_gi_command",
    promotion_policy: "debug_only_unknown_command",
  };
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

function mumuPhaseName(statusCode) {
  if (statusCode === 4) return "augment_select";
  if (statusCode === 5) return "transition_or_unstable";
  if (statusCode === 1) return "planning_or_actionable";
  if (statusCode === 2) return "observing_other_view_or_non_self_current_view";
  if (statusCode == null) return "unknown";
  return "unknown";
}

function deriveTraits(units, items = []) {
  const counts = new Map();
  const evidence = new Map();
  const add = (trait, detail) => {
    const code = String(trait?.code || "");
    if (!code) return;
    counts.set(code, (counts.get(code) || 0) + 1);
    if (!evidence.has(code)) evidence.set(code, []);
    evidence.get(code).push(detail);
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
  const traitsByCode = new Map();
  for (const unit of units || []) {
    for (const trait of unit.traits || []) traitsByCode.set(String(trait.code), trait);
  }
  for (const item of items || []) {
    for (const trait of item.grants_traits || []) traitsByCode.set(String(trait.code), trait);
  }
  return [...counts.entries()]
    .map(([code, count]) => {
      const trait = traitsByCode.get(code);
      const breakpoints = (trait?.breakpoints || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
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

function syncSelfActiveTraitsFromCurrentView(state, reason = "current_view_refresh") {
  state.traits ||= {};
  if (canPromoteSelfViewBoard(state)) {
    state.traits.active_traits = structuredClone(state.current_view.derived_traits || []);
    state.traits.active_trait_policy = {
      primary_source: "mumu_4353_self_view_units",
      item_bonus_source: "confirmed_or_current_view_scoped_trait_items_only",
      text_role: "trait_text_is_consistency_check_only",
      caveat: "Left trait-panel text is not a primary fact source. Active traits are derived from MuMu unit IDs plus catalog trait codes and explicitly scoped/confirmed trait-granting items.",
    };
    state.field_status["traits.active_traits"] = {
      status: state.traits.active_traits.length > 0 ? "candidate" : "missing",
      source_type: "mumu_catalog_overlay_plus_self_view_units",
      evidence: "current_view.derived_traits_from_4353_shop_anchored_self_view",
      promotion_policy: "shop_self_view_anchor_plus_fresh_current_view",
      phase_status_code: state.phase.mumu_status_code,
      phase_name: mumuPhaseName(state.phase.mumu_status_code),
      reason,
      ocr_trait_text_role: "fallback_or_consistency_check_only",
    };
  } else if (state.traits?.active_traits?.length) {
    state.field_status["traits.active_traits"] = {
      status: "held_or_waiting",
      source_type: "mumu_catalog_overlay_plus_self_view_units",
      evidence: "last_shop_anchored_self_view_derived_traits",
      promotion_policy: "do_not_refresh_active_traits_without_shop_self_view_anchor",
      phase_status_code: state.phase.mumu_status_code,
      phase_name: mumuPhaseName(state.phase.mumu_status_code),
      reason,
      ocr_trait_text_role: "fallback_or_consistency_check_only",
    };
  }
}

function refreshCurrentViewDerivedTraits(state) {
  if (!canPromoteSelfViewBoard(state)) {
    state.current_view.derived_traits = [];
    state.current_view.derived_trait_policy = {
      primary_source: "mumu_4353_current_view_units",
      promotion_status: "diagnostic_only_until_s1_plus_fresh_4354_shop_anchor",
      ocr_trait_text_role: "fallback_or_consistency_check_only",
      caveat: "S=2/non-self current-view 4353 rows must not become opponent traits, own traits, or host-visible strategy facts.",
    };
    delete state.field_status["current_view.derived_traits"];
    syncSelfActiveTraitsFromCurrentView(state, "current_view_not_self_anchored");
    return;
  }
  const scopedTraitItems = currentViewTraitItems(state);
  state.current_view.derived_traits = deriveTraits(state.current_view.filtered_units, scopedTraitItems);
  state.current_view.derived_trait_policy = {
    primary_source: "mumu_4353_current_view_units",
    item_bonus_source: "scoped_current_view_trait_items_only",
    ocr_trait_text_role: "fallback_or_consistency_check_only",
    caveat: "Global equipped item candidates are not counted into current_view traits unless explicitly scoped to current_view. S=2/non-self diagnostics must not become opponent facts.",
  };
  if (state.current_view.derived_traits.length > 0) {
    state.field_status["current_view.derived_traits"] = {
      status: "candidate",
      source_type: "mumu_catalog_overlay_plus_current_view_units",
      evidence: "current_view.filtered_units.trait_codes",
      promotion_policy: "current_view_context_only_until_self_or_opponent_scope_bound",
    };
  }
  syncSelfActiveTraitsFromCurrentView(state, "current_view_derived_traits_refreshed");
}

function hasSelfViewAnchor(state) {
  return state.local.binding_status === "shop_self_view_anchor";
}

function isReplayLikeSourceMode(value) {
  const mode = String(value || "").toLowerCase();
  return mode.includes("replay") || mode.includes("observer") || mode.includes("spectator");
}

function eventSourceMode(state, event) {
  return event.source_mode || state.metadata.source_mode || state.metadata.source_health?.source_mode || null;
}

function shopAnchorFreshForCurrentView(state) {
  const shopAt = Date.parse(state.shop.last_non_empty_seen_at || state.shop.last_updated_at || state.local.self_view_anchor_established_at || "");
  const viewAt = Date.parse(state.current_view.last_updated_at || "");
  if (!Number.isFinite(shopAt) || !Number.isFinite(viewAt)) return false;
  return viewAt >= shopAt && viewAt - shopAt <= SHOP_SELF_VIEW_ANCHOR_TTL_MS;
}

function establishSelfViewAnchorFromShop(state, event) {
  if (!Array.isArray(state.shop.shop_units) || state.shop.shop_units.length <= 0) return;
  if (state.phase.mumu_status_code !== 1) {
    state.source_insights.rejected_events.push({
      at: event.received_at,
      command: event.command,
      reason: "shop_anchor_requires_status_s1",
      status_code: state.phase.mumu_status_code,
    });
    state.field_status["local.self_view_anchor"] = {
      status: "blocked",
      source_type: "mumu_nemuinit_gi_plugin_jkchess",
      command: event.command,
      evidence: "mumu_gi_command:0x1102_shop_units_visible",
      reason: "requires_s1_plus_non_empty_4354_shop",
    };
    return;
  }
  if (isReplayLikeSourceMode(eventSourceMode(state, event))) {
    state.source_insights.rejected_events.push({
      at: event.received_at,
      command: event.command,
      reason: "replay_or_observer_shop_cannot_anchor_self_view",
      source_mode: eventSourceMode(state, event),
    });
    state.field_status["local.self_view_anchor"] = {
      status: "blocked",
      source_type: "mumu_nemuinit_gi_plugin_jkchess",
      command: event.command,
      evidence: "mumu_gi_command:0x1102_shop_units_visible",
      reason: "replay_or_observer_source_mode",
    };
    return;
  }
  state.local.binding_status = "shop_self_view_anchor";
  state.local.binding_source = "mumu_4354_visible_shop_self_view";
  state.local.binding_confidence = 0.95;
  state.local.self_view_anchor_established_at ||= event.received_at;
  state.local.self_view_promotion_suspended = false;
  state.local.self_view_promotion_suspended_reason = null;
  state.local.evidence.push({
    at: event.received_at,
    type: "mumu_4354_shop_self_view_anchor",
    command: event.command,
    confidence: 0.95,
    caveat: "The player's shop is visible only on the local actionable view; S codes remain phase/status evidence, not self-board proof.",
  });
  if (state.local.evidence.length > 40) state.local.evidence.shift();
  state.field_status["local.self_view_anchor"] = {
    status: "candidate",
    source_type: "mumu_nemuinit_gi_plugin_jkchess",
    command: event.command,
    evidence: "mumu_gi_command:0x1102_shop_units_visible",
    promotion_policy: "auto_self_view_anchor_from_4354_visible_shop",
  };
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
    && state.local.self_view_promotion_suspended !== true
    && currentShopVisible
    && shopAnchorFreshForCurrentView(state)
    && currentViewFreshForAnchor
    && hasBenchScopeEvidence
    && state.current_view.filtered_units.length > 0;
}

function holdLocalBoardAsStaleReference(state, event, reason, promotionBlockReason) {
  const currentBoard = state.board.local_board_units_candidate || [];
  const currentTraits = state.traits?.active_traits || state.current_view?.derived_traits || [];
  if (currentBoard.length > 0) {
    state.board.stale_local_board_units_reference = {
      units: structuredClone(currentBoard),
      last_observed_at: state.field_status["board.local_board_units_candidate"]?.current_view_last_updated_at
        || state.current_view.last_updated_at
        || null,
      held_at: event.received_at || null,
      reason,
      promotion_block_reason: promotionBlockReason,
    };
  }
  if (currentTraits.length > 0) {
    state.traits.stale_active_traits_reference = {
      traits: structuredClone(currentTraits),
      last_observed_at: state.field_status["traits.active_traits"]?.observed_at
        || state.current_view.last_updated_at
        || null,
      held_at: event.received_at || null,
      reason,
      promotion_block_reason: promotionBlockReason,
    };
  }
  state.board.local_board_units_candidate = [];
  state.current_view.derived_traits = [];
  state.traits.active_traits = [];
  delete state.field_status["current_view.derived_traits"];
  state.field_status["traits.active_traits"] = {
    status: state.traits.stale_active_traits_reference ? "stale_reference" : "not_observed",
    source_type: "mumu_catalog_overlay_plus_self_view_units",
    evidence: state.traits.stale_active_traits_reference
      ? "last_shop_anchored_self_view_derived_traits"
      : "no_shop_anchored_self_view_derived_traits",
    promotion_policy: "conditional_only_until_shop_self_view_anchor_refresh",
    phase_status_code: state.phase.mumu_status_code,
    phase_name: mumuPhaseName(state.phase.mumu_status_code),
    reason,
    promotion_block_reason: promotionBlockReason,
    usable_for: state.traits.stale_active_traits_reference ? "conditional_only" : null,
    ocr_trait_text_role: "fallback_or_consistency_check_only",
  };
}

function refreshLocalBoardPromotion(state, event, reason) {
  const reasonAllowsPromotion = reason === "current_view_units_candidate";
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
    state.board.last_self_view_board_units_candidate = structuredClone(state.board.local_board_units_candidate);
    syncSelfActiveTraitsFromCurrentView(state, reason);
    state.field_status["board.local_board_units_candidate"] = {
      status: "candidate",
      source_type: "mumu_nemuinit_gi_plugin_jkchess",
      command: event.command,
      evidence: `mumu_gi_command:${event.command_hex}`,
      promotion_policy: "shop_self_view_anchor_plus_fresh_current_view",
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
      caveat: "Valid only after 4354 shop data proves the local actionable view and current_view carries bench-overlap evidence; S codes alone never promote current_view into own board.",
    };
    state.source_insights.promotion_decision = "shop_self_view_anchor_candidate";
    state.board.stale_local_board_units_reference = null;
    state.traits.stale_active_traits_reference = null;
  } else if (hasSelfViewAnchor(state)) {
    const promotionBlockReason = shopAnchorFreshForCurrentView(state)
      ? null
      : "shop_self_view_anchor_stale_or_missing_current_shop";
    holdLocalBoardAsStaleReference(state, event, reason, promotionBlockReason);
    state.field_status["board.local_board_units_candidate"] = {
      status: "held_or_waiting",
      source_type: "mumu_nemuinit_gi_plugin_jkchess",
      command: event.command,
      evidence: `mumu_gi_command:${event.command_hex}`,
      promotion_policy: "shop_self_view_anchor_plus_fresh_current_view",
      phase_status_code: state.phase.mumu_status_code,
      phase_name: mumuPhaseName(state.phase.mumu_status_code),
      reason,
      suspended: state.local.self_view_promotion_suspended === true,
      bench_overlap_count: state.current_view.bench_overlap_count,
      shop_anchor_fresh: shopAnchorFreshForCurrentView(state),
      shop_anchor_ttl_ms: SHOP_SELF_VIEW_ANCHOR_TTL_MS,
      promotion_block_reason: promotionBlockReason,
      current_view_last_updated_at: state.current_view.last_updated_at || null,
      self_view_anchor_established_at: state.local.self_view_anchor_established_at || null,
      caveat: "No new local-board promotion until S=1, visible shop anchoring, fresh current_view, and bench-overlap evidence agree.",
    };
  } else {
    state.board.local_board_units_candidate = [];
  }
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

  if (ownUnits.length > 0) state.items.equipped_items = assigned;
  state.items.visible_equipment_unassigned = unassigned;
  state.items.equipped_item_assignment_policy = {
    primary_source: "mumu_4356_equipment_rectangles",
    own_unit_source: "s1_plus_fresh_4354_shop_anchored_4353_units",
    max_distance_px: OWN_EQUIPMENT_ASSIGN_MAX_DISTANCE_PX,
    s2_policy: "diagnostic_visible_equipment_only_never_own_equipped_items",
  };
  state.field_status["items.visible_equipment_unassigned"] = {
    status: unassigned.length > 0 ? "candidate" : "empty",
    source_type: "mumu_nemuinit_gi_plugin_jkchess",
    command: event.command,
    evidence: `mumu_gi_command:${event.command_hex}`,
    source: "mumu_4356_visible_equipment_unassigned",
    promotion_policy: "diagnostic_only_never_own_equipped_items_without_coordinate_assignment",
  };
  if (ownUnits.length > 0) {
    state.field_status["items.equipped_items"] = {
      status: assigned.length > 0 ? "candidate" : "observed_empty",
      source_type: "mumu_nemuinit_gi_plugin_jkchess",
      command: event.command,
      evidence: `mumu_gi_command:${event.command_hex}`,
      source: "mumu_4356_equipment_to_4353_own_unit",
      promotion_policy: "s1_4354_shop_anchor_plus_4356_rect_to_4353_unit_coordinate_assignment",
      assigned_count: assigned.length,
      unassigned_count: unassigned.length,
    };
  } else {
    state.field_status["items.equipped_items"] = {
      status: "held_or_waiting",
      source_type: "mumu_nemuinit_gi_plugin_jkchess",
      command: event.command,
      evidence: `mumu_gi_command:${event.command_hex}`,
      source: "mumu_4356_equipment_to_4353_own_unit",
      promotion_policy: "requires_s1_plus_non_empty_4354_shop_anchor_plus_fresh_4353_own_units",
      reason: "visible_equipment_not_assigned_to_trusted_own_units",
    };
  }
}

function mergeEvent(state, event, catalog) {
  if (event.match_session_id && state.metadata.match_session_id && event.match_session_id !== state.metadata.match_session_id) {
    state.source_insights.rejected_events.push({
      at: event.received_at,
      command: event.command,
      event_type: event.type,
      reason: "cross_match_event_rejected",
      expected_match_session_id: state.metadata.match_session_id,
      actual_match_session_id: event.match_session_id,
    });
    return;
  }
  state.source_insights.mumu_gi_event_count += 1;
  state.source_insights.latest_command = event.command;
  state.source_insights.latest_event_type = event.type;
  state.metadata.freshness.last_mumu_gi_event_at = event.received_at;

  if (event.match_session_id) state.metadata.match_session_id = event.match_session_id;
  if (event.type === "match_start") {
    state.match.status = "in_game";
    state.match.game_start_time = event.match_patch?.game_start_time || event.received_at;
    state.match.match_id = event.match_session_id || state.match.match_id;
    state.pollution_guard.current_match_started = true;
    state.source_insights.match_boundaries.push({ type: "start", at: event.received_at, command: event.command });
    return;
  }
  if (event.type === "match_end") {
    state.match.status = "ended";
    state.match.game_end_time = event.match_patch?.game_end_time || event.received_at;
    state.source_insights.match_boundaries.push({ type: "end", at: event.received_at, command: event.command });
    return;
  }
  if (event.type === "bench_units_candidate") {
    const nextBenchUnits = event.bench_patch?.bench_units || [];
    const phaseAllowsBenchUpdate = state.phase.mumu_status_code == null || state.phase.mumu_status_code === 1;
    if (phaseAllowsBenchUpdate) {
      state.bench.bench_units = decorateUnits(nextBenchUnits, catalog);
      state.bench.stale_bench_units_reference = null;
      state.field_status["bench.bench_units"] = candidateStatus(event);
    } else {
      if (state.bench.bench_units.length > 0) {
        state.bench.stale_bench_units_reference = {
          units: structuredClone(state.bench.bench_units),
          last_observed_at: state.field_status["bench.bench_units"]?.received_at || null,
          held_at: event.received_at || null,
          reason: "bench_update_outside_s1",
        };
      }
      state.bench.bench_units = [];
      state.field_status["bench.bench_units"] = {
        ...candidateStatus(event),
        status: "held_or_waiting",
        reason: "bench_update_outside_s1",
      };
    }
    const currentViewScope = splitCurrentViewScope(state.current_view.raw_units || state.current_view.filtered_units || [], state.bench.bench_units);
    state.current_view.filtered_units = decorateUnits(currentViewScope.filtered_units, catalog);
    state.current_view.bench_overlap_count = currentViewScope.bench_overlap_count;
    refreshCurrentViewDerivedTraits(state);
    refreshLocalBoardPromotion(state, event, "bench_units_candidate");
    return;
  }
  if (event.type === "current_view_units_candidate" || event.type === "board_units_candidate") {
    state.current_view.raw_units = decorateUnits(event.current_view_patch?.current_view_units || event.board_patch?.board_units || [], catalog);
    state.current_view.last_updated_at = event.received_at;
    const currentViewScope = splitCurrentViewScope(state.current_view.raw_units, state.bench.bench_units);
    const canExposeCurrentViewRows = state.phase.mumu_status_code === 1 && hasSelfViewAnchor(state);
    state.current_view.filtered_units = canExposeCurrentViewRows
      ? decorateUnits(currentViewScope.filtered_units, catalog)
      : [];
    state.current_view.diagnostic_units = canExposeCurrentViewRows
      ? []
      : decorateUnits(currentViewScope.filtered_units, catalog);
    state.current_view.bench_overlap_count = canExposeCurrentViewRows ? currentViewScope.bench_overlap_count : 0;
    state.current_view.diagnostic_policy = canExposeCurrentViewRows
      ? "self_view_anchor_allows_current_view_processing"
      : "diagnostic_only_not_own_or_opponent_board; requires S=1 plus fresh non-empty 4354 shop anchor";
    refreshCurrentViewDerivedTraits(state);
    refreshLocalBoardPromotion(state, event, "current_view_units_candidate");
    state.field_status["current_view.filtered_units"] = candidateStatus(event);
    if (!hasSelfViewAnchor(state)) {
      state.field_status["board.local_board_units_candidate"] = {
        status: "blocked",
        source_type: "mumu_nemuinit_gi_plugin_jkchess",
        command: event.command,
        evidence: `mumu_gi_command:${event.command_hex}`,
        promotion_policy: "requires_4354_visible_shop_self_view_anchor",
        caveat: "4353 is current-view candidate; promote to own board only after the current match observes visible 4354 shop data.",
      };
    }
    return;
  }
  if (event.type === "shop_units_candidate") {
    state.shop.shop_units = decorateUnits(event.shop_patch?.shop_units || [], catalog);
    state.shop.last_updated_at = event.received_at;
    if (state.shop.shop_units.length > 0) state.shop.last_non_empty_seen_at = event.received_at;
    state.field_status["shop.shop_units"] = candidateStatus(event);
    establishSelfViewAnchorFromShop(state, event);
    refreshLocalBoardPromotion(state, event, "shop_units_candidate");
    return;
  }
  if (event.type === "carousel_units_candidate") {
    state.carousel.active = event.carousel_patch?.active ?? true;
    state.carousel.available_units = decorateUnits(event.carousel_patch?.available_units || [], catalog);
    state.field_status["carousel.available_units"] = candidateStatus(event);
    return;
  }
  if (event.type === "item_bench_candidate") {
    state.items.item_bench = decorateItems(event.items_patch?.item_bench || [], catalog).map((item) => ({
      ...item,
      source: "mumu_4357_item_bench",
      area: "inventory_equipment",
      owner_scope: "item_bench",
      semantic_status: "mumu_structured_left_item_rail_candidate",
    }));
    state.field_status["items.item_bench"] = {
      ...candidateStatus(event),
      source: "mumu_4357_item_bench",
      promotion_policy: "structured_4357_left_item_rail_primary",
    };
    return;
  }
  if (event.type === "equipped_items_candidate") {
    assignVisibleEquipmentToOwnUnits(state, event.items_patch?.equipped_items || [], catalog, event);
    refreshCurrentViewDerivedTraits(state);
    return;
  }
  if (event.type === "game_status_candidate") {
    state.phase.mumu_status_code = event.phase_patch?.mumu_status_code ?? null;
    state.phase.phase = mumuPhaseName(state.phase.mumu_status_code);
    state.field_status["phase.phase"] = candidateStatus(event);
    refreshLocalBoardPromotion(state, event, "game_status_candidate");
    return;
  }
}

function unitKey(unit) {
  const id = unit?.base_hero_id ?? unit?.hero_id ?? unit?.champion_id;
  return `${id}:${unit?.x}:${unit?.y}`;
}

function filterBenchUnits(rawUnits, benchUnits) {
  return splitCurrentViewScope(rawUnits, benchUnits).filtered_units;
}

function splitCurrentViewScope(rawUnits, benchUnits) {
  const benchKeys = new Set((benchUnits || []).map(unitKey));
  let benchOverlapCount = 0;
  const filteredUnits = (rawUnits || [])
    .filter((unit) => !benchKeys.has(unitKey(unit)))
    .filter((unit) => isMumuGiXYOnCalibratedBoard(unit))
    .map((unit) => ({
      ...unit,
      area: "current_view",
      position: {
        ...(unit.position || {}),
        area: "current_view",
      },
    }));
  for (const unit of rawUnits || []) {
    if (benchKeys.has(unitKey(unit))) benchOverlapCount += 1;
  }
  return { filtered_units: filteredUnits, bench_overlap_count: benchOverlapCount };
}

function candidateStatus(event) {
  return {
    status: "candidate",
    source_type: "mumu_nemuinit_gi_plugin_jkchess",
    command: event.command,
    evidence: `mumu_gi_command:${event.command_hex}`,
    promotion_policy: event.promotion_policy,
    received_at: event.received_at || null,
    caveat: "Requires proven bridge access plus local-player/current-view semantics before final strategy promotion.",
  };
}

function emptyState() {
  return {
    schema: "jcc-mumu-gi-live-state-v1",
    match: {
      match_id: null,
      game_start_time: null,
      game_end_time: null,
      status: "unknown",
    },
    local: {
      local_chair_id: null,
      binding_status: "unbound",
      binding_source: null,
      binding_confidence: 0,
      self_view_anchor_established_at: null,
      evidence: [],
      self_view_promotion_suspended: false,
      self_view_promotion_suspended_reason: null,
    },
    phase: {
      phase: "unknown",
      mumu_status_code: null,
    },
    current_view: {
      raw_units: [],
      filtered_units: [],
      bench_overlap_count: 0,
      last_updated_at: null,
      derived_traits: [],
      derived_trait_policy: null,
    },
    board: {
      local_board_units_candidate: [],
      last_self_view_board_units_candidate: [],
      stale_local_board_units_reference: null,
    },
    bench: { bench_units: [], stale_bench_units_reference: null },
    shop: { shop_units: [], last_updated_at: null, last_non_empty_seen_at: null },
    carousel: { active: "unknown", available_units: [] },
    items: { item_bench: [], equipped_items: [], visible_equipment_unassigned: [] },
    traits: { active_traits: [], active_trait_policy: null, stale_active_traits_reference: null },
    field_status: {},
    source_insights: {
      mumu_gi_event_count: 0,
      latest_command: null,
      latest_event_type: null,
      match_boundaries: [],
      promotion_decision: "candidate_only_until_live_bridge_and_local_scope_are_proven",
      rejected_events: [],
    },
    metadata: {
      source_health: {
        product_boundary: "mumu_host_nemuinit_bridge",
        bridge_access: "event_input_file",
        source_mode: "event_input",
      },
      catalog_overlay: null,
      source_mode: "event_input",
      match_session_id: null,
      freshness: {},
    },
    pollution_guard: {
      current_match_started: false,
      cross_match_fusion_allowed: false,
      raw_history_promotion_allowed: false,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  assert(options.events, "Missing --events");
  const rawEvents = parseLines(await readFile(options.events, "utf8"));
  const catalog = await loadCatalogOverlay(options.catalogOverlay);
  const state = emptyState();
  state.metadata.source_mode = options.sourceMode || "event_input";
  state.metadata.source_health.source_mode = state.metadata.source_mode;
  state.metadata.match_session_id = options.matchSessionId || null;
  if (catalog) {
    state.metadata.catalog_overlay = {
      schema: catalog.schema,
      active_mode: catalog.active_mode,
      season: catalog.season,
      source_policy: catalog.source?.policy,
      counts: catalog.counts,
    };
  }
  for (const raw of rawEvents) {
    const event = await normalizeRawEvent(raw);
    if (event) mergeEvent(state, event, catalog);
  }
  const json = `${JSON.stringify(state, null, 2)}\n`;
  if (options.out) await writeFile(options.out, json, "utf8");
  else process.stdout.write(json);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
