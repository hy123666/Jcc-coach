import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

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
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function resetDir(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readJsonl(file) {
  const text = await readFile(file, "utf8");
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runFixture({ outDir, matchSessionId, fixture }) {
  await resetDir(outDir);
  const result = await runNode([
    "tools/watch-jcc-mumu-runtime-logcat.mjs",
    "--out-dir",
    outDir,
    "--match-session-id",
    matchSessionId,
    "--logcat-fixture",
    fixture,
  ]);
  assert(result.code === 0, `watcher fixture failed: ${result.stderr || result.stdout}`);
  return result;
}

async function main() {
  const wrapperSource = await readFile("tools/start-jcc-mumu-runtime-watch.mjs", "utf8");
  const runtimeServiceSource = await readFile("ui/electron/runtime-service.js", "utf8");
  assert(wrapperSource.includes("source_only: true"), "production wrapper must declare its fixed structured-source contract");
  assert(wrapperSource.includes("owner_instance_id: options.ownerInstanceId || null"), "watcher wrapper must persist its owning runtime instance");
  assert(wrapperSource.includes("supervisor_pid: process.pid"), "watcher wrapper must persist the supervisor PID used for stale-process fencing");
  assert(!wrapperSource.includes("--runtime-ui-mode"), "structured watcher wrapper must not retain the obsolete runtime UI mode parameter");
  assert(
    runtimeServiceSource.includes("trackedPid === process.pid")
      && runtimeServiceSource.includes("watcher_process_self_termination_refused"),
    "runtime-service must never terminate its own process while repairing stale watcher ownership",
  );

  const fixture = ".omx/runtime-evidence/mumu-gi-live/watch-verify-structured-source.logcat.txt";
  await mkdir(path.dirname(fixture), { recursive: true });
  await writeFile(fixture, [
    '06-11 10:00:00.000  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4358 {"s":1}, id: 1',
    '06-11 10:00:00.100  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4354 {"bl":[{"i":11453,"l":0,"t":0,"r":10,"b":10}]}, id: 2',
    '06-11 10:00:00.200  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4352 {"wl":[{"i":1450,"x":4,"y":-1}]}, id: 3',
    '06-11 10:00:00.300  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4353 {"hl":[{"i":1450,"x":4,"y":-1},{"i":1451,"x":1,"y":1}]}, id: 4',
    '06-11 10:00:00.400  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4356 {"el":[{"i":3101,"l":0,"t":0,"r":2,"b":2}]}, id: 5',
    '06-11 10:00:00.500  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4357 {"el":[{"i":3102,"l":30,"t":30,"r":40,"b":40}]}, id: 6',
    "06-11 10:00:00.600  1000  2000 I UnrelatedSubsystem : ignored text",
  ].join("\n"), "utf8");
  const outDir = ".omx/runtime-evidence/mumu-gi-live/watch-verify-structured-source";
  await runFixture({ outDir, matchSessionId: "watch-verify-structured-source", fixture });

  const state = await readJson(path.join(outDir, "state.json"));
  const summary = await readJson(path.join(outDir, "summary.json"));
  const liveState = await readJson(path.join(outDir, "cruise-live-state.json"));
  const events = await readJsonl(path.join(outDir, "events.jsonl"));
  const files = (await readdir(outDir)).sort();
  assert(JSON.stringify(files) === JSON.stringify(["cruise-live-state.json", "events.jsonl", "state.json", "summary.json"]), "watcher must write only the structured source artifacts");
  assert(state.runtime?.source_only === true, "watcher runtime contract must be fixed to structured source mode");
  assert(summary.source_only === true, "summary must expose the fixed structured source contract");
  assert(liveState.source?.source_only === true, "live-state must expose the fixed structured source contract");
  assert(state.source_revision === 6 && summary.source_revision === 6 && liveState.source_revision === 6, "all structured source artifacts must share the latest revision");
  assert(events.length === 6, "only structured GI observations may be emitted as events");
  assert(events.every((event, index) => event.type === "mumu_gi_message" && event.source_revision === index + 1), "structured events must preserve source order and monotonic revisions");
  assert(state.board?.local_board_units_candidate?.length === 1, "structured own-board promotion must remain available");
  assert(state.items?.item_bench?.length === 1, "structured 4357 inventory facts must remain available");
  assert(state.items?.equipped_items?.length === 1, "trusted structured 4356 equipment facts must remain available");
  assert(JSON.stringify(Object.keys(state.augment || {}).sort()) === JSON.stringify(["last_status_code_4_at", "status_code_4_active", "status_code_4_seen"]), "augment state must contain only structured 4358 status facts");
  const requiredLiveStateSections = ["bench", "board", "command_counts", "economy", "items", "match_session_id", "phase", "schema", "shop", "source", "source_revision"];
  assert(requiredLiveStateSections.every((key) => Object.hasOwn(liveState, key)), "live-state must expose all required structured source sections");
  assert(!["visual", "augments", "choices", "raw_events", "raw_logcat"].some((key) => Object.hasOwn(liveState, key)), "structured watcher must not add visual, choice, or raw-log facts");
  assert(liveState.source?.item_source_diagnostics?.schema === "jcc-mumu-watch-source-diagnostics-v1", "live-state must expose bounded item source diagnostics");

  const revisionFixture = ".omx/runtime-evidence/mumu-gi-live/watch-verify-source-revisions.logcat.txt";
  await writeFile(revisionFixture, [
    '06-11 10:07:00.000  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4358 {"s":1}, id: 1',
    '06-11 10:07:00.200  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4354 {"bl":[]}, id: 2',
  ].join("\n"), "utf8");
  const revisionOutDir = ".omx/runtime-evidence/mumu-gi-live/watch-verify-source-revisions";
  await runFixture({ outDir: revisionOutDir, matchSessionId: "watch-verify-source-revisions", fixture: revisionFixture });
  const restartResult = await runNode([
    "tools/watch-jcc-mumu-runtime-logcat.mjs",
    "--out-dir",
    revisionOutDir,
    "--match-session-id",
    "watch-verify-source-revisions",
    "--logcat-fixture",
    revisionFixture,
  ]);
  assert(restartResult.code === 0, `same-session restart failed: ${restartResult.stderr || restartResult.stdout}`);
  const restartEvents = await readJsonl(path.join(revisionOutDir, "events.jsonl"));
  assert(JSON.stringify(restartEvents.map((event) => event.source_revision)) === JSON.stringify([3, 4]), "same-session restart must continue the revision cursor");
  const newMatchResult = await runNode([
    "tools/watch-jcc-mumu-runtime-logcat.mjs",
    "--out-dir",
    revisionOutDir,
    "--match-session-id",
    "watch-verify-source-revisions-new-match",
    "--logcat-fixture",
    revisionFixture,
  ]);
  assert(newMatchResult.code === 0, `new-match fixture failed: ${newMatchResult.stderr || newMatchResult.stdout}`);
  const newMatchEvents = await readJsonl(path.join(revisionOutDir, "events.jsonl"));
  assert(JSON.stringify(newMatchEvents.map((event) => event.source_revision)) === JSON.stringify([1, 2]), "new match must reset the revision cursor");

  const equipmentFixture = ".omx/runtime-evidence/mumu-gi-live/watch-verify-equipment-source-revisions.logcat.txt";
  await writeFile(equipmentFixture, [
    '06-11 10:07:10.000  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4358 {"s":1}, id: 1',
    '06-11 10:07:10.100  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4354 {"bl":[{"i":11453,"l":0,"t":0,"r":10,"b":10}]}, id: 2',
    '06-11 10:07:10.200  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4353 {"hl":[{"i":1451,"x":1,"y":1}]}, id: 3',
    '06-11 10:07:10.300  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4356 {"el":[{"i":3101,"l":0,"t":0,"r":2,"b":2}]}, id: 4',
    '06-11 10:07:10.400  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4356 {"el":[]}, id: 5',
    '06-11 10:07:10.500  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4358 {"s":2}, id: 6',
    '06-11 10:07:10.600  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4356 {"el":[{"i":3102,"l":0,"t":0,"r":2,"b":2}]}, id: 7',
  ].join("\n"), "utf8");
  const equipmentOutDir = ".omx/runtime-evidence/mumu-gi-live/watch-verify-equipment-source-revisions";
  await runFixture({ outDir: equipmentOutDir, matchSessionId: "watch-verify-equipment-source-revisions", fixture: equipmentFixture });
  const equipmentState = await readJson(path.join(equipmentOutDir, "state.json"));
  assert(equipmentState.items?.equipped_items?.length === 0, "trusted empty 4356 observation must clear own equipped items");
  assert(equipmentState.items?.equipped_items_source_revision === 5, "own equipped-item revision must ignore later S=2 diagnostics");
  assert(equipmentState.items?.visible_equipment_source_revision === 7, "visible equipment diagnostics must retain the latest 4356 revision");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "watcher has one fixed structured-source contract",
      "watcher writes only state, events, live-state, and summary artifacts",
      "structured board, bench, shop, equipment, inventory, phase, and revision facts remain available",
      "same-session revisions continue and new-match revisions reset",
      "trusted own equipment revisions remain isolated from S=2 diagnostics",
    ],
    source_revision: state.source_revision,
    source_event_count: events.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
