import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  attachMumuBoardGrid,
  isMumuGiXYOnCalibratedBoard,
  mapMumuGiXYToBoardGrid,
} from "./jcc-mumu-board-grid.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve("."),
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

const KNOWN_BOARD_UNITS = [
  { name: "小木灵", x: 714, y: 573, row: 1, col: 3 },
  { name: "黛安娜", x: 803, y: 582, row: 1, col: 4 },
  { name: "俄洛伊", x: 878, y: 577, row: 1, col: 5 },
  { name: "蕾欧娜", x: 671, y: 524, row: 2, col: 2 },
  { name: "超级机甲", x: 932, y: 524, row: 2, col: 5 },
  { name: "阿萝拉", x: 851, y: 386, row: 4, col: 4 },
  { name: "乐芙兰", x: 1055, y: 400, row: 4, col: 6 },
  { name: "金克丝", x: 1140, y: 391, row: 4, col: 7 },
];

const KNOWN_BENCH_BAND_UNITS = [
  { name: "莫甘娜", x: 421, y: 279 },
  { name: "俄洛伊", x: 514, y: 279 },
  { name: "俄洛伊", x: 607, y: 279 },
  { name: "俄洛伊", x: 700, y: 279 },
];

function assertDirectMapping() {
  for (const unit of KNOWN_BOARD_UNITS) {
    const grid = mapMumuGiXYToBoardGrid(unit.x, unit.y);
    assert(grid, `${unit.name} should map to board grid`);
    assert(grid.row === unit.row, `${unit.name} expected row ${unit.row}, got ${grid.row}`);
    assert(grid.col === unit.col, `${unit.name} expected col ${unit.col}, got ${grid.col}`);
    assert(grid.position_words?.compact, `${unit.name} should include position words`);
  }

  for (const unit of KNOWN_BENCH_BAND_UNITS) {
    assert(!mapMumuGiXYToBoardGrid(unit.x, unit.y), `${unit.name} bench-band y must not map to board`);
    assert(!isMumuGiXYOnCalibratedBoard(unit), `${unit.name} bench-band unit must fail board predicate`);
  }

  const attached = attachMumuBoardGrid({ name: "金克丝", x: 1140, y: 391, position: { x: 1140, y: 391, area: "board" } });
  assert(attached.position.board_grid?.row === 4, "attached board_grid row mismatch");
  assert(attached.position.board_grid?.col === 7, "attached board_grid col mismatch");
}

async function assertRuntimePromotionFiltering() {
  const outDir = ".omx/runtime-evidence/mumu-board-grid-verify";
  const fixture = `${outDir}/fixture.logcat.txt`;
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const hl = [
    { i: 12460, x: 714, y: 573 },
    { i: 13458, x: 803, y: 582 },
    { i: 13460, x: 878, y: 577 },
    { i: 11454, x: 671, y: 524 },
    { i: 14379, x: 932, y: 524 },
    { i: 13462, x: 851, y: 386 },
    { i: 14380, x: 1055, y: 400 },
    { i: 12458, x: 1140, y: 391 },
    { i: 15434, x: 421, y: 279 },
    { i: 13460, x: 514, y: 279 },
    { i: 13460, x: 607, y: 279 },
    { i: 13460, x: 700, y: 279 },
  ];
  await writeFile(fixture, [
    '06-11 10:00:00.000  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4358 {"s":1}, id: 1',
    '06-11 10:00:00.300  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4354 {"bl":[{"i":11453,"l":0,"t":0,"r":10,"b":10}]}, id: 2',
    `06-11 10:00:00.800  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4353 ${JSON.stringify({ hl })}, id: 3`,
  ].join("\n"), "utf8");

  const result = await runNode([
    "tools/watch-jcc-mumu-runtime-logcat.mjs",
    "--out-dir",
    outDir,
    "--match-session-id",
    "mumu-board-grid-verify",
    "--logcat-fixture",
    fixture,
  ]);
  assert(result.code === 0, `watcher fixture failed: ${result.stderr || result.stdout}`);

  const state = JSON.parse(await readFile(`${outDir}/state.json`, "utf8"));
  const board = state.board?.local_board_units_candidate || [];
  assert(board.length === 8, `expected exactly 8 board units after bench-band filtering, got ${board.length}`);
  for (const unit of board) {
    assert(unit.position?.board_grid, `${unit.name || unit.hero_id} missing board_grid after promotion`);
    assert(unit.position.board_grid.row >= 1 && unit.position.board_grid.row <= 4, "board_grid row out of range");
    assert(unit.position.board_grid.col >= 1 && unit.position.board_grid.col <= 7, "board_grid col out of range");
    assert(Number(unit.position.y) !== 279, "bench-band unit leaked into promoted board");
  }
  assert((state.current_view?.raw_units || []).length === 12, "raw current_view must preserve all candidates for evidence");
  assert((state.current_view?.filtered_units || []).length === 8, "filtered current_view must drop bench-band geometry");
  assert((state.bench?.bench_units || []).length === 0, "fixture intentionally has no 4352 bench evidence");
}

async function main() {
  assertDirectMapping();
  await assertRuntimePromotionFiltering();
  console.log(JSON.stringify({
    ok: true,
    checked: [
      "6-1 replay MuMu XY samples map to user-defined 4x7 board rows and columns",
      "bench-band y≈279 never maps to board row 4",
      "watcher promotion attaches board_grid only after local-board promotion",
      "watcher filters bench-band geometry even when 4352 bench evidence is absent",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
