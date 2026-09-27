import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireLiveRankingRefreshLease,
  liveRankingBindingFromSourceIdentity,
  publishLiveRankingGeneration,
  sha256File,
  verifyLiveRankingGeneration,
} from "./jcc_live_rankings_generation_store.mjs";
import {
  completeCoreRankingPublicationTransaction,
  resolveRankingRefreshBaselineClosureSync,
} from "./jcc_live_rankings_active_closure.mjs";
import { archiveLiveRankingSignal } from "./jcc_live_rankings_history.mjs";
import {
  applyRankingMaintenance,
  createDegradedRankingMaintenance,
  createNotRequiredRankingMaintenance,
  validateRankingMaintenancePacketForStrategy,
  validateRankingMaintenanceResponse,
} from "./jcc_ranking_maintenance.mjs";
import { readRankingRecipeGenerationSync } from "./jcc_live_rankings_recipe_store.mjs";
import { buildRankingRecipeFreshnessProfile } from "./jcc_ranking_recipe_freshness.mjs";
import { resolveRankingTarget } from "./jcc_ranking_target.mjs";
import { retryTransientFileOperation } from "./jcc_transient_file_operations.mjs";
import {
  activeClosureMatchesRankingMaintenanceExpectation,
  assertCurrentRankingMaintenancePreparation,
  assertRankingMaintenancePreparation,
  rankingMaintenanceExpectedActiveClosure,
  readRankingMaintenancePreparation,
  removeRankingMaintenancePreparationIfCurrent,
} from "./jcc_ranking_maintenance_preparation.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const rankingsRoot = path.join(repoRoot, "data", "live-rankings", "jcc");
const currentDir = path.join(rankingsRoot, "current");
const artifactFiles = [
  "snapshot.json",
  "rank-signal.json",
  "lineup-strategy-index.json",
  "latest-diff.json",
  "audit.json",
  "manifest.json",
];

