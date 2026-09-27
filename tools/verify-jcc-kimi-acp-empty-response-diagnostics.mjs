import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runHostAgentRequest } from "../ui/electron/host-adapters.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  await verifyProviderDiagnosticsFromSessionLog();
  await verifyGenericAcpAuthErrorUsesSessionLog();
  await verifyJsonRpcOnlyStdoutDoesNotBecomeUserDiagnostic();
  await verifyJsonRpcOnlyStdoutOnNonZeroExitDoesNotBecomeUserDiagnostic();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked: [
      "kimi-acp-empty-response-provider-diagnostics",
      "kimi-acp-generic-auth-error-provider-diagnostics",
      "kimi-acp-jsonrpc-only-empty-response-diagnostic",
      "kimi-acp-nonzero-jsonrpc-only-diagnostic",
    ],
  }, null, 2)}\n`);
}

async function verifyGenericAcpAuthErrorUsesSessionLog() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-kimi-auth-log-"));
  const kimiHome = path.join(tempRoot, ".kimi-code");
  const sessionId = "session_auth_diagnostics";
  const fakeKimi = path.join(tempRoot, "fake-kimi-auth.mjs");
  const fakeLauncher = path.join(tempRoot, process.platform === "win32" ? "fake-kimi.cmd" : "fake-kimi");
  await writeFile(fakeKimi, `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const sessionId = ${JSON.stringify(sessionId)};
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
      sessionId,
      configOptions: [{
        id: "model",
        currentValue: "kimi-code/kimi-for-coding",
        options: [{ value: "kimi-code/kimi-for-coding-highspeed" }]
      }]
    });
    return;
  }
  if (message.method === "session/set_config_option") {
    const logDir = path.join(process.env.KIMI_CODE_HOME, "sessions", "wd_probe", sessionId, "logs");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, "kimi-code.log"),
      'WARN errorMessage="401 Your current subscription does not have access to kimi-for-coding-highspeed. Upgrade to an Allegretto plan or above."',
      "utf8");
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: "Authentication required" }
    }) + "\\n");
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
      kimi_home: kimiHome,
    }, "Return JSON.", {
      parseJson: true,
      repoRoot: path.resolve(import.meta.dirname, ".."),
      hostCwd: tempRoot,
      timeoutMs: 30000,
    });
    assert(result.ok === false, "generic ACP auth error must fail");
    assert(/401|subscription|Allegretto/i.test(result.error || ""), `generic ACP auth error should expose the provider diagnostic, got: ${result.error}`);
    assert(!/^code=-32000 Authentication required$/i.test(result.error || ""), "generic ACP auth error must not hide the provider diagnostic");
  } finally {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function verifyProviderDiagnosticsFromSessionLog() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-kimi-empty-"));
  const kimiHome = path.join(tempRoot, ".kimi-code");
  const sessionId = "session_empty_diagnostics";
  const fakeKimi = path.join(tempRoot, "fake-kimi-empty.mjs");
  const fakeLauncher = path.join(tempRoot, process.platform === "win32" ? "fake-kimi.cmd" : "fake-kimi");
  await mkdir(tempRoot, { recursive: true });
  await writeFile(fakeKimi, `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const sessionId = ${JSON.stringify(sessionId)};
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
    respond(message.id, { sessionId, configOptions: [] });
    return;
  }
  if (message.method === "session/prompt") {
    const logDir = path.join(process.env.KIMI_CODE_HOME, "sessions", "wd_probe", sessionId, "logs");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, "kimi-code.log"), [
      "2026-07-04T12:01:31.277Z WARN  llm request failed  errorName=APIStatusError errorMessage=\\"403 You've reached your usage limit for this billing cycle.\\" statusCode=403",
      "2026-07-04T12:01:31.284Z WARN  acp: turn ended with failed reason  error={\\"code\\":\\"provider.api_error\\",\\"message\\":\\"403 You've reached your usage limit for this billing cycle.\\"}",
    ].join("\\n"), "utf8");
    respond(message.id, { stopReason: "end_turn" });
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
      kimi_home: kimiHome,
    }, "Return JSON.", {
      parseJson: true,
      repoRoot: path.resolve(import.meta.dirname, ".."),
      hostCwd: tempRoot,
      timeoutMs: 30000,
    });
    assert(result.ok === false, "empty Kimi ACP response must fail");
    assert(/usage limit|billing cycle|403/i.test(result.error || ""), `error should expose Kimi provider diagnostic, got: ${result.error}`);
    assert(!/Host CLI returned empty response/i.test(result.error || ""), "error must not regress to generic empty response");
  } finally {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function verifyJsonRpcOnlyStdoutDoesNotBecomeUserDiagnostic() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-kimi-jsonrpc-empty-"));
  const kimiHome = path.join(tempRoot, ".kimi-code");
  const sessionId = "session_jsonrpc_only_empty";
  const fakeKimi = path.join(tempRoot, "fake-kimi-jsonrpc-empty.mjs");
  const fakeLauncher = path.join(tempRoot, process.platform === "win32" ? "fake-kimi.cmd" : "fake-kimi");
  await mkdir(tempRoot, { recursive: true });
  await writeFile(fakeKimi, `
import readline from "node:readline";

const sessionId = ${JSON.stringify(sessionId)};
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
    respond(message.id, { sessionId, configOptions: [] });
    return;
  }
  if (message.method === "session/prompt") {
    respond(message.id, { stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 0 } });
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
      kimi_home: kimiHome,
    }, "Return JSON.", {
      parseJson: true,
      repoRoot: path.resolve(import.meta.dirname, ".."),
      hostCwd: tempRoot,
      timeoutMs: 30000,
    });
    assert(result.ok === false, "JSON-RPC-only Kimi ACP response must fail");
    assert(/Kimi CLI returned no assistant text/i.test(result.error || ""), `error should explain missing assistant text, got: ${result.error}`);
    assert(result.error.includes(sessionId), `error should include session id for diagnostics, got: ${result.error}`);
    assert(!/^\s*\{.*"jsonrpc"/is.test(result.error || ""), `error must not expose raw ACP JSON-RPC stdout, got: ${result.error}`);
    assert(!/Host CLI returned empty response/i.test(result.error || ""), "error must not regress to generic empty response");
  } finally {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function verifyJsonRpcOnlyStdoutOnNonZeroExitDoesNotBecomeUserDiagnostic() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-kimi-jsonrpc-exit-"));
  const kimiHome = path.join(tempRoot, ".kimi-code");
  const sessionId = "session_jsonrpc_only_exit";
  const fakeKimi = path.join(tempRoot, "fake-kimi-jsonrpc-exit.mjs");
  const fakeLauncher = path.join(tempRoot, process.platform === "win32" ? "fake-kimi.cmd" : "fake-kimi");
  await mkdir(tempRoot, { recursive: true });
  await writeFile(fakeKimi, `
process.stdout.write(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { image: true } }
  }
}) + "\\n");
process.stdout.write(JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  result: { sessionId: ${JSON.stringify(sessionId)}, configOptions: [] }
}) + "\\n");
process.exit(9);
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
      kimi_home: kimiHome,
    }, "Return JSON.", {
      parseJson: true,
      repoRoot: path.resolve(import.meta.dirname, ".."),
      hostCwd: tempRoot,
      timeoutMs: 30000,
    });
    assert(result.ok === false, "non-zero Kimi ACP response must fail");
    assert(/Kimi ACP exited 9/i.test(result.error || ""), `non-zero exit should be summarized, got: ${result.error}`);
    assert(!/^\s*\{.*"jsonrpc"/is.test(result.error || ""), `non-zero exit must not expose raw ACP JSON-RPC stdout, got: ${result.error}`);
    assert(!/Host CLI returned empty response/i.test(result.error || ""), "non-zero exit must not regress to generic empty response");
  } finally {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
