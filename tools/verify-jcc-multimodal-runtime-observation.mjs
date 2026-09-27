import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { runMultimodalRuntimeObservation } from "./run-jcc-multimodal-runtime-observation.mjs";

const LIVE_STATE = "tools/fixtures/jcc-self-board-s1-state.json";
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
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
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function hasRawImagePayload(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.startsWith("data:image/") || value.length > 500000;
  if (Array.isArray(value)) return value.some(hasRawImagePayload);
  if (typeof value === "object") return Object.values(value).some(hasRawImagePayload);
  return false;
}

async function writeFrameFixture(tmp) {
  const imagePath = path.join(tmp, "frame.png");
  const framePath = path.join(tmp, "visual-frame.json");
  await writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG, "base64"));
  await writeJson(framePath, {
    ok: true,
    source: "verifier_fixture",
    frame_id: "frame:multimodal-verifier",
    sha256: "multimodal-verifier",
    match_session_id: "sample-match",
    image: {
      format: "png",
      width: 1,
      height: 1,
      persisted: true,
      path: imagePath,
    },
  });
  return { framePath, imagePath };
}

function hostCliAgentResponse() {
  return {
    source: "codex_cli_agent_native",
    model: "host_cli_multimodal_model",
    confidence: 0.92,
    observations: {
      economy: {
        hp: 100,
        gold: 12,
        level: 4,
        xp: { value: 2, to_next: 10, display: "2/10" },
      },
      selected_augments: [{ id: "20475", confidence: 0.89, slot: 0 }],
      item_bench: [{ id: "3003", confidence: 0.91, slot: 0 }],
      equipped_items: [{ hero_id: 12457, items: [{ id: "2009", confidence: 0.9, slot: 0 }] }],
    },
  };
}

async function assertRuntimeOutput(resultFile, outDir, { expectComplete }) {
  const result = await readJson(resultFile);
  assert(result.schema === "jcc-multimodal-runtime-observation-result-v1", "unexpected runtime observation schema");
  assert(result.backend_policy?.primary === "host_cli_agent_native_multimodal_model", "runtime entry must use host CLI agent native multimodal model as primary");
  assert(result.backend_policy?.detached_model_service === "not_used", "runtime entry must not require a detached model service");
  assert(result.backend_policy?.text_ocr_runtime === "not_invoked_for_hard_visual_tasks", "runtime entry must not invoke text OCR for hard visual panels");
  assert(!hasRawImagePayload(result), "runtime result must not embed image bytes");
  const request = await readJson(path.join(outDir, "vision-request.json"));
  assert(request.type === "jcc_vision_model_request", "host CLI agent task should be a jcc vision request");
  assert(request.frame?.image_reference?.path, "host CLI agent task must reference the current frame path");
  assert(!hasRawImagePayload(request), "host CLI agent task must not embed image bytes");
  assert(!JSON.stringify(request).includes(`OPENAI_${"API"}_KEY`), "host CLI agent task must not mention detached model service keys");
  if (!expectComplete) return result;

  assert(result.ok === true && result.status === "completed", "runtime entry should complete with host CLI agent response");
  assert(result.artifacts?.visual_observations, "runtime result missing visual_observations artifact");
  assert(result.artifacts?.visual_live_state, "runtime result missing visual_live_state artifact");
  const observations = await readJson(result.artifacts.visual_observations);
  assert(observations.visual_observations?.metadata?.source === "vision_model", "observations should be sourced from host-agent vision_model label");
  assert(!observations.visual_observations?.board?.board_units?.length, "visual model must not write board units");
  assert(!observations.visual_observations?.bench?.bench_units?.length, "visual model must not write bench units");
  const sourceLiveState = await readJson(LIVE_STATE);
  const sourceState = sourceLiveState.live_state || sourceLiveState;
  const visualLiveState = await readJson(result.artifacts.visual_live_state);
  const visualState = visualLiveState.live_state || visualLiveState;
  assert(JSON.stringify(visualState.board?.board_units || []) === JSON.stringify(sourceState.board?.board_units || []), "top-level board_units must remain unchanged");
  assert(JSON.stringify(visualState.bench?.bench_units || []) === JSON.stringify(sourceState.bench?.bench_units || []), "top-level bench_units must remain unchanged");
  assert(visualState.visual?.items?.item_bench?.length === 1, "visual live_state should retain host-agent item candidate");
  assert(!visualState.visual?.economy?.gold, "refresh_self_state host visual must not retain HUD gold; self-state ROI OCR owns HUD economy facts");
  assert(!hasRawImagePayload(visualLiveState), "visual live_state must not embed image bytes");
  return result;
}

