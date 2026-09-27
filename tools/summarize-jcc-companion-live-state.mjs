#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CATALOG_PATH = "android-companion/app/src/main/assets/jcc_catalog.json";

function parseArgs(argv) {
  const args = {
    input: ".omx/logs/jcc-companion-accepted.jsonl",
    last: 2000,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") args.input = argv[++i];
    else if (arg === "--last") args.last = Number(argv[++i]);
    else if (arg === "--help") {
      console.log("Usage: node tools/summarize-jcc-companion-live-state.mjs [--input <jsonl>] [--last <n>]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeForMatch(value) {
  return normalizeText(value).replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

function extractRound(text) {
  const match = normalizeText(text).match(/(?:当前回合|鎬粅鍥炲悎)?\s*([1-9])\s*[-鈥擼–—]\s*([1-9])/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function extractLevel(text) {
  const match = normalizeText(text).match(/([1-9])\s*(?:级|绾)/);
  return match ? Number(match[1]) : null;
}

function extractXp(text) {
  const match = normalizeText(text).match(/\b(\d{1,3})\s*\/\s*(\d{1,3})\b/);
  if (!match) return null;
  return {
    current: Number(match[1]),
    required: Number(match[2]),
  };
}

function extractNumbers(text) {
  return [...normalizeText(text).matchAll(/\d+/g)].map((match) => Number(match[0]));
}

function rowOrder(row) {
  return [
    Number(row?.monotonic_ms ?? row?.observed_at_epoch_ms ?? 0),
    Number(row?.frame_seq ?? 0),
  ];
}

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const [aTime, aSeq] = rowOrder(a);
    const [bTime, bSeq] = rowOrder(b);
    return aTime - bTime || aSeq - bSeq;
  });
}

function extractGold(text) {
  const normalized = normalizeText(text);
  if (/\d+\s*\/\s*\d+/.test(normalized) || /%/.test(normalized) || /(?:级|绾)/.test(normalized)) return null;
  const marked = normalized.match(/[●金币]\s*(\d{1,3})/);
  if (marked) {
    const value = Number(marked[1]);
    if (value >= 0 && value <= 200) return value;
  }
  const exact = normalized.match(/^\D*(\d{1,3})\D*$/);
  const value = exact ? Number(exact[1]) : null;
  if (value == null || value < 0 || value > 200) return null;
  return value;
}

function extractGoldFromShopBand(block) {
  const lines = block?.native_lines || [];
  const joined = normalizeText(`${block?.text || ""} ${block?.native_text || ""}`);
  const afterXp = joined.match(/\d{1,3}\s*\/\s*\d{1,3}\D+(\d{1,3})\b/);
  if (afterXp) {
    const value = Number(afterXp[1]);
    if (value >= 0 && value <= 200) return value;
  }
  let seenXp = false;
  for (const line of lines) {
    const normalized = normalizeText(line);
    if (/\d{1,3}\s*\/\s*\d{1,3}/.test(normalized)) {
      seenXp = true;
      continue;
    }
    if (!seenXp) continue;
    const value = extractGold(normalized);
    if (value != null) return value;
  }
  return null;
}

function extractGoldFromSheet(block) {
  const lines = Array.isArray(block?.lines) ? block.lines : [];
  for (const line of lines) {
    const normalized = normalizeText(line);
    if (/^\d{1,3}$/.test(normalized)) {
      const value = Number(normalized);
      if (value >= 0 && value <= 200) return value;
    }
  }
  return null;
}

function collectNativeTexts(block) {
  const nativeBlocks = Array.isArray(block?.native_blocks?.blocks) ? block.native_blocks.blocks : [];
  return nativeBlocks.map((item) => normalizeText(item.text)).filter(Boolean);
}

async function loadCatalog() {
  try {
    const catalog = JSON.parse(await readFile(resolve(CATALOG_PATH), "utf8"));
    return {
      augments: Array.isArray(catalog.augments) ? catalog.augments : [],
    };
  } catch {
    return { augments: [] };
  }
}

function matchAugments(text, augments) {
  const normalizedText = normalizeForMatch(text);
  if (!normalizedText) return [];
  const matches = [];
  for (const augment of augments) {
    const name = normalizeForMatch(augment.name);
    if (!name || name.length < 2) continue;
    if (normalizedText.includes(name)) {
      matches.push({
        augment_id: augment.id,
        augment_name: augment.name,
        season: augment.season ?? null,
        tags: augment.tags ?? [],
        rounds: augment.rounds ?? [],
        match: "exact_substring",
        confidence: 0.86,
      });
    }
  }
  return matches.slice(0, 6);
}

function summarizeRoi(row) {
  const occupancy = row?.observations?.slot_occupancy || [];
  const identity = row?.observations?.identity_candidates || [];
  const groups = {};
  for (const item of occupancy) {
    const group = item.group;
    groups[group] ??= { total: 0, occupied: 0, empty: 0, avg_confidence: 0 };
    groups[group].total += 1;
    groups[group].occupied += item.occupied_candidate ? 1 : 0;
    groups[group].empty += item.occupied_candidate ? 0 : 1;
    groups[group].avg_confidence += Number(item.confidence || 0);
  }
  for (const group of Object.keys(groups)) {
    groups[group].avg_confidence = Number((groups[group].avg_confidence / groups[group].total).toFixed(3));
  }

  const strongIdentity = identity
    .filter((item) => item.identity_status === "candidate")
    .map((item) => ({
      group: item.roi_group,
      slot: item.slot,
      hero_id: item.hero_id,
      hero_name: item.hero_name,
      confidence: item.confidence,
      hash_distance: item.hash_distance,
      combined_score: item.combined_score ?? null,
      score_margin: item.score_margin ?? null,
      matcher_version: item.matcher_version ?? null,
      top_candidates: Array.isArray(item.top_candidates) ? item.top_candidates.slice(0, 3) : [],
    }));

  return {
    frame_seq: row?.frame_seq ?? null,
    screen_state_candidate: row?.observations?.screen_state_candidate ?? null,
    occupancy_groups: groups,
    identity_candidates: strongIdentity,
    low_confidence_identity_count: identity.filter((item) => item.identity_status === "low_confidence").length,
    scoreboard_candidates: summarizeScoreboardCandidates(row?.observations?.scoreboard_candidates || []),
  };
}

function summarizeScoreboardCandidates(rows) {
  const candidates = rows
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      slot: row.slot,
      local_player_candidate: row.local_player_candidate === true,
      confidence: Number(row.confidence || 0),
      avatar_size_score: Number(row.avatar_size_score || 0),
      binding_status: row.binding_status || "scoreboard_row_candidate",
      hp_roi: row.hp_roi || null,
    }))
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
  return {
    local_player_row_candidate: candidates.find((row) => row.local_player_candidate) || null,
    row_candidates: candidates.slice(0, 4),
    binding_basis: "largest_or_highlighted_scoreboard_avatar_candidate",
  };
}

