import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function verifyPackagedDaemon(appDir) {
  const resources = path.resolve(appDir, "resources");
  const temp = await mkdtemp(path.join(os.tmpdir(), "jcc-packaged-daemon-"));
  const dataRoot = path.join(temp, "runtime-data");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(JCC_|NODE_|ELECTRON_|VITE_)/i.test(key)));
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: "1",
    JCC_RUNTIME_REPO_ROOT: resources,
    JCC_RUNTIME_DATA_DIR: dataRoot,
    JCC_UI_DISABLE_CODEX_EXEC: "1",
    JCC_ADB: path.join(resources, "adb", "adb.exe"),
    JCC_OCR_PYTHON: path.join(resources, "ocr", "python", "python.exe"),
  });
  const started = Date.now();
  const child = spawn(path.join(appDir, "JCC Runtime.exe"), [
    path.join(resources, "ui", "electron", "runtime-daemon-server.js"),
  ], { cwd: temp, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let pending = "";
  let info;
  let timer;
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16000); });
  try {
    info = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Packaged daemon readiness timeout: ${stderr}`)), 300000);
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Packaged daemon exited (${code}): ${stderr}`)));
      child.stdout.on("data", chunk => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) {
          try {
            const message = JSON.parse(line);
            if (message.type === "jcc-runtime-daemon-ready") resolve(message);
          } catch {}
        }
      });
    });
    clearTimeout(timer);
    const headers = { "x-jcc-runtime-token": info.token };
    const health = await fetch(`${info.url}/health`, { headers, signal: AbortSignal.timeout(15000) });
    assert.equal(health.status, 200, "installed daemon must serve health");
    const state = await fetch(`${info.url}/state`, { headers, signal: AbortSignal.timeout(15000) });
    assert.equal(state.status, 200, "installed daemon must serve SQLite state");
    assert.equal((await state.json()).ok, true);
    assert.ok(path.resolve(info.sqlite_file).startsWith(dataRoot + path.sep), "SQLite must stay outside install resources");
    console.log(JSON.stringify({ test: "packaged-daemon", ok: true, ready_ms: Date.now() - started }));
  } finally {
    clearTimeout(timer);
    if (info && child.exitCode === null) {
      await fetch(`${info.url}/shutdown`, {
        method: "POST", headers: { "x-jcc-runtime-token": info.token }, signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
    if (child.exitCode === null && child.pid) {
      const killTimer = setTimeout(() => child.kill(), 5000);
      await exited;
      clearTimeout(killTimer);
    }
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: node verify-jcc-packaged-daemon.mjs <installed-app-directory>");
  await verifyPackagedDaemon(path.resolve(process.argv[2]));
}
