import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdtemp, readFile, writeFile, copyFile, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as zlib from "node:zlib";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = process.env.JCC_SOURCE_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const temp = await mkdtemp(path.join(os.tmpdir(), "jcc-outbound-proxy-"));
const report = { schema: "jcc-native-outbound-metadata-v1", requests: [] };
const outputPath = path.resolve(process.env.JCC_OUTBOUND_REPORT || path.join(root, ".omx/runtime-evidence/native-outbound-metadata.json"));
let server;
try {
  const config = await readFile(path.join(source, "config.toml"), "utf8");
  // Fail closed unless the source has exactly one unambiguous endpoint to replace.
  const matches = [...config.matchAll(/^\s*base_url\s*=\s*"([^"\r\n]+)"\s*$/gm)];
  if (matches.length !== 1) throw new Error("Expected exactly one provider base_url");
  const upstream = new URL(matches[0][1]);
  if (upstream.protocol !== "https:" || upstream.username || upstream.password || upstream.search) {
    throw new Error("Expected credential-free HTTPS endpoint URL");
  }
  server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const wire = Buffer.concat(chunks);
      const encoding = req.headers["content-encoding"];
      let decoded = wire;
      if (encoding === "gzip") decoded = zlib.gunzipSync(wire);
      else if (encoding === "br") decoded = zlib.brotliDecompressSync(wire);
      else if (encoding === "zstd") decoded = zlib.zstdDecompressSync(wire);
      else if (encoding && encoding !== "identity") throw new Error("Unsupported request encoding");
      const entry = { method: req.method, request_bytes: wire.length, decoded_bytes: decoded.length, tool_outputs: [] };
      if (decoded.length) {
        const body = JSON.parse(decoded.toString("utf8"));
        entry.model = body.model;
        entry.top_level_keys = Object.keys(body);
        entry.input_item_types = (Array.isArray(body.input) ? body.input : []).map(item => item.type);
        entry.custom_calls = (Array.isArray(body.input) ? body.input : [])
          .filter(item => item.type === "custom_tool_call")
          .map(item => ({ name: item.name, namespace: item.namespace,
            explicit_max_output_tokens: String(item.input || "").match(/max_output_tokens["']?\s*:\s*(\d+)/)?.[1] || null }));
        const texts = [];
        function visit(value, location) {
          if (typeof value === "string" && value.includes("visibility-probe")) texts.push({ text: value, location });
          else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${location}[${index}]`));
          else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => visit(item, `${location}.${key}`));
        }
        for (const [index, item] of (Array.isArray(body.input) ? body.input : []).entries()) {
          if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
            const before = texts.length;
            visit(item.output, `request.input[${index}].output`);
            for (const output of texts.slice(before)) output.item_type = item.type;
          }
        }
        for (const { text, location, item_type } of texts) {
          entry.tool_outputs.push({
            location, item_type,
            text_bytes: Buffer.byteLength(text),
            sha256: createHash("sha256").update(text).digest("hex"),
            probe_schema_present: text.includes("visibility-probe"),
            marker_fields: Object.fromEntries(["head", "middle", "tail"].map(key =>
              [key, new RegExp(`"${key}"\\s*:\\s*"[a-f0-9]{16}"`).test(text)])),
            truncation_markers: [...text.matchAll(/(?:\d+\s+(?:tokens?|chars?|characters?)\s+truncated|truncated\s+\d+\s+(?:tokens?|chars?|characters?))/gi)].map(match => match[0]),
          });
        }
      }
      report.requests.push(entry);
      const target = new URL(upstream.origin);
      target.pathname = new URL(req.url, "http://localhost").pathname;
      target.search = new URL(req.url, "http://localhost").search;
      const headers = { ...req.headers, host: upstream.host };
      const forward = (target.protocol === "https:" ? httpsRequest : httpRequest)(target,
        { method: req.method, headers }, incoming => {
          entry.status = incoming.statusCode;
          res.writeHead(incoming.statusCode, incoming.headers);
          incoming.pipe(res);
        });
      forward.on("error", () => { entry.forward_error = true; res.destroy(); });
      res.on("close", () => forward.destroy());
      forward.end(wire);
    } catch {
      report.capture_error = true;
      res.writeHead(502); res.end("Probe capture failed");
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const temporarySource = path.join(temp, "source");
  await mkdir(temporarySource);
  const endpoint = `http://127.0.0.1:${server.address().port}${upstream.pathname.replace(/\/$/, "")}`;
  await writeFile(path.join(temporarySource, "config.toml"), config.replace(matches[0][0], `base_url = "${endpoint}"`));
  await copyFile(path.join(source, "auth.json"), path.join(temporarySource, "auth.json")).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  const child = spawn(process.execPath, [path.join(root, "tools/verify-jcc-native-result-visibility-live.mjs")], {
    cwd: root, windowsHide: true,
    env: { ...process.env, JCC_SOURCE_CODEX_HOME: temporarySource, JCC_CODEX_RUNTIME_HOME: path.join(temp, "runtime"),
      JCC_VISIBILITY_REPORT: path.join(temp, "visibility.json") },
    stdio: "ignore",
  });
  report.probe_exit_code = await new Promise((resolve, reject) => {
    child.on("error", reject); child.on("exit", resolve);
  });
  const visibility = JSON.parse(await readFile(path.join(temp, "visibility.json"), "utf8"));
  report.probes = visibility.report.map(row => ({ size: row.size, bytes: row.bytes, ok: row.ok,
    matches: row.matches, markers_correct: Object.fromEntries(["head", "middle", "tail"].map(key =>
      [key, row.response?.[key] === row.expected?.[key]])), completed_item_types: [...new Set((row.events || [])
        .filter(event => event.method === "item/completed").map(event => event.params?.item?.type))],
    native_results: (row.events || []).filter(event => event.method === "item/completed" && event.params?.item?.type === "dynamicToolCall")
      .map(event => ({ namespace: event.params.item.namespace, tool: event.params.item.tool,
        text_bytes: Buffer.byteLength((event.params.item.contentItems || []).map(item => item.text || "").join("")) })) }));
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(report, null, 2));
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
console.log(JSON.stringify(report, null, 2));
assert.equal(report.probe_exit_code, 0, "live visibility subprocess must succeed");
assert.ok(!report.capture_error && report.requests.every(row => !row.forward_error && row.status >= 200 && row.status < 300), "all captured requests must succeed");
assert.ok(report.probes?.length === 2 && report.probes.every(row => row.ok && row.matches && Object.values(row.markers_correct).every(Boolean)), "both model probes must reproduce all markers");
const outputs = report.requests.flatMap(row => row.tool_outputs);
assert.ok(outputs.length >= 2 && outputs.every(output => output.item_type === "function_call_output" && output.truncation_markers.length === 0 && Object.values(output.marker_fields).every(Boolean)), "all probe outputs must be direct and untruncated");
assert.ok(report.requests.every(row => !row.custom_calls?.some(call => call.name === "exec")), "JCC probe must not route through Code Mode exec");
assert.ok(report.probes.every(probe => outputs.some(output => output.text_bytes === probe.bytes)), "each complete probe payload must reach upstream");
