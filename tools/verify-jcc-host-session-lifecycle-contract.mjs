import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cancelHostAgentRunDetailed,
  closeAllHostAgentSessions,
  closeHostAgentSession,
  hostAdapterContract,
  preemptHostAgentSessionStart,
  runHostAgentRequest,
} from "../ui/electron/host-adapters.js";
import {
  buildHostSessionBootstrapPrompt,
  buildHostSessionWarmupPrompt,
  buildHostTurnDeltaPrompt,
  configureRuntimeServicePaths,
  dailyHostSessionBootstrapDisposition,
  getRuntimeServiceState,
  handleRuntimeAction,
  hostContextCapsuleForRequest,
  hostSessionRouteForState,
  matchOwnershipForReplacement,
  prepareHostSessionInvocation,
  runHostModel as runOwnedHostModel,
  setRuntimeServiceState,
  setRuntimeServiceCanonicalStateWriter,
  persistStateAndCanonicalResponseTask,
  startMatchReadiness,
  terminateProcessTreeByPid,
  repairStaleWatcherProcess,
  killWatcher,
  setWatcherProcessForTest,
  warmHostSession,
} from "../ui/electron/runtime-service.js";
import { JccRuntimeDaemon, mergeRuntimeServiceCanonicalSnapshot } from "../ui/electron/runtime-daemon.js";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { loadActiveRulesBundle } from "./jcc_active_rules_contract.mjs";
import { createActiveCoreProfileSnapshot } from "./jcc_test_core_profile_fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");

function runHostModel(request, taskId) {
  const current = getRuntimeServiceState();
  setRuntimeServiceState({ ...current, response_task: {
    status: "running", response_task_id: taskId, revision: 1,
    mode: request.mode, match_session_id: current.match_session?.status === "active"
      ? current.match_session.match_session_id : null,
    origin: "direct_chat", event_key: null,
  } });
  return runOwnedHostModel(request, taskId);
}

function response(requestId, mode = "daily_chat") {
  return {
    schema: "jcc-host-cli-coach-response-v1",
    generated_by: "current_cli_agent_main_model",
    request_id: requestId,
    request_hash: `${requestId}-hash`,
    mode,
    final_text: `${requestId} completed`,
    recommended_action: "continue",
    confidence: "high",
    followup_question: null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HOST_SESSION_TEST_OBSERVE_TIMEOUT_MS = Number(
  process.env.JCC_HOST_SESSION_TEST_OBSERVE_TIMEOUT_MS || 300000,
);

async function waitForCondition(check, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(25);
  }
  throw new Error(`${label}${lastError ? `: ${lastError.message || String(lastError)}` : ""}`);
}

async function readJsonl(file) {
  const raw = await readFile(file, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return raw
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function writeLauncher(dir, name, scriptPath) {
  const launcher = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  const content = process.platform === "win32"
    ? ["@echo off", `"${process.execPath}" ${JSON.stringify(scriptPath)} %*`, ""].join("\r\n")
    : ["#!/usr/bin/env sh", `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"`, ""].join("\n");
  await writeFile(launcher, content, "utf8");
  if (process.platform !== "win32") await chmod(launcher, 0o755);
  return launcher;
}

async function writeCodexAppServerStub(tempRoot, {
  delayThreadStartMs = 0,
  delayTurnStartMs = 0,
  rejectResume = false,
  resumeErrorMessage = "thread not found",
  omitDynamicToolsOnResume = false,
  partialDynamicToolsOnResume = false,
  partialDynamicToolsOnStart = false,
  omitDynamicToolsOnPlainStart = false,
  omitDynamicToolsOnStart = false,
  deleteExitsProcess = true,
  uniqueThreadIdPerProcess = false,
  uniqueThreadIdPerStart = false,
  firstCoachAnswerIsPlainText = false,
  deliveryPhaseMatrix = false,
  firstCoachAnswerIsEmpty = false,
  delayFirstInterruptMs = 0,
} = {}) {
  const script = path.join(tempRoot, "fake-codex-app-server.mjs");
  await writeFile(script, `
import { appendFile } from "node:fs/promises";
import readline from "node:readline";

const logFile = process.env.JCC_HOST_SESSION_TEST_LOG;
let threadId = ${uniqueThreadIdPerProcess ? '`codex-live-thread-${process.pid}`' : '"codex-live-thread"'};
let threadStartCount = 0;
const delayThreadStartMs = ${Number(delayThreadStartMs)};
const delayTurnStartMs = ${Number(delayTurnStartMs)};
const rejectResume = ${Boolean(rejectResume)};
const resumeErrorMessage = ${JSON.stringify(String(resumeErrorMessage))};
const omitDynamicToolsOnResume = ${Boolean(omitDynamicToolsOnResume)};
const partialDynamicToolsOnResume = ${Boolean(partialDynamicToolsOnResume)};
const partialDynamicToolsOnStart = ${Boolean(partialDynamicToolsOnStart)};
const omitDynamicToolsOnPlainStart = ${Boolean(omitDynamicToolsOnPlainStart)};
const omitDynamicToolsOnStart = ${Boolean(omitDynamicToolsOnStart)};
const uniqueThreadIdPerStart = ${Boolean(uniqueThreadIdPerStart)};
const deleteExitsProcess = ${Boolean(deleteExitsProcess)};
const firstCoachAnswerIsPlainText = ${Boolean(firstCoachAnswerIsPlainText)};
const deliveryPhaseMatrix = ${Boolean(deliveryPhaseMatrix)};
const firstCoachAnswerIsEmpty = ${Boolean(firstCoachAnswerIsEmpty)};
let emptyCoachRequest = null;
const delayFirstInterruptMs = ${Number(delayFirstInterruptMs)};
let nextTurn = 0;
let openTurn = null;
let plainCoachAnswerSent = false;
let interruptCount = 0;

function send(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

async function log(entry) {
  await appendFile(logFile, JSON.stringify({ pid: process.pid, ...entry }) + "\\n", "utf8");
}

function requestText(message) {
  return (message.params?.input || [])
    .map((part) => part?.text || "")
    .join("\\n");
}

function response(requestId, mode) {
  return ${response.toString()}(requestId, mode);
}

function requestMode(text) {
  const inputJson = text.slice(Math.max(0, text.lastIndexOf("INPUT_JSON:")));
  return inputJson.match(/"mode"\\s*:\\s*"([^"]+)"/)?.[1] || "daily_chat";
}

function responseForText(text, requestId) {
  if (!text.includes("JCC_RUNTIME_SESSION_BOOTSTRAP_ONLY:")) return response(requestId, requestMode(text));
  const capsuleId = text.match(/"capsule_id"\\s*:\\s*"([^"]+)"/)?.[1] || null;
  return {
    schema: "jcc-host-session-bootstrap-ack-v1",
    capsule_id: capsuleId,
    operation: text.includes('"operation":"static_context_update"')
      ? "static_context_update"
      : text.includes('"operation":"transport_recovery_probe"')
        ? "transport_recovery_probe"
        : "session_bootstrap",
    accepted: true,
  };
}

async function completeTurn(turnId, requestId, result) {
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: { threadId, turnId, item: { type: "agentMessage", text: typeof result === "string" ? result : JSON.stringify(result) } },
  });
  send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turnId, turn: { id: turnId, status: "completed" } } });
  await log({ event: "turn-completed", turn_id: turnId, request_id: requestId });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const message = JSON.parse(line);
  await log({ event: "request", method: message.method || null, params: message.params || null });
  if (message.method === "initialize") {
    return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
  }
  if (message.method === "thread/start") {
    if (delayThreadStartMs > 0) await new Promise((resolve) => setTimeout(resolve, delayThreadStartMs));
    threadStartCount += 1;
    if (uniqueThreadIdPerStart) threadId = "codex-live-thread-" + process.pid + "-" + threadStartCount;
    const requestedDynamicTools = Array.isArray(message.params?.dynamicTools);
    return send({ jsonrpc: "2.0", id: message.id, result: { thread: {
      id: threadId,
      ...(omitDynamicToolsOnStart || omitDynamicToolsOnPlainStart && !requestedDynamicTools ? {} : {
        dynamicTools: [{ name: "jcc", tools: partialDynamicToolsOnStart
          ? [{ name: "query_knowledge" }]
          : [{ name: "query_knowledge" }, { name: "calculate" }] }],
      }),
    } } });
  }
  if (message.method === "thread/resume") {
    if (rejectResume) return send({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: resumeErrorMessage } });
    return send({ jsonrpc: "2.0", id: message.id, result: { thread: {
      id: message.params?.threadId || threadId,
      ...(omitDynamicToolsOnResume ? {} : {
        dynamicTools: [{ name: "jcc", tools: partialDynamicToolsOnResume
          ? [{ name: "query_knowledge" }]
          : [{ name: "query_knowledge" }, { name: "calculate" }] }],
      }),
    } } });
  }
  if (message.method === "turn/start") {
    const text = requestText(message);
    const declaredRequestId = text.match(/"request_id"\s*:\s*"([^"]+)"/)?.[1] || null;
    const requestId = declaredRequestId || (text.includes("after-crash") ? "after-crash" : text.includes("crash-now") ? "crash-now" : text.includes("after-cancel") ? "after-cancel" : text.includes("interrupt-turn") ? "interrupt-turn" : text.includes("second-turn") ? "second-turn" : "first-turn");
    const turnId = "codex-turn-" + (++nextTurn);
    if (delayTurnStartMs > 0) await new Promise((resolve) => setTimeout(resolve, delayTurnStartMs));
    send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: turnId } } });
    await log({ event: "turn-started", turn_id: turnId, request_id: requestId });
    if (firstCoachAnswerIsEmpty && !emptyCoachRequest && !text.includes("JCC_RUNTIME_SESSION_BOOTSTRAP_ONLY:")) {
      emptyCoachRequest = { text, requestId };
      send({ jsonrpc: "2.0", method: "item/completed", params: { threadId, turnId,
        item: { type: "userMessage", content: [{ type: "text", text }] } } });
      send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turnId,
        turn: { id: turnId, status: "completed", error: null, items: [], itemsView: "notLoaded" } } });
      return;
    }
    if (firstCoachAnswerIsEmpty && text.startsWith("The previous provider turn completed")) {
      await completeTurn(turnId, emptyCoachRequest.requestId, responseForText(emptyCoachRequest.text, emptyCoachRequest.requestId));
      return;
    }
    if (deliveryPhaseMatrix) {
      const messageItem = { type: "agentMessage", id: "interim", phase: "commentary", text: "我会查询当前阵容。" };
      if (!text.includes("empty")) send({ jsonrpc: "2.0", method: "item/completed", params: { threadId, turnId, item: messageItem } });
      if (text.includes("tool-start-empty")) send({ jsonrpc: "2.0", method: "item/started", params: { threadId, turnId,
        item: { type: "dynamicToolCall", id: "tool" } } });
      if (text.includes("with-final")) {
        send({ jsonrpc: "2.0", method: "item/completed", params: { threadId, turnId,
          item: { type: "agentMessage", id: "final", phase: "final_answer", text: JSON.stringify(response(requestId, "daily_chat")) } } });
      }
      send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turnId,
        turn: { id: turnId, status: text.includes("fail") ? "failed" : "completed",
          error: text.includes("fail") ? { message: "429 provider quota exhausted" } : null } } });
      return;
    }
    if (requestId === "crash-now") {
      await log({ event: "process-crashing", turn_id: turnId, request_id: requestId });
      setTimeout(() => process.exit(42), 10);
      return;
    }
    if (requestId === "interrupt-turn") {
      openTurn = { turnId, requestId };
      return;
    }
    const shouldSendPlainCoachAnswer = firstCoachAnswerIsPlainText
      && !plainCoachAnswerSent
      && !text.includes("JCC_RUNTIME_SESSION_BOOTSTRAP_ONLY:")
      && !text.includes("CORRECTION_REQUIRED:");
    if (shouldSendPlainCoachAnswer) plainCoachAnswerSent = true;
    const result = shouldSendPlainCoachAnswer
      ? "我会按当前阶段整理完整建议。"
      : responseForText(text, requestId);
    setTimeout(() => { void completeTurn(turnId, requestId, result); }, 10);
    return;
  }
  if (message.method === "turn/interrupt") {
    interruptCount += 1;
    await log({ event: "turn-interrupted", turn_id: message.params?.turnId || null });
    if (interruptCount === 1 && delayFirstInterruptMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayFirstInterruptMs));
    }
    if (openTurn?.turnId === message.params?.turnId) openTurn = null;
    return send({ jsonrpc: "2.0", id: message.id, result: { accepted: true } });
  }
  if (message.method === "thread/delete") {
    send({ jsonrpc: "2.0", id: message.id, result: { deleted: true } });
    await log({ event: "thread-deleted", thread_id: message.params?.threadId || null });
    if (deleteExitsProcess) setTimeout(() => process.exit(0), 10);
    return;
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`, "utf8");
  return script;
}

async function writeKimiAcpStub(tempRoot, {
  delaySessionNewMs = 0,
  cancelSettleDelayMs = 0,
  uniqueSessionIdPerProcess = false,
  rejectResume = false,
} = {}) {
  const script = path.join(tempRoot, "fake-kimi-acp.mjs");
  await writeFile(script, `
import { appendFile } from "node:fs/promises";
import readline from "node:readline";

const logFile = process.env.JCC_HOST_SESSION_TEST_LOG;
const sessionId = ${uniqueSessionIdPerProcess ? '`kimi-live-session-${process.pid}`' : '"kimi-live-session"'};
const delaySessionNewMs = ${Number(delaySessionNewMs)};
const cancelSettleDelayMs = ${Number(cancelSettleDelayMs)};
const rejectResume = ${Boolean(rejectResume)};
let openPrompt = null;
const sessionConfig = { model: "stub-model", thinking: "high" };

function configOptions() {
  return [
    { id: "model", currentValue: sessionConfig.model },
    { id: "thinking", currentValue: sessionConfig.thinking },
  ];
}

function send(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

async function log(entry) {
  await appendFile(logFile, JSON.stringify({ pid: process.pid, ...entry }) + "\\n", "utf8");
}

function promptText(message) {
  return (message.params?.prompt || [])
    .map((part) => part?.text || "")
    .join("\\n");
}

function response(requestId, mode) {
  return ${response.toString()}(requestId, mode);
}

function requestMode(text) {
  const inputJson = text.slice(Math.max(0, text.lastIndexOf("INPUT_JSON:")));
  return inputJson.match(/"mode"\\s*:\\s*"([^"]+)"/)?.[1] || "daily_chat";
}

function responseForText(text, requestId) {
  if (!text.includes("JCC_RUNTIME_SESSION_BOOTSTRAP_ONLY:")) return response(requestId, requestMode(text));
  const capsuleId = text.match(/"capsule_id"\\s*:\\s*"([^"]+)"/)?.[1] || null;
  return {
    schema: "jcc-host-session-bootstrap-ack-v1",
    capsule_id: capsuleId,
    accepted: true,
  };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const message = JSON.parse(line);
  await log({ event: "request", method: message.method || null, params: message.params || null });
  if (message.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {} },
          promptCapabilities: { image: true },
        },
      },
    });
  }
  if (message.method === "session/new") {
    if (delaySessionNewMs > 0) await new Promise((resolve) => setTimeout(resolve, delaySessionNewMs));
    return send({ jsonrpc: "2.0", id: message.id, result: { sessionId, configOptions: configOptions() } });
  }
  if (message.method === "session/resume" || message.method === "session/load") {
    if (rejectResume) return send({ jsonrpc: "2.0", id: message.id, error: { code: -32004, message: "session not found" } });
    return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: message.params?.sessionId || sessionId, configOptions: configOptions() } });
  }
  if (message.method === "session/set_config_option") {
    const configId = String(message.params?.configId || "");
    if (Object.hasOwn(sessionConfig, configId)) sessionConfig[configId] = String(message.params?.value || "");
    return send({ jsonrpc: "2.0", id: message.id, result: { configOptions: configOptions() } });
  }
  if (message.method === "session/prompt") {
    const text = promptText(message);
    const requestId = text.includes("after-crash") ? "after-crash" : text.includes("crash-now") ? "crash-now" : text.includes("after-cancel") ? "after-cancel" : text.includes("interrupt-turn") ? "interrupt-turn" : text.includes("second-turn") ? "second-turn" : "first-turn";
    await log({ event: "prompt-started", request_id: requestId, session_id: message.params?.sessionId || null });
    if (requestId === "crash-now") {
      await log({ event: "process-crashing", request_id: requestId, session_id: message.params?.sessionId || null });
      setTimeout(() => process.exit(42), 10);
      return;
    }
    if (requestId === "interrupt-turn") {
      openPrompt = { id: message.id, requestId };
      return;
    }
    return send({ jsonrpc: "2.0", id: message.id, result: { content: { text: JSON.stringify(responseForText(text, requestId)) }, stopReason: "end_turn" } });
  }
  if (message.method === "session/cancel") {
    await log({ event: "session-cancel", session_id: message.params?.sessionId || null, had_open_prompt: Boolean(openPrompt) });
    if (openPrompt) {
      const cancelledPrompt = openPrompt;
      openPrompt = null;
      setTimeout(() => send({ jsonrpc: "2.0", id: cancelledPrompt.id, result: { content: { text: "" }, stopReason: "cancelled" } }), cancelSettleDelayMs);
    }
    return send({ jsonrpc: "2.0", id: message.id, result: { accepted: true } });
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`, "utf8");
  return script;
}

async function verifyCodexLongLivedTransport(tempRoot) {
  const logFile = path.join(tempRoot, "codex-rpc.jsonl");
  const script = await writeCodexAppServerStub(tempRoot);
  const sourceHome = path.join(tempRoot, "source-codex-home");
  const runtimeHome = path.join(tempRoot, "runtime-codex-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  await writeFile(path.join(sourceHome, "config.toml"), "model = \"stub\"\n", "utf8");
  process.env.JCC_SOURCE_CODEX_HOME = sourceHome;
  process.env.JCC_CODEX_RUNTIME_HOME = runtimeHome;
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const adapter = {
    provider: "codex",
    available: true,
    spawn_command: process.execPath,
    spawn_prefix_args: [script],
  };
  const baseOptions = {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: 5000,
    hostSessionKey: "match:long-lived-codex",
  };

  const first = await runHostAgentRequest(adapter, "first-turn", { ...baseOptions, taskId: "codex-first" });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.thread_id, "codex-live-thread");
  assert.equal(first.response.request_id, "first-turn");
  assert.equal(first.completed_from, "codex_app_server");

  const second = await runHostAgentRequest(adapter, "second-turn", { ...baseOptions, taskId: "codex-second" });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.thread_id, "codex-live-thread");
  assert.equal(second.response.request_id, "second-turn");

  const interrupted = runHostAgentRequest(adapter, "interrupt-turn", { ...baseOptions, taskId: "codex-interrupt", timeoutMs: 5000 });
  await waitForCondition(
    async () => (await readJsonl(logFile)).some((entry) => entry.event === "turn-started" && entry.request_id === "interrupt-turn"),
    "Codex interrupt turn did not start",
  );
  const cancellation = cancelHostAgentRunDetailed("codex-interrupt");
  assert.equal(cancellation.accepted, true, "stop-current-turn must accept the active Codex turn");
  assert.deepEqual(cancellation.retained_task_ids, ["codex-interrupt"], "Codex turn handle must remain registered until the native turn settles");
  assert.equal(cancellation.provider_acknowledged_count, 0, "the synchronous Stop path must not invent a provider acknowledgement");
  const interruptedResult = await interrupted;
  assert.equal(interruptedResult.ok, false, "interrupted Codex turn must not complete as a normal answer");
  assert.match(interruptedResult.error, /cancelled/i);

  const afterCancel = await runHostAgentRequest(adapter, "after-cancel", { ...baseOptions, taskId: "codex-after-cancel" });
  assert.equal(afterCancel.ok, true, afterCancel.error);
  assert.equal(afterCancel.thread_id, "codex-live-thread");
  assert.equal(afterCancel.response.request_id, "after-cancel");

  const beforeClose = await readJsonl(logFile);
  const nativeStart = beforeClose.find((entry) => entry.event === "request" && entry.method === "thread/start");
  assert.deepEqual(nativeStart.params.config["features.code_mode.direct_only_tool_namespaces"], ["jcc"],
    "model-default Code Mode must not wrap JCC tools");
  assert.equal(nativeStart.params.config.tool_output_token_limit, 262144);
  const pids = new Set(beforeClose.map((entry) => entry.pid));
  const methods = beforeClose.filter((entry) => entry.event === "request").map((entry) => entry.method);
  assert.equal(pids.size, 1, "Codex route must keep one app-server process alive across turns");
  assert.equal(methods.filter((method) => method === "thread/start").length, 1, "Codex route must bootstrap one thread");
  assert.equal(methods.filter((method) => method === "thread/resume").length, 0, "normal Codex turns must not resume provider threads");
  assert.equal(methods.filter((method) => method === "turn/start").length, 4, "Codex route must send multiple turns to the same live process");
  assert(methods.filter((method) => method === "turn/interrupt").length >= 1, "stop-current-turn must interrupt the active Codex turn");
  assert.equal(methods.filter((method) => method === "thread/delete").length, 0, "stop-current-turn must not close the Codex thread");
  assert.equal(beforeClose[0].params?.argv, undefined);
  const codexHomes = new Set(beforeClose.map((entry) => entry.params?.env?.CODEX_HOME).filter(Boolean));
  assert.equal(codexHomes.size, 0, "stub request log must not depend on per-turn CODEX_HOME argv semantics");

  const closed = await closeHostAgentSession("match:long-lived-codex");
  assert.equal(closed.accepted, true, "closing the Codex route must be accepted");
  assert.equal(closed.persistent_transport_closed, true, "closing the Codex route must terminate the app-server transport");
  assert.equal(closed.persistent_transport_close?.pid, first.transport_pid, "Codex close evidence must identify the owned transport PID");
  assert.throws(() => process.kill(first.transport_pid, 0), "Codex close must not report success while the owned PID still exists");
  const afterClose = await readJsonl(logFile);
  const closeMethods = afterClose.filter((entry) => entry.event === "request").map((entry) => entry.method);
  assert.equal(closeMethods.filter((method) => method === "thread/delete").length, 1, "Codex close route must delete the live thread once");
  assert((await readJsonl(logFile)).some((entry) => entry.event === "thread-deleted"), "Codex close route must reach the fake app-server");
}

async function verifyKimiLongLivedTransport(tempRoot) {
  const logFile = path.join(tempRoot, "kimi-rpc.jsonl");
  const script = await writeKimiAcpStub(tempRoot);
  const launcher = await writeLauncher(tempRoot, "fake-kimi-acp", script);
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const adapter = {
    provider: "kimi",
    available: true,
    command: launcher,
    build_args: ["acp"],
    kimi_home: path.join(tempRoot, ".kimi-code"),
  };
  const baseOptions = {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: 5000,
    hostSessionKey: "daily:long-lived-kimi",
  };

  const first = await runHostAgentRequest(adapter, "first-turn", { ...baseOptions, taskId: "kimi-first" });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.session_id, "kimi-live-session");
  assert.equal(first.response.request_id, "first-turn");
  assert.equal(first.completed_from, "kimi_persistent_acp");

  const second = await runHostAgentRequest(adapter, "second-turn", { ...baseOptions, taskId: "kimi-second" });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.session_id, "kimi-live-session");
  assert.equal(second.response.request_id, "second-turn");

  const interrupted = runHostAgentRequest(adapter, "interrupt-turn", { ...baseOptions, taskId: "kimi-interrupt", timeoutMs: 5000 });
  await waitForCondition(
    async () => (await readJsonl(logFile)).some((entry) => entry.event === "prompt-started" && entry.request_id === "interrupt-turn"),
    "Kimi interrupt prompt did not start",
  );
  const cancellation = cancelHostAgentRunDetailed("kimi-interrupt");
  assert.equal(cancellation.accepted, true, "stop-current-turn must accept the active Kimi prompt");
  assert.deepEqual(cancellation.retained_task_ids, ["kimi-interrupt"], "Kimi prompt handle must remain registered until the native prompt settles");
  assert.equal(cancellation.provider_acknowledged_count, 0, "Kimi ACP cancel notification has no synchronous acknowledgement");
  const repeatedCancellation = cancelHostAgentRunDetailed("kimi-interrupt");
  assert.equal(repeatedCancellation.accepted, true, "a repeated exact Stop must still target the retained Kimi prompt");
  assert.deepEqual(repeatedCancellation.retained_task_ids, ["kimi-interrupt"], "repeated Stop must retain the same Kimi cancellation handle until settlement");
  assert.equal(repeatedCancellation.cancellation_states["kimi-interrupt"], "provider_cancel_pending");
  const interruptedResult = await interrupted;
  assert.equal(interruptedResult.ok, false, "interrupted Kimi turn must not complete as a normal answer");
  assert.match(interruptedResult.error, /cancelled/i);

  const afterCancel = await runHostAgentRequest(adapter, "after-cancel", { ...baseOptions, taskId: "kimi-after-cancel" });
  assert.equal(afterCancel.ok, true, afterCancel.error);
  assert.equal(afterCancel.session_id, "kimi-live-session");
  assert.equal(afterCancel.response.request_id, "after-cancel");

  const beforeClose = await readJsonl(logFile);
  const pids = new Set(beforeClose.map((entry) => entry.pid));
  const methods = beforeClose.filter((entry) => entry.event === "request").map((entry) => entry.method);
  assert.equal(pids.size, 1, "Kimi route must keep one ACP process alive across prompts");
  assert.equal(methods.filter((method) => method === "session/new").length, 1, "Kimi route must bootstrap one ACP session");
  assert.equal(methods.filter((method) => method === "session/resume" || method === "session/load").length, 0, "normal Kimi turns must not resume/load provider sessions");
  assert.equal(methods.filter((method) => method === "session/prompt").length, 4, "Kimi route must send multiple prompts to the same live ACP process");
  assert(methods.filter((method) => method === "session/cancel").length >= 1, "stop-current-turn must cancel the active Kimi prompt before route close");

  const closed = await closeHostAgentSession("daily:long-lived-kimi");
  assert.equal(closed.accepted, true, "closing the Kimi route must be accepted");
  assert.equal(closed.persistent_transport_closed, true, "closing the Kimi route must terminate the ACP transport");
  assert.equal(closed.persistent_transport_close?.pid, first.transport_pid, "Kimi close evidence must identify the owned transport PID");
  assert.throws(() => process.kill(first.transport_pid, 0), "Kimi close must not report success while the owned PID still exists");
  const afterClose = await readJsonl(logFile);
  const closeMethods = afterClose.filter((entry) => entry.event === "request").map((entry) => entry.method);
  assert.equal(
    closeMethods.filter((method) => method === "session/cancel").length,
    methods.filter((method) => method === "session/cancel").length + 1,
    "Kimi close route must send one final session cancel after the turn-level cancel path",
  );
}

