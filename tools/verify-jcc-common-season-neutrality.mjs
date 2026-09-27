import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import {
  collectRuntimeManualVariableFields,
  loadActiveRulesBundle,
} from "./jcc_active_rules_contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

const commonExecutableSurfaces = [
  "ui/src/App.tsx",
  "ui/src/runtimeBridge.ts",
  "ui/src/components/DecisionInputCard.tsx",
  "ui/electron/runtime-service.js",
  "ui/electron/runtime-daemon.js",
  "tools/build-jcc-runtime-worker-plan.mjs",
  "tools/run-jcc-cruise-runtime-pipeline.mjs",
  "tools/score-jcc-cruise-strategy.mjs",
  "data/runtime/jcc/runtime-ui-mode-contract.json",
  "data/runtime/jcc/runtime-worker-orchestrator-contract.json",
  "data/runtime/jcc/runtime-mode-sensing-map.json",
  "data/runtime/jcc/cruise-strategy-scorer-contract.json",
  "data/runtime/jcc/cruise-agent-output-loop-contract.json",
  "data/runtime/jcc/host-coach-signature-contract.json",
  "data/runtime/jcc/host-request-context-policy-contract.json",
  "data/runtime/jcc/host-coach-instruction-contract.json",
  "data/runtime/jcc/runtime-agent-wiki/README.md",
  "data/runtime/jcc/runtime-agent-wiki/official/mumu-desktop-runtime.md",
];

const forbiddenSeasonLiterals = [
  { label: "hardcoded season id", pattern: /\bS(?:1\d|[2-9]\d+)\b/i },
  { label: "S17 mode id", pattern: /\bgod_sequence\b/i },
  { label: "S17 mechanic label", pattern: /star[-_ ]god/i },
  { label: "S17 Chinese mechanic vocabulary", pattern: /\u661f\u795e|\u89c2\u661f|\u7075\u80fd\u6b66\u5668|\u9524\u77f3/ },
  { label: "S17 legacy UI payload", pattern: /\b(?:firstGod|secondGod|currentGodFinal|psionicWeapons|god_options|stargazing)\b/ },
  { label: "S17 match-variable point access", pattern: /match_variables\?*\.(?:observer|encounter)\b/ },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const relativePath of commonExecutableSurfaces) {
  const source = await readFile(path.join(repoRoot, relativePath), "utf8");
  for (const { label, pattern } of forbiddenSeasonLiterals) {
    assert(!pattern.test(source), `${relativePath} contains ${label}; move it to the active major-season descriptor`);
  }
}

const commonUiContract = JSON.parse(await readFile(path.join(repoRoot, "data/runtime/jcc/runtime-ui-mode-contract.json"), "utf8"));
assert(
  JSON.stringify(commonUiContract.modes?.manual_match_variables?.fields || []) === JSON.stringify(["target_plan"]),
  "common manual-variable UI contract must contain only the season-neutral target plan",
);

const activeBundle = loadActiveRulesBundle({ repoRoot, runtimePaths: createRuntimePaths(repoRoot) });
const activeFields = collectRuntimeManualVariableFields(activeBundle);
const declaredActiveFields = activeBundle.season_special_rules?.mechanics?.manual_variable_fields || [];
assert(Array.isArray(declaredActiveFields), "active major-season manual variable declaration must be an array when present");
assert(activeFields.length === declaredActiveFields.length, "active manual variable fields must exactly match the selected major-season declaration, including an empty declaration");
assert(activeFields.every((field) => field.source_layer === "season_special_rules"), "manual variable fields must be owned by the active major-season rules");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-common-season-neutrality-verifier-v1",
  checked: [
    "common executable and presentation surfaces contain no S17 mode, mechanic, or payload literals",
    "current authoritative Runtime documentation contains no retired-season variable requirements",
    "common manual-variable contract contains only target_plan",
    "active manual-variable fields, including an empty set, compile from the selected major-season rules",
  ],
  active_season: activeBundle.version_identity?.runtime_season_id || null,
  active_manual_variable_fields: activeFields.map((field) => field.key),
}, null, 2));
