import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { terminateProcessTree, waitForProcessExit } from "./jcc_process_runner.mjs";

let sharedWorker = null;
let sharedWorkerStarting = null;
let sharedWorkerKey = null;
let sharedChild = null;
let sharedGeneration = 0;

function processKey(options) {
  return JSON.stringify({
    python: path.resolve(options.python),
    worker_script: path.resolve(options.workerScript || "tools/run_jcc_rapidocr_jsonl_worker.py"),
    config: path.resolve(options.config),
  });
}

async function spawnRapidOcrWorker(options, generation) {
  const defaultTimeoutMs = Number(
    options.timeoutMs
      || options.timeout_ms
      || process.env.JCC_RAPIDOCR_WORKER_TIMEOUT_MS
      || 30000,
  );
  const child = spawn(path.resolve(options.python), [
    path.resolve(options.workerScript || "tools/run_jcc_rapidocr_jsonl_worker.py"),
    "--config",
    path.resolve(options.config),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  sharedChild = child;
  const rl = readline.createInterface({ input: child.stdout });
  const stderrChunks = [];
  const pending = new Map();
  let readyPending = null;
  let stopped = false;
  let operationRunning = false;
  let operationSequence = 0;
  let generationFailure = null;
  const operationQueue = [];

  const generationError = (reason, cause = null) => {
    const error = new Error(`RapidOCR worker generation ${generation} damaged: ${reason}`);
    if (cause) error.cause = cause;
    return error;
  };

  const rejectQueued = (error) => {
    while (operationQueue.length > 0) {
      const entry = operationQueue.shift();
      clearTimeout(entry.queueTimer);
      entry.reject(error);
    }
  };

  const pumpOperationQueue = () => {
    if (operationRunning || !operationQueue.length) return;
    operationQueue.sort((left, right) => {
      const priorityDelta = Number(right.priority === "foreground") - Number(left.priority === "foreground");
      return priorityDelta || left.sequence - right.sequence;
    });
    const entry = operationQueue.shift();
    clearTimeout(entry.queueTimer);
    if (Date.now() >= entry.deadlineAt) {
      entry.reject(new Error(`RapidOCR worker ${entry.label} timed out in queue after ${entry.timeoutMs}ms`));
      queueMicrotask(pumpOperationQueue);
      return;
    }
    operationRunning = true;
    Promise.resolve()
      .then(() => entry.run(entry.deadlineAt))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        operationRunning = false;
        pumpOperationQueue();
      });
  };

  const enqueueOperation = (
    run,
    priority = "background",
    timeoutMs = defaultTimeoutMs,
    label = "operation",
    ownerMatchSessionId = null,
  ) => new Promise((resolve, reject) => {
    const normalizedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : defaultTimeoutMs;
    const entry = {
      run,
      priority,
      resolve,
      reject,
      sequence: operationSequence += 1,
      timeoutMs: normalizedTimeoutMs,
      deadlineAt: Date.now() + normalizedTimeoutMs,
      label,
      ownerMatchSessionId: String(ownerMatchSessionId || "").trim() || null,
      queueTimer: null,
    };
    entry.queueTimer = setTimeout(() => {
      const index = operationQueue.indexOf(entry);
      if (index < 0) return;
      operationQueue.splice(index, 1);
      reject(new Error(`RapidOCR worker ${label} timed out in queue after ${normalizedTimeoutMs}ms`));
    }, normalizedTimeoutMs);
    operationQueue.push(entry);
    pumpOperationQueue();
  });

  child.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));
  child.stdin.on("error", (error) => {
    if (!stopped) rejectPending(error);
  });

  const rejectPending = (error) => {
    if (readyPending) {
      clearTimeout(readyPending.timer);
      readyPending.reject(error);
      readyPending = null;
    }
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const clearSharedGeneration = () => {
    if (sharedWorker?.generation === generation) sharedWorker = null;
    if (sharedChild === child) sharedChild = null;
    if (!sharedWorker && !sharedWorkerStarting) sharedWorkerKey = null;
  };

  const damageGeneration = (reason, cause = null) => {
    if (generationFailure) return generationFailure;
    generationFailure = generationError(reason, cause);
    stopped = true;
    rejectPending(generationFailure);
    rejectQueued(generationFailure);
    clearSharedGeneration();
    try { child.stdin.destroy(generationFailure); } catch {}
    void terminateProcessTree(child).catch(() => {});
    return generationFailure;
  };

  rl.on("line", (line) => {
    if (readyPending) {
      const entry = readyPending;
      readyPending = null;
      clearTimeout(entry.timer);
      entry.resolve(line);
      return;
    }
    let response = null;
    try { response = JSON.parse(line); } catch { return; }
    const responseId = response?.id === undefined || response?.id === null ? null : String(response.id);
    if (!responseId) return;
    const entry = pending.get(responseId);
    if (!entry) return;
    pending.delete(responseId);
    clearTimeout(entry.timer);
    entry.resolve(line);
  });
  child.once("exit", (code) => {
    stopped = true;
    clearSharedGeneration();
    const error = generationFailure || new Error(`RapidOCR worker exited ${code}: ${stderrChunks.join("")}`);
    rejectPending(error);
    rejectQueued(error);
  });
  child.once("error", (error) => {
    stopped = true;
    clearSharedGeneration();
    const failure = generationFailure || error;
    rejectPending(failure);
    rejectQueued(failure);
  });

  const nextReadyLine = (timeoutMs = defaultTimeoutMs) => new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      if (readyPending === entry) readyPending = null;
      reject(new Error(`RapidOCR worker ready timed out after ${timeoutMs}ms: ${stderrChunks.join("")}`));
    }, timeoutMs);
    readyPending = entry;
  });

  const nextLine = (id, timeoutMs = defaultTimeoutMs, label = "response") => new Promise((resolve, reject) => {
    const requestId = String(id);
    if (pending.has(requestId)) {
      reject(new Error(`RapidOCR worker duplicate request id: ${requestId}`));
      return;
    }
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      pending.delete(requestId);
      const timeoutError = new Error(`RapidOCR worker ${label} timed out after ${timeoutMs}ms: ${stderrChunks.join("")}`);
      reject(damageGeneration(`${label} active request timed out after ${timeoutMs}ms`, timeoutError));
    }, timeoutMs);
    pending.set(requestId, entry);
  });

  let ready;
  try {
    ready = JSON.parse(await nextReadyLine(defaultTimeoutMs));
    ready = {
      ...ready,
      load_ms: ready.load_ms ?? ready.warmup_ms ?? null,
    };
    const readySchema = String(ready.schema || "");
    if (!ready.ok || (ready.type && ready.type !== "ready") || (readySchema && readySchema !== "jcc-rapidocr-worker-ready-v1")) {
      throw new Error(`RapidOCR worker did not become ready: ${JSON.stringify(ready)}`);
    }
  } catch (error) {
    stopped = true;
    rl.close();
    try { child.stdin.destroy(); } catch {}
    await terminateProcessTree(child);
    if (sharedChild === child) sharedChild = null;
    throw error;
  }

  const worker = {
    ready,
    pid: child.pid,
    generation,
    isAlive() {
      return !stopped && child.exitCode === null;
    },
    async ocr(imagePath, id, requestOptions = {}) {
      const enqueuedAt = Date.now();
      const priority = requestOptions.priority === "foreground" ? "foreground" : "background";
      const timeoutMs = Number.isFinite(Number(requestOptions.timeoutMs || requestOptions.timeout_ms))
        && Number(requestOptions.timeoutMs || requestOptions.timeout_ms) > 0
        ? Number(requestOptions.timeoutMs || requestOptions.timeout_ms)
        : defaultTimeoutMs;
      const requestId = String(id);
      const run = async (deadlineAt) => {
        if (generationFailure) throw generationFailure;
        if (!worker.isAlive()) throw new Error("RapidOCR resident worker is not running");
        const startedAt = Date.now();
        const remainingMs = deadlineAt - startedAt;
        if (remainingMs <= 0) throw new Error(`RapidOCR worker ocr:${requestId} timed out before execution after ${timeoutMs}ms`);
        const responsePromise = nextLine(requestId, remainingMs, `ocr:${requestId}`);
        child.stdin.write(`${JSON.stringify({
          type: "ocr",
          id: requestId,
          image: path.resolve(imagePath),
          ...(requestOptions.text_score !== undefined ? { text_score: requestOptions.text_score } : {}),
          ...(requestOptions.use_det !== undefined ? { use_det: requestOptions.use_det } : {}),
          ...(requestOptions.use_cls !== undefined ? { use_cls: requestOptions.use_cls } : {}),
          ...(requestOptions.normalized_roi ? { normalized_roi: requestOptions.normalized_roi } : {}),
          ...(requestOptions.debugOutputImage ? { debug_output_image: path.resolve(requestOptions.debugOutputImage) } : {}),
        })}\n`);
        const response = JSON.parse(await responsePromise);
        if (!response.ok) throw new Error(`RapidOCR worker request failed: ${JSON.stringify(response)}`);
        return {
          ...response,
          queue_wait_ms: startedAt - enqueuedAt,
          request_priority: priority,
          timing_ms: {
            ...(response.timing_ms || {}),
            queue_wait_ms: startedAt - enqueuedAt,
            worker_request_ms: Date.now() - startedAt,
          },
        };
      };
      return enqueueOperation(
        run,
        priority,
        timeoutMs,
        `ocr:${requestId}`,
        requestOptions.ownerMatchSessionId || requestOptions.owner_match_session_id || null,
      );
    },
    retireScope(ownerMatchSessionId, reason = "match_scope_retired") {
      const normalizedOwner = String(ownerMatchSessionId || "").trim();
      if (!normalizedOwner) return { retired: 0, owner_match_session_id: null, reason };
      let retired = 0;
      for (let index = operationQueue.length - 1; index >= 0; index -= 1) {
        const entry = operationQueue[index];
        if (entry.ownerMatchSessionId !== normalizedOwner) continue;
        operationQueue.splice(index, 1);
        clearTimeout(entry.queueTimer);
        entry.reject(new Error(`RapidOCR worker ${entry.label} cancelled: ${reason}`));
        retired += 1;
      }
      return { retired, owner_match_session_id: normalizedOwner, reason };
    },
    async stop() {
      if (stopped || child.exitCode !== null) return;
      stopped = true;
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        await new Promise((resolve) => {
          child.stdin.write(`${JSON.stringify({ type: "shutdown", id: "shutdown" })}\n`, () => resolve());
        }).catch(() => {});
      }
      const exited = await waitForProcessExit(child, Math.min(defaultTimeoutMs, 1500));
      if (!exited) await terminateProcessTree(child);
      clearSharedGeneration();
      rl.close();
    },
  };
  return worker;
}