async function verifyCodexStaticContextUpdateReusesLiveSession(tempRoot) {
  const logFile = path.join(tempRoot, "codex-static-update-rpc.jsonl");
  const script = await writeCodexAppServerStub(tempRoot, { uniqueThreadIdPerProcess: true });
  const sourceHome = path.join(tempRoot, "source-codex-static-update-home");
  const runtimeHome = path.join(tempRoot, "runtime-codex-static-update-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  await writeFile(path.join(sourceHome, "config.toml"), "model = \"stub\"\n", "utf8");
  process.env.JCC_SOURCE_CODEX_HOME = sourceHome;
  process.env.JCC_CODEX_RUNTIME_HOME = runtimeHome;
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const routeKey = "match:codex-static-context-update";
  const provider = "codex";
  const model = "gpt-static-a";
  const adapter = {
    provider,
    available: true,
    spawn_command: process.execPath,
    spawn_prefix_args: [script],
    selected_model: model,
  };
  const baseOptions = {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: 5000,
    hostSessionKey: routeKey,
  };
  const firstRequest = sampleHostRequest({ request_id: "codex-static-first", request_hash: "hash-codex-static-first" });
  const firstCapsule = hostContextCapsuleForRequest(firstRequest, { routeKey, provider, model });
  const first = await runHostAgentRequest(adapter, buildHostSessionBootstrapPrompt(firstRequest, firstCapsule), {
    ...baseOptions,
    taskId: "codex-static-first",
  });
  assert.equal(first.ok, true, first.error);
  assert.match(first.thread_id, /^codex-live-thread-\d+$/);

  const updatedRequest = sampleHostRequest({
    request_id: "codex-static-update",
    request_hash: "hash-codex-static-update",
    stageRound: "2-2",
    daily_big_data: { stat_date: "20260727", snapshot_hash: "rank-static-b" },
  });
  const updatedCapsule = hostContextCapsuleForRequest(updatedRequest, { routeKey, provider, model });
  assert.notEqual(firstCapsule.fingerprint, updatedCapsule.fingerprint, "ranking snapshot change must create a new static context fingerprint");
  const updated = await runHostAgentRequest(
    adapter,
    [
      "JCC_RUNTIME_STATIC_CONTEXT_UPDATE:",
      "Continue the current live provider process and provider session.",
      "STATIC_CONTEXT_JSON:",
      JSON.stringify(updatedCapsule),
      buildHostTurnDeltaPrompt(updatedRequest, updatedCapsule),
    ].join("\n"),
    { ...baseOptions, taskId: "codex-static-update", hostSessionId: first.thread_id },
  );
  assert.equal(updated.ok, true, updated.error);
  assert.equal(updated.thread_id, first.thread_id, "Codex static context update must keep the same provider thread");
  assert.equal(updated.transport_pid, first.transport_pid, "Codex static context update must keep the same live app-server process");

  const normalRequest = sampleHostRequest({
    request_id: "codex-static-normal-after-update",
    request_hash: "hash-codex-static-normal-after-update",
    stageRound: "2-3",
    hp: 76,
    gold: 34,
    query: "What is my next normal turn?",
  });
  const normal = await runHostAgentRequest(adapter, buildHostTurnDeltaPrompt(normalRequest, updatedCapsule), {
    ...baseOptions,
    taskId: "codex-static-normal-after-update",
    hostSessionId: first.thread_id,
  });
  assert.equal(normal.ok, true, normal.error);
  assert.equal(normal.thread_id, first.thread_id, "Codex normal turn after static update must reuse the refreshed provider thread");
  assert.equal(normal.transport_pid, first.transport_pid, "Codex normal turn after static update must reuse the live app-server process");

  const all = await readJsonl(logFile);
  const pids = new Set(all.map((entry) => entry.pid));
  const methods = all.filter((entry) => entry.event === "request").map((entry) => entry.method);
  const turnPrompts = all
    .filter((entry) => entry.event === "request" && entry.method === "turn/start")
    .map((entry) => (entry.params?.input || []).map((part) => part?.text || "").join("\n"));
  assert.equal(pids.size, 1, "Codex static context update and following turn must stay on one process");
  assert.equal(methods.filter((method) => method === "thread/start").length, 1, "Codex static context update route must bootstrap once");
  assert.equal(methods.filter((method) => method === "thread/resume").length, 0, "Codex static context update and following normal turn must not resume");
  assert.equal(methods.filter((method) => method === "turn/start").length, 3, "Codex route must send bootstrap, static update, and normal turn through the live thread");
  assert.equal(turnPrompts.filter((text) => text.includes("JCC_RUNTIME_STATIC_CONTEXT_UPDATE")).length, 1, "Codex route must send exactly one static context update prompt");

  const closed = await closeHostAgentSession(routeKey);
  assert.equal(closed.accepted, true, "Codex static context update route must be closable");
}

async function verifyKimiStaticContextUpdateReusesLiveSession(tempRoot) {
  const logFile = path.join(tempRoot, "kimi-static-update-rpc.jsonl");
  const script = await writeKimiAcpStub(tempRoot, { uniqueSessionIdPerProcess: true });
  const launcher = await writeLauncher(tempRoot, "fake-kimi-static-update-acp", script);
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const routeKey = "daily:kimi-static-context-update";
  const provider = "kimi";
  const model = "moonshot-v1-static-a";
  const adapter = {
    provider,
    available: true,
    command: launcher,
    build_args: ["acp"],
    kimi_home: path.join(tempRoot, ".kimi-static-update-code"),
    selected_model: model,
  };
  const baseOptions = {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: 5000,
    hostSessionKey: routeKey,
  };
  const firstRequest = sampleHostRequest({ request_id: "kimi-static-first", request_hash: "hash-kimi-static-first" });
  const firstCapsule = hostContextCapsuleForRequest(firstRequest, { routeKey, provider, model });
  const first = await runHostAgentRequest(adapter, buildHostSessionBootstrapPrompt(firstRequest, firstCapsule), {
    ...baseOptions,
    taskId: "kimi-static-first",
  });
  assert.equal(first.ok, true, first.error);
  assert.match(first.session_id, /^kimi-live-session-\d+$/);

  const updatedRequest = sampleHostRequest({
    request_id: "kimi-static-update",
    request_hash: "hash-kimi-static-update",
    stageRound: "2-2",
    daily_big_data: { stat_date: "20260727", snapshot_hash: "rank-static-b" },
  });
  const updatedCapsule = hostContextCapsuleForRequest(updatedRequest, { routeKey, provider, model });
  assert.notEqual(firstCapsule.fingerprint, updatedCapsule.fingerprint, "ranking snapshot change must create a new static context fingerprint");
  const updated = await runHostAgentRequest(
    adapter,
    [
      "JCC_RUNTIME_STATIC_CONTEXT_UPDATE:",
      "Continue the current live provider process and provider session.",
      "STATIC_CONTEXT_JSON:",
      JSON.stringify(updatedCapsule),
      buildHostTurnDeltaPrompt(updatedRequest, updatedCapsule),
    ].join("\n"),
    { ...baseOptions, taskId: "kimi-static-update", hostSessionId: first.session_id },
  );
  assert.equal(updated.ok, true, updated.error);
  assert.equal(updated.session_id, first.session_id, "Kimi static context update must keep the same provider session");
  assert.equal(updated.transport_pid, first.transport_pid, "Kimi static context update must keep the same live ACP process");

  const normalRequest = sampleHostRequest({
    request_id: "kimi-static-normal-after-update",
    request_hash: "hash-kimi-static-normal-after-update",
    stageRound: "2-3",
    hp: 76,
    gold: 34,
    query: "What is my next normal turn?",
  });
  const normal = await runHostAgentRequest(adapter, buildHostTurnDeltaPrompt(normalRequest, updatedCapsule), {
    ...baseOptions,
    taskId: "kimi-static-normal-after-update",
    hostSessionId: first.session_id,
  });
  assert.equal(normal.ok, true, normal.error);
  assert.equal(normal.session_id, first.session_id, "Kimi normal turn after static update must reuse the refreshed provider session");
  assert.equal(normal.transport_pid, first.transport_pid, "Kimi normal turn after static update must reuse the live ACP process");

  const all = await readJsonl(logFile);
  const pids = new Set(all.map((entry) => entry.pid));
  const methods = all.filter((entry) => entry.event === "request").map((entry) => entry.method);
  const prompts = all
    .filter((entry) => entry.event === "request" && entry.method === "session/prompt")
    .map((entry) => (entry.params?.prompt || []).map((part) => part?.text || "").join("\n"));
  assert.equal(pids.size, 1, "Kimi static context update and following prompt must stay on one process");
  assert.equal(methods.filter((method) => method === "session/new").length, 1, "Kimi static context update route must bootstrap once");
  assert.equal(methods.filter((method) => method === "session/resume" || method === "session/load").length, 0, "Kimi static context update and following normal prompt must not resume/load");
  assert.equal(methods.filter((method) => method === "session/prompt").length, 3, "Kimi route must send bootstrap, static update, and normal prompt through the live session");
  assert.equal(prompts.filter((text) => text.includes("JCC_RUNTIME_STATIC_CONTEXT_UPDATE")).length, 1, "Kimi route must send exactly one static context update prompt");

  const closed = await closeHostAgentSession(routeKey);
  assert.equal(closed.accepted, true, "Kimi static context update route must be closable");
}

async function verifyCodexModelAndEffortChangeReuseLiveSession(tempRoot) {
  const logFile = path.join(tempRoot, "codex-provider-model-change-rpc.jsonl");
  const script = await writeCodexAppServerStub(tempRoot, { uniqueThreadIdPerProcess: true });
  const sourceHome = path.join(tempRoot, "source-codex-provider-model-change-home");
  const runtimeHome = path.join(tempRoot, "runtime-codex-provider-model-change-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  await writeFile(path.join(sourceHome, "config.toml"), "model = \"stub\"\n", "utf8");
  process.env.JCC_SOURCE_CODEX_HOME = sourceHome;
  process.env.JCC_CODEX_RUNTIME_HOME = runtimeHome;
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const routeKey = "match:codex-provider-model-change";
  const firstAdapter = {
    provider: "codex",
    available: true,
    spawn_command: process.execPath,
    spawn_prefix_args: [script],
    selected_model: "gpt-provider-a",
    reasoning_effort: "low",
  };
  const replacementAdapter = { ...firstAdapter, selected_model: "gpt-provider-b", reasoning_effort: "high" };
  const baseOptions = {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: 5000,
    hostSessionKey: routeKey,
  };

  const first = await runHostAgentRequest(firstAdapter, "first-turn", { ...baseOptions, taskId: "codex-provider-first" });
  assert.equal(first.ok, true, first.error);
  const second = await runHostAgentRequest(replacementAdapter, "second-turn", { ...baseOptions, taskId: "codex-provider-second" });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.thread_id, first.thread_id, "Codex model/effort changes must preserve the provider thread");
  assert.equal(second.transport_pid, first.transport_pid, "Codex model/effort changes must preserve the app-server process");

  const all = await readJsonl(logFile);
  const methods = all.filter((entry) => entry.event === "request").map((entry) => entry.method);
  const turns = all.filter((entry) => entry.event === "request" && entry.method === "turn/start");
  assert.equal(new Set(all.map((entry) => entry.pid)).size, 1, "Codex model/effort changes must use one app-server process");
  assert.equal(methods.filter((method) => method === "thread/start").length, 1, "Codex model/effort changes must bootstrap exactly one thread");
  assert.equal(methods.filter((method) => method === "thread/resume").length, 0, "Codex model/effort changes must not resume the live thread");
  assert.equal(turns[0]?.params?.model, "gpt-provider-a");
  assert.equal(turns[0]?.params?.effort, "low");
  assert.equal(turns[1]?.params?.model, "gpt-provider-b");
  assert.equal(turns[1]?.params?.effort, "high");

  const closed = await closeHostAgentSession(routeKey);
  assert.equal(closed.accepted, true, "Codex in-place configuration route must be closable");
}

async function verifyCodexTransportVersionChangeReplacesLiveSession(tempRoot) {
  const logFile = path.join(tempRoot, "codex-provider-version-change-rpc.jsonl");
  const script = await writeCodexAppServerStub(tempRoot, { uniqueThreadIdPerProcess: true });
  const sourceHome = path.join(tempRoot, "source-codex-provider-version-change-home");
  const runtimeHome = path.join(tempRoot, "runtime-codex-provider-version-change-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  await writeFile(path.join(sourceHome, "config.toml"), "model = \"stub\"\n", "utf8");
  process.env.JCC_SOURCE_CODEX_HOME = sourceHome;
  process.env.JCC_CODEX_RUNTIME_HOME = runtimeHome;
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const routeKey = "match:codex-provider-version-change";
  const firstAdapter = {
    provider: "codex",
    available: true,
    spawn_command: process.execPath,
    spawn_prefix_args: [script],
    version: "codex-cli 1.0.0",
    selected_model: "gpt-provider-a",
  };
  const updatedAdapter = { ...firstAdapter, version: "codex-cli 2.0.0" };
  const baseOptions = {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: 5000,
    hostSessionKey: routeKey,
  };

  const first = await runHostAgentRequest(firstAdapter, "first-turn", { ...baseOptions, taskId: "codex-version-first" });
  assert.equal(first.ok, true, first.error);
  const replacement = await runHostAgentRequest(updatedAdapter, "second-turn", { ...baseOptions, taskId: "codex-version-second" });
  assert.equal(replacement.ok, true, replacement.error);
  assert.notEqual(replacement.thread_id, first.thread_id, "Codex version changes must replace the provider thread");
  assert.notEqual(replacement.transport_pid, first.transport_pid, "Codex version changes must replace the app-server process");

  const all = await readJsonl(logFile);
  const methods = all.filter((entry) => entry.event === "request").map((entry) => entry.method);
  assert.equal(new Set(all.map((entry) => entry.pid)).size, 2, "Codex version changes must use two app-server processes");
  assert.equal(methods.filter((method) => method === "thread/start").length, 2, "Codex version changes must bootstrap a replacement thread");
  assert.equal(methods.filter((method) => method === "thread/resume").length, 0, "Codex version changes must not resume the prior thread");

  const closed = await closeHostAgentSession(routeKey);
  assert.equal(closed.accepted, true, "Codex replacement transport route must be closable");
}

async function verifyKimiModelAndEffortChangeReuseLiveSession(tempRoot) {
  const logFile = path.join(tempRoot, "kimi-provider-model-change-rpc.jsonl");
  const script = await writeKimiAcpStub(tempRoot, { uniqueSessionIdPerProcess: true });
  const launcher = await writeLauncher(tempRoot, "fake-kimi-provider-model-change-acp", script);
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const routeKey = "daily:kimi-provider-model-change";
  const firstAdapter = {
    provider: "kimi",
    available: true,
    command: launcher,
    build_args: ["acp"],
    kimi_home: path.join(tempRoot, ".kimi-provider-model-change-code"),
    selected_model: "moonshot-v1-provider-a",
    reasoning_effort: "low",
  };
  const replacementAdapter = { ...firstAdapter, selected_model: "moonshot-v1-provider-b", reasoning_effort: "max" };
  const baseOptions = {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: 5000,
    hostSessionKey: routeKey,
  };

  const first = await runHostAgentRequest(firstAdapter, "first-turn", { ...baseOptions, taskId: "kimi-provider-first" });
  assert.equal(first.ok, true, first.error);
  const second = await runHostAgentRequest(replacementAdapter, "second-turn", { ...baseOptions, taskId: "kimi-provider-second" });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.session_id, first.session_id, "Kimi model/thinking changes must preserve the provider session");
  assert.equal(second.transport_pid, first.transport_pid, "Kimi model/thinking changes must preserve the ACP process");

  const all = await readJsonl(logFile);
  const methods = all.filter((entry) => entry.event === "request").map((entry) => entry.method);
  const configUpdates = all.filter((entry) => entry.event === "request" && entry.method === "session/set_config_option");
  assert.equal(new Set(all.map((entry) => entry.pid)).size, 1, "Kimi model/thinking changes must use one ACP process");
  assert.equal(methods.filter((method) => method === "session/new").length, 1, "Kimi model/thinking changes must bootstrap exactly one session");
  assert.equal(methods.filter((method) => method === "session/resume" || method === "session/load").length, 0, "Kimi model/thinking changes must not resume/load the live session");
  assert(configUpdates.some((entry) => entry.params?.configId === "model" && entry.params?.value === "moonshot-v1-provider-b"), "Kimi must apply the second-turn model in place");
  assert(configUpdates.some((entry) => entry.params?.configId === "thinking" && entry.params?.value === "max"), "Kimi must apply the second-turn thinking level in place");

  const closed = await closeHostAgentSession(routeKey);
  assert.equal(closed.accepted, true, "Kimi in-place configuration route must be closable");
}

