import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import {
  collectRuntimeChoiceModeContracts,
  loadActiveRulesBundle,
} from "./jcc_active_rules_contract.mjs";
import {
  lineupPinnedResultIsPublishable,
  normalizeLineupPinnedResult,
} from "../ui/electron/lineup-card-contract.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const verifierRuntimeRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-user-reported-choice-contract-"));
const previousRuntimeDataDir = process.env.JCC_RUNTIME_DATA_DIR;
const previousDisableCodexExec = process.env.JCC_UI_DISABLE_CODEX_EXEC;
process.env.JCC_RUNTIME_DATA_DIR = verifierRuntimeRoot;
process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";

async function read(relPath) {
  return readFile(path.join(repoRoot, relPath), "utf8");
}

function assertIncludes(source, needle, message) {
  assert(source.includes(needle), `${message}\nMissing: ${needle}`);
}

function assertNotIncludes(source, needle, message) {
  assert(!source.includes(needle), `${message}\nUnexpected: ${needle}`);
}

function sliceBetween(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle);
  assert(start >= 0, `${label} missing start marker: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `${label} missing end marker: ${endNeedle}`);
  return source.slice(start, end);
}

async function collectFiles(dir, predicate, out = []) {
  const entries = await readdir(path.join(repoRoot, dir), { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.join(dir, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "build", ".git", ".jcc-runtime-data", ".omx"].includes(entry.name)) {
        continue;
      }
      await collectFiles(rel, predicate, out);
    } else if (predicate(rel)) {
      out.push(rel);
    }
  }
  return out;
}

async function assertIdentifierAbsentInProduction(identifierParts, roots) {
  const identifier = identifierParts.join("");
  const checked = [];
  for (const root of roots) {
    const files = await collectFiles(
      root,
      (rel) => /\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(rel)
        && !/\/node_modules\//.test(rel)
        && !/\/dist\//.test(rel)
        && !/\/build\//.test(rel)
        && !/\/verify-jcc-/.test(rel),
    );
    for (const rel of files) {
      checked.push(rel);
      assertNotIncludes(await read(rel), identifier, `${identifier} must not remain in production action/API/tool code (${rel})`);
    }
  }
  return { identifier, checked_count: checked.length };
}

const runtimePaths = createRuntimePaths(repoRoot);
const activeRulesBundle = loadActiveRulesBundle({ repoRoot, runtimePaths });
const activeChoiceContracts = collectRuntimeChoiceModeContracts(activeRulesBundle);
const contractsByMode = new Map(activeChoiceContracts.map((contract) => [contract.mode, contract]));

const runtimeService = await read("ui/electron/runtime-service.js");
const app = await read("ui/src/App.tsx");
const runtimeBridge = await read("ui/src/runtimeBridge.ts");
const preload = await read("ui/electron/preload.js");
const decisionCard = await read("ui/src/components/DecisionInputCard.tsx");
const augmentDraftOcr = await read("ui/electron/augment-choice-draft-ocr.js");
const daemon = await read("ui/electron/runtime-daemon.js");
const lineupContract = await read("ui/electron/lineup-card-contract.js");
const choiceVisualRequestTool = await read("tools/request-jcc-choice-visual-refresh.mjs");
const pendingVisualRequestTool = await read("tools/run-jcc-pending-visual-request.mjs");

for (const mode of ["augment_choice", "item_choice"]) {
  assert(contractsByMode.has(mode), `active common choice contract missing ${mode}`);
}
const godContract = activeChoiceContracts.find((contract) => contract.kind === "god" || /god/i.test(contract.mode));
assert.equal(godContract, undefined, "active S18 rules must not compile the retired S17 star-god choice contract");

for (const contract of [contractsByMode.get("augment_choice"), contractsByMode.get("item_choice")]) {
  assert.equal(
    contract.candidate_input_policy,
    "current_match_user_report",
    `${contract.mode} must require a current-match user report for visible candidates`,
  );
  assert.equal(
    contract.user_report_contract?.no_ocr_or_vision_fallback,
    true,
    `${contract.mode} must explicitly disable OCR/vision fallback in its user-report contract`,
  );
  assert(String(contract.user_report_contract?.report_prompt || "").trim(), `${contract.mode} must provide a user-report prompt`);
  assert(String(contract.user_report_contract?.refresh_report_prefix || "").trim(), `${contract.mode} must provide a refresh-report prefix`);
}

const refreshChoiceRuntimeModeSetsBody = sliceBetween(
  runtimeService,
  "function refreshChoiceRuntimeModeSets",
  "refreshChoiceRuntimeModeSets(activeRulesBundle);",
  "refreshChoiceRuntimeModeSets",
);
assertIncludes(refreshChoiceRuntimeModeSetsBody, 'manualReportChoiceRuntimeModes.add(contract.mode)', "active choice modes must enter the manual-report set");
assertIncludes(refreshChoiceRuntimeModeSetsBody, "Unsupported active choice candidate policy", "unsupported active choice policies must fail closed");
assertNotIncludes(refreshChoiceRuntimeModeSetsBody, "choiceVisualRuntimeModes.add", "active user-report choice modes must not enter visual fallback mode set");
assertNotIncludes(refreshChoiceRuntimeModeSetsBody, "fastTextChoiceRuntimeModes.add", "active user-report choice modes must not enter OCR fast-text mode set");
assertNotIncludes(refreshChoiceRuntimeModeSetsBody, 'visualRuntimeModes.add(contract.mode)', "active user-report choice modes must not enter visual runtime mode set");
for (const choiceOcrModule of [
  "run-jcc-augment-choice-roi-ocr.mjs",
  "run-jcc-god-choice-roi-ocr.mjs",
  "run-jcc-item-choice-roi-ocr.mjs",
]) {
  assertNotIncludes(runtimeService, `from \"../../tools/${choiceOcrModule}\"`, `production runtime must not import calibration-only ${choiceOcrModule}`);
}
assertIncludes(runtimeService, 'from "./augment-choice-draft-ocr.js"', "production runtime may use only the explicit draft-only augment OCR boundary");
assertIncludes(runtimeService, "async function captureDecisionInputOcrDraft", "runtime must expose an explicit augment OCR draft action");
const explicitDraftBody = sliceBetween(
  runtimeService,
  "async function captureDecisionInputOcrDraft",
  "async function submitDecisionInput",
  "captureDecisionInputOcrDraft",
);
assertIncludes(explicitDraftBody, 'mode !== "augment_choice"', "explicit OCR draft must be augment-only");
assertIncludes(explicitDraftBody, 'persistence_policy: "renderer_draft_only_no_canonical_choice_write"', "OCR result must remain a renderer draft");
assertIncludes(explicitDraftBody, 'host_answer_policy: "none"', "OCR draft must not open a Host answer");
assertNotIncludes(explicitDraftBody, "recordStructuredReportedChoiceSet", "OCR draft must not persist a canonical candidate set");
assertNotIncludes(explicitDraftBody, "enqueueExplicitStructuredRuntimeEventFollowup", "OCR draft must not create a strategy answer owner");
assertIncludes(augmentDraftOcr, "runAugmentChoiceRoiOcrAttempt", "draft boundary must reuse the calibrated mechanical OCR attempt");
assertIncludes(decisionCard, "captureDecisionInputOcrDraft", "augment card must expose the explicit draft action");
assertIncludes(decisionCard, 'mode.id === "augment"', "quick OCR control must be scoped to augment mode");
assertIncludes(decisionCard, "原卡片内容未改动", "incomplete OCR must preserve the existing card draft");
assertIncludes(runtimeService, "function choiceOcrWorkerAdapter", "legacy compatibility callers must encounter an explicit production fence");
const choiceOcrAdapterBody = sliceBetween(
  runtimeService,
  "function choiceOcrWorkerAdapter",
  "function itemChoiceKindForOcrWorker",
  "choiceOcrWorkerAdapter",
);
assertIncludes(choiceOcrAdapterBody, "return null;", "production choice OCR adapter must be disabled");
assertNotIncludes(choiceOcrAdapterBody, "run_attempt", "production choice OCR adapter must not expose calibration runners");
for (const [label, source] of [
  ["choice visual request helper", choiceVisualRequestTool],
  ["pending visual request consumer", pendingVisualRequestTool],
]) {
  assertIncludes(source, "--compatibility-calibration", `${label} must require an explicit compatibility-calibration capability`);
  assertIncludes(source, "calibration-only", `${label} must identify choice visual intake as calibration-only`);
}
assertIncludes(choiceVisualRequestTool, "do_not_promote_choice_candidates", "choice visual calibration artifacts must forbid candidate promotion");
assertIncludes(pendingVisualRequestTool, "request?.compatibility_calibration !== true", "pending visual choice work must reject requests without calibration provenance");
assertIncludes(pendingVisualRequestTool, "options.compatibilityCalibration !== true", "pending visual choice work must require an explicit calibration invocation");

