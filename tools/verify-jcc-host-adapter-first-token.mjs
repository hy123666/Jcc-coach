import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeAllHostAgentSessions, runHostAgentRequest } from "../ui/electron/host-adapters.js";
import { createHostTurnTrace, updateHostTurnTrace } from "../ui/electron/host-turn-trace.js";

// Exercise the production callback without bootstrapping an unrelated Runtime session.
const serviceSource = await readFile(new URL("../ui/electron/runtime-service.js", import.meta.url), "utf8");
const dispatchStart = serviceSource.indexOf("const dispatchTraced = async");
const callbackStart = serviceSource.indexOf("onProviderTurnStarted: ", dispatchStart);
const callbackEnd = serviceSource.indexOf(",\n        onProviderFirstToken:", callbackStart);
assert(dispatchStart >= 0 && callbackStart > dispatchStart && callbackEnd > callbackStart);
const startedCallbackSource = serviceSource.slice(callbackStart + "onProviderTurnStarted: ".length, callbackEnd);
const createRuntimeStartedObserver = new Function("updateHostTurnTrace", "recordRuntimeEvent", "options", "initialTrace", `
  let trace = initialTrace;
  const callback = ${startedCallbackSource};
  return { callback, getTrace: () => trace };
`);
const forwardedStarts = [];
const acceptanceEvents = [];
const acceptanceProbe = createRuntimeStartedObserver(updateHostTurnTrace,
  (_type, trace) => acceptanceEvents.push(trace), {
    onProviderTurnStarted: (info) => forwardedStarts.push(info),
  }, createHostTurnTrace({ taskId: "acceptance-probe" }));
for (const accepted_at of [null, undefined, "invalid-date"]) {
  acceptanceProbe.callback({ provider: "kimi", accepted_at });
  assert.equal(acceptanceProbe.getTrace().provider_accepted_at, null);
}
assert.equal(acceptanceEvents.length, 0);
const acceptedAt = "2026-09-06T10:00:00.123Z";
acceptanceProbe.callback({ provider: "codex", accepted_at: acceptedAt, provider_session_id: "probe-session" });
assert.equal(acceptanceProbe.getTrace().provider_accepted_at, acceptedAt, "use provider receipt time, not callback execution time");
assert.equal(acceptanceProbe.getTrace().host_session_id, "probe-session");
assert.equal(acceptanceEvents.length, 1);
assert.equal(forwardedStarts.length, 4, "missing acceptance must not suppress Runtime's started lifecycle callback");

