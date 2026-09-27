import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeDaemonClient } from "../ui/electron/runtime-daemon-client.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: 124, stdout, stderr: `${stderr}\nTimed out`.trim() });
    }, Number(options.timeoutMs || 30000));
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: error.message || String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function verifyLiveMumuIfRequired(requireLiveMumu) {
  if (!requireLiveMumu) {
    return {
      status: "external_dependency_pending",
      live_mumu_accepted: false,
      reason: "Run with --require-live-mumu during a real MuMu session/replay to promote this boundary.",
    };
  }
  const result = await runNode(["tools/discover-jcc-mumu-adb-target.mjs"], { timeoutMs: 30000 });
  assert(result.code === 0, `MuMu live discovery failed: ${result.stderr || result.stdout}`);
  let discovery = null;
  try {
    discovery = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`MuMu live discovery did not return JSON: ${error?.message || String(error)}`);
  }
  const candidates = Array.isArray(discovery?.candidates) ? discovery.candidates : [];
  assert(discovery?.recommended_target || candidates.some((candidate) => candidate?.recommended || Number(candidate?.score || 0) >= 40),
    `MuMu live discovery found no accepted JCC target: ${discovery?.ui_hint || result.stdout}`);
  return {
    status: "pass",
    live_mumu_accepted: true,
    recommended_target: discovery.recommended_target || null,
    candidate_count: candidates.length,
    stdout_tail: result.stdout.trim().slice(-1000),
  };
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function waitForJsonFile(file, { timeoutMs = 12000, intervalMs = 500 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await readJsonIfExists(file);
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

async function verifyLiveWatcherIfRequired({ requireLiveMumu, client, tempRoot, durationMs }) {
  if (!requireLiveMumu) {
    return {
      status: "external_dependency_pending",
      watcher_live_state_accepted: false,
      reason: "Run with --require-live-mumu during a real MuMu session/replay to verify watcher live_state attach.",
    };
  }

  const match = await client.action("startMatch", {});
  assert(match.ok === true, `Start Match action failed: ${JSON.stringify(match)}`);
  const stateAfterStart = match.state || {};
  assert(stateAfterStart.match_session?.status === "active", "Start Match must create an active match session");
  assert(stateAfterStart.match_connection?.status === "waiting_for_live_state", "Start Match should wait for real live_state before claiming live cruise");

  const watchDir = path.join(tempRoot, "runtime-evidence", "mumu-gi-live", "current-watch");
  const liveStateFile = path.join(watchDir, "cruise-live-state.json");
  const liveState = await waitForJsonFile(liveStateFile, {
    timeoutMs: Math.max(12000, Number(durationMs || 0) + 4000),
    intervalMs: 500,
  });
  assert(liveState, `watcher did not write cruise-live-state.json within live acceptance window: ${liveStateFile}`);

  const poll = await client.action("pollCruiseAdvice", {});
  assert(poll.ok === true, `pollCruiseAdvice failed after watcher live_state: ${JSON.stringify(poll)}`);
  assert(
    poll.state?.match_connection?.status === "connected_to_live_match" || poll.status !== "no_live_state",
    `pollCruiseAdvice did not consume watcher live_state: ${JSON.stringify(poll)}`,
  );
  return {
    status: "pass",
    watcher_live_state_accepted: true,
    live_state_file: liveStateFile,
    live_state_schema: liveState.schema || null,
    live_state_match_session_id: liveState.match_session_id || null,
    poll_status: poll.status || null,
    match_connection: poll.state?.match_connection || null,
  };
}

async function rmWithRetry(target, attempts = 12) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw lastError;
}

async function main() {
  const durationMs = Math.max(1000, Number(argValue("--duration-ms", "3000")));
  const requireLiveMumu = hasFlag("--require-live-mumu");
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-live-soak-"));
  const events = [];
  const logs = [];
  const client = new RuntimeDaemonClient({
    repoRoot,
    electronDir: path.join(repoRoot, "ui", "electron"),
    nodeCommand: process.execPath,
    env: {
      ...process.env,
      JCC_RUNTIME_DATA_DIR: tempRoot,
      JCC_UI_DISABLE_CODEX_EXEC: "1",
      JCC_RUNTIME_DAEMON_PORT: "0",
      JCC_RUNTIME_DAEMON_START_TIMEOUT_MS: "300000",
    },
    log: (type, payload) => logs.push({ type, payload }),
  });

  try {
    const liveMumu = await verifyLiveMumuIfRequired(requireLiveMumu);
    await client.ensureStarted();
    client.subscribe((event) => {
      if (event?.type) events.push({ type: event.type, at: Date.now() });
    }).catch((error) => {
      logs.push({ type: "subscribe-error", payload: { error: error?.message || String(error) } });
    });

    await client.action("bootstrap", {});
    await client.action("sendMessage", {
      mode: "daily_chat",
      text: "verify selected context without live host generation",
    });
    const liveWatcher = await verifyLiveWatcherIfRequired({ requireLiveMumu, client, tempRoot, durationMs });

    const startedAt = Date.now();
    const samples = [];
    while (Date.now() - startedAt < durationMs) {
      const state = await client.state();
      const queue = await client.queue({ limit: 20 });
      samples.push({
        t: Date.now() - startedAt,
        state_ok: state.ok === true,
        queue_count: Array.isArray(queue.queue) ? queue.queue.length : null,
        daemon_health: state.daemon_health?.ok === true,
      });
      await client.recoverStaleQueueItems({ staleMs: 0, limit: 10 });
      await sleep(Math.min(500, Math.max(100, durationMs / 6)));
    }

    const finalState = await client.state();
    const finalQueue = await client.queue({ limit: 50 });
    assert(finalState.ok === true, "daemon state must stay healthy during soak");
    assert(finalState.daemon_health?.ok === true, "daemon health must stay true during soak");
    assert(finalQueue.ok === true && Array.isArray(finalQueue.queue), "queue inspect must stay available during soak");
    assert(finalQueue.queue.some((item) => item.queue_name === "host_request"), "soak should persist a host_request queue item");
    assert(events.some((event) => event.type === "runtime_action_completed" || event.type === "queue_item_updated"), "soak should observe daemon push events");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: "jcc-live-acceptance-soak-v1",
      status: requireLiveMumu ? "pass" : "simulated_pass_external_mumu_pending",
      duration_ms: durationMs,
      data_root: tempRoot,
      live_mumu: liveMumu,
      live_watcher: liveWatcher,
      checked: [
        "independent-daemon-start",
        "http-state-loop",
        "queue-inspect-loop",
        "push-events-observed",
        "host-request-persisted",
        "stale-queue-recovery-call",
        "transient-temp-data-root-cleanup",
        requireLiveMumu ? "start-match-watcher-live-state-poll-cruise-attach" : "live-watcher-boundary-pending",
      ],
      samples,
      event_types: [...new Set(events.map((event) => event.type))],
      log_types: [...new Set(logs.map((log) => log.type))],
    }, null, 2)}\n`);
  } finally {
    client.stopEvents();
    await client.stop().catch(() => {});
    await rmWithRetry(tempRoot);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
