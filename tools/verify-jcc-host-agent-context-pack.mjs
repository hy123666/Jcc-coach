import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildModeSummaries, buildPack, writePack } from "./build-jcc-host-agent-context-pack.mjs";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { createActiveCoreProfileSnapshot } from "./jcc_test_core_profile_fixture.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const startup = await buildPack({ scope: "startup", outDir: "unused" });
  const activePaths = createRuntimePaths(path.resolve(import.meta.dirname, ".."));
  const seasonVersionSnapshot = createActiveCoreProfileSnapshot(path.resolve(import.meta.dirname, ".."), {
    capturedAt: new Date().toISOString(),
    runtimePaths: activePaths,
  });
  const matchBinding = {
    seasonVersionSnapshot,
    expectedCoreProfileId: activePaths.activeCoreProfileId,
  };
  const contract = JSON.parse(await readFile("data/runtime/jcc/host-agent-context-pack-contract.json", "utf8"));
  assert(startup.scope === "startup", "startup scope mismatch");
  for (const field of contract.scopes.startup.must_include) {
    assert(startup[field] !== undefined && startup[field] !== null, `startup context pack missing contract field: ${field}`);
  }
  assert(startup.root_skill_path === ".codex/skills/jcc-runtime-agent/SKILL.md", "root skill path mismatch");
  assert(startup.non_negotiables.some((item) => item.includes("host model")), "host model invariant missing");
  assert(startup.non_negotiables.some((item) => item.includes("device_connection")), "device connection invariant missing");
  assert(startup.startup_policy.redundant_or_forbidden.includes("auto-discover MuMu every startup"), "startup MuMu discovery guard missing");
  assert(startup.startup_policy.redundant_or_forbidden.includes("start watcher before Start Match"), "startup watcher guard missing");
  assert(startup.readiness.session_contract === "present", "session contract missing");
  assert(startup.readiness.worker_orchestrator_contract === "present", "worker orchestrator contract missing");
  assert(startup.readiness.season_module_contract === "present", "season module contract missing");
  assert(startup.readiness.retention_budget_contract === "present", "retention budget contract missing");
  assert(startup.worker_orchestration?.visible_voice === "host_cli_agent", "startup pack must expose single host coach voice");
  assert(startup.worker_orchestration?.plan_tool?.includes("build-jcc-runtime-worker-plan"), "startup pack must expose worker plan tool");
  assert(startup.worker_orchestration?.optional_specialist_agents?.policy?.includes("structured_packets_only"), "startup pack must expose specialist packet policy");
  assert(startup.worker_orchestration?.optional_specialist_agents?.model_policy?.includes("inherit host CLI default"), "startup pack must expose specialist model inheritance policy");
  assert(startup.worker_orchestration?.optional_specialist_agents?.lanes?.cruise_strategy_specialist?.must_not_write?.includes("final_user_visible_text"), "startup pack must expose specialist final-text guard");
  assert(startup.active_season_module?.package_id, "startup pack must expose active season module");
  assert(startup.retention_budget?.active_match_structured_state_target_mb <= 10, "startup pack must expose compact retention budget");
  assert(startup.required_node_json_rule?.writer === "tools/write-jcc-host-agent-json.mjs", "startup pack must expose Node JSON writer rule");
  assert(startup.daily_session_entry?.must_not_write?.includes("current_match.live_state"), "startup pack must expose daily session write guard");
  assert(Array.isArray(startup.available_runtime_tools) && startup.available_runtime_tools.some((item) => item.includes("build-jcc-host-agent-context-pack")), "startup pack must expose available runtime tools");
  assert(startup.data_readiness === startup.readiness, "data_readiness should alias readiness facts");
  assert(startup.worker_orchestrator_summary === startup.worker_orchestration, "worker_orchestrator_summary should alias worker orchestration facts");
  assert(startup.tool_hints.some((item) => item.includes("only from Connect/Re-scan MuMu UI action")), "MuMu discovery hint must be user-triggered only");
  assert(startup.tool_hints.some((item) => item.includes("build-jcc-runtime-worker-plan")), "worker plan tool hint missing");
  const activeSpecialModes = (startup.active_rules_bundle?.season_special_rules?.mechanics?.choice_mechanics || [])
    .map((entry) => entry.mode)
    .filter(Boolean);
  for (const modeId of activeSpecialModes) {
    assert(startup.available_mode_ids.includes(modeId), `active major-season mode missing from context pack: ${modeId}`);
  }
  const withoutSpecialMechanics = {
    ...startup.active_rules_bundle,
    season_special_rules: {
      ...startup.active_rules_bundle.season_special_rules,
      mechanics: {
        ...startup.active_rules_bundle.season_special_rules.mechanics,
        choice_mechanics: [],
      },
      host_mode_aliases: {},
    },
  };
  const summariesWithoutSpecialMechanics = buildModeSummaries(withoutSpecialMechanics);
  for (const modeId of activeSpecialModes) {
    assert(!summariesWithoutSpecialMechanics[modeId], `season-only mode leaked into invariant context pack: ${modeId}`);
  }

  const match = await buildPack({ scope: "match", matchSessionId: "jcc-match-test", outDir: "unused", ...matchBinding });
  assert(match.match_session_id === "jcc-match-test", "match session id missing");
  assert(match.start_match_policy.command.includes("start-jcc-new-match-session"), "start match command missing");
  assert(match.session_summary.device_connection?.stop_match_effect === "must_not_disconnect", "Stop Match must not disconnect device_connection");
  assert(match.session_summary.match_session?.clears_on_start?.includes("live_state"), "Start Match must clear live_state");
  assert(match.session_summary.response_task?.cancel_effect?.includes("keep_live_state"), "response_task cancel must preserve live_state");

  for (const modeId of startup.available_mode_ids) {
    const mode = await buildPack({ scope: "mode", mode: modeId, matchSessionId: "jcc-match-test", outDir: "unused", ...matchBinding });
    assert(mode.mode_id === modeId, `mode id mismatch: ${modeId}`);
    assert(mode.mode_context?.purpose, `mode purpose missing: ${modeId}`);
    assert(Array.isArray(mode.mode_context.allowed_sources), `allowed_sources missing: ${modeId}`);
    assert(Array.isArray(mode.mode_context.must_not_write), `must_not_write missing: ${modeId}`);
  }

  let failedWithoutMode = false;
  try {
    await buildPack({ scope: "mode", matchSessionId: "jcc-match-test", outDir: "unused", ...matchBinding });
  } catch {
    failedWithoutMode = true;
  }
  assert(failedWithoutMode, "mode scope must require --mode");

  const skill = await readFile(".codex/skills/jcc-runtime-agent/SKILL.md", "utf8");
  assert(skill.includes("device_connection"), "skill missing device_connection");
  assert(skill.includes("response_task"), "skill missing response_task");
  assert(skill.includes("build-jcc-host-agent-context-pack.mjs --scope startup"), "skill missing startup context command");
  assert(skill.includes("Do not use PowerShell"), "skill missing PowerShell JSON guard");
  assert(skill.includes("Mode-specific context is lazy"), "skill missing lazy mode context rule");
  assert(skill.includes("parallel deterministic workers"), "skill missing deterministic worker orchestration rule");
  assert(skill.includes("optional CLI-native specialist subagents"), "skill missing optional specialist subagent rule");
  assert(skill.includes("jcc-runtime-specialist-analysis-packet-v1"), "skill missing specialist packet contract");
  assert(skill.includes("Season data is swappable"), "skill missing season module rule");
  assert(skill.includes("Keep match artifacts compact"), "skill missing retention budget rule");

  const outputLoop = JSON.parse(await readFile("data/runtime/jcc/cruise-agent-output-loop-contract.json", "utf8"));
  assert(outputLoop.lifecycle_contract?.cancel_response_task?.includes("must not end match_session"), "output loop missing cancel_response_task isolation");

  const mumuRunbook = await readFile("data/runtime/jcc/runtime-agent-wiki/official/mumu-desktop-runtime.md", "utf8");
  assert(mumuRunbook.includes("only when") && mumuRunbook.includes("Detect MuMu and Connect"), "MuMu runbook must make discovery user-triggered");

  const uiSource = await readFile("ui/src/App.tsx", "utf8");
  assert(!uiSource.includes("后台自动扫描 MuMu 实例和端口"), "UI must not imply background MuMu discovery");

  const tempDir = await mkdtemp(path.join(tmpdir(), "jcc-context-pack-"));
  try {
    const written = await writePack(startup, tempDir);
    const raw = await readFile(written.jsonPath, "utf8");
    assert(!raw.startsWith("\uFEFF"), "context JSON must be UTF-8 without BOM");
    JSON.parse(raw);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    ok: true,
    checked_modes: startup.available_mode_ids,
    checked_scopes: ["startup", "match", "mode"],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
