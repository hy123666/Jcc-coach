import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: new URL("..", import.meta.url),
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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-targeted-insights-"));
  try {
    const signalsPath = path.join(tempDir, "signals.json");
    const outPath = path.join(tempDir, "live-state.json");
    await writeFile(signalsPath, JSON.stringify({
      ok: true,
      signal_kind: "targeted_capture_candidate_signals",
      live_state_status: "not_promoted_until_focused_verifier",
      signals: [
        {
          type: "match_start",
          confidence: 0.9,
          payload: { game_start_time: "20260606010101" },
          evidence: "GameStart time:20260606010101",
        },
        {
          type: "local_report_chair_candidate",
          confidence: 0.84,
          payload: { chair_id: 6, turn_count: 1 },
          evidence: "#SoGame_Report# chairid: 6",
        },
        {
          type: "player_life",
          confidence: 0.72,
          payload: { chair_id: 6, life: 100 },
          evidence: "life 100 ChairId: 6",
        },
        {
          type: "targeted_capture_delta_candidate",
          confidence: 0.35,
          payload: {
            scope: "planning_shop",
            term: "board",
            delta: 3,
            target_fields: ["board.board_units"],
            promotion_status: "candidate_only",
            blocker: "term_count_delta_does_not_prove_live_state_semantics",
          },
          evidence: "board changed snippet",
        },
        {
          type: "targeted_capture_delta_candidate",
          confidence: 0.35,
          payload: {
            scope: "planning_shop",
            term: "gold",
            delta: 2,
            target_fields: ["economy.gold"],
            promotion_status: "candidate_only",
            blocker: "term_count_delta_does_not_prove_live_state_semantics",
          },
          evidence: "gold changed snippet",
        },
      ],
    }, null, 2), "utf8");

    const result = await runNode([
      "tools/build-jcc-match-live-state.mjs",
      "--signals",
      signalsPath,
      "--out",
      outPath,
    ]);
    assert(result.code === 0, `builder exited ${result.code}\n${result.stderr}`);
    const snapshot = JSON.parse(await readFile(outPath, "utf8"));
    const liveState = snapshot.live_state || {};
    const insight = liveState.source_insights?.targeted_capture_candidates;

    assert(insight, "source_insights.targeted_capture_candidates must exist");
    assert(insight.count === 2, "targeted candidate insight must count candidate signals");
    assert(insight.promotion_decision?.status === "not_promoted", "targeted candidates must not promote");
    assert(insight.by_target_field?.["board.board_units"]?.count === 1, "board target field candidate count missing");
    assert(insight.by_target_field?.["economy.gold"]?.count === 1, "gold target field candidate count missing");
    assert(insight.by_scope?.planning_shop?.count === 2, "planning_shop scope count missing");
    assert(liveState.field_status?.["source_insights.targeted_capture_candidates"]?.status === "partial", "targeted insight status must be partial");
    assert(liveState.field_status?.["board.board_units"]?.status === "missing", "board.board_units must remain missing");
    assert(liveState.field_status?.["economy.gold"]?.status === "missing", "economy.gold must remain missing");
    assert(Array.isArray(liveState.board?.board_units) && liveState.board.board_units.length === 0, "board_units must not be promoted");
    assert(liveState.economy?.gold === "unknown", "economy.gold value must remain unknown");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "targeted delta candidate signals appear in source_insights",
        "candidates are grouped by scope and target field",
        "targeted candidates do not promote board or gold live_state fields",
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
