import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { windowsSafeArtifactToken } from "./jcc_artifact_filename.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args, cwd = path.resolve(import.meta.dirname, "..")) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function legacyAdviceRequest() {
  return {
    type: "advice_response_requested",
    response_id: "verify-normalized-host-request",
    mode: "augment_choice",
    response_draft: {
      summary: "后端草稿不是最终回答。",
    },
    host_cli_agent_request: {
      request_id: "verify-normalized-host-request",
      request_hash: "verify-normalized-host-hash",
      prompt: "Return the final coach JSON.",
      expected_response_shape: "jcc-host-cli-coach-response-v1",
      context: {
        live_state_summary: { phase: { stage_round: "2-1" } },
      },
    },
  };
}

function agentResponse() {
  return {
    schema: "jcc-host-cli-coach-response-v1",
    generated_by: "current_cli_agent_main_model",
    request_id: "verify-normalized-host-request",
    request_hash: "verify-normalized-host-hash",
    final_text: "优先拿便携锻炉；如果已经选了，就告诉我具体神器，我会按当前阶段继续判断。",
    recommended_action: "take_portable_forge",
    confidence: "high",
    followup_question: null,
  };
}

async function verifyDirectMerge(tempRoot) {
  const requestFile = path.join(tempRoot, "legacy-request.json");
  const responseFile = path.join(tempRoot, "agent-response.json");
  const outFile = path.join(tempRoot, "direct-result.json");
  await writeJson(requestFile, legacyAdviceRequest());
  await writeJson(responseFile, agentResponse());

  const run = await runNode([
    "tools/run-jcc-host-coach-response.mjs",
    "--request", requestFile,
    "--agent-response", responseFile,
    "--out", outFile,
  ]);
  assert(run.code === 0, `direct host coach merge should normalize legacy request: ${run.stderr || run.stdout}`);
  const result = JSON.parse(await readFile(outFile, "utf8"));
  assert(result.status === "completed", "direct normalized merge must complete");
  assert(result.advice_response?.ai_native_policy?.output_model === "host_cli_main_model_required", "normalized request must carry host main-model policy");
  assert(result.advice_response?.user_visible_text?.includes("便携锻炉"), "normalized merge must preserve final visible answer");
}

async function verifyPendingMerge(tempRoot) {
  const pipelineFile = path.join(tempRoot, "pipeline.json");
  const responseFile = path.join(tempRoot, "agent-response.json");
  const outDir = path.join(tempRoot, "pending-out");
  await writeJson(pipelineFile, {
    schema: "verify-pipeline-v1",
    response_events: [legacyAdviceRequest()],
  });
  await writeJson(responseFile, agentResponse());

  const run = await runNode([
    "tools/run-jcc-pending-host-coach-response.mjs",
    "--pipeline", pipelineFile,
    "--out-dir", outDir,
    "--agent-response", responseFile,
  ]);
  assert(run.code === 0, `pending host coach merge should normalize selected request: ${run.stderr || run.stdout}`);
  const result = JSON.parse(run.stdout);
  assert(result.status === "completed", "pending normalized merge must complete");
  const writtenRequest = JSON.parse(await readFile(result.request_event_file, "utf8"));
  assert(writtenRequest.ai_native_policy?.output_model === "host_cli_main_model_required", "pending tool must persist normalized request contract");
  assert(result.advice_response?.user_visible_text?.includes("便携锻炉"), "pending normalized merge must preserve final visible answer");
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-host-coach-request-normalization-"));
try {
  assert(
    windowsSafeArtifactToken("runtime:event") !== windowsSafeArtifactToken("runtime/event"),
    "Windows-safe Host artifact tokens must remain collision-resistant after invalid characters are replaced",
  );
  assert(
    !/[<>:"/\\|?*]/.test(windowsSafeArtifactToken("runtime-event-followup:test")),
    "Host artifact tokens must exclude Windows-invalid filename characters",
  );
  await verifyDirectMerge(tempRoot);
  await verifyPendingMerge(tempRoot);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked: [
      "direct_host_coach_merge_normalizes_missing_ai_native_policy",
      "pending_host_coach_merge_normalizes_missing_ai_native_policy",
    ],
  }, null, 2)}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
