import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildHostTurnDeltaPrompt,
  compactDailyRankingMetaMap,
  compactSuccessfulHostDiagnostic,
  enforceHostTurnDeltaBudget,
  hostContextCapsuleForRequest,
  hostRequestPersistenceRef,
  HOST_PERSISTENT_TURN_DELTA_TARGETS,
  HOST_STRATEGIC_TURN_DELTA_MAX_BYTES,
  HOST_STRATEGIC_TURN_DELTA_TARGET_BYTES,
} from "../ui/electron/runtime-service.js";
import { createRuntimePaths, createRuntimeSqliteStore } from "../ui/electron/runtime-state-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeServiceSource = await readFile(path.join(repoRoot, "ui/electron/runtime-service.js"), "utf8");
const runtimeStateStoreSource = await readFile(path.join(repoRoot, "ui/electron/runtime-state-store.js"), "utf8");
const preloadSource = await readFile(path.join(repoRoot, "ui/electron/preload.js"), "utf8");
const bridgeSource = await readFile(path.join(repoRoot, "ui/src/runtimeBridge.ts"), "utf8");
const matchFactCaptureContract = JSON.parse(await readFile(path.join(repoRoot, "data/runtime/jcc/match-fact-capture-contract.json"), "utf8"));

const repeatedPayload = "x".repeat(300_000);
assert.equal(matchFactCaptureContract.context_budget?.target_turn_bytes, 128 * 1024, "match-fact turns must retain their dedicated 128 KiB closed-write budget");
assert.equal(matchFactCaptureContract.context_budget?.absolute_turn_bytes, 128 * 1024, "match-fact turns must not inherit the general strategy-turn ceiling");
assert.equal(matchFactCaptureContract.context_budget?.inherits_general_strategy_turn_budget, false, "match-fact budget isolation must be explicit");
const forbiddenPersistenceSentinel = "JCC_FULL_REQUEST_MUST_STAY_IN_MEMORY_ONLY_7f1b2c9d";
assert.equal(HOST_PERSISTENT_TURN_DELTA_TARGETS.cruise, 4 * 1024 * 1024,
  "strategic Cruise turns must use the 4 MiB optimization target");
for (const mode of ["augment_choice", "item_choice", "lineup_card"]) {
  assert.equal(HOST_PERSISTENT_TURN_DELTA_TARGETS[mode], 1024 * 1024,
    `${mode} must share the ordinary 1 MiB strategy-turn target`);
}
assert.equal(HOST_STRATEGIC_TURN_DELTA_TARGET_BYTES, 4 * 1024 * 1024,
  "strategic turn target must match the pipeline transport target");
assert.equal(HOST_STRATEGIC_TURN_DELTA_MAX_BYTES, 8 * 1024 * 1024,
  "strategic turn hard limit must leave room for complete atomic candidates and merged obligations");
const oversizedStrategicTurn = enforceHostTurnDeltaBudget({
  schema: "jcc-host-turn-delta-v1",
  request_id: "strategic-target-budget",
  request_kind: "host_question",
  mode: "cruise",
  user_message: "给我当前阵容方向和收束建议",
  payload: "x".repeat(140 * 1024),
});
assert.equal(oversizedStrategicTurn.context_budget?.target_bytes, undefined,
  "a strategic turn below the 4 MiB soft target must remain unreduced");
const dailyBigData = {
  available: true,
  stat_date: "20260816",
  battle_type: "masters_plus",
  tiers: {
    "0": {
      label: "master_plus",
      top_lineups: Array.from({ length: 30 }, (_, index) => ({
        id: `lineup-${index}`,
        display_name: `阵容${index}`,
        main_traits: [`羁绊${index}`],
        summary: { use_num: 1000 + index, top4_rate: 0.6, top1_rate: 0.2, avg_rank: 3.1 },
        raw_payload_that_must_not_survive: repeatedPayload,
      })),
    },
  },
};

