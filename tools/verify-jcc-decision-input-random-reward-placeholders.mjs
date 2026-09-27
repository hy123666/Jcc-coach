import assert from "node:assert/strict";
import { buildDecisionInputCatalogFromSources, createDecisionInputCatalog } from "../ui/electron/decision-input-catalog.js";

const placeholderIds = ["9470", "9471", "9472"];
const sourceItems = placeholderIds.map((id) => ({
  id,
  address: `jcc:s18:item:${id}`,
  name: {
    "9470": "random component reward",
    "9471": "random completed-item reward",
    "9472": "random emblem reward",
  }[id],
  type: "special",
  player_facing: true,
  equippable: true,
}));

const catalogJson = buildDecisionInputCatalogFromSources({
  seasonId: "s18",
  activePatchId: "s18_1",
  items: sourceItems,
});
const catalog = createDecisionInputCatalog(catalogJson);
const quickRecordItems = catalog.by_kind.get("item") || [];

for (const id of placeholderIds) {
  assert(!quickRecordItems.some((item) => item.id === id), `placeholder ${id} must not be player-facing or equippable`);
  assert(catalogJson.excluded_item_entities.some((item) => item.id === id
    && item.classified_as === "random_reward_placeholder"
    && item.reason === "random_reward_placeholder_not_player_facing_equipment"),
  `placeholder ${id} must have an explicit audited exclusion`);
}

assert.deepEqual(
  Object.values(catalogJson.item_categories).flat(),
  [],
  "random reward placeholders must not enter any quick-record item category",
);

console.log(JSON.stringify({
  ok: true,
  checked_placeholder_ids: placeholderIds,
  excluded_item_entities: catalogJson.excluded_item_entities,
}, null, 2));
