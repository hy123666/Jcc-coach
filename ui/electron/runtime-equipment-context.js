import { createHash } from "node:crypto";

const explicitOwnershipPattern = /(?:我(?:现在|目前|这会儿|这把|又)?(?:有|拿了|拿到|多了|合了|做了|出了)|我(?:现在|目前|这会儿|这把)?的(?:装备|散件|成装)|当前(?:装备|散件|成装)|装备栏(?:有|是)|散件(?:有|是)|成装(?:有|是)|更新一下(?:当前)?装备|给[\p{Script=Han}A-Za-z0-9·]{1,16}(?:带了|装了|合了)|[\p{Script=Han}A-Za-z0-9·]{1,16}(?:带了|带着|身上有|装了))/u;
const snapshotPattern = /(?:我(?:现在|目前|这会儿)?有|我(?:现在|目前|这会儿|这把)?的(?:装备|散件|成装)|当前(?:装备|散件|成装)|装备栏(?:有|是)|散件(?:有|是)|成装(?:有|是)|更新一下(?:当前)?装备)/u;
const theoryOnlyPattern = /(?:完美装备|推荐装备|应该(?:做|合|给)|该(?:做|合|给)|适合什么装备|怎么出装|缺什么装备|要什么装备|选什么装备|能合什么|要不要合|该不该合)/u;
const explicitlyEmptyEquippedPattern = /(?:没有|没|无人|没人)(?:给|穿|带|装)?(?:任何)?装备|(?:任何)?英雄(?:都)?(?:没有|没)(?:穿|带|装)装备|装备(?:都)?(?:没|没有)(?:给|穿|带|装)/u;
function normalizeText(value) {
  return String(value || "").trim();
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function uniqueBy(items, keyFor) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFor(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function itemFactKey(item) {
  return `${item?.id || item?.name || "unknown"}:${item?.owner_unit || "bench"}`;
}

function normalizedCount(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, 9) : 1;
}

function countImmediatelyBefore(text, index) {
  const prefix = text.slice(Math.max(0, index - 4), index);
  const match = prefix.match(/(?:([1-9])|([一二两三四五六七八九]))\s*(?:个|件|把)?\s*$/u);
  if (!match) return 1;
  if (match[1]) return Number(match[1]);
  return ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 })[match[2]] || 1;
}

function matchKnownOwner(segment, championNames) {
  const names = championNames
    .map(normalizeText)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const catalogOwner = names.find((name) => segment.includes(name));
  if (catalogOwner) return catalogOwner;
  const given = segment.match(/给([\p{Script=Han}A-Za-z0-9·]{1,16})(?:带了|装了|合了)/u);
  if (given?.[1]) return given[1];
  const leading = segment.match(/^([\p{Script=Han}A-Za-z0-9·]{1,16})(?:带了|带着|身上有|装了|有)/u);
  const owner = leading?.[1] || null;
  return owner && !owner.startsWith("我") ? owner : null;
}

function matchCatalogItemsInSegment(segment, catalog, { equipmentReportContext = false } = {}) {
  const matches = [];
  const occupied = [];
  const addMatch = (entry, index, matchedText, matchKind) => {
    if (index < 0) return;
    const end = index + matchedText.length;
    if (occupied.some(([left, right]) => index < right && end > left)) return;
    occupied.push([index, end]);
    matches.push({
      id: entry.id || null,
      name: entry.name,
      count: countImmediatelyBefore(segment, index),
      matched_text: matchedText,
      match_kind: matchKind,
      index,
    });
  };
  for (const entry of catalog.items) {
    if (entry.name === "战利品" && segment.includes("神秘战利品")) continue;
    let cursor = 0;
    while (cursor < segment.length) {
      const index = segment.indexOf(entry.name, cursor);
      if (index < 0) break;
      addMatch(entry, index, entry.name, "catalog_exact");
      cursor = index + entry.name.length;
    }
  }
  for (const [alias, entry] of catalog.aliases) {
    let cursor = 0;
    while (cursor < segment.length) {
      const index = segment.indexOf(alias, cursor);
      if (index < 0) break;
      const left = segment[index - 1] || "";
      const right = segment[index + alias.length] || "";
      const bounded = !/[\p{Script=Han}A-Za-z0-9]/u.test(left) && !/[\p{Script=Han}A-Za-z0-9]/u.test(right);
      const touchesRecognizedItem = occupied.some(([start, end]) => end === index || start === index + alias.length);
      if (bounded || alias.length >= 2 || (equipmentReportContext && touchesRecognizedItem)) {
        addMatch(entry, index, alias, "catalog_alias");
      }
      cursor = index + alias.length;
    }
  }
  return matches.sort((left, right) => left.index - right.index);
}

