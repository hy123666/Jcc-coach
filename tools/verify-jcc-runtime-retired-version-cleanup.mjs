import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRuntimeSqliteStore } from "../ui/electron/runtime-state-store.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-retired-runtime-cleanup-"));
const fixtureRepoRoot = path.join(tempRoot, "repo");
const runtimeDataRoot = path.join(tempRoot, "runtime-data");
const knowledgeRoot = path.join(fixtureRepoRoot, "data", "game-knowledge", "jcc");
const finalCoreProfileId = "a".repeat(64);
const store = createRuntimeSqliteStore(repoRoot, { dataRoot: runtimeDataRoot });

async function writeJson(relativePath, value) {
  const file = path.join(knowledgeRoot, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeIdentityFixture({ archived = true, activeSeason = "s18", candidateSeason = "s19" } = {}) {
  await writeJson("manifest.json", {
    schema: "jcc-game-knowledge-manifest-v1",
    season_descriptors: { s17: "seasons/s17/season-descriptor.json" },
    season_archives: archived ? { s17: "seasons/s17/archive-manifest.json" } : {},
  });
  await writeJson("seasons/s17/season-descriptor.json", { schema: "fixture", logical_id: "season.s17" });
  await writeJson("seasons/s17/archive-manifest.json", {
    schema: "jcc-season-in-place-archive-v1",
    season_id: "s17",
    status: "frozen_read_only_in_place",
    archive_policy: {
      physical_relocation_allowed: false,
      source_updates_allowed: false,
      excluded_from_new_default_compilation: true,
    },
    identity_policy: { local_season_id: "s17" },
    descriptor: {
      logical_id: "season.s17",
      path: "data/game-knowledge/jcc/seasons/s17/season-descriptor.json",
    },
    final_core_profile_id: finalCoreProfileId,
    generated_core_profiles: [{ core_profile_id: finalCoreProfileId }],
  });
  await writeJson("active-profile.json", { season_id: activeSeason, runtime_identity: { season_id: activeSeason } });
  await writeJson("candidates/candidate-profile.json", { season_id: candidateSeason, runtime_identity: { season_id: candidateSeason } });
}

function runMaintenance(extra = []) {
  return spawnSync(process.execPath, [
    "tools/maintain-jcc-runtime-db.mjs",
    "--repo-root", fixtureRepoRoot,
    "--runtime-data-root", runtimeDataRoot,
    "--reset-retired-version-runtime",
    "--vacuum",
    ...extra,
  ], { cwd: repoRoot, encoding: "utf8" });
}

try {
  await writeIdentityFixture();
  const missingSeason = runMaintenance();
  assert.notEqual(missingSeason.status, 0);
  assert.match(missingSeason.stderr, /explicit --season-id/);

  const unarchived = runMaintenance(["--season-id", "s16"]);
  assert.notEqual(unarchived.status, 0);
  assert.match(unarchived.stderr, /no registered archive manifest/);

  await writeIdentityFixture({ activeSeason: "s17" });
  const active = runMaintenance(["--season-id", "s17"]);
  assert.notEqual(active.status, 0);
  assert.match(active.stderr, /active season/);

  await writeIdentityFixture({ candidateSeason: "s17" });
  const candidate = runMaintenance(["--season-id", "s17"]);
  assert.notEqual(candidate.status, 0);
  assert.match(candidate.stderr, /candidate season/);

  await writeIdentityFixture();
  store.open();
  store.setJson("user_preferences", { rank_tier: "master" });
  store.setJson("runtime_settings", { diagnostic_mode: false });
  store.setJson("user_strategy_memory", { strategy_rows: [{ id: "keep-strategy" }] });
  store.setJson("user_memory", { strategy_rows: [{ id: "keep-migrated-strategy" }] });
  store.setJson("future_durable_extension", { keep: true });
  store.setJson("daily_session_current", { session_id: "daily" });
  store.setJson("match_session_current", { match_session_id: "old-match" });
  store.setJson("ui_runtime_state", { match_session: { match_session_id: "old-match" } });
  store.upsertSession("daily", "daily_session", "active", { mode: "daily_chat" });
  store.upsertSession("old-match", "match_session", "stopped", { postgame_summary: { schema: "jcc-postgame-decision-summary-v1" } });
  store.enqueue("host_request", { request_ref: "old" }, "completed");
  store.appendEvent("old_runtime_event", { match_session_id: "old-match" });
  store.appendLog("warn", "old runtime log", { match_session_id: "old-match" });
  const protectedSource = store.addWikiSourceEvent({
    sourceType: "protected",
    namespace: "personal_strategy",
    payload: { keep: true },
  });
  store.upsertWikiPage({
    page_id: "keep-page",
    namespace: "personal_strategy",
    category: "strategy",
    title: "Keep",
    status: "published",
    summary: "keep",
    body_md: "keep",
    source_event_ids: [protectedSource.id],
  });
  store.recordWikiCurationRun({ runId: "old-run", status: "pending_host_model", input: { old: true } });
  store.addWikiSourceEvent({
    sourceType: "unreferenced",
    namespace: "personal_strategy",
    payload: { remove: true },
  });
  store.close();

  const run = runMaintenance(["--season-id", "s17"]);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout);
  assert.equal(report.retired_version_reset_receipt.receipt.season_id, "s17");
  const receipt = JSON.parse(await readFile(path.join(runtimeDataRoot, "maintenance", "retired-version-db-reset-receipt.json"), "utf8"));
  assert.equal(receipt.season_id, "s17");
  assert.equal(receipt.final_core_profile_id, finalCoreProfileId);

  store.open();
  assert.deepEqual(store.getJson("user_preferences", null), { rank_tier: "master" });
  assert.deepEqual(store.getJson("runtime_settings", null), { diagnostic_mode: false });
  assert.deepEqual(store.getJson("user_strategy_memory", null), { strategy_rows: [{ id: "keep-strategy" }] });
  assert.deepEqual(store.getJson("user_memory", null), { strategy_rows: [{ id: "keep-migrated-strategy" }] });
  assert.deepEqual(store.getJson("future_durable_extension", null), { keep: true });
  assert.deepEqual(store.getJson("daily_session_current", null), { session_id: "daily" });
  assert.equal(store.getJson("match_session_current", null), null);
  assert.equal(store.getJson("ui_runtime_state", null), null);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM runtime_sessions WHERE session_type = 'daily_session'").get().count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM runtime_sessions WHERE session_type = 'match_session'").get().count, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM runtime_queue").get().count, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM runtime_events").get().count, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM runtime_logs").get().count, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM wiki_pages WHERE page_id = 'keep-page'").get().count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM wiki_curation_runs").get().count, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM wiki_source_events").get().count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM wiki_source_events WHERE id = ?").get(protectedSource.id).count, 1);
  store.close();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-runtime-retired-version-cleanup-verification-v1",
    checked: [
      "match-sessions-removed",
      "queue-events-and-logs-removed",
      "transient-runtime-kv-removed",
      "published-wiki-preferences-settings-and-user-memory-preserved",
      "published-wiki-source-lineage-preserved",
      "unknown-future-durable-kv-preserved",
      "stale-wiki-curation-work-removed",
      "explicit-season-id-required",
      "unarchived-active-and-candidate-seasons-rejected",
      "registered-archived-season-reset-receipt-written",
    ],
  }, null, 2)}\n`);
} finally {
  store.close();
  await rm(tempRoot, { recursive: true, force: true });
}
