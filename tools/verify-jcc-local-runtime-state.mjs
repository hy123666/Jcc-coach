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

function companionRow(type, extra = {}) {
  return {
    schema: "jcc-android-companion-runtime-intake-v1",
    type,
    match_session_id: "match:test:abc",
    capture_session_id: "capture:test:def",
    frame_seq: extra.frame_seq ?? 1,
    monotonic_ms: extra.monotonic_ms ?? 1000,
    observed_at_epoch_ms: extra.observed_at_epoch_ms ?? 1780000000000,
    game_package: "com.tencent.jkchess",
    resolution: { width: 1600, height: 910 },
    orientation: 90,
    ...extra,
  };
}

function signal(type, payload, evidence = type) {
  return {
    type,
    payload,
    evidence,
    confidence: type === "match_start" ? 0.9 : 0.8,
    source_file: "runtime.log",
  };
}

async function writeCompanionLog(file) {
  const rows = [
    companionRow("semantic_observations", {
      observations: { kind: "capture_started", confidence: 1 },
      promotion_status: "candidate_only",
    }),
    companionRow("ocr_text_blocks", {
      frame_seq: 30,
      monotonic_ms: 2000,
      blocks: [
        { roi: "phase:top_bar", text: "2-1", lines: ["2-1"] },
        { roi: "economy:gold", text: "10", lines: ["10"] },
        { roi: "economy:level", text: "3级", lines: ["3级"] },
      ],
    }),
    companionRow("roi_observations", {
      frame_seq: 45,
      monotonic_ms: 2500,
      observations: {
        layout_id: "test",
        screen_state_candidate: { kind: "in_game_candidate", occupied_roi_count: 3, confidence: 0.95 },
        slot_occupancy: [
          { group: "bench_slots", slot: 0, occupied_candidate: true, confidence: 0.9 },
          { group: "board_slots", slot: 1, occupied_candidate: true, confidence: 0.9 },
          { group: "shop_slots", slot: 0, occupied_candidate: true, confidence: 0.9 },
        ],
        identity_candidates: [
          {
            roi_group: "board_slots",
            slot: 1,
            identity_status: "candidate",
            hero_name: "Must Not Promote From Visual",
            combined_score: 0.99,
            score_margin: 0.5,
          },
        ],
      },
      promotion_status: "candidate_only",
    }),
  ];
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function writeSignals(file, signals) {
  await writeFile(file, `${JSON.stringify({
    ok: true,
    signal_kind: "candidate_runtime_signals",
    signal_count: signals.length,
    signals,
  }, null, 2)}\n`, "utf8");
}

async function buildState(tempDir, signals) {
  const companionLog = path.join(tempDir, "companion.jsonl");
  const signalsFile = path.join(tempDir, "signals.json");
  const out = path.join(tempDir, "local-runtime-state.json");
  await writeCompanionLog(companionLog);
  await writeSignals(signalsFile, signals);
  const result = await runNode([
    "tools/build-jcc-local-runtime-state.mjs",
    "--companion-log",
    companionLog,
    "--signals",
    signalsFile,
    "--out",
    out,
  ]);
  assert(result.code === 0, `local runtime state exited ${result.code}\nstdout:${result.stdout}\nstderr:${result.stderr}`);
  return JSON.parse(await readFile(out, "utf8"));
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-local-runtime-state-verify-"));
  try {
    const strong = await buildState(tempDir, [
      signal("match_start", { game_start_time: "20260608180000", interpretation: "new_match_window_boundary" }, "GameStart time:20260608180000"),
      signal("local_report_chair_candidate", {
        frame: 100,
        turn_count: 1,
        chair_id: 2,
        next_report_index: 0,
        pre_report_index: 0,
        report_player_count: 1,
        interpretation: "local_report_chair_candidate",
      }),
      signal("switch_player_chair", {
        actor_ref: "actor:local",
        chair_id: 2,
        ext: "TurnStartBack",
        interpretation: "view_or_actor_switch_candidate",
      }),
      signal("get_on_chess_candidate", {
        actor_ref: "actor:local",
        entity_id: 200111,
        action_chair_id_candidate: 2,
        raw_hero_id: 12456,
        star_or_state: 1,
        action: "get_on_chess",
        to: { x: 4, y: -1 },
        hero: { raw_id: 12456, champion_id: "2456", star_tier: 1, name: "Local Bench Unit" },
      }),
      signal("get_on_chess_candidate", {
        actor_ref: "actor:other",
        entity_id: 300111,
        action_chair_id_candidate: 3,
        raw_hero_id: 11462,
        star_or_state: 1,
        action: "get_on_chess",
        to: { x: 1, y: 2 },
        hero: { raw_id: 11462, champion_id: "1462", star_tier: 1, name: "Other Board Unit" },
      }),
    ]);
    assert(strong.local.binding_status === "strongly_bound", "local chair must bind from current signals");
    assert(strong.bench_units.length === 1, "primary local bench unit must promote from local action reducer");
    assert(strong.bench_units[0].name === "Local Bench Unit", "local bench identity must come from action data");
    assert(strong.board_units.length === 0, "non-local board unit must not promote");
    assert(!JSON.stringify(strong).includes("Must Not Promote From Visual"), "visual identity candidate must not become board/bench identity");
    assert(strong.action.action_scope.secondary_global_count === 1, "other player action must remain debug-only");

    const weak = await buildState(tempDir, [
      signal("match_start", { game_start_time: "20260608190000", interpretation: "new_match_window_boundary" }, "GameStart time:20260608190000"),
      signal("local_report_chair_candidate", { frame: 100, turn_count: 1, chair_id: 1, interpretation: "local_report_chair_candidate" }),
      signal("local_report_chair_candidate", { frame: 200, turn_count: 2, chair_id: 4, interpretation: "local_report_chair_candidate" }),
      signal("get_on_chess_candidate", {
        entity_id: 400111,
        action_chair_id_candidate: 4,
        raw_hero_id: 12456,
        star_or_state: 1,
        action: "get_on_chess",
        to: { x: 4, y: -1 },
        hero: { raw_id: 12456, champion_id: "2456", star_tier: 1, name: "Conflict Unit" },
      }),
    ]);
    assert(weak.local.binding_status === "weakly_bound_conflicting_reports", "conflicting local reports must weaken binding");
    assert(weak.board_units.length === 0 && weak.bench_units.length === 0, "weak binding must block board/bench promotion");
    assert(weak.pollution_guard.secondary_global_actions_strategy_allowed === false, "secondary global actions must remain barred from strategy");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "local runtime state binds local chair per current match signals",
        "primary local actions promote bench/board identities",
        "secondary global actions stay debug-only",
        "visual 3D identity candidates do not promote",
        "weak/conflicting local binding blocks board/bench output",
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
