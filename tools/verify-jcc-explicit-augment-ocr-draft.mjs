import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDecisionInputCatalog,
  listDecisionInputCandidates,
} from "../ui/electron/decision-input-catalog.js";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import {
  getRuntimeServiceState,
  handleRuntimeAction,
  resolveExplicitAugmentOcrDraftCandidates,
  shouldRunBackgroundSelfStateRefresh,
  setExplicitAugmentChoiceDraftOcrRunnerForTest,
  setRuntimeServiceEventWriter,
  setRuntimeServiceState,
} from "../ui/electron/runtime-service.js";
import { augmentChoiceOcrAttemptTimeoutMs } from "../ui/electron/augment-choice-draft-ocr.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePaths = createRuntimePaths(repoRoot);
assert.equal(augmentChoiceOcrAttemptTimeoutMs(), 15000, "Quick OCR must bound one hot click independently from the worker startup budget");
assert.equal(augmentChoiceOcrAttemptTimeoutMs("invalid"), 15000, "invalid Quick OCR timeout configuration must fail to the bounded default");

setRuntimeServiceState({
  match_session: { status: "active", match_session_id: "verify-augment-ocr-reservation" },
  active_mode: "augment_choice",
  response_task: { status: "idle", response_task_id: null },
  self_state_refresh: null,
});
assert.equal(
  shouldRunBackgroundSelfStateRefresh(),
  false,
  "augment mode must reserve the shared OCR lane and block new background HUD OCR jobs",
);
setRuntimeServiceState({
  match_session: { status: "active", match_session_id: "verify-augment-ocr-starvation" },
  active_mode: "augment_choice",
  response_task: { status: "idle", response_task_id: null },
  self_state_refresh: { last_completed_at: new Date(Date.now() - 31_000).toISOString() },
});
assert.equal(
  shouldRunBackgroundSelfStateRefresh(),
  true,
  "a foreground choice card must not starve HP and economy refresh beyond the bounded 30-second window",
);
setRuntimeServiceState({
  match_session: { status: "active", match_session_id: "verify-augment-ocr-reservation" },
  active_mode: "cruise",
  response_task: { status: "idle", response_task_id: null },
  self_state_refresh: null,
});
assert.equal(
  shouldRunBackgroundSelfStateRefresh(),
  true,
  "background HUD OCR may resume after the player returns to Cruise",
);
const activeCatalogSource = JSON.parse(readFileSync(runtimePaths.activeDecisionInputCatalogFile, "utf8"));
assert.equal(activeCatalogSource.source_identity?.season_id, "s18");
assert.deepEqual(activeCatalogSource.choice_descriptors?.augment?.stages, ["2-1", "3-2", "4-2"]);
assert.equal(activeCatalogSource.choice_descriptors?.augment?.stage_authority_source, "datatft_s18_database_snapshot");
const activeCatalog = createDecisionInputCatalog(activeCatalogSource);
const exactStageGold = listDecisionInputCandidates(activeCatalog, {
  kind: "augment",
  round: "2-1",
  tier: "gold",
});
assert(exactStageGold.length >= 3, "the exact-stage dropdown must use the active supplemental stage authority");
assert(exactStageGold.every((row) => row.current_stage_eligible === true && row.stage_unknown === false));
const unknownStageGold = listDecisionInputCandidates(activeCatalog, {
  kind: "augment",
  round: "2-1",
  tier: "gold",
  includeUnknownRound: true,
  searchScope: "global_search",
}).filter((row) => row.stage_unknown === true);
assert(unknownStageGold.length >= 3, "global search must retain unmatched official augments for explicit discovery");
assert(unknownStageGold.every((row) => row.stage_unknown === true && row.current_stage_eligible === false));

const fixtureRows = unknownStageGold.slice(0, 3);
const fixtureAddresses = new Set(fixtureRows.map((row) => row.ref.address));
const fixtureCatalogSource = {
  ...activeCatalogSource,
  entities: activeCatalogSource.entities.map((entity) => fixtureAddresses.has(entity.address)
    ? { ...entity, rounds: ["2-1"], round_bucket: "known_round", stage_unknown: false, stage_authority: "verifier_fixture" }
    : entity),
};
const catalog = createDecisionInputCatalog(fixtureCatalogSource);
const pinnedCatalogDir = mkdtempSync(path.join(tmpdir(), "jcc-pinned-decision-catalog-"));
const pinnedCatalogFile = path.join(pinnedCatalogDir, "decision-input-catalog.json");
writeFileSync(pinnedCatalogFile, JSON.stringify(fixtureCatalogSource));
const fixtureSeasonSnapshot = {
  core_profile_id: runtimePaths.activeCoreProfileId,
  core_profile_ref: runtimePaths.activeCoreProfile,
  core_profile_artifacts: { decision_input_catalog: pinnedCatalogFile },
  core_source_identity: catalog.source_identity,
};
const legal = listDecisionInputCandidates(catalog, {
  kind: "augment",
  round: "2-1",
  tier: "gold",
}).filter((row) => {
  const rounds = row.rounds || [];
  return row.tier_color === "gold" && rounds.includes("2-1") && !rounds.includes("3-2");
}).slice(0, 3);
assert.equal(legal.length, 3, "fixture requires three exact 2-1 gold augments");

