import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createDecisionInputCatalog } from "../ui/electron/decision-input-catalog.js";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import {
  applyEquipmentInventoryMutation,
  applyEquipmentInventoryMutationWithResult,
  compactMatchFactCaptureCatalog,
  MATCH_FACT_CAPTURE_CATALOG_BUDGET_BYTES,
  normalizeMatchFactCaptureResponse,
  resolveMatchFactCaptureOperations,
} from "../ui/electron/match-fact-capture.js";
import {
  buildHostTurnDeltaPrompt,
  compactHostTurnDelta,
  currentEffectiveDecisionEquipment,
  decisionInputEquipmentOptionGroups,
  mergeUserConfirmedEquipmentSections,
  normalizeStructuredEquipmentSections,
  normalizeHostCoachResponse,
  setRuntimeServiceState,
  stripMaterializedHostEvidenceForRebuild,
} from "../ui/electron/runtime-service.js";

const catalog = createDecisionInputCatalog({
  schema: "jcc-decision-input-catalog-v1",
  source_identity: {
    season_id: "s-test",
    active_patch_id: "test.1",
    catalog_source_fingerprint: "fixture",
  },
  entities: [
    {
      kind: "augment",
      id: "augment-1",
      address: "jcc:s-test:augment:augment-1",
      season_id: "s-test",
      source: "fixture",
      name: "飞升",
      tier_color: "gold",
      rounds: ["3-2"],
      round_bucket: "known_round",
    },
    {
      kind: "item",
      id: "item-sword",
      address: "jcc:s-test:item:item-sword",
      season_id: "s-test",
      source: "fixture",
      name: "暴风大剑",
      item_category: "components",
    },
    {
      kind: "item",
      id: "item-ie",
      address: "jcc:s-test:item:item-ie",
      season_id: "s-test",
      source: "fixture",
      name: "无尽之刃",
      item_category: "completed",
    },
    {
      kind: "item",
      id: "item-support",
      address: "jcc:s-test:item:item-support",
      season_id: "s-test",
      source: "fixture",
      name: "辅助装",
      item_category: "support",
      item_subtype: "support",
    },
    {
      kind: "item",
      id: "item-special",
      address: "jcc:s-test:item:item-special",
      season_id: "s-test",
      source: "fixture",
      name: "特殊装",
      item_category: "special",
      item_subtype: "special",
    },
    {
      kind: "item",
      id: "item-radiant",
      address: "jcc:s-test:item:item-radiant",
      season_id: "s-test",
      source: "fixture",
      name: "光明装",
      item_category: "radiant",
      item_subtype: "radiant",
    },
    {
      kind: "item",
      id: "item-artifact",
      address: "jcc:s-test:item:item-artifact",
      season_id: "s-test",
      source: "fixture",
      name: "神器装",
      item_category: "artifacts",
      item_subtype: "artifact",
    },
    {
      kind: "item",
      id: "item-emblem",
      address: "jcc:s-test:item:item-emblem",
      season_id: "s-test",
      source: "fixture",
      name: "斗士纹章",
      item_category: "emblems",
      item_subtype: "emblem",
    },
    {
      kind: "champion",
      id: "champion-reksai",
      address: "jcc:s-test:champion:champion-reksai",
      season_id: "s-test",
      source: "fixture",
      name: "雷克塞",
    },
    {
      kind: "season_pick",
      id: "season-choice-1",
      address: "jcc:s-test:season_pick:season-choice-1",
      season_id: "s-test",
      source: "fixture",
      name: "造物契约",
    },
    {
      kind: "season_reward",
      id: "season-reward-1",
      address: "jcc:s-test:season_reward:season-reward-1",
      season_id: "s-test",
      source: "fixture",
      name: "奖励甲",
      parent_name: "造物契约",
      stage_num: 2,
    },
  ],
  aliases: [
    {
      alias: "挖掘机",
      evidence_kind: "player_alias",
      source: "fixture.entity_alias_gateway",
      auto_confirm: false,
      ref: { kind: "champion", id: "champion-reksai", address: "jcc:s-test:champion:champion-reksai", season_id: "s-test", source: "fixture" },
    },
    {
      alias: "大剑",
      evidence_kind: "player_alias",
      source: "fixture.entity_alias_gateway",
      auto_confirm: false,
      ref: { kind: "item", id: "item-sword", address: "jcc:s-test:item:item-sword", season_id: "s-test", source: "fixture" },
    },
    {
      alias: "恶火",
      evidence_kind: "player_alias",
      source: "fixture.entity_alias_gateway",
      auto_confirm: false,
      ref: { kind: "item", id: "item-artifact", address: "jcc:s-test:item:item-artifact", season_id: "s-test", source: "fixture" },
    },
  ],
});

const normalized = normalizeMatchFactCaptureResponse({
  schema: "jcc-match-fact-capture-v1",
  operations: [
    { op: "set_choice", choice_kind: "augment", stage_round: "3-2", entity_name: "飞升" },
    {
      op: "replace_equipment",
      category: "components",
      items: [{ entity_name: "暴风大剑", quantity: 2 }],
    },
    {
      op: "assign_equipment",
      champion_name: "卡莎",
      item_name: "无尽之刃",
      holder_intent: "temporary",
    },
  ],
  unresolved: [{ input_text: "一件没听清的装备", reason: "speech_uncertain" }],
});

