import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("tools/finalize-jcc-ranking-maintenance.mjs", "utf8");
const maintenanceSource = await readFile("tools/jcc_ranking_maintenance.mjs", "utf8");
const runtimeSource = await readFile("ui/electron/runtime-service.js", "utf8");
const versionPipelineSource = await readFile("tools/run-jcc-version-pipeline.mjs", "utf8");
const transientFileSource = await readFile("tools/jcc_transient_file_operations.mjs", "utf8");
const refreshContract = JSON.parse(await readFile("data/live-rankings/jcc/runtime-agent-refresh-contract.json", "utf8"));

function position(fragment) {
  const index = source.indexOf(fragment);
  assert(index >= 0, `missing publication boundary: ${fragment}`);
  return index;
}

const verifyPrepared = position("verifyLiveRankingGeneration({ rootDir: rankingsRoot, generationId: preparedGenerationId })");
const validatePacket = position("validateRankingMaintenancePacketForStrategy(packet, strategyIndex)");
const applyMaintenance = position("applyRankingMaintenance(strategyIndex, maintenance");
const verifyFinal = position("verifyCandidate(stagingDir, target)");
const acquireLease = position("acquireLiveRankingRefreshLease({ rootDir: rankingsRoot })");
const compareAndSwap = position("activeClosureMatchesRankingMaintenanceExpectation(preparedPointer, currentClosure)");
const rereadPreparation = position("assertCurrentRankingMaintenancePreparation(preparedPointerFile, preparedPointer)");
const recipeValidate = position("readPreparedRecipeCandidate(");
const publish = position("publishLiveRankingGeneration({");
const publicationTransaction = position("completeCoreRankingPublicationTransaction({");
const archive = position("archiveLiveRankingSignal(signal");
const cleanup = source.lastIndexOf("await rm(stagingDir, { recursive: true, force: true })");
assert(cleanup >= 0, "missing publication staging cleanup");

assert(verifyPrepared < validatePacket && validatePacket < applyMaintenance,
  "prepared generation and maintenance packet must be verified before annotations are applied");
assert(applyMaintenance < verifyFinal && verifyFinal < acquireLease,
  "the maintained candidate must pass deterministic verification before publication locking");
assert(recipeValidate < acquireLease && acquireLease < rereadPreparation && rereadPreparation < publish && publish < compareAndSwap
  && compareAndSwap < publicationTransaction,
  "publication must validate the pinned recipe, reread its exact preparation under the lease, publish immutably, then use one durable transaction for closure and all compatibility mirrors");
assert(!source.includes("promoteRankingsCandidate({"),
  "semantic maintenance finalization must not own a caller-specific current-directory promotion path");
assert(source.includes("desiredAlreadyActive"),
  "publication must be resumable after a crash after authoritative closure commit");
assert(source.includes("writeRankingCandidateMirror")
    && source.includes('operation: "ranking_candidate_mirror"')
    && source.includes("candidate_generation: candidateMirror"),
  "an Active publication must refresh the same-Core candidate mirror and expose repair failure");
assert(source.includes("publication_resumed"),
  "publication output must expose whether it resumed an already committed closure");
assert(publicationTransaction < archive, "history may be archived only after the durable closure and mirror transaction");
assert(archive < source.lastIndexOf("removeRankingMaintenancePreparationIfCurrent(preparedPointerFile, preparedPointer)"),
  "the resumable preparation pointer must survive until history archival succeeds");
assert(maintenanceSource.includes("current_day_strength_unchanged: true"),
  "maintenance receipt must state that current-day strength is unchanged");
assert(source.includes("active Ranking closure is invalid before semantic maintenance"),
  "semantic maintenance must fail closed when the authoritative active closure is invalid");
assert(source.includes("active_closure"), "semantic maintenance output must expose the authoritative closure");
assert(!source.includes("restoreRecipePointer") && !source.includes("previousRecipePointerText"),
  "semantic maintenance must not restore independently managed recipe pointers");
assert(source.includes("semantic maintenance is not ready for publication"),
  "unsupported semantic maintenance envelopes must fail before immutable publication");
assert(source.includes("prepared ranking maintenance pointer does not pin an exact recipe generation"),
  "prepared maintenance must consume its exact pinned recipe generation instead of a mutable recipe candidate pointer");
assert(source.includes("removeRankingMaintenancePreparationIfCurrent")
    && source.includes("prepared maintenance expected Active identity does not match the finalizer request"),
  "semantic maintenance must compare-and-delete only its exact preparation revision and bind Active CAS to that preparation");
