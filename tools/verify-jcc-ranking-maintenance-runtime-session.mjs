import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import {
  acquireRankingMaintenanceWorkspaceLease,
  runRankingSemanticMaintenance,
} from "../ui/electron/runtime-service.js";

const identity = {
  runtime_season_id: "s18",
  active_patch_id: "s18_1",
  game_mode_id: "jcc-mode18",
  core_profile_id: "a".repeat(64),
  hard_data_manifest_fingerprint: "b".repeat(64),
  catalog_source_fingerprint: "c".repeat(64),
  battle_type: "31",
  lineup_version_id: "v6",
  ranking_set_id: "18",
};

const packet = {
  schema: "jcc-ranking-maintenance-packet-v1",
  target_identity: identity,
  stat_date: "20260823",
  authority: {},
  common_summary: {},
  core_summary: {},
  records: [{ lineup_id: "lineup-a", semantic_hash: "d".repeat(64) }],
  input_hash: "e".repeat(64),
};

let calls = 0;
let capturedOptions = null;
const success = await runRankingSemanticMaintenance(packet, {
  ensureHost: async () => ({
    available: true,
    provider: "codex",
    command: "codex",
    selected_model: "runtime-selected-model",
  }),
  runHost: async (_host, prompt, options) => {
    calls += 1;
    capturedOptions = options;
    const batch = JSON.parse(prompt.split("输入数据如下：\n")[1].split("\n输出形状：")[0]);
    return {
      ok: true,
      response: {
        schema: "jcc-ranking-maintenance-response-v1",
        target_identity: batch.target_identity,
        input_hash: batch.input_hash,
        annotations: [{
          lineup_id: "lineup-a",
          confidence: "medium",
          formation_burden: "medium",
          flexibility: "medium",
          strategy_style: "standard_leveling",
          condition_flags: [],
          rationale_codes: ["new_current_day_recipe"],
        }],
      },
    };
  },
  taskId: "verify-ranking-maintenance-session",
});

assert.equal(calls, 1, "one update must create exactly one model maintenance call when semantic records changed");
assert.equal(success.receipt.status, "ready");
assert.equal(success.receipt.ephemeral, true);
assert.equal(success.receipt.host_session_key, null);
assert.equal(Object.hasOwn(capturedOptions, "hostSessionKey"), false,
  "maintenance must not join or mutate the persistent lobby/match provider sessions");
assert.equal(Object.hasOwn(capturedOptions, "hostSessionId"), false,
  "maintenance must never resume a provider-native conversation");
assert.equal(capturedOptions.parseJson, true);
assert.match(capturedOptions.taskId, /^verify-ranking-maintenance-session:1:attempt-1$/u);
assert.match(capturedOptions.outputSchemaPath, /tools[\\/]schemas[\\/]jcc-ranking-maintenance-response-v1\.json$/u);
assert.equal(capturedOptions.jsonResponseKind, "ranking_maintenance");
assert.equal(
  path.resolve(capturedOptions.hostCwd),
  path.join(createRuntimePaths(path.resolve(import.meta.dirname, "..")).runtimeDataRoot, "host-workspaces", "ranking-maintenance"),
  "ranking maintenance must use an isolated Runtime workspace and never let the Host adapter rewrite repository files",
);
assert.notEqual(path.resolve(capturedOptions.hostCwd), path.resolve("."));

let noChangeCalls = 0;
const noChange = await runRankingSemanticMaintenance({ ...packet, records: [] }, {
  ensureHost: async () => { throw new Error("no semantic changes must not discover a Host"); },
  runHost: async () => { noChangeCalls += 1; },
});
assert.equal(noChangeCalls, 0);
assert.equal(noChange.receipt.status, "not_required");
assert.equal(noChange.response_envelope.schema, "jcc-ranking-maintenance-not-required-v1");

const unavailable = await runRankingSemanticMaintenance(packet, {
  ensureHost: async () => ({ available: false }),
  runHost: async () => { throw new Error("unavailable Host must not be called"); },
});
assert.equal(unavailable.receipt.status, "degraded");
assert.equal(unavailable.response_envelope.failure_code, "selected_host_unavailable");

