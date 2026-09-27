import {
  compactDecisionInputText,
  searchDecisionInputCatalog,
} from "./decision-input-catalog.js";
import { QUICK_RECORD_TURN_MAX_BYTES } from "./jcc-host-budget-contract.js";

export const MATCH_FACT_CAPTURE_REQUEST_KIND = "match_fact_capture";
export const MATCH_FACT_CAPTURE_SCHEMA = "jcc-match-fact-capture-v1";
export const MATCH_FACT_CAPTURE_CATALOG_BUDGET_BYTES = QUICK_RECORD_TURN_MAX_BYTES;

const allowedEquipmentCategories = new Set(["components", "completed", "radiant", "support", "artifacts", "emblems", "special"]);
const equipmentCategoryAliases = new Map([
  ["component", "components"],
  ["components", "components"],
  ["散件", "components"],
  ["completed", "completed"],
  ["standard_completed", "completed"],
  ["standardcompleted", "completed"],
  ["普通装备", "completed"],
  ["成装", "completed"],
  ["普通成装", "completed"],
  ["radiant", "radiant"],
  ["光明装备", "radiant"],
  ["光明装", "radiant"],
  ["support", "support"],
  ["辅助装备", "support"],
  ["artifacts", "artifacts"],
  ["artifact", "artifacts"],
  ["神器", "artifacts"],
  ["emblems", "emblems"],
  ["emblem", "emblems"],
  ["纹章", "emblems"],
  ["转职", "emblems"],
  ["special", "special"],
  ["特殊装备", "special"],
]);

function normalizeEquipmentCategory(value) {
  const raw = String(value || "").normalize("NFKC").trim().toLowerCase();
  return equipmentCategoryAliases.get(raw) || (allowedEquipmentCategories.has(raw) ? raw : null);
}
const allowedOperations = new Set([
  "set_choice",
  "replace_equipment",
  "add_equipment",
  "remove_equipment",
  "clear_equipment",
  "assign_equipment",
  "clear_equipment_assignments",
  "set_match_variable",
]);

function boundedText(value, limit = 160) {
  return String(value || "").trim().slice(0, limit);
}

function firstArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasExplicitEquipmentFactContext(value) {
  const text = String(value || "").normalize("NFKC");
  if (/(?:装备栏|装备区|散件栏|散件|成装|神器|光明装备|辅助装备|纹章|道具栏)/u.test(text)) return true;
  if (/(?:只剩|剩下).{0,12}(?:件|个|把|装备|散件|成装)/u.test(text)) return true;
  if (/(?:给[\p{Script=Han}A-Za-z0-9·]{1,16}|[\p{Script=Han}A-Za-z0-9·]{1,16})(?:穿|带|装)(?:了|着)?/u.test(text)) return true;

  const ownership = text.match(/我(?:现在|目前|这会儿|这把)?(?:有|还有|拿到|获得|爆了|合了|做了|出了)(?<subject>.+)$/u);
  if (!ownership?.groups?.subject) return false;
  const subject = ownership.groups.subject.trim();
  if (/^\d+(?:\.\d+)?\s*%/u.test(subject)) return false;
  if (/(?:加成|属性|面板|数值|倍率|每秒)/u.test(subject)) return false;
  if (/^\d+(?:\.\d+)?\s*(?:攻速|攻击速度|法强|攻击力|护甲|魔抗|生命值?|血量|法力|回蓝)/u.test(subject)) return false;
  return true;
}

