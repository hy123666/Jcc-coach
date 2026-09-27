import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runHostAgentRequest } from "../ui/electron/host-adapters.js";
import { buildHostCoachNativeOutputSchema } from "../ui/electron/host-coach-response-contract.js";

// Explicit live verifier: only synthetic data is sent; credentials are copied read-only
// by the production adapter into a disposable home without global skills or hooks.
const root = await mkdtemp(path.join(os.tmpdir(), "jcc-native-schema-live-"));
const previous = process.env.JCC_CODEX_RUNTIME_HOME;
process.env.JCC_CODEX_RUNTIME_HOME = path.join(root, "home");
try {
  const invalidProbe = process.argv.includes("--legacy-invalid");
  const probes = invalidProbe ? [{
    id: "invalid_choice",
    options: { mode: "augment_choice", augmentCandidateNames: ["A", "B", "C"] },
    prompt: 'Return schema jcc-host-cli-coach-response-v1, generated_by current_cli_agent_main_model, final_text "probe", choice_handoff {selected_ref:"A",ordered_refs:["A","B","C"],ui_action:"select",refresh_slots:[]}.',
  }] : [
    {
      id: "ordinary_text",
      options: { mode: "chat" },
      prompt: 'Return schema jcc-host-cli-coach-response-v1, generated_by current_cli_agent_main_model, and final_text "probe".',
    },
    {
      id: "choice_handoff",
      options: { mode: "augment_choice", augmentCandidateNames: ["A", "B", "C"] },
      prompt: 'Return schema jcc-host-cli-coach-response-v1, generated_by current_cli_agent_main_model, final_text "probe", choice_handoff {selected_ref:"A",ordered_refs:["A","B","C"],ui_action:"select",refresh_slots:[]}.',
    },
    {
      id: "candidate_refs",
      options: { mode: "strategic_checkpoint", strategicDecisionKeys: ["direction"], strategicCandidateIds: ["candidate-a"], strategicContractRequired: true },
      prompt: 'Return schema jcc-host-cli-coach-response-v1, generated_by current_cli_agent_main_model, final_text "probe", candidate_refs [{candidate_id:"candidate-a",variant_id:null,candidate_evidence_id:null}].',
    },
    {
      id: "lineup_handoff",
      options: { mode: "lineup_card", lineupCard: true },
      prompt: 'Return schema jcc-host-cli-coach-response-v1, generated_by current_cli_agent_main_model, final_text "probe", lineup_handoff {candidate_id:"candidate-a",variant_id:null,target_source:"ranking",target_identity:"candidate-a",adjustments:[],equipment_priority:[],positioning_intent:null}.',
    },
    {
      id: "fact_capture",
      options: { mode: "match_fact_capture", factCapture: true },
      prompt: 'Return schema jcc-host-cli-coach-response-v1, generated_by current_cli_agent_main_model, final_text "probe", fact_capture {schema:"jcc-match-fact-capture-v1",operations:[],unresolved:[]}.',
    },
  ];
  const results = [];
  for (const probe of probes) {
    const schema = buildHostCoachNativeOutputSchema(probe.options);
    if (invalidProbe) {
      schema.properties.choice_handoff.additionalProperties = true;
      schema.properties.choice_handoff.required = [];
    }
    let result;
    try {
      result = await runHostAgentRequest({ provider: "codex", command: "codex", available: true },
        `This is a synthetic JSON schema transport probe. No tools, no game advice. ${probe.prompt}`,
        { repoRoot: root, hostCwd: path.join(root, "cwd"), parseJson: true, outputSchema: schema, timeoutMs: 60000 });
    } catch (error) {
      result = { ok: false, error: error?.message || String(error), stderr: "", stdout: "" };
    }
    const diagnostics = `${result.error || ""}\n${result.stderr || ""}\n${result.stdout || ""}`;
    const schemaRejected = /invalid.*schema|additionalProperties|required.*supplied|schema.*invalid/is.test(diagnostics);
    results.push({
      id: probe.id,
      ok: result.ok,
      native_output_schema_applied: result.native_output_schema_applied || false,
      schema_rejected: schemaRejected,
      error: result.error || null,
      diagnostics: result.ok ? null : diagnostics.slice(-5000),
      response: result.response || null,
    });
  }
  const ok = invalidProbe
    ? results[0].schema_rejected
    : results.every((result) => result.ok && result.native_output_schema_applied);
  console.log(JSON.stringify({
    ok,
    schema: "jcc-host-native-schema-live-verification-v2",
    legacy_invalid: invalidProbe,
    probes: results,
  }, null, 2));
  if (invalidProbe) {
    assert(results[0].schema_rejected, "local preflight must reject invalid schema before Provider dispatch");
  } else {
    for (const result of results) {
      assert.equal(result.ok, true, `${result.id} requires a live native structured response`);
      assert.equal(result.native_output_schema_applied, true, `${result.id} must use the native output schema`);
    }
    assert.deepEqual(results.find((entry) => entry.id === "choice_handoff")?.response?.choice_handoff?.ordered_refs, ["A", "B", "C"]);
    assert.equal(results.find((entry) => entry.id === "candidate_refs")?.response?.candidate_refs?.[0]?.candidate_id, "candidate-a");
    assert.equal(results.find((entry) => entry.id === "lineup_handoff")?.response?.lineup_handoff?.candidate_id, "candidate-a");
    assert.deepEqual(results.find((entry) => entry.id === "fact_capture")?.response?.fact_capture?.operations, []);
  }
} finally {
  if (previous === undefined) delete process.env.JCC_CODEX_RUNTIME_HOME;
  else process.env.JCC_CODEX_RUNTIME_HOME = previous;
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
