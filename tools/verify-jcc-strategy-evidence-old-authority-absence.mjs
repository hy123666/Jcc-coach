import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(repoRoot, relative), "utf8");

const ownedPaths = [
  "data/game-knowledge/jcc/common/strategy-evidence-framework.json",
  "data/runtime/jcc/strategy-evidence-runtime-contract.json",
  "data/runtime/jcc/host-readonly-tool-contract.json",
  "data/runtime/jcc/strategy-evidence-kernel-migration-matrix.json",
  "ui/electron/strategy-evidence-kernel.js",
  "ui/electron/host-readonly-tool-broker.js",
];
const ownedText = (await Promise.all(ownedPaths.map(read))).join("\n");

for (const forbidden of [/\bS17\b/i, /second[_ -]?model[_ -]?planner/i]) {
  assert.equal(forbidden.test(ownedText), false, `retired authority leaked into strategy evidence kernel: ${forbidden}`);
}

const implementationText = (await Promise.all([
  read("ui/electron/strategy-evidence-kernel.js"),
  read("ui/electron/host-readonly-tool-broker.js"),
])).join("\n");
for (const forbidden of [/GraphRAG/i, /vector[_ -]?database/i, /embedding[_ -]?retrieval/i]) {
  assert.equal(forbidden.test(implementationText), false, `retired implementation leaked into strategy evidence kernel: ${forbidden}`);
}

const runtime = await read("ui/electron/runtime-service.js");
assert.match(runtime, /buildStrategyEvidenceKernelPacket/);
assert.match(runtime, /activeCoreKnowledgeBundle\?\.common\?\.strategy_evidence_framework/);
assert.doesNotMatch(runtime, /strategyEvidenceFrameworkFile/);
assert.match(runtime, /strategy_evidence_plan/);
assert.match(runtime, /strategy_evidence_coverage/);
assert.match(runtime, /createReadonlyBrokerForHostTurn/);
assert.doesNotMatch(runtime, /runStrategyEvidencePlannerModel|invokeEvidencePlannerModel/);

const migration = JSON.parse(await read("data/runtime/jcc/strategy-evidence-kernel-migration-matrix.json"));
assert.ok(migration.absence_guards.includes("no model call dedicated only to planning"));
assert.ok(migration.absence_guards.includes("no single-route truncation of a multi-domain question"));

console.log(JSON.stringify({ ok: true, schema: "jcc-strategy-evidence-old-authority-absence-verification-v1" }));
