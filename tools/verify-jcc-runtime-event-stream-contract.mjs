import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { RuntimeDaemonClient } from "../ui/electron/runtime-daemon-client.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await wait(20);
  }
  throw new Error(message);
}

function authHeaders(token) {
  return { "x-jcc-runtime-token": token };
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function spawnDaemon(repoRoot, tempRoot) {
  return spawn(process.execPath, ["ui/electron/runtime-daemon-server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      JCC_RUNTIME_DATA_DIR: tempRoot,
      JCC_RUNTIME_REPO_ROOT: repoRoot,
      JCC_RUNTIME_DAEMON_PORT: "0",
      JCC_UI_DISABLE_CODEX_EXEC: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

const DAEMON_READY_TIMEOUT_MS = Number(process.env.JCC_TEST_DAEMON_READY_TIMEOUT_MS || 300000);

async function waitForDaemonReady(child, timeoutMs = DAEMON_READY_TIMEOUT_MS) {
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
    if (child.exitCode !== null) {
      throw new Error(`daemon exited before ready: code=${child.exitCode} stderr=${stderr}`);
    }
    await wait(50);
  }
  throw new Error(`daemon did not become ready: stderr=${stderr}`);
}

async function waitForChildExit(child, timeoutMs = DAEMON_READY_TIMEOUT_MS) {
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  try {
    await waitFor(() => child.exitCode !== null, "child process did not exit", timeoutMs);
  } catch (error) {
    if (child.exitCode === null) child.kill();
    throw error;
  }
  return { code: child.exitCode, stderr };
}

function parseSseChunk(chunk) {
  const eventLine = chunk.split(/\r?\n/).find((line) => line.startsWith("event: "));
  const idLine = chunk.split(/\r?\n/).find((line) => line.startsWith("id: "));
  const dataLines = chunk.split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
  if (!dataLines.length) return null;
  return {
    event: eventLine?.slice(7) || null,
    id: idLine ? Number(idLine.slice(4)) : null,
    data: JSON.parse(dataLines.join("\n")),
  };
}

async function readSseUntil(url, token, predicate, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: authHeaders(token), signal: controller.signal });
    assert(response.ok, `SSE request failed: HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const chunk = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = parseSseChunk(chunk);
        if (!parsed) continue;
        events.push(parsed);
        if (predicate(parsed, events)) {
          controller.abort();
          return events;
        }
      }
    }
    throw new Error("SSE stream ended before expected event");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
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
    if (opcode === 1) messages.push(JSON.parse(payload.toString("utf8")));
  }
  return messages;
}

async function readWebSocketReplay(ready, since = 0, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const daemonUrl = new URL(ready.url);
    const socket = net.createConnection(Number(daemonUrl.port), daemonUrl.hostname);
    const key = randomBytes(16).toString("base64");
    let upgraded = false;
    let frameBuffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for WebSocket replay"));
    }, timeoutMs);
    socket.on("connect", () => {
      socket.write([
        `GET /ws?token=${ready.token}&since=${since} HTTP/1.1`,
        `Host: ${daemonUrl.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "\r\n",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      if (!upgraded) {
        const separator = chunk.indexOf("\r\n\r\n");
        if (separator < 0) return;
        const headers = chunk.subarray(0, separator).toString("utf8");
        if (!headers.startsWith("HTTP/1.1 101")) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(`WebSocket upgrade failed: ${headers.slice(0, 120)}`));
          return;
        }
        upgraded = true;
        frameBuffer = Buffer.concat([frameBuffer, chunk.subarray(separator + 4)]);
      } else {
        frameBuffer = Buffer.concat([frameBuffer, chunk]);
      }
      const messages = decodeServerWebSocketFrames(frameBuffer);
      if (messages.some((event) => event.type === "runtime_action_completed")) {
        clearTimeout(timer);
        socket.end();
        resolve(messages);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function writeFakeSse(response, event) {
  response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

async function verifyClientReconnect(repoRoot) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-event-client-"));
  const connections = [];
  const openResponses = new Set();
  let nextSequence = 1;
  const fakeServer = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/shutdown") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"ok\":true}\n");
      return;
    }
    if (request.method !== "GET" || url.pathname !== "/events") {
      response.writeHead(404);
      response.end();
      return;
    }
    const since = Number(url.searchParams.get("since") || 0);
    const lastEventId = Number(request.headers["last-event-id"] || 0);
    connections.push({
      since,
      lastEventId,
      hasSince: url.searchParams.has("since"),
      hasLastEventId: request.headers["last-event-id"] !== undefined,
    });
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    openResponses.add(response);
    request.on("close", () => openResponses.delete(response));
    const sequence = nextSequence;
    nextSequence += 1;
    writeFakeSse(response, {
      schema: "jcc-runtime-daemon-event-v1",
      type: "response_task_changed",
      payload: { sequence },
      sequence,
      event_id: sequence,
      observed_at: new Date().toISOString(),
    });
    if (connections.length === 1) setTimeout(() => response.destroy(), 30);
  });
  await new Promise((resolve) => fakeServer.listen(0, "127.0.0.1", resolve));
  const address = fakeServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new RuntimeDaemonClient({
    repoRoot,
    electronDir: path.resolve(repoRoot, "ui/electron"),
    env: {
      ...process.env,
      JCC_RUNTIME_DATA_DIR: tempRoot,
      JCC_RUNTIME_EVENT_RECONNECT_MS: "20",
    },
    log: () => {},
  });
  const info = { url: baseUrl, token: "verify-token", websocket_url: null };
  client.ensureStarted = async () => {
    client.info = info;
    return client;
  };
  client.info = info;
  const events = [];
  const onEvent = (event) => events.push(event);
  try {
    void client.subscribe(onEvent);
    await waitFor(
      () => events.some((event) => event.type === "daemon_reconnected")
        && events.some((event) => event.sequence === 2),
      "client did not reconnect and continue from the last sequence",
    );
    assert(connections[0].since === 0, "first client connection must start at sequence 0");
    assert(!connections[0].hasSince && !connections[0].hasLastEventId, "first client connection must start live instead of replaying all history");
    assert(connections[1].since === 1, `reconnect must request since=1, got ${connections[1].since}`);
    assert(connections[1].lastEventId === 1, "SSE reconnect must send Last-Event-ID=1");

    client.stopEvents();
    const stoppedConnectionCount = connections.length;
    await wait(120);
    assert(connections.length === stoppedConnectionCount, "stopEvents must prevent reconnect attempts");

    void client.subscribe(onEvent);
    await waitFor(() => events.some((event) => event.sequence === 3), "subscribe after stop did not restart event delivery");
    assert(connections[2].since === 2, `resubscribe must continue from since=2, got ${connections[2].since}`);

    await client.restart();
    await waitFor(
      () => events.some((event) => event.sequence === 4),
      "daemon restart did not restore the active event subscription",
    );
    assert(connections[3].since === 3, `restart must resume from since=3, got ${connections[3].since}`);
    assert(
      events.filter((event) => event.type === "daemon_reconnected").length >= 2,
      "client must notify UI after stream reconnect and daemon restart",
    );
  } finally {
    client.stopEvents();
    for (const response of openResponses) response.destroy();
    await new Promise((resolve) => fakeServer.close(resolve));
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function verifyClientWebSocketReconnect(repoRoot) {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
      sockets.push(this);
      const sequence = sockets.length;
      setTimeout(() => {
        if (this.closed) return;
        this.emit("open", {});
        this.emit("message", {
          data: JSON.stringify({
            schema: "jcc-runtime-daemon-event-v1",
            type: "response_task_changed",
            payload: { sequence },
            sequence,
            event_id: sequence,
            observed_at: new Date().toISOString(),
          }),
        });
        if (sequence === 1) setTimeout(() => this.close(), 20);
      }, 5);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit("close", {});
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  const client = new RuntimeDaemonClient({
    repoRoot,
    electronDir: path.resolve(repoRoot, "ui/electron"),
    env: { ...process.env, JCC_RUNTIME_EVENT_RECONNECT_MS: "20" },
    log: () => {},
  });
  const info = {
    url: "http://127.0.0.1:1",
    token: "websocket-token",
    websocket_url: "ws://127.0.0.1:1/ws?token=websocket-token",
  };
  client.info = info;
  client.ensureStarted = async () => {
    client.info = info;
    return client;
  };
  const events = [];
  try {
    void client.subscribe((event) => events.push(event));
    await waitFor(
      () => events.some((event) => event.type === "daemon_reconnected")
        && events.some((event) => event.sequence === 2),
      "WebSocket client did not reconnect from its last durable sequence",
    );
    const firstUrl = new URL(sockets[0].url);
    const secondUrl = new URL(sockets[1].url);
    assert(!firstUrl.searchParams.has("since"), "first WebSocket connection must start live without replaying all history");
    assert(secondUrl.searchParams.get("since") === "1", `WebSocket reconnect must request since=1, got ${secondUrl}`);
    client.stopEvents();
    const stoppedSocketCount = sockets.length;
    await wait(100);
    assert(sockets.length === stoppedSocketCount, "stopEvents must stop the WebSocket reconnect loop");
  } finally {
    client.stopEvents();
    globalThis.WebSocket = originalWebSocket;
  }
}

async function verifyIncompatibleDaemonRetirementFailsClosed(repoRoot) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-retire-fail-closed-"));
  let shutdownRequests = 0;
  let shutdownToken = null;
  const fakeDaemon = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${JSON.stringify({
        ok: true,
        runtime_source_fingerprint: "incompatible-runtime-source",
        host_cli_exec_disabled: false,
      })}\n`);
      return;
    }
    if (request.method === "POST" && request.url === "/shutdown") {
      shutdownRequests += 1;
      shutdownToken = request.headers["x-jcc-runtime-token"] || null;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"ok\":true}\n");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => fakeDaemon.listen(0, "127.0.0.1", resolve));
  const address = fakeDaemon.address();
  const info = {
    url: `http://127.0.0.1:${address.port}`,
    token: "retire-token",
    pid: process.pid,
    runtime_source_fingerprint: "incompatible-runtime-source",
    host_cli_exec_disabled: false,
  };
  const emptyElectronDir = path.join(tempRoot, "empty-electron");
  await mkdir(emptyElectronDir, { recursive: true });
  const client = new RuntimeDaemonClient({
    repoRoot,
    electronDir: emptyElectronDir,
    env: {
      ...process.env,
      JCC_RUNTIME_DATA_DIR: tempRoot,
      JCC_RUNTIME_DAEMON_RETIRE_TIMEOUT_MS: "250",
    },
    log: () => {},
  });
  await mkdir(path.dirname(client.infoFile), { recursive: true });
  await writeFile(client.infoFile, `${JSON.stringify(info, null, 2)}\n`, "utf8");
  let failure = null;
  try {
    await client.ensureStarted();
  } catch (error) {
    failure = error;
  } finally {
    await new Promise((resolve) => fakeDaemon.close(resolve));
  }
  assert(failure?.code === "JCC_RUNTIME_DAEMON_RETIRE_FAILED", "retirement failure must fail closed with an explicit error");
  assert(shutdownRequests === 1, `client must request authenticated shutdown exactly once, got ${shutdownRequests}`);
  assert(shutdownToken === info.token, "client must carry the daemon token when retiring a non-owned daemon");
  assert(client.process === null, "client must not spawn a replacement after retirement cannot be confirmed");
  assert(existsSync(client.infoFile), "client must not delete daemon-info when retirement cannot be confirmed");
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

