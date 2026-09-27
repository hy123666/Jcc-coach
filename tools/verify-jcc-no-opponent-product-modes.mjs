import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function assertNotIncludes(text, needle, file) {
  assert(!text.includes(needle), `${file} must not contain ${needle}`);
}

async function main() {
  const files = [
    "ui/src/runtimeBridge.ts",
    "ui/src/App.tsx",
    "ui/DESIGN.md",
    "ui/OPEN_DESIGN.md",
    "ui/IA.md",
    "ui/electron/preload.js",
    "ui/electron/runtime-service.js",
    "tools/run-jcc-cruise-runtime-pipeline.mjs",
    "tools/run-jcc-multimodal-runtime-observation.mjs",
    "tools/run-jcc-self-state-roi-ocr.mjs",
    "tools/run-jcc-augment-choice-roi-ocr.mjs",
    "tools/run-jcc-item-choice-roi-ocr.mjs",
    "tools/run-jcc-left-item-rail-roi-icon.mjs",
    "tools/build-jcc-host-agent-context-pack.mjs",
    "data/runtime/jcc/host-request-context-policy-contract.json",
    "data/runtime/jcc/runtime-ui-mode-contract.json",
    "data/runtime/jcc/runtime-mode-sensing-map.json",
    "data/runtime/jcc/runtime-worker-orchestrator-contract.json",
    "data/runtime/jcc/vision-model-sensing-contract.json",
    "data/runtime/jcc/runtime-agent-wiki/official/mumu-desktop-runtime.md",
    "data/runtime/jcc/runtime-agent-wiki/official/quickstart.md",
    ".codex/skills/jcc-runtime-agent/SKILL.md",
    "AGENTS.md",
  ];

  for (const file of files) {
    const text = await read(file);
    if (!file.startsWith("tools/verify-")) {
      assertNotIncludes(text, "opponents.current_view", file);
      assertNotIncludes(text, "visual.opponents", file);
      assertNotIncludes(text, "opponent_current_view", file);
      assertNotIncludes(text, "opponent pressure", file);
    }
    assertNotIncludes(text, "recordOpponentSnapshot", file);
    assertNotIncludes(text, "finishOpponentScan", file);
    assertNotIncludes(text, "opponent_lobby_scans", file);
    assertNotIncludes(text, "opponent_scan_summaries", file);
    assertNotIncludes(text, "Opponent scan", file);
    assertNotIncludes(text, "外面战力分析", file);
    assertNotIncludes(text, "对手战力+对位推荐", file);
    assertNotIncludes(text, "记录当前家", file);
    assertNotIncludes(text, "完成扫描", file);
    assert(!/s=2[^\n.。]*(combat|战斗)|S=2[^\n.。]*(combat|战斗)|(combat|战斗)[^\n.。]*s=2/i.test(text), `${file} must not describe S=2 as combat`);
    if (!file.includes("runtime-mode-sensing-map") && !file.includes("jcc-runtime-agent")) {
      assertNotIncludes(text, "opponent-specific positioning", file);
    }
  }

  const obsoleteDebugTools = (await readdir(path.join(root, "tools")))
    .filter((name) => /legacy.*debug|debug.*legacy/i.test(name));
  assert.deepEqual(
    obsoleteDebugTools,
    [],
    `obsolete legacy/debug sensing tools must be deleted, found: ${obsoleteDebugTools.join(", ")}`,
  );

  const bridge = await read("ui/src/runtimeBridge.ts");
  assert(!/RuntimeModeId[\s\S]*\|\s*"scan"/.test(bridge), "runtimeBridge RuntimeModeId must not expose scan mode");
  assert(!/RuntimeModeId[\s\S]*\|\s*"position"/.test(bridge), "runtimeBridge RuntimeModeId must not expose position mode");
  assert(!/scan\s*:\s*"opponent_power"/.test(bridge), "runtimeBridge must not map scan to opponent_power");
  assert(!/position\s*:\s*"opponent_positioning"/.test(bridge), "runtimeBridge must not map position to opponent_positioning");

  const app = await read("ui/src/App.tsx");
  assert(!/{\s*id:\s*"scan"/.test(app), "App mode list must not expose scan mode");
  assert(!/{\s*id:\s*"position"/.test(app), "App mode list must not expose position mode");
  assert(!/activeMode\s*===\s*"scan"/.test(app), "App must not render scan mode controls");
  assert(!/activeMode\s*===\s*"position"/.test(app), "App must not render position mode controls");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "opponent_power/opponent_positioning are absent from active product contracts",
      "scan/position UI modes are absent",
      "opponent-shaped visual facts and old scan UI copy are absent from product surfaces",
      "S=2 is not described as combat state",
      "obsolete legacy/debug sensing tools are physically absent from tools/",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
