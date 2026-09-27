import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CATALOG = "data/runtime/jcc/mumu-catalog-overlay.json";
const DEFAULT_ICON_MANIFEST = "data/runtime/jcc/visual-icons/manifest.json";

function usage() {
  return [
    "Usage:",
    "  node tools/run-jcc-multimodal-runtime-observation.mjs --frame <visual-frame.json> --live-state <state.json> --mode <mode> --out-dir <dir> [--agent-response <agent-response.json>] [--out <result.json>]",
    "",
    "Runs the product multimodal visual path:",
    "  current frame + live_state + catalog references",
    "  -> host CLI agent native multimodal task package",
    "  -> host CLI agent JSON response",
    "  -> visual_observations",
    "  -> visual live_state candidate apply",
    "",
    "This entry does not call a detached model service, text OCR for hard visual panels, or live icon matching.",
    "The host CLI agent (Codex/Claude/Kimi/etc.) supplies --agent-response after using its native multimodal capability.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { catalog: DEFAULT_CATALOG, iconManifest: DEFAULT_ICON_MANIFEST };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--frame") options.frame = argv[++index];
    else if (arg === "--live-state") options.liveState = argv[++index];
    else if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--catalog") options.catalog = argv[++index];
    else if (arg === "--icon-manifest") options.iconManifest = argv[++index];
    else if (arg === "--agent-response") options.agentResponse = argv[++index];
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function runNode(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(options.env || {}) },
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

function hasRawImagePayload(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.startsWith("data:image/") || value.length > 500000;
  if (Array.isArray(value)) return value.some(hasRawImagePayload);
  if (typeof value === "object") {
    return Object.entries(value).some(([key, child]) => {
      if (/^(image_bytes|bytes_b64|base64|b64|data_url)$/i.test(key)) return true;
      return hasRawImagePayload(child);
    });
  }
  return false;
}

async function runStep(label, args, env = {}) {
  const result = await runNode(args, { env });
  if (result.code !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

async function runMultimodalRuntimeObservation(options) {
  if (!options.frame) throw new Error(`Missing --frame\n${usage()}`);
  if (!options.liveState) throw new Error(`Missing --live-state\n${usage()}`);
  if (!options.mode) throw new Error(`Missing --mode\n${usage()}`);
  if (!options.outDir) throw new Error(`Missing --out-dir\n${usage()}`);

  const catalog = options.catalog || DEFAULT_CATALOG;
  const iconManifest = options.iconManifest || DEFAULT_ICON_MANIFEST;
  const stepEnv = options.env || {};
  const outDir = path.resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  const requestFile = path.join(outDir, "vision-request.json");
  const visionResponseFile = path.join(outDir, "vision-response.json");
  const observationsFile = path.join(outDir, "visual-observations.json");
  const visualLiveStateFile = path.join(outDir, "visual-live-state.json");

  await runStep("vision request generation", [
    "tools/run-jcc-vision-model-observation.mjs",
    "--frame", options.frame,
    "--live-state", options.liveState,
    "--catalog", catalog,
    "--icon-manifest", iconManifest,
    "--mode", options.mode,
    "--emit-request",
    "--out", requestFile,
  ], stepEnv);
  const request = await readJson(requestFile);
  if (hasRawImagePayload(request)) throw new Error("vision request must not embed raw image bytes");

  const baseResult = {
    ok: false,
    schema: "jcc-multimodal-runtime-observation-result-v1",
    mode: options.mode,
    status: "awaiting_host_cli_agent_response",
    source: "host_cli_agent_native_multimodal",
    storage_policy: "structured_json_only_no_raw_frame_retention",
    artifacts: {
      vision_request: requestFile,
      host_cli_agent_task: requestFile,
      vision_response: null,
      visual_observations: null,
      visual_live_state: null,
    },
    backend_policy: {
      primary: "host_cli_agent_native_multimodal_model",
      model_host: "codex_cli_or_compatible_cli_agent",
      detached_model_service: "not_used",
      text_ocr_runtime: "not_invoked_for_hard_visual_tasks",
      icon_assets: "reference_data_only",
    },
  };

  if (!options.agentResponse) {
    const output = {
      ...baseResult,
      ok: false,
      reason: options.dryRun
        ? "host CLI agent task package generated"
        : "waiting for host CLI agent native multimodal JSON response",
      next_step: "Host CLI agent should inspect artifacts.vision_request.frame.image_reference.path and write JSON matching expected_response_shape, then rerun with --agent-response <json>.",
    };
    if (options.out) await writeJson(options.out, output);
    return output;
  }

  const hostAgentResponse = await readJson(options.agentResponse);
  if (hasRawImagePayload(hostAgentResponse)) throw new Error("host CLI agent response must not retain raw image bytes");
  await writeJson(visionResponseFile, hostAgentResponse);
  await runStep("vision response normalization", [
    "tools/run-jcc-vision-model-observation.mjs",
    "--frame", options.frame,
    "--live-state", options.liveState,
    "--catalog", catalog,
    "--icon-manifest", iconManifest,
    "--vision-response", visionResponseFile,
    "--mode", options.mode,
    "--out", observationsFile,
  ], stepEnv);
  const observations = await readJson(observationsFile);
  if (hasRawImagePayload(observations)) throw new Error("visual observations must not retain raw image bytes");

  await runStep("visual live_state merge", [
    "tools/build-jcc-visual-live-state.mjs",
    "--live-state", options.liveState,
    "--visual-observations", observationsFile,
    "--out", visualLiveStateFile,
  ], stepEnv);
  const visualLiveState = await readJson(visualLiveStateFile);
  if (hasRawImagePayload(visualLiveState)) throw new Error("visual live_state must not retain raw image bytes");

  const output = {
    ...baseResult,
    ok: true,
    status: "completed",
    artifacts: {
      ...baseResult.artifacts,
      vision_response: visionResponseFile,
      visual_observations: observationsFile,
      visual_live_state: visualLiveStateFile,
    },
    summary: {
      observations_source: observations.visual_observations?.metadata?.source || null,
      selected_augments_count: observations.visual_observations?.augments?.selected_augments?.length || 0,
      item_bench_count: observations.visual_observations?.items?.item_bench?.length || 0,
      equipped_items_count: observations.visual_observations?.items?.equipped_items?.length || 0,
      non_self_diagnostic_selected_augments_count: observations.visual_observations?.diagnostics?.non_self_current_view?.selected_augments?.length || 0,
      non_self_diagnostic_item_bench_count: observations.visual_observations?.diagnostics?.non_self_current_view?.item_bench?.length || 0,
      non_self_diagnostic_equipped_items_count: observations.visual_observations?.diagnostics?.non_self_current_view?.equipped_items?.length || 0,
    },
  };
  if (options.out) await writeJson(options.out, output);
  return output;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const output = await runMultimodalRuntimeObservation(options);
  if (!options.out) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

export { runMultimodalRuntimeObservation };
