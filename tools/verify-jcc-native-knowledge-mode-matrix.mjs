import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHostReadonlyToolBroker } from "../ui/electron/host-readonly-tool-broker.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiModes = JSON.parse(await readFile(
  path.join(repoRoot, "data/runtime/jcc/runtime-ui-mode-contract.json"),
  "utf8",
));

const expectedReadRoutes = new Map([
  ["daily_chat", { operation: "search_lineups" }],
  ["augment_choice", { operation: "get_related_entities" }],
  ["item_choice", { operation: "get_related_entities" }],
  ["postgame_review", { operation: "get_common_knowledge" }],
  ["lineup_card", { operation: "get_lineup", candidate_id: "candidate:lineup-card" }],
]);

const observed = [];
for (const mode of Object.keys(uiModes.modes || {})) {
  const route = expectedReadRoutes.get(mode);
  if (!route) {
    observed.push({ mode, route: "runtime_only", native_tool_call: false });
    continue;
  }
  const broker = createHostReadonlyToolBroker({
    evidencePacket: {
      evidence_snapshot: { evidence_snapshot_id: `evidence:mode:${mode}` },
      plan: { evidence_policy_id: "current_match_bound" },
      coverage: { receipts: [] },
    },
    queryKnowledge: async (args) => ({
      status: "ok",
      mode,
      operation: args.operation,
      candidate_id: args.candidate_id || null,
    }),
  });
  const result = await broker.call("jcc.query_knowledge", route);
  assert.equal(result.ok, true, `${mode} must use the native JCC knowledge broker`);
  assert.equal(result.schema, "jcc-query-knowledge-result-v2");
  assert.equal(result.result.mode, mode);
  assert.equal(result.result.operation, route.operation);
  assert.equal(JSON.stringify(result).includes("functions.exec"), false);
  assert.equal(JSON.stringify(result).includes("tools.jcc__query_knowledge"), false);
  observed.push({ mode, route: "jcc.query_knowledge", native_tool_call: true });
}

assert.equal(observed.some((entry) => entry.mode === "lineup_card" && entry.native_tool_call), true,
  "lineup-card mode must be able to retrieve exact candidate evidence through the native tool");
assert.equal(observed.some((entry) => entry.mode === "refresh_self_state" && !entry.native_tool_call), true,
  "self-state refresh remains a Runtime-owned sensing path, not a knowledge-tool call");

const calculationBroker = createHostReadonlyToolBroker({
  evidencePacket: {
    evidence_snapshot: { evidence_snapshot_id: "evidence:mode:calculate" },
    plan: { evidence_policy_id: "current_core_bound" },
    coverage: { receipts: [] },
  },
  calculate: async (question) => ({ question, answer: "deterministic-fixture-result" }),
});
const calculation = await calculationBroker.call("jcc.calculate", { question: "计算当前 Core 的测试公式" });
assert.equal(calculation.ok, true, "the native calculate tool must remain callable for deterministic Runtime calculations");
assert.equal(calculation.schema, "jcc-calculate-tool-result-v1");
assert.equal(calculation.result.answer, "deterministic-fixture-result");
assert.equal(JSON.stringify(calculation).includes("functions.exec"), false);

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-native-knowledge-mode-matrix-verification-v1",
  checked: observed,
  invariant: "knowledge reads use jcc.query_knowledge, deterministic math uses jcc.calculate, Runtime sensing remains separate",
}, null, 2));