assert.equal(normalized.operations.length, 3);
assert.equal(normalized.operations[1].items[0].quantity, 2);
assert.equal(normalized.unresolved.length, 1);

const normalizedAliasFields = normalizeMatchFactCaptureResponse({
  schema: "jcc-match-fact-capture-v1",
  operations: [
    {
      operation: "assign_equipment",
      holderName: "挖掘机",
      artifactName: "恶火小斧",
    },
    {
      operation: "set_choice",
      choiceKind: "augment",
      stageRound: "3-2",
      choiceName: "珠光莲花 II",
    },
    {
      operation: "replace_equipment",
      equipmentAction: "replace",
      equipment: [{ equipmentName: "羊刀", quantity: 1 }],
    },
  ],
});
assert.equal(normalizedAliasFields.operations.length, 3, "representation aliases must normalize before semantic entity resolution");
assert.equal(normalizedAliasFields.operations[0].champion_name, "挖掘机");
assert.equal(normalizedAliasFields.operations[0].item_name, "恶火小斧");
assert.equal(normalizedAliasFields.operations[1].entity_name, "珠光莲花 II");
assert.equal(normalizedAliasFields.operations[2].items[0].entity_name, "羊刀");

const resolvedEntityAliases = resolveMatchFactCaptureOperations(normalizeMatchFactCaptureResponse({
  operations: [
    { operation: "assign_equipment", championName: "挖掘机", equipmentName: "恶火" },
    { operation: "add_equipment", equipment: [{ equipmentName: "大剑" }] },
  ],
}), { catalog, championNames: ["雷克塞"] });

const semanticChoiceAliasCapture = normalizeMatchFactCaptureResponse({
  operations: [{
    choiceKind: "augment",
    stageRound: "3-2",
    augmentName: "珠光莲花 II",
  }],
});
assert.equal(semanticChoiceAliasCapture.operations[0].entity_name, "珠光莲花 II");
assert.equal(resolvedEntityAliases.accepted.length, 2, "Core/data-owned aliases should resolve across champion and item entity kinds");
assert.equal(resolvedEntityAliases.accepted[0].champion.name, "雷克塞");
assert.equal(resolvedEntityAliases.accepted[0].item.name, "神器装");
assert.equal(resolvedEntityAliases.accepted[1].items[0].entity.name, "暴风大剑");

for (const op of ["set_target_plan", "set_lineup_direction", "request_advice", "write_arbitrary_json_path"]) {
  const forbiddenOperation = normalizeMatchFactCaptureResponse({
    schema: "jcc-match-fact-capture-v1",
    operations: [{ op, value: "卡莎" }],
  });
  assert.equal(forbiddenOperation.operations.length, 0, `${op} must never reach persistence`);
  assert.equal(forbiddenOperation.unresolved[0].reason, "unsupported_operation");

  const forbiddenChoiceDisguise = normalizeMatchFactCaptureResponse({
    schema: "jcc-match-fact-capture-v1",
    operations: [{ op, choice_kind: "augment", stage_round: "3-2", entity_name: "飞升" }],
  });
  assert.equal(forbiddenChoiceDisguise.operations.length, 0, `${op} must not be inferred as set_choice`);
  assert.equal(forbiddenChoiceDisguise.unresolved[0].reason, "unsupported_operation");
}

const observedHostShape = normalizeMatchFactCaptureResponse({
  schema: "jcc-match-fact-capture-v1",
  operations: [
    { operation: "set_choice", choice_kind: "augment", stage_round: "3-2", entity_name: "飞升" },
    {
      operation: "replace_equipment",
      items: [{ item_name: "暴风大剑", quantity: 2 }],
    },
    { operation: "set_target_plan", value: "卡莎" },
  ],
});
assert.deepEqual(observedHostShape.operations.map((entry) => entry.op), ["set_choice", "replace_equipment"]);
assert.equal(observedHostShape.operations[1].category, null, "missing category must remain unresolved until catalog validation");
assert.equal(observedHostShape.unresolved[0].reason, "unsupported_operation");

const mechanicallyRecoverableHostShape = normalizeMatchFactCaptureResponse({
  schema: "jcc-match-fact-capture-v1",
  operations: [
    { choice_kind: "augment", stage_round: "3-2", entity_name: "飞升" },
    { action: "replace", items: [{ item_name: "暴风大剑" }] },
  ],
});
assert.deepEqual(
  mechanicallyRecoverableHostShape.operations.map((entry) => entry.op),
  ["set_choice", "replace_equipment"],
  "unambiguous Host field shapes should recover a missing operation key without another model turn",
);

const observedHostResolved = resolveMatchFactCaptureOperations(observedHostShape, {
  catalog,
  choiceDescriptors: [{ kind: "augment", catalog_entity_kind: "augment", aliases: ["augment"], stages: ["2-1", "3-2", "4-2"] }],
});
assert.equal(observedHostResolved.accepted.length, 2, "one malformed operation must not discard independent valid facts");
assert.equal(observedHostResolved.accepted[1].category, "components", "equipment category should be inferred from one canonical item class");
assert.equal(observedHostResolved.unresolved[0].reason, "unsupported_operation");

