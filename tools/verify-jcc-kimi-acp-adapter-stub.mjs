import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runHostAgentRequest } from "../ui/electron/host-adapters.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-kimi-acp-"));
  const promptCaptureFile = path.join(tempRoot, "prompt.txt");
  const promptJsonCaptureFile = path.join(tempRoot, "prompt.json");
  const imageFile = path.join(tempRoot, "choice.png");
  const envCaptureFile = path.join(tempRoot, "env.json");
  const argvCaptureFile = path.join(tempRoot, "argv.txt");
  const modelCaptureFile = path.join(tempRoot, "model.txt");
  const fakeKimi = path.join(tempRoot, "fake-kimi-acp.mjs");
  const fakeLauncher = path.join(tempRoot, process.platform === "win32" ? "fake-kimi.cmd" : "fake-kimi");
  await mkdir(tempRoot, { recursive: true });
  await writeFile(imageFile, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l0e0dAAAAABJRU5ErkJggg==", "base64"));
  await writeFile(fakeKimi, `
import { appendFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const promptCaptureFile = ${JSON.stringify(promptCaptureFile)};
const promptJsonCaptureFile = ${JSON.stringify(promptJsonCaptureFile)};
const envCaptureFile = ${JSON.stringify(envCaptureFile)};
const modelCaptureFile = ${JSON.stringify(modelCaptureFile)};
const rl = readline.createInterface({ input: process.stdin });
writeFileSync(envCaptureFile, JSON.stringify({
  cwd: process.cwd(),
  JCC_HOST_CLI_SELECTED_CONTEXT_MODE: process.env.JCC_HOST_CLI_SELECTED_CONTEXT_MODE || null,
  KIMI_MODEL_THINKING_EFFORT: process.env.KIMI_MODEL_THINKING_EFFORT || null,
  CODEX_HOME: process.env.CODEX_HOME || null,
}, null, 2), "utf8");

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: "stub-acp-v1",
      agentCapabilities: {
        promptCapabilities: {
          image: true,
          embeddedContext: true
        }
      }
    });
    return;
  }
  if (message.method === "session/new") {
    respond(message.id, {
      sessionId: "stub-kimi-session",
      configOptions: [{
        type: "select",
        id: "model",
        currentValue: "kimi-code/kimi-for-coding",
        options: [
          { value: "kimi-code/kimi-for-coding", name: "K2.7 Code" },
          { value: "kimi-code/kimi-for-coding-highspeed", name: "K2.7 Code HighSpeed" },
          { value: "kimi-code/k3", name: "K3" }
        ]
      }]
    });
    return;
  }
  if (message.method === "session/set_config_option") {
    writeFileSync(modelCaptureFile, String(message.params?.value || ""), "utf8");
    respond(message.id, { configOptions: [{ id: "model", currentValue: message.params?.value }] });
    return;
  }
  if (message.method === "session/prompt") {
    const prompt = message.params?.prompt || [];
    const text = prompt.find((block) => block?.type === "text")?.text || "";
    writeFileSync(promptJsonCaptureFile, JSON.stringify(prompt, null, 2), "utf8");
    writeFileSync(promptCaptureFile, text, "utf8");
    respond(message.id, {
      final_text: JSON.stringify({
        schema: "jcc-host-cli-coach-response-v1",
        generated_by: "current_cli_agent_main_model",
        final_text: "Kimi ACP stub received selected JCC context",
        recommended_action: "continue",
        confidence: "high",
        followup_question: text.includes("runtime_context") ? null : "runtime_context missing",
      }),
    });
    rl.close();
    setImmediate(() => process.exit(0));
    return;
  }
  appendFileSync(promptCaptureFile, "\\nUNHANDLED:" + message.method, "utf8");
  respond(message.id, {});
});
`, "utf8");
  const launcherContent = process.platform === "win32"
    ? [
        "@echo off",
        `echo %* > ${JSON.stringify(argvCaptureFile)}`,
        `"${process.execPath}" ${JSON.stringify(fakeKimi)}`,
        "",
      ].join("\r\n")
    : [
        "#!/usr/bin/env sh",
        `printf '%s\\n' "$*" > ${JSON.stringify(argvCaptureFile)}`,
        `${JSON.stringify(process.execPath)} ${JSON.stringify(fakeKimi)}`,
        "",
      ].join("\n");
  await writeFile(fakeLauncher, launcherContent, "utf8");
  if (process.platform !== "win32") await chmod(fakeLauncher, 0o755);

  try {
    const result = await runHostAgentRequest({
      provider: "kimi",
      available: true,
      command: fakeLauncher,
      build_args: ["acp"],
      selected_model: "kimi-code/k3",
      reasoning_effort: "max",
    }, [
      "You are the JCC Runtime host model.",
      "runtime_context: selected_context_policy=season_catalog_on_lineup_questions",
      "User: 给我一套当前赛季阵容。",
    ].join("\\n"), {
      parseJson: true,
      repoRoot: path.resolve(import.meta.dirname, ".."),
      hostCwd: tempRoot,
      imagePaths: [imageFile],
      timeoutMs: 30000,
    });

    assert(result.ok === true, `Kimi ACP stub should succeed: ${result.error || ""}`);
    const prompt = await readFile(promptCaptureFile, "utf8");
    const promptBlocks = JSON.parse(await readFile(promptJsonCaptureFile, "utf8"));
    const envCapture = JSON.parse(await readFile(envCaptureFile, "utf8"));
    const argvCapture = await readFile(argvCaptureFile, "utf8");
    const selectedSessionModel = await readFile(modelCaptureFile, "utf8");
    assert(result.completed_from === "acp_json_rpc", "Kimi adapter must complete from ACP JSON-RPC");
    assert(/--model\s+kimi-code\/k3\s+acp/.test(argvCapture), "Kimi ACP launcher must receive the selected model before the acp subcommand");
    assert(selectedSessionModel === "kimi-code/k3", "Kimi ACP session must apply the selected model through session/set_config_option before prompting");
    assert(result.session_id === "stub-kimi-session", "Kimi adapter must keep ACP session id");
    assert(result.response?.schema === "jcc-host-cli-coach-response-v1", "Kimi adapter must parse the canonical coach response");
    assert(result.response?.followup_question === null, "Kimi adapter must pass selected runtime context");
    assert(prompt.includes("runtime_context"), "fake Kimi must receive prompt text");
    assert(Array.isArray(promptBlocks), "Kimi ACP prompt must be sent as content blocks");
    assert(promptBlocks.some((block) => block?.type === "text" && block.text?.includes("runtime_context")), "Kimi ACP prompt must include a text content block");
    const imageBlock = promptBlocks.find((block) => block?.type === "image");
    assert(imageBlock, "Kimi ACP prompt must include an image content block when imagePaths are present");
    assert(imageBlock.mimeType === "image/png", "Kimi ACP image block must include the PNG mime type");
    assert(typeof imageBlock.data === "string" && imageBlock.data.length > 20, "Kimi ACP image block must include base64 data");
    assert(path.resolve(envCapture.cwd) === path.resolve(tempRoot), "Kimi ACP must run inside the JCC host workspace");
    assert(envCapture.JCC_HOST_CLI_SELECTED_CONTEXT_MODE === "1", "Kimi ACP must be marked as selected-context host mode");
    assert(envCapture.KIMI_MODEL_THINKING_EFFORT === "max", "Kimi ACP must receive the provider-advertised K3 max thinking effort through the official CLI environment contract");
    assert(envCapture.CODEX_HOME !== tempRoot, "Kimi ACP must not reuse Codex-specific clean home as its runtime home");
  } finally {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  await verifySelectedModelIsReappliedWhenAlreadyCurrent();
  await verifySelectedModelMustBeConfirmed();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked: [
      "kimi-acp-json-rpc-launch",
      "selected-kimi-model-cli-arg",
      "selected-kimi-model-session-config",
      "selected-kimi-model-session-config-always-applied",
      "selected-kimi-model-session-confirmation-required",
      "selected-kimi-k3-reasoning-effort-env",
      "session-new",
      "session-prompt",
      "host-workspace-cwd",
      "selected-context-mode-env",
      "selected-context-transport",
      "image-content-block-transport",
      "json-response-parse",
    ],
  }, null, 2)}\n`);
}

async function verifySelectedModelIsReappliedWhenAlreadyCurrent() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-kimi-acp-model-current-"));
  const traceFile = path.join(tempRoot, "trace.txt");
  const fakeKimi = path.join(tempRoot, "fake-kimi-acp-current.mjs");
  const fakeLauncher = path.join(tempRoot, process.platform === "win32" ? "fake-kimi.cmd" : "fake-kimi");
  await writeFile(fakeKimi, `
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const traceFile = ${JSON.stringify(traceFile)};
const rl = readline.createInterface({ input: process.stdin });
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    respond(message.id, { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } });
    return;
  }
  if (message.method === "session/new") {
    respond(message.id, {
      sessionId: "stub-current-session",
      configOptions: [{
        id: "model",
        currentValue: "kimi-code/kimi-for-coding-highspeed",
        options: [{ value: "kimi-code/kimi-for-coding-highspeed" }]
      }]
    });
    return;
  }
  if (message.method === "session/set_config_option") {
    appendFileSync(traceFile, "set_config\\n", "utf8");
    respond(message.id, { configOptions: [{ id: "model", currentValue: message.params?.value }] });
    return;
  }
  if (message.method === "session/prompt") {
    appendFileSync(traceFile, "prompt\\n", "utf8");
    respond(message.id, { final_text: JSON.stringify({
      schema: "jcc-host-cli-coach-response-v1",
      generated_by: "current_cli_agent_main_model",
      final_text: "OK",
      recommended_action: "continue",
      confidence: "high",
      followup_question: null,
    }) });
    return;
  }
  respond(message.id, {});
});
`, "utf8");
  const launcherContent = process.platform === "win32"
    ? ["@echo off", `"${process.execPath}" ${JSON.stringify(fakeKimi)}`, ""].join("\r\n")
    : ["#!/usr/bin/env sh", `${JSON.stringify(process.execPath)} ${JSON.stringify(fakeKimi)}`, ""].join("\n");
  await writeFile(fakeLauncher, launcherContent, "utf8");
  if (process.platform !== "win32") await chmod(fakeLauncher, 0o755);

  try {
    const result = await runHostAgentRequest({
      provider: "kimi",
      available: true,
      command: fakeLauncher,
      build_args: ["acp"],
      selected_model: "kimi-code/kimi-for-coding-highspeed",
    }, "Reply OK.", {
      repoRoot: path.resolve(import.meta.dirname, ".."),
      hostCwd: tempRoot,
      timeoutMs: 30000,
    });
    assert(result.ok === true, `Kimi ACP should succeed after explicit session model confirmation: ${result.error || ""}`);
    const trace = (await readFile(traceFile, "utf8")).trim().split(/\r?\n/);
    assert(trace.join(",") === "set_config,prompt", `Kimi ACP must set and confirm the selected model before prompt, got: ${trace.join(",")}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function verifySelectedModelMustBeConfirmed() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-kimi-acp-model-confirm-"));
  const promptMarker = path.join(tempRoot, "prompt-called.txt");
  const fakeKimi = path.join(tempRoot, "fake-kimi-acp-no-confirm.mjs");
  const fakeLauncher = path.join(tempRoot, process.platform === "win32" ? "fake-kimi.cmd" : "fake-kimi");
  await writeFile(fakeKimi, `
import { writeFileSync } from "node:fs";
import readline from "node:readline";
const promptMarker = ${JSON.stringify(promptMarker)};
const rl = readline.createInterface({ input: process.stdin });
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    respond(message.id, { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } });
    return;
  }
  if (message.method === "session/new") {
    respond(message.id, {
      sessionId: "stub-no-confirm-session",
      configOptions: [{
        id: "model",
        currentValue: "kimi-code/kimi-for-coding",
        options: [{ value: "kimi-code/kimi-for-coding-highspeed" }]
      }]
    });
    return;
  }
  if (message.method === "session/set_config_option") {
    respond(message.id, { configOptions: [] });
    return;
  }
  if (message.method === "session/prompt") {
    writeFileSync(promptMarker, "called", "utf8");
    respond(message.id, { final_text: JSON.stringify({
      schema: "jcc-host-cli-coach-response-v1",
      generated_by: "current_cli_agent_main_model",
      final_text: "should not run",
      recommended_action: "continue",
      confidence: "high",
      followup_question: null,
    }) });
    return;
  }
  respond(message.id, {});
});
`, "utf8");
  const launcherContent = process.platform === "win32"
    ? ["@echo off", `"${process.execPath}" ${JSON.stringify(fakeKimi)}`, ""].join("\r\n")
    : ["#!/usr/bin/env sh", `${JSON.stringify(process.execPath)} ${JSON.stringify(fakeKimi)}`, ""].join("\n");
  await writeFile(fakeLauncher, launcherContent, "utf8");
  if (process.platform !== "win32") await chmod(fakeLauncher, 0o755);

  try {
    const result = await runHostAgentRequest({
      provider: "kimi",
      available: true,
      command: fakeLauncher,
      build_args: ["acp"],
      selected_model: "kimi-code/kimi-for-coding-highspeed",
    }, "Return JSON.", {
      repoRoot: path.resolve(import.meta.dirname, ".."),
      hostCwd: tempRoot,
      timeoutMs: 30000,
    });
    assert(result.ok === false, "Kimi ACP must fail when it does not confirm the selected model");
    assert(/did not confirm selected session model/i.test(result.error || ""), `missing model confirmation must be explicit, got: ${result.error}`);
    const promptWasCalled = await readFile(promptMarker, "utf8").then(() => true).catch(() => false);
    assert(promptWasCalled === false, "Kimi ACP must not prompt before selected model confirmation");
  } finally {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
