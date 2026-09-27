import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runHostAgentRequest, closeHostAgentSession, cancelHostAgentRun, hostAgentSessionReadonlyToolMode } from "../ui/electron/host-adapters.js";

// Opt-in: an ordinary run performs one small paid inference. --handshake-only
// cancels in the pre-dispatch callback, after the real ACP/MCP initialization.
const command = process.env.KIMI_BIN || "kimi";
const key = `kimi-mcp-live-${Date.now()}`;
const taskId = `${key}-turn`;
const handshakeOnly = process.argv.includes("--handshake-only");
const offline = process.argv.includes("--offline-handshake");
const sourceHome = offline ? await mkdtemp(path.join(os.tmpdir(), "jcc-kimi-offline-auth-")) : process.env.JCC_SOURCE_KIMI_HOME;
if (offline) await writeFile(path.join(sourceHome, "config.toml"), 'default_model = "probe"\n[providers.probe]\ntype = "openai"\nbase_url = "http://127.0.0.1:1/v1"\napi_key = "local-handshake-only"\n[models.probe]\nprovider = "probe"\nmodel = "probe"\nmax_context_size = 32768\ncapabilities = ["tool_use"]\n');
const expected = randomBytes(12).toString("hex");
const calls = [];
let mode, binding;
try {
  const result = await runHostAgentRequest({ provider: "kimi", available: true, command,
    kimi_home: sourceHome, selected_model: process.env.JCC_KIMI_TEST_MODEL || null,
  }, "Call jcc.calculate exactly once using operation=probe, with the current Runtime binding. Return only the probe_nonce from the tool result. Do not use other tools.", {
    repoRoot: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    hostSessionKey: key, taskId, timeoutMs: 120000,
    onProviderTurnStarted(info) {
      binding = info;
      mode = hostAgentSessionReadonlyToolMode(key);
      if (handshakeOnly || offline) cancelHostAgentRun(taskId);
    },
    onReadonlyToolCall: async (name, args) => {
      calls.push({ name, args });
      return { ok: true, probe_nonce: expected };
    },
  });
  console.log(JSON.stringify({ handshakeOnly, ok: result.ok, mode, binding_present: Boolean(binding?.turn_id),
    receipt: result.capability_receipt, calls, text: result.text, error: result.error,
    stderr: result.ok ? undefined : result.stderr?.slice(-4000) }, null, 2));
  assert.equal(mode, "native_dynamic_tools", result.error);
  if (handshakeOnly || offline) assert.equal(calls.length, 0);
  else {
    assert.equal(result.ok, true, result.error);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "jcc.calculate");
    assert(result.text.includes(expected), "real model must report the nonce only available in the MCP result");
  }
} finally {
  await closeHostAgentSession(key);
  if (offline) await rm(sourceHome, { recursive: true, force: true });
}
