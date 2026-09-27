import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const appDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: packaged-cruise <win-unpacked>');
const resources = path.join(appDir, 'resources');
const temp = await mkdtemp(path.join(os.tmpdir(), 'jcc-packaged-cruise-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(JCC_|NODE_|ELECTRON_|VITE_)/i.test(key)));
Object.assign(env, {
  ELECTRON_RUN_AS_NODE: '1', JCC_RUNTIME_REPO_ROOT: resources,
  JCC_RUNTIME_DATA_DIR: temp, JCC_UI_DISABLE_CODEX_EXEC: '1',
  JCC_ADB: path.join(resources, 'adb/adb.exe'),
  JCC_OCR_PYTHON: path.join(resources, 'ocr/python/python.exe'),
});
function run(exe, args, cwd) {
  const result = spawnSync(exe, args, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 300000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, `${exe}: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout;
}
try {
  // Exercise the packaged service, not a development import or a live Provider.
  const cruise = run(path.join(appDir, 'JCC Runtime.exe'), [path.join(resources, 'tools/verify-jcc-proactive-lineup-convergence.mjs')], resources);
  assert.match(cruise, /"ok": true/);
  const modelDir = path.join(resources, 'ocr/models/ppocrv5-mobile');
  const ocr = run(env.JCC_OCR_PYTHON, ['-c',
    'import sys, pathlib, onnxruntime as o, rapidocr, cv2, numpy; p=pathlib.Path(sys.argv[1]); names=["ch_PP-OCRv5_det_mobile.onnx","ch_PP-OCRv5_rec_mobile.onnx","ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx"]; [o.InferenceSession(str(p/n),providers=["CPUExecutionProvider"]) for n in names]; print("ocr_models_ready")', modelDir], temp);
  assert.match(ocr, /ocr_models_ready/);
  assert.match(run(env.JCC_ADB, ['version'], temp), /Android Debug Bridge/);
  console.log(JSON.stringify({ ok: true, test: 'packaged-cruise-and-offline-dependencies', real_provider_used: false }));
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