function appendFacts(existing, incoming) {
  const byKey = new Map(existing.map((item) => [itemFactKey(item), { ...item, count: normalizedCount(item.count) }]));
  for (const item of incoming) {
    const key = itemFactKey(item);
    const previous = byKey.get(key);
    byKey.set(key, previous
      ? { ...previous, ...item, count: normalizedCount(previous.count) + normalizedCount(item.count) }
      : { ...item, count: normalizedCount(item.count) });
  }
  return [...byKey.values()];
}

export function buildEquipmentCatalog(overlay = {}, entityAliasGateway = null) {
  const items = uniqueBy(Object.values(overlay?.items_by_id || {})
    .map((item) => ({
      id: normalizeText(item?.id) || null,
      name: normalizeText(item?.normalized_name || item?.name),
    }))
    .filter((item) => item.name), (item) => `${item.id || ""}:${item.name}`)
    .sort((left, right) => right.name.length - left.name.length || left.name.localeCompare(right.name, "zh-Hans-CN"));
  const byName = new Map(items.map((item) => [item.name, item]));
  const byId = new Map(items.map((item) => [String(item.id || ""), item]).filter(([id]) => id));
  const aliases = new Map();
  const ambiguousAliases = new Set();
  for (const gatewayEntry of Object.values(entityAliasGateway?.lookup || {})) {
    for (const ref of Array.isArray(gatewayEntry?.r) ? gatewayEntry.r : []) {
      if (ref?.entity_kind !== "item" || ref?.alias_class !== "player_alias") continue;
      const alias = normalizeText(ref.alias);
      const item = byId.get(String(ref.entity_id || "")) || byName.get(normalizeText(ref.entity_name));
      if (!alias || !item || ambiguousAliases.has(alias)) continue;
      const existing = aliases.get(alias);
      if (existing && existing !== item) {
        aliases.delete(alias);
        ambiguousAliases.add(alias);
        continue;
      }
      aliases.set(alias, item);
    }
  }
  return { items, by_name: byName, aliases };
}

export function extractUserConfirmedEquipment(text, {
  catalog,
  championNames = [],
  allowTerseReport = false,
} = {}) {
  const raw = normalizeText(text);
  if (!raw || !catalog?.items?.length) return null;
  const explicitlyOwned = explicitOwnershipPattern.test(raw);
  const explicitlyEmptyEquipped = explicitlyEmptyEquippedPattern.test(raw);
  if (!explicitlyOwned && theoryOnlyPattern.test(raw)) return null;
  if (!explicitlyOwned && !explicitlyEmptyEquipped && !allowTerseReport) return null;
  const itemBench = [];
  const equippedItems = [];
  const recognizedItems = [];
  for (const segment of raw.split(/[，,。；;！!？?\n]+/u).map(normalizeText).filter(Boolean)) {
    const matches = matchCatalogItemsInSegment(segment, catalog, {
      equipmentReportContext: explicitlyOwned || allowTerseReport,
    });
    if (!matches.length) continue;
    const ownerUnit = matchKnownOwner(segment, championNames);
    for (const match of matches) {
      const fact = {
        id: match.id,
        name: match.name,
        count: match.count,
        source: "user_confirmed",
        authority: "explicit_user",
        confidence: match.match_kind === "catalog_exact" ? "high" : "medium",
      };
      recognizedItems.push(fact);
      if (ownerUnit) equippedItems.push({ ...fact, owner_unit: ownerUnit });
      else itemBench.push(fact);
    }
  }
  if (!recognizedItems.length && !explicitlyEmptyEquipped) return null;
  return {
    schema: "jcc-user-confirmed-equipment-extraction-v1",
    update_kind: snapshotPattern.test(raw) || explicitlyEmptyEquipped || (!explicitlyOwned && allowTerseReport) ? "snapshot" : "delta",
    raw_text: raw.slice(0, 500),
    item_bench: itemBench,
    equipped_items: equippedItems,
    recognized_items: recognizedItems,
    confirmed_fields: {
      item_bench: itemBench.length > 0,
      equipped_items: equippedItems.length > 0 || explicitlyEmptyEquipped,
    },
    unresolved_text: [],
    source: "runtime_ui_user_message",
  };
}