for (const [category, itemName, expectedCategory] of [
  ["普通装备", "无尽之刃", "completed"],
  ["光明装备", "光明装", "radiant"],
  ["神器", "神器装", "artifacts"],
  ["纹章", "斗士纹章", "emblems"],
  ["特殊装备", "特殊装", "special"],
]) {
  const categorySnapshot = resolveMatchFactCaptureOperations(normalizeMatchFactCaptureResponse({
    operations: [{ operation: "replace_equipment", category, items: [{ display_name: itemName }] }],
  }), { catalog });
  assert.equal(categorySnapshot.accepted.length, 1, `${category} must resolve as an explicit quick-record category`);
  assert.equal(categorySnapshot.accepted[0].category, expectedCategory, `${category} must normalize to ${expectedCategory}`);
  assert.equal(categorySnapshot.unresolved.length, 0, `${category} must not create an unresolved equipment record`);
}

const malformedReplacement = resolveMatchFactCaptureOperations(normalizeMatchFactCaptureResponse({
  operations: [{
    operation: "replace_equipment",
    items: [{ item_name: "暴风大剑" }, { quantity: 2 }],
  }],
}), { catalog });
assert.equal(malformedReplacement.accepted.length, 0, "a malformed replacement sibling must reject the whole snapshot");
assert.equal(malformedReplacement.unresolved[0].reason, "missing_equipment_name");

const partialMalformedAdd = resolveMatchFactCaptureOperations(normalizeMatchFactCaptureResponse({
  operations: [{
    operation: "add_equipment",
    items: [{ item_name: "暴风大剑" }, { quantity: 2 }],
  }],
}), { catalog });
assert.equal(partialMalformedAdd.accepted.length, 1, "add may retain independent valid siblings");
assert.equal(partialMalformedAdd.accepted[0].items.length, 1);
assert.equal(partialMalformedAdd.unresolved[0].reason, "missing_equipment_name");

for (const quantity of [null, 0, -1, "two", 21]) {
  const invalidQuantity = resolveMatchFactCaptureOperations(normalizeMatchFactCaptureResponse({
    operations: [{ operation: "add_equipment", items: [{ item_name: "暴风大剑", quantity }] }],
  }), { catalog });
  assert.equal(invalidQuantity.accepted.length, 0, `invalid quantity ${quantity} must not become one copy`);
  assert.equal(invalidQuantity.unresolved[0].reason, "invalid_equipment_quantity");
}

for (const items of [undefined, null, "暴风大剑", []]) {
  const invalidItems = resolveMatchFactCaptureOperations(normalizeMatchFactCaptureResponse({
    operations: [{ operation: "replace_equipment", items }],
  }), { catalog });
  assert.equal(invalidItems.accepted.length, 0);
  assert.match(invalidItems.unresolved[0].reason, /equipment_items_(?:not_array|empty)/);
}

for (const category of ["components", "completed", "artifacts"]) {
  const emptySnapshot = resolveMatchFactCaptureOperations(normalizeMatchFactCaptureResponse({
    operations: [{ op: "replace_equipment", category, items: [] }],
  }), { catalog });
  assert.equal(emptySnapshot.accepted.length, 1);
  assert.equal(emptySnapshot.accepted[0].action, "clear");
  assert.equal(emptySnapshot.unresolved.length, 0);
}
for (const op of ["add_equipment", "remove_equipment"]) {
  const emptyMutation = resolveMatchFactCaptureOperations(normalizeMatchFactCaptureResponse({
    operations: [{ op, category: "components", items: [] }],
  }), { catalog });
  assert.equal(emptyMutation.accepted.length, 0);
}
const invalidAssignmentQuantity = resolveMatchFactCaptureOperations(normalizeMatchFactCaptureResponse({
  operations: [{ operation: "assign_equipment", champion_name: "卡莎", item_name: "无尽之刃", quantity: 0 }],
}), { catalog, championNames: ["卡莎"] });
assert.equal(invalidAssignmentQuantity.accepted.length, 0);
assert.equal(invalidAssignmentQuantity.unresolved[0].reason, "invalid_equipment_quantity");

const nonObjectWithValidSibling = normalizeMatchFactCaptureResponse({
  operations: [null, { operation: "set_choice", choice_kind: "augment", stage_round: "3-2", entity_name: "飞升" }],
});
assert.equal(nonObjectWithValidSibling.operations.length, 1);
assert.equal(nonObjectWithValidSibling.unresolved[0].reason, "invalid_operation_shape");

const resolved = resolveMatchFactCaptureOperations(normalized, {
  catalog,
  championNames: ["卡莎", "科加斯"],
  choiceDescriptors: [{ kind: "augment", catalog_entity_kind: "augment", aliases: ["augment"], stages: ["2-1", "3-2", "4-2"] }],
  manualVariableFields: [],
});

assert.equal(resolved.accepted.length, 3);
assert.equal(resolved.unresolved.length, 1);
assert.equal(resolved.accepted[0].entity.name, "飞升");
assert.equal(resolved.accepted[1].items[0].entity.name, "暴风大剑");
assert.equal(resolved.accepted[1].items[0].quantity, 2);
assert.equal(resolved.accepted[2].champion.name, "卡莎");
assert.equal(resolved.accepted[2].holder_intent, "temporary");

