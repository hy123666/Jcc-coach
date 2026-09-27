import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

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

async function writeSyntheticInputs(tempDir) {
  const hash = crypto.createHash("sha256").update("synthetic-visual-live-state").digest("hex");
  const liveState = {
    ok: true,
    live_state: {
      economy: { hp: 88, gold: "unknown", level: "unknown" },
      shop: { shop_units: [{ slot: 0, id: "1001", source_signal_type: "shop_roll_candidate" }] },
      board: { board_units: [] },
      bench: { bench_units: [] },
      source_insights: {
        board_bench_action_candidates: {
          promotion_decision: { status: "not_promoted" },
        },
      },
      field_status: {
        "economy.hp": { status: "verified", source_type: "external_file", confidence: 0.72 },
        "shop.shop_units": { status: "verified", source_type: "external_file", confidence: 0.86 },
      },
      metadata: { source_health: { adb_transport: "verified" } },
      match_session_id: "match:test:001",
    },
    metadata: { source_health: { adb_transport: "verified" }, match_session_id: "match:test:001" },
  };
  const visual = {
    ok: true,
    visual_observations: {
      frame_id: `frame:${hash.slice(0, 16)}`,
      frame_hash: hash,
      phase: {
        value: { value: "planning_shop", stage_round: "3-6", current_round_text: "3-6" },
        status: "visual_candidate",
        source: "explicit_phase_hint",
        confidence: 0.9,
        evidence: { frame_id: `frame:${hash.slice(0, 16)}`, crop: { x: 0, y: 0, w: 1, h: 1 } },
      },
      economy: {
        hp: { status: "visual_candidate", source: "vision_model", confidence: 0.8, value: 86, evidence: { frame_id: `frame:${hash.slice(0, 16)}` } },
        gold: { status: "missing", source: "vision_model", confidence: 0, evidence: { frame_id: `frame:${hash.slice(0, 16)}` } },
        level: { status: "missing", source: "vision_model", confidence: 0, evidence: { frame_id: `frame:${hash.slice(0, 16)}` } },
        xp: { status: "visual_candidate", source: "vision_model", confidence: 0.7, value: 4, evidence: { frame_id: `frame:${hash.slice(0, 16)}` } },
      },
      shop: { shop_units: [{ slot: 0, status: "visual_candidate", source: "vision_model", confidence: 0.45, evidence: { frame_id: `frame:${hash.slice(0, 16)}` } }] },
      board: { board_units: [{ status: "visual_candidate", source: "vision_model", confidence: 0.35, evidence: { frame_id: `frame:${hash.slice(0, 16)}` } }] },
      bench: { bench_units: [{ slot: 0, status: "visual_candidate", source: "vision_model", confidence: 0.45, evidence: { frame_id: `frame:${hash.slice(0, 16)}` } }] },
      augments: {
        selection_active: { value: false, status: "missing", source: "phase_classifier", confidence: 0.2, evidence: { frame_id: `frame:${hash.slice(0, 16)}`, crop: { x: 0.07, y: 0.16, w: 0.86, h: 0.62 } } },
        choices: [
          { slot: 0, status: "visual_candidate", source: "vision_model", confidence: 0.91, catalog_match: { id: "30571", name: "挑个好伙计！" }, evidence: { frame_id: `frame:${hash.slice(0, 16)}` } },
          { slot: 1, status: "visual_candidate", source: "vision_model", confidence: 0.88, name: "清晰头脑", evidence: { frame_id: `frame:${hash.slice(0, 16)}` } },
          { slot: 2, status: "visual_candidate", source: "vision_model", confidence: 0.86, text: "DD街区", evidence: { frame_id: `frame:${hash.slice(0, 16)}` } },
        ],
        selected_augments: [],
      },
      items: {
        choice_options: [{ slot: 0, status: "visual_candidate", source: "vision_model", confidence: 0.86, catalog_match: { id: "1001", name: "暴风之剑" }, evidence: { frame_id: `frame:${hash.slice(0, 16)}` } }],
        item_bench: [{ slot: 0, status: "visual_candidate", source: "vision_model", confidence: 0.8, catalog_match: { id: "1001", name: "暴风之剑" }, evidence: { frame_id: `frame:${hash.slice(0, 16)}` } }],
        equipped_items: [{
          slot: 0,
          status: "visual_candidate",
          source: "vision_model",
          confidence: 0.8,
          catalog_match: { id: "2010", name: "equipped item candidate" },
          evidence: { frame_id: `frame:${hash.slice(0, 16)}` },
          phase_gate: {
            status_code: 2,
            status: "non_self_current_view_candidate",
            promotion_allowed_after_roi_calibration: false,
            reason: "s2_is_current_view_active_not_safe_for_own_equipped_item_promotion",
          },
        }],
      },
      metadata: {
        match_session_id: "match:test:001",
        source: "synthetic_fixture",
        storage_policy: { default_persist_raw_frames: false, ring_buffer_frame_limit: 30 },
        layout: { layout_id: "jcc-mumu-16x9-normalized-v1", status: "matched" },
      },
    },
  };
  visual.visual_observations.diagnostics = {
    non_self_current_view: {
      selected_augments: [
        { slot: 0, status: "visual_candidate", source: "vision_model", confidence: 0.93, catalog_match: { id: "999101", name: "non-self augment diagnostic" }, owner_scope: "non_self_current_view_diagnostic" },
      ],
      item_bench: [
        { slot: 0, status: "visual_candidate", source: "vision_model", confidence: 0.93, catalog_match: { id: "999102", name: "non-self item diagnostic" }, owner_scope: "non_self_current_view_diagnostic" },
      ],
      equipped_items: [
        { slot: 0, status: "visual_candidate", source: "vision_model", confidence: 0.93, catalog_match: { id: "999103", name: "non-self equipped item diagnostic" }, owner_scope: "non_self_current_view_diagnostic" },
      ],
    },
  };
  const liveStateFile = path.join(tempDir, "match-live-state.json");
  const visualFile = path.join(tempDir, "visual-observations.json");
  await writeFile(liveStateFile, `${JSON.stringify(liveState, null, 2)}\n`, "utf8");
  await writeFile(visualFile, `${JSON.stringify(visual, null, 2)}\n`, "utf8");
  return { liveStateFile, visualFile };
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-visual-live-state-"));
  try {
    const { liveStateFile, visualFile } = await writeSyntheticInputs(tempDir);
    const outFile = path.join(tempDir, "visual-live-state.json");
    const result = await runNode([
      "tools/build-jcc-visual-live-state.mjs",
      "--live-state",
      liveStateFile,
      "--visual-observations",
      visualFile,
      "--out",
      outFile,
    ]);
    assert(result.code === 0, `visual live-state apply exited ${result.code}\n${result.stderr}`);
    const merged = JSON.parse(await readFile(outFile, "utf8"));
    assert(merged.live_state.economy.hp === 88, "verified HP must be preserved");
    assert(!merged.live_state.phase?.stage_round, "host multimodal refresh_self_state must not promote stage_round; self-state ROI OCR owns stage facts");
    assert(!Object.hasOwn(merged.live_state.economy, "xp"), "host multimodal refresh_self_state must not promote XP into economy facts");
    assert(merged.live_state.shop.shop_units[0].source_signal_type === "shop_roll_candidate", "log shop units must be preserved");
    assert(merged.live_state.visual.phase.value.stage_round === "3-6", "visual phase stage_round should remain available only as diagnostic evidence");
    assert(merged.live_state.visual.match_session_id === "match:test:001", "match session id missing");
    assert(merged.live_state.visual.board.board_units.length === 1, "visual board candidates missing");
    assert(merged.live_state.visual.bench.bench_units.length === 1, "visual bench candidates missing");
    assert(merged.live_state.visual.items.choice_options[0].catalog_match.id === "1001", "visual item choice missing");
    assert(!("opponents" in merged.live_state.visual), "opponent current-view facts must be absent from product visual state");
    assert(!Object.keys(merged.live_state.field_status || {}).some((field) => field.startsWith("opponents.")), "opponent current-view fields must not create product field_status");
    assert(merged.live_state.field_status["economy.hp"].status === "verified", "HP status must remain verified");
    assert(!merged.live_state.field_status["phase.stage_round"], "non-HUD visual stage must not create a promoted stage status");
    assert(merged.live_state.field_status["economy.xp"].reason.includes("self-state ROI OCR"), "non-HUD economy candidate must be diagnostic only");
    assert(merged.live_state.field_status["items.choice_options"].status === "candidate", "item choice status mismatch");
    assert(merged.live_state.field_status["items.item_bench"].status === "visual_candidate", "item bench status mismatch");
    assert(merged.live_state.field_status["items.equipped_items"].status === "visual_candidate", "equipped item visual status mismatch");
    assert(merged.live_state.field_status["items.equipped_items"].promotion_status === "blocked_by_phase_gate", "combat equipped items must be blocked by phase gate");
    assert(merged.live_state.field_status["items.equipped_items"].phase_gate.status === "non_self_current_view_candidate", "equipped item current-view phase gate must be carried into field status");
    assert(merged.live_state.augments.current_choice_set?.choices?.length === 3, "visual augment choices must promote into current_choice_set for advice pipeline");
    assert(merged.live_state.augments.choice_candidates?.some((choice) => choice.name === "DD街区"), "visual augment choices must preserve A-Z/digit names");
    assert(merged.live_state.field_status["augments.current_choice_set"].status === "candidate", "current choice set must be marked candidate");
    assert(merged.live_state.field_status["augments.current_choice_set"].replacement_policy === "visual_fallback_only_when_roi_ocr_choice_set_absent", "visual current choice set must be fallback-only");
    assert(merged.live_state.field_status["board.board_units"].status === "visual_candidate", "board status mismatch");
    assert(merged.live_state.field_status["board.board_units"].promotion_status === "candidate_not_verified", "board must not be verified by visual ROI");
    assert(merged.live_state.field_status["bench.bench_units"].promotion_status === "candidate_not_verified", "bench must not be verified by visual ROI");
    assert(merged.live_state.metadata.source_health.visual.storage_policy.default_persist_raw_frames === false, "visual storage policy missing");
    assert(merged.visual_contract.match_session_policy.required_start_event === "new_game_start", "match session policy missing");
    assert(merged.visual_contract.forbidden_sources.includes("Frida hooks"), "visual contract forbidden source missing");
    assert(merged.live_state.source_insights.board_bench_action_candidates.promotion_decision.status === "not_promoted", "source insights must be preserved");
    const mismatchVisualFile = path.join(tempDir, "visual-observations-mismatch.json");
    const mismatchVisual = JSON.parse(await readFile(visualFile, "utf8"));
    mismatchVisual.visual_observations.metadata.match_session_id = "match:test:002";
    await writeFile(mismatchVisualFile, `${JSON.stringify(mismatchVisual, null, 2)}\n`, "utf8");
    const mismatchResult = await runNode([
      "tools/build-jcc-visual-live-state.mjs",
      "--live-state",
      liveStateFile,
      "--visual-observations",
      mismatchVisualFile,
    ]);
    assert(mismatchResult.code !== 0, "mismatched match_session_id must reject visual live-state apply");
    assert(/match_session_id mismatch/i.test(mismatchResult.stderr), "mismatch error must be explicit");

    const roiChoiceLiveStateFile = path.join(tempDir, "match-live-state-roi-choice.json");
    const roiChoiceLiveState = JSON.parse(await readFile(liveStateFile, "utf8"));
    roiChoiceLiveState.live_state.augments = {
      current_choice_set: {
        schema: "jcc-augment-current-choice-set-v1",
        source: "augment_choice_roi_ocr",
        choices: [
          { slot: 0, name: "ROI A" },
          { slot: 1, name: "ROI B" },
          { slot: 2, name: "ROI C" },
        ],
      },
    };
    roiChoiceLiveState.live_state.field_status["augments.current_choice_set"] = {
      status: "candidate",
      source: "augment_choice_roi_ocr",
    };
    await writeFile(roiChoiceLiveStateFile, `${JSON.stringify(roiChoiceLiveState, null, 2)}\n`, "utf8");
    const roiChoiceOutFile = path.join(tempDir, "visual-live-state-roi-choice.json");
    const roiChoiceResult = await runNode([
      "tools/build-jcc-visual-live-state.mjs",
      "--live-state",
      roiChoiceLiveStateFile,
      "--visual-observations",
      visualFile,
      "--out",
      roiChoiceOutFile,
    ]);
    assert(roiChoiceResult.code === 0, `ROI choice visual live-state apply exited ${roiChoiceResult.code}\n${roiChoiceResult.stderr}`);
    const roiChoiceMerged = JSON.parse(await readFile(roiChoiceOutFile, "utf8"));
    assert(roiChoiceMerged.live_state.augments.current_choice_set.choices[0].name === "ROI A", "host visual must not replace ROI/OCR current choice set");
    assert(roiChoiceMerged.live_state.augments.visual_choice_candidates?.length === 3, "host visual choices should remain available as conflict evidence");
    assert(
      roiChoiceMerged.live_state.field_status["augments.visual_choice_candidates"].promotion_status === "conflict_check_only_roi_ocr_current_choice_set_primary",
      "host visual choice candidates must be conflict-check only when ROI/OCR exists",
    );

    const staleStageLiveStateFile = path.join(tempDir, "match-live-state-stale-stage.json");
    const staleStageLiveState = JSON.parse(await readFile(liveStateFile, "utf8"));
    staleStageLiveState.live_state.phase = {
      ...(staleStageLiveState.live_state.phase || {}),
      stage_round: "2-1",
      current_round_text: "2-1",
    };
    staleStageLiveState.live_state.field_status["phase.stage_round"] = {
      status: "candidate",
      source_type: "mumu_bridge",
      source: "mumu_bridge",
      confidence: 0.62,
    };
    await writeFile(staleStageLiveStateFile, `${JSON.stringify(staleStageLiveState, null, 2)}\n`, "utf8");
    const hudVisualFile = path.join(tempDir, "visual-observations-hud.json");
    const hudVisual = JSON.parse(await readFile(visualFile, "utf8"));
    hudVisual.visual_observations.phase = {
      value: { value: "3-6", stage_round: "3-6", current_round_text: "3-6" },
      status: "visual_candidate",
      source: "self_state_roi_ocr",
      confidence: 0.92,
      evidence: { crop: { x: 0.44, y: 0.02, w: 0.1, h: 0.05 } },
    };
    hudVisual.visual_observations.economy.gold = {
      status: "visual_candidate",
      source: "self_state_roi_ocr",
      confidence: 0.9,
      value: 50,
      evidence: { crop: { x: 0.5, y: 0.91, w: 0.08, h: 0.04 } },
    };
    hudVisual.visual_observations.metadata.source = "self_state_roi_ocr";
    await writeFile(hudVisualFile, `${JSON.stringify(hudVisual, null, 2)}\n`, "utf8");
    const hudOutFile = path.join(tempDir, "visual-live-state-hud.json");
    const hudResult = await runNode([
      "tools/build-jcc-visual-live-state.mjs",
      "--live-state",
      staleStageLiveStateFile,
      "--visual-observations",
      hudVisualFile,
      "--out",
      hudOutFile,
    ]);
    assert(hudResult.code === 0, `HUD visual live-state apply exited ${hudResult.code}\n${hudResult.stderr}`);
    const hudMerged = JSON.parse(await readFile(hudOutFile, "utf8"));
    assert(hudMerged.live_state.phase.stage_round === "3-6", "self-state ROI OCR must replace stale bridge stage_round");
    assert(hudMerged.live_state.field_status["phase.stage_round"].promotion_status === "replaced_stale_bridge_stage_round_by_hud", "HUD stale-stage replacement status mismatch");
    assert(hudMerged.live_state.economy.gold === 50, "self-state ROI OCR must fill missing gold");
    assert(hudMerged.live_state.shop.shop_units[0].source_signal_type === "shop_roll_candidate", "self-state ROI OCR must not overwrite shop facts");
    assert(
      !hudMerged.live_state.augments?.current_choice_set,
      "refresh_self_state visual observations must not promote visible augment choices into current_choice_set",
    );
    assert(
      !hudMerged.live_state.augments?.choice_candidates,
      "refresh_self_state visual observations must not promote visible augment choice_candidates",
    );

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "verified log fields preserved",
        "same match_session_id accepted",
        "cross-match visual observations rejected",
        "visual candidates added under visual section",
        "host multimodal refresh_self_state HUD facts stay diagnostic only",
    "non-product visual diagnostics stay outside product visual state",
        "host multimodal augment choices are fallback-only when ROI/OCR is absent",
        "host multimodal augment choices cannot replace ROI/OCR current_choice_set",
        "self-state ROI OCR can replace stale stage_round without overwriting shop facts",
        "refresh_self_state visual observations cannot promote augment choices",
        "visual board/bench not promoted to verified",
        "source insights preserved",
        "bounded storage metadata attached",
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