async function verifyCodexCrashRecoveryUsesResumeOnlyAfterCrash(tempRoot) {
  const logFile = path.join(tempRoot, "codex-crash-rpc.jsonl");
  const script = await writeCodexAppServerStub(tempRoot);
  const sourceHome = path.join(tempRoot, "source-codex-crash-home");
  const runtimeHome = path.join(tempRoot, "runtime-codex-crash-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  await writeFile(path.join(sourceHome, "config.toml"), "model = \"stub\"\n", "utf8");
  process.env.JCC_SOURCE_CODEX_HOME = sourceHome;
  process.env.JCC_CODEX_RUNTIME_HOME = runtimeHome;
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const adapter = {
    provider: "codex",
    available: true,
    spawn_command: process.execPath,
    spawn_prefix_args: [script],
  };
  const baseOptions = {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: 5000,
    hostSessionKey: "match:codex-crash-recovery",
  };

  const first = await runHostAgentRequest(adapter, "first-turn", { ...baseOptions, taskId: "codex-crash-first" });
  assert.equal(first.ok, true, first.error);
  const savedThreadId = first.thread_id;
  const second = await runHostAgentRequest(adapter, "second-turn", { ...baseOptions, taskId: "codex-crash-second" });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.thread_id, savedThreadId);
  const preCrash = await readJsonl(logFile);
  const preCrashMethods = preCrash.filter((entry) => entry.event === "request").map((entry) => entry.method);
  assert.equal(preCrashMethods.filter((method) => method === "thread/start").length, 1, "pre-crash Codex turns must bootstrap one thread");
  assert.equal(preCrashMethods.filter((method) => method === "thread/resume").length, 0, "pre-crash Codex turns must not resume");
  assert.equal(new Set(preCrash.map((entry) => entry.pid)).size, 1, "pre-crash Codex turns must share one process");

  const crashed = await runHostAgentRequest(adapter, "crash-now", { ...baseOptions, taskId: "codex-crash-now", timeoutMs: 1000 });
  assert.equal(crashed.ok, false, "Codex crash turn must fail when the app-server process exits");
  await waitForCondition(
    async () => new Set((await readJsonl(logFile)).map((entry) => entry.pid)).size === 1
      && (await readJsonl(logFile)).some((entry) => entry.event === "process-crashing"),
    "Codex crash was not observed",
  );

  const recovered = await runHostAgentRequest(adapter, "after-crash", {
    ...baseOptions,
    taskId: "codex-after-crash",
    hostSessionId: savedThreadId,
  });
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal(recovered.thread_id, savedThreadId, "Codex crash recovery must reuse the saved provider thread id");
  assert.equal(recovered.response.request_id, "after-crash");

  const all = await readJsonl(logFile);
  const methods = all.filter((entry) => entry.event === "request").map((entry) => entry.method);
  const pids = new Set(all.map((entry) => entry.pid));
  assert.equal(pids.size, 2, "Codex crash recovery must start exactly one replacement app-server process");
  assert.equal(methods.filter((method) => method === "thread/start").length, 1, "Codex crash recovery must not create a sibling thread");
  assert.equal(methods.filter((method) => method === "thread/resume").length, 1, "Codex crash recovery must perform exactly one thread/resume");
  assert.equal(methods.filter((method) => method === "turn/start").length, 4, "Codex recovery route must answer the later turn after resume");

  const closed = await closeHostAgentSession("match:codex-crash-recovery");
  assert.equal(closed.accepted, true, "Codex crash-recovered route must still be closable");
}

async function verifyKimiCrashRecoveryUsesResumeOnlyAfterCrash(tempRoot) {
  const logFile = path.join(tempRoot, "kimi-crash-rpc.jsonl");
  const script = await writeKimiAcpStub(tempRoot);
  const launcher = await writeLauncher(tempRoot, "fake-kimi-crash-acp", script);
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const adapter = {
    provider: "kimi",
    available: true,
    command: launcher,
    build_args: ["acp"],
    kimi_home: path.join(tempRoot, ".kimi-crash-code"),
  };
  const baseOptions = {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: 5000,
    hostSessionKey: "daily:kimi-crash-recovery",
  };

  const first = await runHostAgentRequest(adapter, "first-turn", { ...baseOptions, taskId: "kimi-crash-first" });
  assert.equal(first.ok, true, first.error);
  const savedSessionId = first.session_id;
  const second = await runHostAgentRequest(adapter, "second-turn", { ...baseOptions, taskId: "kimi-crash-second" });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.session_id, savedSessionId);
  const preCrash = await readJsonl(logFile);
  const preCrashMethods = preCrash.filter((entry) => entry.event === "request").map((entry) => entry.method);
  assert.equal(preCrashMethods.filter((method) => method === "session/new").length, 1, "pre-crash Kimi prompts must bootstrap one session");
  assert.equal(preCrashMethods.filter((method) => method === "session/resume" || method === "session/load").length, 0, "pre-crash Kimi prompts must not resume/load");
  assert.equal(new Set(preCrash.map((entry) => entry.pid)).size, 1, "pre-crash Kimi prompts must share one process");

  const crashed = await runHostAgentRequest(adapter, "crash-now", { ...baseOptions, taskId: "kimi-crash-now", timeoutMs: 1000 });
  assert.equal(crashed.ok, false, "Kimi crash prompt must fail when the ACP process exits");
  await waitForCondition(
    async () => new Set((await readJsonl(logFile)).map((entry) => entry.pid)).size === 1
      && (await readJsonl(logFile)).some((entry) => entry.event === "process-crashing"),
    "Kimi crash was not observed",
  );

  const recovered = await runHostAgentRequest(adapter, "after-crash", {
    ...baseOptions,
    taskId: "kimi-after-crash",
    hostSessionId: savedSessionId,
  });
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal(recovered.session_id, savedSessionId, "Kimi crash recovery must reuse the saved provider session id");
  assert.equal(recovered.response.request_id, "after-crash");

  const all = await readJsonl(logFile);
  const methods = all.filter((entry) => entry.event === "request").map((entry) => entry.method);
  const pids = new Set(all.map((entry) => entry.pid));
  assert.equal(pids.size, 2, "Kimi crash recovery must start exactly one replacement ACP process");
  assert.equal(methods.filter((method) => method === "session/new").length, 1, "Kimi crash recovery must not create a sibling session");
  assert.equal(methods.filter((method) => method === "session/resume" || method === "session/load").length, 1, "Kimi crash recovery must perform exactly one session/resume or session/load");
  assert.equal(methods.filter((method) => method === "session/prompt").length, 4, "Kimi recovery route must answer the later prompt after resume/load");

  const closed = await closeHostAgentSession("daily:kimi-crash-recovery");
  assert.equal(closed.accepted, true, "Kimi crash-recovered route must still be closable");
}

async function verifyCodexCloseReapsPendingBootstrap(tempRoot) {
  const logFile = path.join(tempRoot, "codex-pending-rpc.jsonl");
  const script = await writeCodexAppServerStub(tempRoot, { delayThreadStartMs: 10000 });
  const sourceHome = path.join(tempRoot, "source-codex-pending-home");
  const runtimeHome = path.join(tempRoot, "runtime-codex-pending-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  await writeFile(path.join(sourceHome, "config.toml"), "model = \"stub\"\n", "utf8");
  process.env.JCC_SOURCE_CODEX_HOME = sourceHome;
  process.env.JCC_CODEX_RUNTIME_HOME = runtimeHome;
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const adapter = {
    provider: "codex",
    available: true,
    spawn_command: process.execPath,
    spawn_prefix_args: [script],
  };
  const baseOptions = {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: 15000,
    hostSessionKey: "match:codex-pending-close",
  };

  const pending = runHostAgentRequest(adapter, "first-turn", { ...baseOptions, taskId: "codex-pending-first" });
  await waitForCondition(
    async () => (await readJsonl(logFile)).some((entry) => entry.event === "request" && entry.method === "thread/start"),
    "Codex pending thread/start was not observed",
  );
  const pendingPid = (await readJsonl(logFile)).find((entry) => entry.event === "request" && entry.method === "thread/start")?.pid;
  const preemptedAt = Date.now();
  const preemption = preemptHostAgentSessionStart("match:codex-pending-close");
  assert.equal(preemption.accepted, true, "preempting a pending Codex route must be accepted");
  assert.equal(preemption.transport_close_requested, true, "pending Codex app-server transport must receive immediate close");
  const closed = await closeHostAgentSession("match:codex-pending-close");
  assert(Date.now() - preemptedAt < 3000, "closing a pending Codex bootstrap must not wait for the provider lifecycle timeout");
  assert.equal(closed.accepted, true, "closing a pending Codex route must be accepted");
  assert.equal(closed.pending_start_reaped, true, "pending Codex bootstrap must be reaped");
  assert.equal(closed.pending_start_transport_closed, true, closed.error || "pending Codex transport must confirm exit");
  assert.throws(() => process.kill(pendingPid, 0), "pending Codex transport PID must be gone before close returns");
  const pendingResult = await pending;
  assert.equal(pendingResult.ok, false, "closing pending Codex bootstrap must prevent the pending turn from answering");

  const later = await runHostAgentRequest(adapter, "after-cancel", { ...baseOptions, taskId: "codex-pending-later" });
  assert.equal(later.ok, true, later.error);
  assert.equal(later.response.request_id, "after-cancel");
  const all = await readJsonl(logFile);
  const pids = new Set(all.map((entry) => entry.pid));
  const methods = all.filter((entry) => entry.event === "request").map((entry) => entry.method);
  assert.equal(pids.size, 2, "a later Codex turn after pending close must use a fresh app-server process");
  assert.equal(methods.filter((method) => method === "thread/start").length, 2, "Codex pending close plus later fresh turn should produce two bootstrap attempts");
  assert.equal(methods.filter((method) => method === "thread/resume").length, 0, "Codex pending close recovery without saved id must not resume");
  assert.equal(methods.filter((method) => method === "turn/start").length, 1, "only the fresh post-close Codex process may answer a turn");
  await closeHostAgentSession("match:codex-pending-close");
}

async function verifyKimiCloseReapsPendingBootstrap(tempRoot) {
  const logFile = path.join(tempRoot, "kimi-pending-rpc.jsonl");
  const script = await writeKimiAcpStub(tempRoot, { delaySessionNewMs: 10000 });
  const launcher = await writeLauncher(tempRoot, "fake-kimi-pending-acp", script);
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const adapter = {
    provider: "kimi",
    available: true,
    command: launcher,
    build_args: ["acp"],
    kimi_home: path.join(tempRoot, ".kimi-pending-code"),
  };
  const baseOptions = {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: 15000,
    hostSessionKey: "daily:kimi-pending-close",
  };

  const pending = runHostAgentRequest(adapter, "first-turn", { ...baseOptions, taskId: "kimi-pending-first" });
  await waitForCondition(
    async () => (await readJsonl(logFile)).some((entry) => entry.event === "request" && entry.method === "session/new"),
    "Kimi pending session/new was not observed",
  );
  const pendingPid = (await readJsonl(logFile)).find((entry) => entry.event === "request" && entry.method === "session/new")?.pid;
  const preemptedAt = Date.now();
  const preemption = preemptHostAgentSessionStart("daily:kimi-pending-close");
  assert.equal(preemption.accepted, true, "preempting a pending Kimi route must be accepted");
  assert.equal(preemption.transport_close_requested, true, "pending Kimi ACP transport must receive immediate close");
  const closed = await closeHostAgentSession("daily:kimi-pending-close");
  assert(Date.now() - preemptedAt < 3000, "closing a pending Kimi bootstrap must not wait for the provider lifecycle timeout");
  assert.equal(closed.accepted, true, "closing a pending Kimi route must be accepted");
  assert.equal(closed.pending_start_reaped, true, "pending Kimi bootstrap must be reaped");
  assert.equal(closed.pending_start_transport_closed, true, closed.error || "pending Kimi transport must confirm exit");
  assert.throws(() => process.kill(pendingPid, 0), "pending Kimi transport PID must be gone before close returns");
  const pendingResult = await pending;
  assert.equal(pendingResult.ok, false, "closing pending Kimi bootstrap must prevent the pending prompt from answering");

  const later = await runHostAgentRequest(adapter, "after-cancel", { ...baseOptions, taskId: "kimi-pending-later" });
  assert.equal(later.ok, true, later.error);
  assert.equal(later.response.request_id, "after-cancel");
  const all = await readJsonl(logFile);
  const pids = new Set(all.map((entry) => entry.pid));
  const methods = all.filter((entry) => entry.event === "request").map((entry) => entry.method);
  assert.equal(pids.size, 2, "a later Kimi prompt after pending close must use a fresh ACP process");
  assert.equal(methods.filter((method) => method === "session/new").length, 2, "Kimi pending close plus later fresh prompt should produce two bootstrap attempts");
  assert.equal(methods.filter((method) => method === "session/resume" || method === "session/load").length, 0, "Kimi pending close recovery without saved id must not resume/load");
  assert.equal(methods.filter((method) => method === "session/prompt").length, 1, "only the fresh post-close Kimi process may answer a prompt");
  await closeHostAgentSession("daily:kimi-pending-close");
}

function sampleHostRequest(overrides = {}) {
  const stageRound = overrides.stageRound || "2-1";
  const mode = overrides.mode || "augment_choice";
  const activeMode = overrides.activeMode || mode;
  const query = overrides.query || "Which augment should I pick?";
  return {
    request_id: overrides.request_id || `request-${stageRound}-${mode}`,
    request_hash: overrides.request_hash || `hash-${stageRound}-${mode}`,
    mode,
    task: { prompt: query },
    user_message: query,
    user_preferences: { rank_tier: "master", preferred_style: "flex" },
    user_strategy_memory: {
      schema: "jcc-runtime-user-memory-v1",
      strategy_rows: [{ text: "Prefer stable top-four lines", weight: 1, approved: true }],
      strategy_conflict_notices: [],
    },
    daily_big_data: overrides.daily_big_data || {
      stat_date: "20260726",
      snapshot_hash: "rank-a",
      lineups: [{ display_name: "line-a", placement: 4.2 }],
    },
    season_catalog: {
      season_id: "s17",
      champion_names: ["Annie", "Ahri", "Garen"],
      champions_by_cost: { 1: ["Annie"], 2: ["Ahri"], 4: ["Garen"] },
    },
    strategy_wiki_context: {
      pages: [{ page_id: "wiki-a", category: "universal_gameplay_strategy", title: "Tempo" }],
    },
    runtime_context: {
      host_session_kind: "match",
      active_mode: activeMode,
      active_rules_bundle: overrides.active_rules_bundle || {
        source_fingerprint: "rules-a",
        version_identity: { season_id: "s17", patch_id: "17.7" },
        base_game_rules: { economy: ["interest thresholds"] },
        season_normal_rules: { mechanics: ["normal rules"] },
        season_special_rules: { mechanic: "set mechanic" },
      },
      coach_rules_brief: { timing: { choice_mechanics: [] } },
      coach_signature_contract: { schema: "signature" },
      season_host_mode_addons: { augment_choice: ["score current candidates"], cruise: ["short action advice"] },
      current_turn_contract: {
        match_session_id: "match-a",
        stage_round: stageRound,
        rules_source_fingerprint: "rules-a",
      },
      game_rule_contract: { stage_round: stageRound },
      game_state_brief: { stage_round: stageRound, economy_label: overrides.economy_label || "stable" },
      match_facts: { latest_user_intent: { text: overrides.intent || "play flexible" } },
      cruise_decision_context: { strategy_fit_packet: { candidate_lines: [] } },
    },
    context: {
      live_state_summary: {
        phase: { stage_round: stageRound },
        economy: {
          hp: overrides.hp ?? 90,
          gold: overrides.gold ?? 20,
          level: overrides.level ?? 4,
          xp: "0/10",
        },
      },
      choices: overrides.choices || [{ name: "Combat A" }, { name: "Economy B" }, { name: "Flex C" }],
    },
  };
}

function verifyContextCapsuleAndDelta() {
  const first = sampleHostRequest();
  const laterStage = sampleHostRequest({
    stageRound: "2-2",
    request_id: "request-stage-change",
    request_hash: "hash-stage-change",
    hp: 82,
    gold: 31,
    query: "Now what?",
  });
  const laterMode = sampleHostRequest({
    stageRound: "3-1",
    mode: "cruise",
    activeMode: "cruise",
    request_id: "request-mode-change",
    request_hash: "hash-mode-change",
    query: "Should I level or roll?",
  });
  const laterQuery = sampleHostRequest({
    request_id: "request-query-change",
    request_hash: "hash-query-change",
    query: "Can I greed one more round?",
    intent: "lean economy if stable",
  });

  const capsuleA = hostContextCapsuleForRequest(first, { routeKey: "match:match-a", provider: "codex", model: "gpt-test" });
  const capsuleStage = hostContextCapsuleForRequest(laterStage, { routeKey: "match:match-a", provider: "codex", model: "gpt-test" });
  const capsuleMode = hostContextCapsuleForRequest(laterMode, { routeKey: "match:match-a", provider: "codex", model: "gpt-test" });
  const capsuleQuery = hostContextCapsuleForRequest(laterQuery, { routeKey: "match:match-a", provider: "codex", model: "gpt-test" });
  assert.equal(capsuleA.fingerprint, capsuleStage.fingerprint, "dynamic stage/economy changes must not invalidate static context");
  assert.equal(capsuleA.fingerprint, capsuleMode.fingerprint, "dynamic mode changes must not invalidate static context");
  assert.equal(capsuleA.fingerprint, capsuleQuery.fingerprint, "dynamic query/intent changes must not invalidate static context");
  assert(capsuleA.static_context.season_catalog, "season catalog must be injected in the static bootstrap");
  assert(capsuleA.static_context.daily_big_data, "daily big data must be injected in the static bootstrap");
  assert.equal(capsuleA.static_context.user_preferences.rank_tier, "master", "durable user preferences must be injected in the static bootstrap");
  assert.equal(capsuleA.static_context.user_strategy_memory.strategy_rows[0].text, "Prefer stable top-four lines", "durable user strategy memory must be injected in the static bootstrap");
  assert(capsuleA.static_context.strategy_wiki_context, "published strategy wiki must be injected in the static bootstrap");
  assert(capsuleA.static_context.rules, "common and season rules must be injected in the static bootstrap");
  assert(capsuleA.static_context.rules.base_game_rules, "base rules must be part of static bootstrap");
  assert(capsuleA.static_context.rules.season_normal_rules, "season normal rules must be part of static bootstrap");
  assert(capsuleA.static_context.rules.season_special_rules, "season special rules must be part of static bootstrap");

  const changedRankings = sampleHostRequest({
    stageRound: "2-2",
    daily_big_data: { stat_date: "20260727", snapshot_hash: "rank-b" },
  });
  const capsuleRankings = hostContextCapsuleForRequest(changedRankings, { routeKey: "match:match-a", provider: "codex", model: "gpt-test" });
  assert.notEqual(capsuleA.fingerprint, capsuleRankings.fingerprint, "static ranking snapshot changes must force rebootstrap");

  const changedRules = sampleHostRequest({
    active_rules_bundle: {
      source_fingerprint: "rules-b",
      version_identity: { season_id: "s17", patch_id: "17.8" },
      base_game_rules: { economy: ["changed"] },
    },
  });
  const capsuleRules = hostContextCapsuleForRequest(changedRules, { routeKey: "match:match-a", provider: "codex", model: "gpt-test" });
  assert.notEqual(capsuleA.fingerprint, capsuleRules.fingerprint, "static rules identity changes must force rebootstrap");

  const changedPreferencesRequest = sampleHostRequest();
  changedPreferencesRequest.user_preferences = { rank_tier: "diamond", preferred_style: "tempo" };
  const capsulePreferences = hostContextCapsuleForRequest(changedPreferencesRequest, { routeKey: "match:match-a", provider: "codex", model: "gpt-test" });
  assert.notEqual(capsuleA.fingerprint, capsulePreferences.fingerprint, "durable user preference changes must update static context in the same live session");

  const changedMemoryRequest = sampleHostRequest();
  changedMemoryRequest.user_strategy_memory.strategy_rows[0].text = "Prefer first-place cap lines";
  const capsuleMemory = hostContextCapsuleForRequest(changedMemoryRequest, { routeKey: "match:match-a", provider: "codex", model: "gpt-test" });
  assert.notEqual(capsuleA.fingerprint, capsuleMemory.fingerprint, "durable user strategy changes must update static context in the same live session");

  const changedModel = hostContextCapsuleForRequest(first, { routeKey: "match:match-a", provider: "codex", model: "gpt-other" });
  assert.equal(capsuleA.fingerprint, changedModel.fingerprint, "model changes must not invalidate static context or replace the live conversation");
  const changedProvider = hostContextCapsuleForRequest(first, { routeKey: "match:match-a", provider: "kimi", model: "gpt-other" });
  assert.notEqual(capsuleA.fingerprint, changedProvider.fingerprint, "provider transport changes must force rebootstrap");

  const bootstrap = buildHostSessionBootstrapPrompt(first, capsuleA);
  const warmup = buildHostSessionWarmupPrompt(first, capsuleA);
  const delta = buildHostTurnDeltaPrompt(laterMode, capsuleA);
  assert(bootstrap.includes("JCC_RUNTIME_SESSION_BOOTSTRAP"));
  assert(bootstrap.includes("season_catalog"));
  assert(bootstrap.includes("daily_big_data"));
  assert(bootstrap.includes("user_preferences"));
  assert(bootstrap.includes("user_strategy_memory"));
  assert(bootstrap.includes("strategy_wiki_context"));
  assert(bootstrap.includes("base_game_rules"));
  assert(!bootstrap.includes("HOST_TURN_EXECUTION_PROTOCOL_JSON"), "bootstrap must not freeze a per-turn execution protocol");
  assert(!bootstrap.includes("JCC_RUNTIME_CURRENT_TURN_DELTA:"), "session bootstrap must not include a gameplay turn delta");
  assert(!warmup.includes("HOST_TURN_EXECUTION_PROTOCOL_JSON"), "warmup must contain static knowledge only");
  assert(!warmup.includes("JCC_RUNTIME_CURRENT_TURN_DELTA:"), "warmup bootstrap must not include a gameplay turn delta");
  assert(delta.includes("JCC_RUNTIME_CURRENT_TURN_DELTA"));
  assert(delta.includes("current_turn_contract"));
  assert(delta.includes("live_state_summary"));
  assert(delta.includes("choices"));
  assert(delta.includes('"mode":"cruise"'), "turn delta must carry the current dynamic mode");
  assert(delta.includes("Should I level or roll?"), "turn delta must carry the current dynamic query");
  assert(delta.includes('"stage_round":"3-1"'), "turn delta must carry the current dynamic stage");
  assert(!delta.includes('"season_catalog"'), "later turn delta must not resend the static season catalog");
  assert(!delta.includes('"daily_big_data"'), "later turn delta must not resend the full daily big-data snapshot");
  assert(!delta.includes('"user_strategy_memory"'), "later turn delta must not resend durable user strategy memory");
  assert(!delta.includes('"strategy_wiki_context"'), "later turn delta must not resend the static wiki snapshot");
  assert(!delta.includes('"base_game_rules"'), "later turn delta must not resend static base rules");

  const dailyRoute = hostSessionRouteForState({
    mode: "daily_chat",
    dailySessionGeneration: 7,
    matchSessionId: null,
  });
  const matchRoute = hostSessionRouteForState({
    mode: "cruise",
    dailySessionGeneration: 7,
    matchSessionId: "match-a",
  });
  assert.equal(dailyRoute.key, "daily:7");
  assert.equal(matchRoute.key, "match:match-a");
  assert.notEqual(dailyRoute.key, matchRoute.key, "lobby and match provider sessions must be isolated");
}