const root = await mkdtemp(path.join(os.tmpdir(), "jcc-first-token-"));
const previous = [process.env.JCC_SOURCE_CODEX_HOME, process.env.JCC_CODEX_RUNTIME_HOME];
try {
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "auth.json"), '{"OPENAI_API_KEY":"stub"}');
  process.env.JCC_SOURCE_CODEX_HOME = source;
  process.env.JCC_CODEX_RUNTIME_HOME = path.join(root, "runtime");
  const script = path.join(root, "provider.mjs");
  await writeFile(script, `
import readline from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let count = 0;
readline.createInterface({ input: process.stdin }).on("line", (m) => {
  const { id, method, params } = JSON.parse(m);
  const reply = (result) => send({ id, result });
  if (method === "initialize") return reply({ agentCapabilities: {} });
  if (method === "thread/start") return reply({ thread: { id: "thread" } });
  if (method === "session/new") return reply({ sessionId: "session", configOptions: [] });
  if (method === "turn/start") {
    const turnId = "turn-" + ++count;
    if (params.input[0].text === "start-failed") {
      send({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId, delta: "unaccepted" } });
      setTimeout(() => send({ id, error: { code: -32000, message: "start rejected" } }), 70);
      return;
    }
    setTimeout(() => reply({ turn: { id: turnId } }), 70);
    setTimeout(() => {
      const emit = (method, extra = {}) => send({ method, params: { threadId: "thread", turnId, ...extra } });
      emit("item/reasoning/textDelta", { delta: "thinking" });
      emit("item/commandExecution/outputDelta", { delta: "tool" });
      emit("item/agentMessage/delta", { delta: "" });
      emit("item/agentMessage/delta", { threadId: "foreign", delta: "wrong thread" });
      emit("item/agentMessage/delta", { turnId: "foreign", delta: "wrong turn" });
      emit("item/completed", { turnId: "foreign", item: { type: "agentMessage", text: "foreign final" } });
      emit("turn/completed", { turnId: "foreign", turn: { id: "foreign", status: "failed", error: "foreign failure" } });
      if (params.input[0].text !== "completed-only") {
        emit("item/agentMessage/delta", { delta: "hel" });
        emit("item/agentMessage/delta", { delta: "lo" });
      }
      emit("item/completed", { item: { type: "agentMessage", text: "hello" } });
      emit("turn/completed", { turn: { id: turnId, status: "completed" } });
    }, 15);
    return;
  }
  if (method === "session/prompt") {
    count++;
    const emit = (sessionUpdate, content, sessionId = "session") => send({ method: "session/update", params: { sessionId, update: { sessionUpdate, content } } });
    emit("agent_thought_chunk", { type: "text", text: "thinking" });
    emit("tool_call", { type: "text", text: "tool" });
    emit("agent_message_chunk", { type: "image", text: "not text" });
    emit("agent_message_chunk", { type: "text", text: "" });
    emit("agent_message_chunk", { type: "text", text: "foreign" }, "foreign");
    if (params.prompt[0].text !== "completed-only") {
      emit("agent_message_chunk", { type: "text", text: "hel" });
      emit("agent_message_chunk", { type: "text", text: "lo" });
    }
    return reply({ final_text: "hello", stopReason: "end_turn" });
  }
  if (id != null) reply({});
});
`);
  const launcher = path.join(root, process.platform === "win32" ? "kimi.cmd" : "kimi");
  await writeFile(launcher, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${script}"\r\n`
    : `#!/bin/sh\n"${process.execPath}" "${script}"\n`);
  if (process.platform !== "win32") await chmod(launcher, 0o755);
  for (const provider of ["codex", "kimi"]) {
    const adapter = provider === "codex"
      ? { provider, available: true, spawn_command: process.execPath, spawn_prefix_args: [script] }
      : { provider, available: true, command: launcher, kimi_home: path.join(root, "kimi-home") };
    const calls = [];
    const dispatched = [];
    const accepted = [];
    const runtimeObserver = createRuntimeStartedObserver(updateHostTurnTrace, () => {}, {
      onProviderTurnStarted: (meta) => { accepted.push(meta); },
    }, createHostTurnTrace({ taskId: `acceptance-${provider}` }));
    const options = {
      repoRoot: path.resolve(import.meta.dirname, ".."), hostCwd: root,
      hostSessionKey: `first-token-${provider}`, timeoutMs: 5000,
      onProviderFirstToken: (meta) => { calls.push(meta); },
      onProviderTurnDispatched: (meta) => { dispatched.push(meta); },
      onProviderTurnStarted: runtimeObserver.callback,
    };
    for (let i = 0; i < 2; i++) {
      const before = Date.now();
      const result = await runHostAgentRequest(adapter, "stream", options);
      assert.equal(result.ok, true, result.error);
      assert.equal(calls.length, i + 1, "exactly once per owning turn, including reused session");
      const meta = calls[i];
      assert.equal(meta.provider, provider);
      assert.equal(meta.provider_session_id, provider === "codex" ? "thread" : "session");
      assert.equal(meta.turn_id, provider === "codex" ? `turn-${i + 1}` : null);
      assert(meta.at >= before && meta.at <= Date.now());
      assert.equal(meta.date, new Date(meta.at).toISOString());
      if (provider === "codex") assert.equal(result.response, "hello");
      assert.equal(dispatched.length, i + 1);
      assert.equal(dispatched[i].turn_id, null, "dispatch cannot know future native turn identity");
      assert.equal(dispatched[i].date, new Date(dispatched[i].at).toISOString());
      assert(dispatched[i].at <= meta.at);
      if (provider === "codex") {
        assert(meta.at < Date.parse(accepted[i].accepted_at), "buffer replay must preserve pre-acceptance receipt timestamp");
        assert.equal(accepted[i].accepted_at, accepted[i].started_at);
        assert(!result.events.some((event) => event.params?.turnId === "foreign"));
      } else {
        assert.equal(accepted[i].accepted_at, null, "ACP has no separate acceptance ack");
        assert.equal(runtimeObserver.getTrace().provider_accepted_at, null,
          "Runtime must not synthesize acceptance from Kimi's pre-dispatch started callback");
      }
    }
    const completed = await runHostAgentRequest(adapter, "completed-only", options);
    assert.equal(completed.ok, true, completed.error);
    assert.equal(calls.length, 2, "no fabricated first token for completed-only response");
    for (const callback of [() => { throw new Error("observer"); }, async () => { throw new Error("observer"); }]) {
      const result = await runHostAgentRequest(adapter, "stream", { ...options, onProviderFirstToken: callback, onProviderTurnDispatched: callback });
      assert.equal(result.ok, true, "observer failure cannot fail provider response");
    }
    if (provider === "codex") {
      const firstCount = calls.length;
      const acceptedCount = accepted.length;
      const dispatchedCount = dispatched.length;
      const failed = await runHostAgentRequest(adapter, "start-failed", options);
      assert.equal(failed.ok, false);
      assert.match(failed.error, /start rejected/);
      assert.equal(calls.length, firstCount, "unaccepted buffered tokens must not leak on start failure");
      assert.equal(accepted.length, acceptedCount);
      assert.equal(dispatched.length, dispatchedCount + 1);
    }
  }
  console.log(JSON.stringify({ ok: true, checked: ["codex_and_kimi_real_text_only", "once_per_turn", "no_native_id_is_null", "foreign_routes_ignored", "completed_only_no_callback", "observer_failure_isolated", "early_foreign_events_quarantined_until_start_ack", "early_token_receipt_time_preserved", "dispatch_and_acceptance_are_separate", "failed_start_discards_early_tokens"] }));
} finally {
  await closeAllHostAgentSessions();
  for (const [index, key] of ["JCC_SOURCE_CODEX_HOME", "JCC_CODEX_RUNTIME_HOME"].entries()) {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
