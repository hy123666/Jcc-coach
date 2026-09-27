import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runHostAgentRequest } from "../ui/electron/host-adapters.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-host-adapter-stream-stub-"));
  const fakeCodex = path.join(tempRoot, "fake-codex.mjs");
  const promptCapture = path.join(tempRoot, "prompt.txt");
  const sourceCodexHome = path.join(tempRoot, "source-codex-home");
  const runtimeCodexHome = path.join(tempRoot, "runtime-codex-home");
  const previousSourceCodexHome = process.env.JCC_SOURCE_CODEX_HOME;
  const previousRuntimeCodexHome = process.env.JCC_CODEX_RUNTIME_HOME;
  try {
    await mkdir(sourceCodexHome, { recursive: true });
    await writeFile(path.join(sourceCodexHome, "auth.json"), "{\"OPENAI_API_KEY\":\"stub\"}\n", "utf8");
    await writeFile(path.join(sourceCodexHome, "installation_id"), "stub-installation\n", "utf8");
    await writeFile(path.join(sourceCodexHome, "config.toml"), [
      'model_provider = "stub_provider"',
      'model = "stub-model"',
      'model_reasoning_effort = "medium"',
      'developer_instructions = "must not be copied"',
      "",
      "[model_providers.stub_provider]",
      'name = "Stub Provider"',
      'base_url = "https://example.invalid/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "",
      "[mcp_servers.bad]",
      'command = "bad"',
      "",
      "[plugins.bad]",
      "enabled = true",
      "",
      "[features]",
      "hooks = true",
      "",
    ].join("\n"), "utf8");
    process.env.JCC_SOURCE_CODEX_HOME = sourceCodexHome;
    process.env.JCC_CODEX_RUNTIME_HOME = runtimeCodexHome;

    await writeFile(fakeCodex, `
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = Buffer.concat(chunks).toString("utf8");
await writeFile(process.env.JCC_HOST_STUB_CAPTURE, input, "utf8");
const response = {
  schema: "jcc-host-cli-coach-response-v1",
  generated_by: "current_cli_agent_main_model",
  request_id: "verify-request",
  request_hash: "verify-hash",
  final_text: "Use the selected current-season context and do not invent old-season champions.",
  recommended_action: "use_selected_context",
  confidence: "high",
  followup_question: null
};
if (process.env.JCC_HOST_STUB_ENV_CAPTURE) {
  let cleanConfig = "";
  try {
    const configUrl = pathToFileURL(path.join(process.env.CODEX_HOME, "config.toml"));
    cleanConfig = await import("node:fs/promises").then(({ readFile }) => readFile(configUrl, "utf8"));
  } catch {}
  await writeFile(process.env.JCC_HOST_STUB_ENV_CAPTURE, JSON.stringify({
    argv: process.argv.slice(2),
    CODEX_HOME: process.env.CODEX_HOME || null,
    JCC_HOST_CLI_CLEAN_CODEX_HOME: process.env.JCC_HOST_CLI_CLEAN_CODEX_HOME || null,
    clean_config: cleanConfig,
  }, null, 2), "utf8");
}
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(response) } }) + "\\n");
`, "utf8");

    process.env.JCC_HOST_STUB_CAPTURE = promptCapture;
    const envCapture = path.join(tempRoot, "env.json");
    process.env.JCC_HOST_STUB_ENV_CAPTURE = envCapture;
    const prompt = [
      "You are the visible AI-native coach for JCC Runtime.",
      "INPUT_JSON:",
      JSON.stringify({
        request_id: "verify-request",
        request_hash: "verify-hash",
        runtime_context: {
          context_policy: {
            include_user_preferences: true,
            include_daily_big_data: true,
            include_season_catalog: true,
          },
        },
        user_preferences: { rank_tier: "master" },
        daily_big_data: { stat_date: "20260617", available: true },
        season_catalog: {
          champion_names: ["潘森", "古拉加斯", "派克"],
        },
      }, null, 2),
    ].join("\n");
    const result = await runHostAgentRequest({
      provider: "codex",
      spawn_command: process.execPath,
      spawn_prefix_args: [fakeCodex],
      selected_model: null,
      reasoning_effort: null,
    }, prompt, {
      parseJson: true,
      jsonResponseKind: "coach",
      repoRoot: process.cwd(),
      taskId: "verify-stub",
      timeoutMs: 10000,
      hostCwd: tempRoot,
    });

    assert(result.ok === true, `stub host adapter should succeed: ${result.error || ""}`);
    assert(result.completed_from === "json_event_stream", "host adapter must parse JSON event stream");
    assert(result.thread_id === "stub-thread", "host adapter must preserve thread id from stream");
    assert(result.response?.generated_by === "current_cli_agent_main_model", "host response JSON should be parsed");
    assert(result.response?.request_id === "verify-request", "host response request id mismatch");

    const captured = await readFile(promptCapture, "utf8");
    assert(captured.includes("INPUT_JSON"), "adapter must send selected context through stdin");
    assert(captured.includes("season_catalog"), "adapter prompt must include selected season catalog when supplied");
    assert(captured.includes("daily_big_data"), "adapter prompt must include selected big-data context when supplied");
    assert(captured.includes("user_preferences"), "adapter prompt must include selected user preferences when supplied");
    const hostAgentsText = await readFile(path.join(tempRoot, "AGENTS.md"), "utf8");
    assert(hostAgentsText.includes("JCC Runtime owns durable game state"), "host workspace AGENTS must summarize JCC runtime ownership");
    assert(hostAgentsText.includes(".codex/skills/jcc-runtime-agent/SKILL.md"), "host workspace AGENTS must point to the JCC runtime skill contract");
    assert(hostAgentsText.includes("Do not load or rely on user-global Codex skills"), "host workspace AGENTS must forbid global skill reliance");
    assert(hostAgentsText.includes("INPUT_JSON selected context"), "host workspace AGENTS must require selected context");
    const envCaptured = JSON.parse(await readFile(envCapture, "utf8"));
    assert(envCaptured.JCC_HOST_CLI_CLEAN_CODEX_HOME === "1", "Codex host run must mark clean CODEX_HOME");
    assert(envCaptured.CODEX_HOME.startsWith(path.join(runtimeCodexHome, "runs")), "Codex host run must use an isolated per-run JCC runtime CODEX_HOME");
    assert(envCaptured.argv.includes("--ephemeral"), "Codex host run must be ephemeral");
    assert(!envCaptured.argv.includes("--ignore-user-config"), "Codex host run must not discard sanitized model/provider config");
    assert(!envCaptured.argv.includes("resume"), "Codex host run must not use resume session memory");
    assert(!envCaptured.CODEX_HOME.endsWith(path.join(".codex")), "Codex host run must not use the user's normal CODEX_HOME");
    const cleanConfig = envCaptured.clean_config || "";
    assert(cleanConfig.includes("JCC Runtime clean Codex home"), "clean Codex home must write a runtime-owned config");
    assert(cleanConfig.includes('model_provider = "stub_provider"'), "clean Codex home must preserve model_provider");
    assert(cleanConfig.includes('model = "stub-model"'), "clean Codex home must preserve selected model");
    assert(cleanConfig.includes("[model_providers.stub_provider]"), "clean Codex home must preserve model provider table");
    assert(!cleanConfig.includes("developer_instructions"), "clean Codex home must not copy user developer instructions");
    assert(!cleanConfig.includes("[mcp_servers"), "clean Codex home config must not copy user MCP servers");
    assert(!cleanConfig.includes("[plugins"), "clean Codex home config must not copy user plugins");
    assert(!cleanConfig.includes("[features]"), "clean Codex home config must not copy user feature toggles");
    for (const dirName of ["skills", "hooks", "plugins", "prompts", "agents", "rules"]) {
      const exists = await access(path.join(envCaptured.CODEX_HOME, dirName)).then(() => true, () => false);
      assert(!exists, `clean Codex home must not contain ${dirName}`);
    }

    const noisyCodex = path.join(tempRoot, "fake-codex-noisy-fail.mjs");
    await writeFile(noisyCodex, `
process.stderr.write("\\u001b[2m2026-06-21T07:33:19.383698Z\\u001b[0m \\u001b[31mERROR\\u001b[0m \\u001b[2mcodex_core::session::session\\u001b[0m\\u001b[2m:\\u001b[0m failed to load skill G:\\\\OneDrive\\\\skill\\\\SKILL.md: missing YAML frontmatter delimited by ---\\n");
process.stderr.write("\\u001b[2m2026-06-21T07:33:19.406681Z\\u001b[0m \\u001b[33m WARN\\u001b[0m \\u001b[2mcodex_core::shell_snapshot\\u001b[0m\\u001b[2m:\\u001b[0m Failed to create shell snapshot for powershell: Shell snapshot not supported yet for PowerShell\\n");
process.exit(1);
`, "utf8");
    const noisyResult = await runHostAgentRequest({
      provider: "codex",
      spawn_command: process.execPath,
      spawn_prefix_args: [noisyCodex],
      selected_model: null,
      reasoning_effort: null,
    }, "hello", {
      parseJson: true,
      repoRoot: process.cwd(),
      taskId: "verify-noisy-stderr",
      timeoutMs: 10000,
      hostCwd: tempRoot,
    });
    assert(noisyResult.ok === false, "noisy failing host should fail");
    assert(noisyResult.error === "Host CLI exited 1", `diagnostic-only stderr should be hidden from user error: ${noisyResult.error}`);
    assert(!noisyResult.error.includes("codex_core::session::session"), "user error must not expose Codex skill-load diagnostics");
    assert(!noisyResult.error.includes("Shell snapshot not supported"), "user error must not expose shell snapshot diagnostics");
    assert(String(noisyResult.stderr || "").includes("codex_core::session::session"), "raw stderr should remain available for debug logs");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      checked: [
        "codex-json-event-stream-stub",
        "stdin-selected-context",
        "host-workspace-agents-runtime-summary",
        "agent-message-json-parse",
        "thread-id-preserved",
        "clean-codex-home",
        "codex-sanitized-model-config",
        "codex-model-provider-config-preserved",
        "codex-ephemeral",
        "diagnostic-stderr-hidden-from-user-error",
      ],
    }, null, 2)}\n`);
  } finally {
    delete process.env.JCC_HOST_STUB_CAPTURE;
    delete process.env.JCC_HOST_STUB_ENV_CAPTURE;
    if (previousSourceCodexHome === undefined) delete process.env.JCC_SOURCE_CODEX_HOME;
    else process.env.JCC_SOURCE_CODEX_HOME = previousSourceCodexHome;
    if (previousRuntimeCodexHome === undefined) delete process.env.JCC_CODEX_RUNTIME_HOME;
    else process.env.JCC_CODEX_RUNTIME_HOME = previousRuntimeCodexHome;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
