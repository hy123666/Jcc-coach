import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectHostAgent, runHostAgentRequest, closeHostAgentSession } from "../ui/electron/host-adapters.js";

const root = await mkdtemp(path.join(os.tmpdir(), "jcc-visibility-"));
const previous = process.env.JCC_CODEX_RUNTIME_HOME;
process.env.JCC_CODEX_RUNTIME_HOME = path.join(root, "home");
const key = `visibility-${Date.now()}`;
const markers = Array.from({ length: 3 }, () => randomBytes(12).toString("hex"));
const count = Number(process.env.JCC_VISIBILITY_ROWS || 900);
assert.ok(Number.isInteger(count) && count >= 2 && count <= 1000);
const midpoint = Math.floor(count / 2);
const payload = { start: markers[0], rows: Array.from({ length: count }, (_, i) => ({
  id: i, evidence: `row-${i}: complete source fact with conditions and provenance. `.repeat(3),
  ...(i === midpoint ? { middle: markers[1] } : {}),
})), end: markers[2] };
const report = { schema: "jcc-provider-evidence-visibility-v1", bytes: Buffer.byteLength(JSON.stringify(payload)),
  sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), calls: 0 };
try {
  const adapter = await detectHostAgent({ provider: "codex", model: "gpt-5.5", reasoning_effort: "low" });
  report.provider_version = adapter.version;
  const result = await runHostAgentRequest(adapter,
    `Transport visibility test, not game advice. Call jcc.query_knowledge once with operation=get_entity. From its result return exactly start, rows[${midpoint}].middle and end. Do not guess. Use null for any value not visible. Do not call a second time. Return JSON {start,middle,end}.`, {
      repoRoot: path.resolve(import.meta.dirname, ".."), hostCwd: root, hostSessionKey: key,
      parseJson: true, jsonResponseKind: "raw", timeoutMs: 120000,
      outputSchema: { type: "object", properties: Object.fromEntries(["start", "middle", "end"].map(k => [k, { type: ["string", "null"] }])), required: ["start", "middle", "end"], additionalProperties: false },
      onReadonlyToolCall: async () => { report.calls++; return payload; },
    });
  report.provider_ok = result.ok;
  report.response = result.response;
  report.error = result.error || null;
  report.text = result.text || null;
  report.matches = ["start", "middle", "end"].map((k, i) => result.response?.[k] === markers[i]);
  report.rollout_outputs = [];
  async function inspect(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else if (entry.name.endsWith(".jsonl")) {
        for (const line of (await readFile(file, "utf8")).split("\n").filter(Boolean)) {
          let row;
          try { row = JSON.parse(line); } catch { continue; }
          if (row.type !== "response_item") continue;
          const body = row.payload;
          if (!String(body?.type || "").includes("output")) continue;
          const text = JSON.stringify(body);
          report.rollout_outputs.push({ type: body.type, bytes: Buffer.byteLength(text), markers_present: markers.map(m => text.includes(m)), truncated_marker: /truncat/i.test(text) });
        }
      }
    }
  }
  await inspect(path.join(root, "home"));
  await mkdir(".omx/runtime-evidence", { recursive: true });
  await writeFile(`.omx/runtime-evidence/provider-evidence-visibility-${count}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(result.ok, true);
  assert.ok(report.matches.every(Boolean), "provider did not retrieve all three random markers");
} finally {
  await closeHostAgentSession(key).catch(() => {});
  if (previous === undefined) delete process.env.JCC_CODEX_RUNTIME_HOME;
  else process.env.JCC_CODEX_RUNTIME_HOME = previous;
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