function argValue(argv, name, required = true) {
  const index = argv.indexOf(name);
  if (index < 0) {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJsonAtomic(file, value, compact = false) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await retryTransientFileOperation(() => writeFile(
      temporary,
      `${JSON.stringify(value, null, compact ? 0 : 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    ));
    await retryTransientFileOperation(() => rename(temporary, file));
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeRankingCandidateMirror(target, publicationPointer, recipeGenerationId) {
  const candidatePointer = {
    schema: "jcc-live-ranking-candidate-pointer-v1",
    season_id: target.season_id,
    patch_id: target.patch_id,
    game_mode_id: target.game_mode_id,
    core_profile_id: target.core_profile_id,
    generation_id: publicationPointer.generation_id,
    recipe_generation_id: recipeGenerationId,
    stat_date: publicationPointer.stat_date,
    content_sha256: publicationPointer.content_sha256,
    catalog_fingerprint: publicationPointer.catalog_fingerprint,
    hard_data_manifest_fingerprint: publicationPointer.hard_data_manifest_fingerprint,
    status: "ready",
  };
  await writeJsonAtomic(target.candidate_pointer_file, candidatePointer);
  return candidatePointer;
}

function verifyCandidate(candidateDir, target) {
  const result = spawnSync(process.execPath, [
    "tools/verify-jcc-live-rankings.mjs",
    "--dir", candidateDir,
    "--season", target.season_id,
    "--patch", target.patch_id,
    "--expected-core-profile-id", target.core_profile_id,
    "--profile", target.selection,
  ], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "ranking maintenance candidate verification failed");
  return JSON.parse(String(result.stdout || "{}").trim());
}

function assertPreparedPointerPath(value) {
  const candidateRoot = path.join(rankingsRoot, "candidates");
  const resolved = path.resolve(value);
  const relative = path.relative(candidateRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(resolved) !== ".json") {
    throw new Error("prepared maintenance pointer must stay inside the ranking candidates directory");
  }
  return resolved;
}

async function readPreparedRecipeCandidate(target, expectedStatDate, expectedGenerationId) {
  const generationId = String(expectedGenerationId || "").trim();
  if (!/^[a-f0-9]{64}$/u.test(generationId)) {
    throw new Error("prepared ranking maintenance pointer does not pin an exact recipe generation");
  }
  const loaded = readRankingRecipeGenerationSync({
    rootDir: rankingsRoot,
    generationId,
    expectedIdentity: target,
  });
  const freshness = buildRankingRecipeFreshnessProfile({
    rankingStatDate: expectedStatDate,
    sourceCapabilities: loaded.document?.capability?.source_capabilities || {},
    identityCompatible: true,
  });
  if (freshness.status === "unavailable") {
    throw new Error(`prepared ranking maintenance recipe candidate has no usable source for ${expectedStatDate || "unknown ranking date"}`);
  }
  return {
    generation: { generation_id: generationId },
    generation_file: loaded.generation_file,
    freshness,
  };
}

const argv = process.argv.slice(2);
const target = await resolveRankingTarget({ repoRoot, argv });
const preparedGenerationId = argValue(argv, "--prepared-generation-id");
const preparedPointerFile = assertPreparedPointerPath(argValue(argv, "--prepared-pointer-file"));
const packetFile = path.resolve(argValue(argv, "--packet-file"));
const responseFile = path.resolve(argValue(argv, "--response-file"));
const expectedActiveGenerationId = argValue(argv, "--expected-active-generation-id", false);
const provider = argValue(argv, "--provider", false);
const model = argValue(argv, "--model", false);
const durationMs = Number(argValue(argv, "--duration-ms", false));

const preparedPointer = await readRankingMaintenancePreparation(preparedPointerFile);
assertRankingMaintenancePreparation(preparedPointer, {
  ...preparedPointer,
  generation_id: preparedGenerationId,
  core_profile_id: target.core_profile_id,
});
const preparedRecipeGenerationId = String(preparedPointer.recipe_generation_id || "").trim();
const prepared = await verifyLiveRankingGeneration({ rootDir: rankingsRoot, generationId: preparedGenerationId });
if (prepared.metadata.content_sha256 !== preparedPointer.content_sha256) {
  throw new Error("prepared maintenance generation does not match its protection pointer");
}

const [strategyIndex, packet, responseEnvelope, manifest, audit, signal] = await Promise.all([
  readJson(path.join(prepared.generation_dir, "lineup-strategy-index.json")),
  readJson(packetFile),
  readJson(responseFile),
  readJson(path.join(prepared.generation_dir, "manifest.json")),
  readJson(path.join(prepared.generation_dir, "audit.json")),
  readJson(path.join(prepared.generation_dir, "rank-signal.json")),
]);
validateRankingMaintenancePacketForStrategy(packet, strategyIndex);
let maintenance;
if (responseEnvelope?.schema === "jcc-ranking-maintenance-response-v1") {
  maintenance = validateRankingMaintenanceResponse(packet, responseEnvelope);
} else if (responseEnvelope?.schema === "jcc-ranking-maintenance-degraded-v1") {
  if (responseEnvelope.input_hash !== packet.input_hash) throw new Error("degraded maintenance receipt input hash mismatch");
  maintenance = createDegradedRankingMaintenance(
    packet,
    responseEnvelope.failure_code,
    responseEnvelope.failure_reason,
  );
} else if (responseEnvelope?.schema === "jcc-ranking-maintenance-not-required-v1") {
  if (responseEnvelope.input_hash !== packet.input_hash) throw new Error("not-required maintenance receipt input hash mismatch");
  maintenance = createNotRequiredRankingMaintenance(packet);
} else {
  throw new Error("unsupported ranking maintenance response envelope");
}
if (!new Set(["ready", "degraded", "not_required"]).has(maintenance.status)) {
  throw new Error(`semantic maintenance is not ready for publication: ${maintenance.status}`);
}

const stagingDir = await mkdtemp(path.join(tmpdir(), "jcc-ranking-maintained-"));
let lease = null;
try {
  for (const file of ["snapshot.json", "rank-signal.json", "latest-diff.json"]) {
    await retryTransientFileOperation(() => copyFile(
      path.join(prepared.generation_dir, file),
      path.join(stagingDir, file),
    ));
  }
  const maintainedIndex = applyRankingMaintenance(strategyIndex, maintenance, {
    provider,
    model,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    reusedAnnotations: packet.reused_annotations || [],
  });
  manifest.semantic_maintenance = maintainedIndex.semantic_maintenance;
  audit.semantic_maintenance = maintainedIndex.semantic_maintenance;
  await writeJsonAtomic(path.join(stagingDir, "lineup-strategy-index.json"), maintainedIndex, true);
  await writeJsonAtomic(path.join(stagingDir, "manifest.json"), manifest);
  await writeJsonAtomic(path.join(stagingDir, "audit.json"), audit);

  const verification = verifyCandidate(stagingDir, target);
  const artifacts = await Promise.all(artifactFiles.map(async (file) => ({
    path: file,
    sha256: await sha256File(path.join(stagingDir, file)),
  })));
  lease = await acquireLiveRankingRefreshLease({ rootDir: rankingsRoot });
  await lease.assertOwnership();
  await assertCurrentRankingMaintenancePreparation(preparedPointerFile, preparedPointer);
  const publicationIdentity = liveRankingBindingFromSourceIdentity(maintainedIndex.source_identity);
  const preparedRecipeCandidate = await readPreparedRecipeCandidate(
    target,
    maintainedIndex.stat_date,
    preparedRecipeGenerationId,
  );
  const publication = await publishLiveRankingGeneration({
    rootDir: rankingsRoot,
    candidateDir: stagingDir,
    artifacts,
    statDate: maintainedIndex.stat_date,
    binding: publicationIdentity,
    activatePointer: false,
    lease,
  });
  if (target.publication_scope === "candidate") {
    await lease.renew();
    await lease.assertOwnership();
    const candidatePointer = await writeRankingCandidateMirror(
      target,
      publication.pointer,
      preparedRecipeCandidate.generation.generation_id,
    );
    await removeRankingMaintenancePreparationIfCurrent(preparedPointerFile, preparedPointer);
    console.log(JSON.stringify({
      ok: true,
      schema: "jcc-ranking-maintenance-finalization-v1",
      status: maintenance.status,
      publication_status: "candidate_committed",
      repair_required: false,
      repair_errors: [],
      annotation_count: maintenance.annotations.length,
      stat_date: maintainedIndex.stat_date,
      ranking_target: {
        selection: target.selection,
        publication_scope: target.publication_scope,
        season_id: target.season_id,
        patch_id: target.patch_id,
        game_mode_id: target.game_mode_id,
        core_profile_id: target.core_profile_id,
      },
      verification,
      published_generation: publication.pointer,
      candidate_generation: candidatePointer,
      active_snapshot_unchanged: true,
      output_dir: publication.generation_dir,
    }, null, 2));
  } else {
  let currentClosure = resolveRankingRefreshBaselineClosureSync({
    rootDir: rankingsRoot,
    expectedIdentity: publicationIdentity,
  });
  if (currentClosure.closure_status === "invalid") {
    throw new Error(`active Ranking closure is invalid before semantic maintenance: ${currentClosure.reason || "unknown reason"}`);
  }
  const desiredAlreadyActive = currentClosure.availability === "available"
    && currentClosure.target_compatible === true
    && currentClosure.ranking_generation_id === publication.pointer.generation_id
    && currentClosure.recipe_generation_id === preparedRecipeCandidate.generation.generation_id;
  const preparedExpectedActiveClosure = rankingMaintenanceExpectedActiveClosure(preparedPointer);
  const preparedExpectedActiveGenerationId = preparedExpectedActiveClosure.ranking_generation_id;
  if ((expectedActiveGenerationId || null) !== preparedExpectedActiveGenerationId) {
    throw new Error("prepared maintenance expected Active identity does not match the finalizer request");
  }
  if (!desiredAlreadyActive && !activeClosureMatchesRankingMaintenanceExpectation(preparedPointer, currentClosure)) {
    throw new Error(`ranking active closure advanced during semantic maintenance: expected ${JSON.stringify(preparedExpectedActiveClosure)}, got ${JSON.stringify({
      ranking_generation_id: currentClosure.ranking_generation_id || null,
      recipe_generation_id: currentClosure.recipe_generation_id || null,
      stat_date: currentClosure.stat_date || null,
      core_profile_id: currentClosure.core_profile_id || null,
    })}`);
  }
  const publicationTransaction = await completeCoreRankingPublicationTransaction({
    rootDir: rankingsRoot,
    rankingGenerationId: publication.pointer.generation_id,
    recipeGenerationId: preparedRecipeCandidate.generation.generation_id,
    statDate: maintainedIndex.stat_date,
    identity: publicationIdentity,
    lease,
    readActiveCoreProfile: () => readJson(path.join(repoRoot, "data", "game-knowledge", "jcc", "active-profile.json")),
    promoteCoreProfile: async () => {
      throw new Error("active Ranking maintenance cannot promote a different Core Profile");
    },
  });
  const repairErrors = [...(publicationTransaction.mirrors?.errors || [])];
  let candidateMirror = null;
  try {
    await lease.renew();
    await lease.assertOwnership();
    candidateMirror = await writeRankingCandidateMirror(
      target,
      publication.pointer,
      preparedRecipeCandidate.generation.generation_id,
    );
  } catch (error) {
    repairErrors.push({ operation: "ranking_candidate_mirror", error: error?.message || String(error) });
  }
  let history = null;
  let historyError = null;
  let publicationStatus = publicationTransaction.status;
  if (publicationStatus === "committed") {
    try {
      history = await archiveLiveRankingSignal(signal, { rootDir: rankingsRoot, keepDates: 14 });
    } catch (error) {
      historyError = error?.message || String(error);
      repairErrors.push({ operation: "ranking_history_archive", error: historyError });
      publicationStatus = "committed_needs_history_repair";
    }
    if (!historyError && repairErrors.length === 0) {
      await removeRankingMaintenancePreparationIfCurrent(preparedPointerFile, preparedPointer);
    }
  }
  const publicationOk = publicationStatus === "committed" && repairErrors.length === 0;
  console.log(JSON.stringify({
    ok: publicationOk,
    schema: "jcc-ranking-maintenance-finalization-v1",
    status: maintenance.status,
    publication_status: publicationStatus,
    repair_required: !publicationOk,
    retryable: !publicationOk,
    repair_errors: repairErrors,
    annotation_count: maintenance.annotations.length,
    stat_date: maintainedIndex.stat_date,
    ranking_target: {
      selection: target.selection,
      publication_scope: target.publication_scope,
      season_id: target.season_id,
      patch_id: target.patch_id,
      game_mode_id: target.game_mode_id,
      core_profile_id: target.core_profile_id,
    },
    verification,
    published_generation: publication.pointer,
    active_generation: publicationTransaction.mirrors?.ranking?.pointer || null,
    active_closure: publicationTransaction.active_closure.pointer,
    active_recipe_generation: publicationTransaction.mirrors?.recipe?.pointer || null,
    candidate_generation: candidateMirror,
    publication_intent_file: publicationTransaction.intent_file,
    publication_transaction_id: publicationTransaction.transaction_id,
    publication_resumed: publicationTransaction.resumed === true || desiredAlreadyActive,
    history: history ? { status: "current", retained_dates: history.pruned.retained_dates } : { status: "degraded", error: historyError },
    output_dir: currentDir,
  }, null, 2));
  }
} finally {
  if (lease) await lease.release();
  await rm(stagingDir, { recursive: true, force: true });
}
