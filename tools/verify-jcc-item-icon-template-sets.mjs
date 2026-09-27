import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { ITEM_TEMPLATE_SETS } from "./jcc_item_icon_catalog.mjs";

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

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function assertItem(row, expectedClass, expectedSet) {
  assert(row.item_class === expectedClass, `${row.id} expected item_class=${expectedClass}, got ${row.item_class}`);
  assert(row.template_sets?.includes(expectedSet), `${row.id} missing template_set ${expectedSet}: ${JSON.stringify(row.template_sets)}`);
  assert(row.clean_name && row.normalized_name, `${row.id} missing clean_name/normalized_name`);
  assert(row.visual_group_id, `${row.id} missing visual_group_id`);
  assert(Array.isArray(row.same_icon_possible_ids) && row.same_icon_possible_ids.length >= 1, `${row.id} missing same_icon_possible_ids`);
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-item-template-sets-"));
  try {
    const manifestResult = await runNode([
      "tools/ensure-jcc-visual-icon-assets.mjs",
      "--out-dir", tempDir,
      "--kind", "item",
    ]);
    assert(manifestResult.code === 0, `manifest generation failed:\n${manifestResult.stderr || manifestResult.stdout}`);
    const report = JSON.parse(manifestResult.stdout);
    const manifest = await readJson(report.manifest);
    const repoManifest = await readJson("data/runtime/jcc/visual-icons/manifest.json");
    const byId = new Map(manifest.templates.filter((entry) => entry.kind === "item").map((entry) => [String(entry.id), entry]));
    const repoById = new Map(repoManifest.templates.filter((entry) => entry.kind === "item").map((entry) => [String(entry.id), entry]));
    assertItem(byId.get("1007"), "component", ITEM_TEMPLATE_SETS.BASIC_COMPONENT_FORGE);
    assertItem(byId.get("2001"), "completed", ITEM_TEMPLATE_SETS.COMPLETED_ITEM_FORGE);
    assertItem(byId.get("6052"), "artifact", ITEM_TEMPLATE_SETS.ARTIFACT_FORGE);
    assertItem(byId.get("2094"), "radiant", ITEM_TEMPLATE_SETS.RADIANT_ITEM);
    assertItem(byId.get("41701"), "emblem", ITEM_TEMPLATE_SETS.EMBLEM_ITEM);
    assertItem(byId.get("3007"), "forge_tool", ITEM_TEMPLATE_SETS.CONSUMABLE_TOOL);

    const smallManifestFile = path.join(tempDir, "small-manifest.json");
    const cropTasksFile = path.join(tempDir, "crop-tasks.json");
    const beltIcon = repoById.get("1007")?.local_path;
    assert(beltIcon, "fixture requires local 1007 icon");
    const beltIconPath = path.resolve(beltIcon);
    const templates = [
      { ...repoById.get("1007"), local_path: path.relative(process.cwd(), beltIconPath).replaceAll(path.sep, "/") },
      { ...repoById.get("2001"), local_path: path.relative(process.cwd(), beltIconPath).replaceAll(path.sep, "/") },
    ];
    await writeFile(smallManifestFile, JSON.stringify({ schema: "fixture", templates }, null, 2), "utf8");
    await writeFile(cropTasksFile, JSON.stringify({
      schema: "jcc-roi-crop-task-batch-collection-v1",
      ok: true,
      frame: "fixture",
      batches: [],
      tasks: [{
        task_id: "fixture",
        field: "items.item_bench.0",
        kind: "item_icon",
        crop_image: beltIconPath,
        evidence: { slot: 0 },
      }],
    }, null, 2), "utf8");
    const matchResult = await runNode([
      "tools/match-jcc-left-item-rail-icons.mjs",
      "--crop-tasks", cropTasksFile,
      "--manifest", smallManifestFile,
      "--template-set", ITEM_TEMPLATE_SETS.BASIC_COMPONENT_FORGE,
    ]);
    assert(matchResult.code === 0, `matcher template-set fixture failed:\n${matchResult.stderr || matchResult.stdout}`);
    const matchPayload = JSON.parse(matchResult.stdout);
    const ids = new Set((matchPayload.matches?.[0]?.candidates || []).map((candidate) => String(candidate.id)));
    assert(ids.has("1007"), "basic_component_forge pool should include component template");
    assert(!ids.has("2001"), "basic_component_forge pool must exclude completed item template");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "item icon manifest rows carry item_class/template_sets/visual_group_id/same_icon_possible_ids",
        "component/completed/artifact/radiant/emblem/forge tool classes are separated",
        "matcher filters by template_set instead of mixing all item icons",
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
