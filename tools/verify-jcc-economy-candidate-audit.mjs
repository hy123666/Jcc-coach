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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-economy-audit-"));
  try {
    const signalsFile = path.join(tempDir, "signals.json");
    const outFile = path.join(tempDir, "economy-audit.json");
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
          evidence: "local chair 6",
        },
        {
          type: "player_life",
          confidence: 0.72,
          payload: { chair_id: 6, life: 92 },
          evidence: "local hp",
        },
        {
          type: "battle_result_money",
          confidence: 0.68,
          payload: { player_ref: "<player-id>", earned_money: 3 },
          evidence: "battle money anonymous player ref",
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
                level_candidate: 5,
              },
            },
          },
          evidence: "hp matches local but chair candidate does not",
        },
      ],
    }, null, 2), "utf8");

    const result = await runNode([
      "tools/analyze-jcc-economy-candidates.mjs",
      "--signals",
      signalsFile,
      "--out",
      outFile,
    ]);
    assert(result.code === 0, `economy candidate audit exited ${result.code}\n${result.stderr}`);
    const report = JSON.parse(await readFile(outFile, "utf8"));
    assert(report.ok === true, "audit must produce ok=true");
    assert(report.local_chair_id === 6, "audit must expose local chair");
    assert(report.candidates.money_events.count === 1, "audit must count money events");
    assert(report.candidates.level_candidates.count === 1, "audit must count level candidates");
    assert(report.promotion_decision.economy_gold.status === "not_promoted", "anonymous money events must not promote economy.gold");
    assert(report.promotion_decision.economy_level.status === "not_promoted", "unbound round_flow level candidate must not promote economy.level");
    assert(report.promotion_decision.economy_xp.status === "missing", "xp must remain missing when no candidate exists");
    assert(report.blockers.includes("money_event_player_ref_not_bound_to_local_chair"), "audit must explain money binding blocker");
    assert(report.blockers.includes("round_flow_level_chair_semantics_unverified"), "audit must explain level binding blocker");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "money candidates counted but not promoted",
        "level candidates counted but not promoted",
        "xp remains missing",
        "blockers emitted",
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
