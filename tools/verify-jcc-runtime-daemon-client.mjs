import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { RuntimeDaemonClient } from "../ui/electron/runtime-daemon-client.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function includes(text, needle, message) {
  assert(text.includes(needle), message || `missing ${needle}`);
}

async function main() {
  const client = await readFile("ui/electron/runtime-daemon-client.js", "utf8");
  const exitBody = client.match(/this\.process\.once\("exit", \(code, signal\) => \{([\s\S]*?)\n    \}\);/)?.[1];
  assert(exitBody, "daemon exit handler must exist");
  const oldChild = {};
  const newChild = {};
  const owner = { process: newChild, ownsProcess: true, info: { pid: 2 }, log() {} };
  const oldExit = Function("spawnedProcess", "code", "signal", exitBody);
  oldExit.call(owner, oldChild, 0, null);
  assert(owner.process === newChild && owner.ownsProcess && owner.info.pid === 2, "late old exit must preserve replacement ownership");
  oldExit.call(owner, newChild, 0, null);
  assert(owner.process === null && owner.info === null && !owner.ownsProcess, "current process exit must clear its own ownership");
  const customDataRoot = path.resolve(".tmp-jcc-runtime-data-root-test");
  const customClient = new RuntimeDaemonClient({
    repoRoot: process.cwd(),
    electronDir: path.resolve("ui/electron"),
    env: { ...process.env, JCC_RUNTIME_DATA_DIR: customDataRoot },
    log: () => {},
  });
  assert(customClient.infoFile.startsWith(customDataRoot), "client daemon-info must respect JCC_RUNTIME_DATA_DIR");
  includes(client, "authHeaders", "client must centralize daemon auth headers");
  includes(client, "x-jcc-runtime-token", "client must send daemon token");
  includes(client, "this.ownsProcess = false", "client must track non-owned daemon state");
  includes(client, "this.ownsProcess = true", "client must mark spawned daemons as owned");
  includes(client, "this.ensureStartedPromise = null", "client must track in-flight daemon startup");
  includes(client, "async ensureStartedInner()", "client must separate single-flight wrapper from startup implementation");
  includes(client, "if (this.ensureStartedPromise) return this.ensureStartedPromise", "client must de-duplicate concurrent ensureStarted calls");
  includes(client, "this.supervisorObservedFailure = true", "client supervisor must remember a failed startup until recovery");
  includes(client, "await onReconnect({ before, after, recovered", "client supervisor must notify after recovering from a failed startup even without an old URL");
  assert(customClient.daemonStartTimeoutMs === 300000, "daemon startup must use a five-minute final guard for module loading and Active Ranking reconciliation");
  const overriddenTimeoutClient = new RuntimeDaemonClient({
    repoRoot: process.cwd(),
    electronDir: path.resolve("ui/electron"),
    env: { ...process.env, JCC_RUNTIME_DAEMON_START_TIMEOUT_MS: "60000" },
    log: () => {},
  });
  assert(overriddenTimeoutClient.daemonStartTimeoutMs === 60000, "daemon startup timeout must remain configurable");
  includes(client, "daemon-reused", "client must reuse healthy daemon-info sidecars");
  includes(client, "shouldReuseDaemon", "client must centralize daemon reuse policy");
  includes(client, "retireIncompatibleDaemon", "client must actively retire stale or incompatible sidecars");
  includes(client, "daemon-retire-incompatible", "client must log stale daemon retirement");
  includes(client, "runtimeSourceFingerprint", "client must fingerprint daemon source files before reuse");
  includes(client, "runtime_source_fingerprint", "client must compare daemon source fingerprint before reuse");
  includes(client, "JCC_RUNTIME_SOURCE_FINGERPRINT", "client must pass runtime source fingerprint to spawned daemon");
  includes(client, "runtime_source_or_host_exec_mismatch", "client must reject stale daemon code as well as host-exec mode mismatch");
  includes(client, "Existing JCC runtime daemon was started with incompatible runtime source or host-exec mode", "client must distinguish source mismatch from old host-exec-only mismatch text");
  includes(client, "typeof daemonFlag !== \"boolean\"", "client must refuse stale daemon-info without host-exec mode metadata");
  includes(client, "if (this.ownsProcess)", "client stop must branch on ownership");
  includes(client, "if (ownedProcess", "client may only kill an owned process");
  includes(client, "subscribe(onEvent)", "client must expose daemon event subscription");
  includes(client, "readWebSocketEvents", "client must prefer daemon WebSocket events");
  includes(client, "websocket_with_sse_fallback", "client contract must prefer WebSocket with SSE fallback");
  includes(client, "readEventStream", "client must parse daemon SSE events");
  includes(client, "this.eventAbortController.abort()", "client must be able to stop event streaming");
  assert(!client.includes("await postJson(`${this.info.url}/shutdown`, {});"), "client must not shutdown daemon without auth/ownership");

  const main = await readFile("ui/electron/main.js", "utf8");
  includes(main, "ensureDaemonEventForwarding", "Electron main must start daemon event forwarding");
  includes(main, "createRetryableDaemonEventForwarder", "Electron main must use the retryable daemon event forwarder");
  includes(main, "ensureStarted: () => client.ensureStarted()", "Electron main forwarder must await daemon readiness before subscribing");
  includes(main, "await daemonEventForwarder.ensure()", "Electron main must await the readiness/forwarding starter before actions");
  includes(main, "mainWindow?.webContents.send(\"jcc-runtime:event\"", "Electron main must forward daemon events");
  includes(main, "runtimeDaemonClient?.stopEvents?.()", "Electron main should stop event stream on quit");
  assert(!main.includes("await getDaemonClient().subscribe"), "Electron main must not await the long-lived daemon event stream before dispatching actions");
  includes(main, "subscribe: (onEvent) => client.subscribe(onEvent)", "Electron main must start daemon event subscription through the forwarder");
  includes(main, "onEvent: (runtimeEvent)", "Electron main must forward daemon runtime events through the retryable forwarder");
  includes(main, "await getDaemonClient().action(\"bootstrap\", { app_launch_id: appLaunchId })", "Electron main must bind recovery bootstrap to this app launch");

  const preload = await readFile("ui/electron/preload.js", "utf8");
  includes(preload, "onRuntimeEvent", "preload must expose runtime event subscription");
  includes(preload, "ipcRenderer.on(\"jcc-runtime:event\"", "preload must bridge daemon event IPC");

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-daemon-client-single-flight-"));
  const logs = [];
  const liveClient = new RuntimeDaemonClient({
    repoRoot: process.cwd(),
    electronDir: path.resolve("ui/electron"),
    env: {
      ...process.env,
      JCC_RUNTIME_DATA_DIR: tempRoot,
      JCC_RUNTIME_DAEMON_PORT: "0",
      JCC_UI_DISABLE_CODEX_EXEC: "1",
    },
    log: (event, payload = {}) => logs.push({ event, ...payload }),
  });
  let startupElapsedMs = null;
  let restartElapsedMs = null;
  try {
    const startupStartedAt = Date.now();
    await Promise.all([
      liveClient.ensureStarted(),
      liveClient.ensureStarted(),
      liveClient.ensureStarted(),
    ]);
    startupElapsedMs = Date.now() - startupStartedAt;
    assert(
      startupElapsedMs < liveClient.daemonStartTimeoutMs,
      `daemon cold start exceeded the ${liveClient.daemonStartTimeoutMs}ms final guard`,
    );
    const readyEvents = logs.filter((entry) => entry.event === "daemon-stdout-json" && entry.type === "jcc-runtime-daemon-ready");
    assert(readyEvents.length === 1, `concurrent ensureStarted should spawn exactly one daemon, got ${readyEvents.length}`);
    const firstReady = { pid: liveClient.info?.pid || null, url: liveClient.info?.url || null };
    const restartStartedAt = Date.now();
    await liveClient.restart();
    restartElapsedMs = Date.now() - restartStartedAt;
    assert(
      restartElapsedMs < liveClient.daemonStartTimeoutMs,
      `daemon replacement restart exceeded the ${liveClient.daemonStartTimeoutMs}ms final guard`,
    );
    assert(liveClient.info?.url, "daemon restart must return only after the replacement is ready");
    assert(
      liveClient.info.pid !== firstReady.pid || liveClient.info.url !== firstReady.url,
      "daemon restart must replace the previous process or endpoint",
    );
  } finally {
    await liveClient.stop().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }

  const recoveredClient = new RuntimeDaemonClient({
    repoRoot: process.cwd(),
    electronDir: path.resolve("ui/electron"),
    log: () => {},
  });
  let supervisorAttempts = 0;
  recoveredClient.ensureStarted = async () => {
    supervisorAttempts += 1;
    if (supervisorAttempts === 1) throw new Error("simulated initial startup timeout");
    recoveredClient.info = { url: "http://127.0.0.1:45678" };
    return recoveredClient;
  };
  const recoveredEvent = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("supervisor did not report recovery after an initial startup failure")), 1000);
    recoveredClient.startSupervisor({
      intervalMs: 10,
      onReconnect: async (event) => {
        clearTimeout(timeout);
        resolve(event);
      },
    });
  });
  try {
    const event = await recoveredEvent;
    assert(event.recovered === true, "supervisor recovery must retain the failed-start signal");
    assert(event.before === null, "first-start recovery must not require an old endpoint URL");
    assert(event.after === "http://127.0.0.1:45678", "supervisor recovery must expose the new daemon endpoint");
  } finally {
    recoveredClient.stopSupervisor();
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    startup_elapsed_ms: startupElapsedMs,
    restart_elapsed_ms: restartElapsedMs,
    checked: [
      "token-auth-client-contract",
      "owned-process-shutdown-contract",
      "non-owner-reuse-contract",
      "single-flight-daemon-startup",
      "five-minute-daemon-startup-final-guard",
      "daemon-startup-timeout-override",
      "daemon-startup-duration-within-final-guard",
      "daemon-restart-waits-for-replacement-readiness",
      "daemon-restart-duration-within-final-guard",
      "first-start-failure-recovery-callback",
      "host-exec-mode-reuse-guard",
      "runtime-source-fingerprint-reuse-guard",
      "stale-daemon-active-retirement",
      "websocket-with-sse-fallback-contract",
      "electron-event-forwarding-contract",
      "electron-event-forwarding-does-not-block-actions",
    ],
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
