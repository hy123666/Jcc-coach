#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

function requestEvent(id) {
  return {
    type: "advice_response_requested",
    response_id: id,
    mode: "cruise",
    ai_native_policy: { output_model: "host_cli_main_model_required" },
    host_cli_agent_request: {
      request_id: id,
      request_hash: `hash:${id}`,
      mode: "cruise",
      user_message: `question:${id}`,
    },
  };
}

async function run(args) {
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: root,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 4,
  });
  return JSON.parse(stdout);
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "jcc-host-request-identity-"));
try {
  const pipelineFile = path.join(tmp, "pipeline.json");
  await writeFile(pipelineFile, JSON.stringify({
    response_events: [requestEvent("request-a"), requestEvent("request-b")],
  }), "utf8");

  const pendingA = await run([
    "tools/run-jcc-pending-host-coach-response.mjs",
    "--pipeline", pipelineFile,
    "--out-dir", tmp,
    "--request-id", "request-a",
  ]);
  assert.equal(pendingA.request.request_id, "request-a");
  assert.equal(pendingA.request_event.response_id, "request-a");
  assert.equal(pendingA.request_event.host_cli_agent_request.request_hash, "hash:request-a");
  assert(existsSync(pendingA.request_event_file));
  assert(!existsSync(path.join(tmp, "host-coach-request-event.json")), "shared latest request artifacts must not be created");

  const pendingB = await run([
    "tools/run-jcc-pending-host-coach-response.mjs",
    "--pipeline", pipelineFile,
    "--out-dir", tmp,
    "--request-id", "request-b",
  ]);
  assert.notEqual(pendingA.request_event_file, pendingB.request_event_file);

  const responseAFile = path.join(tmp, "response-a.json");
  await writeFile(responseAFile, JSON.stringify({
    schema: "jcc-host-cli-coach-response-v1",
    generated_by: "current_cli_agent_main_model",
    request_id: "request-a",
    request_hash: "hash:request-a",
    observed_stage_round: "2-2",
    observed_gold: null,
    ignored_stale_stage: false,
    ignored_stale_gold: false,
    recommended_action: "继续观察并保持经济",
    final_text: "Keep economy and reassess on the latest stage.",
    confidence: "medium",
  }), "utf8");
  const mergedA = await run([
    "tools/run-jcc-host-coach-response.mjs",
    "--request", pendingA.request_event_file,
    "--agent-response", responseAFile,
    "--out", path.join(tmp, "merged-a.json"),
  ]);
  assert.equal(mergedA.status, "completed");
  assert.equal(mergedA.advice_response.response_id, "request-a");

  const service = await readFile(path.join(root, "ui/electron/runtime-service.js"), "utf8");
  assert(service.includes("pending.request_event?.type === \"advice_response_requested\""));
  assert(!service.includes("!requestEvent && requestId"), "runtime completion must not fall back to a mutable shared request");

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-host-request-task-identity-verifier-v1",
    checked: [
      "pending_result_carries_immutable_request_event",
      "request_artifacts_are_task_specific",
      "later_request_does_not_break_earlier_response_merge",
      "runtime_has_no_shared_latest_request_fallback",
    ],
  }, null, 2));
} finally {
  await rm(tmp, { recursive: true, force: true });
}
