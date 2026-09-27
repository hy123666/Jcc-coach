#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const FRAME = "data/runtime/jcc/calibration-samples/self-board-s1-visual-20260613-130615/capture/visual-frame.json";
const LIVE_STATE = "tools/fixtures/jcc-self-board-s1-state.json";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function includesText(value, text) {
  return JSON.stringify(value).includes(text);
}

async function buildRequest(mode, out) {
  const result = await runNode([
    "tools/run-jcc-vision-model-observation.mjs",
    "--frame", FRAME,
    "--live-state", LIVE_STATE,
    "--mode", mode,
    "--emit-request",
    "--out", out,
  ]);
  assert(result.code === 0, `${mode} request build failed: ${result.stderr || result.stdout}`);
  return JSON.parse(await readFile(out, "utf8"));
}

function assertGroundedRequest(request, mode) {
  assert(request.type === "jcc_vision_model_request", `${mode} request type mismatch`);
  assert(request.mode === mode, `${mode} mode mismatch`);
  assert(request.context?.inspection_targets?.length > 0, `${mode} missing inspection targets`);
  assert(request.context?.response_constraints?.no_invention === true, `${mode} missing no-invention constraint`);
  assert(request.context?.response_constraints?.unresolved_policy?.includes("possible_ids"), `${mode} missing possible_ids policy`);
  assert(request.context?.live_context?.current_view_units?.length > 0, `${mode} missing 4353 unit anchors`);
  assert(request.context.live_context.current_view_units.some((unit) => unit.screen_position?.x != null), `${mode} unit anchors lack screen positions`);
  assert(request.context?.candidate_database?.vision_reference_pack?.candidates, `${mode} missing mode-scoped candidate library`);
  assert(request.context?.candidate_database?.vision_reference_pack?.visual_groups?.length > 0, `${mode} missing same-icon visual groups`);
  assert(request.expected_response_shape?.observations?.equipped_items, `${mode} missing equipped-item JSON schema`);
  assert(includesText(request.instructions, "candidate_database"), `${mode} instructions should mention candidate database`);
  assert(includesText(request.instructions, "HP bars"), `${mode} instructions should mention HP-bar equipment grounding`);
  assert(!includesText(request, "data:image/"), `${mode} request must not embed image bytes`);
}

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), "jcc-vision-grounding-"));
  try {
    const refresh = await buildRequest("refresh_self_state", path.join(tmp, "refresh.json"));
    const augment = await buildRequest("augment_choice", path.join(tmp, "augment.json"));

    assertGroundedRequest(refresh, "refresh_self_state");
    assert(augment.context.inspection_targets.includes("augments.choices"), "augment mode should inspect current choices");
    assert((augment.context.candidate_database.vision_reference_pack.candidates.augment || []).length > 20, "augment mode should carry augment candidates");
    assert((augment.context.candidate_database.vision_reference_pack.candidates.item || []).length === 0, "augment mode should not carry item candidates");
    assert(
      augment.instructions.some((line) => line.includes("current three visible cards only")),
      "augment mode should forbid mixing history with current card set",
    );
    const removedOpponent = await runNode([
      "tools/run-jcc-vision-model-observation.mjs",
      "--frame", FRAME,
      "--live-state", LIVE_STATE,
      "--mode", "opponent_power",
      "--emit-request",
      "--out", path.join(tmp, "opponent.json"),
    ]);
    assert(removedOpponent.code !== 0, "removed opponent_power mode must not emit a vision request");
    assert(/Unsupported --mode opponent_power/.test(removedOpponent.stderr || removedOpponent.stdout), "removed opponent mode should fail explicitly");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "host multimodal requests include mode-specific inspection targets",
        "requests include enriched MuMu 4353 unit anchors with screen positions",
        "requests include candidate libraries and same-icon visual groups",
        "requests include no-invention and possible_ids ambiguity constraints",
        "requests include strict expected JSON response shape",
        "augment mode is constrained to the current visible three-card set",
        "removed opponent_power mode cannot create host visual requests",
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
