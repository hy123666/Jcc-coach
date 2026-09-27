#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { archiveSeason } from "./archive-jcc-season.mjs";
import { compileGameKnowledge } from "./jcc_game_knowledge_compiler.mjs";
import {
  promoteGameKnowledgeCandidate,
  pruneGameKnowledgeGenerations,
  readGameKnowledgeGenerationLeases,
} from "./jcc_game_knowledge_profile_store.mjs";
import {
  acquireLiveRankingRefreshLease,
  pruneLiveRankingGenerations,
  verifyLiveRankingGeneration,
} from "./jcc_live_rankings_generation_store.mjs";
import {
  completeCoreRankingPublicationTransaction,
  readCoreRankingPublicationIntentSync,
  resolveActiveRankingClosureSync,
  validateRankingClosureCandidateSync,
} from "./jcc_live_rankings_active_closure.mjs";
import { pruneRankingRecipeGenerations } from "./jcc_live_rankings_recipe_sources.mjs";
import { readRankingRecipeGenerationSync } from "./jcc_live_rankings_recipe_store.mjs";
import { pruneHardDataGenerations } from "./jcc_hard_data_package_store.mjs";
import { resolveRankingTarget } from "./jcc_ranking_target.mjs";
import { buildRankingMaintenancePacket } from "./jcc_ranking_maintenance.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const knowledgeRoot = path.join(repoRoot, "data", "game-knowledge", "jcc");
const liveRankingsRoot = path.join(repoRoot, "data", "live-rankings", "jcc");
const rankingsUpdateTool = "tools/update-jcc-live-rankings.mjs";
const harnessContractFile = path.join(repoRoot, "data", "runtime", "jcc", "harness-entrypoint-contract.json");
const generationLeaseFile = path.resolve(
  process.env.JCC_RUNTIME_DATA_DIR || path.join(repoRoot, ".jcc-runtime-data"),
  "state",
  "jcc-game-knowledge-generation-leases.json",
);
const rankingMaintenanceRoot = path.resolve(
  process.env.JCC_RUNTIME_DATA_DIR || path.join(repoRoot, ".jcc-runtime-data"),
  "ranking-maintenance",
  "version-pipeline",
);

