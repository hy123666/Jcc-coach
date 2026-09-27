import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { HOST_CLI_MAIN_MODEL_OUTPUT, normalizeAdviceResponseRequestEvent } from "./jcc_host_coach_request_contract.mjs";
import {
  normalizeAugmentChoiceRecommendation,
  normalizeHostCoachResponse,
} from "../ui/electron/runtime-service.js";

function usage() {
  return [
    "Usage:",
    "  node tools/run-jcc-host-coach-response.mjs --request <advice-response-event.json> [--agent-response <coach-response.json>] [--out <result.json>]",
    "",
    "Bridges an advice_response_requested event to the current CLI agent main model.",
    "Without --agent-response it emits the host_cli_agent_request for the CLI model to answer.",
    "With --agent-response it validates and stores the final AI-native coach response.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--request") options.request = argv[++index];
    else if (arg === "--agent-response") options.agentResponse = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file) {
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertValidHostRequest(request) {
  if (request?.type !== "advice_response_requested") throw new Error("request must be an advice_response_requested event");
  if (request?.ai_native_policy?.output_model !== HOST_CLI_MAIN_MODEL_OUTPUT) throw new Error("request must require host CLI main model rendering");
  if (!request?.host_cli_agent_request) throw new Error("missing host_cli_agent_request");
  if (request.user_visible_text) throw new Error("request must not treat fallback text as final user_visible_text");
}

function scaffoldingTextsFromRequest(request) {
  return [
    request?.response_draft?.summary,
    request?.response_draft?.why,
    request?.response_draft?.title,
    request?.host_cli_agent_request?.fallback_text,
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

function validateAgentResponse(response, request) {
  const finalText = String(response?.final_text || "").trim();
  if (scaffoldingTextsFromRequest(request).includes(finalText)) {
    throw new Error("host CLI coach response final_text must not be copied from backend draft/fallback scaffolding");
  }
  const canonical = normalizeHostCoachResponse(response, request.host_cli_agent_request);
  return {
    ...canonical,
    provenance: {
      generated_by: canonical.generated_by,
      request_id: canonical.request_id,
      request_hash: canonical.request_hash,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.request) throw new Error(`Missing --request\n${usage()}`);
  const request = normalizeAdviceResponseRequestEvent(await readJson(options.request));
  assertValidHostRequest(request);
  if (!options.agentResponse) {
    const result = {
      ok: true,
      schema: "jcc-host-coach-response-run-result-v1",
      status: "awaiting_host_cli_agent_response",
      request: request.host_cli_agent_request,
      next_step: "Current CLI agent should answer request.expected_response_shape and rerun with --agent-response <json>.",
    };
    if (options.out) await writeJson(options.out, result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const response = validateAgentResponse(await readJson(options.agentResponse), request);
  const result = {
    ok: true,
    schema: "jcc-host-coach-response-run-result-v2",
    status: "completed",
    advice_response: {
      schema: "jcc-advice-response-completion-v2",
      type: "advice_response_completed",
      response_id: request.response_id,
      trigger_id: request.trigger_id || null,
      match_session_id: request.match_session_id || null,
      mode: request.mode || request.host_cli_agent_request?.mode || null,
      request_ref: {
        request_id: request.host_cli_agent_request?.request_id || request.response_id,
        request_hash: request.host_cli_agent_request?.request_hash || null,
        source_event_type: request.type,
      },
      ai_native_policy: {
        output_model: request.ai_native_policy?.output_model || HOST_CLI_MAIN_MODEL_OUTPUT,
      },
      status: "completed",
      coach_response: response,
      user_visible_text: response.final_text,
      final_response_required: false,
    },
  };
  if (options.out) await writeJson(options.out, result);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

export {
  normalizeAugmentChoiceRecommendation as normalizeRequiredChoiceRecommendation,
  validateAgentResponse,
};
