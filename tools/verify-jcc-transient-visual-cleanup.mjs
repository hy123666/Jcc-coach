import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanupPreparedVisualArtifacts } from "../ui/electron/runtime-service.js";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-transient-visual-cleanup-"));
try {
  const rawFrameFile = path.join(tempRoot, "frame.png");
  const burstFrameFile = path.join(tempRoot, "burst.png");
  const frameFile = path.join(tempRoot, "visual-frame.json");
  const visionRequestFile = path.join(tempRoot, "vision-request.json");
  const preparedRunFile = path.join(tempRoot, "prepared-run.json");
  await mkdir(tempRoot, { recursive: true });
  await writeFile(rawFrameFile, "transient-frame", "utf8");
  await writeFile(burstFrameFile, "transient-burst-frame", "utf8");
  await writeFile(frameFile, `${JSON.stringify({ image: { path: rawFrameFile } }, null, 2)}\n`, "utf8");
  await writeFile(visionRequestFile, `${JSON.stringify({ request_id: "cleanup-contract" }, null, 2)}\n`, "utf8");
  await writeFile(preparedRunFile, `${JSON.stringify({
    request: {
      request_id: "cleanup-contract",
      mode: "augment_choice",
      burst_capture: { captures: [{ image_file: burstFrameFile }] },
    },
    artifacts: {
      frame: frameFile,
      vision_request: visionRequestFile,
    },
  }, null, 2)}\n`, "utf8");

  const result = await cleanupPreparedVisualArtifacts(preparedRunFile, "contract_test");
  assert.equal(result.raw_frame_deleted, true);
  assert.equal(result.burst_images_deleted, 1);
  assert.equal(existsSync(rawFrameFile), false, "cleanup must delete the transient raw frame");
  assert.equal(existsSync(burstFrameFile), false, "cleanup must delete transient burst images");
  assert.equal(existsSync(frameFile), true, "cleanup must retain structured visual-frame JSON");
  assert.equal(existsSync(visionRequestFile), true, "cleanup must retain structured vision request JSON");
  assert.equal(existsSync(preparedRunFile), true, "cleanup must retain structured prepared-run JSON");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-transient-visual-cleanup-verifier-v1",
    checked: [
      "raw_frame_deleted_on_abandon",
      "burst_images_deleted_on_abandon",
      "structured_visual_evidence_retained",
    ],
  }, null, 2)}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