const phaseTriggerBody = sliceBetween(
  runtimeService,
  "async function maybeHandleRuntimePhaseTrigger",
  "async function runPipelineForMessage",
  "maybeHandleRuntimePhaseTrigger",
);
assertIncludes(phaseTriggerBody, "manualReportChoiceRuntimeModes.has(trigger.mode)", "phase-trigger handling must detect manual-report modes");
assertIncludes(phaseTriggerBody, 'candidate_input_policy: "current_match_user_report"', "phase-trigger handling must log user-report ownership");
assert(
  phaseTriggerBody.indexOf("manualReportChoiceRuntimeModes.has(trigger.mode)") < phaseTriggerBody.indexOf("ENABLE_STAGE_CHOICE_AUTO_SENSING"),
  "manual-report choice modes must return before opt-in phase OCR/vision sensing can run",
);
assertIncludes(phaseTriggerBody, "return null;", "manual-report phase triggers must exit without starting OCR/vision");

const choicePretriggerBody = sliceBetween(
  runtimeService,
  "async function maybeStartChoicePretrigger",
  "async function runChoicePretriggerLoop",
  "maybeStartChoicePretrigger",
);
assertIncludes(choicePretriggerBody, "manualReportChoiceRuntimeModes.has(configuredTrigger.mode)", "choice pretrigger must guard manual-report modes");
assert(
  choicePretriggerBody.indexOf("manualReportChoiceRuntimeModes.has(configuredTrigger.mode)") < choicePretriggerBody.indexOf("shouldStartChoicePretrigger(stageRound)"),
  "manual-report pretrigger guard must run before any pretrigger worker scheduling",
);

