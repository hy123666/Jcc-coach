import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
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

async function main() {
  const tmp = await mkdir(path.join(os.tmpdir(), `jcc-owned-augment-panel-${Date.now()}`), { recursive: true });
  try {
    const ocrResultFile = path.join(tmp, "ocr-result.json");
    const factsFile = path.join(tmp, "facts.json");
    const payload = {
      schema: "jcc-ocr-result-batch-v1",
      ok: true,
      results: [
        {
          task_id: "owned_augment_text_panel.panel",
          kind: "owned_augment_text_panel",
          roi: { x: 1411, y: 149, w: 165, h: 356 },
          evidence: {
            slot_parts: [
              {
                slot: 0,
                part: "text",
                kind: "augment",
                choice_stage_round: "2-1",
                field: "augments.selected_augments.0.text",
                panel_relative_roi: { x: 0, y: 0, w: 1, h: 0.22 },
              },
              {
                slot: 1,
                part: "text",
                kind: "augment",
                choice_stage_round: "3-2",
                field: "augments.selected_augments.1.text",
                panel_relative_roi: { x: 0, y: 0.23, w: 1, h: 0.26 },
              },
              {
                slot: 2,
                part: "text",
                kind: "augment",
                choice_stage_round: "4-2",
                field: "augments.selected_augments.2.text",
                panel_relative_roi: { x: 0, y: 0.49, w: 1, h: 0.26 },
              },
            ],
          },
          blocks: [
            { text: "存心失利", confidence: 0.99, rect: { x: 44, y: 27, w: 66, h: 17 } },
            { text: "神赐锻炉", confidence: 0.99, rect: { x: 44, y: 121, w: 66, h: 17 } },
            { text: "飞升", confidence: 0.99, rect: { x: 59, y: 214, w: 36, h: 20 } },
          ],
        },
      ],
    };
    await writeFile(ocrResultFile, JSON.stringify(payload, null, 2), "utf8");
    const result = await run(".venv-ocr/Scripts/python.exe", [
      "tools/jcc_owned_augment_text_panel_aggregator.py",
      "--ocr-result", ocrResultFile,
      "--out", factsFile,
    ]);
    assert(result.code === 0, `aggregator failed\n${result.stdout}\n${result.stderr}`);
    const facts = JSON.parse(await readFile(factsFile, "utf8"));
    assert(facts.schema === "jcc-owned-augment-text-panel-facts-v1", "schema mismatch");
    assert(facts.ok === true, "facts should be ok");
    assert(facts.choice_confirmations.length === 3, "only the first three rows should become augment confirmations");
    assert(facts.choice_confirmations.every((event) => event.type === "owned_augment_text_panel_confirmed"), "confirmation type mismatch");
    assert(facts.choice_confirmations.every((event) => event.kind === "augment" && event.choice_kind === "augment_choice"), "confirmation kind mismatch");
    assert(facts.choice_confirmations.map((event) => event.choice_stage_round).join(",") === "2-1,3-2,4-2", "augment rows must bind to fixed stage order");
    assert(facts.facts.selected_augments.map((entry) => entry.name).join("/") === "存心失利/神赐锻炉/飞升", "selected augment names mismatch");
    assert(facts.facts.current_god_final === undefined, "owned augment OCR must not materialize a retired season variable");
    console.log("verify-jcc-owned-augment-text-panel-roi-behavior: ok");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