const wrongStage = resolveMatchFactCaptureOperations(normalizeMatchFactCaptureResponse({
  schema: "jcc-match-fact-capture-v1",
  operations: [{ op: "set_choice", choice_kind: "augment", stage_round: "2-1", entity_name: "飞升" }],
}), {
  catalog,
  championNames: ["卡莎"],
  choiceDescriptors: [{ kind: "augment", catalog_entity_kind: "augment", aliases: ["augment"], stages: ["2-1", "3-2", "4-2"] }],
  manualVariableFields: [],
});
assert.equal(wrongStage.accepted.length, 0);
assert.equal(wrongStage.unresolved[0].reason, "choice_not_legal_at_stage");

const inventory = applyEquipmentInventoryMutation([
  { name: "暴风大剑", ref: { address: "jcc:s-test:item:item-sword" } },
], {
  action: "add",
  items: [{ entity: catalog.entities.find((entry) => entry.name === "暴风大剑"), quantity: 2 }],
});
assert.equal(inventory.filter((entry) => entry.name === "暴风大剑").length, 3);

const afterRemove = applyEquipmentInventoryMutation(inventory, {
  action: "remove",
  items: [{ entity: catalog.entities.find((entry) => entry.name === "暴风大剑"), quantity: 2 }],
});
assert.equal(afterRemove.filter((entry) => entry.name === "暴风大剑").length, 1);

const equipmentDeduped = mergeUserConfirmedEquipmentSections({
  components: [],
  completed: [
    { name: "无尽之刃", ref: { address: "jcc:s-test:item:item-ie" } },
    { name: "无尽之刃", ref: { address: "jcc:s-test:item:item-ie" } },
  ],
  radiant: [],
  artifacts: [],
  emblems: [],
  equipped: [],
}, {
  equipped: [{ name: "无尽之刃", ref: { address: "jcc:s-test:item:item-ie" }, owner_unit: "卡莎" }],
}, { matchSessionId: "equipment-dedup-match", stageRound: "3-2" }).equipment;
assert.equal(equipmentDeduped.equipped.length, 1);
assert.equal(equipmentDeduped.completed.length, 1, "equipped snapshot consumes exactly one matching inventory copy");
assert.ok(equipmentDeduped.changed_sections.includes("completed"), "moved-from inventory category participates in freshness events");

const clearedAssignments = mergeUserConfirmedEquipmentSections(equipmentDeduped, {
  equipped: [],
}, { matchSessionId: "equipment-dedup-match", stageRound: "3-2" }).equipment;
assert.equal(clearedAssignments.equipped.length, 0);
assert.equal(clearedAssignments.completed.length, 1, "clearing holder relationships must not re-add inventory copies");

const normalizedEquipmentSnapshot = normalizeStructuredEquipmentSections({
  action: "equipment_equipped_update",
  equipment: {
    support: [{ name: "辅助装", item_subtype: "support" }],
    artifacts: [{ name: "神器", item_subtype: "artifact" }],
    emblems: [{ name: "冠冕", item_subtype: "emblem" }],
    special: [{ name: "特殊装", subtype: "special" }],
    equipped: [{
      name: "辅助装",
      owner_unit: "卡莎",
      slot: 2,
      holder_intent: "temporary",
    }],
  },
  changed_sections: ["support", "artifacts", "emblems", "special", "equipped"],
});
assert.equal(normalizedEquipmentSnapshot.support[0].item_subtype, "support");
assert.equal(normalizedEquipmentSnapshot.artifacts[0].item_subtype, "artifact");
assert.equal(normalizedEquipmentSnapshot.emblems[0].item_subtype, "emblem");
assert.equal(normalizedEquipmentSnapshot.special[0].item_subtype, "special");
assert.deepEqual(
  {
    owner_unit: normalizedEquipmentSnapshot.equipped[0].owner_unit,
    slot: normalizedEquipmentSnapshot.equipped[0].slot,
    holder_intent: normalizedEquipmentSnapshot.equipped[0].holder_intent,
  },
  { owner_unit: "卡莎", slot: 2, holder_intent: "temporary" },
);

const equipmentOptionGroups = decisionInputEquipmentOptionGroups(catalog);
assert.equal(equipmentOptionGroups.support[0].item_category, "support");
assert.equal(equipmentOptionGroups.special[0].item_category, "special");
assert.ok(Object.hasOwn(equipmentOptionGroups, "emblems"), "emblems remain a catalog-owned category");

setRuntimeServiceState({
  match_session: { status: "active", match_session_id: "equipment-effective-match" },
  match_context: {
    user_confirmed_equipment: {
      schema: "jcc-runtime-user-confirmed-equipment-v1",
      match_session_id: "equipment-effective-match",
      support: [{ name: "辅助装", item_subtype: "support" }],
      special: [{ name: "特殊装", item_subtype: "special" }],
      emblems: [{ name: "冠冕", item_subtype: "emblem" }],
    },
  },
  response_task: { status: "idle" },
});
const effectiveEquipment = currentEffectiveDecisionEquipment();
assert.equal(effectiveEquipment.support[0].item_subtype, "support");
assert.equal(effectiveEquipment.special[0].item_subtype, "special");
assert.equal(effectiveEquipment.emblems[0].item_subtype, "emblem");

