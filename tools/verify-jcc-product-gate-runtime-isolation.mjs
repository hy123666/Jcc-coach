import assert from "node:assert/strict";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const productionDataRoot = path.join(root, ".jcc-runtime-data");
const runtimeDataRoot = path.resolve(process.env.JCC_RUNTIME_DATA_DIR || "");
const gateDataRoot = path.resolve(process.env.JCC_PRODUCT_GATE_ISOLATED_RUNTIME_DATA_DIR || "");

assert(process.env.JCC_PRODUCT_GATE_ISOLATED_RUNTIME_DATA_DIR, "product gate must mark its isolated runtime data root");
assert.equal(runtimeDataRoot, gateDataRoot, "every product-gate child must use the gate-owned runtime data root");
assert.notEqual(runtimeDataRoot, productionDataRoot, "product-gate checks must never use the production canonical runtime data root");

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-product-gate-runtime-isolation-v1",
  checked: [
    "gate_owned_runtime_data_root_is_present",
    "child_runtime_data_root_matches_gate_isolation",
    "production_canonical_runtime_data_is_not_selected",
  ],
}, null, 2)}\n`);
