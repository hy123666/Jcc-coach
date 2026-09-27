#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const LIVE_STATE = "tools/fixtures/jcc-self-board-s1-state.json";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runPack(mode, out) {
  const result = await run("node", [
    "tools/build-jcc-vision-reference-pack.mjs",
    "--mode", mode,
    "--live-state", LIVE_STATE,
    "--out", out,
  ]);
  assert(result.code === 0, `reference pack failed for ${mode}: ${result.stderr || result.stdout}`);
  return JSON.parse(await readFile(out, "utf8"));
}

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), "jcc-vision-reference-pack-"));
  try {
    const augmentPack = await runPack("augment_choice", path.join(tmp, "augment.json"));
    assert(augmentPack.schema === "jcc-vision-reference-pack-v1", "pack should declare schema");
    assert(augmentPack.not_a_matcher === true, "pack must be explicitly marked not_a_matcher");
    assert(augmentPack.counts.augment > 20, "augment mode should include augment candidates");
    assert((augmentPack.counts.item || 0) === 0, "augment mode should not include item candidates");
    assert((augmentPack.counts.champion || 0) === 0, "augment mode should not include champion candidates");
    assert(
      Object.values(augmentPack.candidates || {}).flat().every((entry) => entry.visual_reference_role === "candidate_icon_for_multimodal_pairing"),
      "all candidates should be visual references, not detections",
    );

    const itemPack = await runPack("item_choice", path.join(tmp, "item.json"));
    assert(itemPack.counts.item > 50, "item mode should include a broad item candidate set");
    assert((itemPack.counts.augment || 0) === 0, "item mode should not include augment candidates");
    assert(itemPack.candidates.item.some((entry) => entry.name === "拳套"), "item pack should include basic equipment names");
    assert(itemPack.candidates.item.some((entry) => entry.item_class === "emblem"), "item pack should include emblems");
    assert(itemPack.candidates.item.some((entry) => entry.item_class === "artifact"), "item pack should include artifacts");
    assert(itemPack.candidates.item.some((entry) => entry.item_class === "consumable"), "item pack should include consumables such as removers/forges");

    const removedOpponentPack = await run("node", [
      "tools/build-jcc-vision-reference-pack.mjs",
      "--mode", "opponent_power",
      "--live-state", LIVE_STATE,
      "--out", path.join(tmp, "opponent.json"),
    ]);
    assert(removedOpponentPack.code !== 0, "removed opponent_power mode must not build a vision reference pack");
    assert(/Unsupported|Cannot read|mode/i.test(removedOpponentPack.stderr || removedOpponentPack.stdout), "removed opponent mode should fail explicitly");

    assert(
      augmentPack.response_constraints?.no_invention === true,
      "reference pack should forbid invented entities",
    );
    assert(
      augmentPack.visual_groups.some((group) => group.kind === "augment" && group.entries.length > 1),
      "same-icon augment groups should be preserved for possible_ids disambiguation",
    );
    assert(
      augmentPack.visual_groups.every((group) => group.disambiguation_rule?.includes("visible text") || group.disambiguation_rule?.includes("unit/shop context")),
      "visual groups should declare non-fake-precision disambiguation rules",
    );

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "vision reference pack is a candidate/reference pack, not a matcher result",
        "augment mode includes augment icons only",
        "item mode includes components, completed items, artifacts, emblems, and consumables",
        "removed opponent_power mode is rejected",
        "same-icon groups are preserved with disambiguation rules instead of forced unique IDs",
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
