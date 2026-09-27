import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-mumu-no-opponent-snapshot-"));
  try {
    const eventsFile = path.join(tempDir, "events.jsonl");
    const outFile = path.join(tempDir, "live-state.json");
    const events = [
      { type: "mumu_gi_message", cmd: 4358, payload: { s: 1 }, observed_at: "2026-06-09T09:30:00.000Z", match_session_id: "match-a" },
      { type: "mumu_gi_message", cmd: 4354, payload: { bl: [{ i: 11503, l: 0, t: 0, r: 10, b: 10 }] }, observed_at: "2026-06-09T09:30:00.500Z", match_session_id: "match-a" },
      { type: "mumu_gi_message", cmd: 4352, payload: { wl: [{ i: 11500, x: 4, y: -1 }] }, observed_at: "2026-06-09T09:30:01.000Z", match_session_id: "match-a" },
      { type: "mumu_gi_message", cmd: 4353, payload: { hl: [
        { i: 11500, x: 4, y: -1 },
        { i: 11501, x: 1, y: 1 },
        { i: 11502, x: 2, y: 1 },
      ] }, observed_at: "2026-06-09T09:30:02.000Z", match_session_id: "match-a" },
      { type: "mumu_gi_message", cmd: 4358, payload: { s: 2 }, observed_at: "2026-06-09T09:30:03.000Z", match_session_id: "match-a" },
      { type: "mumu_gi_message", cmd: 4353, payload: { hl: [
        { i: 12503, x: 1, y: 1 },
        { i: 12504, x: 2, y: 1 },
        { i: 12505, x: 3, y: 1 },
      ] }, observed_at: "2026-06-09T09:30:04.000Z", match_session_id: "match-a" },
      { type: "opponent_snapshot_requested", snapshot_id: "snap-1", opponent_label: "current_view_opponent", observed_at: "2026-06-09T09:30:05.000Z", match_session_id: "match-a" },
      { type: "mumu_gi_message", cmd: 4353, payload: { hl: [
        { i: 12507, x: 4, y: 1 },
        { i: 12508, x: 5, y: 1 },
      ] }, observed_at: "2026-06-09T09:30:06.000Z", match_session_id: "match-a" },
    ];
    await writeFile(eventsFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const result = await runNode([
      "tools/build-jcc-mumu-gi-live-state.mjs",
      "--events",
      eventsFile,
      "--out",
      outFile,
    ]);
    assert(result.code === 0, `builder exited ${result.code}\n${result.stderr || result.stdout}`);
    const state = JSON.parse(await readFile(outFile, "utf8"));
    const ownBoard = state.board.local_board_units_candidate || [];
    assert(!state.opponents?.snapshots, "live_state must not emit opponent snapshots");
    assert(!state.field_status?.["opponents.snapshots"], "field_status must not expose opponent snapshots");
    assert(ownBoard.length === 2, "own board candidate should remain last S=1 + shop-anchored board");
    assert(ownBoard.every((unit) => [11501, 11502].includes(unit.base_hero_id)), "own board candidate must come from trusted self-view 4353 only");
    assert(!ownBoard.some((unit) => [12503, 12504, 12505, 12507, 12508].includes(unit.base_hero_id)), "S=2/current-view units must not enter own board");
    assert(state.local.self_view_promotion_suspended !== true, "removed opponent snapshot event must not suspend self-view promotion");
    console.log(JSON.stringify({
      ok: true,
      checked: [
        "legacy opponent_snapshot_requested event is ignored",
        "opponents.snapshots is absent from live_state and field_status",
        "S=2 4353 does not update own board",
        "own board remains the last trusted S=1 + 4354 anchored board",
      ],
      own_board_ids: ownBoard.map((unit) => unit.base_hero_id),
    }, null, 2));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
