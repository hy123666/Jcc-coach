import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve("."),
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

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const root = path.resolve(".omx/runtime-evidence/pending-visual-burst-frame-verify");
  await rm(root, { recursive: true, force: true });
  const watchDir = path.join(root, "watch");
  const immediateBurstDir = path.join(root, "watch", "visual-burst", "augment-burst-test", "frame-01-0ms");
  const burstDir = path.join(root, "watch", "visual-burst", "augment-burst-test", "frame-02-1000ms");
  const siblingBurstDir = path.join(root, "watch", "visual-burst", "augment-burst-sibling", "frame-02-1000ms");
  const outDir = path.join(root, "run");
  await mkdir(watchDir, { recursive: true });
  await mkdir(immediateBurstDir, { recursive: true });
  await mkdir(burstDir, { recursive: true });
  await mkdir(siblingBurstDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const fixtureImage = path.resolve(".omx/runtime-evidence/live-acceptance-20260615-115545/visual-run-001/capture/frame.png");
  const immediateCapture = await runNode([
    "tools/capture-jcc-visual-frame.mjs",
    "--out-dir",
    immediateBurstDir,
    "--fixture-image",
    fixtureImage,
    "--persist-frame",
    "--label",
    "verify_immediate_burst_frame",
  ]);
  assert(immediateCapture.code === 0, `immediate fixture frame capture failed: ${immediateCapture.stderr || immediateCapture.stdout}`);
  const capture = await runNode([
    "tools/capture-jcc-visual-frame.mjs",
    "--out-dir",
    burstDir,
    "--fixture-image",
    fixtureImage,
    "--persist-frame",
    "--label",
    "verify_burst_frame",
  ]);
  assert(capture.code === 0, `fixture frame capture failed: ${capture.stderr || capture.stdout}`);
  const siblingCapture = await runNode([
    "tools/capture-jcc-visual-frame.mjs",
    "--out-dir",
    siblingBurstDir,
    "--fixture-image",
    fixtureImage,
    "--persist-frame",
    "--label",
    "verify_sibling_burst_frame",
  ]);
  assert(siblingCapture.code === 0, `sibling fixture frame capture failed: ${siblingCapture.stderr || siblingCapture.stdout}`);

  const liveStateFile = path.join(watchDir, "cruise-live-state.json");
  await writeJson(liveStateFile, {
    schema: "jcc-cruise-runtime-live-state-from-mumu-watch-v1",
    match_session_id: "verify-burst-frame",
    phase: { status: 4, status_name: "choice_window" },
    board: { board_units: [] },
    bench: { bench_units: [] },
    shop: { shop_units: [] },
    items: { item_bench: [], equipped_items: [] },
    augments: { current_choice_set: null, choice_candidates: [] },
  });

  const request = {
    schema: "jcc-runtime-visual-request-v1",
    request_id: "visual:verify-burst-frame:augment_choice:1",
    mode: "augment_choice",
    phase: "augment_choice",
    target: "augments.choices",
    reason: "mumu_4358_s4_choice_window",
    adb_device_id: "127.0.0.1:7555",
    capture_policy: {
      source: "watcher_s4_burst_capture",
      immediate_capture_delay_ms: 0,
      stable_capture_delay_ms: 1000,
      refresh_capture_interval_ms: 500,
      force_new_burst: false,
    },
    burst_capture: {
      schema: "jcc-augment-choice-burst-capture-v1",
      captures: [
        {
          index: 0,
          offset_ms: 0,
          capture_dir: immediateBurstDir,
          visual_frame_file: path.join(immediateBurstDir, "visual-frame.json"),
          image_file: path.join(immediateBurstDir, "frame.png"),
          status: "captured",
        },
        {
          index: 1,
          offset_ms: 1000,
          capture_dir: burstDir,
          visual_frame_file: path.join(burstDir, "visual-frame.json"),
          image_file: path.join(burstDir, "frame.png"),
          status: "captured",
        },
      ],
    },
  };
  const siblingRequest = {
    ...request,
    request_id: "visual:verify-burst-frame:augment_choice:2",
    reason: "verify_sibling_burst_cleanup",
    queued_at: "2026-01-01T00:00:01.000Z",
    burst_capture: {
      schema: "jcc-augment-choice-burst-capture-v1",
      captures: [
        {
          index: 0,
          offset_ms: 1000,
          capture_dir: siblingBurstDir,
          visual_frame_file: path.join(siblingBurstDir, "visual-frame.json"),
          image_file: path.join(siblingBurstDir, "frame.png"),
          status: "captured",
        },
      ],
    },
  };
  request.queued_at = "2026-01-01T00:00:00.000Z";
  await writeJson(path.join(watchDir, "pending-visual-requests.json"), {
    schema: "jcc-runtime-pending-visual-requests-v1",
    match_session_id: "verify-burst-frame",
    adb_device_id: "127.0.0.1:7555",
    pending: [request, siblingRequest],
    latest: siblingRequest,
  });

  const run = await runNode([
    "tools/run-jcc-pending-visual-request.mjs",
    "--watch-dir",
    watchDir,
    "--out-dir",
    outDir,
    "--request-index",
    "best",
    "--out",
    path.join(outDir, "pending-run.json"),
  ]);
  assert(run.code === 0, `pending visual request failed: ${run.stderr || run.stdout}`);
  const result = JSON.parse(await readFile(path.join(outDir, "pending-run.json"), "utf8"));
  assert(result.status === "awaiting_host_cli_agent_response", "pending visual request should stop at host CLI agent response boundary");
  assert(result.artifacts?.frame_source === "watcher_s4_burst_capture", "pending visual request must prefer watcher s=4 burst frame");
  assert(result.adb_device_id === "127.0.0.1:7555", "pending visual request runner must inherit the watcher/request ADB device");
  assert(path.resolve(result.artifacts?.frame) === path.resolve(path.join(burstDir, "visual-frame.json")), "pending visual request should prefer the 1000ms stable burst frame, not the latest frame");
  assert(result.request?.request_id === request.request_id, "best pending request should select the first same-priority augment burst");
  const responseFile = path.join(outDir, "host-agent-response.json");
  await writeJson(responseFile, {
    source: "codex_cli_agent_native",
    model: "host_cli_multimodal_model",
    confidence: 0.93,
    observations: {
      augment_choices: [
        { name: "爆炸式增长", slot: 0, confidence: 0.95 },
        { name: "挑个好伙计!", slot: 1, confidence: 0.94 },
        { name: "8级D干的传说", slot: 2, confidence: 0.93 },
      ],
    },
  });
  const completedOutDir = path.join(root, "completed-run");
  const completed = await runNode([
    "tools/run-jcc-pending-visual-request.mjs",
    "--watch-dir",
    watchDir,
    "--out-dir",
    completedOutDir,
    "--prepared-run",
    path.join(outDir, "pending-run.json"),
    "--agent-response",
    responseFile,
    "--out",
    path.join(completedOutDir, "completed-run.json"),
  ]);
  assert(completed.code === 0, `pending visual request completion failed: ${completed.stderr || completed.stdout}`);
  const completedResult = JSON.parse(await readFile(path.join(completedOutDir, "completed-run.json"), "utf8"));
  assert(completedResult.status === "completed", "pending visual request should complete after host CLI agent response");
  assert(completedResult.storage_policy?.burst_images_deleted_after_response?.attempted === 2, "current burst cleanup attempt missing");
  assert(completedResult.storage_policy?.sibling_burst_images_deleted_after_response?.attempted === 1, "sibling burst cleanup attempt missing");
  assert(completedResult.storage_policy?.sibling_burst_images_deleted_after_response?.deleted === 1, "sibling burst image should be deleted");
  await readFile(path.join(burstDir, "frame.png")).then(
    () => { throw new Error("current burst image should be deleted after host response"); },
    () => {}
  );
  await readFile(path.join(immediateBurstDir, "frame.png")).then(
    () => { throw new Error("immediate burst image should be deleted after host response"); },
    () => {}
  );
  await readFile(path.join(siblingBurstDir, "frame.png")).then(
    () => { throw new Error("sibling burst image should be deleted after host response"); },
    () => {}
  );
  console.log(JSON.stringify({
    ok: true,
    checked: [
      "pending augment visual request prefers watcher s=4 burst frame",
      "pending visual request runner inherits the watcher/request ADB device without user-supplied port",
      "pending augment visual request prefers the stable 1000ms frame over the latest burst frame",
      "initial s=4 burst fixture contains only immediate and stable frames",
      "host CLI multimodal boundary is preserved",
      "no current-frame recapture is used when burst frame exists",
      "host response cleanup deletes current and sibling augment burst images",
    ],
    frame_source: result.artifacts.frame_source,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
