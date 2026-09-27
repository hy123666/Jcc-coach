#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

function message(overrides = {}) {
  return {
    schema: "jcc-android-companion-runtime-intake-v1",
    type: "frame_meta",
    match_session_id: "match:test:summary",
    capture_session_id: "capture:test:summary",
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

function roiSlot(group, slot, occupied, confidence = occupied ? 0.9 : 0.2) {
  return {
    group,
    name: group.replace(/s$/, ""),
    slot,
    occupied_candidate: occupied,
    confidence,
    variance: occupied ? 2100 : 300,
    saturation: occupied ? 0.5 : 0.2,
  };
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

async function main() {
  const temp = await mkdtemp(join(tmpdir(), "jcc-companion-summary-"));
  const input = join(temp, "accepted.jsonl");
  try {
    const rows = [
      message({ match_session_id: "match:old", frame_seq: 1 }),
      message({ frame_seq: 2 }),
      message({
        type: "roi_observations",
        frame_seq: 3,
        promotion_status: "candidate_only",
        observations: {
          screen_state_candidate: { kind: "in_game_candidate", confidence: 0.95 },
          slot_occupancy: [
            ...Array.from({ length: 5 }, (_, slot) => roiSlot("shop_slots", slot, true, 0.95)),
            ...Array.from({ length: 9 }, (_, slot) => roiSlot("bench_slots", slot, slot <= 1, slot <= 1 ? 0.88 : 0.2)),
            ...Array.from({ length: 28 }, (_, slot) => roiSlot("board_slots", slot, slot === 10, slot === 10 ? 0.82 : 0.25)),
          ],
          identity_candidates: [
            {
              roi_group: "board_slots",
              slot: 10,
              identity_status: "candidate",
              hero_id: "11113",
              hero_name: "伊莉丝",
              hash_distance: 12,
              confidence: 0.8125,
            },
          ],
        },
      }),
      message({
        type: "ocr_text_blocks",
        frame_seq: 4,
        promotion_status: "candidate_only",
        blocks: {
          engine: "mlkit_chinese_text_recognition",
          blocks: [
            {
              roi: { group: "economy", name: "gold" },
              text: "",
              line_count: 0,
              native_blocks: {
                engine: "jcc_native_ppocrv5_ncnn_mobile",
                available: true,
                text_recognition_active: true,
                blocks: [{ text: "42", confidence: 0.91 }],
              },
            },
            { roi: { group: "phase", name: "top_bar" }, text: "总5-2 18", line_count: 1 },
            { roi: { group: "phase", name: "shop_band" }, text: "8级 购买经验 4 10/68 13% 20% 32% 30% 5%", line_count: 1 },
            { roi: { group: "economy", name: "hp_local_scoreboard_detected_row" }, text: "玩家 60 对手 52", line_count: 1 },
          ],
        },
      }),
    ];
    await writeFile(input, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    const result = await runNode(["tools/summarize-jcc-companion-live-state.mjs", "--input", input, "--last", "20"]);
    assert(result.code === 0, `summary exited ${result.code}\n${result.stderr}`);
    const summary = JSON.parse(result.stdout);
    assert(summary.latest_session_id === "match:test:summary", "latest match session must be isolated");
    assert(summary.agent_state.status === "partially_promoted", "agent state should be partially promoted");
    assert(summary.agent_state.promoted.phase.value === "prepare_or_shop_candidate", "phase should promote");
    assert(summary.agent_state.promoted.round.value === "5-2", "round should promote");
    assert(summary.agent_state.promoted.level.value === 8, "level should promote");
    assert(summary.agent_state.promoted.xp.current === 10 && summary.agent_state.promoted.xp.required === 68, "xp should promote");
    assert(summary.agent_state.promoted.gold.value === 42, "gold should promote from the native OCR gold ROI");
    assert(summary.ocr.text_blocks.some((block) => block.roi === "economy:gold" && block.native_text === "42"), "native OCR text must be summarized");
    assert(summary.agent_state.candidates.shop_slots.occupied_slots === 5, "shop slots should be temporal candidates");
    assert(summary.agent_state.candidates.board_slots.promotion_status === "candidate_not_verified", "board must remain candidate");
    assert(summary.agent_state.quarantine.some((item) => item.field === "board_units"), "board_units quarantine missing");
    assert(summary.agent_state.pollution_guard.cross_match_fusion_allowed === false, "cross-match guard missing");
    assert(!result.stdout.includes("frame_base64"), "summary must not expose frame payloads");
    console.log(JSON.stringify({
      ok: true,
      checked: [
        "latest match_session isolated",
        "phase/round/level/xp promoted from OCR evidence",
        "gold promoted from isolated economy ROI",
        "native OCR blocks fused into OCR summary",
        "ROI slots summarized by temporal stability",
        "board/bench/shop units kept out of verified state",
        "pollution guard emitted",
        "no frame payload exposed",
      ],
    }, null, 2));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
