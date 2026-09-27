import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { writeSyntheticHudFrame } from "./jcc_test_hud_fixture.mjs";

const execFileAsync = promisify(execFile);

async function runPython(script, args) {
  const python = process.env.JCC_OCR_PYTHON || ".venv-ocr/Scripts/python.exe";
  const { stdout } = await execFileAsync(path.resolve(python), [path.resolve(script), ...args], {
    cwd: process.cwd(),
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 10,
  });
  return JSON.parse(stdout);
}

async function main() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "jcc-roi-crop-task-"));
  try {
    const frame = path.join(tmp, "synthetic-normal-hud.ppm");
    await writeSyntheticHudFrame(frame);
    const hp = await runPython("tools/roi_hp_local.py", ["--frame", frame, "--out-dir", path.join(tmp, "hp")]);
    assert.equal(hp.schema, "jcc-roi-crop-task-batch-v1");
    assert.equal(hp.ok, true);
    assert.equal(hp.tasks.length, 1);
    assert.equal(hp.tasks[0].field, "economy.hp");
    assert.equal(hp.tasks[0].kind, "numeric_text");
    assert.equal(hp.tasks[0].source_script, "tools/roi_hp_local.py");
    assert(existsSync(hp.tasks[0].crop_image), "HP crop image should exist for resident OCR worker input");
    assert(!Object.hasOwn(hp, "hp_ocr"), "ROI scripts must not OCR text themselves");

    const stage = await runPython("tools/roi_stage.py", ["--frame", frame, "--out-dir", path.join(tmp, "stage")]);
    assert.equal(stage.tasks[0].field, "phase.stage_round");
    assert.equal(stage.tasks[0].source_script, "tools/roi_stage.py");

    const gold = await runPython("tools/roi_gold.py", ["--frame", frame, "--out-dir", path.join(tmp, "gold")]);
    assert.equal(gold.tasks[0].field, "economy.gold");

    const levelXp = await runPython("tools/roi_level_xp.py", ["--frame", frame, "--out-dir", path.join(tmp, "level-xp")]);
    assert.deepEqual(levelXp.tasks.map((task) => task.field), ["economy.level", "economy.xp"]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  console.log("verify-jcc-roi-crop-task-schema: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
