import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { detectHostAgent, runHostAgentRequest } from "../ui/electron/host-adapters.js";

function hasFlag(name) {
  return process.argv.includes(name);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const requireLive = hasFlag("--require-live");
  const timeoutMs = Number(process.env.JCC_KIMI_LIVE_TIMEOUT_MS || 30000);
  const requestedModel = process.env.JCC_KIMI_MODEL || "default";
  const requestedReasoningEffort = process.env.JCC_KIMI_REASONING_EFFORT || "default";
  const detected = await detectHostAgent({
    provider: "kimi",
    model: requestedModel,
    reasoning_effort: requestedReasoningEffort,
  });

  if (!detected.available) {
    const report = {
      ok: !requireLive,
      schema: "jcc-kimi-cli-live-availability-v1",
      status: "external_dependency_pending",
      live_generation_accepted: false,
      provider: "kimi",
      required_for: "Kimi live generation acceptance",
      reason: detected.error || "Kimi CLI not found",
      attempts: detected.attempts || [],
      strict_live_required: requireLive,
      next_step: "Install Kimi CLI or set KIMI_BIN, then run: node tools/verify-jcc-kimi-cli-live-availability.mjs --require-live",
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (requireLive) process.exit(1);
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-kimi-live-"));
  try {
    const prompt = [
      "You are a thin host CLI model for JCC Runtime.",
      "Return only JSON with this exact shape:",
      "{\"ok\":true,\"provider\":\"kimi\",\"saw_selected_context\":true,\"final_text\":\"Kimi live path accepted\"}",
      "",
      "INPUT_JSON:",
      JSON.stringify({
        runtime_context: {
          schema: "jcc-runtime-host-context-policy-v1",
          provider: "kimi",
          state_policy: "runtime_owned_selected_context_per_request",
        },
        user_message: "live adapter smoke test",
      }),
    ].join("\n");

    const result = await runHostAgentRequest(detected, prompt, {
      parseJson: true,
      repoRoot: path.resolve(import.meta.dirname, ".."),
      hostCwd: tempRoot,
      timeoutMs,
    });

    if (!result.ok && /authentication required|auth/i.test(String(result.error || ""))) {
      const report = {
        ok: !requireLive,
        schema: "jcc-kimi-cli-live-availability-v1",
        status: "external_dependency_pending",
        live_generation_accepted: false,
        provider: "kimi",
        command: detected.command,
        version: detected.version || null,
        required_for: "Kimi live generation acceptance",
        reason: "Kimi CLI is installed and ACP initializes, but the Kimi account is not authenticated.",
        strict_live_required: requireLive,
        next_step: "Run the Kimi login flow, then rerun: node tools/verify-jcc-kimi-cli-live-availability.mjs --require-live",
      };
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (requireLive) process.exit(1);
      return;
    }

    assert(result.ok === true, result.error || "Kimi live generation failed");
    assert(result.completed_from === "acp_json_rpc", "Kimi live path must use ACP JSON-RPC");
    assert(result.response?.ok === true, "Kimi live response must parse as JSON");
    assert(result.response?.saw_selected_context === true, "Kimi live response must see selected context");
    if (requestedModel !== "default") assert(detected.selected_model === requestedModel, "Kimi live path must preserve the requested CLI-native model");
    if (requestedReasoningEffort !== "default") assert(detected.reasoning_effort === requestedReasoningEffort, "Kimi live path must preserve the requested provider-advertised reasoning effort");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: "jcc-kimi-cli-live-availability-v1",
      status: "pass",
      live_generation_accepted: true,
      provider: "kimi",
      command: detected.command,
      version: detected.version || null,
      selected_model: detected.selected_model || detected.default_model || null,
      reasoning_effort: detected.reasoning_effort || null,
      completed_from: result.completed_from,
      session_id: result.session_id || null,
      checked: [
        "kimi-cli-detected",
        "kimi-acp-live-generation",
        "selected-context-transport",
        "json-response-parse",
        "provider-native-model-and-reasoning-selection",
      ],
    }, null, 2)}\n`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
