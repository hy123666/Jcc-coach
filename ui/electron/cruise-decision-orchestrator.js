import { createHash } from "node:crypto";

const OUTPUT_SCHEMA = "jcc-cruise-integrated-decision-v1";

function asArray(value) {
  return Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).flat().map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeName(value) {
  return String(value ?? "").normalize("NFKC").replace(/[!！]/g, "").trim().toLowerCase();
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function belongsToMatch(value, matchSessionId) {
  if (!value || typeof value !== "object" || !matchSessionId) return true;
  const owner = value.match_session_id ?? value.matchSessionId ?? null;
  return !owner || String(owner) === String(matchSessionId);
}

function unitIdentity(unit) {
  return String(
    unit?.champion_id
    ?? unit?.hero_id
    ?? unit?.unit_id
    ?? unit?.chess_id
    ?? unit?.id
    ?? "",
  ).trim();
}

function entityLookup(index) {
  const byKind = new Map();
  for (const row of asArray(index?.entities)) {
    const kind = String(row?.entity_kind || "").trim();
    if (!kind) continue;
    if (!byKind.has(kind)) byKind.set(kind, { byId: new Map(), byName: new Map() });
    const bucket = byKind.get(kind);
    if (row.entity_id !== null && row.entity_id !== undefined) bucket.byId.set(String(row.entity_id), row);
    if (row.name) bucket.byName.set(normalizeName(row.name), row);
  }
  return byKind;
}

function championFeatures(unit, lookup) {
  const bucket = lookup.get("champion") || { byId: new Map(), byName: new Map() };
  const row = bucket.byId.get(unitIdentity(unit)) || bucket.byName.get(normalizeName(unit?.name || unit?.champion_name));
  return uniqueStrings(row?.features);
}

function semanticEntity(kind, value, lookup) {
  const bucket = lookup.get(kind) || { byId: new Map(), byName: new Map() };
  const id = typeof value === "object" ? value?.entity_id ?? value?.item_id ?? value?.trait_id ?? value?.id : null;
  const name = typeof value === "object" ? value?.name ?? value?.item_name ?? value?.trait_name : value;
  return (id !== null && id !== undefined ? bucket.byId.get(String(id)) : null)
    || bucket.byName.get(normalizeName(name))
    || null;
}

function hpPressure(hp) {
  const value = finite(hp);
  if (value === null) return "unknown";
  if (value <= 20) return "critical";
  if (value <= 35) return "danger";
  if (value <= 55) return "pressured";
  return "healthy";
}

function collectEquipmentRows(equipment, keys) {
  return keys.flatMap((key) => asArray(equipment?.[key]));
}

const AUGMENT_LIFECYCLE_STATES = new Set([
  "active",
  "applied_or_active",
  "pending",
  "resolved",
  "expired",
  "unresolved",
]);

export function buildCruiseMatchFeatureProjection({
  semanticFeatureIndex,
  matchSessionId = null,
  stageRound,
  economy = {},
  currentBoardShopBench = {},
  equipment = {},
}) {
  const lookup = entityLookup(semanticFeatureIndex);
  const boardUnits = asArray(currentBoardShopBench.board_units).filter((row) => belongsToMatch(row, matchSessionId));
  const benchUnits = asArray(currentBoardShopBench.bench_units).filter((row) => belongsToMatch(row, matchSessionId));
  const shopUnits = asArray(currentBoardShopBench.shop_units).filter((row) => belongsToMatch(row, matchSessionId));
  const roleCoverage = { frontline: 0, backline: 0, support: 0, tank: 0, ad: 0, ap: 0, mixed: 0 };
  const boardFeatures = [];
  const starSummary = { one_star: 0, two_star: 0, three_star: 0, unknown: 0 };
  for (const unit of boardUnits) {
    const features = championFeatures(unit, lookup);
    boardFeatures.push(...features);
    if (features.includes("role.frontline")) roleCoverage.frontline += 1;
    if (features.includes("role.backline")) roleCoverage.backline += 1;
    if (features.includes("role.support")) roleCoverage.support += 1;
    if (features.includes("output.tank")) roleCoverage.tank += 1;
    if (features.includes("output.ad")) roleCoverage.ad += 1;
    if (features.includes("output.ap")) roleCoverage.ap += 1;
    if (features.includes("output.mixed")) roleCoverage.mixed += 1;
    const star = finite(unit?.star ?? unit?.star_level);
    if (star === 1) starSummary.one_star += 1;
    else if (star === 2) starSummary.two_star += 1;
    else if (star === 3) starSummary.three_star += 1;
    else starSummary.unknown += 1;
  }
  const itemBench = collectEquipmentRows(equipment, [
    "item_bench",
    "item_bench_from_4357",
    "confirmed_inventory",
    "inventory",
    "effective_item_bench",
  ]).filter((row) => belongsToMatch(row, matchSessionId));
  const equipped = collectEquipmentRows(equipment, [
    "equipped_items",
    "trusted_equipped_items_from_4356_assignment",
    "confirmed_equipped_items",
    "effective_equipped_items",
  ]).filter((row) => belongsToMatch(row, matchSessionId));
  const confirmedHolders = equipped.filter((item) => item?.owner_unit || item?.unit_name || item?.owner_name);
  const stage = String(stageRound || "");
  const stageNumber = finite(stage.split("-")[0]);
  return {
    schema: "jcc-cruise-match-feature-projection-v1",
    identity: {
      core_profile_id: semanticFeatureIndex?.identity?.core_profile_id || null,
      match_session_id: matchSessionId || null,
    },
    tempo: {
      stage_round: stage || null,
      stage_band: stageNumber === null ? "unknown" : stageNumber <= 2 ? "early" : stageNumber <= 4 ? "mid" : "late",
    },
    survival: {
      hp: finite(economy.hp),
      pressure: hpPressure(economy.hp),
    },
    economy: {
      gold: finite(economy.gold),
      level: finite(economy.level),
      xp: economy.xp ?? null,
    },
    board: {
      board_unit_count: boardUnits.length,
      bench_unit_count: benchUnits.length,
      shop_unit_count: shopUnits.length,
      role_coverage: roleCoverage,
      star_summary: starSummary,
      semantic_features: uniqueStrings(boardFeatures).slice(0, 32),
      active_trait_count: asArray(currentBoardShopBench.active_traits).length,
      policy: "Verified own-board features only; shop is opportunity evidence and has zero board commitment weight.",
    },
    equipment: {
      item_bench_count: itemBench.length,
      equipped_item_count: equipped.length,
      confirmed_holder_count: confirmedHolders.length,
      unassigned_item_count: itemBench.length,
    },
  };
}

function augmentProfileForChoice(choice, profiles) {
  const ids = [choice?.selected_id, choice?.candidate_ref, choice?.augment_id, choice?.id]
    .filter((value) => value !== null && value !== undefined).map(String);
  for (const id of ids) if (profiles?.by_id?.[id]) return profiles.by_id[id];
  const name = normalizeName(choice?.selected || choice?.selected_name || choice?.name);
  return name ? profiles?.by_name?.[name] || profiles?.by_name?.[choice?.selected] || null : null;
}

function choiceIsAugment(choice) {
  return /augment|强化|海克斯/iu.test(String(choice?.kind || choice?.mode || choice?.choice_kind || ""));
}

function availableEffectContext({ projection, combatCapContext, targetContextAuthority, confirmedChoices }) {
  return new Set([
    projection.survival.hp !== null ? "hp" : null,
    projection.economy.gold !== null ? "gold" : null,
    projection.economy.level !== null ? "level" : null,
    projection.board.board_unit_count > 0 ? "owned_units" : null,
    projection.equipment.item_bench_count + projection.equipment.equipped_item_count > 0 ? "item_state" : null,
    targetContextAuthority && targetContextAuthority !== "none" ? "candidate_lineup_context" : null,
    confirmedChoices.length ? "selected_augment_count" : null,
    projection.tempo.stage_round ? "stage_round" : null,
    combatCapContext?.board_power_score !== null && combatCapContext?.board_power_score !== undefined ? "board_power_score" : null,
  ].filter(Boolean));
}

function semanticEffectEntry({ kind, value, lookup, index, matchSessionId, metadata = {} }) {
  if (!belongsToMatch(value, matchSessionId)) return null;
  const row = semanticEntity(kind, value, lookup);
  const sourceName = typeof value === "object"
    ? value?.name || value?.item_name || value?.trait_name || null
    : String(value || "").trim() || null;
  if (!row) {
    return {
      effect_id: `${kind}:${normalizeName(sourceName) || index}`,
      source_kind: kind,
      source_id: typeof value === "object" ? value?.id || value?.item_id || value?.trait_id || null : null,
      source_name: sourceName,
      resolution_status: "unresolved_current_core_profile",
      lifecycle_state: "unresolved",
      applicability_status: "unresolved",
      features: [],
      required_context_fields: [],
      missing_context_fields: [],
      ...metadata,
      policy: { no_name_guessing: true, no_foreign_core_fallback: true, match_scoped_only: true },
    };
  }
  return {
    effect_id: `${kind}:${row.entity_id || index}`,
    source_kind: kind,
    source_id: row.entity_id || null,
    source_name: row.name || sourceName,
    resolution_status: "resolved_active_core_profile",
    lifecycle_state: "active",
    applicability_status: "applicable",
    features: uniqueStrings(row.features),
    required_context_fields: [],
    missing_context_fields: [],
    ...metadata,
    policy: { exact_values_require_typed_core_effect: true, match_scoped_only: true },
  };
}

export function buildActiveEffectLedger({
  confirmedChoices = [],
  augmentSemanticProfiles = {},
  semanticFeatureIndex = {},
  projection,
  equipment = {},
  combatCapContext = {},
  activeTraits = [],
  matchSessionId = null,
  targetContextAuthority = "none",
}) {
  const augmentChoices = asArray(confirmedChoices)
    .filter((choice) => belongsToMatch(choice, matchSessionId))
    .filter(choiceIsAugment);
  const lookup = entityLookup(semanticFeatureIndex);
  const available = availableEffectContext({
    projection,
    combatCapContext,
    targetContextAuthority,
    confirmedChoices: augmentChoices,
  });
  const augmentEffects = augmentChoices.map((choice, index) => {
    const profile = augmentProfileForChoice(choice, augmentSemanticProfiles);
    const features = uniqueStrings(profile?.features);
    const selectedName = choice?.selected || choice?.selected_name || choice?.name || profile?.name || null;
    if (!profile) {
      return {
        effect_id: `augment:${choice?.selected_id || normalizeName(selectedName) || index}`,
        source_kind: "augment",
        source_id: choice?.selected_id || null,
        source_name: selectedName,
        resolution_status: "unresolved_current_core_profile",
        lifecycle_state: "unresolved",
        applicability_status: "unresolved",
        features: [],
        required_context_fields: [],
        missing_context_fields: [],
        policy: { no_name_guessing: true, no_foreign_core_fallback: true },
      };
    }
    const required = uniqueStrings(profile.required_context_fields);
    const explicitRemainingRounds = finite(choice?.remaining_rounds);
    const rawExplicitLifecycle = String(choice?.effect_lifecycle_state || choice?.lifecycle_state || "").trim();
    const explicitLifecycle = AUGMENT_LIFECYCLE_STATES.has(rawExplicitLifecycle)
      ? rawExplicitLifecycle
      : null;
    const isDelayed = features.includes("delivery.delayed") || features.includes("delivery.milestone");
    const lifecycle = explicitLifecycle
      || (explicitRemainingRounds === 0 ? "resolved" : explicitRemainingRounds > 0 ? "pending" : null)
      || (isDelayed ? "unresolved"
        : features.includes("delivery.recurring") || features.includes("delivery.permanent") ? "active" : "applied_or_active");
    const missingContextFields = required.filter((field) => !available.has(field));
    return {
      effect_id: `augment:${profile.augment_id || choice?.selected_id || index}`,
      source_kind: "augment",
      source_id: profile.augment_id || choice?.selected_id || null,
      source_name: profile.name || selectedName,
      confirmed_at_stage: choice?.stage_round || null,
      resolution_status: "resolved_active_core_profile",
      lifecycle_state: lifecycle,
      applicability_status: lifecycle === "pending"
        ? "pending_typed_match_lifecycle"
        : lifecycle === "resolved" || lifecycle === "expired" ? "inactive"
          : lifecycle === "unresolved" ? "unresolved_lifecycle"
        : missingContextFields.length ? "missing_required_context" : "applicable",
      category_ids: uniqueStrings(profile.category_ids),
      features,
      required_context_fields: required,
      missing_context_fields: missingContextFields,
      explicit_remaining_rounds: explicitRemainingRounds,
      policy: {
        exact_values_require_typed_core_effect: true,
        no_invented_countdown_or_reward: true,
        match_scoped_only: true,
      },
    };
  });
  const equipped = collectEquipmentRows(equipment, [
    "equipped_items",
    "trusted_equipped_items_from_4356_assignment",
    "confirmed_equipped_items",
    "effective_equipped_items",
  ]);
  const itemEffects = equipped.map((item, index) => semanticEffectEntry({
    kind: "item",
    value: item,
    lookup,
    index,
    matchSessionId,
    metadata: {
      holder: item?.owner_unit || item?.unit_name || item?.owner_name || null,
    },
  })).filter(Boolean);
  const traitEffects = asArray(activeTraits).map((trait, index) => semanticEffectEntry({
    kind: "trait",
    value: trait,
    lookup,
    index,
    matchSessionId,
    metadata: {
      active_count: finite(trait?.count ?? trait?.value ?? trait?.tier_count),
    },
  })).filter(Boolean);
  return [...augmentEffects, ...itemEffects, ...traitEffects];
}

function confidenceValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === "high") return 0.9;
  if (value === "medium") return 0.7;
  if (value === "low") return 0.45;
  return null;
}

