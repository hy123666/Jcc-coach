import { readFile } from "node:fs/promises";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const service = await readFile("ui/electron/runtime-service.js", "utf8");
  assert(
    service.includes('captureSource: options.captureSource || process.env.JCC_SELF_STATE_ROI_CAPTURE_SOURCE || "auto"'),
    "self-state ROI OCR runtime path must use ADB-first auto capture and reserve MuMuShell for deterministic fallback.",
  );
  assert(
    service.includes('if (selfStateRoiOcrOptions.captureSource) args.push("--capture-source", selfStateRoiOcrOptions.captureSource);'),
    "self-state ROI OCR fallback CLI path must pass the fixed capture source.",
  );
  const selfStateRoiOcrTool = await readFile("tools/run-jcc-self-state-roi-ocr.mjs", "utf8");
  assert(
    selfStateRoiOcrTool.includes('else if (arg === "--capture-source") options.captureSource = argv[++index];'),
    "self-state ROI OCR tool must accept --capture-source.",
  );
  assert(
    selfStateRoiOcrTool.includes('if (options.captureSource) args.push("--capture-source", options.captureSource);'),
    "self-state ROI OCR tool must forward --capture-source into capture-jcc-visual-frame.",
  );
  console.log(JSON.stringify({
    ok: true,
    checked: [
      "self_state_roi_runtime_default_adb_first_auto_capture",
      "self_state_roi_runtime_fallback_forwards_capture_source",
      "self_state_roi_ocr_tool_accepts_capture_source",
      "self_state_roi_ocr_tool_forwards_capture_source",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