function summarizeTemporalRoi(sessionRows, windowSize = 120) {
  const rows = sortRows(sessionRows.filter((row) => row.type === "roi_observations")).slice(-windowSize);
  const bySlot = {};
  for (const row of rows) {
    for (const item of row?.observations?.slot_occupancy || []) {
      const key = `${item.group}:${item.slot}`;
      bySlot[key] ??= {
        group: item.group,
        slot: item.slot,
        samples: 0,
        occupied: 0,
        confidence: 0,
        variance: 0,
        saturation: 0,
      };
      bySlot[key].samples += 1;
      bySlot[key].occupied += item.occupied_candidate ? 1 : 0;
      bySlot[key].confidence += Number(item.confidence || 0);
      bySlot[key].variance += Number(item.variance || 0);
      bySlot[key].saturation += Number(item.saturation || 0);
    }
  }
  const slots = Object.values(bySlot).map((slot) => {
    const occupiedRate = slot.samples ? slot.occupied / slot.samples : 0;
    const avgConfidence = slot.samples ? slot.confidence / slot.samples : 0;
    const avgVariance = slot.samples ? slot.variance / slot.samples : 0;
    const avgSaturation = slot.samples ? slot.saturation / slot.samples : 0;
    return {
      group: slot.group,
      slot: slot.slot,
      samples: slot.samples,
      occupied_rate: Number(occupiedRate.toFixed(3)),
      avg_confidence: Number(avgConfidence.toFixed(3)),
      avg_variance: Number(avgVariance.toFixed(1)),
      avg_saturation: Number(avgSaturation.toFixed(3)),
      stable_occupied: isStableOccupied(slot.group, occupiedRate, avgConfidence),
      unstable_candidate: occupiedRate >= 0.35 && !isStableOccupied(slot.group, occupiedRate, avgConfidence),
    };
  }).sort((a, b) => a.group.localeCompare(b.group) || a.slot - b.slot);

  const groups = {};
  for (const slot of slots) {
    groups[slot.group] ??= {
      total_slots: 0,
      stable_occupied_slots: 0,
      unstable_candidate_slots: 0,
      samples_per_slot: slot.samples,
      stable_slots: [],
      unstable_slots: [],
    };
    groups[slot.group].total_slots += 1;
    if (slot.stable_occupied) {
      groups[slot.group].stable_occupied_slots += 1;
      groups[slot.group].stable_slots.push(slot.slot);
    } else if (slot.unstable_candidate) {
      groups[slot.group].unstable_candidate_slots += 1;
      groups[slot.group].unstable_slots.push(slot.slot);
    }
  }
  return {
    window_size: windowSize,
    roi_observation_rows: rows.length,
    groups,
    slots,
  };
}