let transientHostChecks = 0;
let transientHostCalls = 0;
const transientAvailability = await runRankingSemanticMaintenance(packet, {
  ensureHost: async () => {
    transientHostChecks += 1;
    return transientHostChecks === 1
      ? { available: false }
      : { available: true, provider: "codex", selected_model: "test" };
  },
  runHost: async (_host, prompt) => {
    transientHostCalls += 1;
    const batch = JSON.parse(prompt.split("输入数据如下：\n")[1].split("\n输出形状：")[0]);
    return {
      ok: true,
      response: {
        schema: "jcc-ranking-maintenance-response-v1",
        target_identity: batch.target_identity,
        input_hash: batch.input_hash,
        annotations: [{
          lineup_id: "lineup-a",
          confidence: "medium",
          formation_burden: "medium",
          flexibility: "medium",
          strategy_style: "standard_leveling",
          condition_flags: [],
          rationale_codes: ["new_current_day_recipe"],
        }],
      },
    };
  },
  taskId: "verify-ranking-maintenance-transient-host",
});
assert.equal(transientAvailability.receipt.status, "ready");
assert.equal(transientHostChecks, 2,
  "a transient Host discovery miss must be retried within the same update attempt");
assert.equal(transientHostCalls, 1);

const malformed = await runRankingSemanticMaintenance(packet, {
  ensureHost: async () => ({ available: true, provider: "codex" }),
  runHost: async () => ({ ok: true, response: { score: 999 } }),
});
assert.equal(malformed.receipt.status, "degraded");
assert.equal(malformed.response_envelope.failure_code, "invalid_host_response");
assert.equal(malformed.receipt.failed_batch_attempt_count, 1,
  "optional semantic maintenance fails fast after one malformed Host result");
assert.match(malformed.receipt.failure_reason, /maintenance|schema|response|annotation/i);

const providerFailure = await runRankingSemanticMaintenance(packet, {
  ensureHost: async () => ({ available: true, provider: "codex" }),
  runHost: async () => ({ ok: false, error: "429: quota exhausted", stderr: "irrelevant warning\n".repeat(100) }),
});
assert.equal(providerFailure.receipt.failure_code, "host_rate_limited");
assert.equal(providerFailure.receipt.failure_reason, "429: quota exhausted");

let reusedCalls = 0;
const withReusedAnnotation = await runRankingSemanticMaintenance({
  ...packet,
  reused_annotations: [{
    lineup_id: "lineup-reused",
    semantic_hash: "f".repeat(64),
    annotation: {
      lineup_id: "lineup-reused",
      confidence: "high",
      formation_burden: "low",
      flexibility: "high",
      strategy_style: "flexible_transition",
      condition_flags: [],
      rationale_codes: ["semantic_profile_unchanged"],
    },
  }],
}, {
  ensureHost: async () => ({ available: true, provider: "codex" }),
  runHost: async (_host, prompt) => {
    reusedCalls += 1;
    const batch = JSON.parse(prompt.split("输入数据如下：\n")[1].split("\n输出形状：")[0]);
    return {
      ok: true,
      response: {
        schema: "jcc-ranking-maintenance-response-v1",
        target_identity: batch.target_identity,
        input_hash: batch.input_hash,
        annotations: [{
          lineup_id: "lineup-a",
          confidence: "medium",
          formation_burden: "medium",
          flexibility: "medium",
          strategy_style: "standard_leveling",
          condition_flags: [],
          rationale_codes: ["new_current_day_recipe"],
        }],
      },
    };
  },
});
assert.equal(withReusedAnnotation.receipt.status, "ready");
assert.equal(reusedCalls, 1);
assert.deepEqual(withReusedAnnotation.response_envelope.annotations.map((entry) => entry.lineup_id), ["lineup-a"],
  "reused annotations must not be injected into the changed-record Host response envelope");