const ambiguousChampion = resolveMatchFactCaptureOperations(normalizeMatchFactCaptureResponse({
  schema: "jcc-match-fact-capture-v1",
  operations: [{ op: "assign_equipment", champion_name: "卡", item_name: "无尽之刃" }],
}), {
  catalog,
  championNames: ["卡莎", "卡尔玛"],
  choiceDescriptors: [],
  manualVariableFields: [],
});
assert.equal(ambiguousChampion.accepted.length, 0);
assert.equal(ambiguousChampion.unresolved[0].reason, "champion_not_uniquely_resolved");

const currentStageItemChoice = resolveMatchFactCaptureOperations(normalizeMatchFactCaptureResponse({
  schema: "jcc-match-fact-capture-v1",
  operations: [{ op: "set_choice", choice_kind: "item", stage_round: "3-1", entity_name: "无尽之刃" }],
}), {
  catalog,
  currentStageRound: "3-1",
  choiceDescriptors: [{
    kind: "item",
    catalog_entity_kind: "item",
    aliases: ["item"],
    stages: [],
    stage_policy: "current_verified_stage",
  }],
});
assert.equal(currentStageItemChoice.accepted.length, 1);

const seasonChoiceWithReward = resolveMatchFactCaptureOperations(normalizeMatchFactCaptureResponse({
  schema: "jcc-match-fact-capture-v1",
  operations: [{
    op: "set_choice",
    choice_kind: "season_mechanic",
    stage_round: "2-4",
    entity_name: "造物契约",
    reward_text: "奖励甲",
  }],
}), {
  catalog,
  choiceDescriptors: [{
    kind: "season_mechanic",
    catalog_entity_kind: "season_pick",
    aliases: ["season_mechanic"],
    stages: ["2-4"],
    reward_validation: {
      catalog_entity_kind: "season_reward",
      parent_entity_field: "parent_name",
      stage_field: "stage_num",
      stage_round_values: { "2-4": 2 },
      cross_parent_choice_ids: [],
    },
  }],
});
assert.equal(seasonChoiceWithReward.accepted[0].reward_entity.name, "奖励甲");

const invalidSeasonReward = resolveMatchFactCaptureOperations(normalizeMatchFactCaptureResponse({
  schema: "jcc-match-fact-capture-v1",
  operations: [{
    op: "set_choice",
    choice_kind: "season_mechanic",
    stage_round: "2-4",
    entity_name: "造物契约",
    reward_text: "不存在的奖励",
  }],
}), {
  catalog,
  choiceDescriptors: [{
    kind: "season_mechanic",
    catalog_entity_kind: "season_pick",
    aliases: ["season_mechanic"],
    stages: ["2-4"],
    reward_validation: { catalog_entity_kind: "season_reward" },
  }],
});
assert.equal(invalidSeasonReward.accepted.length, 1);
assert.equal(invalidSeasonReward.accepted[0].reward_text, null);
assert.equal(invalidSeasonReward.unresolved[0].reason, "choice_reward_not_legal");

const partialEquipmentResolution = resolveMatchFactCaptureOperations(normalizeMatchFactCaptureResponse({
  schema: "jcc-match-fact-capture-v1",
  operations: [{
    op: "add_equipment",
    category: "components",
    items: [{ entity_name: "暴风大剑" }, { entity_name: "不存在的装备" }],
  }],
}), { catalog });
assert.equal(partialEquipmentResolution.accepted.length, 1);
assert.equal(partialEquipmentResolution.accepted[0].items.length, 1);
assert.equal(partialEquipmentResolution.unresolved[0].reason, "equipment_not_uniquely_resolved");

const shortRemoval = applyEquipmentInventoryMutationWithResult([
  { name: "暴风大剑", ref: { address: "jcc:s-test:item:item-sword" } },
], {
  action: "remove",
  items: [{ entity: catalog.entities.find((entry) => entry.name === "暴风大剑"), quantity: 2 }],
});
assert.equal(shortRemoval.inventory.length, 0);
assert.equal(shortRemoval.appliedItems[0].quantity, 1);

const productionCatalogSource = JSON.parse(await readFile(
  createRuntimePaths(path.resolve(import.meta.dirname, "..")).activeDecisionInputCatalogFile,
  "utf8",
));
const productionCatalog = createDecisionInputCatalog(productionCatalogSource);
const productionObservedHostShape = normalizeMatchFactCaptureResponse({
  schema: "jcc-match-fact-capture-v1",
  operations: [
    { operation: "set_choice", choice_kind: "augment", stage_round: "3-2", entity_name: "飞升" },
    {
      operation: "replace_equipment",
      items: [
        { item_name: "女神之泪", quantity: 1 },
        { item_name: "负极斗篷", quantity: 1 },
        { item_name: "暴风之剑", quantity: 1 },
      ],
    },
  ],
  unresolved: [{ text: "两个基础装备锻造器", reason: "not_in_current_fact_catalog" }],
});
const productionObservedResolved = resolveMatchFactCaptureOperations(productionObservedHostShape, {
  catalog: productionCatalog,
  choiceDescriptors: [{
    kind: "augment",
    catalog_entity_kind: "augment",
    aliases: ["augment"],
    stages: productionCatalogSource.choice_descriptors?.augment?.stages || [],
  }],
});
assert.equal(productionObservedResolved.accepted.length, 2, "the real Host response shape must preserve the legal choice and equipment snapshot");
assert.equal(productionObservedResolved.accepted[0].entity.name, "飞升");
assert.equal(productionObservedResolved.accepted[1].category, "components");
assert.deepEqual(productionObservedResolved.accepted[1].items.map((entry) => entry.entity.name), ["女神之泪", "负极斗篷", "暴风之剑"]);
assert.equal(productionObservedResolved.unresolved[0].input_text, "两个基础装备锻造器");