function isStableOccupied(group, occupiedRate, avgConfidence) {
  if (group === "bench_slots") return occupiedRate >= 0.85 && avgConfidence >= 0.38;
  if (group === "shop_slots") return occupiedRate >= 0.85 && avgConfidence >= 0.50;
  if (group === "board_slots") return occupiedRate >= 0.80 && avgConfidence >= 0.55;
  return occupiedRate >= 0.80 && avgConfidence >= 0.55;
}

function inferPhaseContext(roiSummary, ocrSummary, temporalRoi = null) {
  const text = (ocrSummary?.text_blocks || []).map((block) => block.text).join(" ");
  const hasShopText = /购买经验|刷新|概率|商店|级|璐拱缁忛獙|鍒锋柊|绾|%|\b\d{1,3}\s*\/\s*\d{1,3}\b|\d{1,2}\s*%/.test(text);
  const hasCombatText = /造成伤害|伤害|对战|胜利|失败|閫犳垚浼ゅ|浼ゅ|瀵规垬|鑳滃埄|澶辫触/.test(text);
  const shopOccupied = roiSummary?.occupancy_groups?.shop_slots?.occupied ?? 0;
  const boardOccupied = roiSummary?.occupancy_groups?.board_slots?.occupied ?? 0;
  const benchOccupied = roiSummary?.occupancy_groups?.bench_slots?.occupied ?? 0;
  const stableShopOccupied = temporalRoi?.groups?.shop_slots?.stable_occupied_slots ?? 0;
  let phase = "unknown";
  let confidence = 0.25;
  const reasons = [];
  if (hasCombatText && !(hasShopText && stableShopOccupied >= 4 && (boardOccupied >= 1 || benchOccupied >= 1))) {
    return {
      phase: "combat_or_summary_candidate",
      confidence: 0.72,
      reasons: ["combat/summary OCR text present"],
      valid_for_board_bench_promotion: false,
    };
  }
  if (hasShopText) {
    phase = "prepare_or_shop_candidate";
    confidence += 0.35;
    reasons.push("shop/economy OCR text present");
  }
  if (stableShopOccupied >= 4) {
    confidence += 0.20;
    reasons.push("stable shop slots occupied over temporal window");
    if (phase === "unknown" && !hasCombatText) {
      phase = "prepare_or_shop_candidate";
    }
  }
  if (shopOccupied >= 4) {
    confidence += 0.15;
    reasons.push("shop-like slots occupied");
  }
  if (boardOccupied >= 1 || benchOccupied >= 1) {
    confidence += 0.10;
    reasons.push("board/bench ROI occupancy present");
  }
  if (shopOccupied >= 4 && boardOccupied === 0 && !hasShopText) {
    phase = "phase_uncertain";
    confidence = 0.45;
    reasons.push("shop ROI occupied but no shop OCR text and no board occupancy");
  }
  if (hasCombatText && hasShopText && stableShopOccupied >= 4 && (boardOccupied >= 1 || benchOccupied >= 1)) {
    phase = "prepare_or_shop_candidate";
    confidence = Math.max(confidence, 0.82);
    reasons.push("stable shop/economy evidence overrides transient combat banner");
  }
  return {
    phase,
    confidence: Number(Math.min(0.95, confidence).toFixed(2)),
    reasons,
    valid_for_board_bench_promotion: phase === "prepare_or_shop_candidate" && confidence >= 0.70,
  };
}

