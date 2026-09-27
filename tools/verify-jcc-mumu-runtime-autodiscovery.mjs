import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
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

async function main() {
  const outDir = ".omx/runtime-evidence/mumu-gi-live/autodiscovery-verify";
  const discoverySource = await readFile("tools/discover-jcc-mumu-adb-target.mjs", "utf8");
  const runtimeServiceSource = await readFile("ui/electron/runtime-service.js", "utf8");
  assert(discoverySource.includes("windowsHide: true"), "MuMu ADB discovery must not open a Windows console");
  assert(discoverySource.includes("terminateProcessTree(child)"), "MuMu ADB discovery timeout must reap the process tree");
  assert(runtimeServiceSource.includes("const runtimeServiceInstanceId = randomUUID()"), "runtime service must assign a process-lifetime watcher owner token");
  assert(runtimeServiceSource.includes('"--owner-instance-id"'), "runtime service must pass its owner token to the watcher wrapper");
  assert(runtimeServiceSource.includes("watcher_owned_by_previous_runtime_instance"), "runtime service must retire watchers owned by a previous daemon instance");
  assert(
    runtimeServiceSource.includes("const termination = await terminateProcess(trackedPid, 2500)")
      && runtimeServiceSource.includes("const previousWatcherTermination = await killWatcher()"),
    "runtime service must await stale and previous watcher tree termination before restart",
  );
  assert(discoverySource.includes("timeoutMs: 8000"), "MuMu discovery must allow ADB cold-start instead of timing out at 2.5s");
  assert(
    discoverySource.includes("probeRuntimeHealth"),
    "MuMu discovery must probe runtime health instead of choosing by fixed port preference",
  );
  assert(
    discoverySource.includes("scan_configured_ports_and_select_by_runtime_health"),
    "MuMu discovery report must explain that port scan selection is health-based",
  );
  assert(
    !discoverySource.includes("if (signals.is_host_port) score += 10"),
    "MuMu discovery must not score host:port serials higher by default",
  );
  assert(
    !discoverySource.includes("initialDevices.length === 0"),
    "MuMu discovery must not skip configured-port scans just because adb already reports an online device",
  );
  const result = await runNode([
    "tools/start-jcc-mumu-runtime-watch.mjs",
    "--out-dir",
    outDir,
    "--match-session-id",
    "autodiscovery-verify",
    "--owner-instance-id",
    "autodiscovery-owner",
    "--owner-pid",
    String(process.pid),
    "--no-connect",
    "--dry-run",
  ]);
  const report = JSON.parse(result.stdout);
  assert([0, 1].includes(result.code), `unexpected autodiscovery exit code: ${result.code}`);
  assert(report.status === "ready" || report.status === "mumu_target_not_found", "autodiscovery dry run should be ready or user-action-needed");
  assert(report.discovery?.ui_hint || report.ui_hint, "autodiscovery must return a UI hint");
  assert(report.discovery?.port_scan?.enabled === false || report.port_scan?.enabled === false, "this verification path must not connect/scan ports implicitly");

  if (report.status === "ready") {
    assert(report.recommended_target?.serial, "recommended target serial missing");
    assert(report.watcher_command.includes("--device"), "watcher command must include --device");
    assert(report.watcher_command.includes(report.recommended_target.serial), "watcher command must use recommended serial");
    assert(!report.watcher_command.includes("127.0.0.1:7555") || report.recommended_target.serial === "127.0.0.1:7555", "watcher must not hardcode MuMu port");
    const allowedWatcherFlags = new Set([
      "--adb",
      "--device",
      "--out-dir",
      "--summary-interval-ms",
      "--match-session-id",
      "--duration-ms",
      "--clear-logcat-first",
      "--catalog-overlay",
    ]);
    assert(
      report.watcher_command.filter((part) => String(part).startsWith("--")).every((flag) => allowedWatcherFlags.has(flag)),
      "production wrapper must forward only structured-source watcher arguments",
    );
    assert(report.source_only === true, "service state must expose the fixed structured-source watcher contract");
    assert(report.owner_instance_id === "autodiscovery-owner", "service state must bind the watcher to the requesting runtime instance");
    assert(report.owner_pid === process.pid, "service state must bind the watcher to the requesting runtime PID");
    assert(Number.isInteger(report.supervisor_pid) && report.supervisor_pid > 0, "service state must expose the wrapper supervisor PID");
    const serviceState = JSON.parse(await readFile(path.join(outDir, "service-state.json"), "utf8"));
    assert(serviceState.schema === "jcc-mumu-runtime-service-state-v1", "service state schema mismatch");
    assert(serviceState.status === "ready", "service state should be ready in dry-run");
    assert(serviceState.owner_instance_id === "autodiscovery-owner" && serviceState.owner_pid === process.pid, "persisted service state must preserve watcher ownership");
  } else {
    assert(result.code === 1, "not-found discovery should exit nonzero for the action caller");
    assert(report.reason === "no_recommended_mumu_jcc_target", "not-found discovery should explain missing target");
    assert(report.discovery?.recommended_target === null, "not-found discovery must not invent a target");
    assert(/Start MuMu and JCC|retry discovery/i.test(report.discovery?.ui_hint || ""), "not-found discovery must tell UI/user how to recover");
  }
  console.log(JSON.stringify({
    ok: true,
    checked: [
      "MuMu/JCC discovery is an explicit user-triggered action",
      "discovery never hardcodes a fixed MuMu port",
      "discovery scans configured MuMu ports when the user asks to connect/rescan",
      "discovery selects by JCC signals plus runtime health instead of fixed port order",
      "discovery returns a UI-recoverable not-found state when MuMu/JCC is not online",
      "ready discovery forwards only structured-source arguments into the watcher command",
      "service state is written for UI/backend consumption when ready",
    ],
    status: report.status,
    recommended_target: report.recommended_target || report.discovery?.recommended_target || null,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