const userMessageBody = sliceBetween(
  runtimeService,
  "async function sendMessage",
  "async function pollCruiseAdvice",
  "sendMessage",
);
assertIncludes(userMessageBody, "manualReportChoiceRuntimeModes.has(requestedMode)", "user-message path must recognize manual-report choice modes");
assertIncludes(userMessageBody, "choice_candidate_report_required", "generic manual choice questions must be stopped at the user-report gate");
assertIncludes(userMessageBody, "currentUserReportedChoiceSetForAdvice", "manual choice Host turns must require a current user-reported choice set");
assertIncludes(userMessageBody, "messageRequiresCurrentChoiceCandidates(text)", "only exact current-window choice requests may fail closed without a current user-reported set");
assertIncludes(userMessageBody, "choiceCheckpointForModeStage(requestedMode, latestKnownStageRound(preMessageLiveState))", "missing candidates may block only an exact authoritative current choice checkpoint");
assert(
  userMessageBody.indexOf("manualReportChoiceRuntimeModes.has(requestedMode)") < userMessageBody.indexOf("visualRuntimeModes.has(requestedMode)"),
  "manual-report gate must run before visual-mode handling in user-message flow",
);

for (const [label, source] of [
  ["App.tsx", app],
  ["runtimeBridge.ts", runtimeBridge],
  ["preload.js", preload],
  ["runtime-service.js", runtimeService],
  ["runtime-daemon.js", daemon],
]) {
  assertNotIncludes(source, "requestAugmentReroll", `${label} must not expose requestAugmentReroll`);
  assertNotIncludes(source, "AugmentReroll", `${label} must not expose AugmentReroll API/action names`);
}
const removedIdentifierScan = await assertIdentifierAbsentInProduction(["request", "Augment", "Reroll"], ["ui", "tools"]);

