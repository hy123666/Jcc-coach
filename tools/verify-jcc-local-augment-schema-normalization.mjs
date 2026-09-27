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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-local-augment-schema-"));
  try {
    const signalsFile = path.join(tempDir, "signals.json");
    const outFile = path.join(tempDir, "live-state.json");
    await writeFile(signalsFile, JSON.stringify({
      ok: true,
      signal_kind: "candidate_runtime_signals",
      signals: [
        {
          type: "match_start",
          confidence: 0.9,
          payload: { game_start_time: "20260606030000" },
          evidence: "GameStart time:20260606030000",
        },
        {
          type: "local_report_chair_candidate",
          confidence: 0.84,
          payload: { chair_id: 2, turn_count: 7 },
          evidence: "#SoGame_Report# chairid: 2",
        },
        {
          type: "augment_choice_state",
          confidence: 0.81,
          payload: {
            chair_id: 2,
            selection_active: true,
            rerolls: 1,
            choices: [
              { slot: 0, augment_id: "20709", name: "Outlier", tier: "gold", desc: "Removed from 4-2.", icon: "augment/outlier.png" },
              { slot: 1, augment_id: "20736", name: "Judge Order", tier: "gold", desc: "Adds a second law effect.", icon: "augment/judge.png" },
              { slot: 2, augment_id: "20888", name: "Tempo", tier: "silver", desc: "Gain resources.", icon: "augment/tempo.png" },
            ],
          },
          evidence: "synthetic augment choices local chair 2",
        },
        {
          type: "augment_choice_state",
          confidence: 0.81,
          payload: {
            chair_id: 5,
            selection_active: true,
            rerolls: 2,
            choices: [{ slot: 0, augment_id: "9999", name: "EnemyOnlyAugment", tier: "prismatic" }],
          },
          evidence: "synthetic augment choices enemy chair 5",
        },
        {
          type: "augment_selected_state",
          confidence: 0.83,
          payload: {
            chair_id: 2,
            selected_augments: [
              { augment_id: "20736", name: "Judge Order", tier: "gold", selected_round: "3-2" },
            ],
          },
          evidence: "synthetic selected augment local chair 2",
        },
      ],
    }, null, 2), "utf8");

    const result = await runNode([
      "tools/build-jcc-match-live-state.mjs",
      "--signals",
      signalsFile,
      "--out",
      outFile,
    ]);
    assert(result.code === 0, `live-state builder exited ${result.code}\n${result.stderr}`);
    const snapshot = JSON.parse(await readFile(outFile, "utf8"));
    const liveState = snapshot.live_state || {};
    const augments = liveState.augments || {};
    const choice = augments.choices?.[0];
    const selected = augments.selected_augments?.[0];

    assert(augments.selection_active === true, "augment selection_active must normalize true");
    assert(augments.rerolls === 1, "augment rerolls must normalize from local choice state");
    assert(augments.choices.length === 3, "augment choices must include local options");
    assert(choice.slot === 0, "augment choice must include slot");
    assert(choice.id === "20709", "augment choice must normalize id");
    assert(choice.name === "Outlier", "augment choice must normalize name");
    assert(choice.tier === "gold", "augment choice must normalize tier");
    assert(choice.desc === "Removed from 4-2.", "augment choice must preserve desc");
    assert(choice.icon === "augment/outlier.png", "augment choice must preserve icon");
    assert(choice.evidence === "synthetic augment choices local chair 2", "augment choice must preserve evidence");
    assert(choice.source_signal_type === "augment_choice_state", "augment choice must preserve source signal type");
    assert(!JSON.stringify(augments.choices).includes("EnemyOnlyAugment"), "augment choices must filter non-local chairs");
    assert(selected.id === "20736", "selected augment must normalize id");
    assert(selected.name === "Judge Order", "selected augment must normalize name");
    assert(selected.tier === "gold", "selected augment must normalize tier");
    assert(selected.selected_round === "3-2", "selected augment must preserve selected_round");
    assert(selected.evidence === "synthetic selected augment local chair 2", "selected augment must preserve evidence");
    assert(liveState.field_status?.["augments.selection_active"]?.status === "observed", "selection_active status must be observed");
    assert(liveState.field_status?.["augments.choices"]?.status === "observed", "augment choices status must be observed");
    assert(liveState.field_status?.["augments.selected_augments"]?.status === "observed", "selected augments status must be observed");
    assert(liveState.field_status?.["augments.rerolls"]?.status === "observed", "augment rerolls status must be observed");
    assert(!liveState.missing_fields?.includes("augments.selection_active"), "selection_active must leave missing_fields when local evidence exists");
    assert(!liveState.missing_fields?.includes("augments.rerolls"), "rerolls must leave missing_fields when local evidence exists");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "local augment choices normalize choice schema",
        "augment choices filter non-local chairs",
        "selected augment normalizes selected schema",
        "augment field_status carries observed evidence",
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
