import { spawn } from "node:child_process";
import path from "node:path";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--adb") options.adb = argv[++index];
    else if (arg === "--no-connect") options.noConnect = true;
    else if (arg === "--ports") options.ports = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const args = ["tools/discover-jcc-mumu-adb-target.mjs"];
  if (options.adb) args.push("--adb", options.adb);
  if (options.noConnect) args.push("--no-connect");
  if (options.ports) args.push("--ports", options.ports);
  const result = await runNode(args);
  let discovery;
  try {
    discovery = JSON.parse(result.stdout);
  } catch {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.code || 1);
  }
  const onlineDevices = (discovery.candidates || [])
    .filter((candidate) => candidate.online)
    .map((candidate) => `${candidate.serial}\tdevice`);
  const recommended = discovery.recommended_target;
  const report = {
    ok: result.code === 0 && discovery.ok !== false,
    adb_candidate: discovery.adb || null,
    checked_candidates: discovery.checked_adb_candidates || [],
    devices_stdout: discovery.devices_stdout || "",
    devices_stderr: discovery.devices_stderr || discovery.reason || "",
    online_devices: onlineDevices,
    scanned_mumu_ports: discovery.port_scan?.ports || [],
    mumu_discovery: discovery,
    mumu_adb_runtime_ready: Boolean(recommended),
    recommended_mumu_device: recommended?.serial || null,
    recommended_mumu_host: recommended?.host || null,
    recommended_mumu_port: recommended?.port || null,
    next_step: recommended
      ? `use --device ${recommended.serial} for MuMu runtime logcat`
      : discovery.reason
        ? "install/fix Android platform-tools or set JCC_ADB, then retry MuMu discovery"
        : "start MuMu and JCC; discovery will scan common local MuMu ADB ports automatically",
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