async function assertCruisePipelineConsumesVisualState(visualLiveStateFile, outDir) {
  const cruiseFile = path.join(outDir, "cruise-result.json");
  const adviceStateFile = path.join(outDir, "advice-state.json");
  const cruiseRun = await runNode([
    "tools/run-jcc-cruise-runtime-pipeline.mjs",
    "--live-state", visualLiveStateFile,
    "--advice-state", adviceStateFile,
    "--out", cruiseFile,
    "--retain-full-state",
    "--now", "2026-06-13T12:00:00.000Z",
  ]);
  assert(cruiseRun.code === 0, `cruise pipeline failed to consume visual live_state: ${cruiseRun.stderr || cruiseRun.stdout}`);
  const cruise = await readJson(cruiseFile);
  assert(cruise.schema === "jcc-cruise-runtime-pipeline-result-v1", "unexpected cruise pipeline schema");
  assert(cruise.standardized_live_state?.economy?.gold?.value !== 12, "cruise pipeline must not ingest host visual HUD gold during refresh_self_state");
  assert(cruise.standardized_live_state?.economy?.hp?.value !== 100, "cruise pipeline must not ingest host visual HUD hp during refresh_self_state");
  assert(cruise.standardized_live_state?.economy?.level?.value !== 4, "cruise pipeline must not ingest host visual HUD level during refresh_self_state");
  assert(cruise.standardized_live_state?.economy?.xp?.value !== 2, "cruise pipeline must not ingest host visual HUD xp during refresh_self_state");
  assert(!cruise.standardized_live_state?.items?.item_bench?.some((item) => String(item.catalog_match?.id || item.id) === "3003"), "cruise pipeline must not ingest generic host visual item_bench; left rail ROI icon source owns items.item_bench");
  assert(!hasRawImagePayload(cruise), "cruise pipeline output must not embed image bytes");
}

