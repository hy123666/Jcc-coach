import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { closeHostAgentSession, runHostAgentRequest, codexStreamFailureDiagnostic } from "../ui/electron/host-adapters.js";

const snapshotWarning = "WARN codex_core::shell_snapshot: Failed to create shell snapshot for powershell: Shell snapshot not supported yet for PowerShell";
assert.match(codexStreamFailureDiagnostic({ code: 1, stderr: snapshotWarning,
  stdout: JSON.stringify({ type: "turn.failed", error: { code: 429, message: "quota exhausted" } }),
}), /429: quota exhausted/);
assert.equal(codexStreamFailureDiagnostic({ code: 1, stderr: snapshotWarning }), "Host CLI exited 1");
assert.equal(codexStreamFailureDiagnostic({ code: 1, stdout: JSON.stringify({ type: "item.completed", item: {type: "agent_message", text: "private answer"} }), stderr: "connection reset" }), "connection reset");
import { hostCoachResponseRunningInfo } from "../ui/electron/runtime-service.js";

const now = Date.now();
const queuedAt = new Date(now - 250_000).toISOString();
const providerStartedAt = new Date(now - 301_000).toISOString();

const queued = hostCoachResponseRunningInfo({
  status: "running",
  response_task_id: "queued-before-provider",
  mode: "augment_choice",
  structured_card_action: true,
  awaiting_since: queuedAt,
}, now);
assert.equal(queued.provider_started, false);
assert.equal(queued.stale, false, "provider queue time must not consume the native answer budget");

const running = hostCoachResponseRunningInfo({
  status: "running",
  response_task_id: "running-at-provider",
  mode: "augment_choice",
  structured_card_action: true,
  awaiting_since: queuedAt,
  provider_awaiting_since: providerStartedAt,
}, now);
assert.equal(running.provider_started, true);
assert.equal(running.stale, true, "native answer time must be measured from provider dispatch");

const [adapters, service] = await Promise.all([
  readFile(new URL("../ui/electron/host-adapters.js", import.meta.url), "utf8"),
  readFile(new URL("../ui/electron/runtime-service.js", import.meta.url), "utf8"),
]);
assert.match(adapters, /active\.turnId = startOutcome\.started\?\.turn\?\.id[\s\S]{0,500}onProviderTurnStarted/);
assert.match(adapters, /const promptPreparation = buildKimiPromptContentBlocks[\s\S]{0,1800}onProviderTurnStarted[\s\S]{0,700}session\/prompt/);
assert.match(adapters, /providerStartTimeout[\s\S]{0,1800}const answerTimeout = new Promise/);
assert.match(adapters, /JCC_UI_HOST_AGENT_TIMEOUT_MS \|\| 300000/,
  "standalone Host answer adapters must use the five-minute final protection ceiling");
assert.doesNotMatch(adapters, /JCC_UI_HOST_PROVIDER_START_TIMEOUT_MS\s*\n?\s*\|\| 180000/,
  "provider admission must not retain the old three-minute protection ceiling");
assert.match(service, /JCC_UI_HOST_SESSION_WARMUP_TIMEOUT_MS \|\| 300000/,
  "Host session warmup must use the five-minute final protection ceiling");
assert.match(service, /if \(!accepted\) \{\s*await closeHostAgentSession\(route\.key\)/,
  "a failed bootstrap must close the dirty Provider session before another bootstrap can start");
assert.match(service, /JCC_HOST_PROVIDER_START_TIMEOUT_MS \|\| 300000/,
  "Runtime provider admission must use the same five-minute protection ceiling");
assert.match(service, /onProviderTurnStarted: \(providerInfo\) => markHostProviderTurnStarted/);
assert.match(service, /provider_awaiting_since: startedAt/);

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-provider-timeout-boundary-"));
const routeKey = `match:provider-timeout-${Date.now()}`;
try {
  const script = path.join(tempRoot, "fake-delayed-codex.mjs");
  await writeFile(script, `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
rl.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
  if (message.method === "thread/start") return send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "provider-timeout-thread" } } });
  if (message.method === "turn/start") {
    await wait(180);
    const turnId = "provider-timeout-turn";
    send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: turnId } } });
    await wait(180);
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "provider-timeout-thread", turnId, item: { type: "reasoning" } } });
    await wait(180);
    send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "provider-timeout-thread", turnId, item: { type: "agentMessage", text: "provider-boundary-ok" } } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "provider-timeout-thread", turnId, turn: { id: turnId, status: "completed" } } });
    return;
  }
  if (message.method === "turn/interrupt") return send({ jsonrpc: "2.0", id: message.id, result: { accepted: true } });
  if (message.method === "thread/delete") {
    send({ jsonrpc: "2.0", id: message.id, result: { deleted: true } });
    setTimeout(() => process.exit(0), 5);
    return;
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`, "utf8");
  const adapterState = {
    provider: "codex",
    available: true,
    spawn_command: process.execPath,
    spawn_prefix_args: [script],
  };
  const warmup = await runHostAgentRequest(adapterState, "provider timeout boundary warmup", {
    parseJson: false,
    repoRoot: process.cwd(),
    hostCwd: tempRoot,
    hostSessionKey: routeKey,
    taskId: "provider-timeout-boundary-warmup",
    providerStartTimeoutMs: 5_000,
    timeoutMs: 5_000,
  });
  assert.equal(warmup.ok, true, `persistent provider warmup failed: ${warmup.error || "unknown error"}`);

  let providerStarted = false;
  const delayed = await runHostAgentRequest(adapterState, "provider timeout boundary", {
    parseJson: false,
    repoRoot: process.cwd(),
    hostCwd: tempRoot,
    hostSessionKey: routeKey,
    taskId: "provider-timeout-boundary",
    providerStartTimeoutMs: 300,
    timeoutMs: 300,
    onProviderTurnStarted: () => { providerStarted = true; },
  });
  assert.equal(delayed.ok, true, delayed.error);
  assert.equal(providerStarted, true, "provider start callback must run after native turn admission");
  assert.equal(delayed.text, "provider-boundary-ok");
} finally {
  await closeHostAgentSession(routeKey).catch(() => {});
  await rm(tempRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-host-provider-timeout-boundary-verifier-v1",
  checked: [
    "provider dispatch clock starts after native turn admission",
    "queue startup and provider response budgets remain separate",
    "provider activity renews the answer lease beyond the absolute timeout window",
    "failed bootstrap closes its dirty Provider session before retry",
  ],
})}\n`);
