import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "../ui/node_modules/esbuild/lib/main.js";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";

const repoRoot = new URL("../", import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, repoRoot), "utf8");

async function loadRuntimeBridgeExports() {
  const tmp = await mkdtemp(join(tmpdir(), "jcc-runtime-bridge-"));
  const outfile = join(tmp, "runtimeBridge.mjs");
  try {
    await build({ entryPoints: [fileURLToPath(new URL("ui/src/runtimeBridge.ts", repoRoot))], outfile, bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "silent" });
    return { module: await import(pathToFileURL(outfile).href), cleanup: () => rm(tmp, { recursive: true, force: true }) };
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
}

const contract = JSON.parse(await read("data/runtime/jcc/runtime-ui-mode-contract.json"));
const activeDecisionInputCatalog = JSON.parse(await readFile(createRuntimePaths(fileURLToPath(repoRoot)).activeDecisionInputCatalogFile, "utf8"));
const app = await read("ui/src/App.tsx");
const bridge = await read("ui/src/runtimeBridge.ts");
const { module: runtimeBridge, cleanup } = await loadRuntimeBridgeExports();

const fixtureMode = {
  choice_kind: "season_choice",
  renderer: {
    visible_in_match_rail: true,
    ui_mode_key: "season_choice",
    short_label: "赛季选择",
    prompt: "报告当前赛季候选",
    icon_key: "sparkles",
    missing_choice_kinds: ["season_choice"],
    availability: { kind: "active_season_capability", active_season_ids: ["fixture_season"], required_option_groups: ["fixture_choices"] },
  },
  choice_poll_policy: {
    candidate_input_policy: "current_match_user_report",
    user_report_contract: { report_prompt: "报告当前候选", refresh_report_prefix: "更新候选：" },
  },
  card_report_policy: {
    card_type: "generic_choice",
    stage_tabs: ["2-3", "3-3"],
    candidate_count: 2,
    required_fields: ["name"],
    candidate_option_source_key: "fixture_choices",
  },
};

try {
  const { resolveAvailableMatchModes, missingChoicePromptIsAvailable } = runtimeBridge;
  const fixtureModes = resolveAvailableMatchModes({
    activeSeasonId: "fixture_season",
    optionGroups: { fixture_choices: [{ name: "A" }, { name: "B" }] },
    seasonModeDefinitions: { season_choice_sequence: fixtureMode },
  });
  const activeModes = resolveAvailableMatchModes({ activeSeasonId: "s18", optionGroups: {}, seasonModeDefinitions: {} });
  const staleOptionModes = resolveAvailableMatchModes({ activeSeasonId: "s18", optionGroups: { fixture_choices: [{ name: "stale" }] }, seasonModeDefinitions: {} });
  const fixture = fixtureModes.find((mode) => mode.backendMode === "season_choice_sequence");

  assert(fixture, "a descriptor-declared choice mode must be visible for its active season and option group");
  assert.deepEqual(fixture.decisionStages, ["2-3", "3-3"]);
  assert.equal(fixture.candidateCount, 2);
  assert.equal(fixture.candidateOptionSourceKey, "fixture_choices");
  assert(missingChoicePromptIsAvailable({ kind: "season_choice" }, fixtureModes));
  assert(!activeModes.some((mode) => mode.backendMode === "season_choice_sequence"));
  assert(!staleOptionModes.some((mode) => mode.backendMode === "season_choice_sequence"), "stale option data must not resurrect an undeclared mode");
  assert(activeModes.some((mode) => mode.backendMode === "augment_choice"));
  assert(activeModes.some((mode) => mode.backendMode === "item_choice"));
  assert(!missingChoicePromptIsAvailable({ kind: "season_choice" }, staleOptionModes));
  assert(!contract.modes?.season_choice_sequence, "Common UI must not own fixture season modes");
  assert.equal(contract.renderer_mode_policy?.unavailable_mode_behavior, "hide_and_fail_closed");
  assert.deepEqual(contract.modes?.manual_match_variables?.fields, ["target_plan"]);
  assert(Object.values(activeDecisionInputCatalog.entities || {}).every((entry) => ["champion", "augment", "item"].includes(entry.kind)));
  assert(Object.keys(activeDecisionInputCatalog.choice_descriptors || {}).every((kind) => ["augment", "item"].includes(kind)), "typed champion aliases must not create a renderer choice descriptor");
  assert(bridge.includes("seasonModeDefinitions") && bridge.includes("active_season_id"));
  assert(app.includes("availableMatchModes") && app.includes("missingChoicePromptIsAvailable"));

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-season-aware-renderer-modes-verifier-v3",
    checked: [
      "descriptor-declared choice mode visibility",
      "descriptor stage and candidate projection",
      "stale option data cannot resurrect an undeclared mode",
      "active S18 retains only its declared common modes",
      "common variable panel remains season-neutral",
    ],
  }, null, 2));
} finally {
  await cleanup();
}