export function compactMatchFactCaptureCatalog(catalog, {
  seasonId = null,
  patchId = null,
  championNames = [],
  choiceDescriptors = [],
  manualVariableFields = [],
  queryText = null,
  aliasLimit = 320,
} = {}) {
  const entityByAddress = new Map(firstArray(catalog?.entities).map((entity) => [entity?.address, entity]));
  const entityKinds = [...new Set([
    "champion",
    "augment",
    "item",
    ...firstArray(choiceDescriptors).flatMap((descriptor) => [
      descriptor?.catalog_entity_kind,
      ...firstArray(descriptor?.related_catalog_entity_kinds),
    ]),
  ].filter(Boolean))];
  const allowedEntityKinds = new Set(entityKinds);
  const normalizedQuery = compactDecisionInputText(queryText);
  const equipmentFactContext = hasExplicitEquipmentFactContext(queryText);
  const selectedAddresses = new Set();
  if (normalizedQuery) {
    const directTerms = [];
    for (const entity of entityByAddress.values()) {
      if (!allowedEntityKinds.has(entity?.kind)) continue;
      if (entity?.kind === "item" && !equipmentFactContext) continue;
      const normalizedName = compactDecisionInputText(entity?.name);
      if (normalizedName) directTerms.push(normalizedName);
      if (normalizedName && normalizedQuery.includes(normalizedName)) selectedAddresses.add(entity.address);
    }
    for (const row of firstArray(catalog?.aliases)) {
      const entity = entityByAddress.get(row?.ref?.address);
      if (!allowedEntityKinds.has(entity?.kind)) continue;
      if (entity?.kind === "item" && !equipmentFactContext) continue;
      const normalizedAlias = compactDecisionInputText(row?.alias);
      if (normalizedAlias.length >= 2) directTerms.push(normalizedAlias);
      if (normalizedAlias.length >= 2 && normalizedQuery.includes(normalizedAlias) && entityByAddress.has(row?.ref?.address)) {
        selectedAddresses.add(row.ref.address);
      }
    }
    const fragments = String(queryText || "")
      .normalize("NFKC")
      .split(/[，。；、,;:：\s]+|(?:我选了|选了|现在装备是|装备是|我还有|还有|只剩下|只剩|给了|穿了)/u)
      .map((fragment) => fragment.trim())
      .filter((fragment) => fragment.length >= 2 && fragment.length <= 48)
      .slice(0, 24);
    for (const fragment of fragments) {
      const normalizedFragment = compactDecisionInputText(fragment);
      if (directTerms.some((term) => normalizedFragment.includes(term))) continue;
      const matches = searchDecisionInputCatalog(catalog, {
        query: fragment,
        searchScope: "global_search",
        includeUnknownRound: true,
        limit: 12,
      });
      for (const match of matches.filter((entry) => (
        allowedEntityKinds.has(entry?.entity?.kind)
        && (entry?.entity?.kind !== "item" || equipmentFactContext)
        && Number(entry?.score || 0) > 58
      )).slice(0, 3)) {
        if (match?.entity?.address) selectedAddresses.add(match.entity.address);
      }
    }
  }
  const selectedEntities = firstArray(catalog?.entities).filter((entity) => (
    !normalizedQuery || selectedAddresses.has(entity.address)
  ));
  const entities = Object.fromEntries(entityKinds.map((kind) => [
    kind,
    selectedEntities.filter((entity) => entity.kind === kind).slice(0, kind === "champion" ? 96 : 64).map((entity) => ({
      name: entity.name,
      ...(kind === "augment" ? { rounds: firstArray(entity.rounds), tier_color: entity.tier_color || null } : {}),
      ...(kind === "item" ? { category: entity.item_category || null } : {}),
      ...(entity.stage_num != null ? { stage_num: entity.stage_num } : {}),
    })),
  ]));
  const aliases = firstArray(catalog?.aliases).map((row) => {
    const entity = entityByAddress.get(row?.ref?.address);
    if (!row?.alias || !entity?.name) return null;
    if (!allowedEntityKinds.has(entity.kind)) return null;
    if (normalizedQuery && !selectedAddresses.has(entity.address)) return null;
    if (compactDecisionInputText(row.alias) === compactDecisionInputText(entity.name)) return null;
    return {
      alias: row.alias,
      canonical_name: entity.name,
      kind: entity.kind,
      evidence_kind: row.evidence_kind || null,
      auto_confirm: row.auto_confirm === true,
      query_match: Boolean(normalizedQuery && normalizedQuery.includes(compactDecisionInputText(row.alias))),
      entity_address: entity.address,
    };
  }).filter(Boolean).sort((left, right) => (
    Number(right.query_match) - Number(left.query_match)
    || Number(right.auto_confirm) - Number(left.auto_confirm)
    || String(left.alias).length - String(right.alias).length
  ));
  const uniqueAliases = [];
  const seenAliasIdentity = new Set();
  const aliasCountByEntity = new Map();
  for (const row of aliases) {
    const identity = `${row.kind}|${compactDecisionInputText(row.alias)}|${row.canonical_name}`;
    if (seenAliasIdentity.has(identity)) continue;
    const entityAliasCount = aliasCountByEntity.get(row.entity_address) || 0;
    if (normalizedQuery && entityAliasCount >= 6) continue;
    seenAliasIdentity.add(identity);
    aliasCountByEntity.set(row.entity_address, entityAliasCount + 1);
    uniqueAliases.push({
      alias: row.alias,
      canonical_name: row.canonical_name,
      kind: row.kind,
      evidence_kind: row.evidence_kind,
      auto_confirm: row.auto_confirm,
    });
    if (uniqueAliases.length >= aliasLimit) break;
  }
  const compact = {
    season_id: catalog?.source_identity?.season_id || seasonId,
    patch_id: catalog?.source_identity?.active_patch_id || patchId,
    choice_descriptors: firstArray(choiceDescriptors),
    champion_names: firstArray(championNames),
    entities,
    aliases: uniqueAliases,
    manual_variable_fields: firstArray(manualVariableFields).map((field) => ({
      key: field.key,
      label: field.label,
      control: field.control,
      aliases: firstArray(field.aliases),
      options: firstArray(field.options).map((option) => option.name || option.label || option.id).filter(Boolean),
    })),
  };
  const serializedBytes = Buffer.byteLength(JSON.stringify(compact));
  if (serializedBytes > MATCH_FACT_CAPTURE_CATALOG_BUDGET_BYTES) {
    throw new Error(`match fact capture catalog exceeds ${MATCH_FACT_CAPTURE_CATALOG_BUDGET_BYTES} bytes: ${serializedBytes}`);
  }
  return compact;
}

