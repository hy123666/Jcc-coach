import { createHash } from "node:crypto";

const IDENTITY_FIELDS = [
  "runtime_season_id",
  "active_patch_id",
  "game_mode_id",
  "core_profile_id",
  "hard_data_manifest_fingerprint",
  "catalog_source_fingerprint",
  "battle_type",
  "lineup_version_id",
  "ranking_set_id",
];

const RESPONSE_KEYS = new Set(["schema", "target_identity", "input_hash", "annotations"]);
const ANNOTATION_KEYS = new Set([
  "lineup_id",
  "confidence",
  "formation_burden",
  "flexibility",
  "strategy_style",
  "condition_flags",
  "rationale_codes",
]);
const CONFIDENCE = new Set(["low", "medium", "high"]);
const BURDEN = new Set(["low", "medium", "high", "unknown"]);
const FLEXIBILITY = new Set(["low", "medium", "high", "unknown"]);
const STRATEGY_STYLES = new Set([
  "standard_leveling",
  "fast_leveling",
  "slow_roll",
  "hyper_roll",
  "conditional_vertical",
  "flexible_transition",
  "unknown",
]);
const CONDITION_FLAGS = new Set([
  "item_dependent",
  "augment_dependent",
  "emblem_dependent",
  "three_star_dependent",
  "high_cost_core",
  "low_flexibility",
  "transition_sensitive",
  "low_sample_context",
]);
const RATIONALE_CODES = new Set([
  "new_current_day_recipe",
  "core_roster_changed",
  "main_carry_changed",
  "equipment_requirements_changed",
  "transition_structure_changed",
  "condition_requirements_changed",
  "lifecycle_changed",
  "semantic_profile_unchanged",
  "semantic_annotation_retry",
]);
// The aggregate packet is a local maintenance artifact; individual Host calls remain batch-bounded.
const MAINTENANCE_PACKET_MAX_BYTES = 4 * 1024 * 1024;
const MAINTENANCE_RESPONSE_MAX_BYTES = 64 * 1024;
// Keep each model response comfortably below the provider output/context edge.
// The aggregate packet remains 1MB; this only narrows one isolated Host call.
const MAINTENANCE_BATCH_MAX_BYTES = 48 * 1024;
const MAINTENANCE_INITIAL_ATTEMPTS_PER_BATCH = 2;
const MAINTENANCE_MAX_ATTEMPTS_PER_BATCH = 6;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function uniqueStrings(values, limit = 128) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").normalize("NFKC").trim())
    .filter(Boolean))].slice(0, limit);
}

function boundedText(value, limit = 160) {
  return String(value ?? "").normalize("NFKC").trim().slice(0, limit);
}

function sourceIdentity(strategyIndex) {
  const source = strategyIndex?.source_identity || {};
  const identity = Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, source[field] ?? null]));
  for (const field of IDENTITY_FIELDS) {
    if (identity[field] === null || String(identity[field]).trim() === "") {
      throw new Error(`ranking maintenance target identity is missing ${field}`);
    }
  }
  return identity;
}

function lineupId(candidate) {
  return boundedText(candidate?.lineup_group_id || candidate?.id, 160);
}

function roleProjection(role) {
  if (!role || typeof role !== "object") return null;
  return {
    champion_id: boundedText(role.champion_id || role.id, 120) || null,
    champion_name: boundedText(role.champion_name || role.name, 80) || null,
    cost: Number.isFinite(Number(role.cost)) ? Number(role.cost) : null,
  };
}

function variantProjection(variant) {
  return {
    variant_id: boundedText(variant?.variant_id || variant?.id, 160) || null,
    atomic_roster_id: boundedText(variant?.atomic_roster_id, 160) || null,
    population: Number.isFinite(Number(variant?.population)) ? Number(variant.population) : null,
    lineup_ids: uniqueStrings(variant?.lineup_ids || variant?.core_unit_ids, 16).sort(),
    external_roster_unit_ids: uniqueStrings(
      variant?.unresolved_source_unit_ids
      || variant?.atomic_roster_members?.filter((unit) => unit?.entity_kind === "external_roster_unit").map((unit) => unit?.source_unit_id),
      16,
    ).sort(),
    main_carry: roleProjection(variant?.main_carry),
    primary_tank: roleProjection(variant?.primary_tank),
    transition_populations: (Array.isArray(variant?.transition_chain) ? variant.transition_chain : variant?.transitions || [])
      .map((entry) => Number(entry?.population))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)
      .slice(0, 12),
  };
}

