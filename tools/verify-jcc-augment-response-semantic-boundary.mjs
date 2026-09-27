import assert from "node:assert/strict";
import { buildHostCoachNativeOutputSchema } from "../ui/electron/host-coach-response-contract.js";
import { normalizeAugmentChoiceRecommendation as normalize } from "../ui/electron/runtime-service.js";

const expected = ["飞升", "打捞桶+", "星界赐福 II"];
const base = { candidate_ranking: expected, refresh_action: "keep_and_pick", refresh_slots: [] };
const providerSchema = buildHostCoachNativeOutputSchema({ augmentCandidateNames: expected });
assert.deepEqual(providerSchema.properties.choice_handoff.properties.ui_action.enum, ["select", "refresh", "none"]);
assert.deepEqual(providerSchema.properties.choice_handoff.properties.ordered_refs.items.enum, expected);
assert(!providerSchema.properties.choice_recommendation, "Provider transport must not require the legacy strategy-rich choice object");
for (const action of ["keep", "keep_and_pick", "keepAndPick", "keep and pick"]) {
  const result = normalize({ ...base, refresh_action: action });
  assert.equal(result, null, "without a sealed expected set no recommendation is accepted");
  assert.equal(normalize({ ...base, refresh_action: action }, expected)?.refresh_action, "keep_and_pick");
}
for (const name of ["星界赐福II", "星界赐福Ⅱ", "星界赐福2", "星界赐福 ２"]) {
  const result = normalize({ ...base, candidate_ranking: ["飞升", "打捞桶＋", name], selected_candidate: name }, expected);
  assert.deepEqual(result?.candidate_ranking, expected);
  assert.equal(result?.selected_candidate, expected[2]);
}
for (const bad of [
  { candidate_ranking: ["飞升", "打捞桶", "星界赐福II"] },
  { candidate_ranking: ["飞升", "打捞桶+", "星界赐福III"] },
  { candidate_ranking: ["飞升", "飞升", "星界赐福II"] },
  { candidate_ranking: [] }, { refresh_action: "no_refresh" }, { refresh_action: "refresh" },
  { refresh_slots: [true] }, { refresh_slots: [9] },
  { refresh_action: "refresh_specific", refresh_slots: [] },
]) assert.equal(normalize({ ...base, ...bad }, expected), null, JSON.stringify(bad));
assert.equal(normalize(base, ["飞升", "星界赐福2", "星界赐福 II"]), null, "ambiguous expected identities fail closed");
assert.equal(normalize({ ...base, refresh_action: "refresh_specific", refresh_slots: "2" }, expected)?.refresh_slots[0], 2);
console.log(JSON.stringify({ ok: true, checked: ["minimal_choice_handoff_schema", "explicit_keep_alias", "expected_set_bound_tier_alias", "plus_and_tier_not_dropped", "missing_and_ambiguous_fail_closed", "invalid_slots_not_silently_filtered"] }));