function normalizeStageRound(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/[—–－_]/g, "-")
    .replace(/\s+/g, "");
  return /^\d+-\d+$/.test(normalized) ? normalized : null;
}

function normalizeQuantity(value, { defaultWhenMissing = false } = {}) {
  if (value === undefined && defaultWhenMissing) return 1;
  const quantity = Number(value);
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= 20 ? quantity : null;
}

function normalizeCaptureItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { item: null, unresolved: { input_text: "未识别装备条目", reason: "invalid_equipment_item" } };
  }
  const entityName = boundedText(
    value.entity_name
      || value.entityName
      || value.item_name
      || value.itemName
      || value.equipment_name
      || value.equipmentName
      || value.artifact_name
      || value.artifactName
      || value.name
      || value.display_name
      || value.displayName,
  );
  if (!entityName) {
    return { item: null, unresolved: { input_text: operationInputText(value), reason: "missing_equipment_name" } };
  }
  const quantity = normalizeQuantity(value.quantity, { defaultWhenMissing: !Object.hasOwn(value, "quantity") });
  if (quantity === null) {
    return { item: null, unresolved: { input_text: entityName, reason: "invalid_equipment_quantity" } };
  }
  return { item: {
    entity_name: entityName,
    quantity,
  }, unresolved: null };
}

function operationInputText(value) {
  return boundedText(
    value?.input_text
      || value?.entity_name
      || value?.entityName
      || value?.choice_name
      || value?.choiceName
      || value?.augment_name
      || value?.augmentName
      || value?.trait_name
      || value?.traitName
      || value?.selection_name
      || value?.selectionName
      || value?.item_name
      || value?.itemName
      || value?.equipment_name
      || value?.equipmentName
      || value?.artifact_name
      || value?.artifactName
      || value?.champion_name
      || value?.championName
      || value?.holder_name
      || value?.holderName
      || value?.field_key
      || value?.field_label
      || value?.op
      || value?.operation,
    240,
  ) || "未识别操作";
}