export function mergeUserConfirmedEquipment(previous, extraction, {
  matchSessionId,
  stageRound = null,
  observedAt = new Date().toISOString(),
} = {}) {
  if (!extraction) return previous || null;
  const activeMatchSessionId = normalizeText(matchSessionId);
  if (!activeMatchSessionId) throw new Error("match_session_id is required for user-confirmed equipment");
  if (previous?.match_session_id && previous.match_session_id !== activeMatchSessionId) {
    throw new Error("user-confirmed equipment match_session_id mismatch");
  }
  const replaceSnapshot = extraction.update_kind === "snapshot";
  const reportedBench = extraction.confirmed_fields?.item_bench === true || extraction.item_bench.length > 0;
  const reportedEquipped = extraction.confirmed_fields?.equipped_items === true || extraction.equipped_items.length > 0;
  const previousBench = Array.isArray(previous?.item_bench) ? previous.item_bench : [];
  const previousEquipped = Array.isArray(previous?.equipped_items) ? previous.equipped_items : [];
  const itemBench = replaceSnapshot && reportedBench
    ? extraction.item_bench.map((item) => ({ ...item, count: normalizedCount(item.count) }))
    : appendFacts(previousBench, extraction.item_bench);
  let equippedItems = replaceSnapshot && reportedEquipped ? [] : previousEquipped;
  if (reportedEquipped) {
    const owners = new Set(extraction.equipped_items.map((item) => item.owner_unit).filter(Boolean));
    equippedItems = [
      ...equippedItems.filter((item) => !owners.has(item.owner_unit)),
      ...extraction.equipped_items.map((item) => ({ ...item, count: normalizedCount(item.count) })),
    ];
  }
  const event = {
    schema: "jcc-user-confirmed-equipment-event-v1",
    update_kind: extraction.update_kind,
    raw_text: extraction.raw_text,
    item_bench: extraction.item_bench,
    equipped_items: extraction.equipped_items,
    confirmed_fields: {
      item_bench: reportedBench,
      equipped_items: reportedEquipped,
    },
    stage_round: stageRound || null,
    observed_at: observedAt,
  };
  const previousConfirmedFields = previous?.confirmed_fields || {};
  const confirmedFields = {
    item_bench: previousConfirmedFields.item_bench === true || reportedBench,
    equipped_items: previousConfirmedFields.equipped_items === true || reportedEquipped,
  };
  const previousConfirmedAt = previous?.confirmed_at_by_field || {};
  return {
    schema: "jcc-user-confirmed-equipment-v1",
    match_session_id: activeMatchSessionId,
    source: "user_confirmed",
    authority: "explicit_user",
    confidence: "high",
    updated_at: observedAt,
    confirmed_at_stage: stageRound || null,
    revision: Number(previous?.revision || 0) + 1,
    item_bench: uniqueBy(itemBench, itemFactKey),
    equipped_items: uniqueBy(equippedItems, itemFactKey),
    confirmed_fields: confirmedFields,
    confirmed_at_by_field: {
      item_bench: reportedBench ? observedAt : previousConfirmedAt.item_bench || null,
      equipped_items: reportedEquipped ? observedAt : previousConfirmedAt.equipped_items || null,
    },
    latest_raw_text: extraction.raw_text,
    events: [...(Array.isArray(previous?.events) ? previous.events.slice(-11) : []), event],
  };
}