function economyActionOptions(context, pressure) {
  return asArray(context?.actions).map((action, index) => ({
    action_id: `economy:${action?.action || index}`,
    route: "economy",
    action: action?.action || "unknown_economy_action",
    source: "economic_decision_context",
    priority_band: pressure === "critical" || pressure === "danger"
      ? action?.action === "roll_to_stabilize" ? "urgent" : "normal"
      : "normal",
    confidence: confidenceValue(action?.confidence),
    route_local_score: finite(action?.score),
    expected_values: {
      gold_cost: finite(action?.gold_cost),
      gold_after: finite(action?.gold_after),
      interest_after: finite(action?.interest_after),
      interest_loss: finite(action?.interest_loss),
      roll_budget: finite(action?.roll_budget),
    },
    evidence: asArray(action?.evidence).slice(0, 5),
    requires_host_judgement: true,
  }));
}

function lineupActionOption(packet, pressure) {
  const action = packet?.best_current_posture;
  if (!action) return null;
  return {
    action_id: `lineup_execution:${action}`,
    route: "lineup_execution",
    action,
    source: "strategy_fit_packet",
    priority_band: (pressure === "critical" || pressure === "danger") && action === "stabilize" ? "urgent" : "high",
    confidence: null,
    evidence: asArray(packet?.candidate_lines).slice(0, 2).map((line) => ({
      line: line?.line || null,
      combined_fit_score: finite(line?.combined_fit_score),
    })),
    requires_host_judgement: true,
  };
}

