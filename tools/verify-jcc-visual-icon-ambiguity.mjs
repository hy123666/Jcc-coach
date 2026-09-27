import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { ITEM_TEMPLATE_SETS } from "./jcc_item_icon_catalog.mjs";

const root = path.resolve(import.meta.dirname, "..");

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
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

function ambiguousItemGroup(manifest) {
  const groups = new Map();
  for (const entry of manifest.templates || []) {
    if (entry.kind !== "item" || !entry.local_exists || !entry.local_path) continue;
    if (!(entry.template_sets || []).includes(ITEM_TEMPLATE_SETS.LEFT_ITEM_RAIL_INVENTORY)) continue;
    const key = entry.visual_group_id || entry.icon_url || entry.local_path;
    const rows = groups.get(key) || [];
    rows.push(entry);
    groups.set(key, rows);
  }
  return [...groups.values()].find((rows) => new Set(rows.map((row) => String(row.id))).size > 1) || null;
}

async function main() {
  const manifestPath = path.join(root, "data/runtime/jcc/visual-icons/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const group = ambiguousItemGroup(manifest);
  assert(group, "expected at least one same-icon item group in the formal item manifest");

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-item-icon-ambiguity-"));
  try {
    const cropTasks = path.join(tempDir, "crop-tasks.json");
    const cropImage = path.resolve(root, group[0].local_path);
    await writeFile(cropTasks, `${JSON.stringify({
      schema: "jcc-roi-crop-task-batch-collection-v1",
      ok: true,
      frame: "fixture:same-item-icon",
      batches: [],
      tasks: [{
        task_id: "left-item-rail-slot-0",
        field: "items.item_bench.0",
        kind: "item_icon",
        crop_image: cropImage,
        evidence: { slot: 0, fixture: "same-icon-item-group" },
      }],
    }, null, 2)}\n`, "utf8");

    const result = await runNode([
      "tools/match-jcc-left-item-rail-icons.mjs",
      "--crop-tasks", cropTasks,
      "--manifest", manifestPath,
      "--template-set", ITEM_TEMPLATE_SETS.LEFT_ITEM_RAIL_INVENTORY,
      "--top", "16",
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    const match = payload.matches?.[0];
    assert(match, "formal left-item-rail matcher must emit a slot candidate");
    assert.equal(match.source, "left_item_rail_roi_icon", "matcher source must remain scene-scoped");
    assert.equal(match.field, "items.item_bench.0", "matcher must stay inside the left item rail field namespace");
    assert.equal(match.disambiguation_needed, true, "same-icon item group must require disambiguation");
    assert(match.possible_ids.length > 1, "same-icon item group must preserve all possible ids");
    assert.equal(payload.policy?.no_equipped_items, true, "left rail matcher must not emit equipped-item facts");
    assert.equal(payload.policy?.no_opponent_items, true, "left rail matcher must not emit opponent facts");

    const expectedIds = new Set(group.map((row) => String(row.id)));
    const possibleIds = new Set(match.possible_ids.map((row) => String(row.id)));
    assert(
      [...expectedIds].every((id) => possibleIds.has(id)),
      `same-icon candidates were collapsed: expected ${[...expectedIds].join(", ")}, got ${[...possibleIds].join(", ")}`,
    );

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "scene-scoped left item rail matcher consumes crop tasks rather than locating ROIs",
        "same-icon item templates remain a possible-id group instead of a fabricated unique id",
        "ambiguous icon output is fallback evidence only",
        "left item rail matching cannot emit equipped or opponent item facts",
      ],
      template_ids: [...expectedIds],
      possible_ids: [...possibleIds],
    }, null, 2));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
