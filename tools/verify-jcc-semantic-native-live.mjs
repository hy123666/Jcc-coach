import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { detectHostAgent, runHostAgentRequest, closeHostAgentSession } from "../ui/electron/host-adapters.js";
import { createDecisionMathService } from "../ui/electron/decision-math-service.js";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { createHostReadonlyToolBroker } from "../ui/electron/host-readonly-tool-broker.js";

const root = path.resolve(import.meta.dirname, "..");
const paths = createRuntimePaths(root);
const catalog = JSON.parse(await readFile(paths.activeDecisionInputCatalogFile, "utf8"));
const service = await createDecisionMathService({
  hardDataPackageDir: path.dirname(path.join(root, paths.activeHardDataManifest)),
  coreProfileFile: paths.activeCoreProfileFile,
  decisionInputCatalogFile: paths.activeDecisionInputCatalogFile,
  expectedIdentity: catalog.source_identity,
});
const model = process.env.JCC_CODEX_MODEL || "gpt-5.6-luna";
const effort = process.env.JCC_CODEX_REASONING_EFFORT || "medium";
const adapter = await detectHostAgent({ provider: "codex", model, reasoning_effort: effort });
assert.ok(adapter.available, adapter.error);
assert.equal(adapter.selected_model, model, adapter.model_options_error);
assert.equal(adapter.reasoning_effort, effort);
console.log(JSON.stringify({ selected_model: adapter.selected_model, effort: adapter.reasoning_effort, command: adapter.command }));
const temp = await mkdtemp(path.join(os.tmpdir(), "jcc-semantic-native-live-"));
const reports = [];
try {
  for (const kind of ["daily", "match"]) {
    const route = `${kind}:semantic-live-${Date.now()}`;
    const broker = createHostReadonlyToolBroker({
      evidencePacket: { evidence_snapshot: { evidence_snapshot_id: catalog.source_identity.core_profile_id || "active-core-simulation" } },
      queryKnowledge: async (args) => service.queryKnowledge(args),
      calculate: async (question) => service.calculateQuestion(question),
      assertFresh: async () => assert.deepEqual(JSON.parse(await readFile(paths.activeDecisionInputCatalogFile, "utf8")).source_identity, catalog.source_identity),
    });
    const started = Date.now();
    let result;
    try {
      result = await runHostAgentRequest(adapter, [
        "This is an isolated JCC Runtime transport simulation, not a live match. Answer in Chinese.",
        "Use jcc.query_knowledge to retrieve the current Core effect before answering. Do not use shell or exec.",
        "Also call jcc.calculate with question: 从7级升8级还需要多少经验和金币. If inputs are missing, report that limitation.",
        "User: 获得21金币，蔓延之根，是我这把3-2的两个强化，我已经有地狱火转了。目前5级，有血量，有质量，你觉得这两个我选哪个？",
        "Return a JSON object with final_text. Explain reward timing from retrieved facts, not user assumptions. Do not invent random rewards.",
      ].join("\n"), {
        hostSessionKey: route, taskId: route, repoRoot: root, hostCwd: temp,
        parseJson: true, jsonResponseKind: "coach", timeoutMs: 300000,
        onReadonlyToolCall: (name, args) => broker.call(name, args),
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.readonly_tool_mode, "native_dynamic_tools");
      assert.ok(result.capability_receipt.observed_tool_calls.includes("jcc.query_knowledge"));
      assert.ok(result.capability_receipt.observed_tool_calls.includes("jcc.calculate"));
      assert.match(result.response.final_text, /3|三/);
      reports.push({ kind, ok: true, model, effort, elapsed_ms: Date.now() - started,
        receipt: result.capability_receipt, tool_audit: broker.audit, final_text: result.response.final_text });
      console.log(JSON.stringify(reports.at(-1)));
    } catch (error) {
      reports.push({ kind, ok: false, model, effort,
        elapsed_ms: Date.now() - started, error: error.message,
        receipt: result?.capability_receipt, tool_audit: broker.audit,
        response: result?.response, events: result?.events,
      });
      console.log(JSON.stringify(reports.at(-1)));
    } finally { await closeHostAgentSession(route); }
  }
} finally { await rm(temp, { recursive: true, force: true }); }
console.log(JSON.stringify({ ok: reports.every((row) => row.ok), schema: "jcc-semantic-native-live-v1", completed_routes: reports.length }));
if (reports.some((row) => !row.ok)) process.exitCode = 1;
