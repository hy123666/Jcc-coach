import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeHostCoachResponse } from "../ui/electron/runtime-service.js";

const [evidencePath, reportPath] = process.argv.slice(2);
assert(evidencePath, "Usage: node tools/verify-jcc-rejected-response-replay.mjs EVIDENCE_JSON [REPORT_JSON]");
const raw = await readFile(evidencePath, "utf8");
const entries = JSON.parse(raw);
assert(Array.isArray(entries) && entries.length, "replay requires captured Provider responses and original sealed requests");
const results = entries.map(({ response, request, error }) => {
  const normalized = normalizeHostCoachResponse(response, request);
  assert.equal(normalized.final_text, response.final_text, "normalization must not delete the offending explanation to pass");
  assert.equal(normalized.strategic_obligation_coverage?.ok, true);
  const candidates = normalized.runtime_materialization?.candidate_presentations || [];
  const selected = response.strategy_selection.selected_candidate_refs;
  assert.equal(candidates.length, selected.length);
  for (const ref of selected) {
    const candidate = candidates.find((entry) => entry.candidate_id === ref.candidate_id);
    assert(candidate?.unit_names?.length > 0);
    assert.equal(candidate.selected_variant_id, ref.selected_variant_id);
    assert.equal(candidate.candidate_evidence_id, ref.candidate_evidence_id);
  }
  const invalid = structuredClone(response);
  invalid.strategy_selection.selected_candidate_refs[0].selected_variant_id = "invalid:foreign-variant";
  assert.throws(() => normalizeHostCoachResponse(invalid, request), /strategic obligation incomplete/,
    "allowing variant explanations must not allow a foreign selected variant");
  return { request_id: request.request_id, original_error: error, validation: "passed",
    original_body_preserved: true, selected_candidate_count: candidates.length,
    roster_sizes: candidates.map((entry) => entry.unit_names.length),
    foreign_variant_rejected: true, provider_retries: 0 };
});
const report = { ok: true, schema: "jcc-rejected-response-replay-v1",
  execution: "captured_real_provider_response_replayed_locally_no_provider_call",
  evidence_sha256: createHash("sha256").update(raw).digest("hex"), results };
if (reportPath) {
  await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
