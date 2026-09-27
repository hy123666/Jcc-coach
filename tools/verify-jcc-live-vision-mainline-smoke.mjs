import { access, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_SMOKE_DIR = ".omx/runtime-evidence/vision-mainline-live-smoke";

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-live-vision-mainline-smoke.mjs [--dir <vision-mainline-live-smoke-dir>]",
    "",
    "Verifies the live MuMu visual path without any detached model service:",
    "  real frame/task package -> host CLI agent JSON -> visual_observations -> runtime live_state.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { dir: DEFAULT_SMOKE_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dir") options.dir = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  if (!value || typeof value !== "object") return false;
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (/^(image_bytes|bytes_b64|base64|b64|data_url)$/i.test(key)) return true;
      if (typeof child === "string" && /^data:image\//i.test(child)) return true;
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return false;
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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

function assertNoProviderResidue(value, label) {
  const text = JSON.stringify(value);
  for (const forbidden of [
    `run-jcc-${"main-model"}-vision-adapter`,
    `JCC_MAIN_MODEL_${"API"}_KEY`,
    `OPENAI_${"API"}_KEY`,
    `/v1/${"responses"}`,
    `OpenAI-${"compatible"}`,
    `mock ${"provider"}`,
    "data:image/",
  ]) {
    assert(!text.includes(forbidden), `${label} contains detached-provider residue: ${forbidden}`);
  }
}

function assertNoRetainedImageArtifacts(value, label) {
  const text = JSON.stringify(value);
  assert(!text.includes("icon-matches.json"), `${label} must not reference retained matcher artifacts`);
}

function assertVisionRequest(request, mode) {
  assert(request.type === "jcc_vision_model_request", `${mode} request type mismatch`);
  assert(request.mode === mode, `${mode} request mode mismatch`);
  assert(request.frame?.image_reference?.path, `${mode} request missing frame image reference`);
  assert(!hasRawImagePayload(request), `${mode} request must not embed raw image bytes`);
  assert(request.context?.candidate_database?.vision_reference_pack?.not_a_matcher === true, `${mode} request reference pack must be marked not_a_matcher`);
  assert(request.context?.candidate_database?.icon_assets?.role === "reference_assets_for_multimodal_agent_not_live_template_matching", `${mode} icon assets must be reference-only`);
  assert(Array.isArray(request.context?.mumu_current_view_units), `${mode} request missing MuMu current_view unit context`);
  assertNoProviderResidue(request, `${mode} request`);
  assertNoRetainedImageArtifacts(request, `${mode} request`);
}

function hostCliAgentResponse() {
  return {
    source: "host_cli_agent_native",
    model: "codex_cli_or_compatible_multimodal_agent",
    confidence: 0.9,
    observations: {
      selected_augments: [{ id: "20475", confidence: 0.84, slot: 0 }],
      item_bench: [{ id: "3003", confidence: 0.9, slot: 0 }],
      equipped_items: [
        {
          hero_id: null,
          hero_name: null,
          items: [{ id: "2009", confidence: 0.86, slot: 0 }],
        },
      ],
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const dir = path.resolve(options.dir);
  const frameFile = path.join(dir, "visual-frame.json");
  const framePng = path.join(dir, "frame.png");
  const summaryFile = path.join(dir, "mumu-watch", "summary.json");
  const liveStateFile = path.join(dir, "mumu-watch", "state.json");
  const refreshRequestFile = path.join(dir, "refresh-self-vision-request.json");

  const [frame, summary, refreshRequest] = await Promise.all([
    readJson(frameFile),
    readJson(summaryFile),
    readJson(refreshRequestFile),
  ]);

  assert(frame.source === "mumu_nemushell_screencap", "smoke frame must come from MuMu screencap");
  assert(frame.sha256 && frame.bytes > 0, "live smoke should preserve frame hash/size metadata after transient image deletion");
  if (frame.image?.persisted === true) {
    assert(frame.image?.path || await exists(framePng), "persisted debug smoke frames should keep an inspectable image path");
  }
  assert((summary.current_view_count || 0) > 0, "MuMu current_view units missing from live smoke");
  if ((summary.shop_count || 0) > 0) {
    assert(summary.local_board_promotion_status === "candidate_promoted_by_shop_self_view_anchor", "visible shop self-view anchor promotion evidence missing");
  } else {
    assert(summary.local_board_promotion_status !== "candidate_promoted_by_shop_self_view_anchor", "smoke without visible shop must not promote local board");
  }

  assertVisionRequest(refreshRequest, "refresh_self_state");
  assert((await stat(refreshRequestFile)).size < 2_000_000, "refresh request unexpectedly large; check for embedded image payload");

  const responseFile = path.join(dir, "host-cli-agent-response-fixture.json");
  const resultFile = path.join(dir, "host-cli-runtime-result.json");
  const runtimeDir = path.join(dir, "host-cli-runtime");
  await writeJson(responseFile, hostCliAgentResponse());
  const runtimeRun = await runNode([
    "tools/run-jcc-multimodal-runtime-observation.mjs",
    "--frame", frameFile,
    "--live-state", liveStateFile,
    "--mode", "refresh_self_state",
    "--out-dir", runtimeDir,
    "--agent-response", responseFile,
    "--out", resultFile,
  ]);
  assert(runtimeRun.code === 0, `host CLI runtime observation failed: ${runtimeRun.stderr || runtimeRun.stdout}`);
  const result = await readJson(resultFile);
  assert(result.ok === true && result.status === "completed", "host CLI runtime observation did not complete");
  assert(result.backend_policy?.detached_model_service === "not_used", "runtime must not use a detached model service");
  assertNoProviderResidue(result, "runtime result");
  assertNoRetainedImageArtifacts(result, "runtime result");

  const visualLiveState = await readJson(result.artifacts.visual_live_state);
  const sourceLiveState = await readJson(liveStateFile);
  const visualState = visualLiveState.live_state || visualLiveState;
  const sourceState = sourceLiveState.live_state || sourceLiveState;
  assert(JSON.stringify(visualState.board?.board_units || []) === JSON.stringify(sourceState.board?.board_units || []), "visual flow must not overwrite top-level board_units");
  assert(JSON.stringify(visualState.bench?.bench_units || []) === JSON.stringify(sourceState.bench?.bench_units || []), "visual flow must not overwrite top-level bench_units");
  assert(visualState.visual?.metadata?.source === "vision_model", "visual live_state source mismatch");
  assert(visualState.visual?.items?.item_bench?.length === 1, "visual live_state missing item candidate");
  assert(!hasRawImagePayload(visualLiveState), "visual live_state must not retain embedded image payload");

  await rm(path.join(dir, "mumu-watch", "events.jsonl"), { force: true });
  await rm(framePng, { force: true });
  frame.image = {
    ...(frame.image || {}),
    persisted: false,
    path: null,
  };
  frame.storage_policy = {
    ...(frame.storage_policy || {}),
    transient_frame_deleted_after_visual_smoke: true,
  };
  await writeJson(frameFile, frame);
  assert(!(await exists(framePng)), "raw smoke PNG must not remain on disk");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "real MuMu frame captured through repo-local ADB/NemuShell",
      "host CLI agent visual task packages are valid",
      "no detached model service, service key, responses call, or provider mock is used",
      "host CLI agent JSON response converts to visual_observations and visual live_state",
      "visual observations merge into runtime state without overwriting MuMu board/bench facts",
      "requests carry icon/catalog assets as references only, not live matcher truth",
      "requests and outputs do not embed raw image bytes or retained matcher artifacts",
      "raw smoke PNG deleted after host-agent task/response flow",
    ],
    summary: {
      phase_status_code: summary.phase_status_code,
      phase_name: summary.phase_name,
      current_view_count: summary.current_view_count,
      local_board_promotion_status: summary.local_board_promotion_status,
      shop_count: summary.shop_count,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