function verifyStartMatchReadinessSemantics() {
  assert.deepEqual(
    startMatchReadiness({ watcher: { ok: true }, hostWarmup: { ok: true } }),
    {
      ok: true,
      match_created: true,
      ready: true,
      watcher_ready: true,
      host_ready: true,
      previous_match_route_closed: true,
      previous_watcher_stopped: true,
      status: "ready",
      degraded_reasons: [],
    },
  );
  const hostFailed = startMatchReadiness({
    watcher: { ok: true },
    hostWarmup: { ok: false, status: "host_cli_unavailable" },
  });
  assert.equal(hostFailed.ok, false);
  assert.equal(hostFailed.match_created, true);
  assert.equal(hostFailed.host_ready, false);
  assert.equal(hostFailed.watcher_ready, true);
  assert.equal(hostFailed.status, "host_warmup_failed");
  const watcherFailed = startMatchReadiness({
    watcher: { ok: false, watcher: { error: "watcher unavailable" } },
    hostWarmup: { ok: true },
  });
  assert.equal(watcherFailed.ok, false);
  assert.equal(watcherFailed.host_ready, true);
  assert.equal(watcherFailed.watcher_ready, false);
  assert.equal(watcherFailed.status, "watcher_failed");
  const bothFailed = startMatchReadiness({
    watcher: { ok: false, error: "watcher unavailable" },
    hostWarmup: { ok: false, error: "host unavailable" },
  });
  assert.equal(bothFailed.status, "start_match_degraded");
  assert.deepEqual(bothFailed.degraded_reasons, ["watcher_failed", "host_warmup_failed"]);
  const watcherMissing = startMatchReadiness({
    watcher: null,
    hostWarmup: { ok: true },
  });
  assert.equal(watcherMissing.ready, false, "missing watcher startup evidence must not be treated as ready");
  assert.equal(watcherMissing.watcher_ready, false);
  assert.equal(watcherMissing.status, "watcher_failed");
  const priorRouteStillAlive = startMatchReadiness({
    watcher: { ok: true },
    hostWarmup: { ok: false, status: "previous_match_host_route_close_failed" },
    previousMatchRouteClose: { closed: false, error: "old provider still alive" },
    previousWatcherTermination: { stopped: true },
  });
  assert.equal(priorRouteStillAlive.ready, false);
  assert.equal(priorRouteStillAlive.previous_match_route_closed, false);
  assert.equal(priorRouteStillAlive.status, "previous_match_host_route_close_failed");
  const priorWatcherStillAlive = startMatchReadiness({
    watcher: { ok: false, status: "previous_watcher_termination_failed" },
    hostWarmup: { ok: true },
    previousMatchRouteClose: { closed: true },
    previousWatcherTermination: { stopped: false, error: "old watcher still alive" },
  });
  assert.equal(priorWatcherStillAlive.ready, false);
  assert.equal(priorWatcherStillAlive.previous_watcher_stopped, false);
  assert.equal(priorWatcherStillAlive.status, "previous_watcher_termination_failed");
}

async function verifyBoundedWatcherTermination() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  assert(Number.isInteger(child.pid) && child.pid > 0, "test watcher process must expose a PID");
  const termination = await terminateProcessTreeByPid(child.pid, 4000);
  assert.equal(termination.attempted, true, "live watcher termination must be attempted");
  assert.equal(termination.stopped, true, termination.error || "watcher process tree must stop before termination returns");
  assert.throws(() => process.kill(child.pid, 0), "terminated watcher PID must no longer exist");
}

async function verifyWatcherPidReuseIsNeverTerminated() {
  const previous = getRuntimeServiceState();
  let terminationCalls = 0;
  try {
    setRuntimeServiceState({
      ...previous,
      watcher: {
        status: "running",
        pid: 424242,
        process_identity: {
          status: "observed",
          pid: 424242,
          started_at: "2026-09-16T00:00:00.000Z",
          executable_path: "C:\\old-watcher.exe",
        },
      },
    });
    const repaired = await repairStaleWatcherProcess("pid_reuse_contract_test", {
      inspectProcess: () => ({
        status: "observed",
        pid: 424242,
        started_at: "2026-09-16T00:00:00.001Z",
        executable_path: "C:\\old-watcher.exe",
      }),
      terminateProcess: async () => {
        terminationCalls += 1;
        return { attempted: true, stopped: true, pid: 424242 };
      },
    });
    assert.equal(repaired, true);
    assert.equal(terminationCalls, 0, "a reused PID must never reach process-tree termination");
    assert.equal(getRuntimeServiceState().watcher.status, "stopped");
    assert.equal(getRuntimeServiceState().watcher.stopped_reason, "watcher_pid_reused_replacement_preserved");
    const expected = getRuntimeServiceState().watcher.process_identity;
    const terminateProcess = async () => {
      terminationCalls += 1;
      return { attempted: true, stopped: true, pid: expected.pid };
    };
    const reused = await killWatcher({
      inspectProcess: () => ({ ...expected, started_at: "2026-09-16T00:00:00.001Z" }),
      terminateProcess,
    });
    assert.equal(reused.stopped, true, "verified retired owner must not block a new match");
    assert.equal(reused.replacement_process_preserved, true);
    const unknown = await killWatcher({
      inspectProcess: () => ({ status: "unverifiable", pid: expected.pid }), terminateProcess,
    });
    assert.equal(unknown.stopped, false);
    assert.equal(terminationCalls, 0);
    const matching = await killWatcher({ inspectProcess: () => expected, terminateProcess });
    assert.equal(matching.stopped, true);
    assert.equal(terminationCalls, 1, "only the exact process instance may be terminated");
  } finally {
    setRuntimeServiceState(previous);
  }
}

async function verifyLiveWatcherHandleSurvivesFailedTermination() {
  const previous = getRuntimeServiceState();
  const ownedHandle = { pid: 515151 };
  let calls = 0;
  try {
    setRuntimeServiceState({ ...previous, watcher: { status: "running", pid: ownedHandle.pid } });
    setWatcherProcessForTest(ownedHandle);
    const failed = await killWatcher({
      terminateProcess: async () => {
        calls += 1;
        return { attempted: true, stopped: false, pid: ownedHandle.pid, error: "still alive" };
      },
    });
    assert.equal(failed.stopped, false);
    const retried = await killWatcher({
      inspectProcess: () => {
        throw new Error("PID fallback must not run while the owned child handle is retained");
      },
      terminateProcess: async () => {
        calls += 1;
        return { attempted: true, stopped: true, pid: ownedHandle.pid, error: null };
      },
    });
    assert.equal(retried.stopped, true);
    assert.equal(calls, 2);
  } finally {
    setWatcherProcessForTest(null);
    setRuntimeServiceState(previous);
  }
}

function verifyStopThenStartUsesOnlyActiveOwnership() {
  const idle = matchOwnershipForReplacement({
    match_session: { status: "idle", match_session_id: null, previous_match_session_id: "retired-match" },
    host_sessions: { match: { status: "stopped", route_key: null, previous_route_key: "match:retired-match" } },
  });
  assert.equal(idle.active_match_session_id, null);
  assert.equal(idle.active_route_key, null);
  assert.equal(idle.retired_match_session_id, "retired-match");
  assert.equal(idle.retired_route_key, "match:retired-match");

  const active = matchOwnershipForReplacement({
    match_session: { status: "active", match_session_id: "active-match", previous_match_session_id: "retired-match" },
    host_sessions: { match: { status: "ready", route_key: "match:active-match", previous_route_key: "match:retired-match" } },
  });
  assert.equal(active.active_match_session_id, "active-match");
  assert.equal(active.active_route_key, "match:active-match");

  const canonicalIdle = {
    match_session: { status: "idle", match_session_id: null, previous_match_session_id: "retired-match" },
    response_task: { status: "idle", revision: 4 },
    response_task_revision: 4,
  };
  const incoming = {
    ...canonicalIdle,
    match_session: { status: "active", match_session_id: "new-match" },
    host_sessions: { match: { route_key: "match:new-match", match_session_id: "new-match" } },
  };
  const merged = mergeRuntimeServiceCanonicalSnapshot(canonicalIdle, incoming, {
    event_type: "match_session_boundary_started",
    event_payload: { previous_match_session_id: null, match_session_id: "new-match" },
  });
  assert.equal(merged.applied, true, merged.reason);
  assert.equal(merged.state.match_session.match_session_id, "new-match");
  const canonicalActive = { ...canonicalIdle,
    match_session: { status: "active", match_session_id: "active-match" } };
  const activeTransition = mergeRuntimeServiceCanonicalSnapshot(canonicalActive, incoming, {
    event_type: "match_session_boundary_started",
    event_payload: { previous_match_session_id: active.active_match_session_id, match_session_id: "new-match" },
  });
  assert.equal(activeTransition.applied, true);
  const staleTransition = mergeRuntimeServiceCanonicalSnapshot(canonicalActive, incoming, {
    event_type: "match_session_boundary_started",
    event_payload: { previous_match_session_id: null, match_session_id: "new-match" },
  });
  assert.equal(staleTransition.applied, false);
}

async function verifyRejectedMatchBoundaryStopsPersistence() {
  const previous = getRuntimeServiceState();
  let writes = 0;
  try {
    const canonical = { ...previous, match_session: { status: "active", match_session_id: "current-owner" } };
    setRuntimeServiceState({ ...previous, match_session: { status: "active", match_session_id: "rejected-new-match" } });
    setRuntimeServiceCanonicalStateWriter(async () => {
      writes += 1;
      return { applied: false, reason: "match_session_boundary_ownership_mismatch", state: canonical };
    });
    await assert.rejects(persistStateAndCanonicalResponseTask({ event_type: "match_session_boundary_started" }),
      { code: "JCC_RUNTIME_TRANSITION_STALE" });
    assert.equal(writes, 1, "a rejected match boundary must not retry or advance startup");
    assert.equal(getRuntimeServiceState().match_session.match_session_id, "current-owner");
  } finally {
    setRuntimeServiceCanonicalStateWriter(null);
    setRuntimeServiceState(previous);
  }
}

async function verifyRuntimeServiceLifecycleWiring() {
  const serviceText = await readFile(path.join(root, "ui/electron/runtime-service.js"), "utf8");
  const daemonText = await readFile(path.join(root, "ui/electron/runtime-daemon.js"), "utf8");
  assert(
    serviceText.includes("const previousOwnership = matchOwnershipForReplacement(state)")
      && serviceText.includes("const previousMatchRouteKey = previousOwnership.retired_route_key")
      && serviceText.includes("const previousMatchSessionId = previousOwnership.retired_match_session_id")
      && serviceText.includes("previous_match_session_id: previousOwnership.active_match_session_id"),
    "Start Match must retain retired ownership for cleanup and use only active ownership for boundary CAS",
  );
  assert(
    serviceText.includes("previousMatchRouteClosePromise = previousMatchRouteKey")
      && serviceText.includes("previousMatchRouteClose = await previousMatchRouteClosePromise"),
    "Start Match must close and audit the prior match provider process/session",
  );
  const startMatchStart = serviceText.indexOf("async function startMatch()");
  const startMatchEnd = serviceText.indexOf("\n}\n\nasync function stopMatch", startMatchStart);
  const startMatchBody = serviceText.slice(startMatchStart, startMatchEnd);
  assert(
    startMatchBody.indexOf('event_type: "match_session_boundary_started"') < startMatchBody.indexOf("previousMatchRouteClosePromise = previousMatchRouteKey"),
    "Start Match must persist the new canonical match boundary before closing the prior provider route",
  );
  assert(
    startMatchBody.includes("const previousOwnersStopped = previousWatcherTermination.stopped")
      && startMatchBody.includes("const watcher = previousOwnersStopped")
      && startMatchBody.includes("const hostWarmup = previousOwnersStopped"),
    "replacement watcher and Host provider must share one prior-owner termination gate",
  );
  assert(
    startMatchBody.indexOf("const previousWatcherTermination = await killWatcher()")
      < startMatchBody.indexOf("await clearMatchScopedRuntimeFiles()"),
    "Start Match must stop the old watcher before clearing and publishing the new match workspace",
  );
  assert(
    startMatchBody.includes("!previousMatchRouteClose || previousMatchRouteClose.closed === true")
      && startMatchBody.includes("previousWatcherTermination.stopped"),
    "Start Match readiness must fail closed when the old provider or watcher did not confirm exit",
  );
  assert(
    serviceText.includes('event_type: "host_session_state_changed"')
      && serviceText.includes('await persistHostSessionState(route.kind, "warmup_completed")')
      && serviceText.includes('await persistHostSessionState(invocation.route.kind, "host_turn_completed")'),
    "native provider session ids and capsule fingerprints must be persisted through the daemon canonical writer",
  );
  assert(
    startMatchBody.includes("const hostWarmup = previousOwnersStopped")
      && startMatchBody.includes("? await warmHostSession({"),
    "Start Match must wait for the new provider-native match session bootstrap instead of fire-and-forget warmup",
  );
  assert(
    startMatchBody.includes("const readiness = startMatchReadiness({")
      && startMatchBody.includes("previousMatchRouteClose,")
      && startMatchBody.includes("previousWatcherTermination,")
      && startMatchBody.includes("...readiness"),
    "Start Match must expose explicit watcher/Host readiness instead of treating watcher startup as complete readiness",
  );
  assert(
    startMatchBody.includes('resetMatchScopedRuntimeState("superseded_by_new_match"')
      && startMatchBody.includes('cancelResponseTaskHostRun(previousResponseTask, "cancelled_by_new_match")'),
    "Start Match must cancel the old provider turn and replace its persisted payload with a clean new-match scope",
  );
  assert(
    serviceText.includes("const previousWatcherTermination = await killWatcher()")
      && serviceText.includes("const watcherTermination = await killWatcher()"),
    "Start/Stop/Exit must await watcher process-tree termination instead of reporting fire-and-forget shutdown",
  );
  assert(
    serviceText.includes("return structuredClone(canonical)")
      && serviceText.includes('invalidateHostStaticContextSource("canonical_user_strategy_memory_hydrated")'),
    "host static context must read user strategy memory from SQLite-hydrated canonical state, not a legacy JSON mirror",
  );
  assert(
    serviceText.includes('scope: "startup",\n      mode: "daily_chat",\n      reason: "host_provider_transport_changed"'),
    "provider transport changes must rebuild the persistent lobby route",
  );
  assert(
    serviceText.includes('scope: "match",\n        mode: "cruise",\n        reason: "host_provider_transport_changed"'),
    "provider transport changes during a match must also rebuild the persistent match route",
  );
  for (const functionName of ["closeWindow", "shutdownRuntime"]) {
    const start = serviceText.indexOf(`async function ${functionName}`);
    const end = serviceText.indexOf("\n}", start);
    const body = serviceText.slice(start, end);
    assert(start >= 0 && body.includes("markRuntimeCleanShutdown"), `${functionName} must commit the clean-shutdown marker`);
    assert(
      body.indexOf("markRuntimeCleanShutdown") > body.indexOf("closeAllHostAgentSessions"),
      `${functionName} must not mark shutdown clean before provider sessions are closed`,
    );
    assert(
      body.includes("closedHostSessions.closed === true"),
      `${functionName} must require every provider route to confirm transport exit`,
    );
    assert(
      body.includes("termination_failed"),
      `${functionName} must preserve a generation lease when provider or watcher termination is unconfirmed`,
    );
    assert(
      body.indexOf("markRuntimeCleanShutdown") > body.indexOf("resetAllRapidOcrWorkers"),
      `${functionName} must not mark shutdown clean before OCR workers are reaped`,
    );
    if (functionName === "closeWindow") {
      const watcherFailureBranch = body.indexOf("if (!watcherTermination.stopped)");
      assert(
        body.indexOf("closeAllHostAgentSessions") < watcherFailureBranch
          && body.indexOf("resetAllRapidOcrWorkers") < watcherFailureBranch,
        "closeWindow must reap Host sessions and OCR workers even when watcher termination fails",
      );
    }
  }
  assert.match(
    daemonText,
    /daemonPreemptiveControlSignals[\s\S]*"shutdown"/,
    "shutdown must signal cancellation before waiting on the daemon action chain",
  );
  assert.match(
    daemonText,
    /action === "shutdown"[\s\S]*preemptHostAgentSessionStart/,
    "shutdown must preempt provider bootstrap routes before serialized cleanup",
  );
}

function verifyRuntimeInvocationStateMachine() {
  const previous = getRuntimeServiceState();
  try {
    const request = sampleHostRequest();
    setRuntimeServiceState({
      ...previous,
      host_cli: {
        ...(previous.host_cli || {}),
        provider: "codex",
        command: "codex",
        version: "test",
        selected_model: "gpt-test",
        default_model: "gpt-test",
        reasoning_effort: "high",
      },
      match_session: {
        status: "active",
        match_session_id: "match-a",
      },
      active_mode: "augment_choice",
      host_sessions: {
        ...(previous.host_sessions || {}),
        match: {
          status: "idle",
          route_id: "match",
          route_key: "match:match-a",
          match_session_id: "match-a",
          provider_session_id: null,
          context_fingerprint: null,
          capsule_id: null,
          provider_identity: null,
          context_keys: [],
        },
      },
    });

    const bootstrap = prepareHostSessionInvocation(request);
    assert.equal(bootstrap.bootstrap_required, true);
    assert.equal(bootstrap.static_context_update_required, false);
    assert.equal(bootstrap.transport_recovery_required, false);
    assert.equal(bootstrap.host_session_id, null);
    assert(bootstrap.prompt.includes("JCC_RUNTIME_SESSION_BOOTSTRAP"));

    const liveDescriptor = {
      status: "ready",
      route_id: "match",
      route_key: bootstrap.route.key,
      match_session_id: "match-a",
      provider_session_id: "provider-match-a",
      context_fingerprint: bootstrap.capsule.fingerprint,
      capsule_id: bootstrap.capsule.capsule_id,
      provider_identity: bootstrap.provider_identity,
      context_keys: [],
    };
    setRuntimeServiceState({
      ...getRuntimeServiceState(),
      host_sessions: {
        ...getRuntimeServiceState().host_sessions,
        match: liveDescriptor,
      },
    });
    const delta = prepareHostSessionInvocation(sampleHostRequest({ stageRound: "2-2", query: "Next action?" }));
    assert.equal(delta.bootstrap_required, false);
    assert(delta.prompt.includes("jcc-host-turn-execution-contract-v1"), "normal turns must carry the unified execution contract");
    assert.equal(delta.static_context_update_required, false);
    assert.equal(delta.transport_recovery_required, false);
    assert.equal(delta.host_session_id, "provider-match-a");
    assert(delta.prompt.includes("JCC_RUNTIME_CURRENT_TURN_DELTA"));
    assert(!delta.prompt.includes("STATIC_CONTEXT_JSON"));

    const changedStatic = prepareHostSessionInvocation(sampleHostRequest({
      daily_big_data: { stat_date: "20260727", snapshot_hash: "rank-b" },
    }));
    assert.equal(changedStatic.bootstrap_required, false);
    assert.equal(changedStatic.static_context_update_required, true);
    assert.equal(changedStatic.host_session_id, "provider-match-a");
    assert(changedStatic.prompt.includes("JCC_RUNTIME_STATIC_CONTEXT_UPDATE"));
    assert(!changedStatic.prompt.includes("HOST_TURN_EXECUTION_PROTOCOL_JSON"), "static context updates must not freeze a per-turn execution protocol");

    setRuntimeServiceState({
      ...getRuntimeServiceState(),
      host_sessions: {
        ...getRuntimeServiceState().host_sessions,
        match: {
          ...liveDescriptor,
          status: "recovering",
        },
      },
    });
    const recovering = prepareHostSessionInvocation(request);
    assert.equal(recovering.bootstrap_required, false);
    assert.equal(recovering.transport_recovery_required, true);
    assert.equal(recovering.host_session_id, "provider-match-a");

    setRuntimeServiceState({
      ...getRuntimeServiceState(),
      host_cli: {
        ...getRuntimeServiceState().host_cli,
        selected_model: "gpt-other",
      },
      host_sessions: {
        ...getRuntimeServiceState().host_sessions,
        match: liveDescriptor,
      },
    });
    const changedModelConfiguration = prepareHostSessionInvocation(request);
    assert.equal(changedModelConfiguration.bootstrap_required, false);
    assert.equal(changedModelConfiguration.static_context_update_required, false);
    assert.equal(changedModelConfiguration.host_session_id, "provider-match-a");

    setRuntimeServiceState({
      ...getRuntimeServiceState(),
      host_cli: {
        ...getRuntimeServiceState().host_cli,
        command: "codex-other-transport",
      },
      host_sessions: {
        ...getRuntimeServiceState().host_sessions,
        match: liveDescriptor,
      },
    });
    const changedProviderTransport = prepareHostSessionInvocation(request);
    assert.equal(changedProviderTransport.bootstrap_required, true);
    assert.equal(changedProviderTransport.host_session_id, null);
  } finally {
    setRuntimeServiceState(previous);
  }
}

function verifyRuntimeBootstrapDisposition() {
  const descriptor = {
    route_key: "daily:4",
    provider_session_id: "provider-daily-4",
    runtime_instance_id: "runtime-a",
  };
  assert.equal(dailyHostSessionBootstrapDisposition({
    descriptor,
    runtimeLifecycle: { clean_shutdown: false },
    runtimeInstanceId: "runtime-a",
  }), "reuse_live_runtime");
  assert.equal(dailyHostSessionBootstrapDisposition({
    descriptor,
    runtimeLifecycle: { clean_shutdown: false },
    runtimeInstanceId: "runtime-b",
  }), "start_new_app_session");
  assert.equal(dailyHostSessionBootstrapDisposition({
    descriptor,
    runtimeLifecycle: { clean_shutdown: true },
    runtimeInstanceId: "runtime-b",
  }), "start_new_app_session");
  for (const [appLaunchId, clean_shutdown, expected] of [
    ["app-a", false, "reuse_live_runtime"],
    ["app-b", false, "start_new_app_session"],
    ["app-a", true, "start_new_app_session"],
  ]) {
    assert.equal(dailyHostSessionBootstrapDisposition({
      descriptor, runtimeLifecycle: { app_launch_id: "app-a", clean_shutdown },
      runtimeInstanceId: "runtime-a", appLaunchId,
    }), expected);
  }
  assert.equal(dailyHostSessionBootstrapDisposition({
    descriptor, runtimeLifecycle: { retirement_failed: true }, runtimeInstanceId: "runtime-a",
  }), "start_new_app_session");
}