async function main() {
  const repoRoot = process.cwd();
  const serverSource = await readFile("ui/electron/runtime-daemon-server.js", "utf8");
  const clientSource = await readFile("ui/electron/runtime-daemon-client.js", "utf8");
  assert(serverSource.includes("daemon.onRuntimeEvent"), "server must subscribe to committed daemon runtime events");
  assert(serverSource.includes("listEventsAfter"), "server must replay committed events from durable storage");
  const sseRoute = serverSource.slice(
    serverSource.indexOf('url.pathname === "/events"'),
    serverSource.indexOf('url.pathname === "/action"'),
  );
  assert(
    sseRoute.indexOf("clients.set(response, since)") < sseRoute.indexOf("listReplayEvents(since)"),
    "SSE must register its durable cursor before replay so commits cannot fall between replay and subscription",
  );
  const websocketUpgrade = serverSource.slice(serverSource.indexOf('server.on("upgrade"'));
  assert(
    websocketUpgrade.indexOf("webSocketClients.set(socket, since)") < websocketUpgrade.indexOf("listReplayEvents(since)"),
    "WebSocket must register its durable cursor before replay so commits cannot fall between replay and subscription",
  );
  assert(!serverSource.includes('appendEvent("daemon_stream_event"'), "server must not wrap durable events in a second daemon_stream_event row");
  assert(serverSource.includes("event_id"), "server wire events must expose event_id");
  assert(serverSource.includes("sequence"), "server wire events must expose monotonic sequence");
  assert(clientSource.includes("lastEventSequence"), "client must retain the last delivered durable event sequence");
  assert(clientSource.includes("daemon_reconnected"), "client must notify UI after reconnecting");
  assert(clientSource.includes("JCC_RUNTIME_EVENT_RECONNECT_MS"), "client reconnect delay must be testable and configurable");
  assert(clientSource.includes("JCC_RUNTIME_DAEMON_RETIRE_FAILED"), "client must fail closed when non-owned daemon retirement cannot be confirmed");
  assert(serverSource.includes("writer-lease.json"), "server must acquire a runtime-data writer lease before opening SQLite");
  assert(serverSource.includes('"runtime-writer-lease.js"'), "server fingerprint must include the shared writer-lease identity module");
  assert(clientSource.includes('"runtime-writer-lease.js"'), "client fingerprint must include the shared writer-lease identity module");

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-event-server-"));
  const child = await spawnDaemon(repoRoot, tempRoot);
  try {
    const ready = await waitForDaemonReady(child);
    const competingChild = await spawnDaemon(repoRoot, tempRoot);
    const competingExit = await waitForChildExit(competingChild);
    assert(competingExit.code !== 0, "second daemon using the same runtime-data root must be rejected");
    assert(
      competingExit.stderr.includes("JCC_RUNTIME_WRITER_LEASE_HELD"),
      `second daemon rejection must identify the active writer lease, stderr=${competingExit.stderr}`,
    );
    for (let index = 0; index < 2; index += 1) {
      const result = await readJson(await fetch(`${ready.url}/action`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(ready.token) },
        body: JSON.stringify({ action: "getState", payload: {} }),
      }));
      assert(result?.ok === true, "daemon getState action failed while seeding event history");
    }
    const messageResult = await readJson(await fetch(`${ready.url}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ready.token) },
      body: JSON.stringify({ action: "sendMessage", payload: { mode: "daily_chat", text: "verify committed response task event" } }),
    }));
    assert(messageResult?.ok === true, "daemon sendMessage failed while seeding response_task_changed history");

    const replay = await readSseUntil(
      `${ready.url}/events?since=0`,
      ready.token,
      (event, events) => event.data?.type === "runtime_action_completed"
        && events.some((entry) => entry.data?.type === "response_task_changed"),
    );
    const durableSseEvents = replay.filter((event) => event.data?.type !== "ready");
    assert(durableSseEvents.length > 0, "SSE must replay events committed before connection");
    for (const event of durableSseEvents) {
      assert(Number.isInteger(event.id) && event.id > 0, "SSE durable event must carry an id field");
      assert(event.data.sequence === event.id, "SSE sequence must equal durable event id");
      assert(event.data.event_id === event.id, "SSE event_id must equal durable event id");
    }
    const sseSequences = durableSseEvents.map((event) => event.data.sequence);
    assert(sseSequences.every((value, index) => index === 0 || value > sseSequences[index - 1]), "SSE replay sequences must be strictly increasing");
    assert(
      durableSseEvents.some((event) => event.data.type === "response_task_changed"),
      "server must broadcast daemon.onRuntimeEvent response_task_changed only after its committed row is replayable",
    );

    const wsReplay = await readWebSocketReplay(ready, 0);
    const durableWsEvents = wsReplay.filter((event) => event.type !== "ready");
    assert(durableWsEvents.length > 0, "WebSocket must replay committed events from since=0");
    assert(
      durableWsEvents.every((event) => Number.isInteger(event.sequence) && event.sequence === event.event_id),
      "WebSocket durable events must carry matching sequence/event_id",
    );
    const wsSequences = durableWsEvents.map((event) => event.sequence);
    assert(wsSequences.every((value, index) => index === 0 || value > wsSequences[index - 1]), "WebSocket replay sequences must be strictly increasing");

    await fetch(`${ready.url}/shutdown`, { method: "POST", headers: authHeaders(ready.token) });
    await waitFor(() => child.exitCode !== null, "daemon did not stop after verifier shutdown", 10000);
    const writerLeaseFile = path.join(tempRoot, "runtime-daemon", "writer-lease.json");
    assert(!existsSync(writerLeaseFile), "clean daemon shutdown must release the runtime-data writer lease");

    await mkdir(path.dirname(writerLeaseFile), { recursive: true });
    await writeFile(writerLeaseFile, `${JSON.stringify({
      schema: "jcc-runtime-writer-lease-v1",
      lease_id: "stale-verifier-lease",
      pid: 2147483647,
      acquired_at: "2000-01-01T00:00:00.000Z",
    })}\n`, "utf8");
    const staleRecoveryChild = await spawnDaemon(repoRoot, tempRoot);
    try {
      const staleRecoveryReady = await waitForDaemonReady(staleRecoveryChild);
      assert(staleRecoveryReady.url, "daemon must recover a writer lease whose owner PID no longer exists");
      await fetch(`${staleRecoveryReady.url}/shutdown`, {
        method: "POST",
        headers: authHeaders(staleRecoveryReady.token),
      });
      await waitFor(() => staleRecoveryChild.exitCode !== null, "stale-lease recovery daemon did not stop", 10000);
    } finally {
      if (staleRecoveryChild.exitCode === null) staleRecoveryChild.kill();
    }

    await writeFile(writerLeaseFile, `${JSON.stringify({
      schema: "jcc-runtime-writer-lease-v1",
      lease_id: "reused-pid-verifier-lease",
      pid: process.pid,
      acquired_at: "2000-01-01T00:00:00.000Z",
    })}\n`, "utf8");
    const reusedPidRecoveryChild = await spawnDaemon(repoRoot, tempRoot);
    try {
      const reusedPidRecoveryReady = await waitForDaemonReady(reusedPidRecoveryChild);
      assert(reusedPidRecoveryReady.url, "daemon must recover a writer lease whose PID has been reused by a newer process");
      await fetch(`${reusedPidRecoveryReady.url}/shutdown`, {
        method: "POST",
        headers: authHeaders(reusedPidRecoveryReady.token),
      });
      await waitFor(() => reusedPidRecoveryChild.exitCode !== null, "reused-pid recovery daemon did not stop", 10000);
    } finally {
      if (reusedPidRecoveryChild.exitCode === null) reusedPidRecoveryChild.kill();
    }
  } finally {
    if (child.exitCode === null) child.kill();
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }

  await verifyClientReconnect(repoRoot);
  await verifyClientWebSocketReconnect(repoRoot);
  await verifyIncompatibleDaemonRetirementFailsClosed(repoRoot);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked: [
      "post-commit-daemon-event-subscription",
      "sse-durable-since-replay",
      "websocket-durable-since-replay",
      "monotonic-sequence-and-event-id",
      "client-since-reconnect",
      "client-websocket-since-reconnect",
      "daemon-reconnected-ui-event",
      "stop-events-terminates-loop",
      "resubscribe-after-stop",
      "restart-restores-subscription",
      "non-owned-incompatible-daemon-retirement-fail-closed",
      "runtime-data-exclusive-writer-lease",
      "stale-writer-lease-pid-recovery",
      "stale-writer-lease-reused-pid-recovery",
    ],
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
