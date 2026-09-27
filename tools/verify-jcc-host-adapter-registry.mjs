import { readFile } from "node:fs/promises";
import {
  detectHostAgent,
  hostAdapterContract,
  normalizeReasoningEffort,
  reasoningEffortOptionsForModel,
  runHostAgentRequest,
} from "../ui/electron/host-adapters.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readText(file) {
  return readFile(file, "utf8");
}

function assertIncludes(source, needle, label) {
  assert(source.includes(needle), `${label} must include ${needle}`);
}

function assertNotIncludes(source, needle, label) {
  assert(!source.includes(needle), `${label} must not include ${needle}`);
}

async function main() {
  const adapter = await readText("ui/electron/host-adapters.js");
  const runtimeBridge = await readText("ui/src/runtimeBridge.ts");
  const service = await readText("ui/electron/runtime-service.js");
  const hostInstructionContract = await readText("data/runtime/jcc/host-coach-instruction-contract.json");

  assert(hostAdapterContract.schema === "jcc-host-adapter-registry-v1", "adapter contract schema mismatch");
  assert(JSON.stringify(Object.keys(hostAdapterContract.adapters).sort()) === JSON.stringify(["codex", "kimi"]), "host adapter contract must contain only Codex CLI and Kimi Code CLI");
  assert(hostAdapterContract.adapters.codex.protocol === "codex-app-server-json-rpc", "Codex persistent adapter must use app-server JSON-RPC");
  assert(hostAdapterContract.adapters.kimi.protocol === "acp-json-rpc", "Kimi adapter must declare ACP JSON-RPC");
  assert(hostAdapterContract.adapters.codex.image_transport === "app-server-local-image-input", "Codex persistent adapter must declare its app-server image transport.");
  assert(hostAdapterContract.adapters.kimi.prompt_transport === "acp-session-prompt-content-blocks", "Kimi adapter must declare verified ACP content-block prompt transport.");
  assert(hostAdapterContract.adapters.kimi.image_transport === "acp-session-prompt-image-base64", "Kimi adapter must declare verified ACP image content-block transport.");
  const removedProvider = "kimi_vision_api";
  const unsupportedDetection = await detectHostAgent({ provider: removedProvider });
  assert(unsupportedDetection.available === false, "removed Kimi HTTP provider must not be detectable");
  assert(String(unsupportedDetection.error || "").includes("Unsupported host provider"), "removed Kimi HTTP provider detection must fail explicitly");
  const unsupportedRun = await runHostAgentRequest({ provider: removedProvider }, "test", { timeoutMs: 50 });
  assert(unsupportedRun.ok === false, "removed Kimi HTTP provider must not be executable");
  assert(String(unsupportedRun.error || "").includes("Unsupported host provider"), "removed Kimi HTTP provider execution must fail explicitly");
  const solModels = [{ value: "gpt-5.6-sol", supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"] }];
  const lunaModels = [{ value: "gpt-5.6-luna", supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"] }];
  const gpt55Models = [{ value: "gpt-5.5", supported_reasoning_levels: ["low", "medium", "high", "xhigh"] }];
  assert(reasoningEffortOptionsForModel("gpt-5.6-sol", solModels).some((option) => option.value === "ultra"), "gpt-5.6-sol should expose CLI-advertised ultra reasoning");
  assert(reasoningEffortOptionsForModel("gpt-5.6-luna", lunaModels).some((option) => option.value === "max"), "gpt-5.6-luna should expose CLI-advertised max reasoning");
  assert(!reasoningEffortOptionsForModel("gpt-5.6-luna", lunaModels).some((option) => option.value === "ultra"), "gpt-5.6-luna should not expose a level omitted by the CLI catalog");
  assert(normalizeReasoningEffort("gpt-5.6-sol", "ultra", solModels) === "ultra", "CLI-advertised gpt-5.6-sol ultra should normalize through");
  assert(normalizeReasoningEffort("gpt-5.6-luna", "ultra", lunaModels) === null, "unsupported ultra should normalize away");
  assert(reasoningEffortOptionsForModel("gpt-5.5", gpt55Models).some((option) => option.value === "xhigh"), "gpt-5.5 should expose CLI-advertised xhigh reasoning");
  assert(reasoningEffortOptionsForModel("gpt-5.5", gpt55Models).some((option) => option.label === "跟随 CLI 默认"), "reasoning labels must be valid Chinese, not mojibake");
  assert(reasoningEffortOptionsForModel("gpt-5.5", gpt55Models).some((option) => option.label === "超高：深度局面/复盘"), "xhigh reasoning label must be valid Chinese");
  assert(reasoningEffortOptionsForModel("gpt-5.6-sol").every((option) => option.value === "default"), "reasoning levels must not be synthesized when the CLI catalog is absent");
  assert(normalizeReasoningEffort("gpt-5.6-sol", "ultra") === null, "ultra must not normalize without CLI catalog evidence");

  for (const needle of [
    "detectHostAgent",
    "runHostAgentRequest",
    "runCodexStream",
    "runKimiAcp",
    "codexEmptyResponseError",
    "kimiEmptyResponseError",
    "extractKimiProviderErrorFromEvents",
    "acpJsonRpcErrorMessage",
    "Codex CLI returned no assistant text",
    "Kimi CLI returned no assistant text",
    "inferKimiHomeFromCommand",
    "sourceKimiHome",
    "prepareKimiRuntimeEnv",
    "KIMI_CODE_HOME",
    "JCC_KIMI_RUNTIME_HOME",
    "JCC_HOST_CLI_RUNTIME_HOME_KIND",
    "acpRunSpec",
    "ensureHostCwd",
    "JCC_HOST_CLI_SELECTED_CONTEXT_MODE",
    "session/new",
    "session/prompt",
    "buildKimiPromptContentBlocks",
    "options.imagePaths",
    "type: \"image\"",
    "mimeType",
    "buffer.toString(\"base64\")",
    "promptCapabilities?.image",
    "acp_json_rpc",
    "fs/read_text_file",
    "JCC Runtime host adapter is read-only for ACP file writes",
    '"--json"',
    '"--skip-git-repo-check"',
    '"--disable", "hooks"',
    '"--disable", "plugins"',
    "item.completed",
    "agent_message",
    "runtime_authoritative_persistent_provider_session",
    "persistent-codex-app-server-thread-and-turns",
    "persistent-acp-process-session-and-prompts",
    "thread/start",
    "turn/start",
    "prompt_transport: \"acp-session-prompt-content-blocks\"",
    "image_transport: \"acp-session-prompt-image-base64\"",
    "model_capability_note",
    "cancelHostAgentRun",
    "activeHostProcesses",
    "hostProcessTaskId",
    "registerHostProcess",
    "unregisterHostProcess",
  ]) {
    assertIncludes(adapter, needle, "host adapter");
  }
  assertNotIncludes(adapter, "let activeHostProcess = null", "host adapter");
  assertNotIncludes(adapter, "modelReasoningLevelsHint", "host adapter");
  assertNotIncludes(adapter, "activeHostProcess = child", "host adapter");
  assertNotIncludes(adapter, "cancelHostAgentRun();\n      finish", "host adapter timeout path");
  for (const needle of [
    "kimi_vision_api",
    "runKimiVisionApi",
    "uploadKimiVisionFile",
    "moonshot-chat-completions",
    "moonshot-files-ms-file-id",
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
    "JCC_KIMI_API_KEY",
    "JCC_EXPOSE_KIMI_VISION_API_PROVIDER",
    "include_http_fallbacks",
  ]) {
    assertNotIncludes(adapter, needle, "host adapter");
    assertNotIncludes(runtimeBridge, needle, "runtime bridge");
  }

  for (const needle of [
    "output-last-message",
    '"exec", "resume"',
    "findNewCodexSessionId",
    "not yet enabled for generation",
    "璺熼殢",
    "浣庯",
  ]) {
    assertNotIncludes(adapter, needle, "host adapter");
    assertNotIncludes(service, needle, "runtime service");
  }

  assertIncludes(service, "runHostAgentRequest", "runtime service");
  assertIncludes(service, "detectHostAgent", "runtime service");
  assertIncludes(service, "function hostVisualTransportError", "runtime service");
  assertIncludes(service, "function assertHostVisualTransportAvailable", "runtime service");
  assertIncludes(service, "acp-session-prompt-image-base64", "runtime service");
  assertIncludes(service, "visual sensing requires a verified image-capable adapter", "runtime service");
  assertIncludes(service, "assertHostVisualTransportAvailable(state.host_cli)", "runtime service");
  assertIncludes(service, "buildHostCoachInstructions", "runtime service prompt builder");
  assertIncludes(hostInstructionContract, "static context capsule already loaded", "canonical runtime service prompt");
  assertIncludes(hostInstructionContract, "Never use prior conversation memory as authority for mutable game facts", "canonical runtime service prompt");
  assertIncludes(service, "function warmHostSession", "runtime service persistent session warmup");
  assertIncludes(service, "buildHostTurnDeltaPrompt", "runtime service dynamic turn transport");

  process.stdout.write(`${JSON.stringify({ ok: true, checked: ["codex-cli-adapter", "kimi-cli-acp-adapter", "removed-kimi-http-provider", "runtime-service"] }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