function verifyStrategyEvidenceLedgerReuse() {
  const previous = getRuntimeServiceState();
  try {
    const request = sampleHostRequest({
      mode: "cruise",
      activeMode: "cruise",
      stageRound: "2-2",
      request_id: "ledger-first",
      request_hash: "ledger-first-hash",
      query: "给出完整阵容方向",
    });
    request.provider_readonly_tool_mode = "prefetch_complete";
    request.task = {
      prompt: request.user_message,
      trigger_id: "lineup_convergence_checkpoint",
      fixed_checkpoint_id: "cruise:2-2:lineup-direction",
    };
    request.runtime_context.strategy_fit_packet = {
      schema: "jcc-strategy-fit-packet-v1",
      candidate_working_set: [{
        candidate_id: "ledger-candidate-a",
        line_id: "ledger-candidate-a",
        display_name: "完整候选 A",
        candidate_evidence_id: "ledger-evidence-a",
        selected_variant_id: "ledger-variant-a",
        atomic_roster_id: "ledger-roster-a",
        roster_is_atomic: true,
        atomic_roster_members: ["前排甲", "后排乙", "功能丙"],
        main_carry: { champion_name: "后排乙", cost: 4 },
        primary_tank: { champion_name: "前排甲", cost: 4 },
        main_traits: ["测试羁绊3"],
        target_population: 8,
        equipment_requirements: { carry: ["测试装备"] },
        lifecycle_prior: { formation_burden: "medium" },
        formation_profile: { target_population: 8 },
        provenance: { source_role: "master_plus" },
      }],
      candidate_working_set_count: 1,
      candidate_working_set_source_count: 1,
      candidate_working_set_limit: 10,
      requested_display_count: 3,
      candidate_lines: [],
    };
    const workingCandidate = request.runtime_context.strategy_fit_packet.candidate_working_set[0];
    request.selected_ranking_candidates = {
      schema: "jcc-live-rankings-selected-candidates-v1",
      candidate_working_set_count: 1,
      candidate_working_set_source_count: 1,
      candidate_working_set_limit: 10,
      candidates: [workingCandidate],
    };
    setRuntimeServiceState({
      ...previous,
      runtime_lifecycle: {
        ...(previous.runtime_lifecycle || {}),
        runtime_instance_id: "runtime-test-instance",
      },
      host_cli: {
        ...(previous.host_cli || {}),
        provider: "codex",
        command: "codex",
        version: "test",
        selected_model: "gpt-test",
        default_model: "gpt-test",
        reasoning_effort: "high",
      },
      match_session: { status: "active", match_session_id: "match-a" },
      active_mode: "cruise",
      host_sessions: {
        ...(previous.host_sessions || {}),
        match: {
          status: "idle",
          route_id: "match",
          route_key: "match:match-a",
          match_session_id: "match-a",
          provider_session_id: null,
          context_fingerprint: null,
          capsule_id: null,
          provider_identity: null,
          context_keys: [],
          context_ledger: {
            schema: "jcc-host-context-ledger-v1",
            runtime_instance_id: null,
            match_session_id: null,
            stable_strategy_evidence: null,
          },
        },
      },
    });

    const first = prepareHostSessionInvocation(request);
    assert(first.prompt.includes("JCC_RUNTIME_SESSION_BOOTSTRAP"),
      "a cold route must prepare static bootstrap separately from the first gameplay turn");
    const firstTurnPrompt = buildHostTurnDeltaPrompt(request, first.capsule);
    const firstDelta = JSON.parse(firstTurnPrompt.slice(firstTurnPrompt.lastIndexOf("INPUT_JSON:\n") + "INPUT_JSON:\n".length));
    assert.equal(first.stable_evidence_reused, false);
    assert.equal(firstDelta.runtime_context.strategy_fit_packet.candidate_working_set.length, 1,
      "first strategic turn must carry complete candidate evidence");
    assert(first.stable_strategy_evidence?.fingerprint);
    assert.equal(firstDelta.selected_ranking_candidates.candidates, undefined,
      "first strategic turn must keep the complete candidate body in one canonical strategy packet");
    assert.equal(firstDelta.selected_ranking_candidates.candidate_refs.length, 1,
      "first strategic turn must expose only candidate references at the duplicate surface");

    const afterFirst = getRuntimeServiceState();
    const runtimeInstanceId = first.runtime_instance_id;
    const untrustedDescriptor = {
      ...afterFirst.host_sessions.match,
      status: "ready",
      provider_session_id: "provider-match-a",
      provider_identity: first.provider_identity,
      context_fingerprint: first.capsule.fingerprint,
      capsule_id: first.capsule.capsule_id,
      context_ledger: {
        schema: "jcc-host-context-ledger-v1",
        runtime_instance_id: null,
        match_session_id: "match-a",
        stable_strategy_evidence: first.stable_strategy_evidence,
      },
    };
    setRuntimeServiceState({ ...afterFirst, host_sessions: { ...afterFirst.host_sessions, match: untrustedDescriptor } });
    const secondRequest = structuredClone(request);
    secondRequest.request_id = "ledger-second";
    secondRequest.request_hash = "ledger-second-hash";
    secondRequest.user_message = "继续这个方向并结合当前经济执行";
    secondRequest.runtime_context.game_state_brief = { stage_round: "2-5", economy_label: "stable" };
    secondRequest.runtime_context.current_turn_contract.stage_round = "2-5";
    const untrusted = prepareHostSessionInvocation(secondRequest);
    const untrustedDelta = JSON.parse(untrusted.prompt.slice(untrusted.prompt.lastIndexOf("INPUT_JSON:\n") + "INPUT_JSON:\n".length));
    assert.equal(untrusted.stable_evidence_reused, false,
      "an untrusted ledger must fail closed and resend complete evidence");
    assert.equal(untrustedDelta.runtime_context.strategy_fit_packet.candidate_working_set.length, 1);

    const trustedDescriptor = {
      ...untrustedDescriptor,
      context_ledger: {
        ...untrustedDescriptor.context_ledger,
        runtime_instance_id: runtimeInstanceId,
      },
    };
    setRuntimeServiceState({ ...getRuntimeServiceState(), host_sessions: { ...getRuntimeServiceState().host_sessions, match: trustedDescriptor } });
    const trusted = prepareHostSessionInvocation(secondRequest);
    const trustedDelta = JSON.parse(trusted.prompt.slice(trusted.prompt.lastIndexOf("INPUT_JSON:\n") + "INPUT_JSON:\n".length));
    assert.equal(trusted.stable_evidence_reused, true,
      "same session, capsule, and working-set identity must enable reuse");
    assert(trusted.prompt.length < untrusted.prompt.length,
      "trusted evidence reuse must reduce the serialized turn payload");
    assert(trusted.prompt.length < first.prompt.length,
      "trusted evidence reuse must be smaller than the first full-evidence turn");
    assert.equal(trustedDelta.runtime_context.strategy_fit_packet.candidate_working_set, undefined,
      "reused turn must not duplicate the complete candidate body");
    assert.equal(trustedDelta.runtime_context.strategy_fit_packet.candidate_working_set_reused, true);
    assert.equal(trustedDelta.runtime_context.decision_guard.stage_round, "2-5",
      "trusted evidence reuse must preserve current dynamic game facts");
    assert.equal(trustedDelta.selected_ranking_candidates.candidates, undefined,
      "reused turn must keep only candidate references at the duplicate surface");
    assert.equal(trustedDelta.selected_ranking_candidates.candidate_refs.length, 1);

    const wideRequest = structuredClone(request);
    wideRequest.task = { prompt: "Compare available candidates" };
    delete wideRequest.selected_ranking_candidates;
    wideRequest.runtime_context.strategy_fit_packet.candidate_working_set = Array.from({ length: 10 }, (_, index) => ({
      ...structuredClone(workingCandidate), candidate_id: `bounded-${index}`, line_id: `bounded-${index}`,
      candidate_evidence_id: `bounded-evidence-${index}`, selected_variant_id: `bounded-variant-${index}`,
    }));
    const boundedFirst = prepareHostSessionInvocation(wideRequest);
    const boundedDelta = JSON.parse(boundedFirst.prompt.slice(boundedFirst.prompt.lastIndexOf("INPUT_JSON:\n") + "INPUT_JSON:\n".length));
    const deliveredIds = boundedDelta.runtime_context.strategy_fit_packet.candidate_working_set.map(row => row.candidate_id);
    assert(deliveredIds.length < 10, "fixture must exercise a smaller delivered pool than retrieval input");
    assert.deepEqual(boundedFirst.stable_strategy_evidence.candidate_ids, deliveredIds,
      "ledger must acknowledge only complete candidates actually emitted");
    const boundedState = getRuntimeServiceState();
    setRuntimeServiceState({ ...boundedState, host_sessions: { ...boundedState.host_sessions, match: {
      ...boundedState.host_sessions.match,
      context_fingerprint: boundedFirst.capsule.fingerprint,
      context_ledger: { runtime_instance_id: boundedFirst.runtime_instance_id, match_session_id: "match-a",
        stable_strategy_evidence: boundedFirst.stable_strategy_evidence },
    } } });
    const boundedSecond = prepareHostSessionInvocation(wideRequest);
    assert.equal(boundedSecond.stable_evidence_reused, true);
    assert.deepEqual(boundedSecond.stable_strategy_evidence.candidate_ids, deliveredIds);
    const reusedDelta = JSON.parse(boundedSecond.prompt.slice(boundedSecond.prompt.lastIndexOf("INPUT_JSON:\n") + "INPUT_JSON:\n".length));
    assert.equal(reusedDelta.runtime_context.host_evidence_materialization.agent_candidate_count, deliveredIds.length);

    setRuntimeServiceState({
      ...getRuntimeServiceState(),
      match_session: { status: "active", match_session_id: "match-b" },
      host_sessions: {
        ...getRuntimeServiceState().host_sessions,
        match: { ...getRuntimeServiceState().host_sessions.match, route_key: "match:match-b", match_session_id: "match-b" },
      },
    });
    const newMatch = prepareHostSessionInvocation(secondRequest);
    const newMatchDelta = JSON.parse(newMatch.prompt.slice(newMatch.prompt.lastIndexOf("INPUT_JSON:\n") + "INPUT_JSON:\n".length));
    assert.equal(newMatch.stable_evidence_reused, false, "new Start Match must never reuse the old match ledger");
    assert.equal(newMatchDelta.runtime_context.strategy_fit_packet.candidate_working_set.length, 1);
  } finally {
    setRuntimeServiceState(previous);
  }
}

async function verifyDailyResetAndStopMatchBoundaries() {
  const previous = getRuntimeServiceState();
  try {
    setRuntimeServiceState({
      ...previous,
      daily_session: { status: "inactive", mode: null, generation: 7 },
      match_session: { status: "active", match_session_id: "match-a" },
      active_mode: "cruise",
      response_task: { status: "completed", response_task_id: null },
      host_sessions: {
        daily: {
          status: "ready",
          route_id: "daily",
          route_key: "daily:7",
          daily_session_generation: 7,
          provider_session_id: "provider-daily-7",
          context_fingerprint: "daily-fingerprint",
          capsule_id: "daily-capsule",
          provider_identity: { provider: "codex" },
          context_keys: [],
        },
        match: {
          status: "ready",
          route_id: "match",
          route_key: "match:match-a",
          match_session_id: "match-a",
          provider_session_id: "provider-match-a",
          context_fingerprint: "match-fingerprint",
          capsule_id: "match-capsule",
          provider_identity: { provider: "codex" },
          context_keys: [],
        },
      },
    });
    const reset = await handleRuntimeAction("resetDailySession", {}, null);
    assert.equal(reset.ok, true);
    assert.equal(reset.state.daily_session.generation, 8);
    assert.equal(reset.state.host_sessions.daily.route_key, "daily:8");
    assert.equal(reset.state.host_sessions.daily.provider_session_id, null);
    assert.equal(reset.state.match_session.match_session_id, "match-a");
    assert.equal(reset.state.host_sessions.match.route_key, "match:match-a");
    assert.equal(reset.state.host_sessions.match.provider_session_id, "provider-match-a");

    const stopped = await handleRuntimeAction("stopMatch", {}, null);
    assert.equal(stopped.ok, true);
    assert.equal(stopped.state.match_session.status, "idle");
    assert.equal(stopped.state.host_sessions.match.status, "stopped");
    assert.equal(stopped.state.host_sessions.match.route_key, null);
    assert.equal(stopped.state.host_sessions.match.provider_session_id, null);
    assert.equal(stopped.state.host_sessions.match.previous_route_key, "match:match-a");
    assert.equal(stopped.state.host_sessions.match.previous_provider_session_id, "provider-match-a");
    assert.equal(stopped.state.daily_session.status, "active");
    assert.equal(stopped.state.active_mode, "daily_chat");
    assert.equal(stopped.state.host_sessions.daily.route_key, "daily:8");
  } finally {
    setRuntimeServiceState(previous);
  }
}

async function verifyCodexBootstrapThenDeltaUsesOneLiveSession(tempRoot) {
  const logFile = path.join(tempRoot, "codex-bootstrap-delta-rpc.jsonl");
  const script = await writeCodexAppServerStub(tempRoot);
  const sourceHome = path.join(tempRoot, "source-codex-bootstrap-delta-home");
  const runtimeHome = path.join(tempRoot, "runtime-codex-bootstrap-delta-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  await writeFile(path.join(sourceHome, "config.toml"), "model = \"stub\"\n", "utf8");
  process.env.JCC_SOURCE_CODEX_HOME = sourceHome;
  process.env.JCC_CODEX_RUNTIME_HOME = runtimeHome;
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const adapter = {
    provider: "codex",
    available: true,
    spawn_command: process.execPath,
    spawn_prefix_args: [script],
  };
  const routeKey = "match:bootstrap-delta";
  const request = sampleHostRequest({ request_id: "bootstrap-turn", request_hash: "bootstrap-turn-hash" });
  const capsule = hostContextCapsuleForRequest(request, {
    routeKey,
    provider: "codex",
    model: "gpt-test",
  });
  const first = await runHostAgentRequest(
    adapter,
    buildHostSessionBootstrapPrompt(request, capsule),
    {
      parseJson: true,
      repoRoot: root,
      hostCwd: tempRoot,
      timeoutMs: 5000,
      hostSessionKey: routeKey,
      taskId: "codex-bootstrap-delta-first",
    },
  );
  assert.equal(first.ok, true, first.error);

  const nextRequest = sampleHostRequest({
    stageRound: "2-2",
    request_id: "second-turn",
    request_hash: "second-turn-hash",
    query: "What is the next action?",
  });
  const deltaPrompt = buildHostTurnDeltaPrompt(nextRequest, capsule);
  assert(deltaPrompt.includes("JCC_RUNTIME_CURRENT_TURN_DELTA"));
  assert(!deltaPrompt.includes("STATIC_CONTEXT_JSON"));
  assert(!deltaPrompt.includes('"recent_user_messages"'));
  const second = await runHostAgentRequest(adapter, deltaPrompt, {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: 5000,
    hostSessionKey: routeKey,
    hostSessionId: first.thread_id,
    taskId: "codex-bootstrap-delta-second",
  });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.thread_id, first.thread_id);

  const log = await readJsonl(logFile);
  const methods = log.filter((entry) => entry.event === "request").map((entry) => entry.method);
  assert.equal(new Set(log.map((entry) => entry.pid)).size, 1, "bootstrap and later delta must use one live Codex process");
  assert.equal(methods.filter((method) => method === "thread/start").length, 1, "bootstrap and later delta must create one native thread");
  assert.equal(methods.filter((method) => method === "thread/resume").length, 0, "normal delta turn must not resume the native thread");
  assert.equal(methods.filter((method) => method === "turn/start").length, 2, "bootstrap and gameplay delta must be two turns in one native thread");
  await closeHostAgentSession(routeKey);
}

async function verifyStopResponseKeepsModeAndNativeSession(tempRoot) {
  const logFile = path.join(tempRoot, "codex-runtime-stop-rpc.jsonl");
  const script = await writeCodexAppServerStub(tempRoot);
  const sourceHome = path.join(tempRoot, "source-codex-runtime-stop-home");
  const runtimeHome = path.join(tempRoot, "runtime-codex-runtime-stop-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  await writeFile(path.join(sourceHome, "config.toml"), "model = \"stub\"\n", "utf8");
  process.env.JCC_SOURCE_CODEX_HOME = sourceHome;
  process.env.JCC_CODEX_RUNTIME_HOME = runtimeHome;
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const routeKey = "match:runtime-stop";
  const adapter = {
    provider: "codex",
    available: true,
    spawn_command: process.execPath,
    spawn_prefix_args: [script],
  };
  const options = {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: 5000,
    hostSessionKey: routeKey,
  };
  const first = await runHostAgentRequest(adapter, "first-turn", { ...options, taskId: "runtime-stop-first" });
  assert.equal(first.ok, true, first.error);
  const pending = runHostAgentRequest(adapter, "interrupt-turn", { ...options, taskId: "runtime-stop-active" });
  await waitForCondition(
    async () => (await readJsonl(logFile)).some((entry) => entry.event === "turn-started" && entry.request_id === "interrupt-turn"),
    "runtime Stop Answer test turn did not start",
  );

  const previous = getRuntimeServiceState();
  try {
    setRuntimeServiceState({
      ...previous,
      match_session: { status: "active", match_session_id: "runtime-stop" },
      active_mode: "augment_choice",
      response_task_revision: 7,
      response_task: {
        status: "running",
        response_task_id: "runtime-stop-active",
        revision: 7,
        mode: "augment_choice",
        origin: "user",
        started_at: new Date().toISOString(),
      },
      host_sessions: {
        ...(previous.host_sessions || {}),
        match: {
          status: "ready",
          route_id: "match",
          route_key: routeKey,
          match_session_id: "runtime-stop",
          provider_session_id: first.thread_id,
          context_fingerprint: "runtime-stop-fingerprint",
          capsule_id: "runtime-stop-capsule",
          provider_identity: { provider: "codex" },
          context_keys: [],
        },
      },
    });
    const stopped = await handleRuntimeAction("stopResponse", {
      response_task_id: "runtime-stop-active",
      response_task_revision: 7,
    }, null);
    assert.equal(stopped.ok, true);
    assert.equal(stopped.status, "response_cancellation_pending");
    assert.equal(stopped.response_task_cancelled, false);
    assert.equal(stopped.state.response_task.status, "cancelling");
    assert.equal(stopped.state.response_task.response_task_id, "runtime-stop-active", "unacknowledged Stop must keep the task targetable");
    assert.equal(stopped.state.active_mode, "augment_choice", "Stop Answer must preserve the active UI mode");
    assert.equal(stopped.state.host_sessions.match.provider_session_id, first.thread_id, "Stop Answer must preserve the native provider session");
    const pendingResult = await pending;
    assert.equal(pendingResult.ok, false, "stopped native turn must not complete normally");
    const settledStop = await handleRuntimeAction("stopResponse", {
      response_task_id: "runtime-stop-active",
      response_task_revision: stopped.state.response_task.revision,
    }, null);
    assert.equal(settledStop.ok, true);
    assert.equal(settledStop.response_task_cancelled, true, "exact Stop after provider settlement must close canonical task ownership");
    assert.equal(settledStop.state.response_task.status, "cancelled");

    const after = await runHostAgentRequest(adapter, "after-cancel", {
      ...options,
      hostSessionId: first.thread_id,
      taskId: "runtime-stop-after",
    });
    assert.equal(after.ok, true, after.error);
    assert.equal(after.thread_id, first.thread_id);
    const log = await readJsonl(logFile);
    const methods = log.filter((entry) => entry.event === "request").map((entry) => entry.method);
    assert.equal(new Set(log.map((entry) => entry.pid)).size, 1, "Stop Answer must keep the native process alive");
    assert.equal(methods.filter((method) => method === "thread/start").length, 1);
    assert.equal(methods.filter((method) => method === "thread/resume").length, 0);
    assert(methods.includes("turn/interrupt"));
  } finally {
    setRuntimeServiceState(previous);
    await closeHostAgentSession(routeKey);
  }
}