const attempt = {
  ok: true,
  readable_choice_texts: legal.map((row, index) => ({
    slot: index + 1,
    text: row.name,
    catalog_match: { id: row.ref.id, name: row.name },
  })),
};
const resolved = await resolveExplicitAugmentOcrDraftCandidates({ attempt, catalog, stageRound: "2-1", tier: "gold" });
assert.equal(resolved.ok, true);
assert.equal(resolved.candidates.length, 3);
assert(resolved.candidates.every((entry) => entry.current_stage_eligible === true));

const partialAttempt = {
  ...attempt,
  ok: false,
  readable_choice_texts: [attempt.readable_choice_texts[0], attempt.readable_choice_texts[2]],
};
const partialResolved = await resolveExplicitAugmentOcrDraftCandidates({ partialAttempt, attempt: partialAttempt, catalog, stageRound: "2-1", tier: "gold" });
assert.equal(partialResolved.ok, true, "uniquely resolved partial OCR must be useful to the renderer draft");
assert.equal(partialResolved.complete, false, "two resolved slots must remain explicitly partial");
assert.equal(partialResolved.candidates.length, 2);
assert.deepEqual(partialResolved.candidates.map((entry) => entry.slot), [1, 3], "partial OCR must retain physical card slots");

const wrongStage = await resolveExplicitAugmentOcrDraftCandidates({ attempt, catalog, stageRound: "3-2", tier: "gold" });
assert.equal(wrongStage.ok, false, "2-1-only candidates must not populate a 3-2 draft");

const duplicate = await resolveExplicitAugmentOcrDraftCandidates({
  attempt: {
    ok: true,
    readable_choice_texts: [1, 2, 3].map((slot) => ({
      slot,
      text: legal[0].name,
      catalog_match: { id: legal[0].ref.id, name: legal[0].name },
    })),
  },
  catalog,
  stageRound: "2-1",
  tier: "gold",
});
assert.equal(duplicate.ok, false, "one OCR row cannot impersonate three distinct candidates");

const wrongIdentity = await resolveExplicitAugmentOcrDraftCandidates({
  attempt,
  catalog: { ...catalog, source_identity: { ...catalog.source_identity, active_patch_id: "s18_0" } },
  stageRound: "2-1",
  tier: "gold",
});
assert.equal(wrongIdentity.status, "explicit_ocr_draft_catalog_identity_mismatch");

const wrongManifestFingerprint = await resolveExplicitAugmentOcrDraftCandidates({
  attempt,
  catalog: {
    ...catalog,
    source_identity: {
      ...catalog.source_identity,
      hard_data_manifest_fingerprint: "stale-manifest-fingerprint",
    },
  },
  stageRound: "2-1",
  tier: "gold",
});
assert.equal(wrongManifestFingerprint.status, "explicit_ocr_draft_catalog_identity_mismatch", "an OCR draft catalog built from stale hard data must fail closed");

const matchSessionId = "verify-explicit-augment-ocr-draft";
setRuntimeServiceEventWriter(() => {});
setRuntimeServiceState({
  active_mode: "augment_choice",
  match_session: {
    status: "active",
    match_session_id: matchSessionId,
    season_version_snapshot: fixtureSeasonSnapshot,
  },
  match_context: { sentinel: "canonical-facts-must-not-change" },
  response_task: { status: "idle", response_task_id: null },
  runtime_settings: {
    schema: "jcc-runtime-settings-v1",
    diagnostic_evidence_enabled: true,
    diagnostic_retention_days: 7,
    source: "verification_fixture",
  },
});
let firstRunnerInput = null;
setExplicitAugmentChoiceDraftOcrRunnerForTest(async (input) => {
  firstRunnerInput = input;
  return attempt;
});
const actionResult = await handleRuntimeAction("captureDecisionInputOcrDraft", {
  mode: "augment",
  backend_mode: "augment_choice",
  choice_kind: "augment_choice",
  stage_round: "2-1",
  tier: "gold",
});
assert.equal(actionResult.status, "explicit_augment_ocr_draft_ready");
assert.equal(actionResult.draft_candidates.length, 3);
assert.match(
  String(firstRunnerInput?.debugEvidenceDir || ""),
  /augment-quick-ocr-latest$/,
  "production Quick OCR must retain one bounded latest panel diagnostic outside the transient attempt directory",
);
assert.equal(
  firstRunnerInput?.captureSource,
  "auto",
  "production Quick OCR must use ADB-first auto capture so an empty MuMu ADB screencap can fall back to NemuShell",
);
assert.equal(
  firstRunnerInput?.catalog,
  pinnedCatalogFile,
  "production Quick OCR must receive the match-captured decision catalog instead of resolving the latest active pointer inside the OCR runner",
);
assert.deepEqual(getRuntimeServiceState().match_context, { sentinel: "canonical-facts-must-not-change" });
assert.equal(getRuntimeServiceState().response_task?.response_task_id || null, null, "Quick OCR must not open a Host answer");

