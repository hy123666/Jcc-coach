import { execFile } from "node:child_process";

export function probeAdbConnection(command, serial, timeoutMs = 2000, run = execFile) {
  return new Promise((resolve) => {
    run(command, ["-s", serial, "shell", "echo", "jcc_connection_ok"],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4096 }, (error, stdout) => {
        resolve({ connected: !error && String(stdout || "").trim() === "jcc_connection_ok", checked_at: new Date().toISOString() });
      });
  });
}
