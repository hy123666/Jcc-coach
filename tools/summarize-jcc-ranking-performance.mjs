import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const ids = process.argv.slice(2);
assert.ok(ids.length > 0, "supply saved run IDs");
const rows = [];
let identity;
for (const id of ids) {
  assert.match(id, /^[a-zA-Z0-9_-]+$/);
  const file = `.omx/runtime-evidence/native-ranking-pull-timing-0-${id}.json`;
  const sample = JSON.parse(await readFile(file, "utf8"));
  const current = [sample.model, sample.reasoning_effort, sample.question, sample.knowledge_snapshot?.generation_id];
  assert.ok(current[3], "comparison requires a recorded immutable knowledge generation");
  identity ??= current;
  assert.deepEqual(current, identity, "model, question and knowledge generation must match");
  const localMs = sample.calls.reduce((sum, call) => sum + call.local_ms, 0);
  rows.push({ id, evidence: file, ok: sample.provider_ok === true && sample.selected_count >= 3,
    elapsed_ms: sample.elapsed_ms, error: sample.error, selected: sample.selected_count || 0,
    prompt_bytes: sample.prompt_bytes, tool_bytes: sample.tool_bytes,
    calls: sample.calls.length, repeated_candidate_deliveries: sample.calls.reduce((sum, call) => sum + (call.repeated || 0), 0),
    local_tool_ms: Math.round(localMs), validation_ms: sample.validation_ms ?? null,
    dispatch_ms: sample.dispatched_ms, first_token_ms: sample.first_token_ms ?? null,
    corrected: sample.corrected ?? null, operations: sample.calls.map(call => call.operation || call.tool || "calculate"),
    cache_hits: sample.calls.filter(call => call.cache_hit).length });
}
const output = { schema: "jcc-ranking-performance-comparison-v1", identity,
  scope: "isolated real-provider 2-2 probes; excludes UI ACK and static session bootstrap; no token telemetry",
  samples: rows, successful: rows.filter(row => row.ok).length,
  within_60_seconds: rows.filter(row => row.ok && row.elapsed_ms <= 60000).length,
  timeout_samples_retained: rows.filter(row => !row.ok && /timed out/i.test(row.error || "")).length,
  conclusion: "Do not infer stable improvement from single historical runs or average only successful samples." };
await writeFile(".omx/runtime-evidence/ranking-performance-comparison.json", JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