const mixedCategoryWithoutLabel = resolveMatchFactCaptureOperations(normalizeMatchFactCaptureResponse({
  operations: [{
    operation: "replace_equipment",
    items: [{ item_name: "暴风大剑" }, { item_name: "无尽之刃" }],
  }],
}), { catalog });
assert.equal(mixedCategoryWithoutLabel.accepted.length, 0, "mixed equipment categories must never be inferred as one snapshot");
assert.equal(mixedCategoryWithoutLabel.unresolved.at(-1).reason, "equipment_category_not_resolved");

const explicitCategoryConflict = resolveMatchFactCaptureOperations(normalizeMatchFactCaptureResponse({
  operations: [{ operation: "replace_equipment", category: "completed", items: [{ item_name: "暴风大剑" }] }],
}), { catalog });
assert.equal(explicitCategoryConflict.accepted.length, 0);
assert.equal(explicitCategoryConflict.unresolved.at(-1).reason, "equipment_category_not_resolved");

const supportedSpecialCategory = normalizeMatchFactCaptureResponse({
  operations: [{ operation: "replace_equipment", category: "special", items: [{ item_name: "特殊道具" }] }],
});
assert.equal(supportedSpecialCategory.operations.length, 1);
assert.equal(supportedSpecialCategory.operations[0].category, "special");

const compactProductionCatalog = compactMatchFactCaptureCatalog(productionCatalog, {
  seasonId: productionCatalogSource.source_identity?.season_id,
  patchId: productionCatalogSource.source_identity?.active_patch_id,
  championNames: ["卡莎", "科加斯"],
  choiceDescriptors: [{
    kind: "augment",
    catalog_entity_kind: "augment",
    aliases: ["augment"],
    stages: productionCatalogSource.choice_descriptors?.augment?.stages || [],
  }],
});
const compactProductionBytes = Buffer.byteLength(JSON.stringify(compactProductionCatalog));
assert.ok(compactProductionCatalog.aliases.length > 0, "production fact capture catalog must include aliases");
assert.ok(compactProductionBytes <= MATCH_FACT_CAPTURE_CATALOG_BUDGET_BYTES, `fact capture catalog exceeds budget: ${compactProductionBytes}`);

const queryScopedProductionCatalog = compactMatchFactCaptureCatalog(productionCatalog, {
  seasonId: productionCatalogSource.source_identity?.season_id,
  patchId: productionCatalogSource.source_identity?.active_patch_id,
  championNames: ["卡莎", "科加斯"],
  choiceDescriptors: [
    {
      kind: "augment",
      catalog_entity_kind: "augment",
      aliases: ["augment"],
      stages: productionCatalogSource.choice_descriptors?.augment?.stages || [],
    },
  ],
  manualVariableFields: [],
  queryText: "我在 3-2 选了飞升。现在装备是女神之泪、负极斗篷，还有一把大剑。",
});
const queryScopedBytes = Buffer.byteLength(JSON.stringify(queryScopedProductionCatalog));
assert.ok(queryScopedBytes < compactProductionBytes, "Quick Record must send a query-scoped catalog instead of the full season catalog");
assert.ok(queryScopedBytes <= 24 * 1024, `query-scoped Quick Record catalog is still too large: ${queryScopedBytes}`);
assert.ok(queryScopedProductionCatalog.entities.item.some((entry) => entry.name === "女神之泪"));
assert.ok(queryScopedProductionCatalog.entities.item.some((entry) => entry.name === "负极斗篷"));
assert.ok(queryScopedProductionCatalog.entities.item.some((entry) => entry.name === "暴风之剑"));
assert.ok(queryScopedProductionCatalog.entities.augment.some((entry) => entry.name === "飞升"));
assert.ok(queryScopedProductionCatalog.aliases.some((entry) => entry.alias === "大剑" && entry.canonical_name === "暴风之剑"));
assert.deepEqual(queryScopedProductionCatalog.manual_variable_fields, [], "active S18 Quick Record must not expose retired season manual variables");
assert.equal(queryScopedProductionCatalog.entities.star_god, undefined, "active S18 Quick Record must not expose retired star-god entities");