function semanticProjection(candidate) {
  return stableValue({
    lineup_id: lineupId(candidate),
    main_carry: roleProjection(candidate?.main_carry),
    primary_tank: roleProjection(candidate?.primary_tank),
    core_unit_ids: uniqueStrings(candidate?.core_unit_ids || candidate?.core_units?.map((unit) => unit?.champion_id), 16).sort(),
    core_units: (Array.isArray(candidate?.core_units) ? candidate.core_units : [])
      .map(roleProjection)
      .filter(Boolean)
      .sort((left, right) => String(left.champion_id).localeCompare(String(right.champion_id))),
    traits: (Array.isArray(candidate?.strength_anchor?.traits) ? candidate.strength_anchor.traits : [])
      .map((trait) => ({
        canonical_trait_id: boundedText(trait?.canonical_trait_id || trait?.trait_id, 120) || null,
        trait_name: boundedText(trait?.trait_name || trait?.name, 80) || null,
        breakpoint: Number.isFinite(Number(trait?.active_breakpoint ?? trait?.breakpoint ?? trait?.count))
          ? Number(trait?.active_breakpoint ?? trait?.breakpoint ?? trait?.count)
          : null,
      }))
      .sort((left, right) => String(left.canonical_trait_id).localeCompare(String(right.canonical_trait_id))),
    equipment_requirements: candidate?.equipment_requirements || null,
    lifecycle_prior: candidate?.lifecycle_prior || null,
    condition_priors: candidate?.condition_priors || null,
    recipe_match: candidate?.recipe_match ? {
      classification: candidate.recipe_match.classification || null,
      matched_anchor_id: candidate.recipe_match.matched_anchor_id || null,
      analogous_anchor_id: candidate.recipe_match.analogous_anchor_id || null,
    } : null,
    variants: (Array.isArray(candidate?.variants) ? candidate.variants : [])
      .map(variantProjection)
      .sort((left, right) => String(left.variant_id).localeCompare(String(right.variant_id))),
  });
}

export function rankingMaintenanceSemanticHash(candidate) {
  return candidate ? sha256(semanticProjection(candidate)) : null;
}

function candidatesById(strategyIndex) {
  return new Map((strategyIndex?.tiers?.["0"]?.lineup_candidates || [])
    .map((candidate) => [lineupId(candidate), candidate])
    .filter(([id]) => id));
}

function compactCommonSummary(value) {
  return {
    principles: uniqueStrings(value?.principles, 16).map((entry) => boundedText(entry, 240)),
  };
}

function compactCoreSummary(value, identity) {
  if (String(value?.core_profile_id || "") !== String(identity.core_profile_id)) {
    throw new Error("ranking maintenance Core summary does not match the selected target Core Profile");
  }
  if (String(value?.season_id || "") !== String(identity.runtime_season_id)
    || String(value?.patch_id || "") !== String(identity.active_patch_id)) {
    throw new Error("ranking maintenance Core summary season or patch does not match the selected target");
  }
  return {
    core_profile_id: identity.core_profile_id,
    season_id: identity.runtime_season_id,
    patch_id: identity.active_patch_id,
    catalog_counts: {
      champion_count: uniqueStrings(value?.champion_ids).length,
      trait_count: uniqueStrings(value?.trait_ids).length,
      augment_count: uniqueStrings(value?.augment_ids).length,
      item_count: uniqueStrings(value?.item_ids).length,
    },
    champion_ids: [],
    trait_ids: [],
    augment_ids: [],
    item_ids: [],
    id_payload_policy: "catalog_counts_only_referenced_entity_ids_are_carried_by_semantic_records",
  };
}