async function verifyRuntimeWarmupThenFirstGameplayTurnIsDeltaOnly(tempRoot, { empty = false, daily = false } = {}) {
  tempRoot = path.join(tempRoot, `warmup-${empty}-${daily}`);
  await mkdir(tempRoot, { recursive: true });
  const logFile = path.join(tempRoot, "codex-runtime-warmup-rpc.jsonl");
  const script = await writeCodexAppServerStub(tempRoot, { firstCoachAnswerIsEmpty: empty });
  const launcher = await writeLauncher(tempRoot, "codex", script);
  const sourceHome = path.join(tempRoot, "source-codex-runtime-warmup-home");
  const runtimeHome = path.join(tempRoot, "runtime-codex-runtime-warmup-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  await writeFile(path.join(sourceHome, "config.toml"), "model = \"stub\"\n", "utf8");
  process.env.JCC_SOURCE_CODEX_HOME = sourceHome;
  process.env.JCC_CODEX_RUNTIME_HOME = runtimeHome;
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const previous = getRuntimeServiceState();
  const scope = daily ? "daily" : "match";
  const mode = daily ? "daily_chat" : "cruise";
  const routeKey = daily ? "daily:1" : "match:runtime-warmup";
  const warmupContextPack = { schema: "jcc-host-agent-context-pack-v1", scope: daily ? "lobby" : "match" };
  const runtimePaths = createRuntimePaths(root, { dataRoot: tempRoot });
  const activeRulesBundle = loadActiveRulesBundle({ repoRoot: root, runtimePaths });
  const seasonVersionSnapshot = createActiveCoreProfileSnapshot(root, { runtimePaths });
  try {
    setRuntimeServiceState({
      ...previous,
      host_cli: {
        ...(previous.host_cli || {}),
        provider: "codex",
        preferred: "codex",
        display_name: "Codex CLI",
        available: true,
        command: launcher,
        spawn_command: process.execPath,
        spawn_prefix_args: [script],
        version: "test",
        selected_model: "gpt-test",
        default_model: "gpt-test",
        reasoning_effort: "high",
      },
      match_session: {
        status: daily ? "idle" : "active",
        match_session_id: "runtime-warmup",
        season_version_snapshot: seasonVersionSnapshot,
      },
      daily_session: { status: daily ? "active" : "inactive", mode: daily ? mode : null, generation: 1 },
      active_mode: mode,
      response_task: { status: "idle", response_task_id: null, revision: 0 },
      host_sessions: {
        ...(previous.host_sessions || {}),
        [scope]: {
          status: "idle",
          route_id: scope,
          route_key: routeKey,
          match_session_id: "runtime-warmup",
          provider_session_id: null,
          context_fingerprint: null,
          capsule_id: null,
          provider_identity: null,
          context_keys: [],
        },
      },
    });
    const warmed = await warmHostSession({
      scope,
      mode,
      contextPack: warmupContextPack,
      reason: "contract_test",
    });
    assert.equal(warmed.ok, true, warmed.error);
    assert.equal(warmed.route_key, routeKey);
    const afterWarmup = getRuntimeServiceState();
    assert(afterWarmup.host_sessions[scope].provider_session_id, "runtime warmup must persist the native provider session id");

    const request = sampleHostRequest({
      mode,
      activeMode: mode,
      stageRound: "2-2",
      request_id: "second-turn",
      request_hash: "second-turn-hash",
      query: "What is the next action?",
      context_pack: warmupContextPack,
    });
    // A real gameplay request carries the pack reference, not a second copy
    // of lobby/static authority. Runtime enriches these fields from its live
    // source before deciding whether the warm session can accept a delta.
    delete request.user_preferences;
    delete request.user_strategy_memory;
    delete request.daily_big_data;
    delete request.season_catalog;
    delete request.strategy_wiki_context;
    const result = await runHostModel(request, "runtime-warmup-first-gameplay-turn");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.thread_id, afterWarmup.host_sessions[scope].provider_session_id);

    const log = await readJsonl(logFile);
    const turnRequests = log.filter((entry) => entry.event === "request" && entry.method === "turn/start");
    assert.equal(turnRequests.length, empty ? 3 : 2, "one bootstrap and at most one empty-turn continuation");
    const promptText = (entry) => (Array.isArray(entry.params?.input) ? entry.params.input : [])
      .map((part) => part?.text || "")
      .join("\n");
    const bootstrapText = promptText(turnRequests[0]);
    const gameplayText = promptText(turnRequests[1]);
    if (empty) {
      assert(promptText(turnRequests[2]).startsWith("The previous provider turn completed"));
      assert(!promptText(turnRequests[2]).includes("STATIC_CONTEXT_JSON:"));
      assert.deepEqual(turnRequests[2].params.outputSchema, turnRequests[1].params.outputSchema);
      assert.equal(turnRequests[2].params.threadId, turnRequests[1].params.threadId);
      assert.equal(result.response.final_text, "second-turn completed");
    }
    assert.equal(
      turnRequests[0].params?.outputSchema?.title,
      "JCC Host Session Warmup Response",
      "Codex warmup must use the provider-native output schema",
    );
    assert.equal(turnRequests[0].params?.effort, "low", "bootstrap acknowledgement must use low reasoning effort");
    assert.equal(
      turnRequests[1].params?.outputSchema?.title,
      "JCC Host Coach Response",
      "Codex gameplay turns must use the provider-native coach schema",
    );
    assert.equal(turnRequests[1].params?.effort, "high", "gameplay turn must retain the selected reasoning effort");
    assert(bootstrapText.includes("JCC_RUNTIME_SESSION_BOOTSTRAP_ONLY:"));
    assert(bootstrapText.includes("STATIC_CONTEXT_JSON:"));
    assert(!bootstrapText.includes("JCC_RUNTIME_CURRENT_TURN_DELTA:"), "native bootstrap must not resend the gameplay delta");
    assert(gameplayText.includes("JCC_RUNTIME_CURRENT_TURN_DELTA:"));
    assert(!gameplayText.includes("JCC_RUNTIME_SESSION_BOOTSTRAP_ONLY:"));
    assert(!gameplayText.includes("STATIC_CONTEXT_JSON:"));
    assert(!gameplayText.includes('"recent_user_messages"'));
    const methods = log.filter((entry) => entry.event === "request").map((entry) => entry.method);
    assert.equal(new Set(log.map((entry) => entry.pid)).size, 1);
    assert.equal(methods.filter((method) => method === "thread/start").length, 1);
    assert.equal(methods.filter((method) => method === "thread/resume").length, 0);
  } finally {
    setRuntimeServiceState(previous);
    await closeHostAgentSession(routeKey);
  }
}

async function verifyRuntimePlainTextCoachAnswerDoesNotCreateCorrectionTurn(tempRoot) {
  const logFile = path.join(tempRoot, "codex-runtime-plain-answer-no-retry-rpc.jsonl");
  const script = await writeCodexAppServerStub(tempRoot, { firstCoachAnswerIsPlainText: true });
  const launcher = await writeLauncher(tempRoot, "codex-plain-answer-no-retry", script);
  const sourceHome = path.join(tempRoot, "source-codex-plain-answer-no-retry-home");
  const runtimeHome = path.join(tempRoot, "runtime-codex-plain-answer-no-retry-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  await writeFile(path.join(sourceHome, "config.toml"), "model = \"stub\"\n", "utf8");
  process.env.JCC_SOURCE_CODEX_HOME = sourceHome;
  process.env.JCC_CODEX_RUNTIME_HOME = runtimeHome;
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const routeKey = "match:plain-answer-no-retry";
  try {
    const adapter = {
      provider: "codex",
      available: true,
      command: launcher,
      spawn_command: process.execPath,
      spawn_prefix_args: [script],
      version: "test",
      selected_model: "gpt-test",
      default_model: "gpt-test",
      reasoning_effort: "high",
    };
    const options = {
      parseJson: true,
      jsonResponseKind: "coach",
      repoRoot: root,
      hostCwd: tempRoot,
      timeoutMs: 5000,
      hostSessionKey: routeKey,
    };
    const first = await runHostAgentRequest(adapter, "original gameplay request", {
      ...options,
      taskId: "plain-answer-no-retry-task",
    });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.response?.final_text, "我会按当前阶段整理完整建议。", "readable coach text must survive transport recovery");
    assert.equal(first.host_transport_diagnostics?.category, "coach_transport_envelope_recovered_as_text");

    const log = await readJsonl(logFile);
    const requests = log.filter((entry) => entry.event === "request");
    const turnRequests = requests.filter((entry) => entry.method === "turn/start");
    const promptText = (entry) => (Array.isArray(entry.params?.input) ? entry.params.input : [])
      .map((part) => part?.text || "")
      .join("\n");
    assert.equal(requests.filter((entry) => entry.method === "thread/start").length, 1, "one failed response must use one provider thread");
    assert.equal(turnRequests.length, 1, "an invalid response must not create a Provider correction turn");
    assert(promptText(turnRequests[0]).includes("original gameplay request"), "first turn must remain the original task");
    assert(!log.some((entry) => entry.event === "request" && promptText(entry).includes("CORRECTION_REQUIRED:")), "no correction prompt may be sent");
    assert.equal(new Set(log.map((entry) => entry.pid)).size, 1, "the failed response must use one app-server process");
  } finally {
    await closeHostAgentSession(routeKey);
  }
}

async function verifyNativeFinalDeliveryPhase(tempRoot) {
  const logFile = path.join(tempRoot, "codex-final-phase.jsonl");
  const script = await writeCodexAppServerStub(tempRoot, { deliveryPhaseMatrix: true });
  const launcher = await writeLauncher(tempRoot, "codex-final-phase", script);
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;
  const routeKey = "match:final-phase";
  const adapter = { provider: "codex", available: true, command: launcher,
    spawn_command: process.execPath, spawn_prefix_args: [script], version: "test",
    selected_model: "gpt-test", default_model: "gpt-test", reasoning_effort: "low" };
  try {
    let sessionId;
    for (const [prompt, expected] of [["fail-commentary", false], ["completed-commentary", false],
      ["fail-with-final", true], ["completed-with-final", true],
      ["completed-empty", false], ["fail-empty", false], ["tool-start-empty", false]]) {
      const result = await runHostAgentRequest(adapter, prompt, { hostSessionKey: routeKey,
        taskId: prompt, repoRoot: root, hostCwd: tempRoot, parseJson: true, jsonResponseKind: "coach", timeoutMs: 5000 });
      assert.equal(result.ok, expected, `${prompt}: ${result.error}`);
      sessionId ||= result.session_id;
      assert.equal(result.session_id, sessionId, "delivery failure must not recreate the session");
      if (expected) assert.ok(result.response.final_text.endsWith("completed"));
      else assert.equal(result.response, undefined, "commentary cannot become recovered strategy text");
      assert.equal(result.empty_completion === true, prompt === "completed-empty", "only genuinely empty successful turns are recoverable");
    }
    assert.equal((await readJsonl(logFile)).filter(row => row.method === "turn/start").length, 7,
      "no format correction or hidden retries");
  } finally { await closeHostAgentSession(routeKey); }
}

async function verifyRuntimeProviderSwitchIgnoresPriorWarmup(tempRoot) {
  const logFile = path.join(tempRoot, "codex-runtime-provider-switch-warmup-rpc.jsonl");
  const oldStubRoot = path.join(tempRoot, "provider-switch-old");
  const newStubRoot = path.join(tempRoot, "provider-switch-new");
  await mkdir(oldStubRoot, { recursive: true });
  await mkdir(newStubRoot, { recursive: true });
  const oldScript = await writeCodexAppServerStub(oldStubRoot, {
    delayTurnStartMs: 800,
    uniqueThreadIdPerProcess: true,
  });
  const newScript = await writeCodexAppServerStub(newStubRoot, {
    uniqueThreadIdPerProcess: true,
  });
  const oldLauncher = await writeLauncher(oldStubRoot, "codex", oldScript);
  const newLauncher = await writeLauncher(newStubRoot, "codex", newScript);
  const sourceHome = path.join(tempRoot, "source-codex-provider-switch-warmup-home");
  const runtimeHome = path.join(tempRoot, "runtime-codex-provider-switch-warmup-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  await writeFile(path.join(sourceHome, "config.toml"), "model = \"stub\"\n", "utf8");
  process.env.JCC_SOURCE_CODEX_HOME = sourceHome;
  process.env.JCC_CODEX_RUNTIME_HOME = runtimeHome;
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const previous = getRuntimeServiceState();
  const dailyGeneration = 77;
  const routeKey = `daily:${dailyGeneration}`;
  const baseHostCli = {
    ...(previous.host_cli || {}),
    provider: "codex",
    preferred: "codex",
    display_name: "Codex CLI",
    available: true,
    version: "test",
    default_model: "gpt-old",
    reasoning_effort: "high",
  };
  try {
    setRuntimeServiceState({
      ...previous,
      host_cli: {
        ...baseHostCli,
        command: oldLauncher,
        spawn_command: process.execPath,
        spawn_prefix_args: [oldScript],
        selected_model: "gpt-old",
      },
      daily_session: { status: "active", mode: "daily_chat", generation: dailyGeneration },
      match_session: { status: "idle", match_session_id: null },
      active_mode: "daily_chat",
      response_task: { status: "idle", response_task_id: null, revision: 0 },
      host_sessions: {
        ...(previous.host_sessions || {}),
        daily: {
          status: "idle",
          route_id: "daily",
          route_key: routeKey,
          daily_session_generation: dailyGeneration,
          provider_session_id: null,
          context_fingerprint: null,
          capsule_id: null,
          provider_identity: null,
          context_keys: [],
        },
      },
    });

    const oldWarmup = warmHostSession({
      scope: "startup",
      mode: "daily_chat",
      contextPack: { schema: "jcc-host-agent-context-pack-v1", scope: "startup" },
      reason: "provider_switch_old_warmup_contract_test",
    });
    await waitForCondition(
      async () => (await readJsonl(logFile)).some((entry) => entry.event === "request" && entry.method === "turn/start"),
      "old provider warmup did not begin",
      HOST_SESSION_TEST_OBSERVE_TIMEOUT_MS,
    );

    const switchingState = getRuntimeServiceState();
    setRuntimeServiceState({
      ...switchingState,
      host_cli: {
        ...baseHostCli,
        command: newLauncher,
        spawn_command: process.execPath,
        spawn_prefix_args: [newScript],
        selected_model: "gpt-new",
        default_model: "gpt-new",
      },
    });
    await closeHostAgentSession(routeKey);
    const closedOldProviderState = getRuntimeServiceState();
    setRuntimeServiceState({
      ...closedOldProviderState,
      host_sessions: {
        ...closedOldProviderState.host_sessions,
        daily: {
          status: "idle",
          route_id: "daily",
          route_key: routeKey,
          daily_session_generation: dailyGeneration,
          provider_session_id: null,
          context_fingerprint: null,
          capsule_id: null,
          provider_identity: null,
          context_keys: [],
        },
      },
    });

    const newWarmup = warmHostSession({
      scope: "startup",
      mode: "daily_chat",
      contextPack: { schema: "jcc-host-agent-context-pack-v1", scope: "startup" },
      reason: "provider_switch_new_warmup_contract_test",
    });
    const request = sampleHostRequest({
      mode: "daily_chat",
      activeMode: "daily_chat",
      request_id: "second-turn",
      request_hash: "second-turn-hash",
      query: "second-turn: Give me a Master-plus lobby strategy answer.",
    });
    const userTurn = runHostModel(request, "provider-switch-first-user-turn");
    const [oldResult, newResult, turnResult] = await Promise.all([oldWarmup, newWarmup, userTurn]);
    assert.equal(oldResult.ok, false, "the prior provider warmup must lose ownership after the switch");
    assert.equal(oldResult.status, "warmup_provider_expired");
    const failureEvidence = JSON.stringify({ oldResult, newResult, turnResult, log: await readJsonl(logFile) }, null, 2);
    assert.equal(newResult.ok, true, failureEvidence);
    assert.equal(turnResult.ok, true, failureEvidence);

    const after = getRuntimeServiceState();
    assert.equal(after.host_sessions.daily.provider_identity?.provider, "codex");
    assert.equal(after.host_cli.selected_model, "gpt-new");
    assert.equal(after.host_sessions.daily.provider_session_id, turnResult.thread_id);
    const log = await readJsonl(logFile);
    const requests = log.filter((entry) => entry.event === "request");
    const userTurnRequests = requests.filter((entry) => entry.method === "turn/start"
      && JSON.stringify(entry.params || {}).includes("Give me a Master-plus lobby strategy answer."));
    assert.equal(userTurnRequests.length, 1, "the immediate lobby message must be sent exactly once after switching provider identity");
    const selectedProviderPid = userTurnRequests[0].pid;
    assert.equal(
      requests.filter((entry) => entry.pid === selectedProviderPid && entry.method === "turn/start").length,
      2,
      "the selected provider process must own both its bootstrap and the immediate user turn",
    );
    assert.equal(requests.filter((entry) => entry.method === "thread/resume").length, 0);
  } finally {
    setRuntimeServiceState(previous);
    await closeHostAgentSession(routeKey).catch(() => {});
  }
}

async function verifyRuntimeProviderSwitchExpiresPriorActiveTurn(tempRoot) {
  const logFile = path.join(tempRoot, "codex-runtime-provider-switch-active-turn-rpc.jsonl");
  const oldStubRoot = path.join(tempRoot, "provider-switch-active-old");
  const newStubRoot = path.join(tempRoot, "provider-switch-active-new");
  await mkdir(oldStubRoot, { recursive: true });
  await mkdir(newStubRoot, { recursive: true });
  const oldScript = await writeCodexAppServerStub(oldStubRoot, {
    delayTurnStartMs: 700,
    uniqueThreadIdPerProcess: true,
  });
  const newScript = await writeCodexAppServerStub(newStubRoot, {
    uniqueThreadIdPerProcess: true,
  });
  const oldLauncher = await writeLauncher(oldStubRoot, "codex", oldScript);
  const newLauncher = await writeLauncher(newStubRoot, "codex", newScript);
  const sourceHome = path.join(tempRoot, "source-codex-provider-switch-active-home");
  const runtimeHome = path.join(tempRoot, "runtime-codex-provider-switch-active-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  await writeFile(path.join(sourceHome, "config.toml"), "model = \"stub\"\n", "utf8");
  process.env.JCC_SOURCE_CODEX_HOME = sourceHome;
  process.env.JCC_CODEX_RUNTIME_HOME = runtimeHome;
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const previous = getRuntimeServiceState();
  const dailyGeneration = 78;
  const routeKey = `daily:${dailyGeneration}`;
  const baseHostCli = {
    ...(previous.host_cli || {}),
    provider: "codex",
    preferred: "codex",
    display_name: "Codex CLI",
    available: true,
    version: "test",
    reasoning_effort: "high",
  };
  try {
    setRuntimeServiceState({
      ...previous,
      host_cli: {
        ...baseHostCli,
        command: oldLauncher,
        spawn_command: process.execPath,
        spawn_prefix_args: [oldScript],
        selected_model: "gpt-old-active",
        default_model: "gpt-old-active",
      },
      daily_session: { status: "active", mode: "daily_chat", generation: dailyGeneration },
      match_session: { status: "idle", match_session_id: null },
      active_mode: "daily_chat",
      response_task: { status: "idle", response_task_id: null, revision: 0 },
      host_sessions: {
        ...(previous.host_sessions || {}),
        daily: {
          status: "idle",
          route_id: "daily",
          route_key: routeKey,
          daily_session_generation: dailyGeneration,
          provider_session_id: null,
          context_fingerprint: null,
          capsule_id: null,
          provider_identity: null,
          context_keys: [],
        },
      },
    });

    const oldWarmup = await warmHostSession({
      scope: "startup",
      mode: "daily_chat",
      contextPack: { schema: "jcc-host-agent-context-pack-v1", scope: "startup" },
      reason: "provider_switch_active_old_warmup_contract_test",
    });
    assert.equal(oldWarmup.ok, true, oldWarmup.error);
    const oldRequest = sampleHostRequest({
      mode: "daily_chat",
      activeMode: "daily_chat",
      request_id: "first-turn",
      request_hash: "first-turn-hash",
      query: "first-turn old-active-turn: answer before provider switch",
    });
    const oldTurn = runHostModel(oldRequest, "provider-switch-old-active-turn");
    await waitForCondition(
      async () => (await readJsonl(logFile)).some((entry) => entry.method === "turn/start"
        && JSON.stringify(entry.params || {}).includes("old-active-turn: answer before provider switch")),
      "old provider active turn did not begin",
      HOST_SESSION_TEST_OBSERVE_TIMEOUT_MS,
    );

    const switchingState = getRuntimeServiceState();
    setRuntimeServiceState({
      ...switchingState,
      host_cli: {
        ...baseHostCli,
        command: newLauncher,
        spawn_command: process.execPath,
        spawn_prefix_args: [newScript],
        selected_model: "gpt-new-active",
        default_model: "gpt-new-active",
      },
    });
    const expiredOldTurn = await oldTurn;
    assert.equal(expiredOldTurn.ok, false, "an old active turn must lose delivery ownership after the provider changes");
    assert.equal(expiredOldTurn.status, "host_session_route_expired");

    const selectedSwitchClose = await closeHostAgentSession(routeKey);
    assert.equal(
      selectedSwitchClose.accepted,
      true,
      "the stale active turn must leave old-route cleanup to the provider-switch owner instead of closing the shared route itself",
    );
    const closedOldProviderState = getRuntimeServiceState();
    setRuntimeServiceState({
      ...closedOldProviderState,
      host_sessions: {
        ...closedOldProviderState.host_sessions,
        daily: {
          status: "idle",
          route_id: "daily",
          route_key: routeKey,
          daily_session_generation: dailyGeneration,
          provider_session_id: null,
          context_fingerprint: null,
          capsule_id: null,
          provider_identity: null,
          context_keys: [],
        },
      },
    });
    const newWarmup = await warmHostSession({
      scope: "startup",
      mode: "daily_chat",
      contextPack: { schema: "jcc-host-agent-context-pack-v1", scope: "startup" },
      reason: "provider_switch_active_new_warmup_contract_test",
    });
    assert.equal(newWarmup.ok, true, newWarmup.error);
    const newResult = await runHostModel(sampleHostRequest({
      mode: "daily_chat",
      activeMode: "daily_chat",
      request_id: "second-turn",
      request_hash: "second-turn-hash",
      query: "second-turn new-active-turn: answer on selected provider",
    }), "provider-switch-new-active-turn");
    assert.equal(newResult.ok, true, newResult.error);
    const after = getRuntimeServiceState();
    assert.equal(after.host_sessions.daily.provider_identity?.provider, "codex");
    assert.equal(after.host_cli.selected_model, "gpt-new-active");
    assert.equal(after.host_sessions.daily.provider_session_id, newResult.thread_id);
  } finally {
    setRuntimeServiceState(previous);
    await closeHostAgentSession(routeKey).catch(() => {});
  }
}