function delayedEffectActionOption(ledger, pressure) {
  if (!(pressure === "critical" || pressure === "danger")) return null;
  const delayed = ledger.filter((entry) => entry.lifecycle_state === "pending" && entry.applicability_status === "pending_typed_match_lifecycle");
  if (!delayed.length) return null;
  return {
    action_id: "active_effect_management:protect_delayed_payout",
    route: "active_effect_management",
    action: "protect_delayed_payout",
    source: "active_effect_ledger",
    priority_band: "high",
    confidence: delayed.every((entry) => entry.resolution_status === "resolved_active_core_profile") ? 0.8 : 0.4,
    evidence: delayed.slice(0, 3).map((entry) => ({
      source_id: entry.source_id,
      source_name: entry.source_name,
      lifecycle_state: entry.lifecycle_state,
      missing_context_fields: entry.missing_context_fields,
    })),
    requires_host_judgement: true,
  };
}

const PRIORITY_ORDER = Object.freeze({ urgent: 0, high: 1, normal: 2, low: 3 });
const CANONICAL_ACTIONS = Object.freeze({
  hold_gold_interest: { operation: "hold_economy", conflict_domain: "economy_posture" },
  roll_to_stabilize: { operation: "stabilize_board", conflict_domain: "economy_posture" },
  stabilize: { operation: "stabilize_board", conflict_domain: "economy_posture" },
  protect_delayed_payout: { operation: "protect_pending_payout", conflict_domain: "payout_management" },
});