const metaMap = compactDailyRankingMetaMap(dailyBigData);
const metaBytes = Buffer.byteLength(JSON.stringify(metaMap), "utf8");
assert(metaBytes < 64 * 1024, `static ranking meta map must remain compact, got ${metaBytes} bytes`);
assert.equal(JSON.stringify(metaMap).includes("raw_payload_that_must_not_survive"), false);
assert.equal(metaMap.tiers["0"].lineup_families.length, 12, "static Meta Map should expose 12 Master+ lineup families");

const requestRef = hostRequestPersistenceRef({
  request_id: "request-1",
  request_hash: "hash-1",
  mode: "cruise",
  daily_big_data: dailyBigData,
  runtime_context: {
    decision_snapshot: { stage_round: "3-2", snapshot_fingerprint: "snapshot-1" },
    match_session: { match_session_id: "match-1" },
  },
}, "task-1");
const requestRefBytes = Buffer.byteLength(JSON.stringify(requestRef), "utf8");
assert(requestRefBytes < 4096, `persisted request ref must remain metadata-only, got ${requestRefBytes} bytes`);
assert.equal(JSON.stringify(requestRef).includes(repeatedPayload), false);
assert.equal(requestRef.decision_snapshot_fingerprint, "snapshot-1");

const oversizedSuccessfulDiagnostic = compactSuccessfulHostDiagnostic({
  status: "completed",
  advice_response: {
    response_id: "response-large",
    trigger_id: "trigger-large",
    match_session_id: "match-1",
    mode: "cruise",
    request_ref: requestRef,
    coach_response: {
      schema: "jcc-host-cli-coach-response-v1",
      confidence: "medium",
      final_text: `诊断正文${forbiddenPersistenceSentinel}${"回".repeat(100_000)}`,
    },
  },
});
const successfulDiagnosticBytes = Buffer.byteLength(JSON.stringify(oversizedSuccessfulDiagnostic), "utf8");
assert(successfulDiagnosticBytes <= 64 * 1024, `successful Host diagnostic must stay below 64KB, got ${successfulDiagnosticBytes} bytes`);
assert.equal(oversizedSuccessfulDiagnostic.coach_response.final_text_truncated, true);

const sqliteTmp = await mkdtemp(path.join(os.tmpdir(), "jcc-host-sqlite-budget-"));
let sqliteStore = null;
let sqliteBytes = null;
try {
  const sqlitePaths = createRuntimePaths(repoRoot, { dataRoot: sqliteTmp });
  sqliteStore = createRuntimeSqliteStore(repoRoot, { dataRoot: sqliteTmp }).open();
  const oversizedRequest = {
    request_id: "sqlite-request",
    request_hash: "sqlite-hash",
    mode: "cruise",
    selected_ranking_candidates: {
      candidates: [{ complete_strategy_package: `${forbiddenPersistenceSentinel}${repeatedPayload.repeat(8)}` }],
    },
    runtime_context: {
      decision_snapshot: { snapshot_fingerprint: "sqlite-snapshot", stage_round: "4-2" },
      match_session: { match_session_id: "sqlite-match" },
    },
  };
  const sqliteRequestRef = hostRequestPersistenceRef(oversizedRequest, "sqlite-task");
  for (const [revision, status] of ["awaiting_host_cli_agent_response", "completed", "failed"].entries()) {
    const responseTask = {
      schema: "jcc-runtime-response-task-v1",
      response_task_id: "sqlite-task",
      revision,
      status,
      mode: "cruise",
      host_request: sqliteRequestRef,
    };
    sqliteStore.commitRuntimeTransition({
      state: { response_task: responseTask, response_task_revision: revision },
      responseTask,
      eventType: `verify_${status}`,
      eventPayload: { response_task_id: "sqlite-task", host_request_ref: sqliteRequestRef },
    });
  }
  sqliteStore.enqueue("advice_task_lifecycle", { response_task_id: "sqlite-task", host_request_ref: sqliteRequestRef });
  sqliteStore.appendLog("info", "verify metadata-only persistence", { host_request_ref: sqliteRequestRef });
  sqliteStore.checkpoint("TRUNCATE");
  sqliteStore.close();
  sqliteStore = null;
  const sqliteFiles = (await readdir(sqliteTmp)).filter((name) => name.startsWith("app.sqlite"));
  const sqliteBuffers = await Promise.all(sqliteFiles.map((name) => readFile(path.join(sqliteTmp, name))));
  const sqliteCorpus = Buffer.concat(sqliteBuffers).toString("utf8");
  sqliteBytes = sqliteBuffers.reduce((sum, buffer) => sum + buffer.length, 0);
  assert.equal(sqliteCorpus.includes(forbiddenPersistenceSentinel), false, "canonical SQLite state, events, queues, and logs must not persist the complete Host request");
  assert(sqliteCorpus.includes("jcc-host-request-ref-v1"), "canonical SQLite should retain the bounded Host request reference");
} finally {
  sqliteStore?.close();
  await rm(sqliteTmp, { recursive: true, force: true });
}

