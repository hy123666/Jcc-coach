import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHostTurnDeltaPrompt,
  buildRuntimeHostContext,
  captureMatchSeasonVersionSnapshot,
  HOST_TURN_DELTA_MAX_BYTES,
  hostRequestPersistenceRef,
  setRuntimeServiceState,
  summarizeHostRequest,
} from "../ui/electron/runtime-service.js";
import { startSession } from "./start-jcc-new-match-session.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const activeCore = JSON.parse(await readFile(path.join(repoRoot, "data/game-knowledge/jcc/active-profile.json"), "utf8"));

setRuntimeServiceState({
  active_mode: "daily_chat",
  daily_session: { status: "active", mode: "daily_chat", generation: 91 },
  match_session: { status: "idle", match_session_id: null },
  match_context: {},
  user_preferences: { rank_tier: "master", default_goal: "balanced" },
});

const request = {
  request_id: "knowledge-integration-query-1",
  request_hash: "knowledge-integration-query-1",
  request_kind: "host_question",
  mode: "daily_chat",
  provider_readonly_tool_mode: "prefetch_complete",
  user_message: "查一下斗士和未来战士能组成哪些强势阵容，并说明转向条件",
  task: { type: "direct_chat" },
  context: {},
};

const startedAt = performance.now();
const runtimeContext = await buildRuntimeHostContext("daily_chat", null, request);
const elapsedMs = performance.now() - startedAt;

assert.equal(runtimeContext.knowledge_snapshot.schema, "jcc-knowledge-snapshot-v3");
assert.equal(runtimeContext.knowledge_snapshot.core_profile_id, activeCore.core_profile_id);
assert.equal(runtimeContext.knowledge_snapshot.compatibility.season_id, activeCore.season_id);
assert.equal(runtimeContext.knowledge_snapshot.compatibility.patch_id, activeCore.patch_id);
if (runtimeContext.knowledge_snapshot.compatibility.status === "ranking_overlay_unavailable") {
  assert.equal(runtimeContext.knowledge_snapshot.ranking_overlay_id, `unavailable:${activeCore.core_profile_id}`);
  assert.equal(runtimeContext.selected_ranking_candidates, null);
} else {
  assert.match(runtimeContext.knowledge_snapshot.ranking_overlay_id, /\S+/u);
  assert.equal(runtimeContext.selected_ranking_candidates?.schema, "jcc-decision-evidence-packet-v1");
  assert.equal(runtimeContext.selected_ranking_candidates?.ranking_scope?.required_ranking_label, "master_plus");
}
assert.equal(runtimeContext.semantic_evidence.schema, "jcc-semantic-evidence-router-v1");
assert.equal(runtimeContext.semantic_evidence.authority.lexical_effect, "supplement_only_and_cannot_change_candidate_membership_or_order");
assert(runtimeContext.semantic_evidence.authority.input_summary.resolved_typed_entity_count >= 0);
assert.match(runtimeContext.semantic_evidence.authority.input_summary.resolved_typed_entities_fingerprint, /^[a-f0-9]{64}$/u);
assert(runtimeContext.semantic_evidence.hits.every((hit) => hit.supplemental_only === true));

const matchSnapshot = captureMatchSeasonVersionSnapshot("2026-08-22T00:00:00.000Z");
assert.equal(matchSnapshot.knowledge_lifecycle.ranking_overlay, "fixed_for_match");
const testRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-snapshot-start-match-"));
try {
  const outDir = path.join(testRoot, "current-watch");
  const stateFile = path.join(testRoot, "state", "current-session.json");
  await mkdir(outDir, { recursive: true });
  const accepted = await startSession({
    matchSessionId: "jcc-runtime-snapshot-regression",
    outDir,
    stateFile,
    testWorkspaceRoot: testRoot,
    seasonSnapshotBase64Url: Buffer.from(JSON.stringify(matchSnapshot), "utf8").toString("base64url"),
    prepareOnly: true,
    dryRun: true,
  });
  assert.equal(accepted.season_version_snapshot.core_profile_id, matchSnapshot.core_profile_id);
  assert.deepEqual(accepted.season_version_snapshot.knowledge_lifecycle, matchSnapshot.knowledge_lifecycle);
} finally {
  await rm(testRoot, { recursive: true, force: true });
}

const summarized = summarizeHostRequest({ ...request, runtime_context: runtimeContext });
assert.equal(summarized.runtime_context.knowledge_snapshot.generation_id, runtimeContext.knowledge_snapshot.generation_id);
assert.equal(summarized.runtime_context.semantic_evidence.authority.lexical_effect, "supplement_only_and_cannot_change_candidate_membership_or_order");

const prompt = buildHostTurnDeltaPrompt({ ...request, runtime_context: runtimeContext }, {
  capsule_id: "knowledge-integration-capsule",
  fingerprint: "knowledge-integration-capsule-fingerprint",
});
const promptBytes = Buffer.byteLength(prompt, "utf8");
assert(promptBytes <= HOST_TURN_DELTA_MAX_BYTES, `knowledge-aware turn delta exceeded the configured hard ceiling: ${promptBytes}`);

const persistenceRef = hostRequestPersistenceRef({ ...request, runtime_context: runtimeContext }, "knowledge-integration-task");
const persistedText = JSON.stringify(persistenceRef);
assert.equal(persistedText.includes("semantic_evidence"), false, "semantic evidence must remain in-memory turn data");
assert.equal(persistedText.includes("selected_ranking_candidates"), false, "complete ranking candidates must not enter persistence refs");
assert(Buffer.byteLength(persistedText, "utf8") < 4096);

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-runtime-knowledge-integration-verifier-v1",
  knowledge_generation_id: runtimeContext.knowledge_snapshot.generation_id,
  ranking_overlay_status: runtimeContext.knowledge_snapshot.compatibility.status,
  ranking_candidate_count: runtimeContext.selected_ranking_candidates?.candidates?.length || 0,
  runtime_snapshot_start_match: "accepted",
  semantic_hits: runtimeContext.semantic_evidence.hits.length,
  semantic_bytes: runtimeContext.semantic_evidence.budgets.serialized_bytes,
  turn_delta_bytes: promptBytes,
  build_runtime_context_ms: Number(elapsedMs.toFixed(2)),
  persistence_ref_bytes: Buffer.byteLength(persistedText, "utf8"),
}, null, 2)}\n`);
