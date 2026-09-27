import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createKimiReadonlyMcpTransport, KIMI_MCP_MAX_RESULT_BYTES } from "../ui/electron/kimi-readonly-mcp-transport.js";
import { JCC_CODEX_DYNAMIC_TOOL_SPECS as specs, createHostReadonlyToolBroker } from "../ui/electron/host-readonly-tool-broker.js";

export async function connectBridge(config) {
  let session;
  let nextId = 0;
  const headers = Object.fromEntries(config.headers.map(({ name, value }) => [name, value]));
  async function request(method, params, overrides = {}, notification = false) {
    const response = await fetch(config.url, {
      method: "POST", headers: { ...headers, "content-type": "application/json",
        ...(session ? { "mcp-session-id": session } : {}), ...overrides },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++nextId }), method, params }),
    });
    if (response.headers.has("mcp-session-id")) session = response.headers.get("mcp-session-id");
    return { status: response.status, value: response.status === 202 ? null : await response.json() };
  }
  return { request, async initialize() {
    assert.equal((await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } })).status, 200);
    await request("notifications/initialized", {}, {}, true);
    return (await request("tools/list", {})).value.result.tools;
  } };
}

async function main() {
  await assert.rejects(createKimiReadonlyMcpTransport({ specs: [...specs, ...specs] }), /exactly/);
  const bridge = await createKimiReadonlyMcpTransport({ specs, callTimeoutMs: 40 });
  const client = await connectBridge(bridge.serverConfig);
  const error = (r) => JSON.parse(r.value.result.content[0].text).error;
  let seen = [];
  let resolveSlow;
  try {
    assert.equal(bridge.verified, false);
    assert.equal((await client.request("tools/list", {})).status, 404);
    assert.equal((await client.request("initialize", {}, { Authorization: "bad" })).status, 401);
    assert.equal((await client.request("initialize", {}, { Origin: "https://example.org" })).status, 403);
    const tools = await client.initialize();
    assert.deepEqual(tools.map((t) => t.name), ["query_knowledge", "calculate"]);
    assert(tools.every((t) => t.inputSchema.required.includes("_jcc_turn")));
    assert.equal(bridge.verified, true);
    assert.equal(bridge.beginTurn({ providerSessionId: "s", taskId: "t" }), null);
    const turn = bridge.beginTurn({ providerSessionId: "s", taskId: "t", handler: async (name, args) => {
      seen.push({ name, args });
      if (args.slow) return new Promise((resolve) => { resolveSlow = resolve; });
      return args.result ?? { ok: true };
    } });
    const call = (args = {}, name = "query_knowledge") => client.request("tools/call", { name, arguments: { _jcc_turn: turn.turnId, ...args } });
    assert.match(error(await call({}, "Bash")), /not_allowed/);
    assert.match(error(await call({ _jcc_turn: "0".repeat(64) })), /stale/);
    assert.equal((await call()).value.result.isError, undefined);
    assert.deepEqual(seen[0], { name: "jcc.query_knowledge", args: {} });
    const exact = "x".repeat(KIMI_MCP_MAX_RESULT_BYTES - 2);
    assert.equal((await call({ result: exact })).status, 413);
    assert.match(error(await call({ result: "x".repeat(17000) })), /arguments_too_large/);
    const slow = call({ slow: true });
    while (!resolveSlow) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.match(error(await call()), /already_pending/);
    turn.revoke();
    assert.match(error(await slow), /expired/);
    resolveSlow({ secret: "must not escape" });
    assert.match(error(await call()), /stale/);
    const next = bridge.beginTurn({ providerSessionId: "s", taskId: "next", handler: async () => exact });
    assert.match(error(await call()), /stale/);
    const nextCall = () => client.request("tools/call", { name: "calculate", arguments: { _jcc_turn: next.turnId } });
    assert.equal((await nextCall()).value.result.content[0].text.length, KIMI_MCP_MAX_RESULT_BYTES);
    next.revoke();
    const huge = bridge.beginTurn({ providerSessionId: "s", taskId: "huge", handler: async () => `${exact}x` });
    assert.match(error(await client.request("tools/call", { name: "calculate", arguments: { _jcc_turn: huge.turnId } })), /transport_limit/);
    huge.revoke();
    const timed = bridge.beginTurn({ providerSessionId: "s", taskId: "timed", handler: () => new Promise(() => {}) });
    assert.match(error(await client.request("tools/call", { name: "calculate", arguments: { _jcc_turn: timed.turnId } })), /expired/);
    timed.revoke();
    let finishQuery;
    let deliveryCount = 0;
    const broker = createHostReadonlyToolBroker({
      evidencePacket: { evidence_snapshot: { evidence_snapshot_id: "kimi:cancelled" }, plan: {}, coverage: { receipts: [] } },
      queryKnowledge: () => new Promise((resolve) => { finishQuery = resolve; }),
      onResult() { deliveryCount++; },
      cacheQueries: true,
    });
    const cancelled = bridge.beginTurn({ providerSessionId: "s", taskId: "broker-cancel",
      handler: (name, args, context) => broker.call(name, args, context) });
    const inFlight = client.request("tools/call", { name: "query_knowledge", arguments: { _jcc_turn: cancelled.turnId, operation: "get_entity", entity_id: "x" } });
    while (!finishQuery) await new Promise((resolve) => setTimeout(resolve, 1));
    cancelled.revoke();
    assert.match(error(await inFlight), /expired/);
    finishQuery({ status: "ok", entity_id: "x" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(deliveryCount, 0, "cancelled transport must not publish a broker delivery receipt");
    assert.deepEqual(bridge.observedToolCalls, ["jcc.query_knowledge", "jcc.calculate"]);
  } finally { await bridge.close(); }
  assert.equal(bridge.verified, false);
  await assert.rejects(client.request("tools/list", {}));
  console.log("Kimi MCP bridge boundary checks passed");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
