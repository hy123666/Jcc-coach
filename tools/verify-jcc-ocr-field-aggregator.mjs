import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { writeSyntheticHudFrame } from "./jcc_test_hud_fixture.mjs";

const execFileAsync = promisify(execFile);

async function runAggregator(tmp, name, results, requestedFields = null, requestedFieldDiagnostics = null) {
  const input = path.join(tmp, `${name}-ocr-result.json`);
  const out = path.join(tmp, `${name}-facts.json`);
  await writeFile(input, JSON.stringify({
    schema: "jcc-ocr-result-batch-v1",
    ok: true,
    ...(requestedFields ? { requested_fields: requestedFields } : {}),
    ...(requestedFieldDiagnostics ? { requested_field_diagnostics: requestedFieldDiagnostics } : {}),
    results,
  }, null, 2), "utf8");
  const python = process.env.JCC_OCR_PYTHON || ".venv-ocr/Scripts/python.exe";
  await execFileAsync(path.resolve(python), [
    path.resolve("tools/jcc_ocr_field_aggregator.py"),
    "--ocr-result", input,
    "--out", out,
  ], { cwd: process.cwd(), windowsHide: true });
  return JSON.parse(await readFile(out, "utf8"));
}

async function runPythonJson(script, args) {
  const python = process.env.JCC_OCR_PYTHON || ".venv-ocr/Scripts/python.exe";
  const { stdout } = await execFileAsync(path.resolve(python), [
    path.resolve(script),
    ...args,
  ], { cwd: process.cwd(), windowsHide: true, maxBuffer: 1024 * 1024 * 10 });
  return JSON.parse(stdout);
}

function hpEvidence(overrides = {}) {
  return {
    detector: "local_scoreboard_avatar_ring",
    scoreboard_layout_status: "standard_player_list",
    local_row_status: "verified_local_row",
    selected_row: 1,
    edge_strength: 1094.09,
    diameter: 60,
    coverage: 0.875,
    color_coverage: 0.375,
    ...overrides,
  };
}

async function assertHp(tmp, name, result, expected, expectedStatus = expected === null ? "missing" : "observed") {
  const facts = await runAggregator(tmp, name, [result]);
  assert.equal(facts.economy.hp, expected);
  assert.equal(facts.field_status["economy.hp"].status, expectedStatus);
  return facts;
}

