import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const options = {
    events: ".omx/runtime-evidence/mumu-gi-live/mumu-self-anchor-20260609-1155/events.jsonl",
    overlay: "data/runtime/jcc/mumu-catalog-overlay.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--events") options.events = argv[++index];
    else if (arg === "--overlay") options.overlay = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function defaultEvents() {
  return [
    { type: "mumu_gi_message", cmd: 4358, payload: { s: 1 }, observed_at: "2026-06-12T10:00:00.000Z", match_session_id: "fixture-s1" },
    { type: "mumu_gi_message", cmd: 4354, payload: { bl: [{ i: 11500, l: 0, t: 0, r: 10, b: 10 }] }, observed_at: "2026-06-12T10:00:00.500Z", match_session_id: "fixture-s1" },
    { type: "mumu_gi_message", cmd: 4352, payload: { wl: [{ i: 11500, x: 4, y: -1 }] }, observed_at: "2026-06-12T10:00:01.000Z", match_session_id: "fixture-s1" },
    { type: "mumu_gi_message", cmd: 4353, payload: { hl: [
      { i: 11500, x: 4, y: -1 },
      { i: 11502, x: 1, y: 1 },
      { i: 12503, x: 2, y: 1 },
    ] }, observed_at: "2026-06-12T10:00:02.000Z", match_session_id: "fixture-s1" },
  ];
}

async function prepareEventsFile(options) {
  if (existsSync(options.events)) return { eventsPath: options.events, cleanup: async () => {}, fixture: false };
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-self-view-anchor-"));
  const eventsPath = path.join(tempDir, "events.jsonl");
  await writeFile(eventsPath, `${defaultEvents().map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  return {
    eventsPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
    fixture: true,
  };
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

async function buildState(events) {
  const args = ["tools/build-jcc-mumu-gi-live-state.mjs", "--events", events];
  const result = await runNode(args);
  assert(result.code === 0, `build live state failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function parseEvents(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

function baseHeroId(rawHeroId) {
  const value = Number(rawHeroId);
  if (!Number.isFinite(value)) return null;
  return (value % 10000) + 10000;
}

function unitKey(entry) {
  return `${baseHeroId(entry.i)}:${entry.x}:${entry.y}`;
}

function findStableWindow(events, expectedBoardIds, expectedBenchIds) {
  let latestBench = [];
  let shopVisible = false;
  for (const event of events) {
    if (event.type !== "mumu_gi_message") continue;
    const command = Number(event.cmd ?? event.command);
    if (command === 4354 && Array.isArray(event.payload?.bl) && event.payload.bl.length > 0) shopVisible = true;
    if (command === 4352) {
      latestBench = Array.isArray(event.payload?.wl) ? event.payload.wl : [];
    }
    if (command !== 4353 || !shopVisible) continue;
    const raw = Array.isArray(event.payload?.hl) ? event.payload.hl : [];
    const benchKeys = new Set(latestBench.map(unitKey));
    const boardIds = new Set(raw.filter((entry) => !benchKeys.has(unitKey(entry))).map((entry) => String(baseHeroId(entry.i))));
    const benchIds = new Set(latestBench.map((entry) => String(baseHeroId(entry.i))));
    const hasBoard = expectedBoardIds.every((id) => boardIds.has(String(id)));
    const hasBench = expectedBenchIds.every((id) => benchIds.has(String(id)));
    if (hasBoard && hasBench) {
      return {
        observed_at: event.observed_at,
        board_ids: [...boardIds],
        bench_ids: [...benchIds],
        raw_count: raw.length,
        bench_count: latestBench.length,
      };
    }
  }
  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prepared = await prepareEventsFile(options);
  try {
    const eventText = await readFile(prepared.eventsPath, "utf8");
    const events = parseEvents(eventText);
    const overlay = JSON.parse(await readFile(options.overlay, "utf8"));

    const anchored = await buildState(prepared.eventsPath);
    assert(
      anchored.metadata.catalog_overlay?.schema === "jcc-runtime-catalog-overlay-v1",
      "live-state must load MuMu catalog overlay",
    );
    assert(
      anchored.local.binding_status === "shop_self_view_anchor",
      "default builder must auto-establish self-view anchor from visible 4354 shop",
    );

    const expectedBoardIds = ["11502", "12503"];
    const expectedBenchIds = ["11500"];
    const stable = findStableWindow(events, expectedBoardIds, expectedBenchIds);
    assert(stable, "missing self-view stable window for board/bench fixture");

    for (const id of [...expectedBoardIds, ...expectedBenchIds]) {
      assert(overlay.champions_by_id[id]?.name, `overlay missing champion name for ${id}`);
      assert(overlay.champions_by_id[id]?.icon_url, `overlay missing champion icon for ${id}`);
    }

    console.log(JSON.stringify({
      ok: true,
      events: prepared.fixture ? "self-contained-fixture" : options.events,
      default_board_count: anchored.board.local_board_units_candidate.length,
      stable_window: stable,
      expected_names: Object.fromEntries(
        [...expectedBoardIds, ...expectedBenchIds].map((id) => [id, overlay.champions_by_id[id].name]),
      ),
      final_phase: anchored.phase,
      final_promotion_status: anchored.field_status["board.local_board_units_candidate"],
      checked: [
        "default build auto-establishes self-view anchor from visible 4354 shop",
        "stable fixture window matches expected self board and bench ids",
        "MuMu catalog overlay resolves expected unit names/icons",
        "final promotion status remains shop-anchored and does not claim current-view as permanent owner data"
      ],
    }, null, 2));
  } finally {
    await prepared.cleanup();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