const oversizedModeAddonPrompt = buildHostTurnDeltaPrompt({
  request_id: "request-addon-budget",
  request_hash: "hash-addon-budget",
  mode: "cruise",
  runtime_context: {
    season_host_mode_addons: {
      cruise: { instructions: repeatedPayload.repeat(4) },
    },
  },
}, {
  capsule_id: "capsule-addon-budget",
  fingerprint: "fingerprint-addon-budget",
});
const oversizedModeAddonPromptBytes = Buffer.byteLength(oversizedModeAddonPrompt, "utf8");
assert(
  oversizedModeAddonPromptBytes < 128 * 1024,
  `static mode addon must not bypass the turn-delta budget, got ${oversizedModeAddonPromptBytes} bytes`,
);

const wireCapsule = hostContextCapsuleForRequest({
  request_id: "wire-capsule-budget",
  mode: "daily_chat",
  user_preferences: { preferred_rank: "master_plus" },
}, { routeKey: "daily:wire-budget" });
const wireCapsulePayload = {
  schema: wireCapsule.schema,
  capsule_id: wireCapsule.capsule_id,
  route_key: wireCapsule.route_key,
  fingerprint: wireCapsule.fingerprint,
  static_context: wireCapsule.static_context,
};
assert.equal(wireCapsule.budget.observed_bytes, Buffer.byteLength(JSON.stringify(wireCapsulePayload), "utf8"));
assert(wireCapsule.budget.observed_bytes <= 256 * 1024);

for (let padding = 1_040_000; padding <= 1_052_000; padding += 211) {
  const bounded = enforceHostTurnDeltaBudget({
    schema: "jcc-host-turn-delta-v1",
    request_id: "turn-budget-boundary",
    selected_ranking_candidates: {
      candidates: [
        { id: "one", detail: "a".repeat(Math.max(0, padding - 600)) },
        { id: "two" },
        { id: "three", disposable: "b".repeat(16_000) },
      ],
    },
  });
  assert(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 2 * 1024 * 1024, "ordinary turn payload must remain inside the unified 2 MiB absolute ceiling after metadata is attached");
}

assert.throws(
  () => enforceHostTurnDeltaBudget({
    schema: "jcc-host-turn-delta-v1",
    request_id: "turn-budget-irreduciable",
    selected_ranking_candidates: {
      candidates: [{ id: "required-primary", detail: "a".repeat(2_100_000) }],
    },
  }),
  /exceeds 2097152 byte safety budget/,
  "an irreducible primary evidence package must fail closed instead of crossing the absolute wire budget",
);