async function main() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "jcc-ocr-aggregator-"));
  try {
    const facts = await runAggregator(tmp, "normal", [
      { task_id: "phase.stage_round:top_bar", field: "phase.stage_round", source_script: "tools/roi_stage.py", text: "3-6", blocks: [{ text: "3-6", confidence: 0.97 }] },
      { task_id: "economy.gold:bottom_hud", field: "economy.gold", source_script: "tools/roi_gold.py", text: "50", blocks: [{ text: "50", confidence: 0.98 }] },
      { task_id: "economy.level:bottom_hud", field: "economy.level", source_script: "tools/roi_level_xp.py", text: "7", blocks: [{ text: "7", confidence: 0.96 }] },
      { task_id: "economy.xp:bottom_hud", field: "economy.xp", source_script: "tools/roi_level_xp.py", text: "14/36", blocks: [{ text: "14/36", confidence: 0.95 }] },
      { task_id: "economy.hp:local_scoreboard_detected_row", field: "economy.hp", source_script: "tools/roi_hp_local.py", evidence: hpEvidence(), text: "67", blocks: [{ text: "67", confidence: 0.99 }] },
    ]);
    assert.equal(facts.schema, "jcc-self-state-facts-v1");
    assert.equal(facts.ok, true);
    assert.equal(facts.phase.stage_round, "3-6");
    assert.equal(facts.economy.gold, 50);
    assert.equal(facts.economy.level, 7);
    assert.deepEqual(facts.economy.xp, { value: 14, to_next: 36, display: "14/36" });
    assert.equal(facts.economy.hp, 67);
    for (const forbidden of ["board", "bench", "shop", "augments", "items"]) {
      assert.equal(Object.hasOwn(facts, forbidden), false, `${forbidden} must not be emitted by self-state ROI OCR aggregator`);
    }

    const noHpTaskFacts = await runAggregator(tmp, "requested-hp-without-task", [
      { task_id: "phase.stage_round:top_bar", field: "phase.stage_round", source_script: "tools/roi_stage.py", text: "2-6", blocks: [{ text: "2-6", confidence: 0.97 }] },
      { task_id: "economy.gold:bottom_hud", field: "economy.gold", source_script: "tools/roi_gold.py", text: "36", blocks: [{ text: "36", confidence: 0.98 }] },
    ], ["phase.stage_round", "economy.gold", "economy.hp"], {
      "economy.hp": {
        source_script: "tools/roi_hp_local.py",
        task_count: 0,
        roi_status: "standard_player_list_or_local_row_not_reliable",
        scoreboard_layout_status: "standard_player_list",
        local_row_status: "local_player_row_not_reliable",
        selected_row: 1,
      },
    });
    assert.equal(noHpTaskFacts.economy.hp, null, "a requested HP field without an OCR task must remain missing");
    assert.equal(noHpTaskFacts.field_status["economy.hp"].status, "missing");
    assert.equal(noHpTaskFacts.field_status["economy.hp"].reason, "standard_player_list_or_local_row_not_reliable");
    assert.equal(noHpTaskFacts.field_status["economy.hp"].diagnostics.local_row_status, "local_player_row_not_reliable");

    const maxXpFacts = await runAggregator(tmp, "max-xp", [
      { task_id: "economy.xp:bottom_hud", field: "economy.xp", source_script: "tools/roi_level_xp.py", text: "已满", blocks: [{ text: "已满", confidence: 0.99 }] },
    ]);
    assert.deepEqual(maxXpFacts.economy.xp, { status: "max", display: "已满" });
    assert.equal(maxXpFacts.field_status["economy.xp"].status, "observed");

    const maxLevelFacts = await runAggregator(tmp, "max-level-implies-max-xp", [
      { task_id: "economy.level:bottom_hud", field: "economy.level", source_script: "tools/roi_level_xp.py", text: "10级", blocks: [{ text: "10级", confidence: 0.98 }] },
      { task_id: "economy.xp:bottom_hud", field: "economy.xp", source_script: "tools/roi_level_xp.py", text: "", blocks: [] },
    ]);
    assert.deepEqual(maxLevelFacts.economy.xp, { status: "max", display: "已满" });
    assert.equal(maxLevelFacts.field_status["economy.xp"].source, "tools/roi_level_xp.py:level_10_implies_max_xp");

    const zeroHpFacts = await runAggregator(tmp, "zero-hp", [
      { task_id: "economy.hp:local_scoreboard_detected_row:false-positive-zero", field: "economy.hp", source_script: "tools/roi_hp_local.py", evidence: hpEvidence(), text: "0", blocks: [{ text: "0", confidence: 0.99 }] },
    ]);
    assert.equal(zeroHpFacts.economy.hp, null, "HP 0 from OCR must stay missing instead of triggering false critical-health advice");
    assert.equal(zeroHpFacts.field_status["economy.hp"].status, "missing");

    await assertHp(tmp, "hp-100-split-blocks", {
      task_id: "economy.hp:local_scoreboard_detected_row:split-100",
      field: "economy.hp",
      source_script: "tools/roi_hp_local.py",
      evidence: hpEvidence(),
      text: "00 1",
      blocks: [
        { text: "00", confidence: 0.99, rect: { x: 147, y: 8, w: 22, h: 18 } },
        { text: "1", confidence: 0.99, rect: { x: 112, y: 8, w: 10, h: 18 } },
      ],
    }, 100);

    await assertHp(tmp, "hp-100-with-overlapping-row-marker", {
      task_id: "economy.hp:local_scoreboard_detected_row:historical-valid-100",
      field: "economy.hp",
      source_script: "tools/roi_hp_local.py",
      evidence: hpEvidence(),
      text: "100 1",
      blocks: [
        { text: "100", confidence: 0.81605, rect: { x: 144, y: 49, w: 170, h: 124 } },
        { text: "1", confidence: 0.99478, rect: { x: 112, y: 73, w: 43, h: 55 } },
      ],
    }, 100);

    await assertHp(tmp, "hp-false-zero-with-overlapping-row-marker", {
      task_id: "economy.hp:local_scoreboard_detected_row:historical-false-zero",
      field: "economy.hp",
      source_script: "tools/roi_hp_local.py",
      evidence: hpEvidence(),
      text: "00 7",
      blocks: [
        { text: "00", confidence: 0.98674, rect: { x: 143, y: 49, w: 164, h: 124 } },
        { text: "7", confidence: 0.51319, rect: { x: 108, y: 69, w: 51, h: 62 } },
      ],
    }, null);

    for (const hp of [100, 88, 30]) {
      await assertHp(tmp, `hp-normal-${hp}`, {
        task_id: `economy.hp:local_scoreboard_detected_row:${hp}`,
        field: "economy.hp",
        source_script: "tools/roi_hp_local.py",
        evidence: hpEvidence(),
        text: String(hp),
        blocks: [{ text: String(hp), confidence: 0.99, rect: { x: 112, y: 8, w: 24, h: 18 } }],
      }, hp);
    }

    await assertHp(tmp, "hp-normal-0", {
      task_id: "economy.hp:local_scoreboard_detected_row:active-match-zero",
      field: "economy.hp",
      source_script: "tools/roi_hp_local.py",
      evidence: hpEvidence(),
      text: "0",
      blocks: [{ text: "0", confidence: 0.99, rect: { x: 112, y: 8, w: 10, h: 18 } }],
    }, null);

    await assertHp(tmp, "hp-ambiguous-split-blocks", {
      task_id: "economy.hp:local_scoreboard_detected_row:ambiguous",
      field: "economy.hp",
      source_script: "tools/roi_hp_local.py",
      evidence: hpEvidence(),
      text: "10 0",
      blocks: [
        { text: "10", confidence: 0.99, rect: { x: 112, y: 8, w: 20, h: 18 } },
        { text: "0", confidence: 0.99, rect: { x: 112, y: 8, w: 10, h: 18 } },
      ],
    }, null);

    await assertHp(tmp, "hp-missing-semantic-evidence", {
      task_id: "economy.hp:local_scoreboard_detected_row:missing-evidence",
      field: "economy.hp",
      source_script: "tools/roi_hp_local.py",
      text: "3",
      blocks: [{ text: "3", confidence: 0.99, rect: { x: 112, y: 8, w: 10, h: 18 } }],
    }, null);

    await assertHp(tmp, "hp-damage-panel-semantic-evidence", {
      task_id: "economy.hp:local_scoreboard_detected_row:damage-panel",
      field: "economy.hp",
      source_script: "tools/roi_hp_local.py",
      evidence: hpEvidence({
        scoreboard_layout_status: "not_standard_player_list",
        local_row_status: "local_player_row_not_reliable",
        selected_row: 3,
        edge_strength: 599.7,
        diameter: 84,
        coverage: 0.531,
        color_coverage: 0.031,
      }),
      text: "3",
      blocks: [{ text: "3", confidence: 0.99, rect: { x: 112, y: 8, w: 10, h: 18 } }],
    }, null);

    const damageFrame = path.resolve("tools/fixtures/jcc-hp-damage-panel-frame.png");
    assert(existsSync(damageFrame), "expected supplied damage-panel evidence frame to exist");
    const damageRoi = await runPythonJson("tools/roi_hp_local.py", [
      "--frame", damageFrame,
      "--out-dir", path.join(tmp, "damage-panel-roi"),
      "--debug",
    ]);
    assert.equal(damageRoi.ok, false, "damage panel must not emit an authoritative HP OCR task");
    assert.equal(damageRoi.tasks.length, 0);
    assert.equal(damageRoi.artifacts.scoreboard_layout_status, "not_standard_player_list");

    const normalFrame = path.join(tmp, "synthetic-normal-hud.ppm");
    await writeSyntheticHudFrame(normalFrame);
    const normalRoi = await runPythonJson("tools/roi_hp_local.py", [
      "--frame", normalFrame,
      "--out-dir", path.join(tmp, "normal-scoreboard-roi"),
    ]);
    assert.equal(normalRoi.ok, true, "synthetic standard scoreboard frame should emit an HP OCR task");
    assert.equal(normalRoi.tasks.length, 1);
    assert.equal(normalRoi.tasks[0].evidence.scoreboard_layout_status, "standard_player_list");
    assert.equal(normalRoi.tasks[0].evidence.local_row_status, "verified_local_row");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
    console.log(JSON.stringify({
      ok: true,
      schema: "jcc-ocr-field-aggregator-verifier-v1",
      checked: [
        "split_block_hp_100_reconstructed_by_geometry",
        "overlapping_scoreboard_row_marker_is_not_promoted_as_hp",
        "normal_hp_values_preserved",
        "active_match_hp_zero_remains_missing",
        "ambiguous_hp_geometry_remains_missing",
        "hp_missing_semantic_evidence_remains_missing",
        "damage_panel_hp3_frame_emits_no_authoritative_hp_task",
        "normal_scoreboard_frame_still_emits_verified_hp_task",
        "requested_hp_without_ocr_task_has_explicit_missing_reason",
        "stage_gold_level_xp_aggregation_preserved",
        "max_level_xp_text_is_structured",
        "level_10_mechanically_implies_max_xp",
      ],
    }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
