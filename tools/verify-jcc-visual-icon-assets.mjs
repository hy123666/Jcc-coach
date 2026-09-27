import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

function runNode(args) {
  return new Promise((resolve) => {
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
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-visual-icon-assets-"));
  try {
    const itemResult = await runNode([
      "tools/ensure-jcc-visual-icon-assets.mjs",
      "--out-dir",
      path.join(tempDir, "items"),
      "--kind",
      "item",
      "--limit",
      "6",
    ]);
    const augmentResult = await runNode([
      "tools/ensure-jcc-visual-icon-assets.mjs",
      "--out-dir",
      path.join(tempDir, "augments"),
      "--kind",
      "augment",
      "--limit",
      "6",
    ]);
    const championResult = await runNode([
      "tools/ensure-jcc-visual-icon-assets.mjs",
      "--out-dir",
      path.join(tempDir, "champions"),
      "--kind",
      "champion",
      "--limit",
      "6",
    ]);
    assert(itemResult.code === 0, `item asset manifest exited ${itemResult.code}\n${itemResult.stderr || itemResult.stdout}`);
    assert(augmentResult.code === 0, `augment asset manifest exited ${augmentResult.code}\n${augmentResult.stderr || augmentResult.stdout}`);
    assert(championResult.code === 0, `champion asset manifest exited ${championResult.code}\n${championResult.stderr || championResult.stdout}`);
    const itemReport = JSON.parse(itemResult.stdout);
    const augmentReport = JSON.parse(augmentResult.stdout);
    const championReport = JSON.parse(championResult.stdout);
    const itemManifest = JSON.parse(await readFile(itemReport.manifest, "utf8"));
    const augmentManifest = JSON.parse(await readFile(augmentReport.manifest, "utf8"));
    const championManifest = JSON.parse(await readFile(championReport.manifest, "utf8"));
    assert(itemManifest.download_enabled === false && augmentManifest.download_enabled === false && championManifest.download_enabled === false, "verify should not download icon files");
    assert(itemManifest.templates.length === 6 && augmentManifest.templates.length === 6 && championManifest.templates.length === 6, "manifest should honor --limit");
    assert(itemManifest.templates.every((entry) => entry.kind === "item"), "item manifest should include item templates");
    assert(augmentManifest.templates.every((entry) => entry.kind === "augment"), "augment manifest should include augment templates");
    assert(championManifest.templates.every((entry) => entry.kind === "champion"), "champion manifest should include champion templates");
    assert([...itemManifest.templates, ...augmentManifest.templates, ...championManifest.templates].every((entry) => entry.icon_url && entry.local_path), "templates must carry icon URL and local path");
    console.log(JSON.stringify({
      ok: true,
      checked: [
        "MuMu catalog item/augment icons produce a local template manifest",
        "MuMu catalog champion icons produce a local template manifest",
        "manifest generation does not download by default",
        "template rows carry icon_url and deterministic local_path",
      ],
      total: itemManifest.templates.length + augmentManifest.templates.length + championManifest.templates.length,
      kinds: ["augment", "champion", "item"],
    }, null, 2));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
