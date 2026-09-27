#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildHostCoachNativeOutputSchema,
  resolveHostCoachResponseValidationBoundary,
} from "../ui/electron/host-coach-response-contract.js";

const strategicShape = {
  strategicDecisionKeys: ["lineup_direction"],
  strategicCandidateIds: ["candidate-a", "candidate-b"],
};

for (const mode of ["augment_choice", "item_choice"]) {
  const boundary = resolveHostCoachResponseValidationBoundary({
    mode,
    strategicEvidencePresent: true,
    strategicContractRequired: false,
  });
  assert.equal(boundary.choice_mode, true, `${mode} must be recognized as a choice response mode`);
  assert.equal(
    boundary.strategic_candidate_validation_required,
    false,
    `${mode} must not inherit strategic candidate validation from attached strategic evidence`,
  );

  const schema = buildHostCoachNativeOutputSchema({
    mode,
    strategicContractRequired: false,
    ...strategicShape,
  });
  assert.equal(schema.properties.candidate_refs, undefined,
    `${mode} must not inherit a candidate handoff from attached evidence alone`);
}

const augmentSchema = buildHostCoachNativeOutputSchema({
  mode: "augment_choice",
  augmentCandidateNames: ["A", "B", "C"],
  strategicContractRequired: false,
  ...strategicShape,
});
assert(augmentSchema.properties.choice_handoff, "augment choice must expose only its mechanical handoff");
assert.equal(
  augmentSchema.properties.choice_handoff.additionalProperties,
  false,
  "choice native schema must remain within Codex strict-schema subset",
);
assert.equal(
  augmentSchema.properties.choice_handoff.properties.ordered_refs.minItems,
  0,
  "choice transport schema must not reject before Runtime normalization",
);
assert.equal(
  augmentSchema.properties.choice_handoff.properties.ui_action.type,
  "string",
  "choice transport schema must retain the refresh action field for normalization",
);
assert.deepEqual(
  [...augmentSchema.properties.choice_handoff.required].sort(),
  ["ordered_refs", "refresh_slots", "selected_ref", "ui_action"],
  "choice native schema must encode optional semantics as nullable/empty values, not omitted properties",
);

const mergedAugmentBoundary = resolveHostCoachResponseValidationBoundary({
  mode: "augment_choice",
  strategicEvidencePresent: true,
  strategicContractRequired: true,
});
assert.equal(
  mergedAugmentBoundary.strategic_candidate_validation_required,
  true,
  "an explicitly merged augment and strategic task must retain strategic validation",
);
const mergedAugmentSchema = buildHostCoachNativeOutputSchema({
  mode: "augment_choice",
  augmentCandidateNames: ["A", "B", "C"],
  strategicContractRequired: true,
  ...strategicShape,
});
assert(mergedAugmentSchema.properties.choice_handoff, "merged augment must retain its choice handoff");
assert.equal(mergedAugmentSchema.properties.candidate_refs, undefined,
  "merged augment must use one mechanical handoff instead of duplicating candidate identity");
assert.equal(mergedAugmentSchema.properties.strategic_completion, undefined);
assert.equal(mergedAugmentSchema.properties.strategy_selection, undefined);

for (const mode of ["strategic_checkpoint", "lineup_card"]) {
  const boundary = resolveHostCoachResponseValidationBoundary({
    mode,
    strategicEvidencePresent: true,
    strategicContractRequired: true,
    lineupCard: mode === "lineup_card",
  });
  assert.equal(
    boundary.strategic_candidate_validation_required,
    true,
    `${mode} must preserve hard strategic candidate validation`,
  );

  const schema = buildHostCoachNativeOutputSchema({
    mode,
    lineupCard: mode === "lineup_card",
    ...strategicShape,
  });
  if (mode === "strategic_checkpoint") {
    assert(schema.properties.candidate_refs, `${mode} must retain the candidate identity handoff`);
  } else {
    assert.equal(schema.properties.candidate_refs, undefined,
      "lineup_card identity is already carried by lineup_handoff");
  }
  assert.equal(schema.properties.strategic_completion, undefined);
  assert.equal(schema.properties.strategy_selection, undefined);
  if (mode === "lineup_card") {
    assert(schema.properties.lineup_handoff, "lineup_card must retain the materialization handoff");
    assert.equal(schema.properties.pinned_result, undefined);
  }
}

const strategicCruise = resolveHostCoachResponseValidationBoundary({
  mode: "cruise",
  strategicEvidencePresent: true,
  strategicContractRequired: true,
});
assert.equal(
  strategicCruise.strategic_candidate_validation_required,
  true,
  "a cruise turn with an explicit strategic contract must retain strategic validation",
);

const evidenceOnlyCruise = resolveHostCoachResponseValidationBoundary({
  mode: "cruise",
  strategicEvidencePresent: true,
  strategicContractRequired: false,
});
assert.equal(
  evidenceOnlyCruise.strategic_candidate_validation_required,
  false,
  "strategic evidence alone must not create a response obligation outside hard strategic modes",
);

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-host-response-mode-validation-boundary-verifier-v1",
  checked: [
    "augment_choice_ignores_attached_strategic_candidate_contract",
    "item_choice_ignores_attached_strategic_candidate_contract",
    "augment_choice_keeps_minimal_choice_handoff",
    "strategic_checkpoint_keeps_candidate_identity_handoff",
    "lineup_card_keeps_minimal_materialization_handoff",
    "strategic_cruise_keeps_explicit_strategic_contract",
    "evidence_presence_does_not_create_a_generic_strategic_obligation",
  ],
}, null, 2));
