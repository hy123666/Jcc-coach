#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import { buildDecisionInputCatalogFromSources } from "../ui/electron/decision-input-catalog.js";

const root = "data/core-patches/jcc/generations/baf64095be401718382c8a2983a1ac34b1c33ed76fd62b02aea004277ff9b047";
const read = (relative) => JSON.parse(fs.readFileSync(`${root}/${relative}`, "utf8"));
const taxonomy = JSON.parse(fs.readFileSync("data/game-knowledge/jcc/seasons/s18/patches/s18_1/item-usage-taxonomy.json", "utf8"));
const catalog = buildDecisionInputCatalogFromSources({
  seasonId: "s18",
  activePatchId: "s18_1",
  manifest: read("hard-data-manifest.json"),
  champions: read("normalized/champions.json"),
  augments: read("normalized/augments.json"),
  items: read("normalized/items.json"),
  traits: read("normalized/traits.json"),
  itemUsageTaxonomy: taxonomy,
  entityAliasGateway: read("indexes/entity_alias_gateway.json"),
  augmentStageAuthority: read("indexes/augment_stage_authority.json"),
  normalRules: { choice_mechanics: [{ kind: "augment", stages: ["2-1", "3-2", "4-2"] }] },
  specialRules: { mechanics: { choice_mechanics: [] } },
});
const byId = (id) => catalog.entities.find((entity) => entity.kind === "item" && entity.id === id);
assert.equal(byId("2032").item_category, "completed");
assert.equal(byId("2045").item_category, "completed");
assert.equal(byId("6091").item_category, "artifacts");
for (const id of ["2036", "2047", "2048"]) assert.equal(byId(id).item_category, "special");
assert.equal(byId("6091").usage_taxonomy_status, "developer_curated_current_patch");
assert.equal(byId("6091").browse_facets.includes("artifact"), true);
console.log(JSON.stringify({
  ok: true,
  schema: "jcc-item-usage-taxonomy-compilation-verification-v1",
  checked: ["standard_completed", "artifact", "special_crowns", "taxonomy_status", "browse_facets"],
}, null, 2));
