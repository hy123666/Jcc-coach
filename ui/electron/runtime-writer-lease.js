import { spawnSync } from "node:child_process";

const PROCESS_START_TOLERANCE_MS = 2_000;

function normalizeIsoTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function processExists(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function inspectWindowsProcessIdentity(pid) {
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter \"ProcessId=${Number(pid)}\" -ErrorAction SilentlyContinue`,
    "if (-not $process) { exit 3 }",
    "$value = [PSCustomObject]@{",
    "  pid = [int]$process.ProcessId",
    "  started_at = $process.CreationDate.ToUniversalTime().ToString('o')",
    "  executable_path = [string]$process.ExecutablePath",
    "  command_line = [string]$process.CommandLine",
    "}",
    "$value | ConvertTo-Json -Compress",
  ].join("\n");
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(String(result.stdout || "").trim());
    return {
      pid: Number(parsed.pid),
      started_at: normalizeIsoTimestamp(parsed.started_at),
      executable_path: String(parsed.executable_path || "") || null,
      command_line: String(parsed.command_line || "") || null,
    };
  } catch {
    return null;
  }
}

export function inspectProcessIdentity(pid) {
  const numericPid = Number(pid);
  if (!processExists(numericPid)) return { status: "missing", pid: numericPid };
  if (process.platform === "win32") {
    const identity = inspectWindowsProcessIdentity(numericPid);
    return identity?.started_at
      ? { status: "observed", ...identity }
      : { status: "unverifiable", pid: numericPid };
  }
  if (numericPid === process.pid) {
    return {
      status: "observed",
      pid: numericPid,
      started_at: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
      executable_path: process.execPath,
      command_line: process.argv.join(" "),
    };
  }
  return { status: "unverifiable", pid: numericPid };
}

export function currentProcessIdentity() {
  return {
    status: "observed",
    pid: process.pid,
    started_at: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
    executable_path: process.execPath,
    command_line: process.argv.join(" "),
  };
}

export function inspectWriterLeaseOwner(lease) {
  const pid = Number(lease?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { status: "unverifiable", reason: "invalid_pid" };
  const current = inspectProcessIdentity(pid);
  if (current.status === "missing") return { status: "stale", reason: "process_missing", current };
  if (current.status !== "observed") return { status: "unverifiable", reason: "process_identity_unavailable", current };

  const expectedStartedAt = normalizeIsoTimestamp(lease?.process_started_at);
  const acquiredAt = normalizeIsoTimestamp(lease?.acquired_at);
  const currentStartedAt = normalizeIsoTimestamp(current.started_at);
  if (!currentStartedAt) return { status: "unverifiable", reason: "process_start_unavailable", current };

  if (expectedStartedAt) {
    const drift = Math.abs(Date.parse(currentStartedAt) - Date.parse(expectedStartedAt));
    return drift <= PROCESS_START_TOLERANCE_MS
      ? { status: "active", reason: "process_instance_matches", current }
      : { status: "stale", reason: "pid_reused", current };
  }

  if (acquiredAt && Date.parse(currentStartedAt) > Date.parse(acquiredAt) + PROCESS_START_TOLERANCE_MS) {
    return { status: "stale", reason: "legacy_lease_pid_reused", current };
  }
  return { status: "active", reason: "legacy_lease_live_process", current };
}

export function leaseOwnerIsCurrentProcess(lease) {
  return inspectWriterLeaseOwner(lease).status === "active";
}
