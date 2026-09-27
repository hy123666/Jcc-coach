import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const repoRoot = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, repoRoot), "utf8");
}

function sliceFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert(start >= 0, `${name} must exist`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next >= 0 ? next : source.length);
}

const app = await read("ui/src/App.tsx");
const bridge = await read("ui/src/runtimeBridge.ts");
const service = await read("ui/electron/runtime-service.js");
const activeRules = await read("tools/jcc_active_rules_contract.mjs");
const variablePanel = sliceFunction(app, "VariablePanel");
const manualMigration = sliceFunction(app, "manualVariablesFromRuntime");

assert(bridge.includes("export type SeasonVariableField"), "runtimeBridge must type season variable descriptors");
assert(bridge.includes("season_variable_fields?: SeasonVariableField[]"), "runtimeBridge must expose season variable descriptors from backend options");
assert(bridge.includes("options?: ManualVariableOptions"), "runtimeBridge must expose generic option groups through the backend options field");
assert(
  bridge.includes("seasonVariables: Record<string, string | string[]>"),
  "saveManualVariables payload must carry generic seasonVariables",
);
assert(!bridge.includes("firstGod:"), "runtimeBridge save payload must not keep firstGod as production authority");
assert(!bridge.includes("observer:"), "runtimeBridge save payload must not keep observer as production authority");
assert(!bridge.includes("currentGodFinal:"), "runtimeBridge save payload must not keep currentGodFinal as production authority");
assert(!bridge.includes("psionicWeapons:"), "runtimeBridge save payload must not keep psionicWeapons as production authority");
assert(bridge.includes('control: "single_select" | "multi_select"'), "runtimeBridge descriptor control must match the active-rules compiler");
assert(bridge.includes('section: "primary" | "advanced"'), "runtimeBridge descriptor section must match the active-rules compiler");
assert(bridge.includes("max_items: number"), "runtimeBridge descriptor cardinality must match the active-rules compiler");
assert(bridge.includes("item_labels: string[]"), "runtimeBridge descriptor labels must match the active-rules compiler");

assert(app.includes("setSeasonVariableFields(nextSeasonVariableFields)"), "App must persist backend season_variable_fields");
assert(app.includes("...result.options"), "App must consume the backend generic option groups");
assert(app.includes("seasonVariableFields={seasonVariableFields}"), "Pinned result must pass descriptors into VariablePanel");

assert(variablePanel.includes("seasonVariableFields: SeasonVariableField[]"), "VariablePanel must receive typed field descriptors");
assert(variablePanel.includes("seasonVariableFields.filter"), "VariablePanel must render from field descriptors");
assert(variablePanel.includes("field.option_group ? variableOptions[field.option_group]"), "VariablePanel must use descriptor option_group names");
assert(variablePanel.includes('field.control === "multi_select"'), "VariablePanel must express repeated controls through descriptor control metadata");
assert(variablePanel.includes("field.max_items"), "VariablePanel must use descriptor cardinality");
assert(variablePanel.includes("field.item_labels"), "VariablePanel must use descriptor item labels");
assert(variablePanel.includes('field.section === "advanced"'), "VariablePanel must use descriptor section ownership");
assert(variablePanel.includes("seasonVariables: cleanedSeasonVariables"), "VariablePanel must save generic seasonVariables");
assert(variablePanel.includes("hasSeasonVariables ? \"确认本局变量\" : \"确认本局目标\""), "S18 without descriptor variables must present the common target surface instead of a variable claim");
assert(variablePanel.includes("<span>明确目标</span>"), "target field must not label provisional preferences as durable targets");
assert(!variablePanel.includes("目标或偏好"), "target-only surface must not invite provisional preferences into durable target_plan");
assert(service.includes("const normalizedTarget = String(payload?.target ?? \"\").trim();"), "runtime must trim target text before persistence");
assert(service.includes("target_plan_text: normalizedTarget || null"), "whitespace-only target text must persist as null");
assert(variablePanel.includes("作为本局明确目标"), "the common target surface must explain that an explicitly confirmed target becomes the durable match target");
assert(variablePanel.includes("setSeasonDraft((current) => Object.fromEntries"), "VariablePanel must drop draft values absent from active descriptors");
assert(!variablePanel.includes("firstGod"), "VariablePanel must not render hardcoded S17 firstGod");
assert(!variablePanel.includes("secondGod"), "VariablePanel must not render hardcoded S17 secondGod");
assert(!variablePanel.includes("observer"), "VariablePanel must not render hardcoded S17 observer");
assert(!variablePanel.includes("currentGodFinal"), "VariablePanel must not render hardcoded S17 final god");
assert(!variablePanel.includes("psionicWeapons"), "VariablePanel must not render hardcoded S17 psionic weapons");
assert(!variablePanel.includes("stargazing"), "VariablePanel must not render hardcoded S17 stargazing");
assert(!variablePanel.includes("psionic_weapons"), "VariablePanel must not render hardcoded S17 psionic option group");
assert(manualMigration.includes("seasonVariableFields.map"), "legacy flat state migration must use active descriptors");
for (const legacyKey of ["god_options", "stargazing", "current_god_final", "psionic_weapons"]) {
  assert(!manualMigration.includes(legacyKey), `generic state migration must not name ${legacyKey}`);
}

assert(service.includes("season_variables: seasonVariables"), "runtime service must persist generic season variables under one field");
assert(service.includes("values.season_variables"), "runtime service must project generic season variables into match context");
assert(activeRules.includes("collectRuntimeManualVariableFields"), "active-rules compiler must own manual-variable descriptors");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-season-variable-panel-runtime-verifier-v1",
  checked: [
    "runtimeBridge save payload is target + generic seasonVariables",
    "runtimeBridge consumes backend season_variable_fields and options",
    "frontend descriptor names match the active-rules compiler",
    "App passes descriptors into VariablePanel",
    "VariablePanel renders fields from descriptors and option_group names",
    "VariablePanel prunes fields missing from the active descriptor list",
    "legacy flat state migration is descriptor-driven and season-neutral",
    "runtime persists one generic season_variables object",
  ],
}, null, 2));
