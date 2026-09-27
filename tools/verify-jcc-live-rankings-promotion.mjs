import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promoteRankingsCandidate } from "./jcc_live_rankings_promotion.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "jcc-rankings-promotion-"));

async function writeSnapshot(directory, value) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "snapshot.json"), `${JSON.stringify({ value })}\n`, "utf8");
}

async function readValue(directory) {
  return JSON.parse(await readFile(path.join(directory, "snapshot.json"), "utf8")).value;
}

try {
  const current = path.join(root, "current");
  const previous = path.join(root, "previous");
  const candidate = path.join(root, ".candidate-new-date");
  await writeSnapshot(current, "old-current");
  await writeSnapshot(previous, "old-previous");
  await writeSnapshot(candidate, "new-current");
  const promoted = await promoteRankingsCandidate({
    currentDir: current,
    previousDir: previous,
    stagingDir: candidate,
    rotateCurrent: true,
  });
  assert.equal(promoted.rotated_current_to_previous, true);
  assert.equal(await readValue(current), "new-current");
  assert.equal(await readValue(previous), "old-current");

  const sameDateCandidate = path.join(root, ".candidate-same-date");
  await writeSnapshot(sameDateCandidate, "same-date-refresh");
  await promoteRankingsCandidate({
    currentDir: current,
    previousDir: previous,
    stagingDir: sameDateCandidate,
    rotateCurrent: false,
  });
  assert.equal(await readValue(current), "same-date-refresh");
  assert.equal(await readValue(previous), "old-current", "same-date refresh must not rotate previous");

  const rollbackCandidate = path.join(root, ".candidate-rollback");
  await writeSnapshot(rollbackCandidate, "must-not-publish");
  const injectedOperations = {
    access,
    rm,
    stat,
    async rename(from, to) {
      if (path.resolve(from) === path.resolve(rollbackCandidate) && path.resolve(to) === path.resolve(current)) {
        throw new Error("injected candidate promotion failure");
      }
      return rename(from, to);
    },
  };
  await assert.rejects(() => promoteRankingsCandidate({
    currentDir: current,
    previousDir: previous,
    stagingDir: rollbackCandidate,
    rotateCurrent: true,
    operations: injectedOperations,
  }), /injected candidate promotion failure/);
  assert.equal(await readValue(current), "same-date-refresh", "failed promotion must restore last-known-good current");
  assert.equal(await readValue(previous), "old-current", "failed promotion must preserve previous");
  assert.equal(await readValue(rollbackCandidate), "must-not-publish", "failed candidate must remain isolated from current");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-live-rankings-promotion-v1",
    checked: [
      "new_date_candidate_promotes_after_validation",
      "old_current_rotates_to_previous_only_during_promotion",
      "same_date_refresh_preserves_previous",
      "promotion_failure_restores_last_known_good_current",
    ],
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
