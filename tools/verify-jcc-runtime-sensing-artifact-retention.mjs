#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pruneRuntimeSensingArtifactDirectory } from "../ui/electron/runtime-sensing-retention.js";
import {
  leftItemRailFallbackDecision,
  messageRequestsCurrentItemEvidence,
} from "../ui/electron/runtime-sensing-policy.js";

const root = path.resolve(import.meta.dirname, "..");
const source = await readFile(path.join(root, "ui/electron/runtime-service.js"), "utf8");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-sensing-retention-"));

try {
  const now = Date.now();
  for (let index = 0; index < 20; index += 1) {
    const file = index % 2 === 0
      ? path.join(tempDir, `artifact-${String(index).padStart(2, "0")}.json`)
      : path.join(tempDir, `self-state-roi-${String(index).padStart(2, "0")}`);
    if (index % 2 === 0) await writeFile(file, "{}\n", "utf8");
    else {
      await mkdir(file, { recursive: true });
      await writeFile(path.join(file, "result.json"), "{}\n", "utf8");
    }
    const timestamp = new Date(now - index * 1000);
    await utimes(file, timestamp, timestamp);
  }
  const result = await pruneRuntimeSensingArtifactDirectory(tempDir, {
    maxEntries: 8,
    maxAgeMs: 60 * 60 * 1000,
    now,
  });
  const retained = await readdir(tempDir);
  assert.equal(retained.length, 8, "sensing artifact directory must retain only the configured newest run entries");
  assert.equal(result.removed.length, 12);
  assert(retained.includes("artifact-00.json") && retained.includes("self-state-roi-07"));
  assert(!retained.includes("artifact-08.json"));
  await Promise.all(retained.map((entry) => rm(path.join(tempDir, entry), { recursive: true, force: true })));
  await writeFile(path.join(tempDir, "newest-small.json"), "x".repeat(1024), "utf8");
  await writeFile(path.join(tempDir, "second-small.json"), "x".repeat(1024), "utf8");
  await writeFile(path.join(tempDir, "oversized.json"), "x".repeat(16 * 1024), "utf8");
  const byteBounded = await pruneRuntimeSensingArtifactDirectory(tempDir, {
    maxEntries: 8,
    maxAgeMs: 60 * 60 * 1000,
    maxBytes: 4 * 1024,
    maxEntryBytes: 4 * 1024,
    now: Date.now(),
  });
  assert(byteBounded.retained_bytes <= 4 * 1024, "sensing artifact retention must enforce an aggregate byte budget");
  assert(!(await readdir(tempDir)).includes("oversized.json"), "an oversized diagnostic artifact must be removed even when it is recent");
  await assert.rejects(
    () => pruneRuntimeSensingArtifactDirectory(tempDir, { maxEntries: "not-a-number" }),
    /maxEntries must be a finite number/,
  );
  const selfStateRunBody = source.slice(source.indexOf("async function runSelfStateRoiOcr"), source.indexOf("async function runLeftItemRailRoiIconRefresh"));
  const itemRailRunBody = source.slice(source.indexOf("async function runLeftItemRailRoiIconRefresh"), source.indexOf("async function refreshStageFromSelfStateRoiOcr"));
  assert(selfStateRunBody.match(/pruneRuntimeSensingArtifactDirectory/g)?.length >= 2, "self-state production path must prune before and after a run");
  assert(itemRailRunBody.match(/pruneRuntimeSensingArtifactDirectory/g)?.length >= 2, "item-rail production path must prune before and after a run");
  assert(!source.includes("LEFT_ITEM_RAIL_FALLBACK_REFRESH_INTERVAL_MS"), "left item rail fallback must not own a hidden periodic cadence");
  const withStructured4357 = leftItemRailFallbackDecision({
    liveState: {
      items: { item_bench: [{ source: "mumu_4357_item_bench", item_id: "test" }] },
    },
    lastStartedAt: null,
    force: true,
  });
  assert.equal(withStructured4357.should_run, false, "HUD failure or force must not run icon fallback while authoritative 4357 exists");
  const withoutStructured4357 = leftItemRailFallbackDecision({
    liveState: {},
    lastStartedAt: null,
  });
  assert.equal(withoutStructured4357.should_run, false, "missing 4357 alone must not start icon matching from the background HUD loop");
  const explicitWithoutStructured4357 = leftItemRailFallbackDecision({
    liveState: {},
    lastStartedAt: null,
    force: true,
  });
  assert.equal(explicitWithoutStructured4357.should_run, true, "an explicit user refresh may run one bounded icon fallback when 4357 is absent");
  assert.equal(
    messageRequestsCurrentItemEvidence("结合我已有散件和成装，告诉我现在能不能合装备"),
    true,
    "a direct question that depends on current owned items must request one on-demand evidence refresh",
  );
  assert.equal(
    messageRequestsCurrentItemEvidence("贾克斯的完美装备是什么"),
    false,
    "general item knowledge must not capture the screen or run the item matcher",
  );
  assert.equal(
    messageRequestsCurrentItemEvidence("散件怎么合成成装"),
    false,
    "generic item recipes must not be mistaken for a current-inventory request",
  );
  const staleFunction = source.slice(source.indexOf("function expireStaleBackgroundSelfStateRefresh"), source.indexOf("function shouldRunBackgroundSelfStateRefresh"));
  assert(!staleFunction.includes("backgroundSelfStateRefreshPromise = null"), "declaring a background run stale must not release its single-flight lock");
  const backgroundBody = source.slice(source.indexOf("async function runBackgroundSelfStateRefresh"), source.indexOf("async function runManualSelfStateRefreshForUserMessage"));
  assert(!backgroundBody.includes("Promise.race(["), "background item fallback must await bounded subprocess completion instead of releasing while work continues");
  assert(backgroundBody.includes("force: options.force === true"), "item fallback must be tied to the explicit refresh option");
  assert(backgroundBody.includes("left_item_rail_fallback_not_requested"), "non-explicit background refreshes must record that icon fallback was not requested");
  assert(source.includes("messageRequestsCurrentItemEvidence(text)"), "direct current-item questions must have an explicit on-demand sensing gate");
  assert(source.includes("user_current_item_evidence_request"), "on-demand item sensing must have an auditable user-requested reason");

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-runtime-sensing-artifact-retention-v1",
    checked: [
      "sensing_artifact_directory_is_file_count_bounded",
      "nested_run_directories_are_bounded",
      "aggregate_and_per_entry_byte_budgets_are_enforced",
      "newest_artifacts_are_retained",
      "invalid_retention_configuration_fails_closed",
      "production_call_sites_prune_before_and_after_runs",
      "structured_4357_suppresses_icon_fallback",
      "hud_failure_does_not_hide_authoritative_4357",
      "missing_4357_does_not_start_background_icon_matching",
      "explicit_refresh_may_run_bounded_icon_fallback",
      "current_item_questions_request_one_on_demand_matcher_run",
      "general_item_knowledge_does_not_start_sensing",
      "stale_background_run_keeps_single_flight_lock",
    ],
  }, null, 2));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