function normalizeOperation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      operation: null,
      unresolved: { input_text: "未识别操作", reason: "invalid_operation_shape" },
    };
  }
  const declaredOperation = boundedText(
    value.op || value.operation || value.operation_type || value.type,
    48,
  ).toLowerCase();
  const hasDeclaredOperation = ["op", "operation", "operation_type", "type"]
    .some((key) => Object.hasOwn(value, key) && String(value[key] || "").trim());
  const equipmentAction = boundedText(value.equipment_action || value.equipmentAction || value.action, 24).toLowerCase();
  const championName = value.champion_name
    || value.championName
    || value.holder_name
    || value.holderName
    || value.unit_name
    || value.unitName
    || value.hero_name
    || value.heroName
    || value.carrier_name
    || value.carrierName;
  const itemName = value.item_name
    || value.itemName
    || value.equipment_name
    || value.equipmentName
    || value.artifact_name
    || value.artifactName
    || value.entity_name
    || value.entityName;
  const choiceKind = value.choice_kind || value.choiceKind;
  const stageRound = value.stage_round || value.stageRound;
  const choiceName = value.entity_name
    || value.entityName
    || value.choice_name
    || value.choiceName
    || value.augment_name
    || value.augmentName
    || value.trait_name
    || value.traitName
    || value.selection_name
    || value.selectionName
    || value.name;
  const inferredOperation = choiceKind && stageRound && choiceName
    ? "set_choice"
    : championName && itemName
      ? "assign_equipment"
      : (value.field_key || value.field_label) && Object.hasOwn(value, "value")
        ? "set_match_variable"
        : Array.isArray(value.items) && ["replace", "add", "remove"].includes(equipmentAction)
          ? `${equipmentAction}_equipment`
          : null;
  const op = allowedOperations.has(declaredOperation)
    ? declaredOperation
    : (hasDeclaredOperation ? declaredOperation : inferredOperation);
  if (!allowedOperations.has(op)) {
    return {
      operation: null,
      unresolved: {
        input_text: operationInputText(value),
        reason: op ? "unsupported_operation" : "missing_operation_name",
      },
    };
  }
  if (["replace_equipment", "add_equipment", "remove_equipment"].includes(op)) {
    const category = normalizeEquipmentCategory(value.category || value.item_category || value.item_type);
    if (value.category || value.item_category || value.item_type) {
      if (!category) {
        return {
          operation: null,
          unresolved: { input_text: operationInputText(value), reason: "unsupported_equipment_category" },
        };
      }
    }
    const itemValues = Array.isArray(value.items || value.equipment || value.equipped_items)
      ? (value.items || value.equipment || value.equipped_items).slice(0, 32)
      : [];
    const itemResults = itemValues.map(normalizeCaptureItem);
    const itemUnresolved = itemResults.map((entry) => entry.unresolved).filter(Boolean);
    if (!Array.isArray(value.items || value.equipment || value.equipped_items)) {
      itemUnresolved.push({ input_text: operationInputText(value), reason: "equipment_items_not_array" });
    } else if (!(value.items || value.equipment || value.equipped_items).length
      && !(op === "replace_equipment" && category)) {
      itemUnresolved.push({ input_text: operationInputText(value), reason: "equipment_items_empty" });
    }
    return { operation: {
      op,
      category: category || null,
      items: itemResults.map((entry) => entry.item).filter(Boolean),
      item_unresolved: itemUnresolved,
      input_text: boundedText(value.input_text, 240) || null,
    }, unresolved: null };
  }
  if (op === "clear_equipment") {
    const category = normalizeEquipmentCategory(value.category || value.item_category || value.item_type);
    if (!allowedEquipmentCategories.has(category)) {
      return {
        operation: null,
        unresolved: {
          input_text: operationInputText(value),
          reason: category ? "unsupported_equipment_category" : "missing_equipment_category",
        },
      };
    }
    return { operation: { op, category, input_text: boundedText(value.input_text, 240) || null }, unresolved: null };
  }
  if (op === "assign_equipment") {
    const quantity = normalizeQuantity(value.quantity, { defaultWhenMissing: !Object.hasOwn(value, "quantity") });
    return { operation: {
      op,
      champion_name: boundedText(championName),
      item_name: boundedText(itemName),
      quantity,
      quantity_invalid: quantity === null,
      holder_intent: value.holder_intent === "temporary" ? "temporary" : "unspecified",
      input_text: boundedText(value.input_text, 240) || null,
    }, unresolved: null };
  }
  if (op === "clear_equipment_assignments") {
    return { operation: { op, input_text: boundedText(value.input_text, 240) || null }, unresolved: null };
  }
  if (op === "set_choice") {
    return { operation: {
      op,
      choice_kind: boundedText(choiceKind, 80).toLowerCase() || null,
      stage_round: normalizeStageRound(stageRound),
      entity_name: boundedText(choiceName),
      reward_text: boundedText(value.reward_text || value.rewardText || value.reward_name || value.rewardName, 160) || null,
      input_text: boundedText(value.input_text, 240) || null,
    }, unresolved: null };
  }
  return { operation: {
    op,
    field_key: boundedText(value.field_key || value.field_label, 80),
    value_text: boundedText(value.value_text ?? value.value, 240),
    input_text: boundedText(value.input_text, 240) || null,
  }, unresolved: null };
}

export function normalizeMatchFactCaptureResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("match fact capture response must be an object");
  }
  if (value.schema && value.schema !== MATCH_FACT_CAPTURE_SCHEMA) {
    throw new Error("match fact capture response schema mismatch");
  }
  const operationResults = firstArray(value.operations).slice(0, 32).map(normalizeOperation);
  return {
    schema: MATCH_FACT_CAPTURE_SCHEMA,
    operations: operationResults.map((entry) => entry.operation).filter(Boolean),
    unresolved: [...firstArray(value.unresolved).slice(0, 24).map((entry) => ({
      input_text: boundedText(entry?.input_text || entry?.text, 240),
      reason: boundedText(entry?.reason, 100) || "host_unresolved",
    })).filter((entry) => entry.input_text), ...operationResults.map((entry) => entry.unresolved).filter(Boolean)].slice(0, 32),
  };
}

function exactCatalogEntity(catalog, kind, text) {
  const query = boundedText(text);
  if (!query) return null;
  const normalized = compactDecisionInputText(query);
  const canonicalMatches = firstArray(catalog?.by_kind?.get?.(kind))
    .filter((entity) => compactDecisionInputText(entity?.name) === normalized);
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  const idMatches = firstArray(catalog?.by_kind?.get?.(kind))
    .filter((entity) => compactDecisionInputText(entity?.id) === normalized);
  if (idMatches.length === 1) return idMatches[0];
  const matches = searchDecisionInputCatalog(catalog, {
    query,
    kind,
    searchScope: "global_search",
    includeUnknownRound: true,
    limit: 12,
  }).filter((row) => firstArray(row?.alias_evidence).some((entry) => (
    compactDecisionInputText(entry?.matched) === normalized
      // Exact common player aliases are valid for explicit fact capture;
      // speech-like aliases remain excluded because they are not unique facts.
      && ["hard_data_alias", "canonical", "id", "player_alias"].includes(entry?.kind)
  )));
  return matches.length === 1 ? matches[0].entity : null;
}

function exactChampion(catalog, championNames, text) {
  const normalized = compactDecisionInputText(text);
  if (!normalized) return null;
  const catalogEntity = exactCatalogEntity(catalog, "champion", text);
  if (catalogEntity) return { id: catalogEntity.id, address: catalogEntity.address, name: catalogEntity.name };
  const exact = firstArray(championNames).filter((name) => compactDecisionInputText(name) === normalized);
  return exact.length === 1 ? { name: exact[0] } : null;
}

function unresolvedFor(operation, reason, extra = {}) {
  return {
    input_text: operation.input_text || operation.entity_name || operation.item_name || operation.field_key || operation.op,
    reason,
    operation: operation.op,
    ...extra,
  };
}

function resolveManualVariableField(fields, keyOrLabel) {
  const normalized = compactDecisionInputText(keyOrLabel);
  if (!normalized) return null;
  const matches = firstArray(fields).filter((field) => [field?.key, field?.label, ...(field?.aliases || [])]
    .some((value) => compactDecisionInputText(value) === normalized));
  return matches.length === 1 ? matches[0] : null;
}

function resolveManualVariableValue(field, valueText) {
  const options = firstArray(field?.options);
  if (!options.length) return boundedText(valueText, 240) || null;
  const normalized = compactDecisionInputText(valueText);
  const matches = options.filter((option) => [option?.id, option?.option_id, option?.label, option?.name, option?.value]
    .some((value) => compactDecisionInputText(value) === normalized));
  return matches.length === 1 ? matches[0] : null;
}

