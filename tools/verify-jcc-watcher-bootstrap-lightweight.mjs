import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(os.tmpdir(), "jcc-watch-bootstrap-"));
try {
  const preload = path.join(temp, "reject-knowledge-read.cjs");
  await writeFile(preload, `const fs = require('node:fs');
const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (/[\\\\/]data[\\\\/](?:game-knowledge|live-rankings|core-patches)[\\\\/]/.test(String(file))) {
    throw new Error('watcher startup must not read Core or Ranking artifacts');
  }
  return read.call(this, file, ...args);
};
require('node:module').syncBuiltinESMExports();
`);
  const start = performance.now();
  const result = spawnSync(process.execPath, ["--require", preload, "tools/start-jcc-mumu-runtime-watch.mjs", "--help"], {
    cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true,
    env: { ...process.env, JCC_RUNTIME_DATA_DIR: temp },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Usage:/);
  const { createRuntimeStoragePaths } = await import("../ui/electron/runtime-state-store.js");
  const paths = createRuntimeStoragePaths(root, { dataRoot: temp });
  assert.equal(paths.currentWatchDir, path.join(temp, "runtime-evidence", "mumu-gi-live", "current-watch"));
  console.log(JSON.stringify({ ok: true, help_ms: performance.now() - start, knowledge_reads: "forbidden by fixture" }));
} finally {
  await rm(temp, { recursive: true, force: true });
}