const realEquipmentQuery = "我现在有杀人剑、光明羊刀和薄暮法袍，散件有一把攻速和两个锁子甲。";
const realEquipmentCatalog = compactMatchFactCaptureCatalog(productionCatalog, {
  seasonId: productionCatalogSource.source_identity?.season_id,
  patchId: productionCatalogSource.source_identity?.active_patch_id,
  choiceDescriptors: [],
  manualVariableFields: [],
  queryText: realEquipmentQuery,
});
assert(realEquipmentCatalog.entities.item.some((entry) => entry.name === "锐利之刃"), "quick record must expose the canonical ordinary item for 杀人剑");
assert(realEquipmentCatalog.entities.item.some((entry) => entry.name === "光明版鬼索的狂暴之刃"), "quick record must expose the canonical radiant item for 光明羊刀");
assert(realEquipmentCatalog.entities.item.some((entry) => entry.name === "薄暮法袍"), "quick record must expose the canonical ordinary item");
const realEquipmentResponse = normalizeMatchFactCaptureResponse({
  operations: [
    { op: "replace_equipment", category: "completed", items: [{ item_name: "杀人剑" }, { item_name: "薄暮法袍" }] },
    { op: "replace_equipment", category: "radiant", items: [{ item_name: "光明羊刀" }] },
    { op: "replace_equipment", category: "components", items: [{ item_name: "反曲之弓" }, { item_name: "锁子甲", quantity: 2 }] },
  ],
});
const realEquipmentResolved = resolveMatchFactCaptureOperations(realEquipmentResponse, { catalog: productionCatalog });
assert.equal(realEquipmentResolved.accepted.length, 3, "ordinary, radiant, and component quick-record operations must resolve together");
assert.deepEqual(realEquipmentResolved.accepted[0].items.map((entry) => entry.entity.name), ["锐利之刃", "薄暮法袍"]);
assert.equal(realEquipmentResolved.accepted[1].items[0].entity.name, "光明版鬼索的狂暴之刃");
assert.equal(realEquipmentResolved.unresolved.length, 0, "unique player aliases must not remain unresolved in quick record");

const captureRequest = {
  request_id: "fact-capture-test",
  request_hash: "fact-capture-test",
  request_kind: "match_fact_capture",
  mode: "cruise",
  user_message: "我 3-2 选了飞升，现在有两把大剑。",
  task: { kind: "match_fact_capture" },
  runtime_context: {
    request_kind: "match_fact_capture",
    fact_capture_catalog: compactProductionCatalog,
    current_match_facts: { choice_confirmations: [], user_confirmed_equipment: null, manual_match_variables: null },
  },
};
const rebuiltCapture = stripMaterializedHostEvidenceForRebuild({
  ...captureRequest,
  selected_ranking_candidates: { candidates: [{ id: "stale" }] },
  runtime_context: {
    ...captureRequest.runtime_context,
    strategy_fit_packet: { candidate_working_set: [{ candidate_id: "stale" }] },
  },
}, { factCapture: true });
assert.equal(rebuiltCapture.selected_ranking_candidates, undefined, "fact capture projection must remove stale Ranking evidence");
assert.equal(rebuiltCapture.runtime_context.strategy_fit_packet, undefined, "fact capture projection must remove stale strategy evidence");
assert(rebuiltCapture.runtime_context.fact_capture_catalog, "fact capture projection must preserve its catalog");
assert(rebuiltCapture.runtime_context.current_match_facts, "fact capture projection must preserve current facts");
const captureCapsule = { capsule_id: "capsule-test", fingerprint: "capture-test", route_key: "match:test" };
const captureDelta = compactHostTurnDelta(captureRequest, captureCapsule);
assert.equal(captureDelta.request_kind, "match_fact_capture");
assert.equal(captureDelta.response_contract_ref.fact_capture_required, true);
assert.equal(captureDelta.runtime_context.fact_capture_catalog.entities.augment.length, compactProductionCatalog.entities.augment.length);
assert.ok(Buffer.byteLength(JSON.stringify(captureDelta)) <= MATCH_FACT_CAPTURE_CATALOG_BUDGET_BYTES);
const capturePrompt = buildHostTurnDeltaPrompt(captureRequest, captureCapsule);
assert.match(capturePrompt, /explicit JCC match fact-capture request/);
assert.match(capturePrompt, /Do not infer a target lineup/);
assert.match(capturePrompt, /MUST use the key op/);
assert.match(capturePrompt, /include category/);
assert.match(capturePrompt, /include canonical reward_text/);

const oversizedCaptureDelta = compactHostTurnDelta({
  ...captureRequest,
  runtime_context: {
    ...captureRequest.runtime_context,
    current_match_facts: {
      ...captureRequest.runtime_context.current_match_facts,
      user_confirmed_equipment: {
        components: Array.from({ length: 5000 }, () => ({ name: "暴风大剑", ref: { address: "jcc:s-test:item:item-sword" } })),
      },
    },
  },
}, captureCapsule);
assert.equal(oversizedCaptureDelta.request_kind, "match_fact_capture");
assert.ok(oversizedCaptureDelta.runtime_context.fact_capture_catalog);
assert.ok(oversizedCaptureDelta.runtime_context.current_match_facts);
assert.ok(Buffer.byteLength(JSON.stringify(oversizedCaptureDelta)) <= MATCH_FACT_CAPTURE_CATALOG_BUDGET_BYTES);
assert.deepEqual(oversizedCaptureDelta.runtime_context.fact_capture_catalog, compactProductionCatalog,
  "quick-record budget compression must preserve the complete fact catalog");
assert.deepEqual(oversizedCaptureDelta.runtime_context.current_match_facts.user_confirmed_equipment.components, [{
  name: "暴风大剑",
  ref: { address: "jcc:s-test:item:item-sword" },
  quantity: 5000,
}], "quick-record compression must preserve repeated equipment quantities");
assert.deepEqual(oversizedCaptureDelta.context_budget.reductions, ["fact_capture_inventory_quantities"]);
assert.equal(oversizedCaptureDelta.runtime_context.host_evidence_materialization, undefined,
  "quick record must not enter the strategic evidence materializer");

