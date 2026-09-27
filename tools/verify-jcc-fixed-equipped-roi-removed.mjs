import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readText(file) {
  return readFile(file, "utf8");
}

async function main() {
  const [layout, roi, matcher, aggregator, mumuBuilder] = await Promise.all([
    readText("data/runtime/jcc/visual-roi-layout.json"),
    readText("tools/roi_left_item_rail.py"),
    readText("tools/match-jcc-left-item-rail-icons.mjs"),
    readText("tools/jcc_left_item_rail_field_aggregator.mjs"),
    readText("tools/build-jcc-mumu-gi-live-state.mjs"),
  ]);

  assert(!layout.includes('"equipped_item_slots"'), "layout must not declare fixed board equipped-item ROIs");
  assert(!roi.includes("equipped_items"), "left item rail cropper must not crop unit-equipped items");
  assert(!matcher.includes("items.equipped_items."), "scene-scoped left item rail matcher must not emit equipped-item fields");
  assert(matcher.includes("no_equipped_items: true"), "left item rail matcher policy must explicitly forbid equipped items");
  assert(aggregator.includes("equipped_items: []"), "left item rail aggregator must leave equipped items empty");
  assert(
    mumuBuilder.includes('source: "mumu_4356_equipment_to_4353_own_unit"'),
    "equipped items must be sourced from 4356-to-4353 coordinate assignment",
  );
  assert(
    mumuBuilder.includes('own_unit_source: "s1_plus_fresh_4354_shop_anchored_4353_units"'),
    "equipped-item assignment must require the S=1 + fresh 4354 + 4353 own-unit anchor",
  );
  assert(
    mumuBuilder.includes('s2_policy: "diagnostic_visible_equipment_only_never_own_equipped_items"'),
    "S=2 equipment must remain diagnostic and must not update own equipped items",
  );

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "fixed board equipped-item ROIs are absent",
      "left item rail crop/match/aggregate stages cannot emit equipped-item facts",
      "4356-to-4353 coordinate assignment is the structured equipped-item path",
      "own equipped-item promotion requires S=1 plus a fresh 4354 shop anchor",
      "S=2 visible equipment remains diagnostic",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
