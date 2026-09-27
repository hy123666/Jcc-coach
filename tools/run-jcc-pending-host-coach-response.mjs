import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { windowsSafeArtifactToken } from "./jcc_artifact_filename.mjs";
import { normalizeAdviceResponseRequestEvent } from "./jcc_host_coach_request_contract.mjs";

function usage() {
  return [
    "Usage:",
    "  node tools/run-jcc-pending-host-coach-response.mjs --pipeline <cruise-pipeline.json> --out-dir <dir> [--request-index latest|0] [--request-id <id>] [--agent-response <coach-response.json>] [--out <json>]",
    "",
    "Consumes the latest advice_response_requested event using the current CLI agent main model.",
    "Without --agent-response it emits the host_cli_agent_request for the CLI model to answer.",
    "With --agent-response it validates and stores the final AI-native coach response.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { requestIndex: "latest" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--pipeline") options.pipeline = argv[++index];
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--request-index") options.requestIndex = argv[++index];
    else if (arg === "--request-id") options.requestId = argv[++index];
    else if (arg === "--agent-response") options.agentResponse = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
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

async function readJson(file) {
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function requestIds(event) {
  return new Set([
    event?.response_id,
    event?.host_cli_agent_request?.request_id,
  ].filter(Boolean).map(String));
}

function requestArtifactSuffix(request) {
  const raw = String(request?.response_id || request?.host_cli_agent_request?.request_id || "request");
  return windowsSafeArtifactToken(raw, "request");
}

function selectRequest(pipeline, requestIndex, requestId = null) {
  const requests = Array.isArray(pipeline?.response_events)
    ? pipeline.response_events.filter((event) => event?.type === "advice_response_requested")
    : [];
  if (!requests.length) throw new Error("No pending advice_response_requested events found");
  if (requestId) {
    const expected = String(requestId);
    const found = requests.find((event) => requestIds(event).has(expected));
    if (!found) throw new Error(`No pending advice_response_requested event matched request_id=${expected}`);
    return found;
  }
  if (requestIndex === "latest") return requests.at(-1);
  const index = Number(requestIndex);
  if (!Number.isInteger(index) || index < 0 || index >= requests.length) {
    throw new Error(`Invalid --request-index ${requestIndex}; queue length=${requests.length}`);
  }
  return requests[index];
}

async function requireOk(label, result) {
  if (result.code !== 0) throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.pipeline) throw new Error(`Missing --pipeline\n${usage()}`);
  if (!options.outDir) throw new Error(`Missing --out-dir\n${usage()}`);
  await mkdir(options.outDir, { recursive: true });

  const pipeline = await readJson(options.pipeline);
  const request = normalizeAdviceResponseRequestEvent(selectRequest(pipeline, options.requestIndex, options.requestId));
  const requestFile = path.join(options.outDir, `host-coach-request-event-${requestArtifactSuffix(request)}.json`);
  await writeJson(requestFile, request);

  const resultFile = options.out || path.join(options.outDir, "host-coach-response-run.json");
  const args = ["tools/run-jcc-host-coach-response.mjs", "--request", requestFile, "--out", resultFile];
  if (options.agentResponse) args.push("--agent-response", options.agentResponse);
  const run = await requireOk("host coach response", await runNode(args));
  const result = {
    ...JSON.parse(run.stdout),
    request_event: request,
    request_event_file: path.resolve(requestFile),
  };

  if (options.out) await writeJson(options.out, result);

  if (result.status === "completed") {
    await writeJson(path.join(options.outDir, "latest-host-coach-response.json"), {
      schema: "jcc-latest-host-coach-response-ref-v1",
      generated_at: new Date().toISOString(),
      response_id: result.advice_response?.response_id || request.response_id,
      status: "completed",
      host_coach_response_file: path.resolve(resultFile),
    });
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
