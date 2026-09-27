import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const ONE_BY_ONE_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8ffff3f0005fe02fea73581e90000000049454e44ae426082",
  "hex",
);

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

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-visual-frame-"));
  try {
    const fixture = path.join(tempDir, "fixture.png");
    const outDir = path.join(tempDir, "capture");
    await writeFile(fixture, ONE_BY_ONE_PNG);
    const result = await runNode([
      "tools/capture-jcc-visual-frame.mjs",
      "--fixture-image",
      fixture,
      "--out-dir",
      outDir,
      "--label",
      "verify",
    ]);
    assert(result.code === 0, `capture exited ${result.code}\n${result.stderr}`);
    const envelope = JSON.parse(await readFile(path.join(outDir, "visual-frame.json"), "utf8"));
    const expectedHash = crypto.createHash("sha256").update(ONE_BY_ONE_PNG).digest("hex");
    assert(envelope.ok === true, "envelope ok mismatch");
    assert(envelope.source === "fixture_image", "source mismatch");
    assert(envelope.adb_path === null, "fixture capture should not resolve adb");
    assert(envelope.sha256 === expectedHash, "hash mismatch");
    assert(envelope.frame_id === `frame:${expectedHash.slice(0, 16)}`, "frame id mismatch");
    assert(envelope.image.width === 1 && envelope.image.height === 1, "PNG dimensions mismatch");
    assert(envelope.image.persisted === false, "fixture frames must not persist by default");
    assert(envelope.image.path === null, "default frame path must be null");
    assert(envelope.storage_policy.default_persist_raw_frames === false, "raw frame persistence must default false");
    assert(envelope.storage_policy.ring_buffer_frame_limit === 30, "ring buffer limit mismatch");
    assert(envelope.forbidden_sources.includes("anti-cheat bypass"), "forbidden sources missing");
    assert(!(await fileExists(path.join(outDir, "frame.png"))), "frame.png must not exist without --persist-frame");

    const retainedDir = path.join(tempDir, "capture-retained");
    const retainedResult = await runNode([
      "tools/capture-jcc-visual-frame.mjs",
      "--fixture-image",
      fixture,
      "--out-dir",
      retainedDir,
      "--label",
      "verify-retained",
      "--persist-frame",
    ]);
    assert(retainedResult.code === 0, `retained capture exited ${retainedResult.code}\n${retainedResult.stderr}`);
    const retainedEnvelope = JSON.parse(await readFile(path.join(retainedDir, "visual-frame.json"), "utf8"));
    assert(retainedEnvelope.image.persisted === true, "explicit --persist-frame should persist raw frame");
    await readFile(path.join(retainedDir, "frame.png"));
    const missingAdb = await runNode([
      "tools/capture-jcc-visual-frame.mjs",
      "--adb",
      path.join(tempDir, "missing-adb.exe"),
      "--out-dir",
      path.join(tempDir, "missing-adb"),
    ]);
    assert(missingAdb.code !== 0, "missing adb smoke should fail");
    assert(missingAdb.stderr.includes("adb_not_found"), "missing adb error should be actionable");
    console.log(JSON.stringify({
      ok: true,
      checked: [
        "fixture capture",
        "sha256 frame id",
        "PNG dimensions",
        "raw frames are transient by default",
        "explicit persistence only with --persist-frame",
        "bounded storage policy",
        "actionable adb missing error",
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
