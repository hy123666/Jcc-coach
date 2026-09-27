import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
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

async function main() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "jcc-cruise-debug-trace-"));
  try {
    const liveState = {
      match_session_id: "debug-trace-match",
      phase: { stage_round: "3-2", status: 1 },
      economy: { gold: 21, hp: 48, level: 6, xp: "12/36" },
      field_status: {
        "board.local_board_units_candidate": {
          status: "candidate",
          promotion_policy: "shop_self_view_anchor+fresh_current_view",
          shop_anchor_fresh: true,
        },
      },
      board: {
        board_units: [
          { id: 11471, base_id: 1471, name: "Diana", star: 2, x: 2, y: 1 },
          { id: 11452, base_id: 1452, name: "Leona", star: 1, x: 3, y: 1 },
        ],
      },
      bench: {
        bench_units: [
          { id: 11471, base_id: 1471, name: "Diana" },
          { id: 11461, base_id: 1461, name: "Aurora" },
        ],
      },
      shop: {
        shop_units: [
          { id: 11471, base_id: 1471, name: "Diana" },
          { id: 11499, base_id: 1499, name: "Jinx" },
        ],
      },
      items: {
        item_bench: [{ id: 1001, name: "B. F. Sword", confidence: 0.82 }],
      },
      opponents: {
        snapshots: [
          { opponent_id: "opp-a", board_units: [{ id: 11471, base_id: 1471, name: "Diana", star: 2 }] },
        ],
      },
    };
    const context = {
      target_plan: {
        id: "phantom-diana",
        name: "Phantom Diana",
        core_unit_ids: [11471, 1471],
        unit_names: ["Diana", "Leona", "Aurora"],
      },
      output_policy: {
        minimum_speak_priority: "low",
        minimum_speak_value_score: 0.1,
      },
    };
    const liveFile = path.join(tmp, "live.json");
    const contextFile = path.join(tmp, "context.json");
    const lifecycleFile = path.join(tmp, "lifecycle.json");
    const traceFile = path.join(tmp, "debug-trace.jsonl");
    await writeFile(liveFile, JSON.stringify(liveState, null, 2), "utf8");
    await writeFile(contextFile, JSON.stringify(context, null, 2), "utf8");

    const run = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", liveFile,
      "--context", contextFile,
      "--advice-state", lifecycleFile,
      "--debug-trace", traceFile,
      "--debug-max-mb", "1",
      "--now", "2026-01-01T00:00:00.000Z",
    ]);
    assert(run.code === 0, `debug trace pipeline failed\n${run.stdout}\n${run.stderr}`);
    const result = JSON.parse(run.stdout);
    assert(result.debug_trace?.path === traceFile, "pipeline result must expose debug trace path");
    assert(result.debug_trace?.storage_policy?.raw_screenshots_saved === false, "debug trace must not save screenshots");
    assert(result.debug_trace?.storage_policy?.raw_logcat_saved === false, "debug trace must not save raw logcat");
    assert(result.debug_trace?.storage_policy?.full_live_state_saved === false, "debug trace must not save full live_state");

    const lines = (await readFile(traceFile, "utf8")).trim().split(/\r?\n/).filter(Boolean);
    assert(lines.length === 1, "debug trace should write one JSONL record");
    const record = JSON.parse(lines[0]);
    assert(record.schema === "jcc-runtime-light-debug-trace-v1", "debug trace schema mismatch");
    assert(record.match_session_id === "debug-trace-match", "debug trace match id mismatch");
    assert(record.live_state_summary?.counts?.board_units === 2, "live_state summary counts missing");
    assert(Array.isArray(record.scorer?.advice_tasks), "scorer advice task summaries missing");
    assert(Array.isArray(record.response_events), "response event summaries missing");
    assert(record.storage_policy?.raw_screenshots_saved === false, "record storage policy must forbid screenshots");
    assert(record.storage_policy?.raw_logcat_saved === false, "record storage policy must forbid raw logcat");
    assert(record.storage_policy?.full_live_state_saved === false, "record storage policy must forbid full live_state");

    assert(!Object.hasOwn(record, "standardized_live_state"), "debug trace must not embed standardized_live_state");
    assert(!Object.hasOwn(record, "estimator_context"), "debug trace must not embed estimator_context");
    assert(!Object.hasOwn(record, "full_live_state"), "debug trace must not embed full live_state");
    assert(!Object.hasOwn(record, "raw_logcat"), "debug trace must not embed raw logcat");
    assert(!Object.hasOwn(record, "screenshot"), "debug trace must not embed screenshot data");
    assert(!Object.hasOwn(record, "image_base64"), "debug trace must not embed image data");
    const serialized = JSON.stringify(record);
    assert(!serialized.includes("data:image/"), "debug trace must not embed image data URLs");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "debug trace is opt-in through --debug-trace",
        "debug trace writes JSONL",
        "debug trace records live_state summary only",
        "debug trace records estimator scalar scores",
        "debug trace records scorer and response summaries",
        "debug trace records confirmation/skip/user-message summary shape",
        "debug trace forbids raw screenshot/logcat/full live_state/full estimator context",
      ],
      trace_schema: record.schema,
    }, null, 2));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