function sortActionOptions(options) {
  const survivalActions = new Set(["stabilize", "roll_to_stabilize"]);
  return options.filter(Boolean).sort((left, right) => (
    (PRIORITY_ORDER[left.priority_band] ?? 9) - (PRIORITY_ORDER[right.priority_band] ?? 9)
    || Number(survivalActions.has(right.action)) - Number(survivalActions.has(left.action))
    || String(left.action_id).localeCompare(String(right.action_id))
  )).slice(0, 8);
}

function normalizeActionOptions(options, snapshotId) {
  const merged = new Map();
  for (const option of sortActionOptions(options)) {
    const canonical = CANONICAL_ACTIONS[option.action] || {
      operation: String(option.action || "unknown_action"),
      conflict_domain: String(option.route || "general"),
    };
    const key = `${canonical.conflict_domain}:${canonical.operation}`;
    const existing = merged.get(key);
    const normalized = {
      ...option,
      action_id: key,
      operation: canonical.operation,
      conflict_domain: canonical.conflict_domain,
      snapshot_id: snapshotId,
      contributing_routes: uniqueStrings(option.route),
      source_actions: uniqueStrings(option.action),
      route_evidence: [{
        route: option.route,
        confidence: option.confidence,
        route_local_score: option.route_local_score,
      }],
    };
    if (!existing) {
      merged.set(key, normalized);
      continue;
    }
    existing.contributing_routes = uniqueStrings([...existing.contributing_routes, option.route]);
    existing.source_actions = uniqueStrings([...existing.source_actions, option.action]);
    existing.evidence = [...asArray(existing.evidence), ...asArray(option.evidence)].slice(0, 6);
    existing.route_evidence.push({
      route: option.route,
      confidence: option.confidence,
      route_local_score: option.route_local_score,
    });
    existing.confidence = null;
    existing.route_local_score = null;
    if ((PRIORITY_ORDER[option.priority_band] ?? 9) < (PRIORITY_ORDER[existing.priority_band] ?? 9)) {
      existing.priority_band = option.priority_band;
    }
  }
  return [...merged.values()].sort((left, right) => (
    (PRIORITY_ORDER[left.priority_band] ?? 9) - (PRIORITY_ORDER[right.priority_band] ?? 9)
    || String(left.action_id).localeCompare(String(right.action_id))
  ));
}