async function verifyRuntimeResumeFailureFallsBackToFreshBootstrap(tempRoot, {
  repairDuringWarmup = false,
  sendDuringWarmup = false,
  partialToolsResume = false,
} = {}) {
  const variant = partialToolsResume
    ? "partial-tools"
    : sendDuringWarmup ? "warmup-race" : repairDuringWarmup ? "warmup" : "turn";
  const logFile = path.join(tempRoot, `codex-runtime-resume-fallback-${variant}-rpc.jsonl`);
  const script = await writeCodexAppServerStub(tempRoot, {
    rejectResume: !partialToolsResume,
    resumeErrorMessage: "no rollout found for thread id codex-live-thread-stale",
    uniqueThreadIdPerProcess: true,
    uniqueThreadIdPerStart: partialToolsResume,
    partialDynamicToolsOnResume: partialToolsResume,
    deleteExitsProcess: !partialToolsResume,
  });
  const launcher = await writeLauncher(tempRoot, "codex", script);
  const sourceHome = path.join(tempRoot, `source-codex-runtime-resume-fallback-${variant}-home`);
  const runtimeHome = path.join(tempRoot, `runtime-codex-runtime-resume-fallback-${variant}-home`);
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  await writeFile(path.join(sourceHome, "config.toml"), "model = \"stub\"\n", "utf8");
  process.env.JCC_SOURCE_CODEX_HOME = sourceHome;
  process.env.JCC_CODEX_RUNTIME_HOME = runtimeHome;
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const previous = getRuntimeServiceState();
  const matchSessionId = `runtime-resume-fallback-${variant}`;
  const routeKey = `match:${matchSessionId}`;
  const runtimePaths = createRuntimePaths(root, { dataRoot: tempRoot });
  const activeRulesBundle = loadActiveRulesBundle({ repoRoot: root, runtimePaths });
  const seasonVersionSnapshot = createActiveCoreProfileSnapshot(root, { runtimePaths });
  seasonVersionSnapshot.rules_source_fingerprint = activeRulesBundle.source_fingerprint;
  try {
    setRuntimeServiceState({
      ...previous,
      host_cli: {
        ...(previous.host_cli || {}),
        provider: "codex",
        preferred: "codex",
        display_name: "Codex CLI",
        available: true,
        command: launcher,
        spawn_command: process.execPath,
        spawn_prefix_args: [script],
        version: "test",
        selected_model: "gpt-test",
        default_model: "gpt-test",
        reasoning_effort: "high",
      },
      match_session: {
        status: "active",
        match_session_id: matchSessionId,
        season_version_snapshot: seasonVersionSnapshot,
      },
      daily_session: { status: "inactive", mode: null, generation: 1 },
      active_mode: "cruise",
      response_task: { status: "idle", response_task_id: null, revision: 0 },
      host_sessions: {
        ...(previous.host_sessions || {}),
        match: {
          status: "idle",
          route_id: "match",
          route_key: routeKey,
          match_session_id: matchSessionId,
          provider_session_id: null,
          context_fingerprint: null,
          capsule_id: null,
          provider_identity: null,
          context_keys: [],
        },
      },
    });

    const warmed = await warmHostSession({
      scope: "match",
      mode: "cruise",
      contextPack: { schema: "jcc-host-agent-context-pack-v1", scope: "match" },
      reason: "resume_fallback_contract_test",
    });
    assert.equal(warmed.ok, true, warmed.error);
    const staleProviderSessionId = getRuntimeServiceState().host_sessions.match.provider_session_id;
    assert(staleProviderSessionId, "warmup must establish the provider session that later becomes unavailable");
    await closeHostAgentSession(routeKey);
    const baselineLogLength = (await readJsonl(logFile)).length;
    setRuntimeServiceState({
      ...getRuntimeServiceState(),
      host_sessions: {
        ...getRuntimeServiceState().host_sessions,
        match: {
          ...getRuntimeServiceState().host_sessions.match,
          status: repairDuringWarmup ? "recovering" : "ready",
          provider_session_id: staleProviderSessionId,
        },
      },
    });

    const request = sampleHostRequest({
      mode: "cruise",
      activeMode: "cruise",
      stageRound: "2-2",
      request_id: "second-turn",
      request_hash: "second-turn-hash",
      query: "What is the next action after recovery?",
    });
    let queuedTurn = null;
    if (repairDuringWarmup) {
      const repairedWarmupPromise = warmHostSession({
        scope: "match",
        mode: "cruise",
        contextPack: { schema: "jcc-host-agent-context-pack-v1", scope: "match" },
        reason: "resume_fallback_warmup_contract_test",
      });
      if (sendDuringWarmup) {
        queuedTurn = runHostModel(request, `runtime-resume-fallback-${variant}`);
      }
      const repairedWarmup = await repairedWarmupPromise;
      assert.equal(repairedWarmup.ok, true, repairedWarmup.error);
      assert.notEqual(
        getRuntimeServiceState().host_sessions.match.provider_session_id,
        staleProviderSessionId,
        "startup warmup must replace a provider thread whose rollout is missing",
      );
    }
    const result = queuedTurn || await runHostModel(request, `runtime-resume-fallback-${variant}`);
    const resolvedResult = await result;
    assert.equal(resolvedResult.ok, true, resolvedResult.error);
    assert.notEqual(resolvedResult.thread_id, staleProviderSessionId, "a missing provider thread must be replaced after the single recovery attempt fails");

    const recoveryLog = (await readJsonl(logFile)).slice(baselineLogLength);
    const requests = recoveryLog.filter((entry) => entry.event === "request");
    const methods = requests.map((entry) => entry.method);
    assert.equal(methods.filter((method) => method === "thread/resume").length, 1, "runtime may attempt native resume exactly once after a crash");
    assert.equal(methods.filter((method) => method === "thread/start").length, 1, "native recovery replacement must bootstrap one fresh provider thread");
    assert.equal(new Set(recoveryLog.map((entry) => entry.pid)).size, partialToolsResume ? 1 : 2,
      "recovery replacement must use the expected bounded provider transport count");
    const replacementTurns = requests.filter((entry) => entry.method === "turn/start");
    const replacementTexts = replacementTurns.map((entry) => (entry.params?.input || []).map((part) => part?.text || "").join("\n"));
    if (repairDuringWarmup) {
      assert.equal(replacementTurns.length, 2,
        "repaired warmup must fully bootstrap a replacement thread before the user turn");
      const bootstrapIndex = 0;
      const gameplayIndex = 1;
      if (partialToolsResume) {
        assert(!replacementTexts.some((text) => text.includes("JCC_RUNTIME_SESSION_RECOVERY_PROBE:")),
          "an uninitialized replacement must not receive a recovery probe");
      }
      assert(replacementTexts[bootstrapIndex].includes("JCC_RUNTIME_SESSION_BOOTSTRAP_ONLY:"),
        "the newly created thread must receive the complete static bootstrap");
      assert(replacementTexts[gameplayIndex].includes("JCC_RUNTIME_CURRENT_TURN_DELTA:"));
      assert(!replacementTexts[gameplayIndex].includes("JCC_RUNTIME_SESSION_BOOTSTRAP:"));
    } else {
      assert.equal(replacementTurns.length, 2, "recovery bootstrap and the original user turn must be separate turns in the fresh provider thread");
      assert(replacementTexts[0].includes("JCC_RUNTIME_SESSION_BOOTSTRAP_ONLY:"));
      assert(!replacementTexts[0].includes("JCC_RUNTIME_CURRENT_TURN_DELTA:"));
      assert(replacementTexts[1].includes("JCC_RUNTIME_CURRENT_TURN_DELTA:"));
      assert(!replacementTexts[1].includes("JCC_RUNTIME_SESSION_BOOTSTRAP:"));
    }
    assert.equal(getRuntimeServiceState().host_sessions.match.provider_session_id, resolvedResult.thread_id);
  } finally {
    setRuntimeServiceState(previous);
    await closeHostAgentSession(routeKey);
  }
}

async function verifyRuntimeKimiResumeFailureFallsBackToFreshBootstrap(tempRoot) {
  const logFile = path.join(tempRoot, "kimi-runtime-resume-fallback-rpc.jsonl");
  const script = await writeKimiAcpStub(tempRoot, {
    rejectResume: true,
    uniqueSessionIdPerProcess: true,
  });
  const launcher = await writeLauncher(tempRoot, "kimi", script);
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const previous = getRuntimeServiceState();
  const matchSessionId = "kimi-runtime-resume-fallback";
  const routeKey = `match:${matchSessionId}`;
  const runtimePaths = createRuntimePaths(root, { dataRoot: tempRoot });
  const activeRulesBundle = loadActiveRulesBundle({ repoRoot: root, runtimePaths });
  const seasonVersionSnapshot = createActiveCoreProfileSnapshot(root, { runtimePaths });
  seasonVersionSnapshot.rules_source_fingerprint = activeRulesBundle.source_fingerprint;
  try {
    setRuntimeServiceState({
      ...previous,
      host_cli: {
        ...(previous.host_cli || {}),
        provider: "kimi",
        preferred: "kimi",
        display_name: "Kimi Code CLI",
        available: true,
        command: launcher,
        spawn_command: null,
        spawn_prefix_args: null,
        build_args: ["acp"],
        kimi_home: path.join(tempRoot, ".kimi-runtime-resume-fallback-code"),
        version: "test",
        selected_model: "kimi-test",
        default_model: "kimi-test",
        reasoning_effort: "high",
      },
      match_session: {
        status: "active",
        match_session_id: matchSessionId,
        season_version_snapshot: seasonVersionSnapshot,
      },
      daily_session: { status: "inactive", mode: null, generation: 1 },
      active_mode: "cruise",
      response_task: { status: "idle", response_task_id: null, revision: 0 },
      host_sessions: {
        ...(previous.host_sessions || {}),
        match: {
          status: "idle",
          route_id: "match",
          route_key: routeKey,
          match_session_id: matchSessionId,
          provider_session_id: null,
          context_fingerprint: null,
          capsule_id: null,
          provider_identity: null,
          context_keys: [],
        },
      },
    });

    const warmed = await warmHostSession({
      scope: "match",
      mode: "cruise",
      contextPack: { schema: "jcc-host-agent-context-pack-v1", scope: "match" },
      reason: "kimi_resume_fallback_contract_test",
    });
    assert.equal(warmed.ok, true, warmed.error);
    const staleProviderSessionId = getRuntimeServiceState().host_sessions.match.provider_session_id;
    assert(staleProviderSessionId, "Kimi warmup must establish the provider session that later becomes unavailable");
    await closeHostAgentSession(routeKey);
    const baselineLogLength = (await readJsonl(logFile)).length;
    setRuntimeServiceState({
      ...getRuntimeServiceState(),
      host_sessions: {
        ...getRuntimeServiceState().host_sessions,
        match: {
          ...getRuntimeServiceState().host_sessions.match,
          status: "ready",
          provider_session_id: staleProviderSessionId,
        },
      },
    });

    const request = sampleHostRequest({
      mode: "cruise",
      activeMode: "cruise",
      stageRound: "2-2",
      request_id: "second-turn",
      request_hash: "second-turn-hash",
      query: "What is the next action after Kimi recovery?",
    });
    const result = await runHostModel(request, "kimi-runtime-resume-fallback");
    const allRecoveryLog = await readJsonl(logFile);
    const recoveryLog = allRecoveryLog.slice(baselineLogLength);
    assert.equal(result.ok, true, `${result.error || "Kimi recovery failed"}\n${JSON.stringify({
      baselineLogLength,
      result,
      hostCli: getRuntimeServiceState().host_cli,
      hostSession: getRuntimeServiceState().host_sessions.match,
      allRecoveryLog,
      recoveryLog,
    }, null, 2)}`);
    assert.notEqual(result.thread_id, staleProviderSessionId, "a missing Kimi provider session must be replaced after the single recovery attempt fails");

    const requests = recoveryLog.filter((entry) => entry.event === "request");
    const methods = requests.map((entry) => entry.method);
    assert.equal(
      methods.filter((method) => method === "session/resume" || method === "session/load").length,
      1,
      "runtime may attempt Kimi native resume/load exactly once after a crash",
    );
    assert.equal(methods.filter((method) => method === "session/new").length, 1, "failed Kimi native recovery must bootstrap one fresh provider session");
    assert.equal(new Set(recoveryLog.map((entry) => entry.pid)).size, 2, "failed Kimi recovery and fresh bootstrap must use two bounded replacement processes");
    const replacementTexts = requests
      .filter((entry) => entry.method === "session/prompt")
      .map((entry) => (entry.params?.prompt || []).map((part) => part?.text || "").join("\n"));
    assert.equal(replacementTexts.length, 2, "Kimi recovery bootstrap and original user turn must remain separate prompts in one fresh session");
    assert(replacementTexts[0].includes("JCC_RUNTIME_SESSION_BOOTSTRAP_ONLY:"));
    assert(!replacementTexts[0].includes("JCC_RUNTIME_CURRENT_TURN_DELTA:"));
    assert(replacementTexts[1].includes("JCC_RUNTIME_CURRENT_TURN_DELTA:"));
    assert(!replacementTexts[1].includes("JCC_RUNTIME_SESSION_BOOTSTRAP:"));
    assert(!replacementTexts[1].includes('"recent_user_messages"'));
    assert.equal(getRuntimeServiceState().host_sessions.match.provider_session_id, result.thread_id);
  } finally {
    setRuntimeServiceState(previous);
    await closeHostAgentSession(routeKey);
  }
}

async function verifyCleanShutdownEndsActiveMatchLifecycle() {
  const previous = getRuntimeServiceState();
  try {
    setRuntimeServiceState({
      ...previous,
      runtime_lifecycle: { clean_shutdown: false, runtime_instance_id: "runtime-before-exit" },
      daily_session: { status: "inactive", mode: null, generation: 4 },
      match_session: { status: "active", match_session_id: "match-before-exit" },
      active_mode: "lineup_card",
      response_task_revision: 3,
      response_task: {
        status: "completed",
        response_task_id: "completed-before-exit",
        revision: 3,
        mode: "lineup_card",
      },
      host_sessions: {
        daily: {
          status: "ready",
          route_key: "daily:4",
          daily_session_generation: 4,
          provider_session_id: "provider-daily-4",
          context_keys: [],
        },
        match: {
          status: "ready",
          route_key: "match:match-before-exit",
          match_session_id: "match-before-exit",
          provider_session_id: "provider-match-before-exit",
          runtime_instance_id: "runtime-before-exit",
          context_keys: [],
        },
      },
    });
    const shutdown = await handleRuntimeAction("shutdown", { reason: "contract_test_clean_exit" }, null);
    assert.equal(shutdown.ok, true);
    assert.equal(shutdown.state?.runtime_lifecycle?.clean_shutdown ?? getRuntimeServiceState().runtime_lifecycle.clean_shutdown, true);
    const after = getRuntimeServiceState();
    assert.equal(after.match_session.status, "idle");
    assert.equal(after.match_session.match_session_id, null);
    assert.equal(after.host_sessions.match.status, "stopped");
    assert.equal(after.host_sessions.match.route_key, null);
    assert.equal(after.host_sessions.match.provider_session_id, null);
    assert.equal(after.host_sessions.match.previous_route_key, "match:match-before-exit");
    assert.equal(after.host_sessions.match.previous_provider_session_id, "provider-match-before-exit");
    assert.equal(after.daily_session.status, "active");
    assert.equal(after.active_mode, "daily_chat");
  } finally {
    setRuntimeServiceState(previous);
  }
}

async function verifyCodexUnstartedTurnCannotFakeSuccessfulStop(tempRoot) {
  const logFile = path.join(tempRoot, "codex-slow-turn-start-rpc.jsonl");
  const script = await writeCodexAppServerStub(tempRoot, { delayTurnStartMs: 600 });
  const sourceHome = path.join(tempRoot, "source-codex-slow-turn-start-home");
  const runtimeHome = path.join(tempRoot, "runtime-codex-slow-turn-start-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  await writeFile(path.join(sourceHome, "config.toml"), "model = \"stub\"\n", "utf8");
  process.env.JCC_SOURCE_CODEX_HOME = sourceHome;
  process.env.JCC_CODEX_RUNTIME_HOME = runtimeHome;
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;
  const routeKey = "match:codex-slow-turn-start";
  const adapter = {
    provider: "codex",
    available: true,
    spawn_command: process.execPath,
    spawn_prefix_args: [script],
  };
  const options = {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: 5000,
    hostSessionKey: routeKey,
  };
  const pending = runHostAgentRequest(adapter, "interrupt-turn", { ...options, taskId: "codex-slow-start-active" });
  await waitForCondition(
    async () => (await readJsonl(logFile)).some((entry) => entry.event === "request" && entry.method === "turn/start"),
    "slow Codex turn/start request was not observed",
  );
  const cancellation = cancelHostAgentRunDetailed("codex-slow-start-active");
  assert.equal(cancellation.accepted, false, "Stop Answer must not claim success before Codex returns a turn id");
  await waitForCondition(
    async () => (await readJsonl(logFile)).some((entry) => entry.event === "turn-started" && entry.request_id === "interrupt-turn"),
    "slow Codex turn id was not exposed after the first Stop Answer attempt",
  );
  const retryCancellation = cancelHostAgentRunDetailed("codex-slow-start-active");
  assert.equal(retryCancellation.accepted, true, "a second Stop Answer must cancel the same turn after Codex exposes its turn id");
  const completed = await pending;
  assert.equal(completed.ok, false, "the second Stop Answer must interrupt the still-running native turn");
  assert.match(completed.error, /cancelled/i);
  const after = await runHostAgentRequest(adapter, "after-cancel", {
    ...options,
    hostSessionId: completed.thread_id,
    taskId: "codex-slow-start-after",
  });
  assert.equal(after.ok, true, after.error);
  const log = await readJsonl(logFile);
  const methods = log.filter((entry) => entry.event === "request").map((entry) => entry.method);
  assert.equal(new Set(log.map((entry) => entry.pid)).size, 1);
  assert.equal(methods.filter((method) => method === "thread/start").length, 1);
  assert.equal(methods.filter((method) => method === "thread/resume").length, 0);
  assert.equal(methods.filter((method) => method === "turn/interrupt").length, 1);
  assert.equal(methods.filter((method) => method === "thread/delete").length, 0);
  await closeHostAgentSession(routeKey);
}

async function verifyCodexQueuedTurnCanStopBeforeProviderStart(tempRoot) {
  const logFile = path.join(tempRoot, "codex-queued-turn-cancel-rpc.jsonl");
  const script = await writeCodexAppServerStub(tempRoot);
  const sourceHome = path.join(tempRoot, "source-codex-queued-turn-home");
  const runtimeHome = path.join(tempRoot, "runtime-codex-queued-turn-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  await writeFile(path.join(sourceHome, "config.toml"), "model = \"stub\"\n", "utf8");
  process.env.JCC_SOURCE_CODEX_HOME = sourceHome;
  process.env.JCC_CODEX_RUNTIME_HOME = runtimeHome;
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;
  const routeKey = "match:codex-queued-turn-cancel";
  const adapter = {
    provider: "codex",
    available: true,
    spawn_command: process.execPath,
    spawn_prefix_args: [script],
  };
  const options = {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: 5000,
    hostSessionKey: routeKey,
  };

  const active = runHostAgentRequest(adapter, "interrupt-turn", {
    ...options,
    taskId: "codex-queue-active",
  });
  await waitForCondition(
    async () => (await readJsonl(logFile)).some((entry) => entry.event === "turn-started" && entry.request_id === "interrupt-turn"),
    "active Codex turn did not start",
  );
  const queued = runHostAgentRequest(adapter, "second-turn", {
    ...options,
    taskId: "codex-queue-pending",
  });
  await sleep(50);

  const queuedCancellation = cancelHostAgentRunDetailed("codex-queue-pending");
  assert.equal(queuedCancellation.accepted, true, "a queued turn must be targetable before provider start");
  assert.deepEqual(
    queuedCancellation.provider_acknowledged_task_ids,
    ["codex-queue-pending"],
    "a queued turn cancellation is complete before provider start",
  );
  const repeatedQueuedCancellation = cancelHostAgentRunDetailed("codex-queue-pending");
  assert.equal(repeatedQueuedCancellation.matched_count, 0, "a provider-acknowledged queued cancellation must release its task handle immediately");

  const activeCancellation = cancelHostAgentRunDetailed("codex-queue-active");
  assert.equal(activeCancellation.accepted, true, "the active turn must remain independently targetable");
  const [activeResult, queuedResult] = await Promise.all([active, queued]);
  assert.equal(activeResult.ok, false);
  assert.match(activeResult.error, /cancelled/i);
  assert.equal(queuedResult.ok, false);
  assert.match(queuedResult.error, /cancelled before it reached the provider/i);

  const after = await runHostAgentRequest(adapter, "after-cancel", {
    ...options,
    hostSessionId: activeResult.thread_id,
    taskId: "codex-queue-after",
  });
  assert.equal(after.ok, true, after.error);
  const log = await readJsonl(logFile);
  const turnRequests = log.filter((entry) => entry.event === "request" && entry.method === "turn/start");
  assert.equal(turnRequests.length, 2, "only the active and post-cancel turns may reach the provider");
  assert.equal(
    turnRequests.some((entry) => JSON.stringify(entry.params || {}).includes("second-turn")),
    false,
    "the cancelled queued turn must never be sent to Codex",
  );
  assert.equal(new Set(log.map((entry) => entry.pid)).size, 1, "queued cancellation must preserve the native process");
  assert.equal(log.filter((entry) => entry.event === "request" && entry.method === "thread/start").length, 1);
  assert.equal(log.filter((entry) => entry.event === "request" && entry.method === "thread/resume").length, 0);
  await closeHostAgentSession(routeKey);
}

async function verifyCodexInterruptTimeoutRetainsOwnerAndQueue(tempRoot, { answerTimeout = false } = {}) {
  const logFile = path.join(tempRoot, `codex-${answerTimeout ? "answer" : "interrupt"}-timeout-rpc.jsonl`);
  const script = await writeCodexAppServerStub(tempRoot, { delayFirstInterruptMs: 3400 });
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;
  const routeKey = "match:codex-interrupt-timeout";
  const adapter = {
    provider: "codex",
    available: true,
    spawn_command: process.execPath,
    spawn_prefix_args: [script],
  };
  const options = {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: answerTimeout ? 100 : 8000,
    hostSessionKey: routeKey,
  };
  const active = runHostAgentRequest(adapter, "interrupt-turn", {
    ...options,
    taskId: "codex-interrupt-timeout-active",
  });
  await waitForCondition(
    async () => (await readJsonl(logFile)).some((entry) => entry.event === "turn-started" && entry.request_id === "interrupt-turn"),
    "Codex interrupt-timeout turn did not start",
  );
  if (answerTimeout) {
    await waitForCondition(
      async () => (await readJsonl(logFile)).some((entry) => entry.event === "turn-interrupted"),
      "answer timeout did not request interrupt",
    );
  } else {
    const firstCancellation = cancelHostAgentRunDetailed("codex-interrupt-timeout-active");
    assert.equal(firstCancellation.accepted, true);
  }
  const queued = runHostAgentRequest(adapter, "second-turn", {
    ...options,
    taskId: "codex-interrupt-timeout-queued",
  });
  await sleep(3150);
  const beforeRetry = await readJsonl(logFile);
  assert.equal(
    beforeRetry.some((entry) => entry.event === "turn-started" && entry.request_id === "second-turn"),
    false,
    "the next turn must remain queued while native interrupt settlement is unknown",
  );
  const retryCancellation = cancelHostAgentRunDetailed("codex-interrupt-timeout-active");
  assert.equal(retryCancellation.accepted, true, "a timed-out interrupt must leave the same owner targetable");
  assert.deepEqual(retryCancellation.matched_task_ids, ["codex-interrupt-timeout-active"]);
  const activeResult = await active;
  assert.equal(activeResult.ok, false);
  assert.match(activeResult.error, answerTimeout ? /timed out/i : /cancelled/i);
  const queuedResult = await queued;
  assert.equal(queuedResult.ok, true, queuedResult.error);
  const log = await readJsonl(logFile);
  assert(log.filter((entry) => entry.event === "request" && entry.method === "turn/interrupt").length >= 2,
    "the retry must send another native interrupt after the first settlement timed out");
  await closeHostAgentSession(routeKey);
}

