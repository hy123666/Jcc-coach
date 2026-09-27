import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { detectHostAgent, runHostAgentRequest, closeHostAgentSession } from "../ui/electron/host-adapters.js";

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(os.tmpdir(), "jcc-visibility-"));
const previousRuntimeHome = process.env.JCC_CODEX_RUNTIME_HOME;
process.env.JCC_CODEX_RUNTIME_HOME = path.join(temp, "host-home");
const model = process.env.JCC_CODEX_MODEL || "gpt-6-astra";
const report = [];
try {
  const adapter = await detectHostAgent({ provider: "codex", model, reasoning_effort: "low" });
  let large;
  if (process.env.JCC_VISIBILITY_FIXTURE) {
    const fixture = JSON.parse(await readFile(path.resolve(process.env.JCC_VISIBILITY_FIXTURE), "utf8"));
    const event = fixture.turns[0].events.find(e => e.method === "item/completed" && e.params?.item?.type === "dynamicToolCall");
    large = JSON.parse(event.params.item.contentItems[0].text).result;
  } else {
    large = { candidates: Array.from({ length: 5 }, (_, i) => ({ candidate_id: `probe-${i}`, filler: randomBytes(10500).toString("hex") })) };
  }
  for (const size of ["small", "ranking"]) {
    const markers = Object.fromEntries(["head", "middle", "tail"].map(k => [k, randomBytes(8).toString("hex")]));
    const payload = { schema: "visibility-probe", head: markers.head,
      first_half: size === "ranking" ? large.candidates.slice(0, 2) : [],
      middle: markers.middle, second_half: size === "ranking" ? large.candidates.slice(2) : [], tail: markers.tail };
    const row = { size, expected: markers, bytes: Buffer.byteLength(JSON.stringify(payload)), calls: [] };
    const route = `daily:visibility-${size}-${Date.now()}`;
    const start = Date.now();
    try {
      const result = await runHostAgentRequest(adapter,
        "This is a tool transport visibility test. Call jcc.query_knowledge operation=search_lineups. Its result contains random fields head, middle and tail; report their exact values in the final JSON. Do not infer or invent them. If a field is not visible return UNKNOWN for it. The surrounding game data is filler for this test; do not analyze strategy.",
        { repoRoot: root, hostCwd: temp, hostSessionKey: route, taskId: route, timeoutMs: 300000, parseJson: true, jsonResponseKind: "raw",
          outputSchema: { type: "object", properties: { head: { type: "string" }, middle: { type: "string" }, tail: { type: "string" } }, required: ["head", "middle", "tail"], additionalProperties: false },
          onReadonlyToolCall: async (name, args) => { row.calls.push({ name, args }); return payload; } });
      row.ok = result.ok;
      row.error = result.error;
      row.response = result.response;
      row.matches = Object.keys(markers).every(k => result.response?.[k] === markers[k]);
      row.events = result.events;
    } finally { await closeHostAgentSession(route); }
    row.elapsed_ms = Date.now() - start;
    report.push(row);
    console.log(JSON.stringify({ ...row, events: undefined }));
  }
} finally {
  try {
    const file = path.resolve(root, process.env.JCC_VISIBILITY_REPORT || ".omx/runtime-evidence/native-result-visibility.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ model, report }, null, 2));
  } finally {
    if (previousRuntimeHome === undefined) delete process.env.JCC_CODEX_RUNTIME_HOME;
    else process.env.JCC_CODEX_RUNTIME_HOME = previousRuntimeHome;
    await rm(temp, { recursive: true, force: true });
  }
}
assert.ok(report.length === 2 && report.every(row => row.ok && row.matches), "visibility probe failed; inspect report");
