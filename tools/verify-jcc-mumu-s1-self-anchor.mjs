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

async function buildState(events) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-mumu-s1-self-anchor-"));
  try {
    const eventsFile = path.join(tempDir, "events.jsonl");
    const outFile = path.join(tempDir, "live-state.json");
    await writeFile(eventsFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const result = await runNode([
      "tools/build-jcc-mumu-gi-live-state.mjs",
      "--events",
      eventsFile,
      "--out",
      outFile,
    ]);
    assert(result.code === 0, `builder exited ${result.code}\n${result.stderr || result.stdout}`);
    return JSON.parse(await readFile(outFile, "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const initialOwnEvents = [
    { type: "mumu_gi_message", cmd: 4358, payload: { s: 1 }, observed_at: "2026-06-12T10:00:00.000Z", match_session_id: "match-s1" },
    { type: "mumu_gi_message", cmd: 4354, payload: { bl: [{ i: 11453, l: 0, t: 0, r: 10, b: 10 }] }, observed_at: "2026-06-12T10:00:00.500Z", match_session_id: "match-s1" },
    { type: "mumu_gi_message", cmd: 4352, payload: { wl: [{ i: 11450, x: 4, y: -1 }] }, observed_at: "2026-06-12T10:00:01.000Z", match_session_id: "match-s1" },
    { type: "mumu_gi_message", cmd: 4353, payload: { hl: [
      { i: 11450, x: 4, y: -1 },
      { i: 11451, x: 1, y: 1 },
      { i: 11452, x: 2, y: 1 },
    ] }, observed_at: "2026-06-12T10:00:02.000Z", match_session_id: "match-s1" },
  ];
  const initialState = await buildState(initialOwnEvents);
  const initialBoard = initialState.board.local_board_units_candidate || [];
  assert(initialState.local.binding_status === "shop_self_view_anchor", "visible shop should auto-establish self-view anchor without --self-view-anchor");
  assert(initialBoard.length === 2, "shop anchor should promote fresh 4353 minus 4352 as own board");
  assert(initialBoard.every((unit) => [11451, 11452].includes(unit.base_hero_id)), "initial own board ids should match filtered self-view units");
  assert(initialState.field_status["board.local_board_units_candidate"]?.promotion_policy === "shop_self_view_anchor_plus_fresh_current_view", "promotion policy should name shop self-view anchor");

  const resumeEvents = [
    ...initialOwnEvents,
    { type: "mumu_gi_message", cmd: 4358, payload: { s: 2 }, observed_at: "2026-06-12T10:01:00.000Z", match_session_id: "match-s1" },
    { type: "mumu_gi_message", cmd: 4353, payload: { hl: [
      { i: 11460, x: 1, y: 1 },
      { i: 11461, x: 2, y: 1 },
    ] }, observed_at: "2026-06-12T10:01:01.000Z", match_session_id: "match-s1" },
    { type: "mumu_gi_message", cmd: 4358, payload: { s: 1 }, observed_at: "2026-06-12T10:02:00.000Z", match_session_id: "match-s1" },
    { type: "mumu_gi_message", cmd: 4354, payload: { bl: [{ i: 11454, l: 0, t: 0, r: 10, b: 10 }] }, observed_at: "2026-06-12T10:02:00.500Z", match_session_id: "match-s1" },
    { type: "mumu_gi_message", cmd: 4353, payload: { hl: [
      { i: 11450, x: 4, y: -1 },
      { i: 11453, x: 3, y: 2 },
    ] }, observed_at: "2026-06-12T10:02:01.000Z", match_session_id: "match-s1" },
  ];
  const resumeState = await buildState(resumeEvents);
  const resumedBoard = resumeState.board.local_board_units_candidate || [];
  assert(!resumeState.opponents?.snapshots?.length, "s=2 current view must not create opponent snapshots");
  assert(resumeState.local.self_view_promotion_suspended === false, "s=2 observing view must not leave a self-view suspension flag");
  assert(resumedBoard.length === 1, "after returning to visible shop, new self-view 4353 should promote own board");
  assert(resumedBoard[0].base_hero_id === 11453, "resumed own board must come from the post-shop 4353, not stale opponent view");
  assert(!resumedBoard.some((unit) => [11460, 11461].includes(unit.base_hero_id)), "s=2 current view must not pollute resumed own board");

  const shopHiddenEvents = [
    ...initialOwnEvents,
    { type: "mumu_gi_message", cmd: 4354, payload: { bl: [] }, observed_at: "2026-06-12T10:03:00.000Z", match_session_id: "match-s1" },
    { type: "mumu_gi_message", cmd: 4353, payload: { hl: [
      { i: 11460, x: 1, y: 1 },
      { i: 11461, x: 2, y: 1 },
    ] }, observed_at: "2026-06-12T10:03:01.000Z", match_session_id: "match-s1" },
  ];
  const shopHiddenState = await buildState(shopHiddenEvents);
  const shopHiddenBoard = shopHiddenState.board.local_board_units_candidate || [];
  assert(shopHiddenBoard.every((unit) => [11451, 11452].includes(unit.base_hero_id)), "hidden/empty shop must not let later current_view overwrite own board");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "visible 4354 shop auto-establishes self-view anchor without legacy flag",
      "shop anchor promotes fresh current 4353 minus 4352 to own board",
      "s=2 current_view creates no opponent facts and does not update own board",
      "returning to visible shop resumes promotion only after a fresh post-anchor 4353",
      "hidden/empty shop prevents later current_view from overwriting own board",
    ],
    initial_own_board_ids: initialBoard.map((unit) => unit.base_hero_id),
    resumed_own_board_ids: resumedBoard.map((unit) => unit.base_hero_id),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
