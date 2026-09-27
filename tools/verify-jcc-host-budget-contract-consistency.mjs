import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  HOST_STATIC_CAPSULE_ABSOLUTE_MAX_BYTES,
  HOST_TURN_DELTA_TARGET_BYTES,
  HOST_TURN_DELTA_ABSOLUTE_MAX_BYTES,
  HOST_STRATEGIC_TURN_DELTA_TARGET_BYTES,
  HOST_STRATEGIC_TURN_DELTA_ABSOLUTE_MAX_BYTES,
  QUICK_RECORD_TURN_MAX_BYTES,
  MANUAL_MATCH_VARIABLES_TURN_TARGET_BYTES,
  HOST_READONLY_TOOL_MIN_RESERVE_BYTES,
  SUCCESSFUL_HOST_DIAGNOSTIC_MAX_BYTES,
} from "../ui/electron/jcc-host-budget-contract.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const readJson = async (relativePath) => JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));
const readText = (relativePath) => readFile(path.join(repoRoot, relativePath), "utf8");

const lifecycle = await readJson("data/runtime/jcc/host-context-lifecycle-contract.json");
const knowledge = await readJson("data/runtime/jcc/knowledge-profile-contract.json");
const strategyEvidence = await readJson("data/runtime/jcc/strategy-evidence-runtime-contract.json");
const requestPolicy = await readJson("data/runtime/jcc/host-request-context-policy-contract.json");
const quickRecord = await readJson("data/runtime/jcc/match-fact-capture-contract.json");
const readonlyTools = await readJson("data/runtime/jcc/host-readonly-tool-contract.json");
const [agents, skill, runtimeSource, pipelineSource] = await Promise.all([
  readText("AGENTS.md"),
  readText(".codex/skills/jcc-runtime-agent/SKILL.md"),
  readText("ui/electron/runtime-service.js"),
  readText("tools/run-jcc-cruise-runtime-pipeline.mjs"),
]);

const authority = lifecycle.request_architecture.size_budgets;
assert.equal(HOST_STATIC_CAPSULE_ABSOLUTE_MAX_BYTES, authority.static_capsule_max_bytes);
assert.equal(HOST_TURN_DELTA_TARGET_BYTES, authority.turn_delta_target_bytes);
assert.equal(HOST_TURN_DELTA_ABSOLUTE_MAX_BYTES, authority.turn_delta_max_bytes);
assert.equal(HOST_STRATEGIC_TURN_DELTA_TARGET_BYTES, authority.strategic_turn_delta_target_bytes);
assert.equal(HOST_STRATEGIC_TURN_DELTA_ABSOLUTE_MAX_BYTES, authority.strategic_turn_delta_max_bytes);
assert.equal(QUICK_RECORD_TURN_MAX_BYTES, authority.quick_record_turn_max_bytes);
assert.equal(MANUAL_MATCH_VARIABLES_TURN_TARGET_BYTES, authority.manual_match_variables_turn_target_bytes);
assert.equal(HOST_READONLY_TOOL_MIN_RESERVE_BYTES, authority.native_tool_minimum_reserve_bytes);
assert.equal(SUCCESSFUL_HOST_DIAGNOSTIC_MAX_BYTES, authority.successful_diagnostic_max_bytes);
assert.equal(quickRecord.context_budget.absolute_turn_bytes, authority.quick_record_turn_max_bytes);
assert.equal(quickRecord.context_budget.target_turn_bytes, authority.quick_record_turn_target_bytes);
assert.equal(readonlyTools.budget.minimum_reserved_tool_bytes_for_native_turn, authority.native_tool_minimum_reserve_bytes);
assert.equal(knowledge.budgets.successful_diagnostic_max_bytes, authority.successful_diagnostic_max_bytes);
assert.equal(knowledge.budgets.strategic_current_turn_delta_target_bytes, authority.strategic_turn_delta_target_bytes);
assert.equal(knowledge.budgets.strategic_current_turn_delta_max_bytes, authority.strategic_turn_delta_max_bytes);
assert.equal(strategyEvidence.payload_budget.strategic_current_turn_target_bytes, authority.strategic_turn_delta_target_bytes);
assert.equal(strategyEvidence.payload_budget.strategic_current_turn_absolute_bytes, authority.strategic_turn_delta_max_bytes);
assert(requestPolicy.strategy_evidence_kernel_policy.budget.includes("4 MiB")
  && requestPolicy.strategy_evidence_kernel_policy.budget.includes("8 MiB"));
assert(agents.includes("ordinary turns target 1 MiB with a 2 MiB ceiling"));
assert(agents.includes("strategic turns target 4 MiB with an 8 MiB ceiling"));
assert(skill.includes("fixed strategic turns use a 4 MiB soft target and 8 MiB absolute ceiling"));
assert(runtimeSource.includes("./jcc-host-budget-contract.js"), "runtime-service must consume the canonical budget loader");
assert(pipelineSource.includes("jcc-host-budget-contract.js"), "ranking pipeline must consume the canonical budget loader");
assert(!skill.includes("fixed strategic turns use a 2 MiB soft target and 4 MiB absolute ceiling"));
assert(!agents.includes("strategic turns target 2 MiB with a 4 MiB ceiling"));

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-host-budget-contract-consistency-verification-v1",
  authority: {
    ordinary_target_bytes: authority.turn_delta_target_bytes,
    ordinary_max_bytes: authority.turn_delta_max_bytes,
    strategic_target_bytes: authority.strategic_turn_delta_target_bytes,
    strategic_max_bytes: authority.strategic_turn_delta_max_bytes,
    static_capsule_max_bytes: authority.static_capsule_max_bytes,
    quick_record_max_bytes: authority.quick_record_turn_max_bytes,
    manual_match_variables_target_bytes: authority.manual_match_variables_turn_target_bytes,
    native_tool_reserve_bytes: authority.native_tool_minimum_reserve_bytes,
    successful_diagnostic_max_bytes: authority.successful_diagnostic_max_bytes,
  },
}, null, 2));
