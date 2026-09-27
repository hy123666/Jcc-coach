import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const scannedFiles = [
  "AGENTS.md",
  ".codex/skills/jcc-runtime-agent/SKILL.md",
  "ui/src/App.tsx",
  "ui/src/runtimeBridge.ts",
  "ui/electron/preload.js",
  "ui/electron/runtime-daemon.js",
  "ui/electron/runtime-service.js",
  "data/runtime/jcc/runtime-mode-sensing-map.json",
  "data/runtime/jcc/runtime-ui-mode-contract.json",
  "data/runtime/jcc/choice-confirmation-hook-contract.json",
  "data/runtime/jcc/cruise-agent-output-loop-contract.json",
  "data/runtime/jcc/visual-live-state-contract.json",
  "data/runtime/jcc/visual-roi-layout.json",
  "data/runtime/jcc/vision-model-sensing-contract.json",
  "data/runtime/jcc/runtime-agent-wiki/official/mumu-desktop-runtime.md",
  "data/runtime/jcc/runtime-agent-wiki/official/quickstart.md",
  "data/runtime/jcc/runtime-agent-wiki/official/host-multimodal-visual-sensing-runbook.md",
  "docs/runtime-ocr-redesign.md",
  "docs/jcc-runtime-product-readiness.md",
  "ui/PRODUCT.md",
  "ui/IA.md",
  "tools/request-jcc-choice-visual-refresh.mjs",
  "tools/run-jcc-pending-visual-request.mjs",
  "tools/run-jcc-vision-model-observation.mjs",
  "tools/run-jcc-cruise-runtime-pipeline.mjs",
  "tools/score-jcc-cruise-strategy.mjs",
  "tools/build-jcc-choice-confirmation-state.mjs",
  "tools/build-jcc-host-agent-context-pack.mjs",
  "tools/build-jcc-vision-reference-pack.mjs",
];

const forbiddenNeedles = [
  "requestGodRewardChoice",
  "onGodRewardChoice",
  "god_reward_choice",
  "god_reward_choice_3",
  "god_reward_options",
  "choices.god_reward_options",
  "装备/英雄三选一",
  "装备英雄",
  "英雄三选",
  "奖励三选",
];

for (const relativePath of scannedFiles) {
  const text = readFileSync(path.join(repoRoot, relativePath), "utf8");
  for (const needle of forbiddenNeedles) {
    if (text.includes(needle)) {
      throw new Error(`${relativePath} still contains removed god reward 3-choice product reference: ${needle}`);
    }
  }
}

console.log("verify-jcc-god-reward-choice-removed: ok");