function summarizeOcr(row, catalog) {
  const blocks = row?.blocks?.blocks || [];
  const nonEmpty = blocks
    .filter((block) => normalizeText(block.text) || collectNativeTexts(block).length > 0)
    .map((block) => ({
      roi: `${block.roi?.group}:${block.roi?.name}${block.roi?.slot != null ? `:${block.roi.slot}` : ""}`,
      text: normalizeText(block.text),
      native_text: collectNativeTexts(block).join(" "),
      native_line_count: collectNativeTexts(block).length,
      line_count: block.line_count ?? 0,
      lines: Array.isArray(block.lines) ? block.lines.map(normalizeText).filter(Boolean) : [],
      native_lines: collectNativeTexts(block),
    }));
  const joined = nonEmpty.map((block) => [block.text, block.native_text].filter(Boolean).join(" ")).join(" ");
  const round = extractRound(joined);
  const level = extractLevel(joined);
  const xp = extractXp(joined);
  const hpBlocks = nonEmpty.filter((block) => block.roi === "economy:hp_local_scoreboard_detected_row");
  const augmentBlocks = nonEmpty.filter((block) => block.roi === "phase:augment_choice_panel" || block.roi === "phase:augment_trigger_text");
  const goldBlock = nonEmpty.find((block) => block.roi === "economy:gold");
  const shopBandBlock = nonEmpty.find((block) => block.roi === "phase:shop_band");
  const criticalSheet = nonEmpty.find((block) => block.roi === "fast_ocr:critical_sheet");
  const goldFromRoi = goldBlock ? extractGold(`${goldBlock.text} ${goldBlock.native_text}`) : null;
  const goldFromShopBand = goldFromRoi == null && shopBandBlock ? extractGoldFromShopBand(shopBandBlock) : null;
  const goldFromSheet = goldFromRoi == null && goldFromShopBand == null ? extractGoldFromSheet(criticalSheet) : null;
  const gold = goldFromRoi ?? goldFromShopBand ?? goldFromSheet;
  const goldSource = goldFromRoi != null
    ? "economy_gold_roi"
    : goldFromShopBand != null
      ? "shop_band_native_gold_marker"
      : goldFromSheet != null
        ? "critical_sheet_heuristic"
        : null;
  const hpCandidates = hpBlocks.flatMap((block) => extractNumbers(`${block.text} ${block.native_text}`)).filter((value) => value >= 1 && value <= 150);
  const augmentCandidates = augmentBlocks.flatMap((block) => matchAugments(`${block.text} ${block.native_text}`, catalog.augments));
  return {
    frame_seq: row?.frame_seq ?? null,
    monotonic_ms: row?.monotonic_ms ?? null,
    round_candidate: round,
    level_candidate: level,
    xp_candidate: xp,
    gold_candidate: gold,
    gold_source: goldSource,
    hp_number_candidates: hpCandidates.slice(0, 8),
    augment_choice_candidates: augmentCandidates,
    text_blocks: nonEmpty,
  };
}

function compactSlotCandidates(roiSummary, temporalRoi, group) {
  const temporalGroup = temporalRoi?.groups?.[group];
  if (temporalGroup) {
    return {
      status: temporalGroup.stable_occupied_slots > 0 ? "visual_candidate" : "missing",
      occupied_slots: temporalGroup.stable_occupied_slots,
      unstable_candidate_slots: temporalGroup.unstable_candidate_slots,
      total_slots: temporalGroup.total_slots,
      stable_slots: temporalGroup.stable_slots,
      unstable_slots: temporalGroup.unstable_slots,
      promotion_status: "candidate_not_verified",
      basis: "temporal_roi_stability_window",
    };
  }
  const groupSummary = roiSummary?.occupancy_groups?.[group] || {};
  const occupied = groupSummary.occupied ?? 0;
  return {
    status: occupied > 0 ? "visual_candidate" : "missing",
    occupied_slots: occupied,
    total_slots: groupSummary.total ?? 0,
    avg_confidence: groupSummary.avg_confidence ?? 0,
    promotion_status: "candidate_not_verified",
  };
}