export async function startSharedRapidOcrWorker(options) {
  const key = processKey(options);
  if (sharedWorker?.isAlive?.() && sharedWorkerKey === key) return sharedWorker;
  if (sharedWorkerStarting && sharedWorkerKey === key) return sharedWorkerStarting;
  if (sharedWorker || sharedWorkerStarting) await stopSharedRapidOcrWorker("configuration_changed");
  sharedWorkerKey = key;
  const generation = sharedGeneration += 1;
  const starting = spawnRapidOcrWorker(options, generation)
    .then((worker) => {
      if (sharedGeneration === generation) sharedWorker = worker;
      return worker;
    })
    .finally(() => {
      if (sharedWorkerStarting === starting) sharedWorkerStarting = null;
      if (!sharedWorker) sharedWorkerKey = null;
    });
  sharedWorkerStarting = starting;
  return sharedWorkerStarting;
}

export async function stopSharedRapidOcrWorker() {
  const starting = sharedWorkerStarting;
  const worker = sharedWorker;
  if (worker) {
    try {
      await worker.stop();
    } catch {}
  } else if (starting) {
    if (sharedChild && sharedChild.exitCode === null) await terminateProcessTree(sharedChild);
    try {
      const startedWorker = await starting;
      await startedWorker.stop();
    } catch {}
  } else if (sharedChild && sharedChild.exitCode === null) {
    await terminateProcessTree(sharedChild);
  }
  sharedWorker = null;
  sharedWorkerStarting = null;
  sharedWorkerKey = null;
}

export function retireSharedRapidOcrScope(ownerMatchSessionId, reason = "match_scope_retired") {
  return sharedWorker?.retireScope?.(ownerMatchSessionId, reason) || {
    retired: 0,
    owner_match_session_id: String(ownerMatchSessionId || "").trim() || null,
    reason,
  };
}

export function sharedRapidOcrWorkerSnapshot() {
  return {
    starting: Boolean(sharedWorkerStarting),
    ready: Boolean(sharedWorker?.isAlive?.()),
    pid: sharedWorker?.pid || null,
    generation: sharedWorker?.generation || null,
    key: sharedWorkerKey,
  };
}
