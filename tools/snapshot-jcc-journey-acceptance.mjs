import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const [sourceFile, stateFile, outputFile, rolloutFile] = process.argv.slice(2);
if (!sourceFile || !stateFile || !outputFile) throw new Error("Usage: snapshot-jcc-journey-acceptance.mjs REPORT STATE OUTPUT");
const report = JSON.parse(await readFile(sourceFile, "utf8"));
let state;
try { state = JSON.parse(await readFile(stateFile, "utf8")); } catch { state = null; }
const task = state?.response_task;
const nativeUsage = [];
if (rolloutFile) {
  try {
    for (const line of (await readFile(rolloutFile, "utf8")).split("\n").filter(Boolean)) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === "token_usage_record") nativeUsage.push({ timestamp: record.timestamp,
        provider_turn_id: record.payload?.turn_id, session_id: record.payload?.session_id,
        usage: record.payload?.usage, turn_token_usage: record.payload?.turn_token_usage });
    }
  } catch { /* The owning process may already have cleaned its temporary home. */ }
}
const snapshot = {
  ...report,
  snapshot_at: new Date().toISOString(),
  native_usage_records: nativeUsage,
  usage_attribution: "Native provider turn IDs; includes warmup/correction turns, not inferred per journey step",
  current_runtime_task: task ? {
    task_id: task.response_task_id, revision: task.revision, status: task.status,
    mode: task.mode, origin: task.origin, match_session_id: task.match_session_id,
    started_at: task.started_at, awaiting_since: task.awaiting_since,
    error: task.error || null, host_diagnostics: task.host_diagnostics || null,
    request_ref: task.host_request || null,
    response_chars: task.response?.final_text?.length ?? null,
    response_bytes: task.response?.final_text ? Buffer.byteLength(task.response.final_text, "utf8") : null,
  } : null,
  current_provider_session_id: state?.host_sessions?.match?.provider_session_id || null,
};
await mkdir(path.dirname(path.resolve(outputFile)), { recursive: true });
await writeFile(outputFile, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(JSON.stringify({ output: path.resolve(outputFile), status: task?.status || report.status, completed_turns: (report.turns || report.acceptance?.turns || []).length }));
