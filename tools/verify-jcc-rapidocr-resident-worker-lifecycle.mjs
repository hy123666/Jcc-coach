import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  retireSharedRapidOcrScope,
  sharedRapidOcrWorkerSnapshot,
  startSharedRapidOcrWorker,
  stopSharedRapidOcrWorker,
} from "./jcc-rapidocr-resident-worker.mjs";

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function resolvePython() {
  const candidates = [
    process.env.JCC_OCR_PYTHON,
    path.resolve(".venv-ocr/Scripts/python.exe"),
    path.resolve(".venv/Scripts/python.exe"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error("Python executable not found for resident worker lifecycle verifier");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-rapidocr-worker-"));
try {
  const python = await resolvePython();
  const config = path.join(tempDir, "config.yaml");
  const readyScript = path.join(tempDir, "ready_worker.py");
  const delayedScript = path.join(tempDir, "delayed_worker.py");
  const delayedRequestLog = path.join(tempDir, "delayed-requests.log");
  const stalledScript = path.join(tempDir, "stalled_worker.py");
  const stalledPidFile = path.join(tempDir, "stalled.pid");
  await writeFile(config, "test: true\n", "utf8");
  await writeFile(readyScript, [
    "import json, sys",
    "print(json.dumps({'schema':'jcc-rapidocr-worker-ready-v1','type':'ready','ok':True,'load_ms':1}), flush=True)",
    "for line in sys.stdin:",
    "    request = json.loads(line)",
    "    if request.get('type') == 'shutdown': break",
    "    print(json.dumps({'ok':True,'id':request.get('id'),'blocks':[]}), flush=True)",
  ].join("\n"), "utf8");
  await writeFile(stalledScript, [
    "import os, time",
    `open(${JSON.stringify(stalledPidFile)}, 'w', encoding='utf-8').write(str(os.getpid()))`,
    "time.sleep(30)",
  ].join("\n"), "utf8");
  await writeFile(delayedScript, [
    "import json, sys, time",
    "print(json.dumps({'schema':'jcc-rapidocr-worker-ready-v1','type':'ready','ok':True,'load_ms':1}), flush=True)",
    "for line in sys.stdin:",
    "    request = json.loads(line)",
    "    if request.get('type') == 'shutdown': break",
    `    open(${JSON.stringify(delayedRequestLog)}, 'a', encoding='utf-8').write(str(request.get('id')) + '\\n')`,
    "    if request.get('id') == 'slow': time.sleep(0.15)",
    "    if request.get('id') == 'queue-blocker': time.sleep(0.7)",
    "    print(json.dumps({'ok':True,'id':request.get('id'),'blocks':[]}), flush=True)",
  ].join("\n"), "utf8");

  const options = { python, config, workerScript: readyScript, timeoutMs: 15000 };
  const [first, second, third] = await Promise.all([
    startSharedRapidOcrWorker(options),
    startSharedRapidOcrWorker(options),
    startSharedRapidOcrWorker(options),
  ]);
  assert.equal(first.ready.load_ms, 1, "worker readiness must expose one normalized load_ms diagnostic");
  assert.equal(first.pid, second.pid, "concurrent consumers must share one resident OCR process");
  assert.equal(first.pid, third.pid, "all ROI modes must share one resident OCR process");
  assert.equal(sharedRapidOcrWorkerSnapshot().ready, true);
  await first.ocr(path.join(tempDir, "unused.png"), "shared-worker-smoke");
  await stopSharedRapidOcrWorker();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(processExists(first.pid), false, "shared resident worker must exit after stop");

  let delayed = await startSharedRapidOcrWorker({ python, config, workerScript: delayedScript, timeoutMs: 15000 });
  const damagedPid = delayed.pid;
  const damagedGeneration = delayed.generation;
  const activeTimeout = delayed.ocr(path.join(tempDir, "unused.png"), "slow", { timeoutMs: 40 });
  const rejectedQueued = delayed.ocr(path.join(tempDir, "unused.png"), "queued-behind-damaged", { timeoutMs: 500 });
  await assert.rejects(activeTimeout, /generation \d+ damaged: ocr:slow active request timed out/);
  await assert.rejects(rejectedQueued, /generation \d+ damaged: ocr:slow active request timed out/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(processExists(damagedPid), false, "active request timeout must terminate the damaged worker process tree");
  assert.equal(sharedRapidOcrWorkerSnapshot().ready, false, "damaged generation must release the shared worker reference");
  delayed = await startSharedRapidOcrWorker({ python, config, workerScript: delayedScript, timeoutMs: 15000 });
  assert.notEqual(delayed.pid, damagedPid, "restart after active timeout must use a new worker PID");
  assert(delayed.generation > damagedGeneration, "restart after active timeout must use a new worker generation");
  const fastResponse = await delayed.ocr(path.join(tempDir, "unused.png"), "fast", { timeoutMs: 500 });
  assert.equal(fastResponse.id, "fast", "old generation output must not settle a request on the replacement worker");
  const completionOrder = [];
  const inFlight = delayed.ocr(path.join(tempDir, "unused.png"), "slow", { timeoutMs: 500, priority: "background" })
    .then((response) => completionOrder.push(response.id));
  const queuedBackground = delayed.ocr(path.join(tempDir, "unused.png"), "background-2", { timeoutMs: 500, priority: "background" })
    .then((response) => completionOrder.push(response.id));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const foreground = delayed.ocr(path.join(tempDir, "unused.png"), "foreground-quick-ocr", { timeoutMs: 500, priority: "foreground" })
    .then((response) => completionOrder.push(response.id));
  await Promise.all([inFlight, queuedBackground, foreground]);
  assert.deepEqual(completionOrder, ["slow", "foreground-quick-ocr", "background-2"], "foreground Quick OCR must run immediately after the current in-flight HUD task");

  const queueBlocker = delayed.ocr(path.join(tempDir, "unused.png"), "queue-blocker", { timeoutMs: 1500, priority: "background" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const queuedAt = Date.now();
  await assert.rejects(
    delayed.ocr(path.join(tempDir, "unused.png"), "expired-in-queue", { timeoutMs: 150, priority: "foreground" }),
    /timed out in queue after 150ms/,
  );
  assert(Date.now() - queuedAt < 500, "foreground Quick OCR timeout must include queue wait instead of waiting for the blocker");
  await queueBlocker;
  const afterQueueTimeout = await delayed.ocr(path.join(tempDir, "unused.png"), "after-queue-timeout", { timeoutMs: 500 });
  assert.equal(afterQueueTimeout.id, "after-queue-timeout", "worker must remain usable after a queued request expires");
  const scopeBlocker = delayed.ocr(path.join(tempDir, "unused.png"), "queue-blocker", { timeoutMs: 1500, priority: "background" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const retiredOldMatch = delayed.ocr(path.join(tempDir, "unused.png"), "retired-old-match", {
    timeoutMs: 1200,
    priority: "background",
    ownerMatchSessionId: "match-old",
  });
  const retainedNewMatch = delayed.ocr(path.join(tempDir, "unused.png"), "retained-new-match", {
    timeoutMs: 1600,
    priority: "background",
    ownerMatchSessionId: "match-new",
  });
  const retirement = retireSharedRapidOcrScope("match-old", "verify_match_boundary");
  assert.equal(retirement.retired, 1, "match boundary must remove queued OCR owned by the retired match");
  await assert.rejects(retiredOldMatch, /cancelled: verify_match_boundary/);
  await scopeBlocker;
  assert.equal((await retainedNewMatch).id, "retained-new-match", "retiring one match must not remove another match's OCR work");
  const executedRequests = (await readFile(delayedRequestLog, "utf8")).trim().split(/\r?\n/);
  assert(!executedRequests.includes("expired-in-queue"), "an expired queued OCR request must never be sent to Python");
  assert(!executedRequests.includes("retired-old-match"), "a retired match OCR request must never reach Python");
  await stopSharedRapidOcrWorker();

  const pythonWorkerSource = await readFile("tools/run_jcc_rapidocr_jsonl_worker.py", "utf8");
  assert(pythonWorkerSource.includes('"id": request_id'), "Python worker failures must preserve request id for immediate Node correlation");

  await assert.rejects(
    startSharedRapidOcrWorker({ python, config, workerScript: stalledScript, timeoutMs: 5000 }),
    /timed out after 5000ms/,
  );
  const stalledPid = Number(await readFile(stalledPidFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(processExists(stalledPid), false, "startup timeout must terminate the Python process tree");
  assert.deepEqual(sharedRapidOcrWorkerSnapshot(), {
    starting: false,
    ready: false,
    pid: null,
    generation: null,
    key: null,
  });

  console.log(JSON.stringify({
    ok: true,
    shared_pid: first.pid,
    checks: [
      "concurrent_consumers_share_one_process",
      "graceful_stop_reaps_worker",
      "active_timeout_damages_generation_and_rejects_queue",
      "damaged_generation_restarts_with_new_pid",
      "old_generation_output_cannot_settle_replacement_request",
      "foreground_quick_ocr_preempts_queued_background_hud",
      "foreground_timeout_includes_queue_wait",
      "expired_queue_request_is_not_executed",
      "retired_match_queue_request_is_not_executed",
      "python_error_preserves_request_id",
      "ready_timeout_reaps_process_tree",
    ],
  }, null, 2));
} finally {
  await stopSharedRapidOcrWorker().catch(() => {});
  await rm(tempDir, { recursive: true, force: true });
}