function actionDecisionRank(option, projection) {
  const pressure = projection.survival.pressure;
  const survivalPressure = pressure === "critical" || pressure === "danger";
  const hardConstraint = survivalPressure && option.operation === "stabilize_board"
    ? 3
    : survivalPressure && option.operation === "hold_economy" ? -2 : 0;
  return [
    hardConstraint,
    9 - (PRIORITY_ORDER[option.priority_band] ?? 9),
  ];
}

function compareDecisionRank(left, right, projection) {
  const leftRank = actionDecisionRank(left, projection);
  const rightRank = actionDecisionRank(right, projection);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) return rightRank[index] - leftRank[index];
  }
  return String(left.action_id).localeCompare(String(right.action_id));
}

function resolveActionPlan(options, projection) {
  const selected = [];
  const suppressed = [];
  const byDomain = new Map();
  for (const option of options) {
    if (!byDomain.has(option.conflict_domain)) byDomain.set(option.conflict_domain, []);
    byDomain.get(option.conflict_domain).push(option);
  }
  for (const [conflictDomain, rows] of byDomain) {
    const ranked = [...rows].sort((left, right) => compareDecisionRank(left, right, projection));
    selected.push(ranked[0]);
    for (const row of ranked.slice(1)) {
      suppressed.push({
        action_id: row.action_id,
        operation: row.operation,
        conflict_domain: conflictDomain,
        suppressed_by: ranked[0].action_id,
        reason: "lower_deterministic_conflict_rank",
        contributing_routes: row.contributing_routes,
      });
    }
  }
  selected.sort((left, right) => compareDecisionRank(left, right, projection));
  suppressed.sort((left, right) => String(left.action_id).localeCompare(String(right.action_id)));
  return { selected_actions: selected.slice(0, 6), suppressed_actions: suppressed.slice(0, 6) };
}

