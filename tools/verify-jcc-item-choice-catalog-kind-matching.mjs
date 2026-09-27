import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function verifyCase(tmpDir, itemChoiceKind, name, expectedId) {
  const input = {
    schema: "jcc-ocr-result-batch-v1",
    results: [
      {
        task_id: `item_choice.${itemChoiceKind}.name_row`,
        ok: true,
        roi: { x: 0, y: 0, w: 400, h: 40 },
        evidence: {
          slot_parts: [
            {
              slot: 0,
              part: "name",
              field: "items.choice_options.0.name",
              item_choice_kind: itemChoiceKind,
              normalized_roi: { x: 0, y: 0, w: 0.25, h: 1 },
              panel_relative_roi: { x: 0, y: 0, w: 1, h: 1 },
            },
          ],
        },
        blocks: [
          {
            text: name,
            confidence: 0.99,
            rect: { x: 10, y: 8, w: 80, h: 20 },
          },
        ],
      },
    ],
  };
  const inputFile = path.join(tmpDir, `${itemChoiceKind}.json`);
  await writeFile(inputFile, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  const python = process.env.JCC_PYTHON || ".venv-ocr/Scripts/python.exe";
  const result = await run(python, [
    "tools/jcc_item_choice_field_aggregator.py",
    "--ocr-result", inputFile,
    "--phase", "item_choice",
    "--item-choice-kind", itemChoiceKind,
  ]);
  if (result.code !== 0) {
    throw new Error(`${itemChoiceKind} aggregator failed: ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout);
  const actual = parsed.choices?.[0]?.id;
  if (actual !== expectedId) {
    throw new Error(`${itemChoiceKind} expected ${name} -> ${expectedId}, got ${actual || "null"}`);
  }
}

async function main() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "jcc-item-kind-"));
  try {
    await verifyCase(tmpDir, "basic_component_forge", "暴风之剑", "1001");
    await verifyCase(tmpDir, "completed_item_forge", "红霸符", "2009");
    await verifyCase(tmpDir, "artifact_forge", "死亡之蔑", "6054");
    console.log(JSON.stringify({
      ok: true,
      checked: [
        "basic_component_forge catalog id range",
        "completed_item_forge catalog id range",
        "artifact_forge catalog id range",
      ],
    }, null, 2));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
