import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runHostAgentRequest, closeHostAgentSession } from "../ui/electron/host-adapters.js";

// The real CLI talks only to this loopback Responses fixture. No credentials or game facts.
const root = await mkdtemp(path.join(os.tmpdir(), "jcc-wire-visibility-"));
const saved = { source: process.env.JCC_SOURCE_CODEX_HOME, home: process.env.JCC_CODEX_RUNTIME_HOME };
const key = `wire-${Date.now()}`;
const model = process.env.JCC_CODEX_MODEL || "gpt-6-astra";
const outputPath = path.resolve(process.env.JCC_WIRE_VISIBILITY_REPORT || ".omx/runtime-evidence/provider-wire-visibility.json");
const markers = Array.from({ length: 3 }, () => randomBytes(12).toString("hex"));
const targetBytes = 1024 * 1024 - 1024;
const payload = { start: markers[0], first_half: "", middle: markers[1], second_half: "", end: markers[2] };
const fillerBytes = targetBytes - Buffer.byteLength(JSON.stringify(payload));
payload.first_half = "a".repeat(Math.floor(fillerBytes / 2));
payload.second_half = "b".repeat(fillerBytes - payload.first_half.length);
const payloadText = JSON.stringify(payload);
const report = { schema: "jcc-provider-wire-visibility-v1", model, sent_bytes: Buffer.byteLength(payloadText), requests: [] };
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const input = JSON.stringify(body.input || []);
    const outputs = (body.input || []).filter(item => item.type === "function_call_output");
    report.requests.push({ path: req.url, model: body.model, input_bytes: Buffer.byteLength(input),
      direct_calls: (body.input || []).filter(item => item.type === "function_call")
        .map(item => ({ name: item.name, namespace: item.namespace, call_id: item.call_id })),
      custom_call_count: (body.input || []).filter(item => item.type === "custom_tool_call" || item.type === "custom_tool_call_output").length,
      tool_outputs: outputs.map(item => {
      const text = typeof item.output === "string" ? item.output : (item.output || [])
        .filter(part => part.type === "input_text").map(part => part.text).join("\n");
      return { call_id: item.call_id, bytes: Buffer.byteLength(text), exact_payload: text === payloadText,
        markers_present: markers.map(m => text.includes(m)), truncation_marker: /truncat/i.test(text) };
    }) });
    const item = outputs.length ? { type: "message", id: "msg_probe", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }] }
      : { type: "function_call", id: "fc_probe", call_id: "call_probe", namespace: "jcc", name: "query_knowledge", arguments: '{"operation":"get_entity"}', status: "completed" };
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit("response.created", { response: { id: `resp_${report.requests.length}`, object: "response", status: "in_progress", output: [] } });
    emit("response.output_item.added", { output_index: 0, item });
    if (outputs.length) emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: '{"ok":true}' });
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", { response: { id: `resp_${report.requests.length}`, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  process.env.JCC_SOURCE_CODEX_HOME = path.join(root, "source");
  process.env.JCC_CODEX_RUNTIME_HOME = path.join(root, "home");
  await mkdir(process.env.JCC_SOURCE_CODEX_HOME);
  await writeFile(path.join(process.env.JCC_SOURCE_CODEX_HOME, "config.toml"),
    `model_provider = "fixture"\nmodel = ${JSON.stringify(model)}\n[model_providers.fixture]\nname = "fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  const result = await runHostAgentRequest({ provider: "codex", command: "codex", available: true, selected_model: model, reasoning_effort: "low" }, "Read the test tool.", {
    repoRoot: path.resolve(import.meta.dirname, ".."), hostCwd: root, hostSessionKey: key,
    parseJson: true, jsonResponseKind: "raw", timeoutMs: 45000,
    onReadonlyToolCall: async () => payload,
  });
  report.ok = result.ok;
  report.error = result.error || null;
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.ok(result.ok);
  assert.equal(result.response?.ok, true);
  assert.equal(report.sent_bytes, targetBytes);
  assert.ok(report.requests.every(request => request.model === model && request.custom_call_count === 0), "fixture must use direct calls with the requested model");
  assert.ok(report.requests.some(request => request.direct_calls.some(call => call.name === "query_knowledge" && call.namespace === "jcc" && call.call_id === "call_probe")), "direct JCC invocation must be retained in model input");
  const outputs = report.requests.flatMap(request => request.tool_outputs);
  assert.ok(outputs.length > 0 && outputs.every(output => output.call_id === "call_probe" && output.exact_payload && !output.truncation_marker && output.markers_present.every(Boolean)), "entire near-1MiB payload must reach model HTTP input unchanged");
} finally {
  await closeHostAgentSession(key).catch(() => {});
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  for (const [name, value] of [["JCC_SOURCE_CODEX_HOME", saved.source], ["JCC_CODEX_RUNTIME_HOME", saved.home]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
