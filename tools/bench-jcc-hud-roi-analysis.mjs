import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runHostAgentRequest } from "../ui/electron/host-adapters.js";

const FRAME = ".jcc-runtime-data/runtime-evidence/roi-markup/capture-current/frame.png";
const HUD_SHEET = ".jcc-runtime-data/runtime-evidence/roi-markup/capture-current/hud-multifield-bench/hud-roi-sheet.png";
const SELF_STATE_ROI_OCR_RESULT = ".jcc-runtime-data/runtime-evidence/roi-markup/capture-current/hud-ocr-test-2/result.json";
const OUT_DIR = ".jcc-runtime-data/runtime-evidence/roi-markup/capture-current/hud-analysis-bench";

function parseArgs(argv) {
  const options = { kimiCommand: "kimi" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--kimi-command") options.kimiCommand = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function callKimi({ prompt, imagePaths = [], kimiCommand, label }) {
  const started = performance.now();
  const result = await runHostAgentRequest({
    provider: "kimi",
    available: true,
    command: kimiCommand,
    build_args: ["acp"],
    selected_model: null,
  }, prompt, {
    parseJson: true,
    imagePaths: imagePaths.map((item) => path.resolve(item)),
    timeoutMs: 90000,
    hostCwd: path.resolve(".jcc-runtime-data/runtime-evidence/roi-markup/capture-current/kimi-host-cwd"),
    repoRoot: process.cwd(),
    reasoning_effort: "low",
  });
  return {
    label,
    ok: result.ok === true,
    elapsed_ms: Math.round(performance.now() - started),
    response: result.response ?? null,
    text: typeof result.text === "string" ? result.text.slice(0, 800) : null,
    error: result.ok ? null : result.error,
    completed_from: result.completed_from || null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(OUT_DIR, { recursive: true });
  const selfStateRoiOcr = JSON.parse(await readFile(SELF_STATE_ROI_OCR_RESULT, "utf8"));
  const compactHudJson = {
    phase: selfStateRoiOcr.phase,
    economy: selfStateRoiOcr.economy,
    roi_texts: (selfStateRoiOcr.roi_results || []).map((row) => ({
      id: row.roi_id,
      kind: row.kind,
      text: row.text,
      confidence: row.confidence,
    })),
  };
  const jsonPrompt = [
    "你是金铲铲 JCC Runtime 的底层分析模型。",
    "下面是机械 OCR 从 HUD ROI 读出的结构化 JSON。请只基于这些字段输出严格 JSON：",
    "{\"stage_round\":string|null,\"gold\":number|null,\"hp\":number|null,\"level\":number|null,\"xp\":object|null,\"missing_fields\":string[],\"usable_for_strategy\":boolean}",
    JSON.stringify(compactHudJson),
  ].join("\n");
  const visionPrompt = [
    "图片是由多个 HUD ROI 拼成的表，每块左上角有标签：stage、gold、level、xp、hp。",
    "请读取这些字段并输出严格 JSON：",
    "{\"stage_round\":string|null,\"gold\":number|null,\"hp\":number|null,\"level\":number|null,\"xp\":object|null,\"missing_fields\":string[],\"visible_text\":string,\"confidence\":\"high|medium|low\"}",
    "看不清的字段填 null，并列入 missing_fields。不要解释。",
  ].join("\n");
  const fullPrompt = [
    "请从整张金铲铲截图读取 HUD 字段：阶段、金币、血量、等级、XP。",
    "输出严格 JSON：{\"stage_round\":string|null,\"gold\":number|null,\"hp\":number|null,\"level\":number|null,\"xp\":object|null,\"missing_fields\":string[],\"visible_text\":string,\"confidence\":\"high|medium|low\"}",
    "不要解释。",
  ].join("\n");

  const report = {
    measured_at: new Date().toISOString(),
    ocr_json_to_kimi_text: await callKimi({ prompt: jsonPrompt, kimiCommand: options.kimiCommand, label: "ocr_json_to_kimi_text" }),
    kimi_hud_roi_sheet_vision: await callKimi({ prompt: visionPrompt, imagePaths: [HUD_SHEET], kimiCommand: options.kimiCommand, label: "kimi_hud_roi_sheet_vision" }),
    kimi_full_screenshot_vision: await callKimi({ prompt: fullPrompt, imagePaths: [FRAME], kimiCommand: options.kimiCommand, label: "kimi_full_screenshot_vision" }),
  };
  await writeFile(path.join(OUT_DIR, "bench-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
