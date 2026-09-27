import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function names(rows) {
  return (rows || []).map((row) => row.name || row.item_name || row.id || row.item_id);
}

function hasName(rows, name) {
  return names(rows).includes(name);
}

async function runVisualBuilder({ liveStateFile, visualFile, outFile }) {
  const result = await runNode([
    "tools/build-jcc-visual-live-state.mjs",
    "--live-state", liveStateFile,
    "--visual-observations", visualFile,
    "--out", outFile,
  ]);
  assert(result.code === 0, `visual live-state builder failed:\n${result.stderr || result.stdout}`);
  return JSON.parse(await readFile(outFile, "utf8"));
}

async function runPipeline({ liveStateFile, adviceStateFile, outFile }) {
  const result = await runNode([
    "tools/run-jcc-cruise-runtime-pipeline.mjs",
    "--live-state", liveStateFile,
    "--advice-state", adviceStateFile,
    "--out", outFile,
    "--retain-full-state",
    "--now", "2026-06-13T12:00:00.000Z",
  ]);
  assert(result.code === 0, `cruise pipeline failed:\n${result.stderr || result.stdout}`);
  return JSON.parse(await readFile(outFile, "utf8"));
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-left-item-rail-"));
  try {
    const primaryLiveStateFile = path.join(tempDir, "live-state-primary.json");
    const visualFile = path.join(tempDir, "visual.json");
    const primaryOutFile = path.join(tempDir, "out-primary.json");
    const adviceStateFile = path.join(tempDir, "advice-state.json");
    const pipelineFile = path.join(tempDir, "pipeline.json");
    await writeFile(primaryLiveStateFile, JSON.stringify({
      metadata: { match_session_id: "left-item-rail-test" },
      items: {
        item_bench: [
          {
            slot: 0,
            item_id: "mumu:item:belt",
            name: "mumu-4357-giant-belt",
            source: "mumu_4357_item_bench",
            promotion_policy: "structured_4357_left_item_rail_primary",
            confidence: 0.95,
          },
        ],
      },
      field_status: {
        "items.item_bench": {
          status: "candidate",
          source: "mumu_4357_item_bench",
          promotion_policy: "structured_4357_left_item_rail_primary",
          confidence: 0.95,
        },
      },
    }, null, 2), "utf8");
    await writeFile(visualFile, JSON.stringify({
      schema: "jcc-visual-observations-v1",
      match_session_id: "left-item-rail-test",
      frame_id: "fixture:left-item-rail",
      items: {
        item_bench: [],
        item_bench_candidates: [
          {
            slot: 0,
            item_id: "item:spatula",
            name: "icon-spatula-validation-candidate",
            status: "visual_candidate",
            evidence_layer: "confirmed",
            confidence: 0.93,
            source: "left_item_rail_roi_icon",
            evidence: "left_item_rail_slot_0",
          },
          {
            slot: 2,
            name: "icon-belt-uncertain-candidate",
            status: "visual_uncertain_candidate",
            evidence_layer: "candidate",
            confidence: 0.66,
            source: "left_item_rail_roi_icon",
            possible_ids: [{ id: "1007", name: "Giant Belt" }],
            disambiguation_needed: true,
          },
        ],
        equipped_items: [
          {
            unit_name: "bad-scope-unit",
            item_id: "item:bad-scope",
            name: "bad-scope-equipped-item",
            status: "visual_candidate",
            confidence: 0.99,
            source: "left_item_rail_roi_icon",
          },
        ],
      },
      metadata: {
        source: "left_item_rail_roi_icon",
        mode: "refresh_self_state",
        scope: "items.item_bench_only",
        recognition_layer: "item_icon_matcher",
      },
      field_status: {
        "items.item_bench": {
          status: "candidate",
          source: "left_item_rail_roi_icon",
          source_type: "left_item_rail_icon_matcher",
          confidence: 0.93,
        },
      },
    }, null, 2), "utf8");

    const primaryOutput = await runVisualBuilder({ liveStateFile: primaryLiveStateFile, visualFile, outFile: primaryOutFile });
    assert(hasName(primaryOutput.items?.item_bench, "mumu-4357-giant-belt"), "4357 primary item_bench row must be preserved");
    assert(!hasName(primaryOutput.items?.item_bench, "icon-spatula-validation-candidate"), "left rail icon rows must not populate item_bench when 4357 exists");
    assert(hasName(primaryOutput.items?.item_bench_candidates, "icon-spatula-validation-candidate"), "confirmed icon row should become validation candidate");
    assert(hasName(primaryOutput.items?.item_bench_candidates, "icon-belt-uncertain-candidate"), "uncertain icon row should stay in item_bench_candidates");
    assert(!(primaryOutput.visual?.items?.equipped_items || []).some((row) => row.source === "left_item_rail_roi_icon"), "left item rail source must not leak into equipped_items");
    assert(primaryOutput.field_status?.["items.item_bench"]?.source === "mumu_4357_item_bench", "icon matcher must not replace 4357 item_bench field_status");
    assert(primaryOutput.field_status?.["items.item_bench_candidates"]?.source === "left_item_rail_roi_icon", "icon matcher status belongs to item_bench_candidates");

    const pipelineOutput = await runPipeline({ liveStateFile: primaryOutFile, adviceStateFile, outFile: pipelineFile });
    const standardized = pipelineOutput.standardized_live_state;
    assert(hasName(standardized?.items?.item_bench, "mumu-4357-giant-belt"), "cruise standardized live_state must keep 4357 item_bench");
    assert(!hasName(standardized?.items?.item_bench, "icon-spatula-validation-candidate"), "cruise standardized live_state must not promote icon candidate to item_bench");
    assert(hasName(standardized?.items?.item_bench_candidates, "icon-spatula-validation-candidate"), "cruise standardized live_state must expose icon validation candidates separately");
    assert(hasName(standardized?.items?.item_bench_candidates, "icon-belt-uncertain-candidate"), "cruise standardized live_state must expose uncertain icon candidates separately");

    const iconOnlyLiveStateFile = path.join(tempDir, "live-state-icon-only.json");
    const iconOnlyOutFile = path.join(tempDir, "out-icon-only.json");
    await writeFile(iconOnlyLiveStateFile, JSON.stringify({
      metadata: { match_session_id: "left-item-rail-test" },
      items: { item_bench: [] },
      field_status: {},
    }, null, 2), "utf8");
    const iconOnlyOutput = await runVisualBuilder({ liveStateFile: iconOnlyLiveStateFile, visualFile, outFile: iconOnlyOutFile });
    assert(!hasName(iconOnlyOutput.items?.item_bench, "icon-spatula-validation-candidate"), "icon rows must not populate item_bench even when 4357 is absent");
    assert(hasName(iconOnlyOutput.items?.item_bench_candidates, "icon-spatula-validation-candidate"), "icon rows should remain fallback candidates when 4357 is absent");
    const iconOnlyPipeline = await runPipeline({
      liveStateFile: iconOnlyOutFile,
      adviceStateFile: path.join(tempDir, "advice-state-icon-only.json"),
      outFile: path.join(tempDir, "pipeline-icon-only.json"),
    });
    assert(!hasName(iconOnlyPipeline.standardized_live_state?.items?.item_bench, "icon-spatula-validation-candidate"), "pipeline must not promote icon fallback candidate to item_bench");
    assert(hasName(iconOnlyPipeline.standardized_live_state?.items?.item_bench_candidates, "icon-spatula-validation-candidate"), "pipeline must preserve icon fallback candidate separately");

    const emptyVisualFile = path.join(tempDir, "visual-empty.json");
    const emptyOutFile = path.join(tempDir, "out-empty.json");
    await writeFile(emptyVisualFile, JSON.stringify({
      schema: "jcc-visual-observations-v1",
      match_session_id: "left-item-rail-test",
      frame_id: "fixture:left-item-rail-empty",
      items: {
        item_bench: [],
        item_bench_candidates: [],
        equipped_items: [],
      },
      metadata: {
        source: "left_item_rail_roi_icon",
        mode: "refresh_self_state",
        scope: "items.item_bench_only",
        recognition_layer: "item_icon_matcher",
      },
      field_status: {
        "items.item_bench": {
          status: "observed_empty",
          source: "left_item_rail_roi_icon",
          source_type: "left_item_rail_icon_matcher",
          confidence: 0,
        },
      },
    }, null, 2), "utf8");
    const emptyOutput = await runVisualBuilder({ liveStateFile: primaryOutFile, visualFile: emptyVisualFile, outFile: emptyOutFile });
    assert(hasName(emptyOutput.items?.item_bench, "mumu-4357-giant-belt"), "observed-empty icon scan must not clear 4357 item_bench");
    assert(Array.isArray(emptyOutput.items?.item_bench_candidates) && emptyOutput.items.item_bench_candidates.length === 0, "observed-empty icon scan should clear only icon candidates");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "4357 remains the only primary item_bench source",
        "left item rail icon rows become validation/fallback candidates only",
        "icon rows never populate item_bench, even when 4357 is absent",
        "observed-empty icon scans do not clear 4357 item_bench",
      "non-primary icon candidates remain fallback-only",
        "left item rail source cannot leak into equipped_items",
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