const runtimeSource = await readFile("ui/electron/runtime-service.js", "utf8");
assert(runtimeSource.includes("async function ensureSelectedHostCli()"));
assert(runtimeSource.includes("ensureHost = ensureSelectedHostCli"));
assert(runtimeSource.includes("activeRuntimeCatalogOverlayFile")
  && runtimeSource.includes("runtimeCatalogOverlay?.champions_by_id")
  && runtimeSource.includes("runtimeCatalogOverlay?.traits_by_id"),
"ranking maintenance must derive champion and trait identity from the exact selected Core overlay");
const maintenanceRunPosition = runtimeSource.indexOf("const semanticMaintenance = await runRankingSemanticMaintenance");
const finalizePosition = runtimeSource.indexOf('runNodeTool("tools/finalize-jcc-ranking-maintenance.mjs"', maintenanceRunPosition);
const maintenanceToFinalizer = runtimeSource.slice(maintenanceRunPosition, finalizePosition);
assert(maintenanceRunPosition >= 0 && finalizePosition > maintenanceRunPosition
  && !maintenanceToFinalizer.includes('status: "semantic_maintenance_pending"'),
  "degraded optional semantic maintenance must continue to deterministic finalization");
assert(runtimeSource.includes("publication_repair_required")
  && runtimeSource.includes("finalizationSucceeded")
  && runtimeSource.includes("maintenanceWorkspaceLease.cleanup()"),
"Runtime must treat finalizer repair as retryable non-success and clean only through the owning workspace lease");

const leaseRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-ranking-maintenance-lease-"));
const leaseDirectory = path.join(leaseRoot, `run-${packet.input_hash}`);
try {
  const owner = await acquireRankingMaintenanceWorkspaceLease({
    directory: leaseDirectory,
    inputHash: packet.input_hash,
    ownerPid: 70001,
    ownerToken: "owner-token-0000000000000001",
    isProcessAlive: () => true,
  });
  await assert.rejects(
    acquireRankingMaintenanceWorkspaceLease({
      directory: leaseDirectory,
      inputHash: packet.input_hash,
      ownerPid: 70002,
      ownerToken: "owner-token-0000000000000002",
      isProcessAlive: () => true,
    }),
    /owned by another live lease/,
    "the same input hash must have exactly one live workspace owner",
  );
  await owner.release();

  let fakeNow = Date.now();
  const staleOwner = await acquireRankingMaintenanceWorkspaceLease({
    directory: leaseDirectory,
    inputHash: packet.input_hash,
    ttlMs: 10,
    ownerPid: 70003,
    ownerToken: "owner-token-0000000000000003",
    now: () => fakeNow,
    isProcessAlive: () => false,
  });
  await writeFile(path.join(leaseDirectory, "packet.json"), "preserved\n", "utf8");
  fakeNow += 20;
  const recovered = await acquireRankingMaintenanceWorkspaceLease({
    directory: leaseDirectory,
    inputHash: packet.input_hash,
    ttlMs: 1000,
    ownerPid: 70004,
    ownerToken: "owner-token-0000000000000004",
    now: () => fakeNow,
    isProcessAlive: () => false,
  });
  assert.equal((await readFile(path.join(leaseDirectory, "packet.json"), "utf8")).trim(), "preserved",
    "stale recovery must preserve prepared packet/checkpoint/response material");
  await assert.rejects(staleOwner.cleanup(), /ownership was lost/,
    "a recovered non-owner must never recursively delete the workspace");
  await recovered.cleanup();
  await assert.rejects(access(leaseDirectory), /ENOENT/);
} finally {
  await rm(leaseRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-ranking-maintenance-runtime-session-verification-v1",
  verified: [
    "exactly_one_ephemeral_host_call_for_semantic_changes",
    "isolated_host_workspace_preserves_repository_authoring_contracts",
    "no_lobby_or_match_session_key_or_resume",
    "zero_model_calls_for_numeric_or_no_semantic_changes",
    "host_unavailable_is_explicit_degraded_success",
    "malformed_model_output_is_quarantined_as_degraded",
    "malformed_model_output_is_retried_once_with_a_diagnostic_reason",
    "exact_core_overlay_supplies_champion_and_trait_identity",
    "one_owner_per_input_workspace",
    "stale_owner_recovery_preserves_recovery_material",
    "non_owner_recursive_cleanup_is_rejected",
  ],
}, null, 2));