export function buildRankingMaintenancePacket({
  strategyIndex,
  previousStrategyIndex = null,
  commonSummary = {},
  coreSummary,
} = {}) {
  if (!strategyIndex || typeof strategyIndex !== "object") throw new TypeError("strategyIndex is required");
  const identity = sourceIdentity(strategyIndex);
  const previous = previousStrategyIndex && stableJson(sourceIdentity(previousStrategyIndex)) === stableJson(identity)
    ? candidatesById(previousStrategyIndex)
    : new Map();
  const records = [];
  const reusedAnnotations = [];
  for (const [id, candidate] of candidatesById(strategyIndex)) {
    const semantic = semanticProjection(candidate);
    const semanticHash = rankingMaintenanceSemanticHash(candidate);
    const prior = previous.get(id);
    const previousHash = rankingMaintenanceSemanticHash(prior);
    let changeKind = prior ? "semantic_changed" : "new";
    if (previousHash === semanticHash) {
      const priorAnnotation = prior?.semantic_annotation;
      if (priorAnnotation) {
        try {
          const annotation = normalizeAnnotation(priorAnnotation, 0, new Set([id]));
          reusedAnnotations.push({ lineup_id: id, semantic_hash: semanticHash, annotation });
          continue;
        } catch {
          // Invalid legacy annotations are dropped and never block deterministic publication.
        }
      }
      changeKind = "annotation_missing_retry";
    }
    records.push({
      lineup_id: id,
      anchor_id: boundedText(candidate?.strength_anchor?.anchor_id, 200) || null,
      change_kind: changeKind,
      semantic_hash: semanticHash,
      semantic_structure: semantic,
      deterministic_strength_classification: boundedText(candidate?.strength_anchor?.quality?.classification, 80) || null,
    });
  }
  records.sort((left, right) => left.lineup_id.localeCompare(right.lineup_id));
  reusedAnnotations.sort((left, right) => left.lineup_id.localeCompare(right.lineup_id));
  const packetBase = {
    schema: "jcc-ranking-maintenance-packet-v1",
    target_identity: identity,
    stat_date: strategyIndex.stat_date || null,
    authority: {
      model_role: "bounded_semantic_annotation_only",
      forbidden: ["numeric_score", "weight", "rank", "metric_change", "candidate_change", "publication_decision", "free_form_action"],
      current_day_strength_is_deterministic: true,
    },
    common_summary: compactCommonSummary(commonSummary),
    core_summary: compactCoreSummary(coreSummary, identity),
    records,
    reused_annotations: reusedAnnotations,
  };
  const packet = { ...packetBase, input_hash: sha256(packetBase) };
  if (Buffer.byteLength(JSON.stringify(packet)) > MAINTENANCE_PACKET_MAX_BYTES) {
    throw new Error("ranking maintenance packet exceeds 4MB");
  }
  return packet;
}

function maintenanceBatchBase(packet, records) {
  return {
    schema: "jcc-ranking-maintenance-packet-v1",
    target_identity: packet.target_identity,
    stat_date: packet.stat_date || null,
    authority: packet.authority,
    common_summary: packet.common_summary,
    core_summary: packet.core_summary,
    records,
    reused_annotations: [],
  };
}

function finalizeMaintenanceBatch(packet, records) {
  const base = maintenanceBatchBase(packet, records);
  return { ...base, input_hash: sha256(base) };
}

export function buildRankingMaintenanceBatchPackets(packet, {
  maxBytes = MAINTENANCE_BATCH_MAX_BYTES,
} = {}) {
  if (!packet || packet.schema !== "jcc-ranking-maintenance-packet-v1") {
    throw new TypeError("valid maintenance packet is required");
  }
  if (!Array.isArray(packet.records) || packet.records.length === 0) return [];
  const byteLimit = Number(maxBytes);
  if (!Number.isFinite(byteLimit) || byteLimit <= 0 || byteLimit > MAINTENANCE_PACKET_MAX_BYTES) {
    throw new RangeError("maintenance batch byte limit must be positive and no larger than 4MB");
  }
  const batches = [];
  let current = [];
  for (const record of packet.records) {
    const candidate = finalizeMaintenanceBatch(packet, [...current, record]);
    if (Buffer.byteLength(JSON.stringify(candidate)) > byteLimit) {
      if (current.length === 0) {
        throw new Error(`ranking maintenance record cannot fit in ${byteLimit} bytes: ${record.lineup_id}`);
      }
      batches.push(finalizeMaintenanceBatch(packet, current));
      current = [record];
      const single = finalizeMaintenanceBatch(packet, current);
      if (Buffer.byteLength(JSON.stringify(single)) > byteLimit) {
        throw new Error(`ranking maintenance record cannot fit in ${byteLimit} bytes: ${record.lineup_id}`);
      }
    } else {
      current = [...current, record];
    }
  }
  if (current.length > 0) batches.push(finalizeMaintenanceBatch(packet, current));
  return batches;
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value || {})) {
    if (!allowed.has(key)) throw new Error(`${label} contains forbidden field ${key}`);
  }
}

