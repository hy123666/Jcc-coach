export const PRODUCT_GATE_LAYERS = Object.freeze(["deterministic", "provider_contract", "live_acceptance"]);
export const PRODUCT_GATE_FAILURE_TYPES = Object.freeze(["product_regression", "test_fixture_failure", "environment_failure", "known_compatibility_failure"]);
export function gateLayerForCheck(check = {}) {
  if (check.layer && PRODUCT_GATE_LAYERS.includes(check.layer)) return check.layer;
  throw new Error(`product_gate_layer_required:${check.id || "<missing id>"}`);
}
export function classifyProductGateFailure({ layer = "deterministic", checkId = "", timedOut = false, exitCode = null, parsed = null, spawnError = null } = {}) {
  let failureType = "product_regression";
  let evidence = timedOut ? "check_timeout_requires_investigation" : "unclassified_failure_requires_investigation";
  const declared = parsed?.failure;
  if (spawnError) {
    failureType = "environment_failure";
    evidence = `runner_spawn_error:${spawnError}`;
  } else if (!timedOut && PRODUCT_GATE_FAILURE_TYPES.includes(declared?.failure_type)
    && typeof declared.evidence === "string" && declared.evidence.trim()
    && (declared.failure_type !== "known_compatibility_failure" || declared.issue_ref)) {
    failureType = declared.failure_type;
    evidence = declared.evidence;
  }
  return { layer, failure_type: failureType, evidence, issue_ref: declared?.issue_ref || null, blocking: true, check_id: checkId, exit_code: exitCode };
}