export function resolveMatchFactCaptureOperations(capture, {
  catalog,
  championNames = [],
  choiceDescriptors = [],
  currentStageRound = null,
  manualVariableFields = [],
} = {}) {
  const accepted = [];
  const unresolved = [...firstArray(capture?.unresolved)];
  for (const operation of firstArray(capture?.operations)) {
    if (operation.op === "set_choice") {
      const requestedKind = compactDecisionInputText(operation.choice_kind);
      const matchingDescriptors = firstArray(choiceDescriptors).filter((descriptor) => [
        descriptor?.kind,
        descriptor?.mode,
        ...firstArray(descriptor?.aliases),
      ].some((value) => compactDecisionInputText(value) === requestedKind));
      const descriptor = matchingDescriptors.length === 1 ? matchingDescriptors[0] : null;
      const kind = descriptor?.kind || null;
      const catalogKind = descriptor?.catalog_entity_kind || kind;
      const stages = firstArray(descriptor?.stages).map(normalizeStageRound).filter(Boolean);
      const stageIsLegal = stages.length
        ? stages.includes(operation.stage_round)
        : descriptor?.stage_policy === "current_verified_stage"
          && operation.stage_round === normalizeStageRound(currentStageRound);
      if (!kind || !catalogKind || !operation.stage_round || !stageIsLegal) {
        unresolved.push(unresolvedFor(operation, "choice_stage_not_registered"));
        continue;
      }
      const entity = exactCatalogEntity(catalog, catalogKind, operation.entity_name);
      if (!entity) {
        unresolved.push(unresolvedFor(operation, "choice_not_uniquely_resolved"));
        continue;
      }
      if (kind === "augment" && firstArray(entity.rounds).length && !entity.rounds.includes(operation.stage_round)) {
        unresolved.push(unresolvedFor(operation, "choice_not_legal_at_stage", { canonical_name: entity.name }));
        continue;
      }
      let rewardEntity = null;
      let rewardText = operation.reward_text || null;
      if (rewardText && descriptor.reward_validation) {
        const validation = descriptor.reward_validation;
        rewardEntity = exactCatalogEntity(catalog, validation.catalog_entity_kind || "season_reward", rewardText);
        const parentField = validation.parent_entity_field || null;
        const stageField = validation.stage_field || null;
        const expectedParentValues = [entity.name, entity.id, entity.address]
          .map((value) => compactDecisionInputText(value))
          .filter(Boolean);
        const actualParent = parentField ? compactDecisionInputText(rewardEntity?.[parentField]) : null;
        const expectedStage = validation.stage_round_values?.[operation.stage_round];
        const actualStage = stageField ? rewardEntity?.[stageField] : null;
        const parentValid = !parentField || expectedParentValues.includes(actualParent);
        const stageValid = expectedStage === undefined || String(actualStage ?? "") === String(expectedStage);
        const allowedCrossParentIds = firstArray(validation.cross_parent_choice_ids).map((value) => String(value));
        const crossParentValid = !allowedCrossParentIds.length
          || allowedCrossParentIds.includes(String(entity.id));
        if (!rewardEntity || !parentValid || !stageValid || !crossParentValid) {
          unresolved.push(unresolvedFor(operation, "choice_reward_not_legal", {
            canonical_name: entity.name,
            reward_text: rewardText,
          }));
          rewardEntity = null;
          rewardText = null;
        } else {
          rewardText = rewardEntity.name;
        }
      } else if (rewardText) {
        unresolved.push(unresolvedFor(operation, "choice_reward_not_registered", {
          canonical_name: entity.name,
          reward_text: rewardText,
        }));
        rewardText = null;
      }
      accepted.push({ ...operation, choice_kind: kind, entity, reward_text: rewardText, reward_entity: rewardEntity });
      continue;
    }
    if (["replace_equipment", "add_equipment", "remove_equipment"].includes(operation.op)) {
      const resolvedItems = [];
      let invalid = firstArray(operation.item_unresolved).length > 0;
      for (const entry of firstArray(operation.item_unresolved)) {
        unresolved.push(unresolvedFor(operation, entry.reason, { input_text: entry.input_text }));
      }
      for (const item of operation.items) {
        const entity = exactCatalogEntity(catalog, "item", item.entity_name);
        if (!entity) {
          unresolved.push(unresolvedFor(operation, "equipment_not_uniquely_resolved", { input_text: item.entity_name }));
          invalid = true;
          continue;
        }
        resolvedItems.push({ entity, quantity: item.quantity });
      }
      const itemCategories = [...new Set(resolvedItems.map((item) => item.entity.item_category).filter(Boolean))];
      const resolvedCategory = normalizeEquipmentCategory(operation.category)
        || (itemCategories.length === 1 ? itemCategories[0] : null);
      if (!allowedEquipmentCategories.has(resolvedCategory) || itemCategories.some((category) => category !== resolvedCategory)) {
        unresolved.push(unresolvedFor(operation, "equipment_category_not_resolved"));
        continue;
      }
      if (operation.op === "replace_equipment" && !invalid && !operation.items.length) {
        accepted.push({ ...operation, category: resolvedCategory, action: "clear", items: [] });
        continue;
      }
      if ((operation.op === "replace_equipment" && invalid) || !resolvedItems.length) continue;
      accepted.push({ ...operation, category: resolvedCategory, action: operation.op.split("_")[0], items: resolvedItems });
      continue;
    }
    if (operation.op === "clear_equipment") {
      accepted.push({ ...operation, action: "clear", items: [] });
      continue;
    }
    if (operation.op === "assign_equipment") {
      if (operation.quantity_invalid || operation.quantity === null) {
        unresolved.push(unresolvedFor(operation, "invalid_equipment_quantity"));
        continue;
      }
      const champion = exactChampion(catalog, championNames, operation.champion_name);
      const item = exactCatalogEntity(catalog, "item", operation.item_name);
      if (!champion) {
        unresolved.push(unresolvedFor(operation, "champion_not_uniquely_resolved"));
        continue;
      }
      if (!item) {
        unresolved.push(unresolvedFor(operation, "equipment_not_uniquely_resolved"));
        continue;
      }
      accepted.push({ ...operation, champion, item });
      continue;
    }
    if (operation.op === "clear_equipment_assignments") {
      accepted.push(operation);
      continue;
    }
    if (operation.op === "set_match_variable") {
      const field = resolveManualVariableField(manualVariableFields, operation.field_key);
      const value = field ? resolveManualVariableValue(field, operation.value_text) : null;
      if (!field || value === null) {
        unresolved.push(unresolvedFor(operation, field ? "match_variable_value_not_resolved" : "match_variable_field_not_registered"));
        continue;
      }
      accepted.push({ ...operation, field, value });
    }
  }
  return { accepted, unresolved };
}

