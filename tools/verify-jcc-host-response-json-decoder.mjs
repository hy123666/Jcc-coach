import assert from "node:assert/strict";
import {
  decodeHostJsonObject,
  parseHostJsonObject,
} from "../ui/electron/host-response-json.js";
import { extractJsonFromModelText } from "../ui/electron/host-adapters.js";

const expected = {
  schema: "jcc-host-cli-coach-response-v1",
  generated_by: "current_cli_agent_main_model",
  request_id: "decoder-test",
  final_text: "brace in string: } and escaped quote: \\\"",
};

assert.deepEqual(parseHostJsonObject(JSON.stringify(expected)), expected);
assert.deepEqual(parseHostJsonObject(`\uFEFF\n\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``), expected);
const camelCaseCoach = {
  responseSchema: "jcc-host-cli-coach-response-v1",
  generatedBy: "current_cli_agent_main_model",
  finalText: "camel case transport alias",
};
assert.deepEqual(parseHostJsonObject(JSON.stringify(camelCaseCoach)), camelCaseCoach);

const adjacent = decodeHostJsonObject(`${JSON.stringify(expected)}${JSON.stringify({ diagnostic: true })}`);
assert.deepEqual(adjacent.value, expected);
assert.equal(adjacent.trailing, JSON.stringify({ diagnostic: true }));

const providerFirst = decodeHostJsonObject(`${JSON.stringify({ schema: "provider-debug-v1", text: "internal status" })}\n${JSON.stringify(expected)}`);
assert.deepEqual(providerFirst.value, expected);
assert.match(providerFirst.prefix, /provider-debug-v1/);

const prose = decodeHostJsonObject(`model preface\n${JSON.stringify(expected)}\nfinished`);
assert.deepEqual(prose.value, expected);
assert.equal(prose.prefix, "model preface");
assert.equal(prose.trailing, "finished");

assert.throws(() => parseHostJsonObject("not json"), (error) => {
  assert.equal(error.code, "JCC_HOST_JSON_PARSE_FAILED");
  assert.equal(error.message, "host_cli_json_parse_failed");
  return true;
});
assert.throws(() => parseHostJsonObject('{"incomplete":true'), /host_cli_json_parse_failed/);
assert.throws(
  () => parseHostJsonObject(`${JSON.stringify(expected)}${JSON.stringify({ ...expected, request_id: "second" })}`),
  (error) => error.reason === "ambiguous_multiple_coach_response_objects",
);
assert.throws(
  () => parseHostJsonObject(JSON.stringify({ schema: "provider-debug-v1", text: "not a coach response" })),
  (error) => error.reason === "coach_response_object_missing",
);
assert.throws(
  () => parseHostJsonObject(JSON.stringify({ generated_by: "current_cli_agent_main_model", status: "thinking" })),
  (error) => error.reason === "coach_response_object_missing",
  "a marker-only provider diagnostic must not compete with a complete coach response",
);
const markerDiagnosticBeforeCoach = decodeHostJsonObject(
  `${JSON.stringify({ generated_by: "current_cli_agent_main_model", status: "thinking" })}\n${JSON.stringify(expected)}`,
);
assert.deepEqual(markerDiagnosticBeforeCoach.value, expected);
assert.deepEqual(
  extractJsonFromModelText(JSON.stringify({ schema: "protocol-smoke-v1", ok: true }), { jsonResponseKind: "raw" }).value,
  { schema: "protocol-smoke-v1", ok: true },
  "raw JSON mode is only for transport smoke tests and must not alter coach validation",
);
assert.throws(
  () => extractJsonFromModelText(JSON.stringify({ schema: "unregistered-v1", final_text: "not a registered response kind" }), { jsonResponseKind: "unknown" }),
  /Unsupported JSON response kind: unknown/,
  "unregistered response kinds must not fall back to accepting arbitrary JSON",
);
assert.throws(
  () => parseHostJsonObject("{".repeat(200000)),
  (error) => error.reason === "response_too_complex",
  "pathological unmatched braces must fail inside the parser scan budget",
);

console.log(JSON.stringify({
  ok: true,
  checks: [
    "pure_json_object",
    "fenced_json_object",
    "provider_diagnostic_before_coach_is_quarantined",
    "adjacent_non_coach_json_is_diagnostic_only",
    "multiple_coach_objects_are_rejected_as_ambiguous",
    "objects_without_final_text_are_not_coach_responses",
    "bounded_camel_case_transport_aliases",
    "prefix_and_trailing_text_are_diagnostics",
    "escaped_braces_and_quotes",
    "malformed_json_uses_internal_error_code",
    "pathological_unmatched_braces_are_bounded",
  ],
}, null, 2));
