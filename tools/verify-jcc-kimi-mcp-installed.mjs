import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { runHostAgentRequest, closeHostAgentSession, detectHostAgent } from "../ui/electron/host-adapters.js";
import { KIMI_MCP_MAX_RESULT_BYTES } from "../ui/electron/kimi-readonly-mcp-transport.js";

// Real installed ACP + MCP, deterministic local provider. No account or paid inference.
const source = await mkdtemp(path.join(os.tmpdir(), "jcc-kimi-installed-"));
const command = process.env.KIMI_BIN || (await detectHostAgent({ provider: "kimi" })).command;
const key = `kimi-installed-${Date.now()}`;
const wire = [];
const nonce = randomBytes(12).toString("hex");
const largePayload = randomBytes(Math.floor((KIMI_MCP_MAX_RESULT_BYTES - 100) / 2)).toString("hex");
let calls = 0;
let token;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    wire.push(body);
    const text = JSON.stringify(body.messages);
    token ||= text.match(/_jcc_turn=([a-f0-9]{64})/)?.[1];
    const tools = [
      ["Read", { path: path.join(source, "forbidden.txt") }],
      ["Bash", { command: "echo FORBIDDEN_EXECUTION" }],
      ["FetchURL", { url: "http://127.0.0.1:1/must-not-run" }],
      ["Agent", { description: "must not run", prompt: "must not run", subagent_type: "explore" }],
      ["mcp__jcc__calculate", { question: "probe", _jcc_turn: token }],
    ];
    const next = tools[wire.length - 1];
    const delta = next ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${wire.length}`, type: "function", function: { name: next[0], arguments: JSON.stringify(next[1]) } }] }
      : { role: "assistant", content: nonce };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: `completion_${wire.length}`, object: "chat.completion.chunk", created: 1, model: "probe" };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: next ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  await writeFile(path.join(source, "forbidden.txt"), "LOCAL_FILE_SECRET_MUST_NOT_APPEAR");
  await writeFile(path.join(source, "config.toml"), `default_model = "probe"\n[providers.probe]\ntype = "openai"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\napi_key = "local-test"\n[models.probe]\nprovider = "probe"\nmodel = "probe"\nmax_context_size = 32768\ncapabilities = ["tool_use"]\n`);
  const result = await runHostAgentRequest({ provider: "kimi", command, available: true, kimi_home: source }, "Run the local provider probe.", {
    repoRoot: path.resolve(import.meta.dirname, ".."), hostSessionKey: key, taskId: key, timeoutMs: 30000,
    onReadonlyToolCall(name, args, context) {
      assert.equal(name, "jcc.calculate");
      assert.equal(args.question, "probe");
      assert.equal(context.signal.aborted, false);
      calls++;
      return { ok: true, probe_nonce: nonce, payload: largePayload };
    },
  });
  console.log(JSON.stringify({ ok: result.ok, error: result.error, calls, requests: wire.length,
    mode: result.readonly_tool_mode, receipt: result.capability_receipt,
    tools: wire[0]?.tools?.map((t) => t.function?.name), stderr: result.ok ? undefined : result.stderr?.slice(-3000) }, null, 2));
  assert.equal(result.ok, true, result.error);
  assert.equal(calls, 1);
  assert.equal(result.text, nonce);
  assert.equal(result.readonly_tool_mode, "native_dynamic_tools");
  const messages = wire.at(-1).messages;
  const toolResults = messages.filter((m) => m.role === "tool");
  console.log(JSON.stringify({ result_chars: JSON.stringify(toolResults.at(-1)).length, payload_chars: largePayload.length }));
  assert.equal(toolResults.length, 5);
  for (const denied of toolResults.slice(0, 4)) assert.match(JSON.stringify(denied.content), /denied|not found/i);
  assert.doesNotMatch(JSON.stringify(messages), /LOCAL_FILE_SECRET_MUST_NOT_APPEAR/);
  assert.match(JSON.stringify(toolResults.at(-1)), new RegExp(nonce));
  assert(JSON.stringify(toolResults.at(-1)).includes(largePayload), "the full near-limit random payload must reach the next real CLI provider request");
  assert.deepEqual(wire[0].tools.map((t) => t.function.name).filter((n) => n.startsWith("mcp__")).sort(), ["mcp__jcc__calculate", "mcp__jcc__query_knowledge"]);
  console.log("Installed Kimi: actual MCP allowed, builtin execution denied, model-bound tool result verified");
} finally {
  await closeHostAgentSession(key);
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await rm(source, { recursive: true, force: true, maxRetries: 5 });
}
