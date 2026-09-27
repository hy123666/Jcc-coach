import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHostAgentRequest, closeHostAgentSession, cancelHostAgentRun, hostAgentSessionReadonlyToolMode, sanitizeKimiConfigForRuntime } from "../ui/electron/host-adapters.js";
import { connectBridge } from "./verify-jcc-kimi-mcp-bridge.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
if (process.argv.includes("--fake-child")) {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin });
  let mcp, token, promptId;
  const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  rl.on("line", async (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") return send(message.id, { agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { resume: true } } });
    if (["session/new", "session/resume", "session/load"].includes(message.method)) {
      const failMarker = path.join(process.env.KIMI_CODE_HOME, "fail-next-resume");
      if (message.method !== "session/new" && await access(failMarker).then(() => true, () => false)) {
        await rm(failMarker);
        return process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "transient resume failure" } })}\n`);
      }
      const history = path.join(process.env.KIMI_CODE_HOME, "native-history-test");
      if (message.method === "session/new") await writeFile(history, "retained");
      else assert.equal(await readFile(history, "utf8"), "retained", "crash recovery must preserve native history");
      assert.equal(message.params.mcpServers.length, 1);
      mcp = await connectBridge(message.params.mcpServers[0]);
      if (!process.argv.includes("--no-handshake")) setTimeout(() => void mcp.initialize(), 30);
      send(message.id, { sessionId: "fake-kimi-native" });
      const marker = process.argv.indexOf("--marker");
      if (marker >= 0) await writeFile(process.argv[marker + 1], process.env.KIMI_CODE_HOME);
      if (process.argv.includes("--exit-before-handshake")) setTimeout(() => process.exit(1), 40);
      return;
    }
    if (message.method === "session/cancel") {
      if (promptId) { send(promptId, {}); promptId = null; }
      return;
    }
    if (message.method !== "session/prompt") return;
    promptId = message.id;
    const text = message.params.prompt.map((b) => b.text || "").join("\n");
    if (text.includes("CRASH_NOW")) return process.exit(1);
    const oldToken = token;
    token = text.match(/_jcc_turn=([a-f0-9]{64})/)?.[1];
    const call = (name, t = token, args = {}) => mcp.request("tools/call", { name, arguments: { ...args, _jcc_turn: t } });
    let answer = { schema: "jcc-host-cli-coach-response-v1", generated_by: "current_cli_agent_main_model", final_text: "test", token: Boolean(token), home: process.env.KIMI_CODE_HOME, cwd: process.cwd(), args: process.argv, timeout: process.env.KIMI_MCP_TOOL_TIMEOUT_MS };
    if (token) {
      if (oldToken) answer.stale = (await call("calculate", oldToken)).value.result.isError;
      answer.query = (await call("query_knowledge", token, { operation: "get_entity" })).value.result;
      answer.math = (await call("calculate", token, { operation: "test" })).value.result;
    }
    if (text.includes("WAIT_CANCEL")) return;
    send(message.id, { final_text: JSON.stringify(answer) });
    promptId = null;
  });
} else {
  const temp = await mkdtemp(path.join(os.tmpdir(), "jcc-kimi-mcp-test-"));
  const routes = [];
  const isolatedRoots = new Set();
  try {
    const sourceConfig = 'default_model = "test"\n[plugins]\nenabled = true\n[models.test]\nmodel = "test"\n[hooks]\ncommand = "forbidden"\n';
    await writeFile(path.join(temp, "config.toml"), sourceConfig);
    assert.doesNotMatch(sanitizeKimiConfigForRuntime(sourceConfig), /plugins|hooks|forbidden/);
    const launcher = path.join(temp, process.platform === "win32" ? "kimi.cmd" : "kimi");
    const child = fileURLToPath(import.meta.url);
    await writeFile(launcher, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${child}" --fake-child %*\r\n`
      : `#!/bin/sh\n"${process.execPath}" "${child}" --fake-child "$@"\n`);
    await chmod(launcher, 0o755);
    const adapter = { provider: "kimi", command: launcher, kimi_home: temp, available: true };
    const key = `kimi-mcp-test-${Date.now()}`;
    routes.push(key);
    const opts = { repoRoot, hostSessionKey: key, parseJson: true, timeoutMs: 10000 };
    const bootstrap = await runHostAgentRequest(adapter, "BOOTSTRAP", { ...opts, taskId: "bootstrap" });
    assert.equal(bootstrap.ok, true, bootstrap.error);
    assert.equal(bootstrap.response.token, false);
    assert.equal(bootstrap.readonly_tool_mode, "native_dynamic_tools");
    assert.equal(hostAgentSessionReadonlyToolMode(key), "native_dynamic_tools");
    assert.match(bootstrap.capability_receipt.verification_basis, /tools_list/);
    assert.notEqual(bootstrap.response.home, temp);
    isolatedRoots.add(path.dirname(bootstrap.response.home));
    assert.equal(bootstrap.response.args.includes("--agent-file"), false);
    assert.equal(bootstrap.response.args.includes("--skills-dir"), false);
    const config = await readFile(path.join(bootstrap.response.home, "config.toml"), "utf8");
    assert.match(config, /!\{mcp__jcc__query_knowledge,mcp__jcc__calculate\}/);
    assert.match(config, /scope = "user"/);
    assert.equal(bootstrap.response.timeout, "300000");
    assert.doesNotMatch(await readFile(path.join(bootstrap.response.home, "config.toml"), "utf8"), /plugins|hooks/);
    let turnId, calls = [];
    const handler = async (name, args) => { assert(turnId); calls.push({ name, args }); return { ok: true, name }; };
    for (const taskId of ["first", "second"]) {
      const result = await runHostAgentRequest(adapter, "TOOLS", { ...opts, taskId,
        onProviderTurnStarted(info) { turnId = info.turn_id; }, onReadonlyToolCall: handler });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.response.query.isError, undefined);
      assert.equal(result.response.math.isError, undefined);
      if (taskId === "second") assert.equal(result.response.stale, true);
      assert.deepEqual(result.capability_receipt.observed_tool_calls, ["jcc.query_knowledge", "jcc.calculate"]);
      assert.equal(result.transport_pid, bootstrap.transport_pid);
    }
    assert.equal(calls.length, 4);
    assert(calls.every(({ args }) => !("_jcc_turn" in args)));
    const maintenance = await runHostAgentRequest(adapter, "MAINTENANCE", { ...opts, taskId: "maintenance" });
    assert.equal(maintenance.ok, true, maintenance.error);
    assert.equal(maintenance.response.token, false);
    const waiting = runHostAgentRequest(adapter, "WAIT_CANCEL", { ...opts, taskId: "cancel-me", onProviderTurnStarted() { setTimeout(() => cancelHostAgentRun("cancel-me"), 40); } });
    assert.equal((await waiting).ok, false);
    const after = await runHostAgentRequest(adapter, "AFTER_CANCEL", { ...opts, taskId: "after" });
    assert.equal(after.ok, true, after.error);
    assert.equal(after.transport_pid, bootstrap.transport_pid);
    const crashed = await runHostAgentRequest(adapter, "CRASH_NOW", { ...opts, taskId: "crash" });
    assert.equal(crashed.ok, false);
    await writeFile(path.join(bootstrap.response.home, "fail-next-resume"), "once");
    const failedResume = await runHostAgentRequest(adapter, "RECOVER", { ...opts, hostSessionId: bootstrap.session_id, taskId: "failed-recover" });
    assert.equal(failedResume.ok, false);
    assert.equal(await readFile(path.join(bootstrap.response.home, "native-history-test"), "utf8"), "retained",
      "transient resume failure must not delete recoverable provider history");
    const residuePaths = ["mcp.json", "plugins", "skills", ".agents", ".kimi-code", ".claude", ".codex"];
    for (const relative of residuePaths) {
      const target = path.join(bootstrap.response.home, relative);
      if (relative.endsWith(".json")) await writeFile(target, "{}");
      else { await mkdir(target, { recursive: true }); await writeFile(path.join(target, "residue"), "must not load"); }
    }
    await writeFile(path.join(bootstrap.response.cwd, ".mcp.json"), "{}");
    const recovered = await runHostAgentRequest(adapter, "RECOVER", { ...opts, hostSessionId: bootstrap.session_id, taskId: "recover" });
    assert.equal(recovered.ok, true, recovered.error);
    assert.equal(recovered.session_id, bootstrap.session_id);
    assert.notEqual(recovered.transport_pid, bootstrap.transport_pid);
    for (const relative of residuePaths) assert.equal(await access(path.join(bootstrap.response.home, relative)).then(() => true, () => false), false);
    assert.equal(await access(path.join(bootstrap.response.cwd, ".mcp.json")).then(() => true, () => false), false);
    const replacements = await Promise.all(["replace-a", "replace-b"].map(taskId => runHostAgentRequest(
      { ...adapter, build_args: ["--replacement", "acp"] }, "REPLACE", { ...opts, taskId },
    )));
    assert(replacements.every(result => result.ok), JSON.stringify(replacements.map(result => result.error)));
    assert.equal(replacements[0].transport_pid, replacements[1].transport_pid, "concurrent replacement owns one transport");
    assert.equal(await readFile(path.join(replacements[0].response.home, "native-history-test"), "utf8"), "retained");
    const fallbackKey = `${key}-fallback`;
    routes.push(fallbackKey);
    const fallback = await runHostAgentRequest({ ...adapter, build_args: ["--no-handshake", "acp"] }, "NO_TOOLS", { ...opts, hostSessionKey: fallbackKey, timeoutMs: 500 });
    assert.equal(fallback.ok, true, fallback.error);
    isolatedRoots.add(path.dirname(fallback.response.home));
    assert.equal(fallback.readonly_tool_mode, "prefetch_complete");
    assert.equal(fallback.response.token, false);
    for (const crash of [true, false]) {
      const blockedKey = `${key}-blocked-${crash}`;
      routes.push(blockedKey);
      const marker = path.join(temp, `ready-${crash}`);
      const startTime = Date.now();
      const blocked = runHostAgentRequest({ ...adapter, build_args: ["--no-handshake", "--marker", marker,
        ...(crash ? ["--exit-before-handshake"] : []), "acp"] }, "BLOCKED", {
        ...opts, hostSessionKey: blockedKey, timeoutMs: 300000,
      });
      let markedHome;
      for (let i = 0; i < 200 && !markedHome; i++) {
        markedHome = await readFile(marker, "utf8").catch(() => null);
        if (!markedHome) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(markedHome, "fake session/new reached before close test");
      isolatedRoots.add(path.dirname(markedHome));
      if (!crash) await closeHostAgentSession(blockedKey);
      const outcome = await Promise.race([blocked, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("handshake close did not interrupt wait")), 3000);
        timer.unref();
      })]);
      assert.equal(outcome.ok, false);
      assert(Date.now() - startTime < 3000);
    }
    assert.equal(await readFile(path.join(temp, "config.toml"), "utf8"), sourceConfig);
    console.log("Kimi persistent ACP + native MCP fake-session checks passed");
  } finally {
    for (const key of routes) await closeHostAgentSession(key);
    for (const root of isolatedRoots) await rm(root, { recursive: true, force: true, maxRetries: 5 });
    await rm(temp, { recursive: true, force: true, maxRetries: 5 });
  }
}