function assertEnum(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`${label} has unsupported value ${String(value)}`);
}

function assertStringArray(value, allowed, label, limit) {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label} must be an array with at most ${limit} values`);
  const normalized = value.map((entry) => boundedText(entry, 80));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicates`);
  for (const entry of normalized) assertEnum(entry, allowed, label);
  return normalized.sort();
}

function normalizeAnnotation(annotation, index, allowedIds) {
  if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) throw new Error(`annotation ${index} must be an object`);
  assertExactKeys(annotation, ANNOTATION_KEYS, `annotation ${index}`);
  const id = boundedText(annotation.lineup_id, 160);
  if (!allowedIds.has(id)) throw new Error(`annotation ${index} references unknown lineup ${id}`);
  assertEnum(annotation.confidence, CONFIDENCE, `annotation ${index}.confidence`);
  assertEnum(annotation.formation_burden, BURDEN, `annotation ${index}.formation_burden`);
  assertEnum(annotation.flexibility, FLEXIBILITY, `annotation ${index}.flexibility`);
  assertEnum(annotation.strategy_style, STRATEGY_STYLES, `annotation ${index}.strategy_style`);
  return {
    lineup_id: id,
    confidence: annotation.confidence,
    formation_burden: annotation.formation_burden,
    flexibility: annotation.flexibility,
    strategy_style: annotation.strategy_style,
    condition_flags: assertStringArray(annotation.condition_flags, CONDITION_FLAGS, `annotation ${index}.condition_flags`, 8),
    rationale_codes: assertStringArray(annotation.rationale_codes, RATIONALE_CODES, `annotation ${index}.rationale_codes`, 8),
  };
}

export function validateRankingMaintenanceResponse(packet, response) {
  if (!packet || packet.schema !== "jcc-ranking-maintenance-packet-v1") throw new TypeError("valid maintenance packet is required");
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new TypeError("maintenance response must be an object");
  if (Buffer.byteLength(JSON.stringify(response)) > MAINTENANCE_RESPONSE_MAX_BYTES) throw new Error("maintenance response exceeds 64KB");
  assertExactKeys(response, RESPONSE_KEYS, "maintenance response");
  if (response.schema !== "jcc-ranking-maintenance-response-v1") throw new Error("unsupported maintenance response schema");
  if (stableJson(response.target_identity) !== stableJson(packet.target_identity)) throw new Error("maintenance response identity mismatch");
  if (response.input_hash !== packet.input_hash) throw new Error("maintenance response input hash mismatch");
  if (!Array.isArray(response.annotations)) throw new Error("maintenance response annotations must be an array");
  const allowedIds = new Set(packet.records.map((entry) => entry.lineup_id));
  const seen = new Set();
  const annotations = response.annotations.map((annotation, index) => {
    const normalized = normalizeAnnotation(annotation, index, allowedIds);
    const id = normalized.lineup_id;
    if (seen.has(id)) throw new Error(`duplicate annotation for lineup ${id}`);
    seen.add(id);
    return normalized;
  }).sort((left, right) => left.lineup_id.localeCompare(right.lineup_id));
  if (seen.size !== allowedIds.size) {
    const missing = [...allowedIds].filter((id) => !seen.has(id));
    throw new Error(`maintenance response omitted changed lineups: ${missing.join(",")}`);
  }
  return {
    status: "ready",
    input_hash: packet.input_hash,
    output_hash: sha256(response),
    annotations,
    failure_code: null,
  };
}