function inventoryIdentity(entry) {
  return String(entry?.ref?.address || entry?.address || entry?.name || "");
}

function inventoryEntry(entity) {
  return {
    name: entity.name,
    ref: entity.ref || {
      kind: entity.kind,
      id: String(entity.id),
      address: entity.address,
      season_id: entity.season_id || null,
      source: entity.source || "hard_data",
    },
    item_category: entity.item_category || null,
    source: "user_confirmed_equipment",
  };
}

export function applyEquipmentInventoryMutationWithResult(previous, operation) {
  const action = operation?.action || "replace";
  if (action === "clear") return { inventory: [], appliedItems: [] };
  const incoming = firstArray(operation?.items).flatMap(({ entity, quantity }) => (
    Array.from({ length: normalizeQuantity(quantity, { defaultWhenMissing: true }) || 0 }, () => inventoryEntry(entity))
  ));
  if (action === "replace") return { inventory: incoming, appliedItems: firstArray(operation?.items) };
  if (action === "add") return { inventory: [...firstArray(previous), ...incoming], appliedItems: firstArray(operation?.items) };
  if (action !== "remove") return { inventory: firstArray(previous), appliedItems: [] };
  const next = [...firstArray(previous)];
  const appliedItems = [];
  for (const requested of firstArray(operation?.items)) {
    let removed = 0;
    for (let index = 0; index < (normalizeQuantity(requested.quantity, { defaultWhenMissing: true }) || 0); index += 1) {
      const foundIndex = next.findIndex((entry) => inventoryIdentity(entry) === inventoryIdentity(inventoryEntry(requested.entity)));
      if (foundIndex < 0) break;
      next.splice(foundIndex, 1);
      removed += 1;
    }
    if (removed) appliedItems.push({ entity: requested.entity, quantity: removed });
  }
  return { inventory: next, appliedItems };
}

export function applyEquipmentInventoryMutation(previous, operation) {
  return applyEquipmentInventoryMutationWithResult(previous, operation).inventory;
}
