import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const contractPath = path.resolve(moduleDirectory, "../../data/runtime/jcc/host-context-lifecycle-contract.json");
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const budgets = contract.request_architecture?.size_budgets || {};

export const HOST_STATIC_CAPSULE_ABSOLUTE_MAX_BYTES = Number(budgets.static_capsule_max_bytes);
export const HOST_TURN_DELTA_TARGET_BYTES = Number(budgets.turn_delta_target_bytes);
export const HOST_TURN_DELTA_ABSOLUTE_MAX_BYTES = Number(budgets.turn_delta_max_bytes);
export const HOST_STRATEGIC_TURN_DELTA_TARGET_BYTES = Number(budgets.strategic_turn_delta_target_bytes);
export const HOST_STRATEGIC_TURN_DELTA_ABSOLUTE_MAX_BYTES = Number(budgets.strategic_turn_delta_max_bytes);
export const QUICK_RECORD_TURN_TARGET_BYTES = Number(budgets.quick_record_turn_target_bytes);
export const QUICK_RECORD_TURN_MAX_BYTES = Number(budgets.quick_record_turn_max_bytes);
export const MANUAL_MATCH_VARIABLES_TURN_TARGET_BYTES = Number(budgets.manual_match_variables_turn_target_bytes);
export const HOST_READONLY_TOOL_MIN_RESERVE_BYTES = Number(budgets.native_tool_minimum_reserve_bytes);
export const SUCCESSFUL_HOST_DIAGNOSTIC_MAX_BYTES = Number(budgets.successful_diagnostic_max_bytes);

for (const [name, value] of Object.entries({
  HOST_STATIC_CAPSULE_ABSOLUTE_MAX_BYTES,
  HOST_TURN_DELTA_TARGET_BYTES,
  HOST_TURN_DELTA_ABSOLUTE_MAX_BYTES,
  HOST_STRATEGIC_TURN_DELTA_TARGET_BYTES,
  HOST_STRATEGIC_TURN_DELTA_ABSOLUTE_MAX_BYTES,
  QUICK_RECORD_TURN_TARGET_BYTES,
  QUICK_RECORD_TURN_MAX_BYTES,
  MANUAL_MATCH_VARIABLES_TURN_TARGET_BYTES,
  HOST_READONLY_TOOL_MIN_RESERVE_BYTES,
  SUCCESSFUL_HOST_DIAGNOSTIC_MAX_BYTES,
})) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name} in ${contractPath}`);
  }
}

export const HOST_BUDGET_CONTRACT_PATH = contractPath;