export function resolveEquipmentFactLayers({
  structuredEquipment = {},
  userConfirmedEquipment = null,
  activeMatchSessionId = null,
} = {}) {
  const normalizedActiveMatchSessionId = normalizeText(activeMatchSessionId);
  const userConfirmationMatchSessionId = normalizeText(
    userConfirmedEquipment?.match_session_id || userConfirmedEquipment?.matchSessionId,
  );
  let userConfirmationRejectionReason = null;
  if (userConfirmedEquipment) {
    if (!normalizedActiveMatchSessionId) {
      userConfirmationRejectionReason = "missing_active_match_session_id";
    } else if (!userConfirmationMatchSessionId) {
      userConfirmationRejectionReason = "missing_match_session_id";
    } else if (userConfirmationMatchSessionId !== normalizedActiveMatchSessionId) {
      userConfirmationRejectionReason = "match_session_id_mismatch";
    }
  }
  const currentMatchUserConfirmation = userConfirmationRejectionReason
    ? null
    : userConfirmedEquipment;
  const structuredBench = Array.isArray(structuredEquipment.item_bench_from_4357)
    ? structuredEquipment.item_bench_from_4357
    : [];
  const structuredEquipped = Array.isArray(structuredEquipment.trusted_equipped_items_from_4356_assignment)
    ? structuredEquipment.trusted_equipped_items_from_4356_assignment
    : [];
  const userBench = Array.isArray(currentMatchUserConfirmation?.item_bench) ? currentMatchUserConfirmation.item_bench : [];
  const userEquipped = Array.isArray(currentMatchUserConfirmation?.equipped_items) ? currentMatchUserConfirmation.equipped_items : [];
  const fallbackCandidates = Array.isArray(structuredEquipment.item_bench_candidates_fallback_only)
    ? structuredEquipment.item_bench_candidates_fallback_only
    : [];
  const sourceHealth = structuredEquipment.structured_source_health || {};
  const structuredBenchObserved = structuredBench.length > 0
    || sourceHealth.item_bench_4357?.current_payload_observed === true;
  const structuredEquippedObserved = structuredEquipped.length > 0
    || (
      sourceHealth.equipped_items_4356?.current_payload_observed === true
      && sourceHealth.equipped_items_4356?.current_payload_nonempty === false
    );
  const userConfirmedFields = currentMatchUserConfirmation?.confirmed_fields || {};
  const userBenchObserved = userConfirmedFields.item_bench === true || userBench.length > 0;
  const userEquippedObserved = userConfirmedFields.equipped_items === true || userEquipped.length > 0;
  const effectiveItemBench = structuredBenchObserved ? structuredBench : userBenchObserved ? userBench : [];
  const effectiveEquippedItems = structuredEquippedObserved ? structuredEquipped : userEquippedObserved ? userEquipped : [];
  const itemBenchSource = structuredBench.length
    ? "mumu_4357"
    : structuredBenchObserved
      ? "mumu_4357_authoritative_empty"
      : userBenchObserved
        ? "user_confirmed"
        : "unavailable";
  const equippedSource = structuredEquipped.length
    ? "trusted_mumu_4356_assignment"
    : structuredEquippedObserved
      ? "trusted_mumu_4356_authoritative_empty"
      : userEquippedObserved
        ? "user_confirmed"
        : "unavailable";
  const reliableFieldCoverage = {
    item_bench: structuredBenchObserved || userBenchObserved,
    equipped_items: structuredEquippedObserved || userEquippedObserved,
  };
  const missingReliableFields = Object.entries(reliableFieldCoverage)
    .filter(([, available]) => !available)
    .map(([field]) => field);
  const normalizedFactSet = (rows) => new Set(rows.map((item) => itemFactKey(item)));
  const fieldConflict = (structuredRows, userRows) => {
    if (!structuredRows.length || !userRows.length) return false;
    const structuredKeys = normalizedFactSet(structuredRows);
    const userKeys = normalizedFactSet(userRows);
    return structuredKeys.size !== userKeys.size || [...structuredKeys].some((key) => !userKeys.has(key));
  };
  const fieldConflicts = {
    item_bench: fieldConflict(structuredBench, userBench),
    equipped_items: fieldConflict(structuredEquipped, userEquipped),
  };
  const reliabilityByField = {
    item_bench: itemBenchSource === "unavailable"
      ? "missing"
      : fieldConflicts.item_bench
        ? "conflicting_structured_preferred"
        : itemBenchSource.endsWith("authoritative_empty")
          ? "authoritative_empty"
          : "reliable",
    equipped_items: equippedSource === "unavailable"
      ? "missing"
      : fieldConflicts.equipped_items
        ? "conflicting_structured_preferred"
        : equippedSource.endsWith("authoritative_empty")
          ? "authoritative_empty"
          : "reliable",
  };
  return {
    ...structuredEquipment,
    user_confirmed_item_bench: userBench,
    user_confirmed_equipped_items: userEquipped,
    effective_item_bench: effectiveItemBench,
    effective_equipped_items: effectiveEquippedItems,
    effective_source_by_field: {
      item_bench: itemBenchSource,
      equipped_items: equippedSource,
    },
    reliable_field_coverage: reliableFieldCoverage,
    missing_reliable_fields: missingReliableFields,
    reliability_by_field: reliabilityByField,
    field_conflicts: fieldConflicts,
    has_current_match_user_confirmation: userBenchObserved || userEquippedObserved,
    user_confirmation_match_session_id: userConfirmationMatchSessionId || null,
    user_confirmation_rejection_reason: userConfirmationRejectionReason,
    has_reliable_equipment: effectiveItemBench.length > 0 || effectiveEquippedItems.length > 0,
    has_complete_reliable_equipment: missingReliableFields.length === 0,
    needs_user_confirmation: missingReliableFields.length > 0,
    decision_readiness: missingReliableFields.length === 0
      ? "ready"
      : missingReliableFields.length === 1
        ? "partial"
        : "missing",
    resolution_policy: {
      wait_for_structured_source: false,
      wait_for_visual_candidate: false,
      use_highest_currently_available_source: true,
      ask_only_for_decision_changing_missing_fields: true,
    },
    item_bench_candidates_fallback_only: fallbackCandidates,
    visual_candidates_are_authoritative: false,
    source_precedence: ["mumu_structured", "user_confirmed", "visual_candidate_fallback"],
  };
}

