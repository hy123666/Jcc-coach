import { readFile } from "node:fs/promises";
import ts from "../ui/node_modules/typescript/lib/typescript.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function extractSetBody(source, name) {
  const marker = `const ${name} = new Set([`;
  const start = source.indexOf(marker);
  assert(start >= 0, `missing ${name}`);
  const end = source.indexOf("]);", start);
  assert(end > start, `missing ${name} end`);
  return source.slice(start, end);
}

function setHas(body, value) {
  return body.includes(`"${value}"`) || body.includes(`'${value}'`);
}

async function main() {
  const daemon = await readFile("ui/electron/runtime-daemon.js", "utf8");
  const service = await readFile("ui/electron/runtime-service.js", "utf8");
  const renderer = await readFile("ui/src/App.tsx", "utf8");
  const modeTransitionFenceSource = await readFile("ui/src/modeTransitionFence.ts", "utf8");
  const adapters = await readFile("ui/electron/host-adapters.js", "utf8");
  const preemptiveSignals = extractSetBody(daemon, "daemonPreemptiveControlSignals");
  const fastControlActions = extractSetBody(daemon, "daemonFastControlActions");
  const queuedActions = extractSetBody(daemon, "daemonQueuedActions");

  for (const action of ["startMatch", "stopMatch", "shutdown", "stopResponse", "sendMessage"]) {
    assert(
      setHas(preemptiveSignals, action),
      `${action} must signal host-process cancellation before its serialized state transition`,
    );
  }

  for (const action of ["setMode", "pollCruiseAdvice", "updateRankings", "saveManualVariables"]) {
    assert(
      !setHas(preemptiveSignals, action),
      `${action} must not emit a control-plane host cancellation signal`,
    );
  }
  const setModeStart = service.indexOf("async function setMode(payload)");
  const setModeEnd = service.indexOf("\nasync function saveManualVariables", setModeStart);
  assert(setModeStart >= 0 && setModeEnd > setModeStart, "runtime service must expose a bounded setMode implementation");
  const setModeBody = service.slice(setModeStart, setModeEnd);
  assert(!setModeBody.includes("getOrBuildContextPack"), "setMode must not build Host context on the UI control lane");
  assert(!setModeBody.includes("ensureModeVisualObservation"), "setMode must not run visual sensing before returning the control-plane transition");
  assert(!setModeBody.includes("supersedeChoiceResponseTaskForMode"), "mode switching must not cancel the answer owner that is already running");
  assert(!setModeBody.includes("supersedeVisualRequestForMode"), "mode switching must not perform unrelated visual-task supersession on the control lane");
  assert(renderer.includes("modeTransitionFenceRef.current.isCurrent(generation)"), "renderer mode changes must apply every completion through the shared last-click-wins fence");
  assert(!renderer.includes("if (modeTransitionPending) return;\n    setModeTransitionPending(true);"), "a pending earlier mode request must not silently discard the user's later click");
  const transpiledFence = ts.transpileModule(modeTransitionFenceSource, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const fenceModule = await import(`data:text/javascript;base64,${Buffer.from(transpiledFence).toString("base64")}`);
  const fence = fenceModule.createModeTransitionFence();
  const appliedModes = [];
  let resolveFirst;
  let resolveSecond;
  const firstResult = new Promise((resolve) => { resolveFirst = resolve; });
  const secondResult = new Promise((resolve) => { resolveSecond = resolve; });
  const settleMode = async (mode, token, result) => {
    await result;
    if (fence.isCurrent(token)) appliedModes.push(mode);
  };
  const firstToken = fence.begin();
  const firstSettlement = settleMode("augment", firstToken, firstResult);
  const secondToken = fence.begin();
  const secondSettlement = settleMode("cruise", secondToken, secondResult);
  resolveSecond();
  await secondSettlement;
  resolveFirst();
  await firstSettlement;
  assert(appliedModes.length === 1 && appliedModes[0] === "cruise", "out-of-order mode completions must apply only the latest user click");

  assert(
    setHas(queuedActions, "sendMessage"),
    "sendMessage must preempt old host work immediately but keep canonical state mutation on the serialized action queue",
  );
  assert(
    daemon.includes("if (daemonPreemptiveControlSignals.has(action) && !statusPingOnly)")
      && daemon.includes("cancelHostAgentRunDetailed(requestedTaskId)")
      && daemon.includes("bootstrapRouteKeys.map((routeKey) => preemptHostAgentSessionStart(routeKey,")
      && !daemon.includes("return this.handleActionLocked(action, payload, window);"),
    "preemptive actions must signal host cancellation immediately while serializing the canonical state transition",
  );
  assert(
    daemon.includes('(action === "startMatch" || action === "stopMatch")')
      && daemon.includes("match_bootstrap_preemption: matchBootstrapPreemption"),
    "Start Match replacement and Stop Match must preempt a provider session that is still bootstrapping before waiting on actionChain",
  );
  assert(
    /const baseArgs = \[\s*"app-server",\s*"--stdio",[\s\S]*?"--disable", "hooks",[\s\S]*?"--disable", "plugins",[\s\S]*?"--disable", "shell_tool",[\s\S]*?"--disable", "unified_exec"/.test(adapters),
    "the isolated Codex app-server must not load hooks or synchronize plugins during JCC Host bootstrap",
  );
  assert(
    adapters.includes("persistentHostSessionStartBlocks.add(normalizedKey)")
      && adapters.includes("persistentHostSessionStartBlocks.has(routeKey)")
      && adapters.includes("persistentHostSessionStartBlocks.delete(normalizedKey)"),
    "Stop Match must block a match route even when it arrives before the provider bootstrap transport exists",
  );
  assert(
    daemon.includes("Boolean(requestedTaskId)")
      && daemon.includes("Number.isInteger(requestedRevision)")
      && daemon.includes("requestedRevision === Number(canonicalTask?.revision)"),
    "preemptive stopResponse cancellation must require an exact task id and revision instead of cancelling every host process",
  );
  assert(
    setHas(fastControlActions, "stopResponse")
      && !setHas(fastControlActions, "startMatch")
      && !setHas(fastControlActions, "stopMatch")
      && !setHas(fastControlActions, "setMode")
      && daemon.includes("if (daemonFastControlActions.has(action)) return run();")
      && daemon.includes("this.actionChain.catch(() => {}).then(run)"),
    "only exact stopResponse may bypass the serialized reducer; all other runtime actions remain on actionChain",
  );

  const sendMessageBody = service.slice(
    service.indexOf("async function sendMessage(payload)"),
    service.indexOf("async function pollCruiseAdvice()"),
  );
  assert(sendMessageBody.includes("runDirectHostModelForUserMessageInBackground({"), "sendMessage direct host path must launch host model work in the background");
  assert(
    !sendMessageBody.includes("const codexResult = await runHostModel(hostRequest, taskId)"),
    "sendMessage direct host path must not await runHostModel while the daemon actionChain is held",
  );
  assert(
    sendMessageBody.includes('status: "awaiting_host_cli_agent_response"')
      && sendMessageBody.includes("return {")
      && sendMessageBody.includes('status: "awaiting_host_cli_agent_response"'),
    "sendMessage must persist an awaiting response_task and return immediately for UI delivery polling",
  );

  const visualAdviceBody = service.slice(
    service.indexOf("async function continuePendingVisualToAdvice"),
    service.indexOf("async function sendMessage(payload)"),
  );
  assert(
    visualAdviceBody.includes("runDirectHostModelForUserMessageInBackground({"),
    "visual-to-advice continuation must launch host model work in the background",
  );
  assert(
    !visualAdviceBody.includes("const codexResult = await runHostModel(hostRequest, taskId)"),
    "visual-to-advice continuation must not await runHostModel while the daemon actionChain is held",
  );
  assert(
    service.includes("`${parentResponseTaskId}:visual:${visualRunId}`"),
    "slow visual host work must be namespaced under the parent response task so Stop cancels the whole request tree",
  );

  const taskOwnershipBody = service.slice(
    service.indexOf("function responseTaskMatchesSession"),
    service.indexOf("function activeRuntimeEventResponseTask"),
  );
  assert(
    taskOwnershipBody.includes("currentMatchSessionId === matchSessionId")
      && taskOwnershipBody.includes("taskMatchSessionId === matchSessionId")
      && taskOwnershipBody.includes("responseTaskMatchesSession(matchSessionId)"),
    "late host results must require both the current runtime session and response task session to match the launch session",
  );

  const directBackgroundBody = service.slice(
    service.indexOf("function runDirectHostModelForUserMessageInBackground"),
    service.indexOf("function summarizeFastChoiceTextResult"),
  );
  assert(
    directBackgroundBody.includes("const matchSessionId = state.response_task?.match_session_id")
      && directBackgroundBody.includes("direct_host_model_background_merge_result_not_current")
      && directBackgroundBody.includes("const owner = captureResponseTaskOwner(taskId, requestedMode, matchSessionId)")
      && directBackgroundBody.includes("responseTaskStillOwnedAtRevision(owner)"),
    "direct background host work must capture launch-session revision ownership and recheck it after awaited response merging",
  );

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "startMatch/stopMatch/stopResponse and direct send signal immediate host cancellation",
      "setMode preserves the active Host answer while serializing the UI state transition",
      "startMatch replacement and stopMatch preempt pending provider-session bootstrap before serialized cleanup",
      "isolated Codex app-server bootstrap disables hooks and plugins",
      "early stopMatch blocks late provider bootstrap until serialized route cleanup finishes",
      "only exact stopResponse bypasses actionChain; all other state transitions remain serialized",
      "new direct user messages preempt old host work before entering the serialized reducer",
      "ordinary background actions cannot emit control-plane cancellation signals",
      "sendMessage direct host path launches host work in background",
      "visual-to-advice host path launches host work in background",
      "visual host work is cancellable through its parent response task",
      "late host results require task and match-session identity",
      "direct host result ownership is rechecked after response merge",
      "stopResponse without exact task identity cannot cancel all host processes",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
