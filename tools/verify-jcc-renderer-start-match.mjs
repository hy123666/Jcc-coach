import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "../ui/node_modules/typescript/lib/typescript.js";

const source = await readFile("ui/src/App.tsx", "utf8");
const body = source.match(/const handleStart = async \(\) => \{([\s\S]*?)\n  \};/);
assert(body, "App must expose handleStart");
const compiled = ts.transpileModule(`async function handleStart() {${body[1]}\n}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness({ result, error, drainError, pending } = {}) {
  const messages = { daily: [], match: [] };
  const reconciles = [];
  let calls = 0;
  const ref = (current = null) => ({ current });
  const context = {
    startMatchInFlightRef: ref(false),
    runtimeReconcileDrainRef: ref({ async whenIdle() { if (drainError) throw drainError; } }),
    liveMatchNoticeRef: ref(), visualStatusNoticeRef: ref(), manualModeLockRef: ref(),
    deliveredCoachResponseKeysRef: ref(new Map()), responseGenerationRef: ref(0),
    activeModeRef: ref("cruise"), confirmedVariablesSessionRef: ref(),
    lineupExpectedTaskIdRef: ref(), lineupRequestInFlightRef: ref(false),
    clearVisualFollowup() {},
    runtime: { async startMatch() { calls += 1; if (error) throw error; return pending || result; } },
    syncState() {},
    addMessage(message) { messages.daily.push(message); },
    appendMessageToStream(stream, message) { messages[stream].push(message); },
    setMatchMessages(value) { messages.match = value; },
    initialMatchMessages: [], messageId: () => "test-message",
    userVisibleRuntimeErrorText: (message, fallback) => message || fallback,
    setActiveMode() {}, setConfirmedManualVariables() {}, setLineupPlan() {},
    setLineupStatus() {}, setPinnedPanelOpen() {}, setActiveView() {},
    requestRuntimeReconcile(request) { reconciles.push(request); },
  };
  const start = Function(...Object.keys(context), `${compiled}\nreturn handleStart;`)(...Object.values(context));
  return { start, messages, reconciles, context, calls: () => calls };
}

const degraded = {
  ok: false, match_created: true, ready: false, host_ready: true, watcher_ready: false,
  status: "watcher_failed", error: "watcher startup failed",
  state: { match_session: { status: "active", ui_ready: false, match_session_id: "match-1" } },
};
const lobby = harness({ result: degraded });
await lobby.start();
assert.match(lobby.messages.daily.at(-1).text, /实时监听未启动/, "lobby must receive the terminal watcher failure");
assert.equal(lobby.messages.daily.at(-1).text, lobby.messages.match.at(-1).text);
assert.equal(lobby.reconciles.length, 1, "a committed match must still reconcile canonical delivery");
assert.equal(lobby.context.startMatchInFlightRef.current, false);

for (const result of [
  { ...degraded, state: { match_session: { ...degraded.state.match_session, ui_ready: true } } },
  { ...degraded, ok: true, ready: true, watcher_ready: true,
    state: { match_session: { status: "active", match_session_id: "match-1" } } },
]) {
  const match = harness({ result });
  await match.start();
  assert.equal(match.messages.daily.length, 1, "visible match result must not be duplicated into the lobby");
  assert.match(match.messages.match.at(-1).text, result.ready ? /正在等待游戏状态/ : /实时监听未启动/);
  assert.equal(match.reconciles.length, 1);
}

const rejected = harness({ result: { ok: false, match_created: false, error: "start rejected" } });
await rejected.start();
assert.equal(rejected.messages.daily.at(-1).text, "start rejected");
assert.equal(rejected.reconciles.length, 0);

for (const failure of [{ error: new Error("IPC disconnected") }, { drainError: new Error("drain failed") }]) {
  const failed = harness(failure);
  await failed.start();
  assert.match(failed.messages.daily.at(-1).text, /IPC disconnected|drain failed/);
  assert.equal(failed.context.startMatchInFlightRef.current, false, "failure must release the start fence");
  assert.equal(failed.reconciles.length, 0);
  if (failure.drainError) assert.equal(failed.calls(), 0);
}

let resolveStart;
const concurrent = harness({ pending: new Promise((resolve) => { resolveStart = resolve; }) });
const first = concurrent.start();
await concurrent.start();
assert.equal(concurrent.calls(), 1, "repeated clicks must not create concurrent matches");
resolveStart(degraded);
await first;
assert.equal(concurrent.context.startMatchInFlightRef.current, false);
console.log("PASS: renderer Start Match lobby/match routing, degraded/ready/rejected results, IPC/drain exceptions, and duplicate clicks");

const service = await readFile("ui/electron/runtime-service.js", "utf8");
for (const name of ["observeRuntimeTick", "pollCruiseAdvice", "automaticRuntimeAdviceBlock"]) {
  const block = service.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{([\\s\\S]*?)\\n\\}`));
  assert(block, name);
  const invoke = Function("state", `return ${name === "automaticRuntimeAdviceBlock" ? "" : "async "}function() {${block[1]}};`)({match_session:{status:"active",ui_ready:false}});
  const result = await invoke();
  assert.equal(result.status || result.reason, "match_not_ready", `${name} must reject unready Match before any watcher or Host work`);
}
assert.match(source, /observe: request\.observe[^,]+ui_ready !== false/);
assert.match(source, /reason: "30-second canonical reconciliation watchdog",\s*observe:[^,]+ui_ready !== false/);
console.log("PASS: unready Match cannot trigger automatic advice through renderer or service entrypoints");
