import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const REQUEST_MODE_PRIORITY = {
  augment_choice: 100,
  item_choice: 90,
  refresh_self_state: 20,
};

function usage() {
  return [
    "Usage:",
    "  node tools/run-jcc-pending-visual-request.mjs --watch-dir <dir> --out-dir <dir> [--request-index best|latest|0] [--request-id <id>] [--device <adb-id>] [--adb <adb>] [--agent-response <json>] [--prepared-run <pending-run.json>] [--out <json>]",
    "",
    "Consumes a watcher pending visual request using the product host-CLI multimodal path.",
    "Without --agent-response, it captures the current frame and emits the host CLI visual task package.",
    "With --agent-response, it converts the host CLI JSON response into visual_observations and visual live_state.",
    "With --prepared-run, it reuses the exact previously captured frame/request instead of capturing a new frame.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { requestIndex: "best", burstFrameWaitMs: 1600 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--watch-dir") options.watchDir = argv[++index];
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--request-index") options.requestIndex = argv[++index];
    else if (arg === "--request-id") options.requestId = argv[++index];
    else if (arg === "--device") options.device = argv[++index];
    else if (arg === "--adb") options.adb = argv[++index];
    else if (arg === "--connect") options.connect = argv[++index];
    else if (arg === "--fixture-image") options.fixtureImage = argv[++index];
    else if (arg === "--capture-source") options.captureSource = argv[++index];
    else if (arg === "--mumu-shell") options.mumuShell = argv[++index];
    else if (arg === "--mumu-host") options.mumuHost = argv[++index];
    else if (arg === "--mumu-instance") options.mumuInstance = argv[++index];
    else if (arg === "--agent-response") options.agentResponse = argv[++index];
    else if (arg === "--prepared-run") options.preparedRun = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--burst-frame-wait-ms") options.burstFrameWaitMs = Number(argv[++index]);
    else if (arg === "--compatibility-calibration") options.compatibilityCalibration = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function readJson(file) {
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

function liveStateMatchSessionId(liveState) {
  if (!liveState || typeof liveState !== "object") return null;
  return liveState.match_session_id
    || liveState.metadata?.match_session_id
    || liveState.source?.match_session_id
    || liveState.live_state?.match_session_id
    || null;
}

function normalizeStageRound(value) {
  if (value === undefined || value === null) return null;
  const raw = typeof value === "object" && Object.hasOwn(value, "value") ? value.value : value;
  const text = String(raw || "").trim();
  const match = text.match(/(\d+)\s*[-_/]\s*(\d+)/);
  return match ? `${Number(match[1])}-${Number(match[2])}` : null;
}

function liveStateStageRound(liveState) {
  if (!liveState || typeof liveState !== "object") return null;
  const root = liveState.live_state || liveState;
  return normalizeStageRound(
    root.phase?.stage_round
    || root.phase?.current_round_text
    || root.phase?.round_key
    || root.stage_round
    || liveState.visual?.phase?.value?.stage_round
    || liveState.visual?.phase?.value?.current_round_text,
  );
}

function requestStageRound(request) {
  if (!request || typeof request !== "object") return null;
  return normalizeStageRound(
    request.stage_round
    || request.target_stage_round
    || request.requested_stage_round
    || request.phase?.stage_round
    || request.phase?.current_round_text,
  );
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function requireOk(label, result) {
  if (result.code !== 0) throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  return result;
}

async function removeTransientFrameAfterResponse(frameFile, hasAgentResponse) {
  if (!hasAgentResponse) return false;
  const frame = await readJson(frameFile);
  const imagePath = frame?.image?.path || frame?.frame?.image_reference?.path;
  if (!imagePath) return false;
  await rm(path.resolve(imagePath), { force: true });
  return true;
}

async function removeBurstImagesAfterResponse(request, hasAgentResponse) {
  if (!hasAgentResponse) return { attempted: 0, deleted: 0 };
  const captures = Array.isArray(request?.burst_capture?.captures) ? request.burst_capture.captures : [];
  let attempted = 0;
  let deleted = 0;
  for (const capture of captures) {
    const imageFile = capture?.image_file ? path.resolve(capture.image_file) : null;
    if (!imageFile) continue;
    attempted += 1;
    try {
      await rm(imageFile, { force: true });
      deleted += 1;
    } catch {
      // Best-effort cleanup: structured visual-frame.json remains the durable evidence.
    }
  }
  return { attempted, deleted };
}

async function removeSiblingBurstImagesAfterResponse(pending, consumedRequest, hasAgentResponse) {
  if (!hasAgentResponse || !pending) return { attempted: 0, deleted: 0 };
  const requests = Array.isArray(pending?.pending) ? pending.pending : [];
  let attempted = 0;
  let deleted = 0;
  for (const request of requests) {
    if (request?.request_id === consumedRequest?.request_id) continue;
    if (request?.mode !== consumedRequest?.mode) continue;
    const result = await removeBurstImagesAfterResponse(request, true);
    attempted += result.attempted;
    deleted += result.deleted;
  }
  return { attempted, deleted };
}

async function resolvePreparedRun(options) {
  if (!options.preparedRun) return null;
  const prepared = await readJson(path.resolve(options.preparedRun));
  const frameFile = prepared?.artifacts?.frame;
  const visionRequestFile = prepared?.artifacts?.vision_request;
  const request = prepared?.request;
  if (!frameFile || !visionRequestFile || !request) {
    throw new Error("--prepared-run must point to a prior pending visual run with artifacts.frame, artifacts.vision_request, and request");
  }
  if (prepared.status !== "awaiting_host_cli_agent_response") {
    throw new Error(`--prepared-run status must be awaiting_host_cli_agent_response, got ${prepared.status || "unknown"}`);
  }
  return {
    request,
    frameFile: path.resolve(frameFile),
    visionRequestFile: path.resolve(visionRequestFile),
    watchDir: prepared.watch_dir ? path.resolve(prepared.watch_dir) : null,
  };
}

function selectRequest(pending, requestIndex, requestId = null) {
  const requests = (Array.isArray(pending?.pending) ? pending.pending : [])
    .filter((request) => request?.status !== "superseded_by_fast_choice_text");
  if (!requests.length) throw new Error("No pending visual requests found");
  if (requestId) {
    const expected = String(requestId);
    const found = requests.find((request) => String(request?.request_id || "") === expected);
    if (!found) throw new Error(`No pending visual request matched request_id=${expected}`);
    return found;
  }
  if (requestIndex === "best") {
    return requests
      .map((request, index) => ({ request, index }))
      .sort((left, right) => {
        const rightPriority = REQUEST_MODE_PRIORITY[right.request?.mode] || 0;
        const leftPriority = REQUEST_MODE_PRIORITY[left.request?.mode] || 0;
        if (rightPriority !== leftPriority) return rightPriority - leftPriority;
        const leftAt = Date.parse(left.request?.queued_at || left.request?.at || "") || 0;
        const rightAt = Date.parse(right.request?.queued_at || right.request?.at || "") || 0;
        if (left.request?.mode === "refresh_self_state" && right.request?.mode === "refresh_self_state") {
          return rightAt - leftAt;
        }
        return leftAt - rightAt;
      })[0].request;
  }
  if (requestIndex === "latest") return requests.at(-1);
  const index = Number(requestIndex);
  if (!Number.isInteger(index) || index < 0 || index >= requests.length) {
    throw new Error(`Invalid --request-index ${requestIndex}; queue length=${requests.length}`);
  }
  return requests[index];
}

async function requestWasSuperseded(pendingVisualRequestsFile, request) {
  if (!request?.request_id) return false;
  const latestPending = await readJson(pendingVisualRequestsFile).catch(() => null);
  const latestRequests = Array.isArray(latestPending?.pending) ? latestPending.pending : [];
  return latestRequests.some((entry) =>
    String(entry?.request_id || "") === String(request.request_id)
    && entry?.status === "superseded_by_fast_choice_text"
  );
}

function isSupersededByConsumedRequest(candidate, consumed) {
  if (!candidate || !consumed) return false;
  if (candidate.request_id === consumed.request_id) return true;
  if (consumed.mode !== "refresh_self_state") return false;
  if (candidate.mode !== "refresh_self_state") return false;
  if (candidate.match_session_id && consumed.match_session_id && candidate.match_session_id !== consumed.match_session_id) return false;
  const candidateAt = Date.parse(candidate.queued_at || candidate.at || "");
  const consumedAt = Date.parse(consumed.queued_at || consumed.at || "");
  if (!Number.isFinite(candidateAt) || !Number.isFinite(consumedAt)) return false;
  return candidateAt <= consumedAt;
}

async function pruneConsumedRequest(pendingVisualRequestsFile, pending, consumedRequest) {
  const requests = Array.isArray(pending?.pending) ? pending.pending : [];
  const nextPending = {
    ...(pending || {}),
    pending: requests.filter((request) => !isSupersededByConsumedRequest(request, consumedRequest)),
    last_consumed_request: {
      request_id: consumedRequest?.request_id || null,
      mode: consumedRequest?.mode || null,
      consumed_at: new Date().toISOString(),
      policy: consumedRequest?.mode === "refresh_self_state"
        ? "drop_consumed_and_older_refresh_self_state_requests"
        : "drop_consumed_request_only",
    },
  };
  await writeJson(pendingVisualRequestsFile, nextPending);
  return {
    before: requests.length,
    after: nextPending.pending.length,
    removed: requests.length - nextPending.pending.length,
  };
}

function safePathSegment(value) {
  return String(value || "request")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "request";
}

function resolveAdbDevice(options, pending, request) {
  return options.device || request?.adb_device_id || pending?.adb_device_id || null;
}

function resolveAdbPath(options, pending, request) {
  return options.adb || request?.adb_path || pending?.adb_path || null;
}

function captureArgs(options, captureDir, request, pending) {
  const args = ["tools/capture-jcc-visual-frame.mjs", "--out-dir", captureDir, "--persist-frame", "--label", request.mode || "visual_request"];
  const adbDevice = resolveAdbDevice(options, pending, request);
  const adbPath = resolveAdbPath(options, pending, request);
  if (adbDevice) args.push("--device", adbDevice);
  if (adbPath) args.push("--adb", adbPath);
  if (options.connect) args.push("--connect", options.connect);
  if (options.fixtureImage) args.push("--fixture-image", options.fixtureImage);
  if (options.captureSource) args.push("--capture-source", options.captureSource);
  if (options.mumuShell) args.push("--mumu-shell", options.mumuShell);
  if (options.mumuHost) args.push("--mumu-host", options.mumuHost);
  if (options.mumuInstance) args.push("--mumu-instance", options.mumuInstance);
  return args;
}

function preferredBurstFrameOffsetMs(request) {
  const policy = request?.capture_policy || {};
  if (policy.force_new_burst === true && Number.isFinite(Number(policy.stable_capture_delay_ms))) {
    return Number(policy.stable_capture_delay_ms);
  }
  if (Number.isFinite(Number(policy.stable_capture_delay_ms))) {
    return Number(policy.stable_capture_delay_ms);
  }
  const captures = Array.isArray(request?.burst_capture?.captures) ? request.burst_capture.captures : [];
  const stableCapture = captures.find((capture) => Number(capture?.offset_ms) > 0);
  return Number.isFinite(Number(stableCapture?.offset_ms)) ? Number(stableCapture.offset_ms) : null;
}

async function findPreferredBurstFrame(request) {
  const captures = Array.isArray(request?.burst_capture?.captures) ? request.burst_capture.captures : [];
  const preferredOffset = preferredBurstFrameOffsetMs(request);
  const rankedCaptures = [...captures].sort((left, right) => {
    if (preferredOffset != null) {
      const leftDistance = Math.abs(Number(left?.offset_ms ?? 0) - preferredOffset);
      const rightDistance = Math.abs(Number(right?.offset_ms ?? 0) - preferredOffset);
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    }
    return Number(left?.offset_ms ?? 0) - Number(right?.offset_ms ?? 0);
  });
  for (const capture of rankedCaptures) {
    const frameFile = capture?.visual_frame_file ? path.resolve(capture.visual_frame_file) : null;
    if (frameFile && await fileExists(frameFile)) {
      return {
        frameFile,
        source: "watcher_s4_burst_capture",
        capture,
      };
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLatestBurstFrame(request, waitMs) {
  if (!request?.burst_capture) return null;
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  let latest = await findPreferredBurstFrame(request);
  while (!latest && Date.now() < deadline) {
    await sleep(Math.min(100, deadline - Date.now()));
    latest = await findPreferredBurstFrame(request);
  }
  return latest;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.watchDir) throw new Error(`Missing --watch-dir\n${usage()}`);
  if (!options.outDir) throw new Error(`Missing --out-dir\n${usage()}`);
  if (options.preparedRun && !options.agentResponse) {
    throw new Error("--prepared-run is only valid with --agent-response");
  }

  const watchDir = path.resolve(options.watchDir);
  const outDir = path.resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  const preparedRun = await resolvePreparedRun(options);
  if (preparedRun?.watchDir && preparedRun.watchDir !== watchDir) {
    throw new Error(`--prepared-run watch_dir mismatch: ${preparedRun.watchDir} !== ${watchDir}`);
  }
  const pendingVisualRequestsFile = path.join(watchDir, "pending-visual-requests.json");
  const pending = await readJson(pendingVisualRequestsFile);
  const request = preparedRun?.request || selectRequest(pending, options.requestIndex, options.requestId);
  const requestMode = String(request?.mode || request?.phase || "");
  if (requestMode !== "refresh_self_state") {
    if (request?.compatibility_calibration !== true || options.compatibilityCalibration !== true) {
      throw new Error(`${requestMode || "choice"} visual request is calibration-only and cannot run on the production pending-visual path`);
    }
  }
  let queue_prune = null;
  const liveStateFile = path.join(watchDir, "cruise-live-state.json");
  const captureDir = path.join(outDir, "capture");
  await mkdir(captureDir, { recursive: true });
  const burstFrame = preparedRun ? null : await waitForLatestBurstFrame(request, options.burstFrameWaitMs);
  if (!preparedRun && !burstFrame) {
    await requireOk("frame capture", await runNode(captureArgs(options, captureDir, request, pending)));
  }
  const frameFile = preparedRun?.frameFile || burstFrame?.frameFile || path.join(captureDir, "visual-frame.json");
  const observationDir = path.join(outDir, "runtime-observation", safePathSegment(request.request_id || request.mode || request.phase));
  const observationResult = path.join(observationDir, "result.json");
  const observationArgs = [
    "tools/run-jcc-multimodal-runtime-observation.mjs",
    "--frame", frameFile,
    "--live-state", liveStateFile,
    "--mode", request.mode || request.phase,
    "--out-dir", observationDir,
    "--out", observationResult,
  ];
  if (options.agentResponse) observationArgs.push("--agent-response", options.agentResponse);
  await requireOk("multimodal runtime observation", await runNode(observationArgs));
  const observation = await readJson(observationResult);
  if (!preparedRun && observation.ok === true) {
    queue_prune = await pruneConsumedRequest(pendingVisualRequestsFile, pending, request);
  }
  const rawFrameDeletedAfterResponse = await removeTransientFrameAfterResponse(frameFile, Boolean(options.agentResponse));
  const burstImagesDeletedAfterResponse = await removeBurstImagesAfterResponse(request, Boolean(options.agentResponse));
  const siblingBurstImagesDeletedAfterResponse = await removeSiblingBurstImagesAfterResponse(pending, request, Boolean(options.agentResponse));
  const report = {
    ok: observation.ok === true,
    schema: "jcc-pending-visual-request-run-result-v1",
    request,
    adb_device_id: resolveAdbDevice(options, pending, request),
    adb_path: resolveAdbPath(options, pending, request),
    watch_dir: watchDir,
    artifacts: {
      frame: frameFile,
      frame_source: preparedRun ? "prepared_run" : burstFrame?.source || "current_frame_capture",
      burst_capture: burstFrame?.capture || null,
      multimodal_result: observationResult,
      vision_request: observation.artifacts?.vision_request || null,
      visual_observations: observation.artifacts?.visual_observations || null,
      visual_live_state: observation.artifacts?.visual_live_state || null,
    },
    status: observation.status,
    next_step: observation.next_step || null,
    storage_policy: {
      transient_frame_capture: true,
      raw_frame_is_for_host_cli_visual_task_only: true,
      structured_json_only_after_response: true,
      raw_frame_deleted_after_response: rawFrameDeletedAfterResponse,
      burst_images_deleted_after_response: burstImagesDeletedAfterResponse,
      sibling_burst_images_deleted_after_response: siblingBurstImagesDeletedAfterResponse,
    },
    queue_prune,
  };
  const supersededBeforeLatestWrite = preparedRun
    ? await requestWasSuperseded(pendingVisualRequestsFile, request)
    : false;
  let staleByMatchSession = false;
  let staleByStageRound = false;
  if (observation.ok === true && observation.artifacts?.visual_live_state && request?.match_session_id) {
    const visualLiveState = await readJson(observation.artifacts.visual_live_state).catch(() => null);
    const visualMatchSessionId = liveStateMatchSessionId(visualLiveState);
    staleByMatchSession = Boolean(visualMatchSessionId && visualMatchSessionId !== request.match_session_id);
    const expectedStageRound = requestStageRound(request);
    const visualStageRound = liveStateStageRound(visualLiveState);
    staleByStageRound = Boolean(expectedStageRound && visualStageRound && expectedStageRound !== visualStageRound);
  }
  if (observation.ok === true && observation.artifacts?.visual_live_state && !supersededBeforeLatestWrite && !staleByMatchSession && !staleByStageRound) {
    await writeJson(path.join(watchDir, "latest-visual-live-state.json"), {
      schema: "jcc-runtime-latest-visual-live-state-ref-v1",
      generated_at: new Date().toISOString(),
      request,
      visual_live_state_file: observation.artifacts.visual_live_state,
      visual_observations_file: observation.artifacts?.visual_observations || null,
      status: "completed",
    });
  }
  if (supersededBeforeLatestWrite) {
    report.status = "stale_logged_only";
    report.stale_reason = "pending_visual_request_superseded_by_fast_choice_text";
    report.artifacts.visual_live_state_not_promoted = observation.artifacts.visual_live_state || null;
  }
  if (staleByMatchSession) {
    report.status = "stale_logged_only";
    report.stale_reason = "pending_visual_request_match_session_mismatch";
    report.artifacts.visual_live_state_not_promoted = observation.artifacts.visual_live_state || null;
  }
  if (staleByStageRound) {
    report.status = "stale_logged_only";
    report.stale_reason = "pending_visual_request_stage_round_mismatch";
    report.artifacts.visual_live_state_not_promoted = observation.artifacts.visual_live_state || null;
  }
  if (options.out) await writeJson(options.out, report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
