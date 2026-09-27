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

function iconMatch(field, id, name, overrides = {}) {
  const slot = Number(String(field).match(/items\.item_bench\.(\d+)/)?.[1] || 0);
  const confidence = overrides.confidence ?? 0.84;
  return {
    task_id: `left_item_rail_slot_${slot}`,
    field,
    kind: "item",
    slot,
    status: overrides.status || "visual_icon_candidate_high_confidence",
    confidence,
    top_gap: overrides.top_gap ?? 0.14,
    source: "left_item_rail_roi_icon",
    candidates: [{
      kind: "item",
      id,
      name,
      score: confidence,
      icon_url: null,
      item_class: overrides.item_class || "component",
      template_sets: ["left_item_rail_inventory"],
    }],
    possible_ids: overrides.possible_ids || [{ id, name, kind: "item" }],
    disambiguation_needed: overrides.disambiguation_needed === true,
    evidence: {
      crop_image: `fixture-slot-${slot}.png`,
      crop_variant: "slot_inner",
      coordinate_space: "crop_task_pixels",
      presence_status: overrides.presence_status || { reject: false, reason: "fixture_occupied" },
      ...(overrides.evidence || {}),
    },
  };
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-left-item-second-column-"));
  try {
    const matchesFile = path.join(tempDir, "icon-matches.json");
    const observationsFile = path.join(tempDir, "visual-observations.json");
    await writeFile(matchesFile, JSON.stringify({
      ok: true,
      schema: "jcc-left-item-rail-icon-match-batch-v1",
      source: "left_item_rail_roi_icon",
      frame: "fixture:left-item-second-column-guard",
      matches: [
        iconMatch("items.item_bench.0", "3003", "remover"),
        iconMatch("items.item_bench.1", "3001", "duplicator"),
        iconMatch("items.item_bench.2", "1003", "rod"),
        iconMatch("items.item_bench.3", "1007", "belt"),
        iconMatch("items.item_bench.4", "1007", "belt"),
        iconMatch("items.item_bench.13", "3007", "basic anvil", { item_class: "forge_tool" }),
        iconMatch("items.item_bench.14", "3007", "empty second column slot", {
          status: "empty_or_background_slot",
          confidence: 0,
          top_gap: null,
          presence_status: { reject: true, reason: "fixture_empty_slot" },
        }),
      ],
    }, null, 2), "utf8");
    const result = await runNode([
      "tools/jcc_left_item_rail_field_aggregator.mjs",
      "--icon-matches",
      matchesFile,
      "--out",
      observationsFile,
    ]);
    assert(result.code === 0, `left item rail aggregator failed:\n${result.stderr || result.stdout}`);
    const observations = JSON.parse(await readFile(observationsFile, "utf8"));
    const itemBench = observations.items.item_bench || [];
    const itemBenchCandidates = observations.items.item_bench_candidates || [];
    assert(itemBench.length === 0, `left rail icon matcher must not populate main item_bench: ${JSON.stringify(itemBench)}`);
    assert(itemBenchCandidates.length === 6, `expected first column plus one real second-column candidate, got ${itemBenchCandidates.length}: ${JSON.stringify(itemBenchCandidates)}`);
    assert(itemBenchCandidates.some((entry) => entry.slot === 13), "second-column real item should pass per-slot gates as a candidate");
    assert(!itemBenchCandidates.some((entry) => entry.slot === 14), "second-column empty slot must not enter item_bench_candidates");
    console.log(JSON.stringify({
      ok: true,
      checked: [
        "left item rail aggregator consumes the ROI icon match schema",
        "second-column items are no longer globally suppressed",
        "icon matcher rows stay in item_bench_candidates, never main item_bench",
        "second-column empty slots do not enter item_bench_candidates",
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
