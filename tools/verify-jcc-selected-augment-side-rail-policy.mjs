import { readFile } from "node:fs/promises";

const LAYOUT = "data/runtime/jcc/visual-roi-layout.json";
const CONTRACT = "data/runtime/jcc/visual-live-state-contract.json";
const WIKI = "data/runtime/jcc/runtime-agent-wiki/official/mumu-desktop-runtime.md";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function allWithin(slots, predicate) {
  return Array.isArray(slots) && slots.length > 0 && slots.every(predicate);
}

async function main() {
  const layout = JSON.parse(await readFile(LAYOUT, "utf8"));
  const contract = JSON.parse(await readFile(CONTRACT, "utf8"));
  const wiki = await readFile(WIKI, "utf8");

  const policy = layout.selected_augment_side_rail_policy || {};
  const selfSlots = layout.regions?.selected_augment_slots?.self || [];
  const opponentSlots = layout.regions?.selected_augment_slots?.opponent || [];
  const nonSelfCurrentViewSlots = layout.regions?.selected_augment_slots?.non_self_current_view_diagnostic || [];

  assert(policy.self_owner_scope === "left_rail", "layout must declare self selected augments as left rail");
  assert(policy.opponent_board_scope === "removed_from_product_runtime", "layout must mark opponent board/rail sensing as removed from product runtime");
  assert(!("opponent_owner_scope" in policy), "layout must not keep an opponent selected-augment owner scope");
  assert(/Do not infer opponent selected augments/i.test(policy.view_switch_policy || ""), "layout must forbid opponent current-view selected augment inference");
  assert(!("opponent_power_policy" in policy), "layout must not keep opponent_power ROI policy");

  assert(allWithin(selfSlots, (slot) => slot.owner_scope === "self" && slot.x < 0.5), "self selected augment slots must stay on left rail");
  assert(opponentSlots.length === 0, "opponent selected augment slots must not exist in product ROI layout");
  assert(nonSelfCurrentViewSlots.length === 0, "non-self current view must not reuse item-bench slots as selected augment slots");
  assert(!layout.regions?.non_self_current_view_diagnostic_selected_augment_slots, "layout must not keep non-self selected augment ROI slots");
  assert(!layout.regions?.non_self_current_view_diagnostic_item_bench_slots, "layout must not keep non-self item bench ROI slots");
  assert(!layout.regions?.non_self_current_view_diagnostic_special_choice_slots, "layout must not keep non-self special choice ROI slots");
  assert(!layout.regions?.non_self_current_view_diagnostic_traits_panel, "layout must not keep non-self traits panel ROI");
  assert(!(layout.regions?.selected_augment_slots?.opponent_current_view || []).length, "layout must not keep legacy opponent_current_view selected augment slots");
  assert(!layout.regions?.opponent_current_view_selected_augment_slots, "layout must not keep legacy opponent_current_view selected augment ROI slots");
  assert(!layout.regions?.opponent_current_view_item_bench_slots, "layout must not keep legacy opponent_current_view item bench ROI slots");
  assert(!layout.regions?.opponent_current_view_special_choice_slots, "layout must not keep legacy opponent_current_view special choice ROI slots");
  assert(!layout.regions?.opponent_current_view_traits_panel, "layout must not keep legacy opponent_current_view traits panel ROI");

  assert(/Opponent selected augments/.test(contract.icon_recognition_policy?.owner_scope_policy || ""), "contract must explicitly remove opponent selected augment sensing");
  assert(/not product sensing paths/.test(contract.icon_recognition_policy?.owner_scope_policy || ""), "contract must mark opponent side rails/current-view sensing as non-product");
  assert(/reference\/debug candidates only/.test(contract.icon_recognition_policy?.owner_scope_policy || ""), "contract must keep owned augment text-panel OCR diagnostic-only");
  assert(
    /Selected augments require same-match confirmation through the structured augment card/.test(contract.icon_recognition_policy?.promotion_policy || ""),
    "contract must require same-match structured confirmation for final selected augments",
  );
  assert(/owned-augment panel OCR remains diagnostic only/.test(contract.icon_recognition_policy?.promotion_policy || ""), "owned augment text-panel OCR must not promote a final selection");
  assert(/4357 is primary/.test(contract.icon_recognition_policy?.equipment_policy || ""), "contract must preserve 4357 item bench primary source");

  assert(/S=2/i.test(wiki) && /must not/i.test(wiki), "wiki must document S=2 non-product current-view boundary");
  assert(/owned-augment detail panel/i.test(wiki), "wiki must document manual owned augment detail-panel OCR recovery");
  assert(
    /Final selected augments come from same-match structured card confirmation/i.test(wiki),
    "wiki must keep selected augments on structured same-match confirmation",
  );
  assert(/owned-augment text-panel OCR is diagnostic effect-text[\s\S]*cannot write the final selection/i.test(wiki), "wiki must keep owned augment OCR diagnostic-only");
  assert(!/opponent_power inventory rail/i.test(wiki), "wiki must not keep opponent_power inventory rail semantics");
  assert(!/mirrored `opponent` ROI/i.test(wiki), "wiki must not describe opponent selected augment ROI as mirrored");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "layout selected_augment_side_rail_policy",
      "left rail self owner_scope",
      "opponent selected augment ROI removed",
      "layout removes non-self selected augment slots",
      "contract marks opponent current-view side rails as non-product",
      "contract keeps owned augment text-panel OCR diagnostic-only",
      "wiki documents S=2 non-product boundary",
      "wiki documents diagnostic owned augment panel recovery",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
