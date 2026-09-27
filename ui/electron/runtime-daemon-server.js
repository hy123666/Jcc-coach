import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JccRuntimeDaemon, runtimeDaemonContract } from "./runtime-daemon.js";
import { createRuntimePaths } from "./runtime-state-store.js";
import { currentProcessIdentity, inspectWriterLeaseOwner } from "./runtime-writer-lease.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(process.env.JCC_RUNTIME_REPO_ROOT || path.join(__dirname, "../.."));
const host = process.env.JCC_RUNTIME_DAEMON_HOST || "127.0.0.1";
const requestedPort = Number(process.env.JCC_RUNTIME_DAEMON_PORT || 0);
const runtimePaths = createRuntimePaths(repoRoot);
const daemonInfoFile = path.join(runtimePaths.runtimeDataRoot, "runtime-daemon", "daemon-info.json");
const daemonToken = process.env.JCC_RUNTIME_DAEMON_TOKEN || randomBytes(32).toString("hex");

const DAEMON_SOURCE_FILES = [
  "runtime-daemon-server.js",
  "runtime-daemon.js",
  "runtime-daemon-client.js",
  "runtime-service.js",
  "runtime-state-store.js",
  "host-adapters.js",
  "runtime-writer-lease.js",
];

function computeRuntimeSourceFingerprint() {
  const hash = createHash("sha256");
  for (const file of DAEMON_SOURCE_FILES) {
    const fullPath = path.join(__dirname, file);
    hash.update(file);
    hash.update("\0");
    hash.update(existsSync(fullPath) ? readFileSync(fullPath) : "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

const runtimeSourceFingerprint = process.env.JCC_RUNTIME_SOURCE_FINGERPRINT || computeRuntimeSourceFingerprint();

const writerLeaseFile = path.join(runtimePaths.runtimeDataRoot, "runtime-daemon", "writer-lease.json");

function readWriterLease() {
  try {
    return JSON.parse(readFileSync(writerLeaseFile, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function writerLeaseError(message, owner = null, cause = null) {
  const error = new Error(message);
  error.code = "JCC_RUNTIME_WRITER_LEASE_HELD";
  error.owner = owner;
  if (cause) error.cause = cause;
  return error;
}

function acquireWriterLease() {
  mkdirSync(path.dirname(writerLeaseFile), { recursive: true });
  const processIdentity = currentProcessIdentity();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let fileDescriptor = null;
    const lease = {
      schema: "jcc-runtime-writer-lease-v1",
      lease_id: randomBytes(16).toString("hex"),
      pid: process.pid,
      repo_root: repoRoot,
      sqlite_file: runtimePaths.sqliteFile,
      runtime_source_fingerprint: runtimeSourceFingerprint,
      process_started_at: processIdentity.started_at,
      process_executable_path: processIdentity.executable_path,
      acquired_at: new Date().toISOString(),
    };
    try {
      fileDescriptor = openSync(writerLeaseFile, "wx");
      writeFileSync(fileDescriptor, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
      closeSync(fileDescriptor);
      return lease;
    } catch (error) {
      if (fileDescriptor !== null) {
        try {
          closeSync(fileDescriptor);
        } catch {}
      }
      if (error?.code !== "EEXIST") {
        try {
          const current = readWriterLease();
          if (current?.lease_id === lease.lease_id) rmSync(writerLeaseFile, { force: true });
        } catch {}
        throw error;
      }
      const owner = readWriterLease();
      if (!Number.isInteger(Number(owner?.pid)) || Number(owner.pid) <= 0) {
        throw writerLeaseError("JCC runtime writer lease exists but has no verifiable owner PID; refusing unsafe takeover", owner);
      }
      const ownerStatus = inspectWriterLeaseOwner(owner);
      if (ownerStatus.status === "active") {
        throw writerLeaseError(`JCC runtime writer lease is held by active PID ${owner.pid}`, owner);
      }
      if (ownerStatus.status === "unverifiable") {
        throw writerLeaseError(`JCC runtime writer lease owner PID ${owner.pid} could not be verified safely`, owner);
      }
      try {
        rmSync(writerLeaseFile, { force: true });
      } catch (removeError) {
        throw writerLeaseError(`Could not remove stale JCC runtime writer lease for PID ${owner.pid}`, owner, removeError);
      }
    }
  }
  throw writerLeaseError("Could not acquire JCC runtime writer lease after stale-owner recovery");
}

function releaseWriterLease(lease) {
  if (!lease) return;
  try {
    const owner = readWriterLease();
    if (owner?.pid === process.pid && owner?.lease_id === lease.lease_id) {
      rmSync(writerLeaseFile, { force: true });
    }
  } catch {}
}

let writerLease = null;
try {
  writerLease = acquireWriterLease();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    type: "jcc-runtime-daemon-start-failed",
    code: error?.code || "JCC_RUNTIME_WRITER_LEASE_FAILED",
    error: error?.message || String(error),
    owner: error?.owner || null,
  })}\n`);
  process.exit(73);
}

const daemon = new JccRuntimeDaemon({ repoRoot }).start();
await daemon.reconcileDerivedStateOnStart();
const clients = new Map();
const webSocketClients = new Map();
const EVENT_REPLAY_BATCH_SIZE = 500;

function daemonHealthPayload() {
  return {
    ok: true,
    schema: "jcc-runtime-daemon-health-v1",
    contract: runtimeDaemonContract.schema,
    host_cli_exec_disabled: process.env.JCC_UI_DISABLE_CODEX_EXEC === "1",
    runtime_source_fingerprint: runtimeSourceFingerprint,
    pid: process.pid,
    checked_at: new Date().toISOString(),
  };
}

daemon.store.setJson("runtime_daemon_health", daemonHealthPayload());

function writeJson(response, statusCode, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    connection: "close",
  });
  response.end(body);
}

function parseEventPayload(payload) {
  if (typeof payload !== "string") return payload && typeof payload === "object" ? payload : {};
  try {
    return JSON.parse(payload);
  } catch {
    return { raw: payload };
  }
}

function normalizeCommittedEvent(value) {
  const committed = value?.event && typeof value.event === "object" ? value.event : value;
  const sequence = Number(committed?.sequence ?? committed?.event_id ?? committed?.id);
  const type = committed?.event_type || committed?.type;
  if (!Number.isInteger(sequence) || sequence <= 0 || !type) return null;
  return {
    schema: "jcc-runtime-daemon-event-v1",
    type,
    payload: parseEventPayload(committed.payload),
    sequence,
    event_id: sequence,
    observed_at: committed.created_at || committed.observed_at || new Date().toISOString(),
  };
}

function readyEvent(sequence, transport) {
  const cursor = Math.max(0, Number(sequence) || 0);
  return {
    schema: "jcc-runtime-daemon-event-v1",
    type: "ready",
    payload: { ok: true, pid: process.pid, transport },
    sequence: cursor,
    event_id: cursor,
    observed_at: new Date().toISOString(),
  };
}

function writeSseEvent(response, event) {
  response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function writeWebSocketEvent(socket, event) {
  socket.write(encodeWebSocketFrame(JSON.stringify(event)));
}

function broadcastCommittedEvent(value) {
  const committedEvent = normalizeCommittedEvent(value);
  if (!committedEvent) return false;
  const cursors = [...clients.values(), ...webSocketClients.values()];
  if (!cursors.length) return true;
  const pendingEvents = listReplayEvents(Math.min(...cursors));
  for (const [client, cursor] of clients) {
    for (const event of pendingEvents) {
      if (event.sequence <= (clients.get(client) ?? cursor)) continue;
      try {
        writeSseEvent(client, event);
        clients.set(client, event.sequence);
      } catch {
        clients.delete(client);
        client.destroy?.();
        break;
      }
    }
  }
  for (const [socket, cursor] of webSocketClients) {
    if (socket.destroyed) {
      webSocketClients.delete(socket);
      continue;
    }
    for (const event of pendingEvents) {
      if (event.sequence <= (webSocketClients.get(socket) ?? cursor)) continue;
      try {
        writeWebSocketEvent(socket, event);
        webSocketClients.set(socket, event.sequence);
      } catch {
        webSocketClients.delete(socket);
        socket.destroy();
        break;
      }
    }
  }
  return true;
}

function emitEvent(type, payload = {}) {
  const committed = daemon.store.appendEvent(type, payload);
  broadcastCommittedEvent(committed);
  return committed;
}

function latestCommittedSequence() {
  const latest = daemon.store.listRecentEvents(1)?.[0];
  return Math.max(0, Number(latest?.sequence ?? latest?.id) || 0);
}

function requestedEventCursor(url, request) {
  if (url.searchParams.has("since")) {
    const querySince = Number(url.searchParams.get("since"));
    if (Number.isInteger(querySince) && querySince >= 0) return { sequence: querySince, replay: true };
  }
  if (request.headers["last-event-id"] !== undefined) {
    const headerSince = Number(request.headers["last-event-id"]);
    if (Number.isInteger(headerSince) && headerSince >= 0) return { sequence: headerSince, replay: true };
  }
  return { sequence: latestCommittedSequence(), replay: false };
}

function listReplayEvents(afterSequence) {
  const events = [];
  let cursor = Math.max(0, Number(afterSequence) || 0);
  while (true) {
    const rows = daemon.store.listEventsAfter(cursor, EVENT_REPLAY_BATCH_SIZE) || [];
    const batch = rows
      .map((row) => normalizeCommittedEvent(row))
      .filter((event) => event && event.sequence > cursor)
      .sort((left, right) => left.sequence - right.sequence);
    if (!batch.length) break;
    events.push(...batch);
    const nextCursor = batch[batch.length - 1].sequence;
    if (nextCursor <= cursor) break;
    cursor = nextCursor;
    if (rows.length < EVENT_REPLAY_BATCH_SIZE) break;
  }
  return events;
}

const unsubscribeDaemonRuntimeEvents = typeof daemon.onRuntimeEvent === "function"
  ? daemon.onRuntimeEvent((event) => broadcastCommittedEvent(event))
  : () => {};

async function readRequestJson(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function isAuthorized(request) {
  const headerToken = request.headers["x-jcc-runtime-token"];
  const bearer = request.headers.authorization || "";
  return headerToken === daemonToken || bearer === `Bearer ${daemonToken}`;
}

function requireAuth(request, response) {
  if (isAuthorized(request)) return true;
  writeJson(response, 401, { ok: false, error: "Unauthorized" });
  return false;
}

function writeDaemonInfo(port) {
  mkdirSync(path.dirname(daemonInfoFile), { recursive: true });
  const info = {
    schema: "jcc-runtime-daemon-info-v1",
    pid: process.pid,
    token: daemonToken,
    host,
    port,
    url: `http://${host}:${port}`,
    websocket_url: `ws://${host}:${port}/ws?token=${daemonToken}`,
    repo_root: repoRoot,
    sqlite_file: daemon.store.paths.sqliteFile,
    contract: runtimeDaemonContract.schema,
    host_cli_exec_disabled: process.env.JCC_UI_DISABLE_CODEX_EXEC === "1",
    runtime_source_fingerprint: runtimeSourceFingerprint,
    started_at: new Date().toISOString(),
  };
  writeFileSync(daemonInfoFile, `${JSON.stringify(info, null, 2)}\n`, "utf8");
  return info;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${host}`);
    if (request.method === "GET" && url.pathname === "/health") {
      const health = daemonHealthPayload();
      daemon.store.setJson("runtime_daemon_health", health);
      writeJson(response, 200, health);
      return;
    }
    if (request.method === "GET" && url.pathname === "/state") {
      if (!requireAuth(request, response)) return;
      writeJson(response, 200, {
        ok: true,
        state: daemon.store.getJson("ui_runtime_state", null),
        device_connection: daemon.store.getJson("device_connection", null),
        response_task: daemon.store.getJson("response_task", null),
        queue: daemon.store.listQueue({ limit: 30 }),
        recent_events: daemon.store.listRecentEvents(30),
        logs: daemon.store.listLogs(30),
        migrations: daemon.store.listMigrations(),
        daemon_health: daemon.store.getJson("runtime_daemon_health", daemonHealthPayload()),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/queue") {
      if (!requireAuth(request, response)) return;
      writeJson(response, 200, {
        ok: true,
        queue: daemon.store.listQueue({
          queueName: url.searchParams.get("queue_name"),
          status: url.searchParams.get("status"),
          limit: Number(url.searchParams.get("limit") || 50),
        }),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/queue/update") {
      if (!requireAuth(request, response)) return;
      const body = await readRequestJson(request);
      const item = daemon.store.updateQueueItem(body.id, body.status, body.patch || {}, {
        workerId: body.worker_id || null,
        leaseToken: body.lease_token || null,
        leaseGeneration: body.lease_generation ?? null,
      });
      if (!item) {
        writeJson(response, 404, { ok: false, error: "Queue item not found" });
        return;
      }
      emitEvent("queue_item_updated", {
        id: item.id,
        queue_name: item.queue_name || body.queue_name || null,
        status: item.status,
      });
      writeJson(response, 200, { ok: true, item });
      return;
    }
    if (request.method === "POST" && url.pathname === "/queue/claim") {
      if (!requireAuth(request, response)) return;
      const body = await readRequestJson(request);
      const item = daemon.store.claimQueueItem(body.queue_name, {
        workerId: body.worker_id,
        leaseMs: body.lease_ms,
      });
      if (!item) {
        writeJson(response, 200, { ok: true, item: null, status: "empty" });
        return;
      }
      emitEvent("queue_item_claimed", {
        id: item.id,
        queue_name: item.queue_name,
        status: item.status,
        locked_by: item.locked_by,
      });
      writeJson(response, 200, { ok: true, item });
      return;
    }
    if (request.method === "POST" && url.pathname === "/queue/complete") {
      if (!requireAuth(request, response)) return;
      const body = await readRequestJson(request);
      const item = daemon.store.completeQueueItem(body.id, body.patch || {}, {
        workerId: body.worker_id || null,
        leaseToken: body.lease_token || null,
        leaseGeneration: body.lease_generation ?? null,
      });
      if (!item) {
        writeJson(response, 409, { ok: false, error: "Queue item lease is stale or invalid" });
        return;
      }
      emitEvent("queue_item_completed", {
        id: item.id,
        queue_name: item.queue_name,
        status: item.status,
      });
      writeJson(response, 200, { ok: true, item });
      return;
    }
    if (request.method === "POST" && url.pathname === "/queue/fail") {
      if (!requireAuth(request, response)) return;
      const body = await readRequestJson(request);
      const item = daemon.store.failQueueItem(body.id, body.error || {}, {
        retryDelayMs: body.retry_delay_ms || 0,
        workerId: body.worker_id || null,
        leaseToken: body.lease_token || null,
        leaseGeneration: body.lease_generation ?? null,
      });
      if (!item) {
        writeJson(response, 409, { ok: false, error: "Queue item lease is stale or invalid" });
        return;
      }
      emitEvent("queue_item_failed", {
        id: item.id,
        queue_name: item.queue_name,
        status: item.status,
        attempts: item.attempts,
        max_attempts: item.max_attempts,
      });
      writeJson(response, 200, { ok: true, item });
      return;
    }
    if (request.method === "POST" && url.pathname === "/queue/recover-stale") {
      if (!requireAuth(request, response)) return;
      const body = await readRequestJson(request);
      const recovered = daemon.store.recoverStaleQueueItems({
        staleMs: body.stale_ms || 60000,
        limit: body.limit || 100,
      });
      emitEvent("queue_stale_recovered", {
        count: recovered.length,
        ids: recovered.map((item) => item.id),
      });
      writeJson(response, 200, { ok: true, recovered });
      return;
    }
    if (request.method === "GET" && url.pathname === "/logs") {
      if (!requireAuth(request, response)) return;
      writeJson(response, 200, {
        ok: true,
        logs: daemon.store.listLogs(Number(url.searchParams.get("limit") || 50)),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      if (!requireAuth(request, response)) return;
      const cursorRequest = requestedEventCursor(url, request);
      const since = cursorRequest.sequence;
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      writeSseEvent(response, readyEvent(since, "sse"));
      clients.set(response, since);
      request.on("close", () => clients.delete(response));
      if (cursorRequest.replay) {
        for (const event of listReplayEvents(since)) {
          if (event.sequence <= (clients.get(response) ?? since)) continue;
          writeSseEvent(response, event);
          clients.set(response, event.sequence);
        }
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/action") {
      if (!requireAuth(request, response)) return;
      const body = await readRequestJson(request);
      if (body.action === "minimizeWindow" || body.action === "closeWindow") {
        writeJson(response, 400, { ok: false, error: "Window actions must be handled by Electron main" });
        return;
      }
      const result = await daemon.handleAction(body.action, body.payload || {}, null);
      emitEvent("runtime_action_completed", {
        action: body.action,
        status: result?.status || null,
        ok: result?.ok !== false,
      });
      writeJson(response, 200, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/shutdown") {
      if (!requireAuth(request, response)) return;
      writeJson(response, 200, { ok: true, status: "shutting_down" });
      emitEvent("daemon_shutdown_requested", {});
      setTimeout(() => shutdown(0), 20);
      return;
    }
    writeJson(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    try {
      daemon.store.appendEvent("daemon_http_error", { error: error?.message || String(error) });
    } catch {}
    writeJson(response, 500, { ok: false, error: error?.message || String(error) });
  }
});

function encodeWebSocketFrame(text) {
  const payload = Buffer.from(text);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function readWebSocketTextFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  if (opcode === 0x8) return { type: "close" };
  if (opcode !== 0x1) return null;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }
  return { type: "text", text: payload.toString("utf8") };
}

server.on("upgrade", (request, socket) => {
  try {
    const url = new URL(request.url || "/", `http://${host}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token") || request.headers["x-jcc-runtime-token"];
    if (token !== daemonToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"));
    const cursorRequest = requestedEventCursor(url, request);
    const since = cursorRequest.sequence;
    writeWebSocketEvent(socket, readyEvent(since, "websocket"));
    webSocketClients.set(socket, since);
    if (cursorRequest.replay) {
      for (const event of listReplayEvents(since)) {
        if (event.sequence <= (webSocketClients.get(socket) ?? since)) continue;
        writeWebSocketEvent(socket, event);
        webSocketClients.set(socket, event.sequence);
      }
    }
    socket.on("data", (chunk) => {
      const frame = readWebSocketTextFrame(chunk);
      if (frame?.type === "close") socket.end();
    });
    socket.on("close", () => webSocketClients.delete(socket));
    socket.on("error", () => webSocketClients.delete(socket));
  } catch {
    socket.destroy();
  }
});

let shutdownStarted = false;

async function cleanupBeforeShutdown() {
  unsubscribeDaemonRuntimeEvents();
  for (const client of clients.keys()) client.end();
  clients.clear();
  for (const socket of webSocketClients.keys()) socket.end();
  webSocketClients.clear();
  try {
    await daemon.handleAction("shutdown", { reason: "daemon_server_shutdown" }, null);
  } catch (error) {
    try {
      daemon.store.appendEvent("daemon_shutdown_cleanup_failed", {
        error: error?.message || String(error),
      });
    } catch {}
  }
}

function shutdown(code = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  void cleanupBeforeShutdown().finally(() => {
    server.close(() => {
      try {
        daemon.stop();
      } finally {
        releaseWriterLease(writerLease);
        writerLease = null;
      }
      process.exit(code);
    });
    setTimeout(() => {
      try {
        daemon.stop();
      } finally {
        releaseWriterLease(writerLease);
        writerLease = null;
      }
      process.exit(code);
    }, 1000);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("exit", () => releaseWriterLease(writerLease));

server.listen(requestedPort, host, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  const info = writeDaemonInfo(port);
  daemon.store.setJson("runtime_daemon_info", info);
  daemon.store.appendEvent("daemon_http_started", info);
  process.stdout.write(`${JSON.stringify({ type: "jcc-runtime-daemon-ready", ...info })}\n`);
});
