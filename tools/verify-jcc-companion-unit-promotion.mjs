#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

function message(overrides = {}) {
  return {
    schema: "jcc-android-companion-runtime-intake-v1",
    type: "frame_meta",
    match_session_id: "match:test:unit-promotion",
    capture_session_id: "capture:test:unit-promotion",
    frame_seq: 1,
    monotonic_ms: 1000,
    observed_at_epoch_ms: 1780000000000,
    game_package: "com.tencent.jkchess",
    resolution: { width: 1600, height: 910 },
    orientation: 90,
    storage_policy: "no_frame_or_screenshot_persistence",
    payload_policy: "metadata_only_mvp",
    ...overrides,
  };
}

function slot(group, slot, occupied, confidence = occupied ? 0.9 : 0.2) {
  return {
    group,
    name: group.replace(/s$/, ""),
    slot,
    occupied_candidate: occupied,
    confidence,
    variance: occupied ? 2400 : 250,
    saturation: occupied ? 0.55 : 0.2,
  };
}

function roiObservation(frameSeq, withMargin = true) {
  const identity = {
    roi_group: "board_slots",
    roi_name: "board_slot",
    slot: 10,
    identity_status: "candidate",
    hero_id: "11113",
    hero_name: "Illaoi",
    hash_distance: 9,
    confidence: 0.859375,
  };
  if (withMargin) {
    identity.second_best_hash_distance = 13;
    identity.hash_distance_margin = 4;
  }
  return message({
    type: "roi_observations",
    frame_seq: frameSeq,
    monotonic_ms: 1000 + frameSeq,
    promotion_status: "candidate_only",
    observations: {
      screen_state_candidate: { kind: "in_game_candidate", confidence: 0.95 },
      slot_occupancy: [
        ...Array.from({ length: 5 }, (_, index) => slot("shop_slots", index, true, 0.9)),
        ...Array.from({ length: 9 }, (_, index) => slot("bench_slots", index, false, 0.2)),
        ...Array.from({ length: 28 }, (_, index) => slot("board_slots", index, index === 10, index === 10 ? 0.9 : 0.2)),
      ],
      identity_candidates: [identity],
    },
  });
}

function modernRoiObservation(frameSeq) {
  return message({
    type: "roi_observations",
    frame_seq: frameSeq,
    monotonic_ms: 1000 + frameSeq,
    promotion_status: "candidate_only",
    observations: {
      screen_state_candidate: { kind: "in_game_candidate", confidence: 0.95 },
      slot_occupancy: [
        ...Array.from({ length: 5 }, (_, index) => slot("shop_slots", index, true, 0.9)),
        ...Array.from({ length: 9 }, (_, index) => slot("bench_slots", index, false, 0.2)),
        ...Array.from({ length: 28 }, (_, index) => slot("board_slots", index, index === 10, index === 10 ? 0.9 : 0.2)),
      ],
      identity_candidates: [{
        roi_group: "board_slots",
        roi_name: "board_slot",
        slot: 10,
        identity_status: "candidate",
        hero_id: "11113",
        hero_name: "Illaoi",
        hash_distance: 13,
        confidence: 0.81,
        combined_score: 0.712,
        score_margin: 0.032,
        matcher_version: "multi_feature_v2",
      }],
    },
  });
}

function ocr(frameSeq) {
  return message({
    type: "ocr_text_blocks",
    frame_seq: frameSeq,
    monotonic_ms: 1000 + frameSeq,
    promotion_status: "candidate_only",
    blocks: {
      engine: "mlkit_chinese_text_recognition",
      blocks: [
        { roi: { group: "fast_ocr", name: "critical_sheet" }, text: "1-4 1/2", line_count: 2, lines: ["1-4", "1/2"] },
      ],
    },
  });
}

function runNode(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function assert(condition, messageText) {
  if (!condition) throw new Error(messageText);
}

async function summarize(rows) {
  const temp = await mkdtemp(join(tmpdir(), "jcc-companion-unit-promotion-"));
  const input = join(temp, "accepted.jsonl");
  try {
    await writeFile(input, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    const result = await runNode(["tools/summarize-jcc-companion-live-state.mjs", "--input", input, "--last", "50"]);
    assert(result.code === 0, `summary exited ${result.code}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function main() {
  const promotedRows = [
    message({ match_session_id: "match:old", frame_seq: 1, monotonic_ms: 1 }),
    roiObservation(10, true),
    roiObservation(20, true),
    roiObservation(30, true),
    ocr(31),
  ];
  const promoted = await summarize(promotedRows);
  const units = promoted.agent_state.promoted.board_units?.units || [];
  assert(units.length === 1, "board unit should promote when slot and identity are repeatedly verified");
  assert(units[0].slot === 10 && units[0].hero_id === "11113", "verified board unit should carry slot and hero id");
  assert(promoted.identity_stability.verified.board_units[0].evidence.avg_hash_margin === 4, "verified unit should include hash margin evidence");

  const legacyRows = [
    roiObservation(10, false),
    roiObservation(20, false),
    roiObservation(30, false),
    ocr(31),
  ];
  const legacy = await summarize(legacyRows);
  assert(!legacy.agent_state.promoted.board_units, "legacy identity rows without hash margin must not promote");
  assert(
    legacy.agent_state.candidates.identity_stability.candidates.some((row) => row.blockers.includes("identity_margin_unavailable")),
    "legacy rows should expose identity_margin_unavailable blocker"
  );

  const modernRows = [
    modernRoiObservation(10),
    modernRoiObservation(20),
    modernRoiObservation(30),
    ocr(31),
  ];
  const modern = await summarize(modernRows);
  const modernUnits = modern.agent_state.promoted.board_units?.units || [];
  assert(modernUnits.length === 1, "modern multi-feature matcher evidence should promote when stable");
  assert(modernUnits[0].evidence.matcher_policy === "multi_feature_v2", "modern promotion should record matcher policy");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "verified board_units require temporal slot stability",
      "verified board_units require repeated same-hero identity",
      "verified board_units require hash-distance margin",
      "legacy identity rows without margin remain candidates",
      "modern multi-feature identity can promote with score margin",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
