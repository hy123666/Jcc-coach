import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createRuntimePaths } from "./runtime-state-store.js";

export const runtimeDaemonClientContract = {
  schema: "jcc-runtime-daemon-client-v1",
  control_transport: "http",
  event_transport: "websocket_with_sse_fallback",
  ui_policy: "Electron main owns windows; runtime daemon owns JCC state and actions.",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveDuration(value, fallback, minimum = 1) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(minimum, numeric) : fallback;
}

function redactDaemonInfoForLog(value) {
  if (!value || typeof value !== "object") return value;
  const copy = { ...value };
  if (copy.token) copy.token = "[redacted]";
  if (typeof copy.websocket_url === "string") {
    try {
      const url = new URL(copy.websocket_url);
      if (url.searchParams.has("token")) url.searchParams.set("token", "[redacted]");
      copy.websocket_url = url.toString();
    } catch {
      copy.websocket_url = copy.websocket_url.replace(/([?&]token=)[^&]+/i, "$1[redacted]");
    }
  }
  return copy;
}

function safeKillProcess(child) {
  if (!child || typeof child.kill !== "function") return false;
  try {
    if (child.exitCode === null || child.exitCode === undefined) {
      child.kill();
      return true;
    }
  } catch {}
  return false;
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

function daemonRetirementError(info, reason, cause = null) {
  const error = new Error(
    `Refusing to start a second JCC runtime daemon because incompatible daemon ${info?.pid || "unknown"} could not be retired (${reason})`,
  );
  error.code = "JCC_RUNTIME_DAEMON_RETIRE_FAILED";
  if (cause) error.cause = cause;
  return error;
}

const DAEMON_SOURCE_FILES = [
  "runtime-daemon-server.js",
  "runtime-daemon.js",
  "runtime-daemon-client.js",
  "runtime-service.js",
  "runtime-state-store.js",
  "host-adapters.js",
  "runtime-writer-lease.js",
];

function runtimeSourceFingerprint(electronDir) {
  const hash = createHash("sha256");
  for (const file of DAEMON_SOURCE_FILES) {
    const fullPath = path.join(electronDir, file);
    hash.update(file);
    hash.update("\0");
    hash.update(fs.existsSync(fullPath) ? fs.readFileSync(fullPath) : "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(parsed?.error || `HTTP ${response.status}`);
  return parsed;
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { method: "GET", headers: { accept: "application/json", ...headers } });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(parsed?.error || `HTTP ${response.status}`);
  return parsed;
}

export class RuntimeDaemonClient {
  constructor({ repoRoot, electronDir, nodeCommand = process.execPath, env = process.env, log = null }) {
    this.repoRoot = repoRoot;
    this.electronDir = electronDir;
    this.nodeCommand = nodeCommand;
    this.env = env;
    this.log = log || (() => {});
    this.paths = createRuntimePaths(repoRoot, { dataRoot: env.JCC_RUNTIME_DATA_DIR });
    this.infoFile = path.join(this.paths.runtimeDataRoot, "runtime-daemon", "daemon-info.json");
    this.sourceFingerprint = runtimeSourceFingerprint(electronDir);
    this.process = null;
    this.info = null;
    this.ownsProcess = false;
    this.eventAbortController = null;
    this.eventLoop = null;
    this.webSocket = null;
    this.eventCallback = null;
    this.eventLoopGeneration = 0;
    this.eventsStopped = true;
    this.lastEventSequence = 0;
    this.eventHasConnected = false;
    this.eventReconnectTimer = null;
    this.eventReconnectResolve = null;
    this.eventReconnectMs = positiveDuration(env.JCC_RUNTIME_EVENT_RECONNECT_MS, 500, 10);
    this.daemonRetireTimeoutMs = positiveDuration(env.JCC_RUNTIME_DAEMON_RETIRE_TIMEOUT_MS, 5000, 250);
    this.daemonStartTimeoutMs = positiveDuration(env.JCC_RUNTIME_DAEMON_START_TIMEOUT_MS, 300000, 1000);
    this.supervisorTimer = null;
    this.supervisorStarted = false;
    this.supervisorObservedFailure = false;
    this.supervisorLastReadyUrl = null;
    this.ensureStartedPromise = null;
  }

  loadExistingInfo() {
    try {
      if (!fs.existsSync(this.infoFile)) return null;
      const info = JSON.parse(fs.readFileSync(this.infoFile, "utf8").replace(/^\uFEFF/, ""));
      return info?.url ? info : null;
    } catch (error) {
      this.log("daemon-info-read-failed", { error: error?.message || String(error) });
      return null;
    }
  }

  authHeaders(info = this.info) {
    return info?.token ? { "x-jcc-runtime-token": info.token } : {};
  }

  shouldReuseDaemon(info, health = null) {
    if (!info?.url) return false;
    const daemonFingerprint = health?.runtime_source_fingerprint ?? info.runtime_source_fingerprint;
    if (daemonFingerprint !== this.sourceFingerprint) return false;
    const currentDisablesHostExec = this.env.JCC_UI_DISABLE_CODEX_EXEC === "1";
    const daemonFlag = health?.host_cli_exec_disabled ?? info.host_cli_exec_disabled;
    if (typeof daemonFlag !== "boolean") return false;
    const daemonDisablesHostExec = daemonFlag;
    return daemonDisablesHostExec === currentDisablesHostExec;
  }

  async retireIncompatibleDaemon(info, reason, ownedProcess = null) {
    if (!info?.url) return;
    this.log("daemon-retire-incompatible", {
      url: info.url,
      pid: info.pid || null,
      reason,
      owned: Boolean(ownedProcess),
    });
    let retirementError = null;
    try {
      await postJson(`${info.url}/shutdown`, {}, this.authHeaders(info));
      if (ownedProcess) {
        await Promise.race([once(ownedProcess, "exit"), sleep(1500)]).catch(() => {});
        safeKillProcess(ownedProcess);
      }
    } catch (error) {
      this.log("daemon-retire-incompatible-failed", {
        url: info.url,
        error: error?.message || String(error),
      });
      retirementError = error;
      if (ownedProcess) safeKillProcess(ownedProcess);
    }
    const started = Date.now();
    while (Date.now() - started < this.daemonRetireTimeoutMs) {
      const pidAlive = info.pid ? processExists(info.pid) : null;
      let endpointAlive = true;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 250);
      try {
        const response = await fetch(`${info.url}/health`, {
          method: "GET",
          headers: this.authHeaders(info),
          signal: controller.signal,
        });
        endpointAlive = response.ok;
      } catch {
        endpointAlive = false;
      } finally {
        clearTimeout(timeout);
      }
      if (!endpointAlive && (pidAlive === false || pidAlive === null)) {
        try {
          if (fs.existsSync(this.infoFile)) fs.rmSync(this.infoFile, { force: true });
        } catch {}
        return;
      }
      await sleep(50);
    }
    throw daemonRetirementError(info, reason, retirementError);
  }

  async ensureStarted() {
    if (this.ensureStartedPromise) return this.ensureStartedPromise;
    this.ensureStartedPromise = this.ensureStartedInner().finally(() => {
      this.ensureStartedPromise = null;
    });
    return this.ensureStartedPromise;
  }

  async ensureStartedInner() {
    if (this.info?.url) {
      try {
        const health = await getJson(`${this.info.url}/health`, this.authHeaders());
        if (this.shouldReuseDaemon(this.info, health)) return this;
        this.log("daemon-reuse-policy-mismatch", {
          url: this.info.url,
          reason: "runtime_source_or_host_exec_mismatch",
          current_disabled: this.env.JCC_UI_DISABLE_CODEX_EXEC === "1",
          daemon_disabled: health?.host_cli_exec_disabled ?? this.info.host_cli_exec_disabled ?? null,
          current_source_fingerprint: this.sourceFingerprint,
          daemon_source_fingerprint: health?.runtime_source_fingerprint ?? this.info.runtime_source_fingerprint ?? null,
        });
        await this.retireIncompatibleDaemon(this.info, "active-daemon-runtime-source-or-host-exec-mismatch", this.ownsProcess ? this.process : null);
        this.info = null;
        this.process = null;
        this.ownsProcess = false;
      } catch (error) {
        if (error?.code === "JCC_RUNTIME_DAEMON_RETIRE_FAILED") throw error;
        this.info = null;
        this.ownsProcess = false;
      }
    }
    const existing = this.loadExistingInfo();
    if (existing?.url) {
      try {
        const health = await getJson(`${existing.url}/health`, this.authHeaders(existing));
        if (!this.shouldReuseDaemon(existing, health)) {
          this.log("daemon-reuse-skipped", {
            url: existing.url,
            reason: "runtime_source_or_host_exec_mismatch",
            current_disabled: this.env.JCC_UI_DISABLE_CODEX_EXEC === "1",
            daemon_disabled: health?.host_cli_exec_disabled ?? existing.host_cli_exec_disabled ?? null,
            current_source_fingerprint: this.sourceFingerprint,
            daemon_source_fingerprint: health?.runtime_source_fingerprint ?? existing.runtime_source_fingerprint ?? null,
          });
          await this.retireIncompatibleDaemon(existing, "existing-daemon-runtime-source-or-host-exec-mismatch");
          throw new Error("Existing JCC runtime daemon was started with incompatible runtime source or host-exec mode");
        }
        this.info = existing;
        this.ownsProcess = false;
        this.log("daemon-reused", { url: existing.url, pid: existing.pid || null });
        return this;
      } catch (error) {
        if (error?.code === "JCC_RUNTIME_DAEMON_RETIRE_FAILED") throw error;
        this.log("daemon-reuse-failed", { url: existing.url, error: error?.message || String(error) });
      }
    }
    const serverFile = path.join(this.electronDir, "runtime-daemon-server.js");
    if (!fs.existsSync(serverFile)) throw new Error(`Missing runtime daemon server: ${serverFile}`);
    this.process = spawn(this.nodeCommand, [serverFile], {
      cwd: this.repoRoot,
      env: {
        ...this.env,
        JCC_RUNTIME_REPO_ROOT: this.repoRoot,
        JCC_RUNTIME_SOURCE_FINGERPRINT: this.sourceFingerprint,
        ELECTRON_RUN_AS_NODE: "1",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const spawnedProcess = this.process;
    let startupStderr = "";
    this.ownsProcess = true;
    this.process.stderr.on("data", (chunk) => {
      startupStderr = (startupStderr + String(chunk)).slice(-65536);
      this.log("daemon-stderr", { text: String(chunk).slice(0, 800) });
    });
    this.process.stdout.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "jcc-runtime-daemon-ready" && this.process === spawnedProcess) this.info = parsed;
          this.log("daemon-stdout-json", redactDaemonInfoForLog(parsed));
        } catch {
          this.log("daemon-stdout", { text: line.slice(0, 800) });
        }
      }
    });
    this.process.once("exit", (code, signal) => {
      this.log("daemon-exit", { code, signal });
      if (this.process !== spawnedProcess) return;
      this.info = null;
      this.process = null;
      this.ownsProcess = false;
    });
    const started = Date.now();
    while (Date.now() - started < this.daemonStartTimeoutMs) {
      if (this.info?.url) {
        await getJson(`${this.info.url}/health`, this.authHeaders());
        return this;
      }
      if (spawnedProcess.exitCode !== null) {
        const line = startupStderr.split(/\r?\n/).find((entry) => entry.includes("jcc-runtime-daemon-start-failed"));
        let parsed = null;
        try {
          parsed = line ? JSON.parse(line) : null;
        } catch {}
        const missingPackage = startupStderr.match(/Cannot find package ['"]([^'"]+)['"]/);
        const startupDetail = missingPackage ? `Missing runtime dependency: ${missingPackage[1]}` : null;
        const error = new Error(parsed?.error || startupDetail || `JCC runtime daemon exited before ready (code ${spawnedProcess.exitCode})`);
        error.code = parsed?.code || "JCC_RUNTIME_DAEMON_START_FAILED";
        throw error;
      }
      await sleep(100);
    }
    safeKillProcess(this.process);
    throw new Error(`JCC runtime daemon did not become ready within ${this.daemonStartTimeoutMs}ms`);
  }

  startSupervisor({ onReconnect = null, intervalMs = 5000 } = {}) {
    if (this.supervisorStarted) return;
    this.supervisorStarted = true;
    const tick = async () => {
      try {
        const before = this.supervisorLastReadyUrl || this.info?.url || null;
        await this.ensureStarted();
        const after = this.info?.url || null;
        const recovered = this.supervisorObservedFailure;
        const endpointChanged = Boolean(before && after && before !== after);
        this.supervisorObservedFailure = false;
        this.supervisorLastReadyUrl = after;
        if ((recovered || endpointChanged) && onReconnect) {
          await onReconnect({ before, after, recovered, endpoint_changed: endpointChanged });
        }
      } catch (error) {
        this.supervisorObservedFailure = true;
        this.log("daemon-supervisor-health-failed", { error: error?.message || String(error) });
      } finally {
        if (this.supervisorStarted) this.supervisorTimer = setTimeout(tick, intervalMs);
      }
    };
    this.supervisorTimer = setTimeout(tick, intervalMs);
  }

  stopSupervisor() {
    this.supervisorStarted = false;
    this.supervisorObservedFailure = false;
    this.supervisorLastReadyUrl = null;
    if (this.supervisorTimer) clearTimeout(this.supervisorTimer);
    this.supervisorTimer = null;
  }

  async action(action, payload) {
    await this.ensureStarted();
    try {
      return await postJson(`${this.info.url}/action`, { action, payload: payload || {} }, this.authHeaders());
    } catch (error) {
      const message = error?.message || String(error);
      if (!message.includes("Unknown runtime action")) throw error;
      this.log("daemon-action-unknown-restarting", { action, error: message });
      await this.restart();
      return postJson(`${this.info.url}/action`, { action, payload: payload || {} }, this.authHeaders());
    }
  }

  async sendCruiseHardDataQuery(text) {
    return this.action("sendCruiseHardDataQuery", { text });
  }

  async sendDailyCoreTheoryQuery(text) {
    return this.action("sendDailyCoreTheoryQuery", { text });
  }

  async sendCruisePopularRecipeQuery(text) {
    return this.action("sendCruisePopularRecipeQuery", { text });
  }

  async updateRankings() {
    return this.action("updateRankings");
  }

  async state() {
    await this.ensureStarted();
    return getJson(`${this.info.url}/state`, this.authHeaders());
  }

  async queue({ queueName = null, status = null, limit = 50 } = {}) {
    await this.ensureStarted();
    const url = new URL(`${this.info.url}/queue`);
    if (queueName) url.searchParams.set("queue_name", queueName);
    if (status) url.searchParams.set("status", status);
    url.searchParams.set("limit", String(limit));
    return getJson(url.toString(), this.authHeaders());
  }

  async updateQueueItem(id, status, patch = {}, lease = {}) {
    await this.ensureStarted();
    return postJson(`${this.info.url}/queue/update`, {
      id,
      status,
      patch,
      worker_id: lease.workerId || null,
      lease_token: lease.leaseToken || null,
      lease_generation: lease.leaseGeneration ?? null,
    }, this.authHeaders());
  }

  async claimQueueItem(queueName, { workerId = null, leaseMs = 30000 } = {}) {
    await this.ensureStarted();
    return postJson(`${this.info.url}/queue/claim`, {
      queue_name: queueName,
      worker_id: workerId,
      lease_ms: leaseMs,
    }, this.authHeaders());
  }

  async completeQueueItem(id, patch = {}, lease = {}) {
    await this.ensureStarted();
    return postJson(`${this.info.url}/queue/complete`, {
      id,
      patch,
      worker_id: lease.workerId || null,
      lease_token: lease.leaseToken || null,
      lease_generation: lease.leaseGeneration ?? null,
    }, this.authHeaders());
  }

  async failQueueItem(id, error = {}, {
    retryDelayMs = 0,
    workerId = null,
    leaseToken = null,
    leaseGeneration = null,
  } = {}) {
    await this.ensureStarted();
    return postJson(`${this.info.url}/queue/fail`, {
      id,
      error,
      retry_delay_ms: retryDelayMs,
      worker_id: workerId,
      lease_token: leaseToken,
      lease_generation: leaseGeneration,
    }, this.authHeaders());
  }

  async recoverStaleQueueItems({ staleMs = 60000, limit = 100 } = {}) {
    await this.ensureStarted();
    return postJson(`${this.info.url}/queue/recover-stale`, {
      stale_ms: staleMs,
      limit,
    }, this.authHeaders());
  }

  subscribe(onEvent) {
    if (typeof onEvent !== "function") throw new Error("Runtime daemon event subscription requires a callback");
    this.eventCallback = onEvent;
    this.eventsStopped = false;
    if (this.eventLoop) return this.eventLoop;
    const generation = this.eventLoopGeneration + 1;
    this.eventLoopGeneration = generation;
    const loop = this.runEventLoop(generation);
    const trackedLoop = loop.finally(() => {
      if (this.eventLoopGeneration !== generation || this.eventLoop !== trackedLoop) return;
      this.eventLoop = null;
      this.eventAbortController = null;
      this.webSocket = null;
    });
    this.eventLoop = trackedLoop;
    return trackedLoop;
  }

  eventLoopIsActive(generation) {
    return !this.eventsStopped && generation === this.eventLoopGeneration;
  }

  dispatchRuntimeEvent(event) {
    if (!event || typeof event !== "object") return;
    const sequence = Number(event.sequence ?? event.event_id);
    if (event.type === "ready" && Number.isInteger(sequence) && sequence > this.lastEventSequence) {
      this.lastEventSequence = sequence;
    }
    const durable = event.type !== "ready"
      && event.type !== "daemon_reconnected"
      && Number.isInteger(sequence)
      && sequence > 0;
    if (durable && sequence <= this.lastEventSequence) return;
    if (durable) this.lastEventSequence = sequence;
    try {
      this.eventCallback?.(event);
    } catch (error) {
      this.log("daemon-event-callback-failed", { error: error?.message || String(error) });
    }
  }

  markEventTransportConnected(transport) {
    const reconnected = this.eventHasConnected;
    this.eventHasConnected = true;
    if (!reconnected) return;
    this.dispatchRuntimeEvent({
      schema: "jcc-runtime-daemon-event-v1",
      type: "daemon_reconnected",
      payload: { transport, since: this.lastEventSequence },
      sequence: this.lastEventSequence,
      event_id: this.lastEventSequence,
      observed_at: new Date().toISOString(),
    });
  }

  async runEventLoop(generation) {
    while (this.eventLoopIsActive(generation)) {
      try {
        await this.ensureStarted();
        if (!this.eventLoopIsActive(generation)) break;
        await this.readPreferredEventTransport(generation);
        if (this.eventLoopIsActive(generation)) {
          this.log("daemon-events-closed", { since: this.lastEventSequence });
        }
      } catch (error) {
        if (!this.eventLoopIsActive(generation)) break;
        this.log("daemon-events-error", {
          error: error?.message || String(error),
          since: this.lastEventSequence,
        });
      }
      if (this.eventLoopIsActive(generation)) await this.waitForEventReconnect(generation);
    }
  }

  async readPreferredEventTransport(generation) {
    if (this.info?.websocket_url && typeof WebSocket !== "undefined") {
      let websocketConnected = false;
      try {
        await this.readWebSocketEvents(
          (transport) => {
            websocketConnected = true;
            this.markEventTransportConnected(transport);
          },
          generation,
        );
        return;
      } catch (error) {
        if (websocketConnected || !this.eventLoopIsActive(generation)) throw error;
        this.log("daemon-websocket-error", { error: error?.message || String(error) });
      }
    }
    const controller = new AbortController();
    this.eventAbortController = controller;
    try {
      await this.readEventStream(
        (transport) => this.markEventTransportConnected(transport),
        controller.signal,
        generation,
      );
    } finally {
      if (this.eventAbortController === controller) this.eventAbortController = null;
    }
  }

  async readWebSocketEvents(onConnected, generation) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.info.websocket_url);
      if (this.lastEventSequence > 0) url.searchParams.set("since", String(this.lastEventSequence));
      const socket = new WebSocket(url.toString());
      this.webSocket = socket;
      let connected = false;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (this.webSocket === socket) this.webSocket = null;
        callback(value);
      };
      socket.addEventListener("open", () => {
        connected = true;
        if (!this.eventLoopIsActive(generation)) {
          socket.close();
          return;
        }
        onConnected("websocket");
      });
      socket.addEventListener("message", (message) => {
        try {
          this.dispatchRuntimeEvent(JSON.parse(String(message.data)));
        } catch (error) {
          this.log("daemon-websocket-parse-failed", { error: error?.message || String(error) });
        }
      });
      socket.addEventListener("error", () => finish(reject, new Error("Daemon WebSocket failed")));
      socket.addEventListener("close", () => {
        if (connected) finish(resolve);
        else finish(reject, new Error("Daemon WebSocket closed before connecting"));
      });
    });
  }

  async readEventStream(onConnected, signal, generation) {
    const url = new URL(`${this.info.url}/events`);
    const headers = this.authHeaders();
    if (this.lastEventSequence > 0) {
      url.searchParams.set("since", String(this.lastEventSequence));
      headers["last-event-id"] = String(this.lastEventSequence);
    }
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal,
    });
    if (!response.ok) throw new Error(`Daemon event stream failed: HTTP ${response.status}`);
    if (!this.eventLoopIsActive(generation)) return;
    onConnected("sse");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary) break;
        const chunk = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const dataLines = chunk.split(/\r?\n/)
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6));
        if (dataLines.length) {
          try {
            this.dispatchRuntimeEvent(JSON.parse(dataLines.join("\n")));
          } catch (error) {
            this.log("daemon-events-parse-failed", {
              error: error?.message || String(error),
              data: dataLines.join("\n").slice(0, 400),
            });
          }
        }
      }
    }
  }

  waitForEventReconnect(generation) {
    return new Promise((resolve) => {
      if (!this.eventLoopIsActive(generation)) {
        resolve();
        return;
      }
      this.eventReconnectResolve = resolve;
      this.eventReconnectTimer = setTimeout(() => {
        this.eventReconnectTimer = null;
        this.eventReconnectResolve = null;
        resolve();
      }, this.eventReconnectMs);
    });
  }

  stopEvents({ preserveSubscription = false } = {}) {
    this.eventsStopped = true;
    this.eventLoopGeneration += 1;
    if (this.eventAbortController) this.eventAbortController.abort();
    this.eventAbortController = null;
    if (this.webSocket) {
      try {
        this.webSocket.close();
      } catch {}
    }
    this.webSocket = null;
    if (this.eventReconnectTimer) clearTimeout(this.eventReconnectTimer);
    this.eventReconnectTimer = null;
    if (this.eventReconnectResolve) this.eventReconnectResolve();
    this.eventReconnectResolve = null;
    const stoppedLoop = this.eventLoop;
    this.eventLoop = null;
    if (!preserveSubscription) {
      this.eventCallback = null;
      this.eventHasConnected = false;
    }
    return stoppedLoop;
  }

  async stop() {
    this.stopSupervisor();
    this.stopEvents();
    const ownedProcess = this.ownsProcess ? this.process : null;
    if (!this.info?.url) {
      safeKillProcess(ownedProcess);
      return;
    }
    try {
      if (this.ownsProcess) {
        await postJson(`${this.info.url}/shutdown`, {}, this.authHeaders());
        if (ownedProcess) await Promise.race([once(ownedProcess, "exit"), sleep(1000)]);
        safeKillProcess(ownedProcess);
      }
    } catch {
      safeKillProcess(ownedProcess);
    } finally {
      this.info = null;
      this.process = null;
      this.ownsProcess = false;
    }
  }

  async restart() {
    const restoreEventSubscription = !this.eventsStopped && typeof this.eventCallback === "function";
    const eventCallback = this.eventCallback;
    this.stopEvents({ preserveSubscription: restoreEventSubscription });
    const previousInfo = this.info;
    const previousProcess = this.process;
    try {
      if (previousInfo?.url) {
        await postJson(`${previousInfo.url}/shutdown`, {}, this.authHeaders(previousInfo));
      }
      if (previousProcess) {
        await Promise.race([once(previousProcess, "exit"), sleep(1500)]).catch(() => {});
        safeKillProcess(previousProcess);
      }
    } catch (error) {
      this.log("daemon-restart-shutdown-failed", { error: error?.message || String(error) });
      safeKillProcess(previousProcess);
    } finally {
      this.info = null;
      this.process = null;
      this.ownsProcess = false;
      try {
        if (fs.existsSync(this.infoFile)) fs.rmSync(this.infoFile, { force: true });
      } catch {}
    }
    await this.ensureStarted();
    if (restoreEventSubscription && eventCallback) void this.subscribe(eventCallback);
  }
}
