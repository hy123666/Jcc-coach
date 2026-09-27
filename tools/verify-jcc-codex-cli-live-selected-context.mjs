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
  const timeoutMs = Number(process.env.JCC_CODEX_LIVE_TIMEOUT_MS || 120000);
  const model = process.env.JCC_CODEX_MODEL || null;
  const reasoningEffort = process.env.JCC_CODEX_REASONING_EFFORT || "low";
  const detected = await detectHostAgent({
    provider: "codex",
    model,
    reasoning_effort: reasoningEffort,
  });

  if (!detected.available) {
    const report = {
      ok: !requireLive,
      schema: "jcc-codex-cli-live-selected-context-v1",
      status: "external_dependency_pending",
      live_generation_accepted: false,
      provider: "codex",
      required_for: "Codex CLI live selected-context acceptance",
      reason: detected.error || "Codex CLI not found",
      attempts: detected.attempts || [],
      strict_live_required: requireLive,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (requireLive) process.exit(1);
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-codex-live-"));
  const startedAt = Date.now();
  try {
    const input = {
      runtime_context: {
        schema: "jcc-runtime-host-context-policy-v1",
        provider: "codex",
        state_policy: "runtime_owned_selected_context_per_request",
        context_policy: {
          include_user_preferences: false,
          include_daily_big_data: false,
          include_season_catalog: false,
          reason: "minimal_live_adapter_smoke",
        },
      },
      user_message: "live selected-context adapter smoke",
    };
    const prompt = [
      "You are the thin host CLI model for JCC Runtime.",
      "Return exactly this JSON shape and no Markdown:",
      "{\"ok\":true,\"provider\":\"codex\",\"saw_selected_context\":true,\"final_text\":\"Codex live path accepted\"}",
      "",
      "Do not inspect the repository. Use only INPUT_JSON.",
      "INPUT_JSON:",
      JSON.stringify(input),
    ].join("\n");

    const result = await runHostAgentRequest(detected, prompt, {
      parseJson: true,
      repoRoot: path.resolve(import.meta.dirname, ".."),
      hostCwd: tempRoot,
      timeoutMs,
    });

    if (!result.ok && /auth|login|credential|network|rate|quota/i.test(String(result.error || ""))) {
      const report = {
        ok: !requireLive,
        schema: "jcc-codex-cli-live-selected-context-v1",
        status: "external_dependency_pending",
        live_generation_accepted: false,
        provider: "codex",
        command: detected.command,
        version: detected.version || null,
        reason: result.error,
        strict_live_required: requireLive,
        elapsed_ms: Date.now() - startedAt,
      };
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (requireLive) process.exit(1);
      return;
    }

    assert(result.ok === true, result.error || "Codex live selected-context generation failed");
    assert(result.completed_from === "json_event_stream", "Codex live path must use JSON event stream");
    assert(result.response?.ok === true, "Codex live response must parse as JSON");
    assert(result.response?.saw_selected_context === true, "Codex live response must see selected context");
    assert(!String(result.stderr || "").includes("output-last-message"), "Codex live path must not use output-last-message");
    assert(!String(result.stderr || "").includes("exec resume"), "Codex live path must not use resume session memory");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: "jcc-codex-cli-live-selected-context-v1",
      status: "pass",
      live_generation_accepted: true,
      provider: "codex",
      command: detected.command,
      version: detected.version || null,
      completed_from: result.completed_from,
      elapsed_ms: Date.now() - startedAt,
      event_count: Array.isArray(result.events) ? result.events.length : 0,
      response: result.response,
      checked: [
        "codex-cli-detected",
        "codex-json-event-stream-live-generation",
        "selected-context-stdin-transport",
        "json-response-parse",
        "no-output-last-message",
        "no-resume-session-memory",
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
