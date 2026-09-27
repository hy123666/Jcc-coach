import { access, readFile } from "node:fs/promises";
import {
  detectHostAgent,
  hostAdapterContract,
  runHostAgentRequest,
} from "../ui/electron/host-adapters.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertMissing(file) {
  try {
    await access(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${file} must be deleted`);
}

async function main() {
  const adapter = await readFile("ui/electron/host-adapters.js", "utf8");
  const runtimeBridge = await readFile("ui/src/runtimeBridge.ts", "utf8");
  const removedProvider = "kimi_vision_api";
  const forbiddenImplementationMarkers = [
    removedProvider,
    "runKimiVisionApi",
    "detectKimiVisionApiAdapter",
    "uploadKimiVisionFile",
    "moonshot-chat-completions",
    "moonshot-files-ms-file-id",
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
    "JCC_KIMI_API_KEY",
    "JCC_EXPOSE_KIMI_VISION_API_PROVIDER",
    "include_http_fallbacks",
  ];

  assert(JSON.stringify(Object.keys(hostAdapterContract.adapters).sort()) === JSON.stringify(["codex", "kimi"]), "adapter registry must expose only Codex CLI and Kimi Code CLI");
  assert(hostAdapterContract.adapters.kimi.protocol === "acp-json-rpc", "Kimi must remain an ACP adapter");
  assert(hostAdapterContract.adapters.kimi.prompt_transport === "acp-session-prompt-content-blocks", "Kimi ACP prompt content blocks must remain enabled");
  assert(hostAdapterContract.adapters.kimi.image_transport === "acp-session-prompt-image-base64", "Kimi ACP image content blocks must remain enabled");
  assert(adapter.includes("buildKimiPromptContentBlocks"), "Kimi ACP image block builder must remain present");
  assert(adapter.includes("promptCapabilities?.image"), "Kimi ACP image capability negotiation must remain present");
  assert(adapter.includes("buffer.toString(\"base64\")"), "Kimi ACP image block encoding must remain present");
  assert(adapter.includes('const providers = ["codex", "kimi"]'), "host discovery must scan only Codex CLI and Kimi Code CLI");
  assert(runtimeBridge.includes('requestedProvider !== "codex" && requestedProvider !== "kimi"'), "runtime bridge mock must reject unsupported providers instead of coercing them");

  for (const marker of forbiddenImplementationMarkers) {
    assert(!adapter.includes(marker), `host adapter still contains removed HTTP provider marker: ${marker}`);
    assert(!runtimeBridge.includes(marker), `runtime bridge still contains removed HTTP provider marker: ${marker}`);
  }

  const detection = await detectHostAgent({ provider: removedProvider });
  assert(detection.available === false, "removed provider must not be detectable");
  assert(String(detection.error || "").includes("Unsupported host provider"), "removed provider detection must report unsupported provider");
  const execution = await runHostAgentRequest({ provider: removedProvider }, "test", { timeoutMs: 50 });
  assert(execution.ok === false, "removed provider must not be executable");
  assert(String(execution.error || "").includes("Unsupported host provider"), "removed provider execution must report unsupported provider");

  await assertMissing("tools/verify-jcc-kimi-vision-api-adapter-stub.mjs");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked: [
      "only-codex-and-kimi-cli-providers",
      "kimi-acp-image-capability-preserved",
      "kimi-http-provider-detection-removed",
      "kimi-http-provider-execution-removed",
      "legacy-http-stub-deleted",
    ],
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