async function verifyKimiSlowCancellationKeepsNativeSession(tempRoot) {
  const logFile = path.join(tempRoot, "kimi-slow-cancel-rpc.jsonl");
  const script = await writeKimiAcpStub(tempRoot, { cancelSettleDelayMs: 2600 });
  const launcher = await writeLauncher(tempRoot, "fake-kimi-slow-cancel", script);
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;
  const routeKey = "match:kimi-slow-cancel";
  const adapter = {
    provider: "kimi",
    available: true,
    command: launcher,
    build_args: ["acp"],
    kimi_home: path.join(tempRoot, ".kimi-slow-cancel"),
  };
  const options = {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: 5000,
    hostSessionKey: routeKey,
  };
  const pending = runHostAgentRequest(adapter, "interrupt-turn", { ...options, taskId: "kimi-slow-cancel-active" });
  await waitForCondition(
    async () => (await readJsonl(logFile)).some((entry) => entry.event === "prompt-started" && entry.request_id === "interrupt-turn"),
    "slow Kimi prompt was not observed",
  );
  const cancellation = cancelHostAgentRunDetailed("kimi-slow-cancel-active");
  assert.equal(cancellation.accepted, true);
  assert.deepEqual(cancellation.retained_task_ids, ["kimi-slow-cancel-active"]);
  const repeatedCancellation = cancelHostAgentRunDetailed("kimi-slow-cancel-active");
  assert.equal(repeatedCancellation.accepted, true, "a repeated Stop must keep targeting the same Kimi prompt while cancellation settles");
  assert.deepEqual(repeatedCancellation.matched_task_ids, ["kimi-slow-cancel-active"], "the task handle must remain targetable while provider cancellation settles");
  assert.equal(repeatedCancellation.cancellation_states["kimi-slow-cancel-active"], "provider_cancel_pending");
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /cancelled/i);

  const blocked = await runHostAgentRequest(adapter, "second-turn", {
    ...options,
    hostSessionId: cancelled.session_id,
    taskId: "kimi-slow-cancel-too-soon",
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /still cancelling/i);
  await sleep(750);
  const after = await runHostAgentRequest(adapter, "after-cancel", {
    ...options,
    hostSessionId: cancelled.session_id,
    taskId: "kimi-slow-cancel-after",
  });
  assert.equal(after.ok, true, after.error);
  assert.equal(after.session_id, cancelled.session_id);
  const log = await readJsonl(logFile);
  const methods = log.filter((entry) => entry.event === "request").map((entry) => entry.method);
  assert.equal(new Set(log.map((entry) => entry.pid)).size, 1);
  assert.equal(methods.filter((method) => method === "session/new").length, 1);
  assert.equal(methods.filter((method) => method === "session/resume" || method === "session/load").length, 0);
  await closeHostAgentSession(routeKey);
}

async function verifyCodexUnknownResumeStartsNativeReplacement(tempRoot) {
  const logFile = path.join(tempRoot, "codex-unknown-resume-rpc.jsonl");
  const script = await writeCodexAppServerStub(tempRoot, {
    uniqueThreadIdPerProcess: true,
    uniqueThreadIdPerStart: true,
    partialDynamicToolsOnResume: true,
    partialDynamicToolsOnStart: true,
    omitDynamicToolsOnPlainStart: true,
    deleteExitsProcess: false,
  });
  const sourceHome = path.join(tempRoot, "source-codex-home-unknown-resume");
  const runtimeHome = path.join(tempRoot, "runtime-codex-home-unknown-resume");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  process.env.JCC_SOURCE_CODEX_HOME = sourceHome;
  process.env.JCC_CODEX_RUNTIME_HOME = runtimeHome;
  process.env.JCC_HOST_SESSION_TEST_LOG = logFile;

  const adapter = {
    provider: "codex",
    available: true,
    spawn_command: process.execPath,
    spawn_prefix_args: [script],
  };
  const options = {
    parseJson: true,
    repoRoot: root,
    hostCwd: tempRoot,
    timeoutMs: 5000,
    hostSessionKey: "daily:unknown-resume-capability",
  };
  const first = await runHostAgentRequest(adapter, "first-turn", { ...options, taskId: "unknown-resume-first" });
  assert.equal(first.ok, true, first.error);
  const firstThreadId = first.thread_id;
  await closeHostAgentSession(options.hostSessionKey);

  const recovered = await runHostAgentRequest(adapter, "after-unknown-resume", {
    ...options,
    hostSessionId: firstThreadId,
    taskId: "unknown-resume-second",
  });
  assert.equal(recovered.ok, false);
  assert.equal(recovered.requires_bootstrap, true);
  assert.notEqual(recovered.thread_id, firstThreadId,
    "a resumed thread without explicit dynamic-tool capability must be replaced by a clean native thread");
  const rejectedBootstrap = await runHostAgentRequest(adapter, "not a bootstrap acknowledgement", {
    ...options, hostSessionId: recovered.thread_id, providerSessionBootstrap: true,
    jsonResponseKind: "session_warmup",
    bootstrapCapsuleId: "replacement-capsule", taskId: "replacement-invalid-bootstrap",
  });
  assert.equal(rejectedBootstrap.provider_session_replaced, true);
  const stillBlocked = await runHostAgentRequest(adapter, "second-turn", {
    ...options, hostSessionId: recovered.thread_id, taskId: "replacement-still-blocked",
  });
  assert.equal(stillBlocked.requires_bootstrap, true, "invalid bootstrap must retain initialization requirement");
  const bootstrap = await runHostAgentRequest(adapter,
    'JCC_RUNTIME_SESSION_BOOTSTRAP_ONLY:\n{"capsule_id":"replacement-capsule"}', {
      ...options, hostSessionId: recovered.thread_id, providerSessionBootstrap: true,
      jsonResponseKind: "session_warmup",
      bootstrapCapsuleId: "replacement-capsule", taskId: "replacement-valid-bootstrap",
    });
  assert.equal(bootstrap.ok, true, bootstrap.error);
  assert.equal(bootstrap.response.accepted, true);
  const afterBootstrap = await runHostAgentRequest(adapter, "second-turn", {
    ...options, hostSessionId: recovered.thread_id, taskId: "replacement-after-bootstrap",
  });
  assert.equal(afterBootstrap.ok, true, afterBootstrap.error);
  assert.equal(afterBootstrap.provider_session_replaced, undefined);

  const log = await readJsonl(logFile);
  const methods = log.filter((entry) => entry.event === "request").map((entry) => entry.method);
  assert.equal(methods.filter((method) => method === "thread/resume").length, 1);
  assert.equal(methods.filter((method) => method === "thread/start").length, 4,
    "unknown capability recovery must quarantine partial starts and create clean prefetch threads, not reuse an unverified thread");
  assert.equal(methods.filter((method) => method === "thread/delete").length, 4,
    "replacement must delete the resumed thread, quarantine partial native threads, and close the prior prefetch thread");
  await closeHostAgentSession(options.hostSessionKey);
}

async function verifyCodexRegistrationWithoutEcho(tempRoot) {
  const script = await writeCodexAppServerStub(tempRoot, { omitDynamicToolsOnStart: true });
  process.env.JCC_HOST_SESSION_TEST_LOG = path.join(tempRoot, "no-echo-rpc.jsonl");
  for (const route of ["daily:no-echo", "match:no-echo"]) {
    const result = await runHostAgentRequest({ provider: "codex", available: true,
      spawn_command: process.execPath, spawn_prefix_args: [script] }, "first-turn", {
      parseJson: true, repoRoot: root, hostCwd: tempRoot, timeoutMs: 10000,
      hostSessionKey: route, taskId: route,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.readonly_tool_mode, "native_dynamic_tools",
      "ThreadStartResponse does not echo dynamicTools; accepting registration must not force prefetch");
    assert.deepEqual(result.capability_receipt.declared_tools, ["jcc.query_knowledge", "jcc.calculate"]);
    assert.equal(result.capability_receipt.route_key, route);
    await closeHostAgentSession(route);
  }
  const log = await readJsonl(process.env.JCC_HOST_SESSION_TEST_LOG);
  assert.equal(log.filter((entry) => entry.event === "request" && entry.method === "thread/start").length, 2);
}

async function verifyShutdownPreemptsBeforeSerializedCleanup(tempRoot) {
  const mainSource = await readFile(path.join(root, "ui/electron/main.js"), "utf8");
  const closeSource = mainSource.split("// TESTABLE_CLEAN_WINDOW_CLOSE_START")[1]
    .split("// TESTABLE_CLEAN_WINDOW_CLOSE_END")[0];
  const runCleanWindowClose = new Function(`${closeSource}; return runCleanWindowClose;`)();
  for (const phase of ["thread/start", "turn/start"]) {
    const logFile = path.join(tempRoot, `shutdown-${phase.replace("/", "-")}.jsonl`);
    process.env.JCC_HOST_SESSION_TEST_LOG = logFile;
    const script = await writeCodexAppServerStub(tempRoot, {
      delayThreadStartMs: phase === "thread/start" ? 10000 : 0,
      delayTurnStartMs: phase === "turn/start" ? 10000 : 0,
    });
    const routeKey = "daily:91";
    const pending = runHostAgentRequest({ provider: "codex", available: true,
      spawn_command: process.execPath, spawn_prefix_args: [script] }, "interrupt-turn", {
      hostSessionKey: routeKey, hostCwd: tempRoot, repoRoot: root,
      taskId: "shutdown-unstarted", timeoutMs: 15000,
    });
    await waitForCondition(async () => (await readJsonl(logFile)).some(
      (entry) => entry.event === "request" && entry.method === phase), `missing ${phase}`);
    const order = [];
    const daemon = Object.create(JccRuntimeDaemon.prototype);
    daemon.store = {
      getJson: () => ({ daily_session: { generation: 91 }, host_sessions: { daily: { route_key: routeKey } } }),
      appendEvent: () => {},
    };
    daemon.actionChain = pending.then(() => order.push("in-flight-settled"));
    daemon.handleActionLocked = async (action) => {
      assert.equal(action, "shutdown");
      order.push("cleanup");
      await closeHostAgentSession(routeKey);
      return { ok: true };
    };
    try {
      const startedAt = Date.now();
      const result = await runCleanWindowClose({
        cleanup: () => daemon.handleAction("shutdown", { reason: "close_window" }),
        stopDaemon: async () => order.push("daemon-stopped"),
        close: () => order.push("window-closed"),
      });
      assert.equal(result.ok, true);
      assert(Date.now() - startedAt < 5000, `${phase} shutdown must preempt instead of waiting for 10s bootstrap`);
      assert.deepEqual(order, ["in-flight-settled", "cleanup", "daemon-stopped", "window-closed"]);
      assert.equal((await pending).ok, false);
    } finally {
      await closeHostAgentSession(routeKey);
      await pending;
    }
  }
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-host-session-contract-"));
  const previous = {
    sourceHome: process.env.JCC_SOURCE_CODEX_HOME,
    runtimeHome: process.env.JCC_CODEX_RUNTIME_HOME,
    log: process.env.JCC_HOST_SESSION_TEST_LOG,
  };
  try {
    configureRuntimeServicePaths({ dataRoot: tempRoot });
    const checks = [
      ["context-capsule-and-delta", async () => verifyContextCapsuleAndDelta()],
      ["codex-registration-without-echo", async () => verifyCodexRegistrationWithoutEcho(tempRoot)],
      ["start-match-readiness-semantics", async () => verifyStartMatchReadinessSemantics()],
      ["bounded-watcher-termination", async () => verifyBoundedWatcherTermination()],
      ["watcher-pid-reuse-refuses-termination", async () => verifyWatcherPidReuseIsNeverTerminated()],
      ["watcher-live-handle-retained-after-failed-termination", async () => verifyLiveWatcherHandleSurvivesFailedTermination()],
      ["stop-then-start-active-ownership", async () => verifyStopThenStartUsesOnlyActiveOwnership()],
      ["rejected-match-boundary-stops-persistence", async () => verifyRejectedMatchBoundaryStopsPersistence()],
      ["runtime-service-lifecycle-wiring", async () => verifyRuntimeServiceLifecycleWiring()],
      ["runtime-invocation-state-machine", async () => verifyRuntimeInvocationStateMachine()],
      ["strategy-evidence-ledger-reuse", async () => verifyStrategyEvidenceLedgerReuse()],
      ["runtime-bootstrap-disposition", async () => verifyRuntimeBootstrapDisposition()],
      ["daily-reset-and-stop-match-boundaries", async () => verifyDailyResetAndStopMatchBoundaries()],
      ["codex-bootstrap-then-delta-one-live-session", async () => verifyCodexBootstrapThenDeltaUsesOneLiveSession(tempRoot)],
      ["stop-response-keeps-mode-and-native-session", async () => verifyStopResponseKeepsModeAndNativeSession(tempRoot)],
      ["codex-long-lived-transport", async () => verifyCodexLongLivedTransport(tempRoot)],
      ["kimi-long-lived-transport", async () => verifyKimiLongLivedTransport(tempRoot)],
      ["codex-static-context-update-live-session", async () => verifyCodexStaticContextUpdateReusesLiveSession(tempRoot)],
      ["kimi-static-context-update-live-session", async () => verifyKimiStaticContextUpdateReusesLiveSession(tempRoot)],
      ["runtime-warmup-first-gameplay-turn-delta-only", async () => verifyRuntimeWarmupThenFirstGameplayTurnIsDeltaOnly(tempRoot)],
      ["runtime-empty-completion-match", async () => verifyRuntimeWarmupThenFirstGameplayTurnIsDeltaOnly(tempRoot, { empty: true })],
      ["runtime-empty-completion-daily", async () => verifyRuntimeWarmupThenFirstGameplayTurnIsDeltaOnly(tempRoot, { empty: true, daily: true })],
      ["runtime-plain-text-coach-answer-no-correction-turn", async () => verifyRuntimePlainTextCoachAnswerDoesNotCreateCorrectionTurn(tempRoot)],
      ["runtime-provider-switch-ignores-prior-warmup", async () => verifyRuntimeProviderSwitchIgnoresPriorWarmup(tempRoot)],
      ["runtime-provider-switch-expires-prior-active-turn", async () => verifyRuntimeProviderSwitchExpiresPriorActiveTurn(tempRoot)],
      ["codex-runtime-resume-failure-fresh-bootstrap", async () => verifyRuntimeResumeFailureFallsBackToFreshBootstrap(tempRoot)],
      ["codex-runtime-warmup-resume-failure-fresh-bootstrap", async () => verifyRuntimeResumeFailureFallsBackToFreshBootstrap(tempRoot, { repairDuringWarmup: true })],
      ["codex-runtime-partial-tools-recovery-full-bootstrap", async () => verifyRuntimeResumeFailureFallsBackToFreshBootstrap(tempRoot, { repairDuringWarmup: true, partialToolsResume: true })],
      ["codex-runtime-partial-tools-direct-turn-full-bootstrap", async () => verifyRuntimeResumeFailureFallsBackToFreshBootstrap(tempRoot, { partialToolsResume: true })],
      ["codex-runtime-immediate-turn-waits-for-recovery", async () => verifyRuntimeResumeFailureFallsBackToFreshBootstrap(tempRoot, { repairDuringWarmup: true, sendDuringWarmup: true })],
      ["kimi-runtime-resume-failure-fresh-bootstrap", async () => verifyRuntimeKimiResumeFailureFallsBackToFreshBootstrap(tempRoot)],
      ["clean-shutdown-ends-active-match-lifecycle", async () => verifyCleanShutdownEndsActiveMatchLifecycle()],
      ["codex-unstarted-turn-cannot-fake-successful-stop", async () => verifyCodexUnstartedTurnCannotFakeSuccessfulStop(tempRoot)],
      ["codex-queued-turn-can-stop-before-provider-start", async () => verifyCodexQueuedTurnCanStopBeforeProviderStart(tempRoot)],
      ["codex-interrupt-timeout-retains-owner-and-queue", async () => verifyCodexInterruptTimeoutRetainsOwnerAndQueue(tempRoot)],
      ["codex-answer-timeout-retains-owner-and-queue", async () => verifyCodexInterruptTimeoutRetainsOwnerAndQueue(tempRoot, { answerTimeout: true })],
      ["shutdown-preempts-before-serialized-cleanup", async () => verifyShutdownPreemptsBeforeSerializedCleanup(tempRoot)],
      ["kimi-slow-cancellation-keeps-native-session", async () => verifyKimiSlowCancellationKeepsNativeSession(tempRoot)],
      ["codex-model-effort-change-live-session", async () => verifyCodexModelAndEffortChangeReuseLiveSession(tempRoot)],
      ["codex-transport-version-change-replacement", async () => verifyCodexTransportVersionChangeReplacesLiveSession(tempRoot)],
      ["kimi-model-effort-change-live-session", async () => verifyKimiModelAndEffortChangeReuseLiveSession(tempRoot)],
      ["codex-crash-recovery-resume", async () => verifyCodexCrashRecoveryUsesResumeOnlyAfterCrash(tempRoot)],
      ["codex-unknown-resume-capability-replacement", async () => verifyCodexUnknownResumeStartsNativeReplacement(tempRoot)],
      ["kimi-crash-recovery-resume", async () => verifyKimiCrashRecoveryUsesResumeOnlyAfterCrash(tempRoot)],
      ["codex-pending-bootstrap-close-reap", async () => verifyCodexCloseReapsPendingBootstrap(tempRoot)],
      ["kimi-pending-bootstrap-close-reap", async () => verifyKimiCloseReapsPendingBootstrap(tempRoot)],
      ["host-adapter-contract-labels", async () => {
        assert.equal(hostAdapterContract.adapters.codex.state_policy, "runtime_authoritative_persistent_provider_session");
        assert.equal(hostAdapterContract.adapters.codex.session_transport, "persistent-codex-app-server-thread-and-turns");
        assert.equal(hostAdapterContract.adapters.kimi.state_policy, "runtime_authoritative_persistent_provider_session");
        assert.equal(hostAdapterContract.adapters.kimi.session_transport, "persistent-acp-process-session-and-prompts");
      }],
      ["native-final-delivery-phase", () => verifyNativeFinalDeliveryPhase(tempRoot)],
      ["reasoning-effort-stays-session-stable", async () => {
        const lifecycle = JSON.parse(await readFile(path.join(root, "data/runtime/jcc/host-context-lifecycle-contract.json"), "utf8"));
        assert.equal(lifecycle.reasoning_effort_policy?.selection_owner, "user_selected_host_cli_setting");
        assert.equal(lifecycle.reasoning_effort_policy?.per_turn_dynamic_routing_enabled, false);
        assert.equal(lifecycle.reasoning_effort_policy?.benchmark?.model, "gpt-5.6-sol");
        assert.equal(lifecycle.reasoning_effort_policy?.benchmark?.both_verified_same_session_and_process_per_run, true);
        assert.match(lifecycle.reasoning_effort_policy?.future_enablement_gate || "", /Never restart a lobby or match provider session/i);
      }],
    ];
    const requestedFilter = String(process.env.JCC_HOST_SESSION_TEST_FILTER || "").trim();
    const selectedChecks = requestedFilter
      ? checks.filter(([name]) => name.includes(requestedFilter))
      : checks;
    if (!selectedChecks.length) throw new Error(`No host session lifecycle check matched filter: ${requestedFilter}`);
    const passed = [];
    const failed = [];
    for (const [name, check] of selectedChecks) {
      const startedAt = Date.now();
      console.error(`[host-session-lifecycle] start ${name}`);
      try {
        await check();
        passed.push(name);
        console.error(`[host-session-lifecycle] pass ${name} (${Date.now() - startedAt}ms)`);
      } catch (error) {
        failed.push({ name, error: error?.message || String(error) });
        console.error(`[host-session-lifecycle] fail ${name} (${Date.now() - startedAt}ms)`);
      } finally {
        await closeAllHostAgentSessions().catch(() => {});
      }
    }
    if (failed.length) {
      console.error(JSON.stringify({ ok: false, passed, failed }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({
      ok: true,
      passed,
      checked: [
        "daily and match routes are isolated",
        "ordinary runtime turns use delta-only while static changes update the same provider session",
        "runtime restart disposition distinguishes same-app reuse from fresh app and daemon sessions",
        "explicit daily New Conversation rotates only the lobby route and Stop Match closes only the match route",
        "Start Match creates the new canonical match boundary before closing the prior route and waits for native bootstrap readiness; provider transport changes rebuild both owning routes",
        "static context is bootstrapped once and later turns send dynamic deltas",
        "mode/query/stage deltas do not change the static context fingerprint",
        "static data/provider/rules changes invalidate the context capsule while model/effort changes preserve it",
        "Codex uses one app-server process and one thread/start for multiple turns",
        "Codex normal turns do not call thread/resume",
        "Codex stop-current-turn interrupts only the active turn and the next turn succeeds on the same process",
        "Codex close route deletes the thread and terminates the transport",
        "Kimi uses one ACP process and one session/new for multiple prompts",
        "Kimi normal turns do not call session/resume or session/load",
        "Kimi stop-current-turn cancels only the active prompt and the next prompt succeeds on the same process",
        "Kimi close route terminates the ACP transport",
        "reasoning effort follows the user-selected session setting; per-turn routing stays disabled unless it preserves the live session and proves a material benefit",
        "Codex static context fingerprint changes update the same live process/thread once and the following normal turn reuses it without resume",
        "Kimi static context fingerprint changes update the same live process/session once and the following normal prompt reuses it without resume/load",
        "Codex model/effort changes apply to later turns in the same live process/thread",
        "Codex transport-version changes replace the owning process/thread without normal resume",
        "Kimi model/thinking changes apply through ACP in the same live process/session",
        "Codex crash recovery starts one replacement app-server and uses exactly one thread/resume",
        "Kimi crash recovery starts one replacement ACP process and uses exactly one session/resume or session/load",
        "a missing Codex thread after crash is resumed once, then replaced by one fresh bootstrap followed by the original user delta in the same thread",
        "an immediate user turn waits for startup recovery and is delivered once on the replacement Codex thread",
        "a provider transport switch isolates warmups by provider identity and delivers the immediate lobby turn once on the selected provider",
        "an in-flight old-provider turn expires without closing the shared route before the selected provider replaces it",
        "a missing Kimi ACP session after crash is resumed/loaded once, then replaced by one fresh bootstrap followed by the original user delta in the same session",
        "Codex close during pending thread/start reaps the pending transport before a later fresh process answers",
        "Kimi close during pending session/new reaps the pending transport before a later fresh process answers",
      ],
    }, null, 2));
  } finally {
    await closeAllHostAgentSessions().catch(() => {});
    if (previous.sourceHome === undefined) delete process.env.JCC_SOURCE_CODEX_HOME;
    else process.env.JCC_SOURCE_CODEX_HOME = previous.sourceHome;
    if (previous.runtimeHome === undefined) delete process.env.JCC_CODEX_RUNTIME_HOME;
    else process.env.JCC_CODEX_RUNTIME_HOME = previous.runtimeHome;
    if (previous.log === undefined) delete process.env.JCC_HOST_SESSION_TEST_LOG;
    else process.env.JCC_HOST_SESSION_TEST_LOG = previous.log;
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
