import { spawn } from "node:child_process";

export function waitForProcessExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export async function terminateProcessTree(child, timeoutMs = 2500) {
  if (!child || child.exitCode !== null) return true;
  if (process.platform === "win32" && child.pid) {
    const taskkillOk = await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try { killer.kill("SIGKILL"); } catch {}
        finish(false);
      }, timeoutMs);
      killer.once("error", () => finish(false));
      killer.once("exit", (code) => finish(code === 0));
    });
    if (taskkillOk && await waitForProcessExit(child, 1000)) return true;
  }
  try { child.kill("SIGKILL"); } catch {}
  return waitForProcessExit(child, 1000);
}

export function runProcessTreeBounded(command, args, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number(options.timeoutMs || options.timeout_ms || process.env.JCC_ROI_SUBPROCESS_TIMEOUT_MS || 30000);
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        ...(options.env || {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(async () => {
          if (settled) return;
          timedOut = true;
          await terminateProcessTree(child);
          finish({
            code: 124,
            stdout,
            stderr: `${stderr}${stderr ? "\n" : ""}${command} timed out after ${timeoutMs}ms`,
            timed_out: true,
          });
        }, timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      if (!timedOut) finish({ code: 1, stdout, stderr: error.message || String(error) });
    });
    child.once("close", (code) => {
      if (!timedOut) finish({ code, stdout, stderr });
    });
  });
}