function summarizeIdentityStability(sessionRows, temporalRoi, windowSize = 120) {
  const rows = sortRows(sessionRows.filter((row) => row.type === "roi_observations")).slice(-windowSize);
  const bySlot = {};
  for (const row of rows) {
    for (const item of row?.observations?.identity_candidates || []) {
      if (item.identity_status !== "candidate") continue;
      if (!["board_slots", "bench_slots"].includes(item.roi_group)) continue;
      if (item.slot == null || !item.hero_id) continue;
      const key = `${item.roi_group}:${item.slot}`;
      bySlot[key] ??= { group: item.roi_group, slot: item.slot, samples: 0, heroes: {} };
      const slot = bySlot[key];
      slot.samples += 1;
      slot.heroes[item.hero_id] ??= {
        hero_id: item.hero_id,
        hero_name: item.hero_name,
        samples: 0,
        confidence_sum: 0,
        hash_distance_sum: 0,
        hash_margin_sum: 0,
        hash_margin_samples: 0,
        combined_score_sum: 0,
        combined_score_samples: 0,
        score_margin_sum: 0,
        score_margin_samples: 0,
      };
      const hero = slot.heroes[item.hero_id];
      hero.samples += 1;
      hero.confidence_sum += Number(item.confidence || 0);
      hero.hash_distance_sum += Number(item.hash_distance || 64);
      if (item.hash_distance_margin != null) {
        hero.hash_margin_sum += Number(item.hash_distance_margin || 0);
        hero.hash_margin_samples += 1;
      }
      if (item.combined_score != null) {
        hero.combined_score_sum += Number(item.combined_score || 0);
        hero.combined_score_samples += 1;
      }
      if (item.score_margin != null) {
        hero.score_margin_sum += Number(item.score_margin || 0);
        hero.score_margin_samples += 1;
      }
    }
  }

  const stableSlotKeys = new Set();
  for (const group of ["board_slots", "bench_slots"]) {
    for (const slot of temporalRoi?.groups?.[group]?.stable_slots || []) {
      stableSlotKeys.add(`${group}:${slot}`);
    }
  }

  const verified = { board_units: [], bench_units: [] };
  const candidates = [];
  for (const slot of Object.values(bySlot)) {
    const heroes = Object.values(slot.heroes).sort((a, b) => b.samples - a.samples);
    const best = heroes[0];
    if (!best) continue;
    const dominantRate = best.samples / slot.samples;
    const avgConfidence = best.confidence_sum / best.samples;
    const avgHashDistance = best.hash_distance_sum / best.samples;
    const avgHashMargin = best.hash_margin_samples > 0 ? best.hash_margin_sum / best.hash_margin_samples : null;
    const avgCombinedScore = best.combined_score_samples > 0 ? best.combined_score_sum / best.combined_score_samples : null;
    const avgScoreMargin = best.score_margin_samples > 0 ? best.score_margin_sum / best.score_margin_samples : null;
    const hasHashMargin = best.hash_margin_samples === best.samples;
    const hasCombinedScore = best.combined_score_samples === best.samples;
    const hasScoreMargin = best.score_margin_samples === best.samples;
    const stableSlot = stableSlotKeys.has(`${slot.group}:${slot.slot}`);
    const modernMatcherPass = hasCombinedScore && hasScoreMargin && avgCombinedScore >= 0.70 && avgScoreMargin >= 0.025;
    const legacyMatcherPass = avgConfidence >= 0.82 && avgHashDistance <= 10.5 && hasHashMargin && avgHashMargin >= 3.0;
    const row = {
      group: slot.group,
      slot: slot.slot,
      hero_id: best.hero_id,
      hero_name: best.hero_name,
      identity_samples: best.samples,
      identity_total_samples: slot.samples,
      dominant_rate: Number(dominantRate.toFixed(3)),
      avg_identity_confidence: Number(avgConfidence.toFixed(3)),
      avg_hash_distance: Number(avgHashDistance.toFixed(2)),
      avg_hash_margin: avgHashMargin == null ? null : Number(avgHashMargin.toFixed(2)),
      avg_combined_score: avgCombinedScore == null ? null : Number(avgCombinedScore.toFixed(3)),
      avg_score_margin: avgScoreMargin == null ? null : Number(avgScoreMargin.toFixed(3)),
      stable_slot: stableSlot,
    };
    const passes = stableSlot && best.samples >= 3 && dominantRate >= 0.75 && (modernMatcherPass || legacyMatcherPass);
    if (passes) {
      const confidence = avgCombinedScore == null ? avgConfidence : avgCombinedScore;
      const unit = {
        slot: slot.slot,
        hero_id: best.hero_id,
        hero_name: best.hero_name,
        confidence: Number(Math.min(0.92, confidence * dominantRate).toFixed(3)),
        evidence: {
          identity_samples: best.samples,
          dominant_rate: Number(dominantRate.toFixed(3)),
          avg_hash_distance: Number(avgHashDistance.toFixed(2)),
          avg_hash_margin: avgHashMargin == null ? null : Number(avgHashMargin.toFixed(2)),
          avg_combined_score: avgCombinedScore == null ? null : Number(avgCombinedScore.toFixed(3)),
          avg_score_margin: avgScoreMargin == null ? null : Number(avgScoreMargin.toFixed(3)),
          stable_slot: true,
          matcher_policy: modernMatcherPass ? "multi_feature_v2" : "legacy_hash_margin",
          window: "temporal_roi_and_identity_stability",
        },
      };
      if (slot.group === "board_slots") verified.board_units.push(unit);
      else verified.bench_units.push(unit);
    } else {
      candidates.push({
        ...row,
        promotion_status: "candidate_not_verified",
        blockers: [
          stableSlot ? null : "slot_not_temporally_stable",
          best.samples >= 3 ? null : "insufficient_identity_samples",
          dominantRate >= 0.75 ? null : "identity_not_dominant",
          modernMatcherPass || legacyMatcherPass ? null : "matcher_score_below_threshold",
          hasCombinedScore ? null : "combined_score_unavailable",
          hasScoreMargin ? null : "score_margin_unavailable",
          hasHashMargin ? null : "identity_margin_unavailable",
        ].filter(Boolean),
      });
    }
  }
  verified.board_units.sort((a, b) => a.slot - b.slot);
  verified.bench_units.sort((a, b) => a.slot - b.slot);
  candidates.sort((a, b) => a.group.localeCompare(b.group) || a.slot - b.slot);
  return {
    window_size: windowSize,
    verified,
    candidates,
    policy: {
      min_identity_samples: 3,
      min_dominant_rate: 0.75,
      modern_min_avg_combined_score: 0.70,
      modern_min_avg_score_margin: 0.025,
      legacy_min_avg_identity_confidence: 0.82,
      legacy_max_avg_hash_distance: 10.5,
      legacy_min_avg_hash_margin: 3.0,
      requires_temporal_slot_stability: true,
    },
  };
}