export function createDegradedRankingMaintenance(packet, failureCode = "host_unavailable", failureReason = null) {
  if (!packet || packet.schema !== "jcc-ranking-maintenance-packet-v1") throw new TypeError("valid maintenance packet is required");
  return {
    status: "degraded",
    input_hash: packet.input_hash,
    output_hash: null,
    // Semantic labels are optional. Keep the generation publishable with an
    // explicit low-confidence placeholder for every changed record instead of
    // blocking authoritative Ranking facts when the maintenance Host is slow.
    annotations: packet.records.map((record) => ({
      lineup_id: record.lineup_id,
      confidence: "low",
      formation_burden: "unknown",
      flexibility: "unknown",
      strategy_style: "unknown",
      condition_flags: [],
      rationale_codes: ["semantic_annotation_retry"],
    })),
    failure_code: boundedText(failureCode, 80) || "host_unavailable",
    failure_reason: boundedText(failureReason, 500) || null,
  };
}

export function createNotRequiredRankingMaintenance(packet) {
  if (!packet || packet.schema !== "jcc-ranking-maintenance-packet-v1") throw new TypeError("valid maintenance packet is required");
  if (packet.records.length !== 0) throw new Error("maintenance can be not_required only when no semantic records changed");
  return {
    status: "not_required",
    input_hash: packet.input_hash,
    output_hash: null,
    annotations: [],
    failure_code: null,
  };
}

export function validateRankingMaintenancePacketForStrategy(packet, strategyIndex) {
  if (!packet || packet.schema !== "jcc-ranking-maintenance-packet-v1") throw new TypeError("valid maintenance packet is required");
  const packetWithoutHash = { ...packet };
  delete packetWithoutHash.input_hash;
  if (sha256(packetWithoutHash) !== packet.input_hash) throw new Error("maintenance packet input hash mismatch");
  if (stableJson(packet.target_identity) !== stableJson(sourceIdentity(strategyIndex))) {
    throw new Error("maintenance packet does not match prepared strategy identity");
  }
  if (String(packet.stat_date || "") !== String(strategyIndex?.stat_date || "")) {
    throw new Error("maintenance packet stat_date does not match prepared strategy index");
  }
  const candidates = candidatesById(strategyIndex);
  for (const record of packet.records || []) {
    const candidate = candidates.get(record.lineup_id);
    if (!candidate) throw new Error(`maintenance packet references missing prepared lineup ${record.lineup_id}`);
    if (rankingMaintenanceSemanticHash(candidate) !== record.semantic_hash) {
      throw new Error(`maintenance packet semantic hash mismatch for ${record.lineup_id}`);
    }
  }
  for (const [index, reused] of (packet.reused_annotations || []).entries()) {
    const candidate = candidates.get(reused?.lineup_id);
    if (!candidate) throw new Error(`reused maintenance annotation references missing prepared lineup ${reused?.lineup_id}`);
    const expectedHash = rankingMaintenanceSemanticHash(candidate);
    if (reused.semantic_hash !== expectedHash) throw new Error(`reused maintenance annotation semantic hash mismatch for ${reused.lineup_id}`);
    const normalized = normalizeAnnotation(reused.annotation, index, new Set([reused.lineup_id]));
    if (normalized.lineup_id !== reused.lineup_id) throw new Error(`reused maintenance annotation identity mismatch for ${reused.lineup_id}`);
  }
  return true;
}

export function applyRankingMaintenance(strategyIndex, maintenance, {
  provider = null,
  model = null,
  durationMs = null,
  reusedAnnotations = [],
} = {}) {
  if (!strategyIndex || typeof strategyIndex !== "object") throw new TypeError("strategyIndex is required");
  if (!maintenance || !["ready", "degraded", "not_required"].includes(maintenance.status)) {
    throw new TypeError("validated maintenance result is required");
  }
  const result = structuredClone(strategyIndex);
  const reused = (reusedAnnotations || []).map((entry, index) => normalizeAnnotation(
    entry?.annotation || entry,
    index,
    new Set([entry?.lineup_id || entry?.annotation?.lineup_id]),
  ));
  const byId = new Map(reused.map((entry) => [entry.lineup_id, entry]));
  for (const entry of maintenance.annotations || []) byId.set(entry.lineup_id, entry);
  for (const candidate of result?.tiers?.["0"]?.lineup_candidates || []) {
    delete candidate.semantic_annotation;
    const annotation = byId.get(lineupId(candidate));
    if (annotation) candidate.semantic_annotation = annotation;
  }
  result.semantic_maintenance = {
    schema: "jcc-ranking-semantic-maintenance-receipt-v1",
    status: maintenance.status,
    annotation_count: byId.size,
    reused_annotation_count: reused.length,
    input_hash: maintenance.input_hash || null,
    output_hash: maintenance.output_hash || null,
    provider: boundedText(provider, 40) || null,
    model: boundedText(model, 120) || null,
    duration_ms: Number.isFinite(Number(durationMs)) ? Math.max(0, Math.round(Number(durationMs))) : null,
    failure_code: maintenance.failure_code || null,
    failure_reason: boundedText(maintenance.failure_reason, 500) || null,
    authority: "non_authoritative_semantic_annotation_only",
    current_day_strength_unchanged: true,
  };
  delete result.content_fingerprint;
  return {
    ...result,
    content_fingerprint: sha256(result),
  };
}

