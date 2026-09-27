import { readFile } from "node:fs/promises";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readText(file) {
  return readFile(path.resolve(file), "utf8");
}

async function main() {
  const roi = await readText("tools/roi_left_item_rail.py");
  const matcher = await readText("tools/match-jcc-left-item-rail-icons.mjs");
  const aggregator = await readText("tools/jcc_left_item_rail_field_aggregator.mjs");
  const runner = await readText("tools/run-jcc-left-item-rail-roi-icon.mjs");
  const runtime = await readText("ui/electron/runtime-service.js");
  const map = await readText("data/runtime/jcc/runtime-mode-sensing-map.json");

  assert(roi.includes("regions.item_bench_slots"), "ROI script must crop from layout item_bench_slots");
  assert(!/run_jcc_rapidocr|RapidOCR|ocr_worker|manifest|templateDescriptors|catalog|match_item|parsePng/i.test(roi), "ROI script must not OCR, read catalogs/manifests, or match icons");
  assert(matcher.includes("jcc-left-item-rail-icon-match-batch-v1"), "matcher must emit the left item rail icon schema");
  assert(matcher.includes("items.item_bench."), "matcher must be scoped to items.item_bench fields");
  assert(!matcher.includes("selected_augment_slots"), "matcher must not inspect augment slots");
  assert(!matcher.includes("opponent_current_view_item_bench_slots"), "matcher must not inspect opponent item bench slots");
  assert(!matcher.includes("items.equipped_items"), "matcher must not inspect unit-equipped item fields");
  assert(aggregator.includes("left_item_rail_roi_icon"), "aggregator must preserve the formal product source");
  assert(aggregator.includes("item_bench_candidates"), "aggregator must emit item_bench_candidates");
  assert(aggregator.includes("item_bench: []"), "aggregator must leave main item_bench empty");
  assert(!aggregator.includes("equipped_items: candidate") && aggregator.includes("equipped_items: []"), "aggregator must not emit equipped item candidates");
  assert(runner.includes("roi_left_item_rail.py"), "runner must call the ROI crop script");
  assert(runner.includes("match-jcc-left-item-rail-icons.mjs"), "runner must call the item icon matcher");
  assert(runner.includes("jcc_left_item_rail_field_aggregator.mjs"), "runner must call the field aggregator");
  assert(runtime.includes("runLeftItemRailRoiIconRefresh"), "runtime must wire the left item rail runner into self-state refresh");
  assert(runtime.includes("readLatestLeftItemRailRoiIconLiveState"), "runtime resolver must read latest left item rail state");
  assert(map.includes("\"runner\": \"tools/run-jcc-left-item-rail-roi-icon.mjs\""), "mode sensing map must declare the formal runner");
  assert(!map.includes("product_left_item_rail_specialized"), "mode sensing map must not keep old specialized product role names");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "left item rail ROI script crops only",
      "left item rail matcher scopes to item_bench only",
      "left item rail aggregator emits item_bench_candidates only",
      "runtime self-state refresh includes the formal left item rail producer",
      "mode sensing map no longer pins the old specialized role name",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