function runNode(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      windowsHide: true,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

const budgetClampRun = await runNode([
  "--input-type=module",
  "--eval",
  `import { HOST_STATIC_CAPSULE_MAX_BYTES, HOST_TURN_DELTA_TARGET_BYTES, HOST_TURN_DELTA_MAX_BYTES, HOST_STRATEGIC_TURN_DELTA_TARGET_BYTES, HOST_STRATEGIC_TURN_DELTA_MAX_BYTES } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "ui", "electron", "runtime-service.js")).href)}; process.stdout.write(JSON.stringify({ HOST_STATIC_CAPSULE_MAX_BYTES, HOST_TURN_DELTA_TARGET_BYTES, HOST_TURN_DELTA_MAX_BYTES, HOST_STRATEGIC_TURN_DELTA_TARGET_BYTES, HOST_STRATEGIC_TURN_DELTA_MAX_BYTES }));`,
], {
  env: {
    JCC_HOST_STATIC_CAPSULE_MAX_BYTES: String(10 * 1024 * 1024),
    JCC_HOST_TURN_DELTA_MAX_BYTES: String(10 * 1024 * 1024),
    JCC_HOST_STRATEGIC_TURN_DELTA_MAX_BYTES: String(12 * 1024 * 1024),
  },
});
assert.equal(budgetClampRun.code, 0, `budget clamp child failed: ${budgetClampRun.stderr}`);
const clampedBudgets = JSON.parse(budgetClampRun.stdout.toString("utf8"));
assert.equal(clampedBudgets.HOST_STATIC_CAPSULE_MAX_BYTES, 256 * 1024, "environment must not raise the static capsule absolute ceiling");
assert.equal(clampedBudgets.HOST_TURN_DELTA_TARGET_BYTES, 1024 * 1024, "ordinary turn target must remain at the 1 MiB product target");
assert.equal(clampedBudgets.HOST_TURN_DELTA_MAX_BYTES, 2 * 1024 * 1024, "environment must not raise the 2 MiB turn-delta absolute ceiling");
assert.equal(clampedBudgets.HOST_STRATEGIC_TURN_DELTA_TARGET_BYTES, 4 * 1024 * 1024, "strategic turn target must remain at 4 MiB");
assert.equal(clampedBudgets.HOST_STRATEGIC_TURN_DELTA_MAX_BYTES, 8 * 1024 * 1024, "environment must not raise the 8 MiB strategic absolute ceiling");

const pipelineTmp = await mkdtemp(path.join(os.tmpdir(), "jcc-host-storage-budget-"));
let pipelineArtifactBytes = null;
let pipelineLifecycleBytes = null;
let pipelineStdoutBytes = null;
try {
  const liveStateFile = path.join(pipelineTmp, "live-state.json");
  const contextFile = path.join(pipelineTmp, "context.json");
  const lifecycleFile = path.join(pipelineTmp, "lifecycle.json");
  const outputFile = path.join(pipelineTmp, "pipeline.json");
  await writeFile(liveStateFile, JSON.stringify({
    match_session_id: "storage-budget-match",
    phase: { stage_round: "2-1", status: 1 },
    economy: { hp: 100, gold: 10, level: 4, xp: 0 },
    board: { local_board_units_candidate: [] },
    bench: { units: [] },
    shop: { units: [] },
    items: {},
  }), "utf8");
  await writeFile(contextFile, JSON.stringify({
    match_context: {
      recent_user_messages: [{ text: `${"z".repeat(5 * 1024 * 1024)}${forbiddenPersistenceSentinel}`, mode: "cruise" }],
    },
  }), "utf8");
  const run = await runNode([
    "tools/run-jcc-cruise-runtime-pipeline.mjs",
    "--live-state", liveStateFile,
    "--context", contextFile,
    "--advice-state", lifecycleFile,
    "--out", outputFile,
    "--mode", "cruise",
    "--user-message", "分析当前方向",
    "--force-response-reason", "storage_budget_regression",
  ]);
  assert.equal(run.code, 0, `bounded pipeline failed: ${run.stderr}`);
  pipelineStdoutBytes = run.stdout.length;
  pipelineArtifactBytes = (await stat(outputFile)).size;
  pipelineLifecycleBytes = (await stat(lifecycleFile)).size;
  const [pipelineArtifactText, pipelineLifecycleText] = await Promise.all([
    readFile(outputFile, "utf8"),
    readFile(lifecycleFile, "utf8"),
  ]);
  assert(pipelineStdoutBytes < 4096, `pipeline stdout must be a metadata ref, got ${pipelineStdoutBytes} bytes`);
  assert(pipelineArtifactBytes < 64 * 1024, `successful pipeline artifact must stay below 64KB, got ${pipelineArtifactBytes} bytes`);
  assert(pipelineLifecycleBytes < 512 * 1024, `pipeline lifecycle must stay bounded, got ${pipelineLifecycleBytes} bytes`);
  assert.equal(run.stdout.includes(forbiddenPersistenceSentinel), false, "pipeline stdout must never contain the complete request payload");
  assert.equal(pipelineArtifactText.includes(forbiddenPersistenceSentinel), false, "pipeline artifact must never contain the complete request payload");
  assert.equal(pipelineLifecycleText.includes(forbiddenPersistenceSentinel), false, "pipeline lifecycle must never contain the complete request payload");
  assert.equal(pipelineArtifactText.includes('"host_cli_agent_request":'), false, "pipeline artifact must persist only a Host request reference");
  assert(pipelineArtifactText.includes('"host_cli_agent_request_ref":'), "pipeline artifact must retain bounded request identity metadata");
} finally {
  await rm(pipelineTmp, { recursive: true, force: true });
}

assert(runtimeServiceSource.includes("diagnostic_evidence_enabled: false"));
assert(runtimeServiceSource.includes("debugEvidenceDir: diagnosticEvidenceEnabled()"));
assert(runtimeServiceSource.includes("canonicalHostRequestRef as hostRequestPersistenceRef"));
assert(runtimeStateStoreSource.includes("metadata_only_full_payload_lives_only_for_the_active_provider_turn"));
assert(runtimeServiceSource.includes("HOST_TURN_DELTA_MAX_BYTES"));
assert(runtimeServiceSource.includes("runRuntimePipelineInProcess"));
assert.equal(runtimeServiceSource.includes('runNodeTool("tools/run-jcc-cruise-runtime-pipeline.mjs"'), false);
const pendingSelectorBody = runtimeServiceSource.slice(
  runtimeServiceSource.indexOf("async function requestPendingHostCoach"),
  runtimeServiceSource.indexOf("function runtimeValueText"),
);
assert(pendingSelectorBody.includes("normalizeAdviceResponseRequestEvent(selected)"));
assert(pendingSelectorBody.includes("in_process_request_selection_no_artifact"));
assert.equal(pendingSelectorBody.includes('runNodeTool("tools/run-jcc-pending-host-coach-response.mjs"'), false);
const completionBody = runtimeServiceSource.slice(
  runtimeServiceSource.indexOf("async function completePendingHostCoach"),
  runtimeServiceSource.indexOf("async function runHostCoachForPipeline"),
);
assert(completionBody.includes("if (diagnosticEvidenceEnabled())"));
assert(completionBody.includes("void Promise.resolve().then"));
assert(runtimeServiceSource.includes("state.resolved_decision_snapshot = capturedDecisionSnapshot"));
assert.equal(
  (await readFile(path.join(repoRoot, "tools/run-jcc-cruise-runtime-pipeline.mjs"), "utf8"))
    .includes("active_rules_bundle: ACTIVE_RULES_BUNDLE"),
  false,
);
assert(preloadSource.includes('"saveRuntimeSettings"'));
assert(bridgeSource.includes("diagnostic_evidence_enabled?: boolean"));

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-host-context-storage-budget-verification-v1",
  meta_map_bytes: metaBytes,
  persisted_request_ref_bytes: requestRefBytes,
  successful_diagnostic_bytes: successfulDiagnosticBytes,
  sqlite_files_bytes: sqliteBytes,
  oversized_mode_addon_prompt_bytes: oversizedModeAddonPromptBytes,
  pipeline_stdout_bytes: pipelineStdoutBytes,
  pipeline_artifact_bytes: pipelineArtifactBytes,
  pipeline_lifecycle_bytes: pipelineLifecycleBytes,
  diagnostic_default: false,
  environment_budget_clamp: clampedBudgets,
}, null, 2)}\n`);
