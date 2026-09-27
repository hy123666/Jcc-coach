import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRuntimeSqliteStore } from "../ui/electron/runtime-state-store.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeaders(token) {
  return { "x-jcc-runtime-token": token };
}

function waitForSseEvent(url, token, expectedType, trigger) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Timed out waiting for SSE event ${expectedType}`));
    }, 15000);
    fetch(url, { signal: controller.signal, headers: authHeaders(token) }).then(async (response) => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      await trigger();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes(`event: ${expectedType}`)) {
          clearTimeout(timeout);
          controller.abort();
          resolve(buffer);
          return;
        }
      }
    }).catch((error) => {
      if (error.name !== "AbortError") reject(error);
    });
  });
}

function decodeServerWebSocketFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    let length = buffer[offset + 1] & 0x7f;
    offset += 2;
    if (length === 126) {
      if (offset + 2 > buffer.length) break;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    if (offset + length > buffer.length) break;
    const payload = buffer.subarray(offset, offset + length);
    offset += length;
    if (opcode === 1) messages.push(payload.toString("utf8"));
  }
  return messages;
}

function waitForWebSocketEvent(ready, expectedType, trigger) {
  return new Promise((resolve, reject) => {
    const url = new URL(ready.url);
    const socket = net.createConnection(Number(url.port), url.hostname);
    const key = randomBytes(16).toString("base64");
    let upgraded = false;
    let frameBuffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for WebSocket event ${expectedType}`));
    }, 15000);
    socket.on("connect", () => {
      socket.write([
        `GET /ws?token=${ready.token} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "\r\n",
      ].join("\r\n"));
    });
    socket.on("data", async (chunk) => {
      if (!upgraded) {
        const text = chunk.toString("utf8");
        const split = text.indexOf("\r\n\r\n");
        if (split < 0) return;
        if (!text.startsWith("HTTP/1.1 101")) {
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error(`WebSocket upgrade failed: ${text.slice(0, 120)}`));
          return;
        }
        upgraded = true;
        frameBuffer = Buffer.concat([frameBuffer, chunk.subarray(split + 4)]);
        await trigger();
      } else {
        frameBuffer = Buffer.concat([frameBuffer, chunk]);
      }
      for (const message of decodeServerWebSocketFrames(frameBuffer)) {
        if (message.includes(`"type":"${expectedType}"`) || message.includes(`"type":"ready"`)) {
          if (expectedType === "ready" || message.includes(`"type":"${expectedType}"`)) {
            clearTimeout(timeout);
            socket.end();
            resolve(message);
            return;
          }
        }
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function spawnDaemon({ repoRoot, tempRoot, fingerprint = null }) {
  const env = {
    ...process.env,
    JCC_RUNTIME_DATA_DIR: tempRoot,
    JCC_RUNTIME_REPO_ROOT: repoRoot,
    JCC_RUNTIME_DAEMON_PORT: "0",
    JCC_UI_DISABLE_CODEX_EXEC: "1",
  };
  if (fingerprint !== null) env.JCC_RUNTIME_SOURCE_FINGERPRINT = fingerprint;
  else delete env.JCC_RUNTIME_SOURCE_FINGERPRINT;
  return spawn(process.execPath, ["ui/electron/runtime-daemon-server.js"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

const DAEMON_READY_TIMEOUT_MS = Number(process.env.JCC_TEST_DAEMON_READY_TIMEOUT_MS || 300000);

async function waitForReady(child, timeoutMs = DAEMON_READY_TIMEOUT_MS) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "jcc-runtime-daemon-ready") return parsed;
      } catch {}
    }
    if (child.exitCode !== null) throw new Error(`daemon exited early code=${child.exitCode} stderr=${stderr}`);
    await wait(100);
  }
  throw new Error(`daemon did not become ready; stderr=${stderr}`);
}

async function main() {
  const repoRoot = process.cwd();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-daemon-server-"));
  const expectedFingerprint = "verify-runtime-source-fingerprint";
  const seedStore = createRuntimeSqliteStore(repoRoot, { dataRoot: tempRoot });
  seedStore.open();
  seedStore.setJson("ui_runtime_state", {
    schema: "jcc-ui-runtime-state-v1",
    daily_session: { status: "active", mode: "daily_chat", generation: 1 },
    match_session: { status: "idle", match_session_id: null },
    response_task: { status: "idle", response_task_id: null, revision: 0 },
    response_task_revision: 0,
    rankings_status: {
      schema: "jcc-runtime-rankings-status-v1",
      status: "ready",
      stat_date: "20000101",
      snapshot_in_use: "stale-sqlite-ranking",
    },
  });
  seedStore.close();
  const child = await spawnDaemon({ repoRoot, tempRoot, fingerprint: expectedFingerprint });

  try {
    const ready = await waitForReady(child);
    assert(ready.url?.startsWith("http://127.0.0.1:"), "daemon ready payload must include local URL");
    assert(ready.websocket_url?.startsWith("ws://127.0.0.1:"), "daemon ready payload must include local WebSocket URL");
    assert(typeof ready.token === "string" && ready.token.length >= 32, "daemon ready payload must include auth token");
    assert(ready.sqlite_file === path.join(tempRoot, "app.sqlite"), "daemon must use runtime data dir sqlite");
    assert(ready.runtime_source_fingerprint === expectedFingerprint, "daemon ready payload must include runtime source fingerprint");

    const health = await readJson(await fetch(`${ready.url}/health`));
    assert(health.ok === true && health.contract === "jcc-runtime-daemon-v1", "daemon health failed");
    assert(health.runtime_source_fingerprint === expectedFingerprint, "daemon health must include runtime source fingerprint");
    assert(typeof health.runtime_source_fingerprint === "string" && health.runtime_source_fingerprint.length >= 12, "daemon health fingerprint must be non-empty");
    assert(!("sqlite_file" in health), "unauthenticated health must not expose sqlite path");

    const unauthorized = await fetch(`${ready.url}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "getState", payload: {} }),
    });
    assert(unauthorized.status === 401, "daemon action must require token auth");

    const action = await readJson(await fetch(`${ready.url}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ready.token) },
      body: JSON.stringify({ action: "getState", payload: {} }),
    }));
    assert(action.ok === true && action.state?.schema === "jcc-ui-runtime-state-v1", "daemon action getState failed");

    const state = await readJson(await fetch(`${ready.url}/state`, { headers: authHeaders(ready.token) }));
    assert(
      state.ok === true && state.state?.schema === "jcc-ui-runtime-state-v1",
      `daemon state failed: ${JSON.stringify(state)}`,
    );
    assert(
      state.state.rankings_status?.stat_date !== "20000101"
      && state.state.rankings_status?.snapshot_in_use !== "stale-sqlite-ranking",
      "daemon readiness must reconcile stale SQLite Ranking display state against the current Active pointer",
    );
    assert(
      state.state.response_task?.status === action.state.response_task?.status,
      "first read-only getState must already have the same default canonical state persisted in SQLite",
    );
    assert(Array.isArray(state.queue), "daemon state must include queue inspect data");
    assert(Array.isArray(state.logs), "daemon state must include structured logs");
    assert(Array.isArray(state.migrations) && state.migrations.length >= 3, "daemon state must include sqlite migrations");
    assert(state.daemon_health?.ok === true && state.daemon_health?.pid, "daemon state must expose sqlite-backed health");

    const queuedMessage = await readJson(await fetch(`${ready.url}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ready.token) },
      body: JSON.stringify({ action: "sendMessage", payload: { text: "查一下当前上分思路", mode: "daily_chat" } }),
    }));
    assert(queuedMessage.ok === true && queuedMessage.host_request?.request_id, "daemon sendMessage should create host request without live model in verifier");

    const queue = await readJson(await fetch(`${ready.url}/queue`, { headers: authHeaders(ready.token) }));
    assert(queue.ok === true && Array.isArray(queue.queue), "daemon queue endpoint failed");
    assert(queue.queue.some((item) => item.queue_name === "runtime_action_task" && item.status === "completed" && item.attempts >= 1), "daemon action should run through queue lifecycle");
    const queueItem = queue.queue.find((item) => item.queue_name === "host_request");
    assert(queueItem?.id, "daemon queue endpoint should expose persisted host_request item");
    const updated = await readJson(await fetch(`${ready.url}/queue/update`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ready.token) },
      body: JSON.stringify({ id: queueItem.id, status: "verified", patch: { verifier: "daemon-server" } }),
    }));
    assert(updated.ok === true && updated.item?.status === "verified", "daemon queue update endpoint failed");
    const logs = await readJson(await fetch(`${ready.url}/logs`, { headers: authHeaders(ready.token) }));
    assert(logs.ok === true && Array.isArray(logs.logs), "daemon logs endpoint failed");

    const sseText = await waitForSseEvent(`${ready.url}/events`, ready.token, "queue_item_updated", async () => {
      await fetch(`${ready.url}/queue/update`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(ready.token) },
        body: JSON.stringify({ id: queueItem.id, status: "verified_sse", patch: { verifier: "daemon-server-sse" } }),
      });
    });
    assert(sseText.includes("queue_item_updated"), "daemon SSE event stream did not emit queue update");

    const wsText = await waitForWebSocketEvent(ready, "ready", async () => {});
    assert(wsText.includes('"type":"ready"'), "daemon WebSocket event stream did not emit ready");

    const wsQueueText = await waitForWebSocketEvent(ready, "queue_item_updated", async () => {
      await fetch(`${ready.url}/queue/update`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(ready.token) },
        body: JSON.stringify({ id: queueItem.id, status: "verified_again", patch: { verifier: "daemon-server-ws" } }),
      });
    });
    assert(wsQueueText.includes("queue_item_updated"), "daemon WebSocket event stream did not emit queue update");

    const resetDaily = await readJson(await fetch(`${ready.url}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ready.token) },
      body: JSON.stringify({ action: "resetDailySession", payload: {} }),
    }));
    assert(resetDaily.ok === true, "daemon should reset the disabled-host daily generation before the queue-claim scenario");

    const claimable = await readJson(await fetch(`${ready.url}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ready.token) },
      body: JSON.stringify({ action: "sendMessage", payload: { text: "给我一套低费赌狗阵容", mode: "daily_chat" } }),
    }));
    assert(claimable.ok === true && claimable.host_request?.request_id, "daemon should create second host request for queue claim");
    const claimed = await readJson(await fetch(`${ready.url}/queue/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ready.token) },
      body: JSON.stringify({ queue_name: "host_request", worker_id: "verify-worker", lease_ms: 10 }),
    }));
    assert(claimed.ok === true && claimed.item?.status === "running" && claimed.item?.attempts >= 1, "daemon queue claim endpoint failed");
    const completed = await readJson(await fetch(`${ready.url}/queue/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ready.token) },
      body: JSON.stringify({
        id: claimed.item.id,
        patch: { verifier_completed: true },
        worker_id: claimed.item.locked_by,
        lease_token: claimed.item.lease_token,
        lease_generation: claimed.item.lease_generation,
      }),
    }));
    assert(completed.ok === true && completed.item?.status === "completed", "daemon queue complete endpoint failed");

    const resetBeforeRetry = await readJson(await fetch(`${ready.url}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ready.token) },
      body: JSON.stringify({ action: "resetDailySession", payload: {} }),
    }));
    assert(resetBeforeRetry.ok === true, "daemon should reset the disabled-host daily generation before the queue-retry scenario");

    const retrySource = await readJson(await fetch(`${ready.url}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ready.token) },
      body: JSON.stringify({ action: "sendMessage", payload: { text: "再查一下斗士转", mode: "daily_chat" } }),
    }));
    assert(retrySource.ok === true && retrySource.host_request?.request_id, "daemon should create third host request for queue retry");
    const retryClaim = await readJson(await fetch(`${ready.url}/queue/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ready.token) },
      body: JSON.stringify({ queue_name: "host_request", worker_id: "verify-retry-worker", lease_ms: 1 }),
    }));
    assert(retryClaim.ok === true && retryClaim.item?.status === "running", "daemon retry queue claim failed");
    const failed = await readJson(await fetch(`${ready.url}/queue/fail`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ready.token) },
      body: JSON.stringify({
        id: retryClaim.item.id,
        error: { code: "VERIFY_FAIL" },
        retry_delay_ms: 0,
        worker_id: retryClaim.item.locked_by,
        lease_token: retryClaim.item.lease_token,
        lease_generation: retryClaim.item.lease_generation,
      }),
    }));
    assert(failed.ok === true && failed.item?.status === "retry", "daemon queue fail should schedule retry before max attempts");
    const staleClaim = await readJson(await fetch(`${ready.url}/queue/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ready.token) },
      body: JSON.stringify({ queue_name: "host_request", worker_id: "verify-stale-worker", lease_ms: 1 }),
    }));
    assert(staleClaim.ok === true && staleClaim.item?.status === "running", "daemon stale queue claim failed");
    const recovered = await readJson(await fetch(`${ready.url}/queue/recover-stale`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ready.token) },
      body: JSON.stringify({ stale_ms: 0, limit: 10 }),
    }));
    assert(recovered.ok === true && recovered.recovered?.some((item) => item.id === staleClaim.item.id), "daemon stale queue recovery endpoint failed");

    const startedMatch = await readJson(await fetch(`${ready.url}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ready.token) },
      body: JSON.stringify({ action: "startMatch", payload: {} }),
    }));
    assert(
      startedMatch.match_created === true
        && startedMatch.state?.match_session?.status === "active"
        && startedMatch.host_ready === false
        && startedMatch.status === "host_warmup_failed",
      `daemon startMatch failed: ${JSON.stringify(startedMatch)}`,
    );
    assert(
      !["preparing", "running", "response_pending", "awaiting_host_cli_agent_response"].includes(startedMatch.state?.response_task?.status),
      `Start Match must cancel an active lobby answer instead of carrying it into the new match: ${JSON.stringify(startedMatch.state?.response_task)}`,
    );
    const modeResult = await readJson(await fetch(`${ready.url}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ready.token) },
      body: JSON.stringify({ action: "setMode", payload: { mode: "augment" } }),
    }));
    assert(
      modeResult.ok === true && modeResult.status === "mode_set_choice_ready_for_user_report",
      `daemon setMode augment must wait for the current-match user report: ${JSON.stringify(modeResult)}`,
    );
    const visualQueue = await readJson(await fetch(`${ready.url}/queue?queue_name=visual_request`, { headers: authHeaders(ready.token) }));
    if (!(visualQueue.ok === true && !visualQueue.queue?.some((item) => item.payload?.mode === "augment_choice" && item.payload?.request_id))) {
      throw new Error(`daemon setMode augment must not enqueue stale visual refresh work; got=${JSON.stringify(visualQueue.queue, null, 2)}`);
    }

    const rejected = await fetch(`${ready.url}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ready.token) },
      body: JSON.stringify({ action: "closeWindow", payload: {} }),
    });
    assert(rejected.status === 400, "window actions must be rejected by daemon");

    const unauthorizedShutdown = await fetch(`${ready.url}/shutdown`, { method: "POST" });
    assert(unauthorizedShutdown.status === 401, "daemon shutdown must require token auth");

    await fetch(`${ready.url}/shutdown`, { method: "POST", headers: authHeaders(ready.token) });
    const startedWait = Date.now();
    while (child.exitCode === null && Date.now() - startedWait < 3000) await wait(100);

    const fallbackRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-daemon-server-fingerprint-"));
    const fallbackChild = await spawnDaemon({ repoRoot, tempRoot: fallbackRoot, fingerprint: null });
    try {
      const fallbackReady = await waitForReady(fallbackChild);
      assert(typeof fallbackReady.runtime_source_fingerprint === "string" && fallbackReady.runtime_source_fingerprint.length >= 12, "daemon must compute fingerprint when env override is absent");
      const fallbackHealth = await readJson(await fetch(`${fallbackReady.url}/health`));
      assert(fallbackHealth.runtime_source_fingerprint === fallbackReady.runtime_source_fingerprint, "fallback health must echo computed runtime source fingerprint");
      await fetch(`${fallbackReady.url}/shutdown`, { method: "POST", headers: authHeaders(fallbackReady.token) });
      const fallbackWait = Date.now();
      while (fallbackChild.exitCode === null && Date.now() - fallbackWait < 3000) await wait(100);
    } finally {
      if (fallbackChild.exitCode === null) fallbackChild.kill();
      await rm(fallbackRoot, { recursive: true, force: true }).catch(() => {});
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      checked: ["os-daemon-process", "http-health", "token-auth", "runtime-source-fingerprint", "runtime-source-fingerprint-fallback", "http-action", "http-state", "ready-after-active-ranking-reconciliation", "queue-inspect", "queue-update", "queue-claim-complete-fail-recover", "structured-logs", "sse-events", "websocket-events", "mode-visual-refresh-sqlite-queue", "window-action-rejection"],
      url: ready.url,
    }, null, 2)}\n`);
  } finally {
    if (child.exitCode === null) child.kill();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await rm(tempRoot, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 9) throw error;
        await wait(200);
      }
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
