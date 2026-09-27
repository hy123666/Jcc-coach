import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  closeHostAgentSession,
  detectHostAgent,
  runHostAgentRequest,
} from "../ui/electron/host-adapters.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

async function main() {
  const provider = String(argValue("--provider", "codex")).trim().toLowerCase();
  const model = argValue("--model", null);
  const reasoningEffort = argValue("--reasoning-effort", null);
  const timeoutMs = Number(argValue("--timeout-ms", "180000"));
  const marker = `jcc-live-session-${randomUUID()}`;
  const routeKey = `live-smoke:${provider}:${Date.now()}`;
  const detected = await detectHostAgent({
    provider,
    repoRoot: process.cwd(),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  });
  assert.equal(detected.available, true, detected.error || `${provider} CLI is unavailable`);
  const options = {
    parseJson: true,
    jsonResponseKind: "raw",
    repoRoot: process.cwd(),
    hostSessionKey: routeKey,
    timeoutMs,
  };
  try {
    const firstStartedAt = Date.now();
    const first = await runHostAgentRequest(detected, [
      "This is turn 1 of a JCC Runtime persistent-session smoke test.",
      `Keep this marker in the current live provider session: ${marker}`,
      "Return exactly one JSON object with schema=jcc-host-session-live-smoke-v1, turn=1, and accepted=true.",
    ].join("\n"), { ...options, taskId: `${routeKey}:turn-1` });
    const firstElapsedMs = Date.now() - firstStartedAt;
    assert.equal(first.ok, true, first.error);
    assert.equal(first.response?.schema, "jcc-host-session-live-smoke-v1");
    assert.equal(first.response?.turn, 1);
    assert.equal(first.response?.accepted, true);

    const secondStartedAt = Date.now();
    const second = await runHostAgentRequest(detected, [
      "This is turn 2 in the same already-live provider session.",
      "Return exactly one JSON object with schema=jcc-host-session-live-smoke-v1, turn=2, and marker set to the marker retained from turn 1.",
      "Do not invent or transform the marker.",
    ].join("\n"), { ...options, taskId: `${routeKey}:turn-2` });
    const secondElapsedMs = Date.now() - secondStartedAt;
    assert.equal(second.ok, true, second.error);
    assert.equal(second.response?.schema, "jcc-host-session-live-smoke-v1");
    assert.equal(second.response?.turn, 2);
    assert.equal(second.response?.marker, marker, "turn 2 must retain turn 1 context without resending it");
    assert.equal(second.thread_id || second.session_id, first.thread_id || first.session_id, "both turns must use one provider session id");
    assert.equal(second.transport_pid, first.transport_pid, "both turns must use one live CLI process");
    assert(first.transport_pid, "persistent transport PID must be observable");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: "jcc-host-session-live-smoke-v1",
      provider,
      model: detected.selected_model || detected.default_model || null,
      reasoning_effort: detected.reasoning_effort || null,
      provider_session_id: first.thread_id || first.session_id,
      transport_pid: first.transport_pid,
      turn_elapsed_ms: [firstElapsedMs, secondElapsedMs],
      completed_from: [first.completed_from, second.completed_from],
      checked: [
        "two real turns share one provider session id",
        "two real turns share one live OS process",
        "turn 2 retains turn 1 context without resending the marker",
      ],
    }, null, 2)}\n`);
  } finally {
    await closeHostAgentSession(routeKey).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
