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
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-round-flow-binding-"));
  try {
    const signalsFile = path.join(tempDir, "signals.json");
    const outFile = path.join(tempDir, "round-flow-binding.json");
    await writeFile(signalsFile, JSON.stringify({
      signals: [
        {
          type: "match_start",
          confidence: 0.9,
          payload: { game_start_time: "20260605210000" },
          evidence: "GameStart time:20260605210000",
        },
        {
          type: "local_report_chair_candidate",
          confidence: 0.84,
          payload: { chair_id: 6, turn_count: 11 },
          evidence: "local report chair 6 turn 11",
        },
        {
          type: "player_life",
          confidence: 0.72,
          payload: { chair_id: 6, life: 92 },
          evidence: "local hp 92",
        },
        {
          type: "round_flow",
          confidence: 0.7,
          payload: {
            decoded: {
              snapshot_candidate: {
                turn_count: 11,
                chair_candidates: [6, 2],
                hp: 84,
                board_units: [{ hero: { name: "ChairMatchHpConflict" } }],
              },
            },
          },
          evidence: "chair candidate matches local but hp conflicts",
        },
        {
          type: "round_flow",
          confidence: 0.7,
          payload: {
            decoded: {
              snapshot_candidate: {
                turn_count: 11,
                chair_candidates: [4, 3],
                hp: 92,
                board_units: [{ hero: { name: "HpMatchChairConflict" } }],
              },
            },
          },
          evidence: "hp matches local but chair candidate does not",
        },
      ],
    }, null, 2), "utf8");

    const result = await runNode([
      "tools/analyze-jcc-round-flow-binding.mjs",
      "--signals",
      signalsFile,
      "--out",
      outFile,
    ]);
    assert(result.code === 0, `analyzer exited ${result.code}\n${result.stderr}`);
    const report = JSON.parse(await readFile(outFile, "utf8"));
    assert(report.ok === true, "analyzer must produce ok=true report");
    assert(report.local_chair_id === 6, "analyzer must bind local chair from local report");
    assert(report.local_hp === 92, "analyzer must read local hp from player_life");
    assert(report.round_flow?.field_hypotheses?.primary_chair_candidate_index?.field === "chair_candidates[0]", "analyzer must document primary chair hypothesis");
    assert(report.round_flow?.promotion_decision?.status === "not_promoted", "conflicting evidence must not promote round_flow to local board");
    assert(report.round_flow?.promotion_decision?.blockers?.includes("hp_conflicts_with_local_chair_candidate"), "promotion blockers must include hp conflict");
    assert(report.round_flow?.promotion_decision?.blockers?.includes("hp_match_missing_local_chair_candidate"), "promotion blockers must include hp-match chair conflict");
    assert(report.round_flow?.candidates?.some((candidate) => candidate.conflicts.includes("hp_mismatch")), "candidate list must expose hp mismatch");
    assert(report.round_flow?.candidates?.some((candidate) => candidate.conflicts.includes("chair_candidate_missing_local")), "candidate list must expose missing local chair");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "local chair and hp extracted",
        "round_flow chair hypothesis documented",
        "conflicts block promotion",
        "candidate-level blockers emitted",
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