assert(source.includes("let publicationStatus = publicationTransaction.status")
    && source.includes("publication_intent_file: publicationTransaction.intent_file"),
  "post-closure mirror failure must preserve the durable transaction intent and return its repair status");
assert(source.includes('publicationStatus = "committed_needs_history_repair"')
    && source.includes("const publicationOk = publicationStatus === \"committed\" && repairErrors.length === 0")
    && source.includes("retryable: !publicationOk"),
  "a repair-required finalization must be retryable non-success");
assert(source.includes("finally") && cleanup > acquireLease,
  "publication staging must be cleaned in a finally block");
assert(source.includes('mkdtemp(path.join(tmpdir(), "jcc-ranking-maintained-")'),
  "semantic maintenance must assemble and verify its large maintained candidate outside the OneDrive-backed Ranking store");
assert(source.includes("writeJsonAtomic(path.join(stagingDir, \"lineup-strategy-index.json\")"),
  "semantic maintenance must atomically write the maintained strategy index instead of truncating the prepared copy in place");
assert(transientFileSource.includes('"UNKNOWN"') && transientFileSource.includes("retryTransientFileOperation"),
  "publication file operations must retry Windows/OneDrive UNKNOWN and lock failures");
const maintenanceCall = runtimeSource.indexOf("const semanticMaintenance = await runRankingSemanticMaintenance");
const finalizerCall = runtimeSource.indexOf('runNodeTool("tools/finalize-jcc-ranking-maintenance.mjs"', maintenanceCall);
const maintenanceToFinalizer = runtimeSource.slice(maintenanceCall, finalizerCall);
assert(maintenanceCall >= 0 && finalizerCall > maintenanceCall
    && !maintenanceToFinalizer.includes('status: "semantic_maintenance_pending"'),
  "a degraded optional annotation result must continue to deterministic Ranking finalization");
assert.equal(refreshContract.strategy_context_policy.semantic_maintenance_limits.total_deadline_minutes, 90,
  "the refresh contract must define a 90-minute resumable full-data maintenance deadline");
assert.equal(refreshContract.strategy_context_policy.semantic_maintenance_limits.total_deadline_ms, 90 * 60 * 1000,
  "the refresh contract must define the 90-minute deadline in milliseconds");
assert.equal(refreshContract.strategy_context_policy.semantic_maintenance_limits.host_call_timeout_minutes, 15,
  "the refresh contract must expose the fifteen-minute per-Host-call bound in minutes");
assert.equal(refreshContract.strategy_context_policy.semantic_maintenance_limits.host_call_timeout_ms, 15 * 60 * 1000,
  "the refresh contract must preserve the fifteen-minute per-Host-call bound");
assert(runtimeSource.includes("semantic_maintenance_limits"),
  "runtime must read the semantic maintenance deadline from the refresh contract");
assert(!runtimeSource.includes("JCC_RANKING_MAINTENANCE_TOTAL_TIMEOUT_MS || 60 * 60 * 1000"),
  "daily Ranking semantic maintenance must not retain a hard-coded one-hour fallback");
assert(versionPipelineSource.includes('"ranking-maintenance",')
    && versionPipelineSource.includes('"version-pipeline",')
    && versionPipelineSource.includes("progressFile: checkpointFile"),
  "version-pipeline semantic maintenance must use a stable resumable workspace outside the mutable Ranking candidates directory");
assert(!versionPipelineSource.includes('path.join(liveRankingsRoot, "candidates", `.pipeline-maintenance-'),
  "candidate cleanup must not be able to delete semantic maintenance packet/response files before finalization");
assert(versionPipelineSource.includes("await workspaceLease.cleanup()")
    && versionPipelineSource.includes("else await workspaceLease.release()"),
  "version-pipeline must preserve interrupted maintenance checkpoints and clean only through the owning lease after successful finalization");
assert(versionPipelineSource.includes('["ready", "not_required"].includes(maintenance.receipt?.status)'),
  "degraded publication must retain its maintenance checkpoint rather than treating publication success as annotation success");
assert(versionPipelineSource.includes("maintenance.ok !== true")
    && versionPipelineSource.includes("ok: maintenance.ok === true")
    && versionPipelineSource.includes("retryable: maintenance.ok !== true")
    && versionPipelineSource.includes("ranking_overlay_published: maintenance.ok === true"),
  "version-pipeline must expose repair-required publication as non-success and unpublished");

console.log(JSON.stringify({
  ok: true,
  verifier: "jcc-ranking-maintenance-publication",
  checks: 20,
}, null, 2));
