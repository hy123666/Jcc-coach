import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nsisRoot = path.join(root, 'ui/node_modules/app-builder-lib/templates/nsis');
const assisted = fs.readFileSync(path.join(nsisRoot, 'assistedInstaller.nsh'), 'utf8');
const uninstaller = fs.readFileSync(path.join(nsisRoot, 'uninstaller.nsh'), 'utf8');
if (!assisted.includes('!insertmacro customUnWelcomePage') || !uninstaller.includes('!insertmacro customUnInstall')) {
  throw new Error('Installed electron-builder does not support required uninstall hooks');
}
const requiredFiles = [
  "ui/electron-builder.yml",
  "ui/installer/uninstall-user-data.nsh",
  "ui/package-lock.json",
  "ui/node_modules/minisearch/package.json",
  "ui/node_modules/minisearch/dist/es/index.js",
  "AGENTS.md",
  "CLAUDE.md",
  "tools/bin/adb.exe",
  "tools/bin/AdbWinApi.dll",
  "tools/bin/AdbWinUsbApi.dll",
  "data/runtime/jcc/windows-installer-dependencies.json",
  "data/runtime/jcc/rapidocr-ppocrv5-mobile.yaml",
  "resources/ocr/models/ppocrv5-mobile/ch_PP-OCRv5_det_mobile.onnx",
  "resources/ocr/models/ppocrv5-mobile/ch_PP-OCRv5_rec_mobile.onnx",
  "resources/ocr/models/ppocrv5-mobile/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx",
];
const requiredDirs = [
  "ui/dist",
  "ui/electron",
  "data",
  "tools",
  "resources/ocr/python",
  "resources/ocr/models/ppocrv5-mobile",
];

const requiredActiveDataFiles = [
  "data/game-knowledge/jcc/active-profile.json",
  "data/live-rankings/jcc/active-generation.json",
  "data/live-rankings/jcc/active-ranking-closure.json",
];

const missing = [];
for (const relative of requiredFiles) {
  if (!fs.existsSync(path.join(root, relative))) missing.push(relative);
}
for (const relative of requiredDirs) {
  if (!fs.existsSync(path.join(root, relative))) missing.push(`${relative}/`);
}
for (const relative of requiredActiveDataFiles) {
  if (!fs.existsSync(path.join(root, relative))) missing.push(relative);
}

function readJson(relative) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    missing.push(relative);
    return null;
  }
}

const activeProfile = readJson("data/game-knowledge/jcc/active-profile.json");
const activeRanking = readJson("data/live-rankings/jcc/active-generation.json");
const activeClosure = readJson("data/live-rankings/jcc/active-ranking-closure.json");

if (activeProfile) {
  const profileId = String(activeProfile.core_profile_id || "").trim();
  const bundlePath = String(activeProfile.bundle_path || "").trim();
  if (!profileId || !bundlePath || !fs.existsSync(path.join(root, "data/game-knowledge/jcc", bundlePath))) {
    missing.push("data/game-knowledge/jcc active Core bundle");
  }
}
if (activeRanking) {
  const generationId = String(activeRanking.generation_id || "").trim();
  if (!generationId || !fs.existsSync(path.join(root, "data/live-rankings/jcc/generations", generationId))) {
    missing.push("data/live-rankings/jcc active Ranking generation");
  }
}
if (activeClosure && activeClosure.availability === "available" && !activeClosure.ranking?.generation_id) {
  missing.push("data/live-rankings/jcc active Ranking closure target");
}

const pythonPath = path.join(root, "resources/ocr/python/python.exe");
if (fs.existsSync(pythonPath) === false) missing.push("resources/ocr/python/python.exe");

for (const relative of ["ui/electron/runtime-daemon-server.js", "ui/electron/runtime-service.js", "tools/bin/adb.exe"]) {
  if (!fs.existsSync(path.join(root, relative))) missing.push(relative);
}

if (missing.length > 0) {
  console.error("JCC Windows installer resource preflight failed.");
  console.error("Missing release resources:");
  for (const item of [...new Set(missing)]) console.error(`- ${item}`);
  console.error("Build the OCR runtime and copy the pinned PP-OCRv5 models before packaging.");
  process.exitCode = 1;
} else {
  console.log("JCC Windows installer resource preflight passed.");
}
