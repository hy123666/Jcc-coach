import { spawn } from "node:child_process";
import path from "node:path";

function runNode(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, ...env },
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
  const result = await runNode(["tools/diagnose-jcc-adb.mjs", "--adb", path.join("Z:\\", "missing", "adb.exe")], {
    JCC_ADB_SKIP_REPO_LOCAL: "1",
    ANDROID_HOME: "",
    ANDROID_SDK_ROOT: "",
    PATH: "",
    Path: "",
  });
  assert(result.code !== 0, "missing adb diagnostic should fail in verifier");
  const report = JSON.parse(result.stdout);
  assert(report.ok === false, "diagnostic ok mismatch");
  assert(Array.isArray(report.checked_candidates), "checked candidates missing");
  assert(report.checked_candidates.some((candidate) => candidate.source === "--adb"), "explicit adb candidate missing");
  assert(report.mumu_discovery?.reason, "diagnostic should expose discovery reason");
  assert(/start MuMu|JCC_ADB|platform-tools/i.test(report.next_step), "next step should be actionable");
  const discovery = await runNode(["tools/discover-jcc-mumu-adb-target.mjs", "--adb", path.join("Z:\\", "missing", "adb.exe")], {
    JCC_ADB_SKIP_REPO_LOCAL: "1",
    ANDROID_HOME: "",
    ANDROID_SDK_ROOT: "",
    PATH: "",
    Path: "",
  });
  assert(discovery.code !== 0, "missing adb discovery should fail in verifier");
  const discoveryReport = JSON.parse(discovery.stdout);
  assert(["adb_not_found", "adb_devices_failed"].includes(discoveryReport.reason), "discovery reason mismatch");
  console.log(JSON.stringify({
    ok: true,
    checked: [
      "missing adb report is machine-readable",
      "explicit adb candidate is surfaced",
      "MuMu discovery reason is surfaced",
      "next step is actionable",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