function summarizeFreshness(latestFrameSeq, latestMonotonicMs, ocr) {
  const ocrAgeFrames = latestFrameSeq != null && ocr.frame_seq != null ? Math.max(0, latestFrameSeq - ocr.frame_seq) : null;
  const ocrAgeMs = latestMonotonicMs != null && ocr.monotonic_ms != null ? Math.max(0, latestMonotonicMs - ocr.monotonic_ms) : null;
  return {
    latest_frame_seq: latestFrameSeq,
    latest_monotonic_ms: latestMonotonicMs,
    ocr_frame_seq: ocr.frame_seq,
    ocr_monotonic_ms: ocr.monotonic_ms,
    ocr_age_frames: ocrAgeFrames,
    ocr_age_ms: ocrAgeMs,
    ocr_fresh: ocrAgeMs != null ? ocrAgeMs <= 15000 : ocrAgeFrames != null && ocrAgeFrames <= 600,
    freshness_policy: "OCR-derived promoted fields are stale when older than 15000ms by capture monotonic clock; frame_seq is fallback only.",
  };
}

function summarizeAgentState({ latestSession, phaseContext, roi, temporalRoi, verificationTemporalRoi, identityStability, ocr, freshness }) {
  const promoted = {};
  const candidates = {};
  const quarantine = [];
  const ocrFresh = freshness?.ocr_fresh === true;

  if (ocrFresh && phaseContext.phase !== "unknown" && phaseContext.confidence >= 0.7) {
    promoted.phase = {
      value: phaseContext.phase,
      confidence: phaseContext.confidence,
      evidence: phaseContext.reasons,
    };
  } else {
    candidates.phase = {
      ...phaseContext,
      promotion_status: ocrFresh ? "candidate_not_verified" : "stale_ocr_candidate",
    };
  }
  if (ocrFresh && ocr.round_candidate) {
    promoted.round = {
      value: ocr.round_candidate,
      confidence: 0.72,
      evidence: "ocr_phase_or_top_bar",
    };
  } else if (ocr.round_candidate) {
    candidates.round = {
      value: ocr.round_candidate,
      promotion_status: "stale_ocr_candidate",
    };
  }
  if (ocrFresh && ocr.level_candidate != null) {
    promoted.level = {
      value: ocr.level_candidate,
      confidence: 0.8,
      evidence: "ocr_shop_band_level_marker",
    };
  } else if (ocr.level_candidate != null) {
    candidates.level = {
      value: ocr.level_candidate,
      promotion_status: "stale_ocr_candidate",
    };
  }
  if (ocrFresh && ocr.xp_candidate) {
    promoted.xp = {
      ...ocr.xp_candidate,
      confidence: 0.78,
      evidence: "ocr_shop_band_xp_fraction",
    };
  } else if (ocr.xp_candidate) {
    candidates.xp = {
      ...ocr.xp_candidate,
      promotion_status: "stale_ocr_candidate",
    };
  }
  if (ocrFresh && ocr.gold_candidate != null && ocr.gold_source === "economy_gold_roi") {
    promoted.gold = {
      value: ocr.gold_candidate,
      confidence: 0.72,
      evidence: "ocr_gold_roi",
    };
  } else if (ocr.gold_candidate != null) {
    candidates.gold = {
      value: ocr.gold_candidate,
      source: ocr.gold_source,
      promotion_status: ocrFresh ? "candidate_not_verified" : "stale_ocr_candidate",
    };
  }

  candidates.hp_scoreboard_numbers = {
    values: ocr.hp_number_candidates,
    local_player_row_candidate: roi.scoreboard_candidates?.local_player_row_candidate ?? null,
    row_candidates: roi.scoreboard_candidates?.row_candidates ?? [],
    binding_basis: roi.scoreboard_candidates?.binding_basis ?? null,
    promotion_status: roi.scoreboard_candidates?.local_player_row_candidate
      ? "candidate_local_player_row_detected_hp_not_line_bound"
      : "candidate_not_local_player_verified",
  };
  candidates.shop_slots = compactSlotCandidates(roi, temporalRoi, "shop_slots");
  candidates.board_slots = compactSlotCandidates(roi, temporalRoi, "board_slots");
  candidates.bench_slots = compactSlotCandidates(roi, temporalRoi, "bench_slots");
  candidates.identity = {
    candidates: roi.identity_candidates,
    low_confidence_count: roi.low_confidence_identity_count,
    promotion_status: "candidate_not_verified",
  };
  candidates.identity_stability = {
    candidates: identityStability.candidates,
    policy: identityStability.policy,
    promotion_status: "candidate_or_verified_by_slot",
  };

  const verifiedBoardSlots = verificationTemporalRoi?.groups?.board_slots?.stable_slots || [];
  const verifiedBenchSlots = verificationTemporalRoi?.groups?.bench_slots?.stable_slots || [];
  if (phaseContext.valid_for_board_bench_promotion && verifiedBoardSlots.length > 0) {
    promoted.board_slot_occupancy = {
      occupied_slots: verifiedBoardSlots,
      total_slots: verificationTemporalRoi.groups.board_slots.total_slots,
      confidence: 0.74,
      evidence: "short_window_temporal_roi_stability",
      promotion_status: "verified_occupancy_only",
    };
  }
  if (phaseContext.valid_for_board_bench_promotion && verifiedBenchSlots.length > 0) {
    promoted.bench_slot_occupancy = {
      occupied_slots: verifiedBenchSlots,
      total_slots: verificationTemporalRoi.groups.bench_slots.total_slots,
      confidence: 0.74,
      evidence: "short_window_temporal_roi_stability",
      promotion_status: "verified_occupancy_only",
    };
  }

  const verifiedBoardUnits = identityStability.verified.board_units;
  const verifiedBenchUnits = identityStability.verified.bench_units;
  if (phaseContext.valid_for_board_bench_promotion && verifiedBoardUnits.length > 0) {
    promoted.board_units = {
      units: verifiedBoardUnits,
      confidence: 0.72,
      evidence: "temporal_slot_stability_plus_repeated_template_identity",
      promotion_status: "verified_partial_snapshot",
    };
  } else if (verifiedBoardUnits.length > 0) {
    candidates.board_units_verified_out_of_phase = {
      units: verifiedBoardUnits,
      promotion_status: "candidate_not_current_phase_verified",
    };
  }
  if (phaseContext.valid_for_board_bench_promotion && verifiedBenchUnits.length > 0) {
    promoted.bench_units = {
      units: verifiedBenchUnits,
      confidence: 0.72,
      evidence: "temporal_slot_stability_plus_repeated_template_identity",
      promotion_status: "verified_partial_snapshot",
    };
  } else if (verifiedBenchUnits.length > 0) {
    candidates.bench_units_verified_out_of_phase = {
      units: verifiedBenchUnits,
      promotion_status: "candidate_not_current_phase_verified",
    };
  }

  if (!promoted.board_units) {
    quarantine.push({
      field: "board_units",
      reason: "No board slot passed temporal occupancy plus repeated identity confirmation in a valid phase.",
    });
  }
  if (!promoted.bench_units) {
    quarantine.push({
      field: "bench_units",
      reason: "No bench slot passed temporal occupancy plus repeated identity confirmation in a valid phase.",
    });
  }
  quarantine.push({
    field: "shop_units",
    reason: "Shop card presence is visible, but card identities are not verified.",
  });
  if (!phaseContext.valid_for_board_bench_promotion) {
    quarantine.push({
      field: "board_bench_candidate_fusion",
      reason: "Current phase is not valid for board/bench promotion.",
    });
  }

  return {
    schema: "jcc-runtime-agent-state-v1",
    match_session_id: latestSession,
    status: Object.keys(promoted).length > 0 ? "partially_promoted" : "candidate_only",
    promoted,
    candidates,
    quarantine,
    freshness,
    pollution_guard: {
      match_session_scoped: true,
      cross_match_fusion_allowed: false,
      raw_frame_persistence_allowed: false,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const catalog = await loadCatalog();
  const input = resolve(args.input);
  const text = await readFile(input, "utf8");
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const rows = lines.slice(-args.last).map((line) => JSON.parse(line));
  const latestSession = rows.at(-1)?.match_session_id ?? null;
  const sessionRows = sortRows(rows.filter((row) => row.match_session_id === latestSession));
  const byType = {};
  for (const row of sessionRows) byType[row.type] = (byType[row.type] || 0) + 1;
  const latestRoi = [...sessionRows].reverse().find((row) => row.type === "roi_observations");
  const latestOcr = [...sessionRows].reverse().find((row) => row.type === "ocr_text_blocks");
  const roi = summarizeRoi(latestRoi);
  const temporalRoi = summarizeTemporalRoi(sessionRows);
  const verificationTemporalRoi = summarizeTemporalRoi(sessionRows, 24);
  const identityStability = summarizeIdentityStability(sessionRows, verificationTemporalRoi, 24);
  const ocr = summarizeOcr(latestOcr, catalog);
  const latestFrame = latestRoi ?? [...sessionRows].reverse().find((row) => row.type === "frame_meta") ?? null;
  const latestFrameSeq = latestFrame?.frame_seq ?? null;
  const latestMonotonicMs = latestFrame?.monotonic_ms ?? null;
  const freshness = summarizeFreshness(latestFrameSeq, latestMonotonicMs, ocr);
  const phaseContext = inferPhaseContext(roi, ocr, verificationTemporalRoi);
  const summary = {
    schema: "jcc-companion-live-state-summary-v1",
    source: input,
    latest_session_id: latestSession,
    session_message_count: sessionRows.length,
    message_counts: byType,
    phase_context: phaseContext,
    roi,
    temporal_roi: temporalRoi,
    verification_temporal_roi: verificationTemporalRoi,
    identity_stability: identityStability,
    ocr,
    data_freshness: freshness,
    agent_state: summarizeAgentState({ latestSession, phaseContext, roi, temporalRoi, verificationTemporalRoi, identityStability, ocr, freshness }),
    promotion_status: "partially_promoted",
    current_limit: "Phase/level/xp/gold may be promoted when OCR evidence is strong. Board, bench, shop, HP, and unit identities remain candidates until calibrated with local-player and identity binding evidence.",
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