assertIncludes(app, "prefillPreset(refreshReportPrompt);", "refresh-result UI control must prefill the descriptor-backed composer prompt");
assertIncludes(app, "setDraft(next);", "prefill controls must update draft text only");
assertIncludes(app, "textareaRef.current?.focus();", "prefill controls must focus the composer for manual editing/sending");
assertNotIncludes(app, "sendPreset(refreshReportPrompt)", "refresh-result UI control must not auto-send");
assertNotIncludes(app, "onAugmentReroll", "composer must not retain an augment reroll callback");
assertNotIncludes(app, "onPreset(", "composer must not route report chips through auto-send preset callbacks");

assertIncludes(lineupContract, 'schema: "jcc-internal-lineup-plan-v1"', "lineup normalizer must emit the internal lineup schema");
assertIncludes(lineupContract, 'inputSchema !== "jcc-internal-lineup-plan-v1"', "lineup normalizer must reject foreign schemas");
assertIncludes(lineupContract, "occupied.has(key)", "lineup publishability must reject duplicate board coordinates");
const normalizedLineup = normalizeLineupPinnedResult({
  schema: "jcc-internal-lineup-plan-v1",
  slot: "lineup",
  title: "Verify Duplicate Coordinates",
  units: [
    { row: 1, col: 1, name: "Alpha" },
    { row: 1, col: 1, name: "Beta" },
    { row: 2, col: 2, name: "Gamma" },
    { row: 2, col: 3, name: "Delta" },
    { row: 3, col: 3, name: "Epsilon" },
  ],
  loadouts: [{ unit: "Alpha", items: ["Item A"] }],
  moves: ["Move around the duplicate coordinate."],
});
assert.equal(normalizedLineup.schema, "jcc-internal-lineup-plan-v1", "normalized lineup must use jcc-internal-lineup-plan-v1");
assert.equal(
  lineupPinnedResultIsPublishable(normalizedLineup, { mode: "lineup_card" }),
  false,
  "duplicate board coordinates must reject lineup publishability",
);
assert.equal(normalizeLineupPinnedResult({ schema: "foreign-lineup-v1", units: [{ row: 1, col: 1, name: "Alpha" }] }), null, "foreign lineup schema must normalize to null");

assertIncludes(runtimeService, "function buildDecisionSnapshot", "runtime must build a task-scoped decision snapshot");
assertIncludes(runtimeService, "deepFreezeDecisionValue", "decision snapshots must use the code-owned deep freeze helper");
assertIncludes(runtimeService, "return deepFreezeDecisionValue({", "decision snapshot return value must be frozen by contract");
assertIncludes(runtimeService, "immutability_policy", "decision snapshot must carry an explicit immutability policy");
assertIncludes(runtimeService, "decision_snapshot: decisionSnapshot", "Host request context must carry the frozen decision snapshot");

