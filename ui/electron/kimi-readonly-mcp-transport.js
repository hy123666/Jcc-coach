import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

// Kimi Code 0.29.2 caps MCP at 100,000 UTF-16 code units, then the v1
// model-result budget replaces >50,000 characters with a 2,000-char preview.
// Keep whole results below both limits; never let the provider slice evidence.
export const KIMI_MCP_MAX_RESULT_CHARS = 100_000;
export const KIMI_MCP_MAX_RESULT_BYTES = 45_000;
export const KIMI_MCP_TURN_FIELD = "_jcc_turn";
const MAX_ARGUMENT_BYTES = 16 * 1024;
const MAX_BODY_BYTES = MAX_ARGUMENT_BYTES + 4096;
const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const secret = () => randomBytes(32).toString("hex");
const failure = (error) => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ schema: "jcc-readonly-tool-error-v1", error }) }],
});

function equalSecret(actual, expected) {
  return typeof actual === "string" && Buffer.byteLength(actual) === Buffer.byteLength(expected)
    && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function send(res, status, value, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  const body = value === undefined ? "" : JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json", "content-length": Buffer.byteLength(body),
    "cache-control": "no-store", ...headers,
  });
  res.end(body);
}

export async function createKimiReadonlyMcpTransport({ specs, callTimeoutMs = 300_000 }) {
  const authorization = `Bearer ${secret()}`;
  const mcpSessionId = secret();
  const entries = specs.flatMap((namespace) => (namespace.tools || []).map((tool) => [
    tool.name, { ...tool, canonicalName: `${namespace.name}.${tool.name}` },
  ]));
  const toolMap = new Map(entries);
  if (entries.length !== 2 || toolMap.size !== 2 || ![...toolMap.values()].every((tool) =>
    ["jcc.query_knowledge", "jcc.calculate"].includes(tool.canonicalName))) {
    throw new Error("Kimi MCP requires exactly the two JCC readonly tools");
  }
  const tools = [...toolMap.values()].map((tool) => ({
    name: tool.name,
    description: `${tool.description} Pass _jcc_turn from the current Runtime turn binding; never reuse a previous turn binding.`,
    inputSchema: {
      ...tool.inputSchema,
      required: [...(tool.inputSchema.required || []), KIMI_MCP_TURN_FIELD],
      properties: {
        ...tool.inputSchema.properties,
        [KIMI_MCP_TURN_FIELD]: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }));
  let initialized = false;
  let notified = false;
  let discovered = false;
  let closed = false;
  let closePromise;
  let activeTurn = null;
  const pending = new Map();
  const observedTools = new Set();
  const readinessWaiters = new Set();
  const settleReadiness = (value) => {
    for (const settle of readinessWaiters) settle(value);
    readinessWaiters.clear();
  };
  const revoke = (turn) => {
    if (!turn || turn !== activeTurn) return;
    activeTurn = null;
    turn.controller.abort();
  };
  const isLive = (turn) => !closed && turn === activeTurn && !turn.controller.signal.aborted;

  async function invoke(message) {
    const turn = activeTurn;
    const args = message.params?.arguments;
    const tool = toolMap.get(message.params?.name);
    if (!tool) return failure("readonly_tool_not_allowed");
    if (!turn || !isLive(turn) || !args || typeof args !== "object" || Array.isArray(args)
      || !equalSecret(args[KIMI_MCP_TURN_FIELD], turn.token)) return failure("readonly_tool_stale_or_unbound_turn");
    if (pending.size) return failure("readonly_tool_call_already_pending");
    if (turn.calls >= 12 || (turn.toolCalls.get(tool.name) || 0) >= 10) return failure("readonly_tool_call_budget_exceeded");
    const { [KIMI_MCP_TURN_FIELD]: unused, ...argumentsForBroker } = args;
    if (Buffer.byteLength(JSON.stringify(argumentsForBroker)) > MAX_ARGUMENT_BYTES) return failure("readonly_tool_arguments_too_large");
    turn.calls++;
    turn.toolCalls.set(tool.name, (turn.toolCalls.get(tool.name) || 0) + 1);
    const controller = new AbortController();
    pending.set(message.id, controller);
    const abort = () => controller.abort();
    turn.controller.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, callTimeoutMs);
    let onAbort;
    try {
      const interrupted = new Promise((resolve) => {
        onAbort = () => resolve({ cancelled: true });
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const outcome = await Promise.race([
        Promise.resolve().then(async () => {
          if (!isLive(turn) || controller.signal.aborted) return { cancelled: true };
          return { result: await turn.handler(tool.canonicalName, argumentsForBroker, { signal: controller.signal }) };
        }), interrupted,
      ]);
      if (!isLive(turn) || controller.signal.aborted || outcome.cancelled) return failure("readonly_tool_turn_expired_during_call");
      const text = JSON.stringify(outcome.result);
      if (typeof text !== "string") return failure("readonly_tool_invalid_result");
      if (text.length > KIMI_MCP_MAX_RESULT_CHARS || Buffer.byteLength(text) > KIMI_MCP_MAX_RESULT_BYTES) {
        return failure("readonly_tool_result_exceeds_kimi_transport_limit");
      }
      observedTools.add(tool.canonicalName);
      return { content: [{ type: "text", text }] };
    } catch {
      return failure("readonly_tool_broker_failed");
    } finally {
      clearTimeout(timer);
      turn.controller.signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort);
      pending.delete(message.id);
    }
  }

  const server = createServer((req, res) => {
    void (async () => {
      if (closed || !equalSecret(req.headers.authorization, authorization)) return send(res, 401, { error: "unauthorized" });
      if (req.headers.host !== address.host || req.headers.origin || req.url !== "/mcp") return send(res, 403, { error: "forbidden" });
      if (req.method !== "POST") return send(res, 405, undefined, { allow: "POST" });
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 415, { error: "json_required" });
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) return send(res, 413, { error: "request_too_large" });
        chunks.push(chunk);
      }
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(res, 400, { error: "invalid_json" }); }
      if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string"
        || (Object.hasOwn(message, "id") && typeof message.id !== "string" && typeof message.id !== "number")) {
        return send(res, 400, { error: "invalid_request" });
      }
      const reply = (result) => send(res, 200, { jsonrpc: "2.0", id: message.id, result });
      if (message.method === "initialize" && Object.hasOwn(message, "id")) {
        if (initialized) return send(res, 409, { error: "already_initialized" });
        initialized = true;
        return send(res, 200, { jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: PROTOCOL_VERSIONS.has(message.params?.protocolVersion) ? message.params.protocolVersion : "2024-11-05",
          capabilities: { tools: {} }, serverInfo: { name: "jcc-runtime", version: "1" },
        } }, { "mcp-session-id": mcpSessionId });
      }
      if (!initialized || !equalSecret(req.headers["mcp-session-id"], mcpSessionId)) return send(res, 404, { error: "unknown_session" });
      if (!Object.hasOwn(message, "id")) {
        if (message.method === "notifications/initialized") notified = true;
        if (message.method === "notifications/cancelled") pending.get(message.params?.requestId)?.abort();
        return send(res, 202);
      }
      if (message.method === "ping") return reply({});
      if (message.method === "tools/list" && notified) {
        discovered = true;
        settleReadiness(true);
        return reply({ tools });
      }
      if (message.method === "tools/call" && discovered) return reply(await invoke(message));
      return send(res, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported_method" } });
    })().catch(() => send(res, 400, { error: "invalid_request" }));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 8;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  return {
    serverConfig: { type: "http", name: "jcc", url: address.href, headers: [{ name: "Authorization", value: authorization }] },
    get verified() { return !closed && initialized && notified && discovered; },
    get observedToolCalls() { return [...observedTools]; },
    waitUntilVerified(timeoutMs = 300_000) {
      if (this.verified || closed) return Promise.resolve(this.verified);
      return new Promise((resolve) => {
        const settle = (value) => { clearTimeout(timer); readinessWaiters.delete(settle); resolve(value); };
        const timer = setTimeout(() => settle(false), Math.max(1, timeoutMs));
        readinessWaiters.add(settle);
      });
    },
    beginTurn({ providerSessionId, taskId, handler }) {
      if (!this.verified || !providerSessionId || !taskId || typeof handler !== "function") return null;
      if (activeTurn) throw new Error("Kimi MCP turn already active");
      const turn = { token: secret(), providerSessionId, taskId, handler, controller: new AbortController(), calls: 0, toolCalls: new Map() };
      activeTurn = turn;
      return {
        turnId: turn.token,
        promptText: `JCC readonly tool turn binding: ${KIMI_MCP_TURN_FIELD}=${turn.token}. Use mcp__jcc__query_knowledge or mcp__jcc__calculate for the corresponding jcc tools. Include this binding in every call.`,
        revoke: () => revoke(turn),
      };
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      settleReadiness(false);
      revoke(activeTurn);
      closePromise = new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}