export function buildRankingMaintenancePrompt(packet) {
  if (!packet || packet.schema !== "jcc-ranking-maintenance-packet-v1") throw new TypeError("valid maintenance packet is required");
  const modelPacket = { ...packet };
  delete modelPacket.reused_annotations;
  return [
    "你是金铲铲每日排名数据的隔离维护器。只分析输入中新增或语义变化的阵容记录。",
    "你不得修改或建议修改任何数值、分数、权重、排名、候选成员、实体、阶段或发布决定。",
    "只返回一个 JSON 对象，不要 Markdown，不要解释，不要在 JSON 前后添加任何自然语言。每个输入 lineup_id 必须且只能返回一次。",
    "这是闭合输出合同。所有字段都必须出现，所有数组只能使用下面列出的值；无法判断时使用 unknown、low 或空数组。",
    JSON.stringify({
      confidence: [...CONFIDENCE],
      formation_burden: [...BURDEN],
      flexibility: [...FLEXIBILITY],
      strategy_style: [...STRATEGY_STYLES],
      condition_flags: [...CONDITION_FLAGS],
      rationale_codes: [...RATIONALE_CODES],
    }),
    "输入数据如下：",
    JSON.stringify(modelPacket),
    "输出形状：{\"schema\":\"jcc-ranking-maintenance-response-v1\",\"target_identity\":<原样>,\"input_hash\":<原样>,\"annotations\":[{\"lineup_id\":\"...\",\"confidence\":\"low|medium|high\",\"formation_burden\":\"low|medium|high|unknown\",\"flexibility\":\"low|medium|high|unknown\",\"strategy_style\":\"standard_leveling|fast_leveling|slow_roll|hyper_roll|conditional_vertical|flexible_transition|unknown\",\"condition_flags\":[\"item_dependent\",\"augment_dependent\",\"emblem_dependent\",\"three_star_dependent\",\"high_cost_core\",\"low_flexibility\",\"transition_sensitive\",\"low_sample_context\"],\"rationale_codes\":[\"new_current_day_recipe\",\"core_roster_changed\",\"main_carry_changed\",\"equipment_requirements_changed\",\"transition_structure_changed\",\"condition_requirements_changed\",\"lifecycle_changed\",\"semantic_profile_unchanged\",\"semantic_annotation_retry\"]}]}",
  ].join("\n");
}

export const RANKING_MAINTENANCE_IDENTITY_FIELDS = Object.freeze([...IDENTITY_FIELDS]);
export const RANKING_MAINTENANCE_PACKET_MAX_BYTES = MAINTENANCE_PACKET_MAX_BYTES;
export const RANKING_MAINTENANCE_RESPONSE_MAX_BYTES = MAINTENANCE_RESPONSE_MAX_BYTES;
export const RANKING_MAINTENANCE_BATCH_MAX_BYTES = MAINTENANCE_BATCH_MAX_BYTES;
export const RANKING_MAINTENANCE_INITIAL_ATTEMPTS_PER_BATCH = MAINTENANCE_INITIAL_ATTEMPTS_PER_BATCH;
export const RANKING_MAINTENANCE_MAX_ATTEMPTS_PER_BATCH = MAINTENANCE_MAX_ATTEMPTS_PER_BATCH;