function timestampWithinRecentWindow(value, windowMs, nowMs) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp)
    && timestamp <= nowMs + 5000
    && nowMs - timestamp <= windowMs;
}

export function resolveMaterialEquipmentDecisionContext({
  targetContext = null,
  latestTargetIntent = null,
  latestChoice = null,
  explicitItemDecisionRequired = false,
  recencyMs = 180000,
  nowMs = Date.now(),
} = {}) {
  if (explicitItemDecisionRequired) {
    return { required: true, reason: "registered_item_decision_event" };
  }
  const targetTimestamps = [
    latestTargetIntent?.at,
    targetContext?.latest_target_intent?.at,
    targetContext?.replacement_intent?.at,
    targetContext?.refinement_intent?.at,
    targetContext?.direction_changed_at,
    targetContext?.confirmed_at,
  ];
  if (targetTimestamps.some((value) => timestampWithinRecentWindow(value, recencyMs, nowMs))) {
    return { required: true, reason: "recent_target_direction_changed" };
  }
  const choiceTimestamp = latestChoice?.confirmed_at
    || latestChoice?.observed_at
    || latestChoice?.created_at
    || latestChoice?.at;
  if (targetContext && timestampWithinRecentWindow(choiceTimestamp, recencyMs, nowMs)) {
    return { required: true, reason: "recent_confirmed_choice_changes_target_item_fit" };
  }
  return { required: false, reason: "no_recent_material_item_decision" };
}

export function shouldRequestUserEquipmentContext({
  matchActive,
  activeMode,
  stageRound,
  responseTaskInFlight,
  choiceWindowReserved,
  observingOtherView,
  targetContext,
  confirmedChoices = [],
  equipment,
  previousPrompts = [],
  nowMs = Date.now(),
  cooldownMs = 120_000,
  maxPromptsPerMatch = 3,
  itemDecisionRequired = false,
} = {}) {
  const stageMatch = normalizeText(stageRound).match(/^(\d+)-(\d+)$/);
  const stageValue = stageMatch ? Number(stageMatch[1]) * 100 + Number(stageMatch[2]) : null;
  const targetText = normalizeText(targetContext?.text || targetContext?.summary || targetContext?.name || targetContext);
  const choiceText = confirmedChoices
    .map((entry) => normalizeText(entry?.choice || entry?.selected || entry?.name || entry))
    .filter(Boolean)
    .join("|");
  const stageBand = stageMatch ? stageMatch[1] : "unknown";
  const fingerprint = stableHash({ target: targetText, choices: choiceText, stage_band: stageBand }).slice(0, 24);
  const deny = (reason) => ({ should_prompt: false, reason, fingerprint });
  if (!matchActive) return deny("match_not_active");
  if (activeMode !== "cruise") return deny("not_cruise_mode");
  if (!Number.isFinite(stageValue) || stageValue < 201) return deny("before_item_decision_window");
  if (responseTaskInFlight) return deny("response_task_active");
  if (choiceWindowReserved) return deny("choice_window_reserved");
  if (observingOtherView) return deny("non_self_current_view");
  const missingFields = Array.isArray(equipment?.missing_reliable_fields)
    ? equipment.missing_reliable_fields
    : equipment?.has_reliable_equipment
      ? []
      : ["item_bench", "equipped_items"];
  if (!missingFields.length) return deny("complete_reliable_equipment_available");
  if (!targetText) return deny("no_target_context_for_equipment_decision");
  if (!itemDecisionRequired) return deny("no_item_dependent_decision_context");
  const prompts = Array.isArray(previousPrompts) ? previousPrompts : [];
  if (prompts.some((entry) => entry?.asked_at && !entry?.answered_at)) return deny("awaiting_user_equipment_confirmation");
  if (prompts.length >= maxPromptsPerMatch) return deny("match_prompt_budget_exhausted");
  if (prompts.some((entry) => entry?.fingerprint === fingerprint)) return deny("material_context_already_prompted");
  const latestPromptAt = Math.max(...prompts.map((entry) => Date.parse(entry?.asked_at || "")).filter(Number.isFinite), 0);
  if (latestPromptAt > 0 && nowMs - latestPromptAt < cooldownMs) return deny("prompt_cooldown");
  return {
    should_prompt: true,
    reason: missingFields.length === 1
      ? `material_item_decision_missing_${missingFields[0]}`
      : "material_item_decision_missing_equipment",
    fingerprint,
    missing_fields: missingFields,
  };
}
