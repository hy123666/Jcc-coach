import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-local-reward-schema-"));
  try {
    const signalsFile = path.join(tempDir, "signals.json");
    const bindingFile = path.join(tempDir, "binding.json");
    const outFile = path.join(tempDir, "live-state.json");
    await writeFile(bindingFile, JSON.stringify({
      local_chair_id: 2,
      game_start_time: "20260606040000",
      binding_status: "strongly_bound",
      confidence: 0.95,
      evidence: "synthetic current-match local chair binding",
    }, null, 2), "utf8");
    await writeFile(signalsFile, JSON.stringify({
      ok: true,
      signal_kind: "candidate_runtime_signals",
      signals: [
        {
          type: "match_start",
          confidence: 0.9,
          payload: { game_start_time: "20260606040000" },
          evidence: "GameStart time:20260606040000",
        },
        {
          type: "local_report_chair_candidate",
          confidence: 0.84,
          payload: { chair_id: 2, turn_count: 9 },
          evidence: "#SoGame_Report# chairid: 2",
        },
        {
          type: "reward_choice_state",
          confidence: 0.8,
          payload: {
            chair_id: 2,
            active: true,
            blocking_choice: { type: "anvil", reward_id: "anvil-1", name: "Item Anvil", slot: null },
            choices: [
              { type: "item", reward_id: "2001", name: "Infinity Edge", slot: 0 },
              { type: "component", reward_id: "1001", name: "B.F. Sword", slot: 1 },
              { type: "item", reward_id: "2002", name: "Secondary Item Reward", slot: 2 },
            ],
          },
          evidence: "synthetic reward choices local chair 2",
        },
        {
          type: "reward_choice_state",
          confidence: 0.8,
          payload: {
            chair_id: 5,
            active: true,
            choices: [{ type: "item", reward_id: "9999", name: "EnemyOnlyReward", slot: 0 }],
          },
          evidence: "synthetic reward choices enemy chair 5",
        },
        {
          type: "reward_selected_state",
          confidence: 0.82,
          payload: {
            chair_id: 2,
            selected_reward: { type: "item", reward_id: "2001", name: "Infinity Edge", slot: 0 },
          },
          evidence: "synthetic selected reward local chair 2",
        },
      ],
    }, null, 2), "utf8");

    const result = await runNode([
      "tools/build-jcc-match-live-state.mjs",
      "--signals",
      signalsFile,
      "--manual-binding",
      bindingFile,
      "--out",
      outFile,
    ]);
    assert(result.code === 0, `live-state builder exited ${result.code}\n${result.stderr}`);
    const snapshot = JSON.parse(await readFile(outFile, "utf8"));
    const liveState = snapshot.live_state || {};
    const rewards = liveState.rewards || {};
    const choice = rewards.choices?.[0];

    assert(rewards.active === true, `rewards.active must normalize true: ${JSON.stringify(rewards)}`);
    assert(rewards.choices.length === 3, "rewards.choices must include local choices");
    assert(choice.type === "item", "reward choice must include type");
    assert(choice.id === "2001", "reward choice must normalize id");
    assert(choice.name === "Infinity Edge", "reward choice must normalize name");
    assert(choice.slot === 0, "reward choice must preserve slot");
    assert(choice.evidence === "synthetic reward choices local chair 2", "reward choice must preserve evidence");
    assert(choice.source_signal_type === "reward_choice_state", "reward choice must preserve source signal type");
    assert(!JSON.stringify(rewards.choices).includes("EnemyOnlyReward"), "reward choices must filter non-local chairs");
    assert(rewards.selected_reward.id === "2001", "selected reward must normalize id");
    assert(rewards.selected_reward.type === "item", "selected reward must normalize type");
    assert(rewards.selected_reward.evidence === "synthetic selected reward local chair 2", "selected reward must preserve evidence");
    assert(rewards.blocking_choice.id === "anvil-1", "blocking choice must normalize id");
    assert(rewards.blocking_choice.type === "anvil", "blocking choice must normalize type");
    assert(liveState.field_status?.["rewards.active"]?.status === "observed", "rewards.active status must be observed");
    assert(liveState.field_status?.["rewards.choices"]?.status === "observed", "rewards.choices status must be observed");
    assert(liveState.field_status?.["rewards.selected_reward"]?.status === "observed", "selected_reward status must be observed");
    assert(liveState.field_status?.["rewards.blocking_choice"]?.status === "observed", "blocking_choice status must be observed");
    assert(!liveState.missing_fields?.includes("rewards.choices"), "rewards.choices must leave missing_fields when local evidence exists");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "local reward choices normalize reward schema",
        "reward choices filter non-local chairs",
        "selected reward normalizes selected schema",
        "reward field_status carries observed evidence",
      ],
    }, null, 2));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