function detectConflicts({ ledger, projection, economicDecisionContext, strategyFitPacket }) {
  const conflicts = [];
  const pressure = projection.survival.pressure;
  const delayed = ledger.some((entry) => entry.features.includes("delivery.delayed") || entry.features.includes("risk.delayed_payout"));
  if (delayed && (pressure === "critical" || pressure === "danger")) {
    conflicts.push({
      kind: "delayed_payout_under_survival_pressure",
      severity: "high",
      routes: ["active_effect_management", "board_stabilization", "economy"],
      host_judgement: "Balance payout preservation against spending enough to survive; do not infer an intentional loss streak.",
    });
  }
  if ((pressure === "critical" || pressure === "danger")
    && economicDecisionContext?.heuristic_top_candidate?.action === "hold_gold_interest"
    && strategyFitPacket?.best_current_posture === "stabilize") {
    conflicts.push({
      kind: "interest_hold_conflicts_with_stabilization",
      severity: "high",
      routes: ["economy", "lineup_execution"],
      host_judgement: "Reconcile exact stabilization cost, board upgrade quality, and remaining economy before choosing an action.",
    });
  }
  return conflicts;
}

function collectMissingFacts(ledger, economicDecisionContext) {
  const rows = [];
  for (const effect of ledger) {
    if (effect.resolution_status !== "resolved_active_core_profile") {
      rows.push({ field: "confirmed_choice_profile", reason: `Unresolved confirmed effect: ${effect.source_name || effect.source_id || "unknown"}` });
    }
    for (const field of effect.missing_context_fields) rows.push({ field, reason: `Required by ${effect.source_name || effect.source_id}` });
  }
  for (const missing of asArray(economicDecisionContext?.missing_decision_facts)) {
    rows.push({ field: missing?.field || "economy_context", reason: missing?.reason || "Missing economy decision fact" });
  }
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.field}:${row.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

function assertFramework(framework, orchestrationContract) {
  if (framework?.logical_id !== "common.cruise_decision_framework" || framework?.season_neutral !== true) {
    throw new Error("Cruise decision orchestration requires the season-neutral Common vocabulary");
  }
  if (orchestrationContract?.runtime_implementation !== "ui/electron/cruise-decision-orchestrator.js") {
    throw new Error("Cruise decision orchestration requires the registered Runtime product contract");
  }
}

export function buildCruiseIntegratedDecision({
  framework,
  orchestrationContract,
  semanticFeatureIndex = {},
  augmentSemanticProfiles = {},
  matchSessionId = null,
  stageRound = null,
  economy = {},
  currentBoardShopBench = {},
  equipment = {},
  combatCapContext = {},
  confirmedChoices = [],
  economicDecisionContext = null,
  strategyFitPacket = null,
  targetContextAuthority = "none",
}) {
  assertFramework(framework, orchestrationContract);
  const projection = buildCruiseMatchFeatureProjection({
    semanticFeatureIndex,
    matchSessionId,
    stageRound,
    economy,
    currentBoardShopBench,
    equipment,
    combatCapContext,
  });
  const ledger = buildActiveEffectLedger({
    confirmedChoices,
    augmentSemanticProfiles,
    semanticFeatureIndex,
    projection,
    equipment,
    combatCapContext,
    activeTraits: currentBoardShopBench.active_traits,
    matchSessionId,
    targetContextAuthority,
  });
  const pressure = projection.survival.pressure;
  const snapshotIdentity = {
    match_session_id: matchSessionId || null,
    core_profile_id: projection.identity.core_profile_id,
    stage_round: projection.tempo.stage_round,
    fact_fingerprint: stableHash({
      projection,
      effects: ledger.map((entry) => [entry.effect_id, entry.resolution_status, entry.lifecycle_state, entry.applicability_status]),
      target_context_authority: targetContextAuthority,
    }),
  };
  const snapshotId = stableHash(snapshotIdentity);
  const normalizedOptions = normalizeActionOptions([
    ...economyActionOptions(economicDecisionContext, pressure),
    lineupActionOption(strategyFitPacket, pressure),
    delayedEffectActionOption(ledger, pressure),
  ], snapshotId);
  const decisionPlan = resolveActionPlan(normalizedOptions, projection);
  const conflicts = detectConflicts({ ledger, projection, economicDecisionContext, strategyFitPacket });
  for (const suppressed of decisionPlan.suppressed_actions) {
    conflicts.push({
      kind: "mutually_exclusive_actions",
      severity: "high",
      conflict_domain: suppressed.conflict_domain,
      selected_action_id: suppressed.suppressed_by,
      suppressed_action_id: suppressed.action_id,
      resolution: suppressed.reason,
    });
  }
  const applicableEffectFeatures = uniqueStrings(ledger
    .filter((entry) => entry.applicability_status === "applicable")
    .flatMap((entry) => entry.features));
  const evidencePacket = {
    schema: "jcc-cruise-integrated-evidence-packet-v1",
    snapshot_identity: { ...snapshotIdentity, snapshot_id: snapshotId },
    active_effect_refs: ledger.slice(0, 8).map((entry) => ({
      effect_id: entry.effect_id,
      applicability_status: entry.applicability_status,
    })),
    contributing_route_ids: uniqueStrings(normalizedOptions.flatMap((option) => option.contributing_routes)).slice(0, 8),
    selected_actions: decisionPlan.selected_actions.slice(0, 4).map((option) => ({
      action_id: option.action_id,
      operation: option.operation,
      conflict_domain: option.conflict_domain,
      priority_band: option.priority_band,
      contributing_routes: option.contributing_routes,
    })),
    suppressed_actions: decisionPlan.suppressed_actions.slice(0, 4),
  };
  return {
    schema: OUTPUT_SCHEMA,
    authority: {
      final_answer_owner: "host_cli_agent",
      deterministic_output_role: "structured_decision_evidence_only",
      typed_facts_remain_authoritative: true,
      common_doctrine_remains_required: true,
    },
    feature_projection: projection,
    resolved_snapshot_identity: { ...snapshotIdentity, snapshot_id: snapshotId },
    active_effect_ledger: ledger,
    effective_feature_overlays: applicableEffectFeatures.slice(0, 40),
    relevant_domains: uniqueStrings(normalizedOptions.flatMap((option) => option.contributing_routes)),
    action_options: decisionPlan.selected_actions,
    decision_plan: decisionPlan,
    conflicts,
    missing_facts: collectMissingFacts(ledger, economicDecisionContext),
    evidence_packet: evidencePacket,
    host_synthesis: {
      max_visible_actions: 2,
      policy: "Resolve hard constraints and current survival first, then use Common doctrine and route evidence to explain one coherent action. Do not copy a route-local score as the final answer.",
    },
    policy: {
      no_sixth_lineup_score_channel: true,
      route_local_scores_are_not_cross_route_comparable: true,
      run_only_relevant_domain_evaluators: true,
      no_model_call_per_evaluator: true,
      single_host_answer: true,
      match_scoped_transient_only: true,
      no_season_entity_special_cases: true,
    },
  };
}

export const CRUISE_INTEGRATED_DECISION_SCHEMA = OUTPUT_SCHEMA;
