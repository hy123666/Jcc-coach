import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcessTreeBounded } from "./jcc_process_runner.mjs";

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), "jcc-roi-subprocess-"));
try {
  const childPidFile = path.join(root, "child.pid");
  const parentPidFile = path.join(root, "parent.pid");
  const childScript = path.join(root, "child.mjs");
  const parentScript = path.join(root, "parent.mjs");
  await writeFile(childScript, "setInterval(() => {}, 1000);\n", "utf8");
  await writeFile(parentScript, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid));
const child = spawn(process.execPath, [${JSON.stringify(childScript)}], { windowsHide: true, stdio: "ignore" });
writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`, "utf8");

  const result = await runProcessTreeBounded(process.execPath, [parentScript], { timeoutMs: 300 });
  assert.equal(result.code, 124, `bounded ROI process must report timeout: ${result.stderr || result.stdout}`);
  const parentPid = Number(await readFile(parentPidFile, "utf8"));
  const childPid = Number(await readFile(childPidFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(processExists(parentPid), false, "timed-out ROI parent must exit");
  assert.equal(processExists(childPid), false, "timed-out ROI child tree must exit");

  const runnerFiles = [
    "run-jcc-self-state-roi-ocr.mjs",
    "run-jcc-augment-choice-roi-ocr.mjs",
    "run-jcc-item-choice-roi-ocr.mjs",
    "run-jcc-owned-augment-text-panel-roi-ocr.mjs",
    "run-jcc-left-item-rail-roi-icon.mjs",
  ];
  for (const file of runnerFiles) {
    const source = await readFile(path.resolve("tools", file), "utf8");
    assert(source.includes('runProcessTreeBounded as runProcess'), `${file} must use the bounded shared process runner`);
    assert(!source.includes("function runProcess("), `${file} must not keep a private unbounded process runner`);
  }

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-roi-subprocess-lifecycle-v1",
    checked: [
      "timeout_reaps_parent_and_child_process_tree",
      "all_product_roi_runners_use_shared_bounded_runner",
      "private_unbounded_process_runners_removed",
    ],
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
