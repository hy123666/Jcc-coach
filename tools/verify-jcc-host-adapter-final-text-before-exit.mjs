import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runHostAgentRequest } from "../ui/electron/host-adapters.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertRecordedProcessStopped(pidFile, label) {
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  for (let attempt = 0; attempt < 20 && processIsAlive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(!processIsAlive(pid), `${label} process ${pid} must be stopped before the adapter resolves`);
}

async function removeTempRoot(tempRoot) {
  try {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (error) {
    if (process.platform === "win32" && ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(error?.code)) return;
    throw error;
  }
}

function hostResponse(requestId, requestHash, text) {
  return {
    schema: "jcc-host-cli-coach-response-v1",
    generated_by: "current_cli_agent_main_model",
    request_id: requestId,
    request_hash: requestHash,
    final_text: text,
    recommended_action: "show_host_answer",
    confidence: "medium",
    followup_question: null,
  };
}

async function writeLauncher(tempRoot, name, scriptPath) {
  const launcher = path.join(tempRoot, process.platform === "win32" ? `${name}.cmd` : name);
  const content = process.platform === "win32"
    ? ["@echo off", `"${process.execPath}" ${JSON.stringify(scriptPath)}`, ""].join("\r\n")
    : ["#!/usr/bin/env sh", `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`, ""].join("\n");
  await writeFile(launcher, content, "utf8");
  if (process.platform !== "win32") await chmod(launcher, 0o755);
  return launcher;
}

async function verifyCodexCompletesBeforeProcessExit(tempRoot) {
  const fakeCodex = path.join(tempRoot, "fake-codex-hangs-after-final.mjs");
  const pidFile = path.join(tempRoot, "fake-codex-hangs-after-final.pid");
  const response = hostResponse("verify-codex-final-before-exit", "verify-codex-hash", "Codex final text should deliver before process close.");
  const responseWithTrailingDiagnostic = `${JSON.stringify(response)}${JSON.stringify({ diagnostic: true })}`;
  await writeFile(fakeCodex, `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-hang-thread" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(responseWithTrailingDiagnostic)} } }) + "\\n");
setInterval(() => {}, 1000);
`, "utf8");

  const result = await runHostAgentRequest({
    provider: "codex",
    spawn_command: process.execPath,
    spawn_prefix_args: [fakeCodex],
    available: true,
  }, "Return JSON.", {
    parseJson: true,
    repoRoot: path.resolve(import.meta.dirname, ".."),
    hostCwd: tempRoot,
    taskId: "verify-codex-final-before-exit",
    timeoutMs: 1200,
  });

  assert(result.ok === true, `Codex adapter must complete from final event before process exit: ${result.error || ""}`);
  assert(result.response?.request_id === response.request_id, "Codex final response request_id mismatch");
  assert(result.host_transport_diagnostics?.category === "host_transport_non_contract_text", "Codex trailing provider output must be quarantined as transport diagnostics");
  assert(result.host_transport_diagnostics?.trailing?.includes("diagnostic"), "Codex transport diagnostics must preserve bounded trailing evidence");
  assert(result.completed_from === "json_event_stream", `Codex completed_from should preserve the adapter protocol, got ${result.completed_from}`);
  assert(result.completion_trigger === "item.completed.agent_message", `Codex completion_trigger should show stream-final delivery, got ${result.completion_trigger}`);
  await assertRecordedProcessStopped(pidFile, "Codex final-response host");
}

async function verifyKimiCompletesBeforeProcessExit(tempRoot) {
  const fakeKimi = path.join(tempRoot, "fake-kimi-hangs-after-final.mjs");
  const pidFile = path.join(tempRoot, "fake-kimi-hangs-after-final.pid");
  const response = hostResponse("verify-kimi-final-before-exit", "verify-kimi-hash", "Kimi final text should deliver before ACP process close.");
  const responseWithTrailingDiagnostic = `${JSON.stringify(response)}${JSON.stringify({ diagnostic: true })}`;
  await writeFile(fakeKimi, `
import { writeFileSync } from "node:fs";
import readline from "node:readline";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "kimi-hang-session", configOptions: [] } });
    return;
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: ${JSON.stringify(responseWithTrailingDiagnostic)} } } } });
    setInterval(() => {}, 1000);
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`, "utf8");
  const launcher = await writeLauncher(tempRoot, "fake-kimi-hangs-after-final", fakeKimi);

  const result = await runHostAgentRequest({
    provider: "kimi",
    available: true,
    command: launcher,
    build_args: ["acp"],
    kimi_home: path.join(tempRoot, ".kimi-code"),
  }, "Return JSON.", {
    parseJson: true,
    repoRoot: path.resolve(import.meta.dirname, ".."),
    hostCwd: tempRoot,
    taskId: "verify-kimi-final-before-exit",
    timeoutMs: 1800,
  });

  assert(result.ok === true, `Kimi adapter must complete from final ACP message before process exit: ${result.error || ""}`);
  assert(result.response?.request_id === response.request_id, "Kimi final response request_id mismatch");
  assert(result.host_transport_diagnostics?.category === "host_transport_non_contract_text", "Kimi trailing provider output must be quarantined as transport diagnostics");
  assert(result.host_transport_diagnostics?.trailing?.includes("diagnostic"), "Kimi transport diagnostics must preserve bounded trailing evidence");
  assert(result.completed_from === "acp_json_rpc", `Kimi completed_from should preserve the adapter protocol, got ${result.completed_from}`);
  assert(
    ["session_prompt_result", "agent_message_chunk", "agent_message_chunk_parseable", "session_prompt_completed_after_stream"].includes(result.completion_trigger),
    `Kimi completion_trigger should show ACP final-text delivery before process exit, got ${result.completion_trigger}`,
  );
  await assertRecordedProcessStopped(pidFile, "Kimi final-response host");
}

async function verifyKimiPromptCompletionBarrierPrefersStream(tempRoot) {
  const fakeKimi = path.join(tempRoot, "fake-kimi-stream-before-prompt-result.mjs");
  const pidFile = path.join(tempRoot, "fake-kimi-stream-before-prompt-result.pid");
  const promptResponse = hostResponse("prompt-result", "verify-kimi-race-hash", "Prompt result is fallback only.");
  const streamResponse = hostResponse("stream", "verify-kimi-race-hash", "ACP stream is authoritative.");
  await writeFile(fakeKimi, `
import { writeFileSync } from "node:fs";
import readline from "node:readline";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "kimi-early-prompt-late-stream-session", configOptions: [] } });
    return;
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: ${JSON.stringify(JSON.stringify(streamResponse))} } } } });
    send({ jsonrpc: "2.0", id: message.id, result: { content: { text: ${JSON.stringify(JSON.stringify(promptResponse))} }, stopReason: "end_turn" } });
    setInterval(() => {}, 1000);
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`, "utf8");
  const launcher = await writeLauncher(tempRoot, "fake-kimi-stream-before-prompt-result", fakeKimi);

  const previousDebounce = process.env.JCC_KIMI_ACP_STREAM_FINAL_DEBOUNCE_MS;
  process.env.JCC_KIMI_ACP_STREAM_FINAL_DEBOUNCE_MS = "1000";
  try {
    const result = await runHostAgentRequest({
      provider: "kimi",
      available: true,
      command: launcher,
      build_args: ["acp"],
      kimi_home: path.join(tempRoot, ".kimi-code"),
    }, "Return JSON.", {
      parseJson: true,
      repoRoot: path.resolve(import.meta.dirname, ".."),
      hostCwd: tempRoot,
      taskId: "verify-kimi-stream-before-prompt-result",
      timeoutMs: 2200,
    });

    assert(result.ok === true, `Kimi prompt completion barrier should complete successfully: ${result.error || ""}`);
    assert(result.response?.request_id === "stream", `Kimi stream must beat conflicting prompt-result fallback, got ${result.response?.request_id || "missing"}`);
    assert(result.text?.includes('"request_id":"stream"'), "Kimi final text must come from ACP stream content");
    assert(
      ["session_prompt_completed_after_stream", "agent_message_chunk_parseable", "process_close_stream_text"].includes(result.completion_trigger),
      `Kimi prompt completion barrier trigger mismatch: ${result.completion_trigger}`,
    );
    await assertRecordedProcessStopped(pidFile, "Kimi stream-before-prompt-result host");
  } finally {
    if (previousDebounce === undefined) delete process.env.JCC_KIMI_ACP_STREAM_FINAL_DEBOUNCE_MS;
    else process.env.JCC_KIMI_ACP_STREAM_FINAL_DEBOUNCE_MS = previousDebounce;
  }
}

async function verifyKimiPromptResultOnlyHungChildCompletesBounded(tempRoot) {
  const fakeKimi = path.join(tempRoot, "fake-kimi-prompt-result-only-hangs.mjs");
  const pidFile = path.join(tempRoot, "fake-kimi-prompt-result-only-hangs.pid");
  const response = hostResponse("verify-kimi-prompt-result-only", "verify-kimi-result-only-hash", "Prompt result should complete without waiting for process close.");
  await writeFile(fakeKimi, `
import { writeFileSync } from "node:fs";
import readline from "node:readline";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "kimi-prompt-result-only-session", configOptions: [] } });
    return;
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: message.id, result: { content: { text: ${JSON.stringify(JSON.stringify(response))} } } });
    setInterval(() => {}, 1000);
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`, "utf8");
  const launcher = await writeLauncher(tempRoot, "fake-kimi-prompt-result-only-hangs", fakeKimi);

  const startedAt = Date.now();
  const result = await runHostAgentRequest({
    provider: "kimi",
    available: true,
    command: launcher,
    build_args: ["acp"],
    kimi_home: path.join(tempRoot, ".kimi-code"),
  }, "Return JSON.", {
    parseJson: true,
    repoRoot: path.resolve(import.meta.dirname, ".."),
    hostCwd: tempRoot,
    taskId: "verify-kimi-prompt-result-only-hangs",
    timeoutMs: 1800,
  });
  const elapsedMs = Date.now() - startedAt;

  assert(result.ok === true, `Kimi prompt-result-only response should complete successfully: ${result.error || ""}`);
  assert(result.response?.request_id === response.request_id, "Kimi prompt-result-only response request_id mismatch");
  assert(result.completion_trigger === "session_prompt_result", `Kimi prompt-result-only completion trigger mismatch: ${result.completion_trigger}`);
  assert(elapsedMs < 1700, `Kimi prompt-result-only completion must be bounded before timeout, took ${elapsedMs}ms`);
  await assertRecordedProcessStopped(pidFile, "Kimi prompt-result-only host");
}

async function verifyKimiNonZeroExitAfterValidStreamRecoversAnswer(tempRoot) {
  const fakeKimi = path.join(tempRoot, "fake-kimi-valid-stream-then-exit-one.mjs");
  const pidFile = path.join(tempRoot, "fake-kimi-valid-stream-then-exit-one.pid");
  const response = hostResponse("verify-kimi-valid-before-exit-one", "verify-kimi-exit-one-hash", "Valid stream must survive a later non-zero process exit.");
  await writeFile(fakeKimi, `
import { writeFileSync } from "node:fs";
import readline from "node:readline";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "kimi-valid-before-exit-one-session", configOptions: [] } });
    return;
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: ${JSON.stringify(JSON.stringify(response))} } } } });
    process.stderr.write("provider cleanup failed after final response\\n");
    setTimeout(() => process.exit(1), 10);
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`, "utf8");
  const launcher = await writeLauncher(tempRoot, "fake-kimi-valid-stream-then-exit-one", fakeKimi);

  const previousDebounce = process.env.JCC_KIMI_ACP_STREAM_FINAL_DEBOUNCE_MS;
  process.env.JCC_KIMI_ACP_STREAM_FINAL_DEBOUNCE_MS = "1000";
  try {
    const result = await runHostAgentRequest({
      provider: "kimi",
      available: true,
      command: launcher,
      build_args: ["acp"],
      kimi_home: path.join(tempRoot, ".kimi-code"),
    }, "Return JSON.", {
      parseJson: true,
      repoRoot: path.resolve(import.meta.dirname, ".."),
      hostCwd: tempRoot,
      taskId: "verify-kimi-valid-stream-then-exit-one",
      timeoutMs: 1800,
    });

    assert(result.ok === true, `Kimi valid stream must survive exit 1: ${result.error || ""}`);
    assert(result.response?.request_id === response.request_id, "Kimi exit-1 recovery response request_id mismatch");
    assert(result.completion_trigger === "process_close_stream_text", `Kimi exit-1 recovery trigger mismatch: ${result.completion_trigger}`);
    assert(result.host_transport_diagnostics?.category === "host_transport_nonzero_exit_after_valid_response", "Kimi exit-1 recovery must retain a typed transport diagnostic");
    assert(result.host_transport_diagnostics?.trailing?.includes("exited 1"), "Kimi exit-1 recovery diagnostic must retain the bounded exit code");
    await assertRecordedProcessStopped(pidFile, "Kimi valid-stream exit-one host");
  } finally {
    if (previousDebounce === undefined) delete process.env.JCC_KIMI_ACP_STREAM_FINAL_DEBOUNCE_MS;
    else process.env.JCC_KIMI_ACP_STREAM_FINAL_DEBOUNCE_MS = previousDebounce;
  }
}

async function verifyKimiInvalidStreamFallsBackToValidPromptResult(tempRoot) {
  const fakeKimi = path.join(tempRoot, "fake-kimi-invalid-stream-valid-prompt-result.mjs");
  const pidFile = path.join(tempRoot, "fake-kimi-invalid-stream-valid-prompt-result.pid");
  const response = hostResponse(
    "verify-kimi-valid-prompt-fallback",
    "verify-kimi-valid-prompt-fallback-hash",
    "A valid prompt result must survive an earlier malformed stream fragment.",
  );
  await writeFile(fakeKimi, `
import { writeFileSync } from "node:fs";
import readline from "node:readline";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "kimi-invalid-stream-valid-prompt-session", configOptions: [] } });
    return;
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "{not-json" } } } });
    send({ jsonrpc: "2.0", id: message.id, result: { content: { text: ${JSON.stringify(JSON.stringify(response))} }, stopReason: "end_turn" } });
    setTimeout(() => process.exit(1), 50);
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`, "utf8");
  const launcher = await writeLauncher(tempRoot, "fake-kimi-invalid-stream-valid-prompt-result", fakeKimi);

  const result = await runHostAgentRequest({
    provider: "kimi",
    available: true,
    command: launcher,
    build_args: ["acp"],
    kimi_home: path.join(tempRoot, ".kimi-code"),
  }, "Return JSON.", {
    parseJson: true,
    repoRoot: path.resolve(import.meta.dirname, ".."),
    hostCwd: tempRoot,
    taskId: "verify-kimi-invalid-stream-valid-prompt-result",
    timeoutMs: 1800,
  });

  assert(result.ok === true, `Kimi must fall back from malformed stream to valid prompt result: ${result.error || ""}`);
  assert(result.response?.request_id === response.request_id, "Kimi valid prompt fallback response request_id mismatch");
  assert(
    ["session_prompt_result_after_invalid_stream", "process_close_prompt_result"].includes(result.completion_trigger),
    `Kimi valid prompt fallback trigger mismatch: ${result.completion_trigger}`,
  );
  await assertRecordedProcessStopped(pidFile, "Kimi invalid-stream valid-prompt-result host");
}

async function verifyKimiMalformedJsonCompletesBeforeTimeout(tempRoot) {
  const fakeKimi = path.join(tempRoot, "fake-kimi-malformed-json-hangs.mjs");
  await writeFile(fakeKimi, `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "kimi-malformed-json-session", configOptions: [] } });
    return;
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "{not-json" } } } });
    setTimeout(() => process.exit(0), 700);
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`, "utf8");
  const launcher = await writeLauncher(tempRoot, "fake-kimi-malformed-json-hangs", fakeKimi);

  const result = await runHostAgentRequest({
    provider: "kimi",
    available: true,
    command: launcher,
    build_args: ["acp"],
    kimi_home: path.join(tempRoot, ".kimi-code"),
  }, "Return JSON.", {
    parseJson: true,
    repoRoot: path.resolve(import.meta.dirname, ".."),
    hostCwd: tempRoot,
    taskId: "verify-kimi-malformed-json-before-timeout",
    timeoutMs: 1800,
  });

  assert(result.ok === false, "Kimi malformed JSON response should fail explicitly");
  assert(
    /could not be parsed as the required JSON|Unexpected end of JSON input|JSON/i.test(result.error || ""),
    `Kimi malformed JSON should report parse failure, got ${result.error || ""}`,
  );
  assert(!/timed out/i.test(result.error || ""), `Kimi malformed JSON must not be reported as timeout, got ${result.error || ""}`);
  assert(result.completed_from === undefined || result.completed_from === "acp_json_rpc", `Kimi malformed JSON completion source mismatch: ${result.completed_from}`);
}

async function verifyKimiSplitJsonChunksWaitForCompleteParse(tempRoot) {
  const fakeKimi = path.join(tempRoot, "fake-kimi-split-json-delayed.mjs");
  const pidFile = path.join(tempRoot, "fake-kimi-split-json-delayed.pid");
  const response = hostResponse("verify-kimi-split-json", "verify-kimi-split-hash", "Kimi split JSON should wait for complete chunks.");
  const fullText = JSON.stringify(response);
  const first = fullText.slice(0, Math.floor(fullText.length / 2));
  const second = fullText.slice(Math.floor(fullText.length / 2));
  await writeFile(fakeKimi, `
import { writeFileSync } from "node:fs";
import readline from "node:readline";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "kimi-split-json-session", configOptions: [] } });
    return;
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: ${JSON.stringify(first)} } } } });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: ${JSON.stringify(second)} } } } });
      setInterval(() => {}, 1000);
    }, 650);
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`, "utf8");
  const launcher = await writeLauncher(tempRoot, "fake-kimi-split-json-delayed", fakeKimi);

  const previousDebounce = process.env.JCC_KIMI_ACP_STREAM_FINAL_DEBOUNCE_MS;
  process.env.JCC_KIMI_ACP_STREAM_FINAL_DEBOUNCE_MS = "100";
  try {
    const result = await runHostAgentRequest({
      provider: "kimi",
      available: true,
      command: launcher,
      build_args: ["acp"],
      kimi_home: path.join(tempRoot, ".kimi-code"),
    }, "Return JSON.", {
      parseJson: true,
      repoRoot: path.resolve(import.meta.dirname, ".."),
      hostCwd: tempRoot,
      taskId: "verify-kimi-split-json-delayed",
      timeoutMs: 2500,
    });

    assert(result.ok === true, `Kimi split JSON chunks should not fail on the first incomplete chunk: ${result.error || ""}`);
    assert(result.response?.request_id === response.request_id, "Kimi split JSON final response request_id mismatch");
    assert(
      ["agent_message_chunk_parseable", "timeout_recovered_stream_text"].includes(result.completion_trigger),
      `Kimi split JSON completion trigger mismatch: ${result.completion_trigger}`,
    );
    await assertRecordedProcessStopped(pidFile, "Kimi split-response host");
  } finally {
    if (previousDebounce === undefined) delete process.env.JCC_KIMI_ACP_STREAM_FINAL_DEBOUNCE_MS;
    else process.env.JCC_KIMI_ACP_STREAM_FINAL_DEBOUNCE_MS = previousDebounce;
  }
}

async function verifyKimiVisualWaitsForKindSpecificJson(tempRoot) {
  const fakeKimi = path.join(tempRoot, "fake-kimi-visual-after-diagnostic.mjs");
  const pidFile = path.join(tempRoot, "fake-kimi-visual-after-diagnostic.pid");
  const diagnostic = JSON.stringify({ provider_status: "streaming" });
  const visual = JSON.stringify({
    observations: [{ kind: "augment", text: "visual candidate" }],
    confidence: 0.91,
  });
  await writeFile(fakeKimi, `
import { writeFileSync } from "node:fs";
import readline from "node:readline";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "kimi-visual-kind-session", configOptions: [] } });
    return;
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: ${JSON.stringify(diagnostic)} } } } });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: ${JSON.stringify(visual)} } } } });
      setInterval(() => {}, 1000);
    }, 650);
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`, "utf8");
  const launcher = await writeLauncher(tempRoot, "fake-kimi-visual-after-diagnostic", fakeKimi);

  const previousDebounce = process.env.JCC_KIMI_ACP_STREAM_FINAL_DEBOUNCE_MS;
  process.env.JCC_KIMI_ACP_STREAM_FINAL_DEBOUNCE_MS = "100";
  try {
    const result = await runHostAgentRequest({
      provider: "kimi",
      available: true,
      command: launcher,
      build_args: ["acp"],
      kimi_home: path.join(tempRoot, ".kimi-code"),
    }, "Return visual JSON.", {
      parseJson: true,
      jsonResponseKind: "visual",
      repoRoot: path.resolve(import.meta.dirname, ".."),
      hostCwd: tempRoot,
      taskId: "verify-kimi-visual-after-diagnostic",
      timeoutMs: 2500,
    });

    assert(result.ok === true, `Kimi visual stream must wait past non-visual diagnostic JSON: ${result.error || ""}`);
    assert(result.response?.observations?.[0]?.text === "visual candidate", "Kimi visual response must select the kind-specific JSON object");
    assert(result.host_transport_diagnostics?.prefix?.includes("provider_status"), "Kimi visual response must quarantine the preceding diagnostic object");
    await assertRecordedProcessStopped(pidFile, "Kimi visual-response host");
  } finally {
    if (previousDebounce === undefined) delete process.env.JCC_KIMI_ACP_STREAM_FINAL_DEBOUNCE_MS;
    else process.env.JCC_KIMI_ACP_STREAM_FINAL_DEBOUNCE_MS = previousDebounce;
  }
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-host-adapter-final-before-exit-"));
try {
  await mkdir(tempRoot, { recursive: true });
  const adapterSource = await readFile(path.resolve(import.meta.dirname, "../ui/electron/host-adapters.js"), "utf8");
  assert(
    adapterSource.includes("activeTaskId.startsWith(taskPrefix)"),
    "cancelling a response task must also cancel namespaced visual child processes",
  );
  await verifyCodexCompletesBeforeProcessExit(tempRoot);
  await verifyKimiCompletesBeforeProcessExit(tempRoot);
  await verifyKimiPromptCompletionBarrierPrefersStream(tempRoot);
  await verifyKimiPromptResultOnlyHungChildCompletesBounded(tempRoot);
  await verifyKimiNonZeroExitAfterValidStreamRecoversAnswer(tempRoot);
  await verifyKimiInvalidStreamFallsBackToValidPromptResult(tempRoot);
  await verifyKimiMalformedJsonCompletesBeforeTimeout(tempRoot);
  await verifyKimiSplitJsonChunksWaitForCompleteParse(tempRoot);
  await verifyKimiVisualWaitsForKindSpecificJson(tempRoot);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked: [
      "codex_final_agent_message_completes_before_process_exit",
      "codex_first_complete_json_quarantines_trailing_diagnostic",
      "kimi_acp_agent_message_completes_before_process_exit",
      "kimi_first_complete_json_quarantines_trailing_diagnostic",
      "kimi_acp_prompt_completion_barrier_prefers_stream",
      "kimi_acp_prompt_result_only_hung_child_completes_bounded",
      "kimi_acp_nonzero_exit_after_valid_stream_recovers_answer",
      "kimi_acp_invalid_stream_falls_back_to_valid_prompt_result",
      "kimi_acp_malformed_json_reports_parse_error_before_timeout",
      "kimi_acp_split_json_chunks_wait_for_complete_parse",
      "kimi_acp_stream_waits_for_kind_specific_visual_json",
      "response_task_cancel_also_cancels_visual_child_processes",
    ],
  }, null, 2)}\n`);
} finally {
  await removeTempRoot(tempRoot);
}
process.exit(0);
