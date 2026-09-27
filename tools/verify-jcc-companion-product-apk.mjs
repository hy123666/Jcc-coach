#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readdirSync } from "node:fs";

const repoRoot = resolve(import.meta.dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function read(path) {
  return readFile(join(repoRoot, path), "utf8");
}

function listFilesRecursive(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

async function main() {
  const manifest = await read("android-companion/app/src/main/AndroidManifest.xml");
  const service = await read("android-companion/app/src/main/java/ai/codex/jcccompanion/CaptureService.java");
  const mainActivity = await read("android-companion/app/src/main/java/ai/codex/jcccompanion/MainActivity.java");
  const foregroundGuard = await read("android-companion/app/src/main/java/ai/codex/jcccompanion/ForegroundAppGuard.java");
  const runtimeMessage = await read("android-companion/app/src/main/java/ai/codex/jcccompanion/RuntimeMessage.java");
  const analyzer = await read("android-companion/app/src/main/java/ai/codex/jcccompanion/FrameAnalyzer.java");
  const ocrAnalyzer = await read("android-companion/app/src/main/java/ai/codex/jcccompanion/OcrAnalyzer.java");
  const nativeBridge = await read("android-companion/app/src/main/java/ai/codex/jcccompanion/NativeOcrBridge.java");
  const cmake = await read("android-companion/app/src/main/cpp/CMakeLists.txt");
  const nativeCpp = await read("android-companion/app/src/main/cpp/jcc_ocr.cpp");
  const championCatalog = await read("android-companion/app/src/main/java/ai/codex/jcccompanion/ChampionCatalog.java");
  const championMatcher = await read("android-companion/app/src/main/java/ai/codex/jcccompanion/ChampionTemplateMatcher.java");
  const roiLayout = await read("android-companion/app/src/main/java/ai/codex/jcccompanion/RoiLayout.java");
  const catalogPath = "android-companion/app/src/main/assets/jcc_catalog.json";
  const roiPath = "android-companion/app/src/main/assets/jcc_roi_layout.json";
  const rapidOcrContractPath = "data/runtime/jcc/mumu-recognition-contract.json";

  assert(/FOREGROUND_SERVICE_MEDIA_PROJECTION/.test(manifest), "manifest missing media projection foreground permission");
  assert(/PACKAGE_USAGE_STATS/.test(manifest), "manifest missing usage-stats permission for game-exit detection");
  assert(/foregroundServiceType="mediaProjection"/.test(manifest), "service must declare mediaProjection foreground type");
  assert(/ImageReader/.test(service) && /createVirtualDisplay/.test(service), "service must use ImageReader virtual display capture");
  assert(/ForegroundAppGuard/.test(service) && /target_game_left_foreground/.test(service), "capture service must stop when the target game leaves foreground after grace period");
  assert(/UsageStatsManager/.test(foregroundGuard) && /MOVE_TO_FOREGROUND/.test(foregroundGuard), "foreground guard must use UsageStats foreground events");
  assert(/ACTION_USAGE_ACCESS_SETTINGS/.test(mainActivity) && /Grant Game Exit Detection/.test(mainActivity), "main UI must expose usage-access grant path for exit detection");
  assert(/capture_stopped/.test(runtimeMessage), "runtime messages must include capture_stopped");
  assert(/roi_observations/.test(runtimeMessage), "runtime messages must include roi_observations");
  assert(/ocr_text_blocks/.test(runtimeMessage), "runtime messages must include ocr_text_blocks");
  assert(/candidate_only/.test(runtimeMessage + analyzer), "semantic observations must remain candidate-only");
  assert(!/frame_base64|png_base64|jpeg_base64|raw_rgba_base64/.test(service + runtimeMessage + analyzer + ocrAnalyzer), "APK source must not emit base64 frame payloads");
  assert(!/openFileOutput|getExternalFilesDir|MediaStore/.test(service + analyzer + ocrAnalyzer), "capture/analyzer source must not persist screenshots");
  assert(/jcc_mlkit_chinese_text_recognition/.test(ocrAnalyzer), "OCR analyzer must use the JCC product OCR engine name");
  assert(/product_default_multi_abi/.test(ocrAnalyzer), "OCR analyzer must identify the default OCR engine as multi-ABI product scope");
  assert(/NativeOcrBridge\.statusJson/.test(ocrAnalyzer), "OCR analyzer must report product native OCR adapter status");
  assert(/System\.loadLibrary\("jcc_ocr"\)/.test(nativeBridge), "native OCR bridge must load the JCC-owned native library");
  assert(/backend", "ppocrv5_ncnn_mobile"/.test(nativeBridge), "native OCR bridge must report PP-OCRv5 ncnn mobile backend");
  assert(/text_recognition_active", canRun/.test(nativeBridge), "native OCR adapter must report text recognition active only after model load succeeds");
  assert(/nativeRecognizeBitmap/.test(nativeBridge + nativeCpp), "native OCR adapter must expose bitmap recognition");
  assert(/add_library\(jcc_ocr SHARED/.test(cmake) && /add_library\(ncnn STATIC IMPORTED/.test(cmake) && /libncnn\.a/.test(cmake), "CMake must link the JCC native OCR adapter to ncnn");
  assert(/find_package\(OpenCV REQUIRED core imgproc\)/.test(cmake), "CMake must link opencv-mobile core/imgproc for PP-OCRv5 preprocessing");
  assert(/jcc-ocr-native-0\.3\.0\+ppocrv5-ncnn/.test(nativeCpp) && /PPOCRv5/.test(nativeCpp), "native OCR adapter must initialize PP-OCRv5 against ncnn");
  assert(!/System\.loadLibrary\("RapidOcr"\)|rapidocr_ppocrv3_mumu|com\.benjaminwan\.ocrlibrary/.test(ocrAnalyzer + analyzer), "default APK source must not load MuMu RapidOCR");
  assert(/GB18030/.test(championCatalog) && /normalizeName/.test(championCatalog), "champion catalog must repair MuMu GBK/UTF-8 mojibake names at load time");
  assert(/second_best_hash_distance/.test(championMatcher) && /hash_distance_margin/.test(championMatcher), "champion matcher must emit second-best hash margin for identity confirmation");
  assert(/multi_feature_v2/.test(championMatcher) && /combined_score/.test(championMatcher) && /top_candidates/.test(championMatcher), "champion matcher must use multi-feature scoring and emit top candidates");
  assert(/differenceHash/.test(championMatcher) && /rgbHistogram/.test(championMatcher) && /centerSimilarity/.test(championMatcher), "champion matcher must combine hash, color histogram, and center-pixel evidence");
  assert(/roiW = cellW \* 0\.62f/.test(roiLayout) && /roiH = cellH \* 0\.68f/.test(roiLayout), "board slots must use center-window ROI calibration instead of full-cell rectangles");
  assert(/scoreboard_candidates/.test(analyzer) && /local_player_candidate/.test(analyzer), "frame analyzer must emit local-player scoreboard row candidates");
  assert(/isFastOcrRoi/.test(roiLayout) && /top_bar/.test(roiLayout) && /shop_band/.test(roiLayout) && /gold/.test(roiLayout), "default OCR must use fast critical ROIs instead of scanning every shop/augment slot");
  assert(existsSync(join(repoRoot, catalogPath)), "missing generated catalog asset");
  assert(existsSync(join(repoRoot, roiPath)), "missing generated ROI asset");
  assert(existsSync(join(repoRoot, rapidOcrContractPath)), "missing MuMu recognition contract");

  const catalog = JSON.parse(await read(catalogPath));
  const activeProfile = JSON.parse(await read("data/game-knowledge/jcc/active-profile.json"));
  assert(catalog.schema === "jcc-companion-catalog-v1", "catalog schema mismatch");
  assert(catalog.generated_from === "active_core_runtime_catalog_overlay", "companion catalog must come from the active Core Profile");
  assert(catalog.core_profile_id === activeProfile.core_profile_id, "companion catalog must match the exact promoted Core Profile identity");
  assert(catalog.season_id === "s18", "companion catalog must be bound to active S18");
  assert(Array.isArray(catalog.heroes) && catalog.heroes.length >= 65, "catalog must contain active-season hero entries");
  assert(catalog.heroes.every((hero) => hero.id && hero.name), "hero entries must include id/name");
  const iconDir = join(repoRoot, "android-companion", "app", "src", "main", "assets", "champion_icons");
  const iconCount = existsSync(iconDir) ? readdirSync(iconDir).filter((file) => file.endsWith(".png")).length : 0;
  assert(iconCount >= 250, "champion icon templates must be bundled for avatar matching");
  const rapidOcrAssetDir = join(repoRoot, "android-companion", "app", "src", "main", "assets", "rapidocr");
  const rapidOcrLib = join(repoRoot, "android-companion", "app", "src", "main", "jniLibs", "x86_64", "libRapidOcr.so");
  assert(!existsSync(rapidOcrAssetDir), "default product APK must not bundle MuMu RapidOCR model assets");
  assert(!existsSync(rapidOcrLib), "default product APK must not bundle MuMu x86_64 libRapidOcr.so");
  const ppocrAssetDir = join(repoRoot, "android-companion", "app", "src", "main", "assets", "jcc_ocr_models");
  const ppocrAssets = existsSync(ppocrAssetDir) ? readdirSync(ppocrAssetDir).filter((file) => file.startsWith("PP_OCRv5_mobile_")) : [];
  assert(ppocrAssets.includes("PP_OCRv5_mobile_det.ncnn.param"), "missing PP-OCRv5 mobile det param asset");
  assert(ppocrAssets.includes("PP_OCRv5_mobile_det.ncnn.bin"), "missing PP-OCRv5 mobile det model asset");
  assert(ppocrAssets.includes("PP_OCRv5_mobile_rec.ncnn.param"), "missing PP-OCRv5 mobile rec param asset");
  assert(ppocrAssets.includes("PP_OCRv5_mobile_rec.ncnn.bin"), "missing PP-OCRv5 mobile rec model asset");
  const strippedNativeDir = join(repoRoot, "android-companion", "app", "build", "intermediates", "stripped_native_libs");
  const nativeLibs = listFilesRecursive(strippedNativeDir).filter((file) => file.endsWith("libjcc_ocr.so"));
  assert(nativeLibs.some((file) => file.includes("arm64-v8a")), "product APK build must include arm64-v8a libjcc_ocr.so");
  assert(nativeLibs.some((file) => file.includes("x86_64")), "product APK build must include x86_64 libjcc_ocr.so");

  const apk = join(repoRoot, "android-companion", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  const apkStatus = existsSync(apk) ? await stat(apk) : null;

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "MediaProjection foreground service contract",
      "game-exit foreground guard contract",
      "ImageReader capture source",
      "ROI/OCR runtime message types",
      "candidate-only semantic promotion",
      "no screenshot/base64 payload persistence in APK source",
      "generated MuMu hero catalog asset",
      "MuMu catalog mojibake name repair",
      "champion template identity margin",
      "board slot center-window ROI calibration",
      "fast default OCR ROI selection",
      "isolated gold OCR ROI",
      "JCC product OCR engine",
      "JCC-owned native OCR adapter arm64-v8a/x86_64",
      "PP-OCRv5 mobile ncnn backend linked into native OCR adapter",
      "bundled PP-OCRv5 mobile det/rec model assets",
      "no bundled MuMu RapidOCR native/model assets",
      "MuMu recognition contract",
      "bundled champion icon templates",
    ],
    hero_count: catalog.heroes.length,
    champion_icon_templates: iconCount,
    rapidocr_model_assets: 0,
    ppocrv5_mobile_model_assets: ppocrAssets.length,
    native_ocr_abis: nativeLibs.map((file) => file.includes("arm64-v8a") ? "arm64-v8a" : file.includes("x86_64") ? "x86_64" : "unknown").sort(),
    apk_exists: Boolean(apkStatus),
    apk_size_bytes: apkStatus?.size ?? 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
