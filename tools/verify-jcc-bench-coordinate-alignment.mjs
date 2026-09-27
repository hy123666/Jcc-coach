import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-bench-align-"));
  try {
    const deltaFile = path.join(tempDir, "delta.json");
    const outFile = path.join(tempDir, "alignment.json");
    await writeFile(deltaFile, `${JSON.stringify({
      ok: true,
      current_match_only: true,
      match: {
        game_start_time: "20260606194813",
        before_same_match: true,
      },
      added_actions: [
        {
          action: "sell_chess",
          actor_ref: "actor:local",
          action_chair_id_candidate: null,
          entity_id: 79,
          raw_hero_id: 11450,
          hero: { champion_id: "1450", name: "崔斯特" },
          position: { x: 4, y: -1 },
          evidence: "AITreeNode_SellChess Uin:<long-id> Hero:79|11450 Pos:4|-1",
        },
        {
          action: "sell_chess",
          actor_ref: "actor:other",
          action_chair_id_candidate: 2,
          entity_id: 200035,
          raw_hero_id: 11459,
          hero: { champion_id: "1459", name: "科加斯" },
          position: { x: 0, y: -1 },
          evidence: "AITreeNode_SellChess Uin:<long-id> Hero:200035|11459 Pos:0|-1",
        },
      ],
    }, null, 2)}\n`, "utf8");

    const result = await runNode([
      "tools/analyze-jcc-bench-coordinate-alignment.mjs",
      "--delta",
      deltaFile,
      "--champion-id",
      "1450",
      "--reported-visible-index",
      "0",
      "--out",
      outFile,
    ]);
    assert(result.code === 0, `alignment analyzer exited ${result.code}\n${result.stderr}\n${result.stdout}`);
    const alignment = JSON.parse(await readFile(outFile, "utf8"));
    assert(alignment.ok === true, "alignment should find the target champion sell");
    assert(alignment.observed_internal_slot?.internal_slot_x === 4, "reported sell should align to internal slot x=4");
    assert(alignment.calibration?.reported_visible_index === 0, "manual reported visible index should be preserved");
    assert(alignment.calibration?.internal_slot_x === 4, "calibration should map visible index 0 to internal x=4");
    assert(alignment.mismatch?.reported_visible_index_equals_internal_x === false, "visible index is not the same field as internal x");
    assert(alignment.current_visible_order?.status === "unavailable_from_action_delta_only", "action delta alone must not claim current visible order");
    assert(alignment.promotion_decision?.status === "not_promoted", "coordinate calibration must not promote final bench_units");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