function parseArguments(argv) {
  const [phase, ...tokens] = argv;
  const options = { phase: phase === "intelligence" ? "rankings" : phase, requestedPhase: phase, write: false };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--write") options.write = true;
    else if (token === "--season") options.seasonId = tokens[++index];
    else if (token === "--patch") options.patchId = tokens[++index];
    else if (token === "--expected-core-profile-id") options.expectedCoreProfileId = tokens[++index];
    else if (token === "--task-id") options.taskId = tokens[++index];
    else if (token === "--retain-previous") options.retainPrevious = Number(tokens[++index]);
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!["source", "inspect", "compile", "intelligence", "rankings", "verify", "promote", "archive", "prune"].includes(phase)) {
    throw new Error("Usage: node tools/run-jcc-version-pipeline.mjs <source|inspect|compile|rankings|verify|promote|archive|prune> --season <sN> --patch <sN_N> [--expected-core-profile-id <sha256>] [--task-id <id>] [--write] (intelligence is a compatibility alias for rankings)");
  }
  return options;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readJsonIfExists(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertIdentity(options, { requirePatch = true, requireFingerprint = false } = {}) {
  if (!/^s\d+$/.test(String(options.seasonId || ""))) throw new Error("A valid --season is required");
  if (requirePatch && !/^s\d+_\d+$/.test(String(options.patchId || ""))) throw new Error("A valid --patch is required");
  if (requireFingerprint && !/^[a-f0-9]{64}$/.test(String(options.expectedCoreProfileId || ""))) {
    throw new Error("A lowercase SHA-256 --expected-core-profile-id is required");
  }
}

export function classifyRankingPipelineUpdate(update) {
  const recipeOnlyPartial = update?.status === "ranking_strength_unavailable_recipes_cached"
    || update?.sync?.status === "ranking_strength_unavailable_recipes_cached";
  const prepared = !recipeOnlyPartial && Boolean(update?.sync?.prepared_generation?.generation_id);
  const published = !prepared && !recipeOnlyPartial && update?.ok === true && Boolean(update?.output_dir);
  const publicationScope = update?.sync?.ranking_target?.publication_scope || null;
  return {
    status: recipeOnlyPartial ? "partial" : prepared ? "prepared" : published ? "published" : "unavailable",
    degraded: !published && !prepared,
    ranking_overlay_published: published,
    active_pointer_preserved: prepared || !published || publicationScope === "candidate",
  };
}

async function finalizePreparedRankingMaintenance(update, options) {
  const sync = update?.sync;
  const target = sync?.ranking_target;
  const preparedGenerationId = sync?.prepared_generation?.generation_id;
  const preparedPointerFile = sync?.prepared_pointer_file;
  if (!target || !preparedGenerationId || !preparedPointerFile || !update?.output_dir) return null;
  const preparedStrategyIndex = await readJson(path.join(update.output_dir, "lineup-strategy-index.json"));
  const runtimeService = await import("../ui/electron/runtime-service.js");
  const previousCandidates = await Promise.all([
    readJsonIfExists(path.join(liveRankingsRoot, "current", "lineup-strategy-index.json")),
    readJsonIfExists(path.join(liveRankingsRoot, "previous", "lineup-strategy-index.json")),
  ]);
  const previousStrategyIndex = runtimeService.selectRankingSemanticMaintenanceBaseline(
    preparedStrategyIndex,
    previousCandidates.filter(Boolean),
  );
  const packet = buildRankingMaintenancePacket({
    strategyIndex: preparedStrategyIndex,
    previousStrategyIndex,
    commonSummary: {},
    coreSummary: {
      core_profile_id: target.core_profile_id,
      season_id: target.season_id,
      patch_id: target.patch_id,
    },
  });
  const maintenanceDir = path.join(
    rankingMaintenanceRoot,
    `${target.core_profile_id}-${packet.input_hash}`,
  );
  const packetFile = path.join(maintenanceDir, "packet.json");
  const checkpointFile = path.join(maintenanceDir, "checkpoint.json");
  const responseFile = path.join(maintenanceDir, "response.json");
  const workspaceLease = await runtimeService.acquireRankingMaintenanceWorkspaceLease({
    directory: maintenanceDir,
    inputHash: packet.input_hash,
  });
  const startedAt = Date.now();
  let finalized = false;
  try {
    await workspaceLease.renew();
    await writeFile(packetFile, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
    const maintenance = await runtimeService.runRankingSemanticMaintenance(packet, {
      taskId: options.taskId || `version-pipeline-ranking-maintenance:${packet.input_hash.slice(0, 16)}`,
      progressFile: checkpointFile,
      beforeProgressWrite: () => workspaceLease.renew(),
    });
    await workspaceLease.renew();
    await writeFile(responseFile, `${JSON.stringify(maintenance.response_envelope, null, 2)}\n`, "utf8");
    const finalizeArgs = [
      "--profile", target.selection,
      "--season", target.season_id,
      "--patch", target.patch_id,
      "--expected-core-profile-id", target.core_profile_id,
      "--prepared-generation-id", preparedGenerationId,
      "--prepared-pointer-file", preparedPointerFile,
      "--packet-file", packetFile,
      "--response-file", responseFile,
      "--provider", "version-pipeline",
      "--model", "runtime-selected",
      "--duration-ms", String(Date.now() - startedAt),
    ];
    if (sync.expected_active_generation_id) {
      finalizeArgs.push("--expected-active-generation-id", sync.expected_active_generation_id);
    }
    const result = await runNodeScriptJson(containedFile("tools/finalize-jcc-ranking-maintenance.mjs", "ranking maintenance finalizer"), finalizeArgs);
    finalized = ["ready", "not_required"].includes(maintenance.receipt?.status)
      && result?.ok === true
      && result?.repair_required !== true
      && !new Set(["committed_needs_repair", "repair_required"]).has(result?.publication_status);
    return result;
  } finally {
    if (finalized) await workspaceLease.cleanup();
    else await workspaceLease.release();
  }
}

async function registeredPatch(options) {
  assertIdentity(options);
  const manifest = await readJson(path.join(knowledgeRoot, "manifest.json"));
  const relative = manifest.patch_manifests?.[options.patchId];
  if (!relative) throw new Error(`Patch ${options.patchId} is not registered`);
  const patchFile = path.resolve(knowledgeRoot, relative);
  const patch = await readJson(patchFile);
  if (patch.season_id !== options.seasonId || patch.patch_id !== options.patchId) {
    throw new Error("Requested season/patch does not match the registered patch manifest");
  }
  return { manifest, patch, patchFile, archived: Boolean(manifest.season_archives?.[options.seasonId]) };
}

function containedFile(relativeFile, label) {
  const absolute = path.resolve(repoRoot, relativeFile);
  const relative = path.relative(repoRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} escapes the repository`);
  return absolute;
}

function containedToolFile(relativeFile, label) {
  if (typeof relativeFile !== "string"
    || !/^tools\/[A-Za-z0-9._/-]+\.mjs$/.test(relativeFile)
    || path.posix.normalize(relativeFile) !== relativeFile
    || relativeFile.split("/").includes("..")) {
    throw new Error(`${label} must be a normalized repository tools/*.mjs path`);
  }
  return containedFile(relativeFile, label);
}

function expandAdapterArguments(argumentsList, options, patch = null) {
  const hardDataManifest = patch?.source_artifacts?.find((artifact) => artifact.role === 'hard_data_manifest')?.path || '';
  const hardDataPackageDir = hardDataManifest ? path.posix.dirname(hardDataManifest.replaceAll('\\', '/')) : '';
  return (argumentsList || []).map((value) => String(value)
    .replaceAll("${season_id}", options.seasonId || "")
    .replaceAll("${patch_id}", options.patchId || "")
    .replaceAll("${hard_data_package_dir}", hardDataPackageDir));
}

async function runNodeScript(script, args = []) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.relative(repoRoot, script)} failed with ${signal || `exit ${code}`}`));
    });
  });
}

async function runNodeScriptJson(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`${path.relative(repoRoot, script)} failed with ${signal || `exit ${code}`}: ${stderr.trim() || "no diagnostic"}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`${path.relative(repoRoot, script)} returned invalid JSON`));
      }
    });
  });
}

async function source(options) {
  const { patch, archived } = await registeredPatch(options);
  if (archived) throw new Error(`Season ${options.seasonId} is archived and cannot run a source update`);
  const adapter = patch.source_adapter;
  if (!adapter?.command) throw new Error(`Patch ${options.patchId} has no registered source_adapter`);
  const command = containedToolFile(adapter.command, "source adapter command");
  const args = expandAdapterArguments(adapter.arguments, options, patch);
  await runNodeScript(command, args);
  return { phase: "source", adapter: adapter.id, command: path.relative(repoRoot, command).replaceAll("\\", "/") };
}

async function inspect(options) {
  assertIdentity(options);
  const result = await compileGameKnowledge({ repoRoot, knowledgeRoot, seasonId: options.seasonId, patchId: options.patchId, write: false });
  return {
    phase: "inspect",
    season_id: options.seasonId,
    patch_id: options.patchId,
    core_profile_id: result.combinedFingerprint,
    activation_blockers: result.candidateProfile.activation_blockers,
    artifact_bytes: {
      bundle: result.bundleBytes,
      decision_input_catalog: result.decisionInputCatalogBytes,
      augment_stage_authority: result.augmentStageAuthorityBytes,
      runtime_catalog_overlay: result.runtimeCatalogOverlayBytes,
    },
  };
}

async function compile(options) {
  assertIdentity(options, { requireFingerprint: options.write });
  if (options.write) {
    const { archived } = await registeredPatch(options);
    if (archived) throw new Error(`Season ${options.seasonId} is archived and cannot compile a writable candidate`);
  }
  const result = await compileGameKnowledge({
    repoRoot,
    knowledgeRoot,
    seasonId: options.seasonId,
    patchId: options.patchId,
    expectedCoreProfileId: options.expectedCoreProfileId || null,
    write: options.write,
  });
  return {
    phase: "compile",
    core_profile_id: result.combinedFingerprint,
    candidate_profile: path.relative(repoRoot, result.candidateProfilePath).replaceAll("\\", "/"),
    activation_blockers: result.candidateProfile.activation_blockers,
    write_status: result.writeStatus,
  };
}

async function rankings(options) {
  assertIdentity(options, { requireFingerprint: true });
  const { archived } = await registeredPatch(options);
  if (archived) throw new Error(`Season ${options.seasonId} is archived and cannot refresh Tencent rankings`);
  let update;
  try {
    update = await runNodeScriptJson(containedFile(rankingsUpdateTool, "Tencent ranking update tool"), [
      "--season", options.seasonId,
      "--patch", options.patchId,
      "--expected-core-profile-id", options.expectedCoreProfileId,
      "--defer-activation",
    ]);
  } catch (error) {
    const diagnostic = String(error?.message || error || "");
    const unavailable = /JCC_TENCENT_(?:RANKINGS|TRANSPORT)_UNAVAILABLE/u.test(diagnostic);
    if (!unavailable) throw error;
    return {
      phase: "rankings",
      ...(options.requestedPhase === "intelligence" ? { compatibility_alias: "intelligence" } : {}),
      status: "unavailable",
      degraded: true,
      season_id: options.seasonId,
      patch_id: options.patchId,
      core_profile_id: options.expectedCoreProfileId,
      source: "tencent_jcc_master_plus",
      reason: "compatible_tencent_rankings_unavailable_or_invalid",
      active_pointer_preserved: true,
      diagnostic: diagnostic.slice(0, 1000),
    };
  }
  const maintenance = await finalizePreparedRankingMaintenance(update, options);
  const publication = maintenance?.publication_status
    ? {
        ok: maintenance.ok === true && maintenance.repair_required !== true,
        status: new Set(["committed_needs_repair", "committed_needs_history_repair"])
          .has(maintenance.publication_status)
          ? maintenance.publication_status
          : "published",
        degraded: maintenance.ok !== true || maintenance.repair_required === true,
        retryable: maintenance.ok !== true || maintenance.repair_required === true,
        ranking_overlay_published: maintenance.ok === true && maintenance.repair_required !== true,
        active_pointer_preserved: maintenance.ok !== true
          || maintenance.repair_required === true
          || maintenance.ranking_target?.publication_scope === "candidate",
      }
    : classifyRankingPipelineUpdate(update);
  let cleanup = null;
  if (publication.ranking_overlay_published === true && publication.active_pointer_preserved !== true) {
    try {
      cleanup = { ok: true, status: "completed", ...(await prune({
        ...options,
        retainPrevious: Number.isFinite(options.retainPrevious) ? options.retainPrevious : 2,
      })) };
    } catch (error) {
      cleanup = { ok: false, status: "degraded", error: String(error?.message || error).slice(0, 1000) };
    }
  }
  return {
    phase: "rankings",
    ...(options.requestedPhase === "intelligence" ? { compatibility_alias: "intelligence" } : {}),
    ...publication,
    season_id: options.seasonId,
    patch_id: options.patchId,
    core_profile_id: options.expectedCoreProfileId,
    source: "tencent_jcc_master_plus",
    stat_date: update?.stat_date || null,
    output_dir: maintenance?.output_dir || update?.output_dir || null,
    maintenance: maintenance || (publication.status === "prepared"
      ? {
          status: "required_before_finalize",
          prepared_generation_id: update?.sync?.prepared_generation?.generation_id || null,
          prepared_recipe_generation_id: update?.sync?.recipe_capabilities?.combined?.generation_id || null,
          prepared_pointer_file: update?.sync?.prepared_pointer_file || null,
          expected_active_generation_id: update?.sync?.expected_active_generation_id || null,
          finalizer: "tools/finalize-jcc-ranking-maintenance.mjs",
        }
      : null),
    cleanup,
    update,
  };
}

async function verify(options = {}) {
  let candidateHardDataManifest = null;
  if (options.expectedCoreProfileId) {
    assertIdentity(options, { requireFingerprint: true });
    const compilation = await compileGameKnowledge({
      repoRoot,
      knowledgeRoot,
      seasonId: options.seasonId,
      patchId: options.patchId,
      expectedCoreProfileId: options.expectedCoreProfileId,
      write: false,
    });
    candidateHardDataManifest = compilation.candidateProfile?.runtime_identity?.hard_data_manifest || null;
    if (!candidateHardDataManifest) {
      throw new Error("Candidate Core Profile is missing its hard-data manifest identity");
    }
  }
  const contract = await readJson(harnessContractFile);
  for (const relativeScript of contract.verification_profiles.version_update || []) {
    const verifierArgs = relativeScript === "tools/verify-jcc-hard-data.mjs" && candidateHardDataManifest
      ? ["--candidate-manifest", candidateHardDataManifest]
      : [];
    await runNodeScript(containedFile(relativeScript, "version verifier"), verifierArgs);
  }
  let adapterVerifierCount = 0;
  let archivedAdapterVerifierStatus = null;
  if (options.seasonId || options.patchId) {
    const { patch, archived } = await registeredPatch(options);
    const adapterVerifiers = patch.source_adapter?.verifiers;
    if ((!Array.isArray(adapterVerifiers) || adapterVerifiers.length === 0) && !archived) {
      throw new Error(`Patch ${options.patchId} has no registered source adapter verifiers`);
    }
    if (archived && (!Array.isArray(adapterVerifiers) || adapterVerifiers.length === 0)) {
      archivedAdapterVerifierStatus = "not_retained_in_frozen_source_manifest";
    }
    for (const verifier of adapterVerifiers || []) {
      await runNodeScript(
        containedToolFile(verifier.command, "source adapter verifier"),
        expandAdapterArguments(verifier.arguments, options, patch),
      );
      adapterVerifierCount += 1;
    }
  }
  if (options.expectedCoreProfileId) {
    await compileGameKnowledge({
      repoRoot,
      knowledgeRoot,
      seasonId: options.seasonId,
      patchId: options.patchId,
      expectedCoreProfileId: options.expectedCoreProfileId,
      write: false,
    });
  }
  return {
    phase: "verify",
    verifier_count: (contract.verification_profiles.version_update || []).length + adapterVerifierCount,
    source_adapter_verifier_count: adapterVerifierCount,
    ...(archivedAdapterVerifierStatus ? { archived_source_adapter_verifier_status: archivedAdapterVerifierStatus } : {}),
  };
}

async function promote(options) {
  assertIdentity(options, { requireFingerprint: true });
  const { archived } = await registeredPatch(options);
  if (archived) throw new Error(`Season ${options.seasonId} is archived and cannot be promoted`);
  const candidateProfilePath = path.join(knowledgeRoot, "candidates", "candidate-profile.json");
  const candidate = await readJson(candidateProfilePath);
  if (candidate.combined_fingerprint !== options.expectedCoreProfileId) throw new Error("Candidate does not match --expected-core-profile-id");
  if (candidate.season_id !== options.seasonId || candidate.patch_id !== options.patchId) throw new Error("Candidate season/patch does not match promotion request");
  if ((candidate.activation_blockers || []).length > 0) {
    throw new Error(`Candidate has activation_blockers: ${candidate.activation_blockers.join(", ")}`);
  }
  const snapshotPath = path.join(knowledgeRoot, "candidates", `.promotion-${process.pid}-${randomUUID()}.json`);
  const candidateBytes = await readFile(candidateProfilePath, "utf8");
  const rankingCandidateFile = path.join(liveRankingsRoot, "candidates", `${options.expectedCoreProfileId}.json`);
  const rankingCandidate = await readJsonIfExists(rankingCandidateFile);
  let verifiedRankingCandidate = null;
  if (rankingCandidate) {
    if (
      rankingCandidate.schema !== "jcc-live-ranking-candidate-pointer-v1"
      || rankingCandidate.status !== "ready"
      || rankingCandidate.core_profile_id !== options.expectedCoreProfileId
      || rankingCandidate.season_id !== options.seasonId
      || rankingCandidate.patch_id !== options.patchId
      || !/^[a-f0-9]{64}$/u.test(String(rankingCandidate.recipe_generation_id || ""))
    ) {
      throw new Error("Ranking candidate pointer is not ready for the promoted Core Profile");
    }
    verifiedRankingCandidate = await verifyLiveRankingGeneration({
      rootDir: liveRankingsRoot,
      generationId: rankingCandidate.generation_id,
    });
    await runNodeScript(containedFile("tools/verify-jcc-live-rankings.mjs", "ranking verifier"), [
      "--dir", verifiedRankingCandidate.generation_dir,
      "--profile", "candidate",
      "--season", options.seasonId,
      "--patch", options.patchId,
      "--expected-core-profile-id", options.expectedCoreProfileId,
    ]);
  } else {
    throw new Error("Core Profile promotion requires a semantically maintained Ranking candidate and paired recipe candidate");
  }
  await writeFile(snapshotPath, candidateBytes, { encoding: "utf8", flag: "wx" });
  let rankingLease = null;
  try {
    await verify(options);
    const currentCandidateBytes = await readFile(candidateProfilePath, "utf8");
    if (currentCandidateBytes !== candidateBytes) throw new Error("Candidate changed during promotion verification");
    let preparedRankingClosure = null;
    if (verifiedRankingCandidate) {
      rankingLease = await acquireLiveRankingRefreshLease({ rootDir: liveRankingsRoot });
      const recipeGenerationId = String(rankingCandidate.recipe_generation_id || "");
      readRankingRecipeGenerationSync({
        rootDir: liveRankingsRoot,
        generationId: recipeGenerationId,
        expectedIdentity: {
          core_profile_id: options.expectedCoreProfileId,
          season_id: options.seasonId,
          patch_id: options.patchId,
        },
      });
      preparedRankingClosure = validateRankingClosureCandidateSync({
        rootDir: liveRankingsRoot,
        rankingGenerationId: rankingCandidate.generation_id,
        recipeGenerationId,
        statDate: verifiedRankingCandidate.metadata.stat_date,
        identity: verifiedRankingCandidate.metadata,
      });
    }
    if (preparedRankingClosure) {
      const publication = await completeCoreRankingPublicationTransaction({
        rootDir: liveRankingsRoot,
        rankingGenerationId: rankingCandidate.generation_id,
        recipeGenerationId: preparedRankingClosure.recipe_generation_id,
        statDate: verifiedRankingCandidate.metadata.stat_date,
        identity: verifiedRankingCandidate.metadata,
        lease: rankingLease,
        readActiveCoreProfile: () => readJson(path.join(knowledgeRoot, "active-profile.json")),
        promoteCoreProfile: () => promoteGameKnowledgeCandidate({
          knowledgeRoot,
          candidateProfilePath: snapshotPath,
          expectedCoreProfileId: options.expectedCoreProfileId,
        }),
      });
      if (publication.status !== "committed") {
        return {
          phase: "promote",
          ok: false,
          status: "repair_required",
          retryable: true,
          core_profile_id: publication.active_core_profile.core_profile_id,
          active_profile: path.relative(repoRoot, path.join(knowledgeRoot, "active-profile.json")).replaceAll("\\", "/"),
          ranking_overlay_id: publication.active_closure.ranking_generation_id,
          ranking_recipe_generation_id: publication.active_closure.recipe_generation_id,
          ranking_legacy_mirror_id: publication.mirrors?.ranking?.pointer?.generation_id || null,
          ranking_recipe_legacy_mirror_id: publication.mirrors?.recipe?.pointer?.generation_id || null,
          ranking_mirror_errors: publication.mirrors?.errors || [],
          ranking_status: publication.status,
          publication_transaction_id: publication.transaction_id,
          publication_resumed: publication.resumed,
          repair_required: true,
          pruning_required: false,
        };
      }
      return {
        phase: "promote",
        core_profile_id: publication.active_core_profile.core_profile_id,
        active_profile: path.relative(repoRoot, path.join(knowledgeRoot, "active-profile.json")).replaceAll("\\", "/"),
        ranking_overlay_id: publication.active_closure.ranking_generation_id,
        ranking_recipe_generation_id: publication.active_closure.recipe_generation_id,
        ranking_legacy_mirror_id: publication.mirrors?.ranking?.pointer?.generation_id || null,
        ranking_recipe_legacy_mirror_id: publication.mirrors?.recipe?.pointer?.generation_id || null,
        ranking_mirror_errors: publication.mirrors?.errors || [],
        ranking_status: "activated",
        publication_transaction_id: publication.transaction_id,
        publication_resumed: publication.resumed,
        repair_required: false,
        pruning_required: true,
      };
    }
    throw new Error("Core Profile promotion requires a validated Ranking publication closure");
  } finally {
    if (rankingLease) await rankingLease.release();
    await rm(snapshotPath, { force: true });
  }
}

async function archive(options) {
  assertIdentity(options, { requirePatch: false });
  const result = await archiveSeason({ repoRoot, seasonId: options.seasonId, finalCoreProfileId: options.expectedCoreProfileId || null, write: options.write });
  return { phase: "archive", season_id: options.seasonId, output_file: path.relative(repoRoot, result.outputFile).replaceAll("\\", "/"), written: options.write };
}

async function archivedCoreProfileIds() {
  const manifest = await readJson(path.join(knowledgeRoot, "manifest.json"));
  const ids = [];
  for (const relativeArchive of Object.values(manifest.season_archives || {})) {
    const archive = await readJson(path.join(knowledgeRoot, relativeArchive));
    for (const entry of archive.generated_core_profiles || []) ids.push(entry.core_profile_id);
  }
  return ids;
}

async function prune(options) {
  const keepPrevious = Number.isFinite(options.retainPrevious) ? options.retainPrevious : 2;
  const pendingPublication = readCoreRankingPublicationIntentSync({ rootDir: liveRankingsRoot });
  if (pendingPublication) {
    throw new Error(`cannot prune generated data while Ranking publication repair is pending: ${pendingPublication.intent.transaction_id}`);
  }
  const activeRankingTarget = await resolveRankingTarget({ repoRoot, argv: ["--profile", "active"] });
  const activeClosure = resolveActiveRankingClosureSync({
    rootDir: liveRankingsRoot,
    expectedIdentity: {
      core_profile_id: activeRankingTarget.core_profile_id,
      season_id: activeRankingTarget.season_id,
      patch_id: activeRankingTarget.patch_id,
      catalog_fingerprint: activeRankingTarget.catalog_source_fingerprint,
      hard_data_manifest_fingerprint: activeRankingTarget.hard_data_manifest_fingerprint,
    },
  });
  if (activeClosure.closure_status === "invalid") {
    throw new Error(`cannot prune generated data while the active Ranking closure is invalid: ${activeClosure.reason || "unknown reason"}`);
  }
  const closureRankingIds = activeClosure.availability === "available"
    ? [activeClosure.ranking_generation_id]
    : [];
  const closureRecipeIds = activeClosure.availability === "available"
    ? [activeClosure.recipe_generation_id]
    : [];
  const generationLeases = await readGameKnowledgeGenerationLeases({ leaseFile: generationLeaseFile });
  const coreProfiles = await pruneGameKnowledgeGenerations({
    knowledgeRoot,
    retainPrevious: keepPrevious,
    protectedCoreProfileIds: await archivedCoreProfileIds(),
    generationLeases,
  });
  const hardData = await pruneHardDataGenerations({ repoRoot });
  if (!coreProfiles.current_profile_ids?.includes(activeRankingTarget.core_profile_id)) {
    throw new Error("cannot prune rankings without the current active Core retention identity");
  }
  const rankingLease = await acquireLiveRankingRefreshLease({ rootDir: liveRankingsRoot });
  try {
    const recipeGenerationIds = (await readdir(path.join(liveRankingsRoot, "recipe-generations"), { withFileTypes: true })
      .catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error)))
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/u.test(entry.name))
      .map((entry) => entry.name);
    const rankings = await pruneLiveRankingGenerations({
      rootDir: liveRankingsRoot,
      keepPrevious,
      validCoreProfileIds: coreProfiles.current_profile_ids,
      protectedGenerationIds: closureRankingIds,
      validRecipeGenerationIds: recipeGenerationIds,
      leasedGenerationIds: generationLeases
        .map((lease) => lease.ranking_overlay_id)
        .filter(Boolean),
      lease: rankingLease,
    });
    const rankingRecipes = await pruneRankingRecipeGenerations({
      rootDir: liveRankingsRoot,
      protectedCoreProfileIds: coreProfiles.current_profile_ids,
      protectedGenerationIds: [
        ...closureRecipeIds,
        ...rankings.candidate_recipe_generation_ids,
        ...generationLeases.map((lease) => lease.recipe_generation_id).filter(Boolean),
      ],
      keepPrevious,
      lease: rankingLease,
    });
    return { phase: "prune", core_profiles: coreProfiles, hard_data: hardData, rankings, ranking_recipes: rankingRecipes };
  } finally {
    await rankingLease.release();
  }
}

export async function runVersionPipeline(options) {
  const normalized = options.phase === "intelligence"
    ? { ...options, phase: "rankings", requestedPhase: "intelligence" }
    : options;
  const actions = { source, inspect, compile, rankings, verify, promote, archive, prune };
  return actions[normalized.phase](normalized);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runVersionPipeline(parseArguments(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify({ ok: true, schema: "jcc-version-pipeline-result-v1", ...result }, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