setExplicitAugmentChoiceDraftOcrRunnerForTest(async () => partialAttempt);
const partialActionResult = await handleRuntimeAction("captureDecisionInputOcrDraft", {
  mode: "augment",
  backend_mode: "augment_choice",
  choice_kind: "augment_choice",
  stage_round: "2-1",
  tier: "gold",
});
assert.equal(partialActionResult.status, "explicit_augment_ocr_draft_partial_ready");
assert.equal(partialActionResult.ok, true, "partial draft fill is a successful mechanical action");
assert.deepEqual(partialActionResult.draft_candidates.map((entry) => entry.slot), [1, 3]);
assert.equal(getRuntimeServiceState().response_task?.response_task_id || null, null, "partial Quick OCR must remain model-free");

let releaseOcr;
let markOcrStarted;
const ocrStarted = new Promise((resolve) => { markOcrStarted = resolve; });
setExplicitAugmentChoiceDraftOcrRunnerForTest(() => new Promise((resolve) => {
  releaseOcr = () => resolve(attempt);
  markOcrStarted();
}));
const firstRun = handleRuntimeAction("captureDecisionInputOcrDraft", {
  mode: "augment",
  backend_mode: "augment_choice",
  choice_kind: "augment_choice",
  stage_round: "2-1",
  tier: "gold",
});
await ocrStarted;
const concurrentRun = await handleRuntimeAction("captureDecisionInputOcrDraft", {
  mode: "augment",
  backend_mode: "augment_choice",
  choice_kind: "augment_choice",
  stage_round: "2-1",
  tier: "gold",
});
assert.equal(concurrentRun.status, "explicit_augment_ocr_draft_busy", "Quick OCR must remain single-flight");
releaseOcr();
assert.equal((await firstRun).status, "explicit_augment_ocr_draft_ready");

let releaseOldMatchOcr;
let markOldMatchOcrStarted;
const oldMatchOcrStarted = new Promise((resolve) => { markOldMatchOcrStarted = resolve; });
setExplicitAugmentChoiceDraftOcrRunnerForTest(({ matchSessionId: requestedMatchSessionId }) => {
  if (requestedMatchSessionId === "verify-explicit-augment-ocr-old-match") {
    return new Promise((resolve) => {
      releaseOldMatchOcr = () => resolve(attempt);
      markOldMatchOcrStarted();
    });
  }
  return Promise.resolve(attempt);
});
setRuntimeServiceState({
  active_mode: "augment_choice",
  match_session: { status: "active", match_session_id: "verify-explicit-augment-ocr-old-match", season_version_snapshot: fixtureSeasonSnapshot },
  response_task: { status: "idle", response_task_id: null },
});
const oldMatchRun = handleRuntimeAction("captureDecisionInputOcrDraft", {
  mode: "augment",
  backend_mode: "augment_choice",
  choice_kind: "augment_choice",
  stage_round: "2-1",
  tier: "gold",
});
await oldMatchOcrStarted;
setRuntimeServiceState({
  active_mode: "augment_choice",
  match_session: { status: "active", match_session_id: "verify-explicit-augment-ocr-new-match", season_version_snapshot: fixtureSeasonSnapshot },
  response_task: { status: "idle", response_task_id: null },
});
const newMatchRun = await handleRuntimeAction("captureDecisionInputOcrDraft", {
  mode: "augment",
  backend_mode: "augment_choice",
  choice_kind: "augment_choice",
  stage_round: "2-1",
  tier: "gold",
});
assert.equal(newMatchRun.status, "explicit_augment_ocr_draft_ready", "a new match must not inherit the old match's OCR single-flight lock");
releaseOldMatchOcr();
assert.equal((await oldMatchRun).status, "explicit_ocr_draft_stale_match", "an old match OCR completion must not populate the new match draft");

const wrongMode = await handleRuntimeAction("captureDecisionInputOcrDraft", {
  mode: "item",
  backend_mode: "item_choice",
  choice_kind: "item_choice",
  stage_round: "2-1",
  tier: "gold",
});
assert.equal(wrongMode.status, "explicit_ocr_draft_unsupported_mode", "Quick OCR must remain augment-only");
setExplicitAugmentChoiceDraftOcrRunnerForTest();
rmSync(pinnedCatalogDir, { recursive: true, force: true });

console.log(JSON.stringify({ ok: true, schema: "jcc-explicit-augment-ocr-draft-verification-v1" }, null, 2));