const serviceUrl = `${pathToFileURL(path.join(repoRoot, "ui/electron/runtime-service.js")).href}?user-reported-choice-contract-${Date.now()}`;
let service = null;
try {
service = await import(serviceUrl);
service.setRuntimeServiceState({
  schema: "jcc-ui-runtime-state-v1",
  active_mode: "augment_choice",
  match_session: { status: "active", match_session_id: "verify-user-report-contract" },
  match_context: {},
  response_task: { response_task_id: "verify-choice-task" },
  runtime_event_advice: { handled: {}, retry_pending: {}, last_by_category: {}, last_by_trigger: {}, last_started_at: null },
});
const firstReportedSet = service.buildUserReportedChoiceSet({
  text: "Alpha / Bravo / Charlie\uff1b\u88c5\u5907\uff1a\u5f13\u3001\u8170\u5e26",
  mode: "augment_choice",
  liveState: {
    phase: { stage_round: "2-1" },
    economy: { hp: 100, gold: 10, level: 3, xp: "0/6" },
  },
  observedAt: "2026-07-27T10:00:00.000Z",
});
assert(firstReportedSet, "first current-match augment report must create a choice set");
assert.equal(firstReportedSet.revision, 1, "first reported choice set must start at revision 1");
assert.equal(firstReportedSet.refreshed, false, "first reported choice set must not be marked refreshed");
assert.equal(firstReportedSet.choice_stage_round, "2-1", "first reported choice set must bind to the active choice checkpoint");
assert.deepEqual(firstReportedSet.candidates.map((entry) => entry.name), ["Alpha", "Bravo", "Charlie"]);
assert.equal(firstReportedSet.candidate_count, 3, "equipment facts appended to a 2-1 augment report must not become extra choice candidates");

const naturalVoiceReportedSet = service.buildUserReportedChoiceSet({
  text: "\u6211\u73b0\u5728\u770b\u5230\u7684\u4e09\u4e2a\u5f3a\u5316\u5206\u522b\u662f\u65b0\u7eaa\u5143\u3001\u4fbf\u643a\u953b\u7089\u548c\u56e2\u961f\u5efa\u8bbe\uff0c\u6211\u7684\u88c5\u5907\u662f\u5f13\u3001\u8170\u5e26\u3002",
  mode: "augment_choice",
  liveState: { phase: { stage_round: "2-1" } },
});
assert(naturalVoiceReportedSet, "natural voice-style reports must not require the prefill template syntax");
assert.deepEqual(
  naturalVoiceReportedSet.candidates.map((entry) => entry.name),
  ["\u65b0\u7eaa\u5143", "\u4fbf\u643a\u953b\u7089", "\u56e2\u961f\u5efa\u8bbe"],
  "natural voice-style reports must normalize conversational lead-ins and trailing punctuation",
);

const refreshedSet = service.buildUserReportedChoiceSet({
  text: "\u5237\u65b0\u540e\u662f\uff1aDelta / Echo / Foxtrot",
  mode: "augment_choice",
  previous: firstReportedSet,
  liveState: {
    phase: { stage_round: "2-1" },
    economy: { hp: 100, gold: 10, level: 3, xp: "0/6" },
  },
  observedAt: "2026-07-27T10:00:05.000Z",
});
assert(refreshedSet, "refresh report must create a replacement choice set");
assert.equal(refreshedSet.revision, 2, "refresh report must increment the choice-set revision");
assert.equal(refreshedSet.supersedes_revision, 1, "refresh report must name the superseded revision");
assert.equal(refreshedSet.refreshed, true, "refresh report must be marked refreshed");

const completedItemSet = service.buildUserReportedChoiceSet({
  text: "Item A / Item B / Item C / Item D / Item E\uff1b\u5f53\u524d\u88c5\u5907\uff1a\u5f13\u3001\u62f3\u5957",
  mode: "item_choice",
  itemChoiceKind: "completed_item_forge",
  liveState: { phase: { stage_round: "2-2" } },
});
assert(completedItemSet, "completed-item forge report must create a choice set");
assert.equal(completedItemSet.item_choice_kind, "completed_item_forge");
assert.equal(completedItemSet.expected_candidate_count, 5, "completed-item forge must require five reported candidates");
assert.equal(completedItemSet.candidate_count, 5, "current equipment appended to an item report must not become a choice candidate");

const choiceMatchContext = {
  match_session_id: "verify-user-report-contract",
  reported_choice_sets_by_mode: { augment_choice: refreshedSet },
  recent_user_messages: [{ text: "Pick the best current option", observed_at: "2026-07-27T10:00:06.000Z" }],
  updated_at: "2026-07-27T10:00:06.000Z",
};
assert.equal(
  service.currentUserReportedChoiceSetForAdvice(
    "augment_choice",
    { phase: { stage_round: "2-1" } },
    choiceMatchContext,
  )?.revision,
  2,
  "latest same-checkpoint report must own augment advice",
);
assert.equal(
  service.currentUserReportedChoiceSetForAdvice(
    "augment_choice",
    { phase: { stage_round: "2-2" } },
    choiceMatchContext,
  ),
  null,
  "a reported choice set must expire after the live stage advances past its checkpoint",
);
for (const text of [
  "这三个强化怎么选？",
  "这组海克斯哪个好，要不要刷新？",
  "帮我比较当前星神候选",
  "锻造器这几个拿哪一个",
]) {
  assert.equal(service.messageRequestsChoiceAdvice(text), true, `choice-shaped text must require a current report: ${text}`);
  assert.equal(service.messageRequiresCurrentChoiceCandidates(text), true, `exact current-window choice text must require candidates: ${text}`);
}
for (const text of [
  "分析这局的强化适配，我这两个强化适合什么阵容",
  "我这两个强化往哪个阵容方向走比较好",
  "后续想要什么强化",
  "结合已选强化给我阵容方向",
]) {
  assert.equal(service.messageRequiresCurrentChoiceCandidates(text), false, `non-window strategy questions must not be blocked by the current-candidate gate: ${text}`);
}
for (const text of [
  "这把玩什么阵容？",
  "现在要不要升人口？",
  "我想规划九人口上限",
]) {
  assert.equal(service.messageRequestsChoiceAdvice(text), false, `non-choice tactical chat must remain available: ${text}`);
}

const decisionSnapshot = service.buildDecisionSnapshot({
  mode: "augment_choice",
  hostRequest: { request_id: "verify-decision-request" },
  liveStateSummary: {
    observed_at: "2026-07-27T10:00:07.000Z",
    phase: { stage_round: "2-1" },
    economy: { hp: 97, gold: 18, level: 4, xp: "2/10" },
    shop: { units: [{ name: "Shop A" }, { name: "Shop B" }] },
  },
  matchContext: choiceMatchContext,
  matchFacts: {
    target_plan: { text: "Target composition", source: "user_confirmed", updated_at: "2026-07-27T10:00:06.000Z" },
    user_confirmed_equipment: { revision: 3 },
  },
});
assert(Object.isFrozen(decisionSnapshot), "decision snapshot root must be frozen");
assert(Object.isFrozen(decisionSnapshot.economy), "decision snapshot nested economy must be frozen");
assert(Object.isFrozen(decisionSnapshot.choice_set?.candidates), "decision snapshot choice candidates must be frozen");
assert.equal(decisionSnapshot.stage_round, "2-1", "decision snapshot must use the newest supplied stage");
assert.equal(decisionSnapshot.economy.gold, 18, "decision snapshot must use the newest supplied economy");
assert.equal(decisionSnapshot.choice_set?.revision, 2, "decision snapshot must capture the newest choice-set revision");
assert.equal(decisionSnapshot.equipment_revision, 3, "decision snapshot must capture the current equipment revision");

service.setRuntimeServiceState({
  ...service.getRuntimeServiceState(),
  active_mode: "cruise",
});
const gate = service.shouldStartAdviceForRuntimeEvent({
  type: "shop_decision_context_changed",
  layer: "decision_signal",
  semantic_key: "verify-choice-window-reservation",
  advice_eligible: true,
  stage_round: "2-1",
  decision_trigger_id: "shop_hold_sell_interest",
}, {
  schema: "jcc-live-state-v1",
  match_session_id: "verify-user-report-contract",
  phase: { stage_round: "2-1", status: 1 },
  economy: { hp: 100, gold: 10, level: 3, xp: "0/6" },
});
assert.equal(gate.ok, false, "choice windows must reserve the Host lane for user-reported/manual choice ownership");
assert.equal(gate.reason, "only_fixed_checkpoint_or_explicit_card_action_opens_host_answer", "choice-window facts must not open Host unless the user explicitly acts on the structured card");

const quietWindowVariablesGate = service.shouldStartAdviceForRuntimeEvent({
  type: "match_variables_changed",
  layer: "decision_signal",
  semantic_key: "verify-variables-before-first-choice",
  advice_eligible: true,
  stage_round: "1-4",
}, {
  schema: "jcc-live-state-v1",
  match_session_id: "verify-user-report-contract",
  phase: { stage_round: "1-4", status: 1 },
  economy: { hp: 100, gold: 10, level: 3, xp: "0/6" },
});
assert.equal(quietWindowVariablesGate.ok, false, "match-variable facts near 2-1 must not open a competing Host turn");
assert.equal(quietWindowVariablesGate.reason, "interaction_context_only", "1-4 variable facts must remain context-only for the first user-owned augment answer");

assertIncludes(runtimeService, "function buildProactiveCoachContentAgenda", "runtime must build a proactive content agenda");
const agendaBody = sliceBetween(
  runtimeService,
  "function buildProactiveCoachContentAgenda",
  "function responseTaskRuntimeEventPriority",
  "buildProactiveCoachContentAgenda",
);
for (const needle of [
  'schema: "jcc-proactive-coach-content-agenda-v1"',
  "retry_reason: event?.retry_reason || null",
  "deferred_after_choice_window: event?.deferred_after_choice_window === true",
  "freshness_policy:",
  "Use the newest decision snapshot",
  "Re-evaluate this agenda from the newest decision snapshot",
  "stage_round: stageRound || null",
  "next_checkpoint: effectiveSelected.next_checkpoint",
]) {
  assertIncludes(agendaBody, needle, `proactive agenda must carry freshness/retry field: ${needle}`);
}

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-user-reported-choice-contract-verifier-v1",
  checked: [
    "active S18 augment/item choice contracts require current_match_user_report",
    "active S18 rules do not compile the retired S17 star-god choice contract",
    "active user-report choice contracts declare no OCR/vision fallback",
    "manual-report runtime modes are excluded from active visual/OCR mode sets",
    "production runtime does not import or expose calibration-only choice OCR adapters",
    "choice visual compatibility tools require explicit calibration capability and cannot promote candidates",
    "phase and pretrigger sensing guard manual-report choice modes before OCR/vision setup",
    "UI report-result controls prefill only and no requestAugmentReroll action/API/tool remains",
    "lineup schema normalizes to jcc-internal-lineup-plan-v1 and duplicate coordinates reject publishability",
    "reported choice revisions replace prior sets and expire after their choice checkpoint",
    "choice-shaped free text fails closed without blocking unrelated tactical chat",
    "Host decision snapshots execute with newest stage/economy/revisions and are deeply frozen",
    "proactive content agenda carries freshness/retry metadata",
  ],
  active_choice_modes: activeChoiceContracts.map((contract) => ({
    mode: contract.mode,
    kind: contract.kind,
    policy: contract.candidate_input_policy,
    no_ocr_or_vision_fallback: contract.user_report_contract?.no_ocr_or_vision_fallback === true,
  })),
  removed_identifier_scan: removedIdentifierScan,
  choice_window_gate: gate,
  quiet_window_variables_gate: quietWindowVariablesGate,
}, null, 2));
} finally {
  try {
    if (service) {
      service.setRuntimeServiceState({
        ...service.getRuntimeServiceState(),
        response_task: { status: "idle", response_task_id: null },
      });
      await service.handleRuntimeAction("shutdown", {
        reason: "user_reported_choice_contract_verifier_complete",
      }, { close() {}, minimize() {} });
    }
  } finally {
    if (previousRuntimeDataDir === undefined) delete process.env.JCC_RUNTIME_DATA_DIR;
    else process.env.JCC_RUNTIME_DATA_DIR = previousRuntimeDataDir;
    if (previousDisableCodexExec === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
    else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisableCodexExec;
    await rm(verifierRuntimeRoot, { recursive: true, force: true });
  }
}