const normalizedCaptureHostResponse = normalizeHostCoachResponse({
  schema: "jcc-host-cli-coach-response-v1",
  generated_by: "current_cli_agent_main_model",
  final_text: "不应直接展示的模型说明",
  recommended_action: "转阵",
  followup_question: "要不要锁阵？",
  choice_recommendation: {
    candidate_ranking: ["甲", "乙", "丙"],
    refresh_action: "keep_and_pick",
    selected_candidate: "甲",
    refresh_slots: [],
  },
  pinned_result: {
    schema: "jcc-internal-lineup-plan-v1",
    slot: "lineup",
    title: "Injected",
    units: [],
    moves: [],
  },
  fact_capture: { schema: "jcc-match-fact-capture-v1", operations: [], unresolved: [] },
}, {
  request_id: "capture-normalize",
  request_hash: "capture-normalize",
  request_kind: "match_fact_capture",
  mode: "cruise",
  expected_response_shape: { fact_capture: {} },
});
assert.equal(normalizedCaptureHostResponse.recommended_action, null);
assert.equal(normalizedCaptureHostResponse.followup_question, null);
assert.equal(normalizedCaptureHostResponse.choice_recommendation, null);
assert.equal(normalizedCaptureHostResponse.pinned_result, null);

const [runtimeSource, appSource, decisionCardSource, bridgeSource, uiContract, captureContract, agentsSource] = await Promise.all([
  readFile(new URL("../ui/electron/runtime-service.js", import.meta.url), "utf8"),
  readFile(new URL("../ui/src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../ui/src/components/DecisionInputCard.tsx", import.meta.url), "utf8"),
  readFile(new URL("../ui/src/runtimeBridge.ts", import.meta.url), "utf8"),
  readFile(new URL("../data/runtime/jcc/runtime-ui-mode-contract.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../data/runtime/jcc/match-fact-capture-contract.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
]);

assert.equal(uiContract.cruise_mode_policy.renderer.fact_capture_action.request_kind, "match_fact_capture");
assert.equal(captureContract.entry.visible_text_alone_never_authorizes_fact_writes, true);
assert.equal(captureContract.ownership.target_plan_mutation_forbidden, true);
assert.match(bridgeSource, /request_kind\?: "host_question" \| "match_fact_capture"/);
assert.match(appSource, /factCaptureAction/);
assert.match(appSource, /draftRequestKind/);
assert.match(decisionCardSource, /equipmentEditGeneration/);
assert.match(decisionCardSource, /requestEquipmentGeneration === equipmentEditGeneration\.current/);
assert.match(runtimeSource, /payload\.request_kind === MATCH_FACT_CAPTURE_REQUEST_KIND/);
assert.match(runtimeSource, /options\.allowFactWrites === true/);
assert.match(runtimeSource, /origin === MATCH_FACT_CAPTURE_REQUEST_KIND/);
assert.match(runtimeSource, /applyMatchFactCapture\(finalResponse\.fact_capture/);
assert.match(runtimeSource, /fact_capture_catalog: dynamicRuntimeContext\.fact_capture_catalog/);
assert.match(runtimeSource, /fact_capture_required: true/);
assert.match(runtimeSource, /\.\.\.matchFactCaptureHostInstructions\(hostRequest\)/);
assert.match(runtimeSource, /isCurrent: \(\) => responseTaskStillOwnedAtRevision\(owner\)/);
assert.match(runtimeSource, /expectedMatchSessionId: matchSessionId/);
assert.match(runtimeSource, /match_fact_capture_result_not_current_after_persistence/);
assert.doesNotMatch(runtimeSource.slice(
  runtimeSource.indexOf("function matchFactCaptureChoiceDescriptors"),
  runtimeSource.indexOf("async function matchFactCaptureVariableFields"),
), /star_god|god_reward|星神/);
const captureBranchIndex = runtimeSource.indexOf("if (requestKind === MATCH_FACT_CAPTURE_REQUEST_KIND) {", runtimeSource.indexOf("async function sendMessage"));
const ordinaryContextIndex = runtimeSource.indexOf("let recordedUserMessageContext = null;", captureBranchIndex);
assert.ok(captureBranchIndex >= 0 && ordinaryContextIndex > captureBranchIndex);
assert.match(runtimeSource.slice(captureBranchIndex, ordinaryContextIndex), /runDirectHostModelForUserMessageInBackground/);
assert.match(agentsSource, /Visible\s+text alone never grants this authority/);

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-match-fact-capture-verifier-v1",
  payload_bytes: {
    normal: Buffer.byteLength(JSON.stringify(captureDelta)),
    oversized_inventory_compressed: Buffer.byteLength(JSON.stringify(oversizedCaptureDelta)),
    limit: MATCH_FACT_CAPTURE_CATALOG_BUDGET_BYTES,
  },
  checked: [
    "explicit_quick_record_authority",
    "ordinary_chat_no_fact_writes",
    "catalog_validated_sparse_match_updates",
    "no_target_plan_inference",
    "equipment_snapshot_generation_fence",
    "canonical_persistence_ownership_recheck",
  ],
}, null, 2));