async function assertPendingVisualRequestRunner(tmp, fixtureImage) {
  const watchDir = path.join(tmp, "pending-watch");
  await mkdir(watchDir, { recursive: true });
  await writeJson(path.join(watchDir, "pending-visual-requests.json"), {
    schema: "jcc-runtime-pending-visual-requests-v1",
    match_session_id: "sample-match",
    pending: [
      {
        schema: "jcc-runtime-visual-request-v1",
        request_id: "visual:sample:refresh_self_state:0",
        mode: "refresh_self_state",
        phase: "economy",
        reason: "older_refresh_should_not_win_best",
        fields: ["economy.gold"],
        visual_backend: "host_cli_multimodal",
        persist_raw_frame: false,
        at: "2026-01-01T00:00:00.000Z",
      },
      {
        schema: "jcc-runtime-visual-request-v1",
        request_id: "visual:sample:refresh_self_state:1",
        mode: "refresh_self_state",
        phase: "economy",
        reason: "verify_pending_runner",
        fields: ["economy.gold", "items.item_bench"],
        visual_backend: "host_cli_multimodal",
        persist_raw_frame: false,
        at: "2026-01-01T00:00:10.000Z",
      },
      {
        schema: "jcc-runtime-visual-request-v1",
        request_id: "visual:sample:augment_choice:1",
        mode: "augment_choice",
        phase: "augment_choice",
        reason: "verify_choice_priority",
        fields: ["augments.choices"],
        visual_backend: "host_cli_multimodal",
        persist_raw_frame: false,
        at: "2026-01-01T00:00:05.000Z",
      },
    ],
  });
  await writeJson(path.join(watchDir, "cruise-live-state.json"), await readJson(LIVE_STATE));
  const responseFile = path.join(tmp, "pending-host-cli-agent-response.json");
  await writeJson(responseFile, hostCliAgentResponse());
  const outDir = path.join(tmp, "pending-runner");
  const resultFile = path.join(outDir, "pending-result.json");
  const result = await runNode([
    "tools/run-jcc-pending-visual-request.mjs",
    "--watch-dir", watchDir,
    "--out-dir", outDir,
    "--agent-response", responseFile,
    "--out", resultFile,
    "--fixture-image", fixtureImage,
  ]);
  assert(result.code === 0, `pending visual request runner failed: ${result.stderr || result.stdout}`);
  const pendingResult = await readJson(resultFile);
  assert(pendingResult.ok === true && pendingResult.status === "completed", "pending runner should complete with host CLI response");
  assert(pendingResult.request?.mode === "augment_choice", "pending runner default must prioritize choice-mode requests over latest refresh_self_state");
  assert(pendingResult.artifacts?.vision_request, "pending runner must expose host CLI vision request");
  assert(pendingResult.artifacts?.visual_live_state, "pending runner must expose visual live_state");
  assert(pendingResult.storage_policy?.raw_frame_deleted_after_response === true, "pending runner must delete transient frame after host CLI response");
  assert(!(await exists(path.join(outDir, "capture", "frame.png"))), "pending runner must not leave a frame PNG after host CLI response");
  const latestVisualRef = await readJson(path.join(watchDir, "latest-visual-live-state.json"));
  assert(latestVisualRef.request?.mode === "augment_choice", "pending runner should publish latest visual live_state reference with chosen request metadata");
  assert(latestVisualRef.visual_live_state_file, "pending runner latest visual state ref missing visual_live_state_file");

  const preparedWatchDir = path.join(tmp, "prepared-pending-watch");
  await mkdir(preparedWatchDir, { recursive: true });
  await writeJson(path.join(preparedWatchDir, "pending-visual-requests.json"), {
    schema: "jcc-runtime-pending-visual-requests-v1",
    match_session_id: "prepared-match",
    pending: [
      {
        schema: "jcc-runtime-visual-request-v1",
        request_id: "visual:prepared:augment_choice:1",
        mode: "augment_choice",
        phase: "augment_choice",
        reason: "verify_prepared_run_capture_lock",
        fields: ["augments.choices"],
        visual_backend: "host_cli_multimodal",
        persist_raw_frame: false,
        at: "2026-01-01T00:00:05.000Z",
      },
    ],
  });
  await writeJson(path.join(preparedWatchDir, "cruise-live-state.json"), await readJson(LIVE_STATE));
  const preparedOutDir = path.join(tmp, "prepared-runner");
  const preparedRunFile = path.join(preparedOutDir, "prepared-run.json");
  const preparedInitial = await runNode([
    "tools/run-jcc-pending-visual-request.mjs",
    "--watch-dir", preparedWatchDir,
    "--out-dir", preparedOutDir,
    "--request-index", "latest",
    "--out", preparedRunFile,
    "--fixture-image", fixtureImage,
  ]);
  assert(preparedInitial.code === 0, `prepared initial pending visual run failed: ${preparedInitial.stderr || preparedInitial.stdout}`);
  const preparedInitialResult = await readJson(preparedRunFile);
  assert(preparedInitialResult.status === "awaiting_host_cli_agent_response", "prepared initial run should wait for host response");
  const preparedFrameFile = preparedInitialResult.artifacts?.frame;
  const preparedFrame = await readJson(preparedFrameFile);
  const preparedResponseFile = path.join(tmp, "prepared-host-cli-agent-response.json");
  await writeJson(preparedResponseFile, hostCliAgentResponse());
  const preparedFinalDir = path.join(tmp, "prepared-final");
  const preparedFinalFile = path.join(preparedFinalDir, "prepared-final.json");
  const preparedFinal = await runNode([
    "tools/run-jcc-pending-visual-request.mjs",
    "--watch-dir", preparedWatchDir,
    "--out-dir", preparedFinalDir,
    "--prepared-run", preparedRunFile,
    "--agent-response", preparedResponseFile,
    "--out", preparedFinalFile,
  ]);
  assert(preparedFinal.code === 0, `prepared final pending visual run failed: ${preparedFinal.stderr || preparedFinal.stdout}`);
  const preparedFinalResult = await readJson(preparedFinalFile);
  assert(preparedFinalResult.ok === true && preparedFinalResult.status === "completed", "prepared final run should complete");
  assert(path.resolve(preparedFinalResult.artifacts.frame) === path.resolve(preparedFrameFile), "prepared final run must reuse the original visual-frame.json");
  assert(!(await exists(path.join(preparedFinalDir, "capture", "visual-frame.json"))), "prepared final run must not create a new capture directory/frame");
  const preparedVisualState = await readJson(preparedFinalResult.artifacts.visual_live_state);
  const preparedState = preparedVisualState.live_state || preparedVisualState;
  assert(preparedState.visual?.frame_id === preparedFrame.frame_id, "prepared visual live_state should reference the original frame id");
  assert(preparedState.metadata?.source_health?.visual?.frame_id === preparedFrame.frame_id, "prepared source health should reference the original frame id");
}

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), "jcc-host-cli-multimodal-runtime-"));
  try {
    const { framePath, imagePath } = await writeFrameFixture(tmp);
    const taskDir = path.join(tmp, "host-task");
    const taskResultFile = path.join(taskDir, "result.json");
    const taskRun = await runNode([
      "tools/run-jcc-multimodal-runtime-observation.mjs",
      "--frame", framePath,
      "--live-state", LIVE_STATE,
      "--mode", "refresh_self_state",
      "--out-dir", taskDir,
      "--out", taskResultFile,
    ]);
    assert(taskRun.code === 0, `host task generation failed: ${taskRun.stderr || taskRun.stdout}`);
    const taskResult = await assertRuntimeOutput(taskResultFile, taskDir, { expectComplete: false });
    assert(taskResult.status === "awaiting_host_cli_agent_response", "without agent response, runtime should wait for host CLI agent JSON");

    const responseFile = path.join(tmp, "host-cli-agent-response.json");
    await writeJson(responseFile, hostCliAgentResponse());

    const completeDir = path.join(tmp, "complete-cli");
    const completeResultFile = path.join(completeDir, "result.json");
    const completeRun = await runNode([
      "tools/run-jcc-multimodal-runtime-observation.mjs",
      "--frame", framePath,
      "--live-state", LIVE_STATE,
      "--mode", "refresh_self_state",
      "--out-dir", completeDir,
      "--agent-response", responseFile,
      "--out", completeResultFile,
    ]);
    assert(completeRun.code === 0, `host agent response ingestion failed: ${completeRun.stderr || completeRun.stdout}`);
    const completeResult = await assertRuntimeOutput(completeResultFile, completeDir, { expectComplete: true });
    await assertCruisePipelineConsumesVisualState(completeResult.artifacts.visual_live_state, completeDir);

    const directDir = path.join(tmp, "direct-function");
    const directResultFile = path.join(directDir, "result.json");
    const directResult = await runMultimodalRuntimeObservation({
      frame: framePath,
      liveState: LIVE_STATE,
      mode: "refresh_self_state",
      outDir: directDir,
      agentResponse: responseFile,
      out: directResultFile,
    });
    assert(directResult.ok === true && directResult.status === "completed", "imported backend function should complete with host CLI agent response");
    await assertRuntimeOutput(directResultFile, directDir, { expectComplete: true });
    await assertCruisePipelineConsumesVisualState(directResult.artifacts.visual_live_state, directDir);
    await assertPendingVisualRequestRunner(tmp, imagePath);

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "unified runtime entry generates a host CLI agent visual task package",
        "no detached model service key or separate model service is required",
        "host CLI agent JSON response is converted to visual_observations and visual live_state",
        "imported backend function path works without spawning the wrapper CLI",
        "visual live_state is accepted by cruise runtime pipeline",
        "text OCR for hard visual panels and live icon matcher are not invoked by this product entry",
        "visual model output cannot overwrite top-level board_units or bench_units",
        "no structured artifact retains raw image bytes",
        "pending watcher visual request shape is compatible with host CLI multimodal runtime observation",
      ],
    }, null, 2));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
