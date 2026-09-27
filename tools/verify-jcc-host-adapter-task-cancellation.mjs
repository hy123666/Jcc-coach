import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cancelHostAgentRun, runHostAgentRequest } from "../ui/electron/host-adapters.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLogCount(logFile, pattern, expected, timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const text = await readFile(logFile, "utf8").catch(() => "");
    const count = (text.match(pattern) || []).length;
    if (count >= expected) return text;
    await sleep(25);
  }
  const text = await readFile(logFile, "utf8").catch(() => "");
  throw new Error(`Timed out waiting for ${expected} log entries matching ${pattern}; log=${text}`);
}

function runStub({ fakeCodex, label, taskId, timeoutMs }) {
  return runHostAgentRequest({
    provider: "codex",
    spawn_command: process.execPath,
    spawn_prefix_args: [fakeCodex],
    selected_model: null,
    reasoning_effort: null,
  }, `stub prompt ${label}`, {
    parseJson: true,
    repoRoot: process.cwd(),
    taskId,
    timeoutMs,
    hostCwd: path.dirname(fakeCodex),
  });
}

async function writeFakeCodex(tempRoot, { label, logFile, delayMs }) {
  const fakeCodex = path.join(tempRoot, `fake-codex-${label}.mjs`);
  await writeFile(fakeCodex, `
import { appendFile } from "node:fs/promises";

const label = ${JSON.stringify(label)};
const logFile = ${JSON.stringify(logFile)};
const delayMs = ${Number(delayMs)};
await appendFile(logFile, "started " + label + "\\n", "utf8");
for await (const _chunk of process.stdin) {}
await new Promise((resolve) => setTimeout(resolve, delayMs));
const response = {
  schema: "jcc-host-cli-coach-response-v1",
  generated_by: "current_cli_agent_main_model",
  request_id: label,
  final_text: "completed " + label,
  recommended_action: "continue",
  confidence: "high",
  followup_question: null
};
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-" + label }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(response) } }) + "\\n");
await appendFile(logFile, "completed " + label + "\\n", "utf8");
`, "utf8");
  return fakeCodex;
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-host-adapter-task-cancel-"));
  const sourceCodexHome = path.join(tempRoot, "source-codex-home");
  const runtimeCodexHome = path.join(tempRoot, "runtime-codex-home");
  const logFile = path.join(tempRoot, "events.log");
  const previousSourceCodexHome = process.env.JCC_SOURCE_CODEX_HOME;
  const previousRuntimeCodexHome = process.env.JCC_CODEX_RUNTIME_HOME;
  try {
    await mkdir(sourceCodexHome, { recursive: true });
    await writeFile(path.join(sourceCodexHome, "auth.json"), "{\"OPENAI_API_KEY\":\"stub\"}\n", "utf8");
    await writeFile(path.join(sourceCodexHome, "installation_id"), "stub-installation\n", "utf8");
    await writeFile(path.join(sourceCodexHome, "config.toml"), [
      'model_provider = "stub_provider"',
      'model = "stub-model"',
      "",
      "[model_providers.stub_provider]",
      'name = "Stub Provider"',
      'base_url = "https://example.invalid/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");
    process.env.JCC_SOURCE_CODEX_HOME = sourceCodexHome;
    process.env.JCC_CODEX_RUNTIME_HOME = runtimeCodexHome;

    const timeoutVictimScript = await writeFakeCodex(tempRoot, { label: "timeout-victim", logFile, delayMs: 5000 });
    const timeoutSurvivorScript = await writeFakeCodex(tempRoot, { label: "timeout-survivor", logFile, delayMs: 700 });
    const timeoutVictim = runStub({
      fakeCodex: timeoutVictimScript,
      label: "timeout-victim",
      taskId: "task-timeout-victim",
      timeoutMs: 350,
    });
    await waitForLogCount(logFile, /started timeout-victim/g, 1);
    const timeoutSurvivor = runStub({
      fakeCodex: timeoutSurvivorScript,
      label: "timeout-survivor",
      taskId: "task-timeout-survivor",
      timeoutMs: 8000,
    });
    await waitForLogCount(logFile, /started timeout-survivor/g, 1);

    const [timedOut, survivedTimeout] = await Promise.all([timeoutVictim, timeoutSurvivor]);
    assert(timedOut.ok === false, "timed-out task should fail independently");
    assert(/timed out|exited/i.test(String(timedOut.error || "")), `timeout victim error should explain failure: ${timedOut.error || ""}`);
    assert(survivedTimeout.ok === true, `other task must survive unrelated timeout: ${survivedTimeout.error || ""}`);
    assert(survivedTimeout.response?.request_id === "timeout-survivor", "surviving task response should be preserved");

    const manualVictimScript = await writeFakeCodex(tempRoot, { label: "manual-victim", logFile, delayMs: 5000 });
    const manualSurvivorScript = await writeFakeCodex(tempRoot, { label: "manual-survivor", logFile, delayMs: 700 });
    const manualVictim = runStub({
      fakeCodex: manualVictimScript,
      label: "manual-victim",
      taskId: "task-manual-victim",
      timeoutMs: 10000,
    });
    await waitForLogCount(logFile, /started manual-victim/g, 1);
    const manualSurvivor = runStub({
      fakeCodex: manualSurvivorScript,
      label: "manual-survivor",
      taskId: "task-manual-survivor",
      timeoutMs: 8000,
    });
    await waitForLogCount(logFile, /started manual-survivor/g, 1);

    const cancelled = cancelHostAgentRun("task-manual-victim");
    assert(cancelled === true, "task-specific cancel should report true for the selected task");
    const [manualCancelled, survivedManualCancel] = await Promise.all([manualVictim, manualSurvivor]);
    assert(manualCancelled.ok === false, "manually cancelled task should fail independently");
    assert(survivedManualCancel.ok === true, `other task must survive task-specific cancellation: ${survivedManualCancel.error || ""}`);
    assert(survivedManualCancel.response?.request_id === "manual-survivor", "manual survivor response should be preserved");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      checked: [
        "host-adapter-task-timeout-isolated-by-task-id",
        "host-adapter-manual-cancel-isolated-by-task-id",
      ],
    }, null, 2)}\n`);
  } finally {
    cancelHostAgentRun();
    if (previousSourceCodexHome === undefined) delete process.env.JCC_SOURCE_CODEX_HOME;
    else process.env.JCC_SOURCE_CODEX_HOME = previousSourceCodexHome;
    if (previousRuntimeCodexHome === undefined) delete process.env.JCC_CODEX_RUNTIME_HOME;
    else process.env.JCC_CODEX_RUNTIME_HOME = previousRuntimeCodexHome;
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
