import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { experimentPrompt, experimentResult } from "./jcc-evidence-recovery-experiment.mjs";

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(os.tmpdir(), "jcc-match-native-live-"));
process.env.JCC_RUNTIME_DATA_DIR = temp;
process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
for (const suffix of ["AUGMENT_CHOICE_OCR", "GOD_CHOICE_OCR", "ITEM_CHOICE_OCR", "SELF_STATE_ROI_OCR", "OWNED_AUGMENT_TEXT_PANEL_OCR"]) {
  process.env[`JCC_DISABLE_RESIDENT_${suffix}`] = "1";
}
process.env.JCC_ALLOW_COLD_CHOICE_OCR_FALLBACK = "0";
process.env.JCC_ALLOW_COLD_SELF_STATE_ROI_OCR_FALLBACK = "0";
const reportFile = path.resolve(root, process.env.JCC_LIVE_REPORT || ".omx/runtime-evidence/jcc-match-native-live.json");
const report = { schema: "jcc-match-native-live-v1", started_at: new Date().toISOString(),
  experiment: process.env.JCC_EVIDENCE_EXPERIMENT || "baseline",
  scope: "simulated Match observations; real production context, bootstrap, schema, broker, normalization and Provider; no Electron/OCR or automatic scheduler",
  model: process.env.JCC_CODEX_MODEL || "gpt-6-astra", effort: process.env.JCC_CODEX_REASONING_EFFORT || "low", turns: [] };
let close;
const route = `match:live-benchmark-${Date.now()}`;
async function save() {
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}
try {
  const importStarted = Date.now();
  const service = await import("../ui/electron/runtime-service.js");
  const { createRuntimePaths } = await import("../ui/electron/runtime-state-store.js");
  const { detectHostAgent, runHostAgentRequest, closeHostAgentSession } = await import("../ui/electron/host-adapters.js");
  const { HOST_SESSION_WARMUP_NATIVE_OUTPUT_SCHEMA } = await import("../ui/electron/host-coach-response-contract.js");
  const { createStrategicObligationQueueState, enqueueStrategicObligation, strategicObligationDeliveryEnvelope } = await import("../ui/electron/cruise-strategic-obligation-queue.js");
  close = closeHostAgentSession;
  const paths = createRuntimePaths(root);
  assert.ok(path.resolve(paths.currentWatchDir).startsWith(path.resolve(temp)), "test state must be isolated");
  const snapshot = service.captureMatchSeasonVersionSnapshot();
  assert.ok(snapshot.ranking_overlay_id, "current Ranking must be available, not a fake candidate fixture");
  report.snapshot = snapshot;
  report.module_initialization_ms = Date.now() - importStarted;
  const adapter = await detectHostAgent({ provider: "codex", model: report.model, reasoning_effort: report.effort });
  assert.equal(adapter.selected_model, report.model);
  assert.equal(adapter.reasoning_effort, report.effort);
  assert.ok(adapter.available);
  const confirmations = [];
  const noopWindow = { close() {}, minimize() {} };
  let capsule;
  let providerSessionId;
  for (const stage of (process.env.JCC_LIVE_STAGES || "2-1,2-2,3-2").split(",")) {
    const preparationStarted = Date.now();
    const mode = stage === "2-2" ? "cruise" : "augment_choice";
    service.setRuntimeServiceState({ active_mode: mode, host_cli: { provider: "codex" },
      match_session: { status: "active", match_session_id: route, season_version_snapshot: snapshot },
      response_task: { status: "idle" }, user_preferences: { rank_tier: "master" },
      match_context: { choice_confirmations: structuredClone(confirmations) },
    });
    const live = { match_session_id: route, phase: { status: "planning", stage_round: stage },
      economy: { hp: { value: stage === "3-2" ? 86 : 100 }, gold: { value: stage === "3-2" ? 42 : 20 },
        level: { value: stage === "3-2" ? 6 : 4 }, xp: { value: 0, to_next: stage === "3-2" ? 36 : 10 } },
      own_board: { units: [{ name: "奥恩", star: 2, items: ["石像鬼石板甲"] }, { name: "霞", star: 2, items: [] },
        { name: "凯尔", star: 1, items: [] }, { name: "蕾欧娜", star: 1, items: [] }] },
      own_bench: { units: [] }, shop: { units: [] }, source: "isolated_simulation" };
    await mkdir(paths.currentWatchDir, { recursive: true });
    await writeFile(path.join(paths.currentWatchDir, "cruise-live-state.json"), JSON.stringify(live));
    let candidates = [];
    let recordedChoiceSet;
    if (mode === "augment_choice") {
      const options = await service.handleRuntimeAction("getDecisionInputOptions", {
        mode, choice_kind: "augment", stage_round: stage, tier_color: "gold", limit: 3,
      }, noopWindow);
      candidates = (options.options?.candidates || []).slice(0, 3).map((candidate, index) => ({ ...candidate, slot: index + 1 }));
      assert.equal(candidates.length, 3, JSON.stringify(options).slice(0, 500));
      const recorded = await service.handleRuntimeAction("submitDecisionInput", {
        mode, choice_kind: "augment", stage_round: stage, tier: "gold",
        payload_binding: options.payload_binding, candidates, request_advice: false,
      }, noopWindow);
      assert.ok(recorded.ok, JSON.stringify(recorded).slice(0, 600));
      recordedChoiceSet = recorded.state.match_context.reported_choice_sets_by_mode[mode];
      candidates = recordedChoiceSet.candidates;
    }
    const choices = { schema: "jcc-host-choice-candidates-v1", source: "current_match_user_report",
      kind: "augment", mode, stage_round: stage, candidates,
      report_id: recordedChoiceSet?.report_id, choice_set_revision: recordedChoiceSet?.revision };
    const contextPack = { schema: "jcc-runtime-context-pack-v1", scope: "mode", mode_id: mode };
    let request = { request_id: `${route}:${stage}`, request_hash: `${route}:${stage}:simulation`,
      request_kind: "host_question", provider_readonly_tool_mode: "native_dynamic_tools", mode,
      user_message: mode === "cruise" ? "请给出本轮2-2的完整候选方向建议。" : `这三个强化选哪个：${candidates.map(c => c.name).join("、")}？`,
      task: { type: "runtime_event_followup", stage_round: stage, structured_card_action: mode !== "cruise" },
      context_pack: contextPack, context: { mode, live_state_summary: live, ...(candidates.length ? { choices } : {}) },
      ...(candidates.length ? { choices } : {}),
    };
    request.runtime_context = await service.buildRuntimeHostContext(mode, contextPack, request);
    if (mode === "cruise") {
      const queue = enqueueStrategicObligation(createStrategicObligationQueueState(), {
        match_session_id: route, stage_round: stage, fixed_checkpoint_stage_round: stage,
        fixed_checkpoint_id: "direction_exploration", decision_trigger_id: "lineup_convergence_checkpoint", event_key: `${route}:2-2`,
      });
      request = service.hostRequestWithStrategicObligationEnvelope(request, strategicObligationDeliveryEnvelope(queue));
    }
    capsule ||= service.hostContextCapsuleForRequest(request, { routeKey: route, provider: "codex", model: report.model });
    const prompt = experimentPrompt(service.buildHostTurnDeltaPrompt(request, capsule), report.experiment);
    const broker = service.createReadonlyBrokerForHostTurn(request, { capsule, turn_prompt_bytes: Buffer.byteLength(prompt) });
    assert.ok(broker, "production broker must exist");
    const row = { stage, mode, preparation_ms: Date.now() - preparationStarted, prompt_bytes: Buffer.byteLength(prompt),
      choices: candidates, previous_confirmations: structuredClone(confirmations), tool_calls: [],
      decision_snapshot: request.runtime_context.decision_snapshot };
    report.turns.push(row);
    const options = { hostSessionKey: route, taskId: request.request_id, repoRoot: root, hostCwd: temp,
      parseJson: true, timeoutMs: 300000, allowContractCorrection: false };
    if (!providerSessionId) {
      const started = Date.now();
      const bootstrapPrompt = service.buildHostSessionWarmupPrompt(request, capsule);
      console.log(JSON.stringify({ phase: "bootstrap", bytes: Buffer.byteLength(bootstrapPrompt), model: report.model }));
      const warm = await runHostAgentRequest(adapter, bootstrapPrompt, { ...options, jsonResponseKind: "session_warmup",
        providerSessionBootstrap: true, bootstrapCapsuleId: capsule.capsule_id,
        outputSchema: HOST_SESSION_WARMUP_NATIVE_OUTPUT_SCHEMA });
      report.bootstrap = { elapsed_ms: Date.now() - started, bytes: Buffer.byteLength(bootstrapPrompt), ok: warm.ok,
        response: warm.response, receipt: warm.capability_receipt, error: warm.error };
      await save();
      assert.ok(warm.ok && warm.response?.accepted, JSON.stringify(report.bootstrap));
      providerSessionId = warm.session_id;
      assert.ok(providerSessionId, "bootstrap must return a session identity");
    }
    const started = Date.now();
    console.log(JSON.stringify({ phase: "turn", stage, preparation_ms: row.preparation_ms, bytes: row.prompt_bytes }));
    const result = await runHostAgentRequest(adapter, prompt, { ...options, hostSessionId: providerSessionId,
      jsonResponseKind: "coach", outputSchema: service.hostCoachNativeOutputSchemaForRequest(request),
      onProviderTurnDispatched: () => { row.dispatched_ms = Date.now() - started; },
      onProviderTurnStarted: () => { row.accepted_ms = Date.now() - started; },
      onProviderFirstToken: () => { row.first_token_ms = Date.now() - started; },
      onReadonlyToolCall: async (name, args) => {
        const call = { name, args, start_ms: Date.now() - started };
        row.tool_calls.push(call);
        try { const value = experimentResult(await broker.call(name, args), report.experiment); call.ok = value.ok; call.bytes = Buffer.byteLength(JSON.stringify(value)); return value; }
        catch (error) { call.error = error.message; throw error; }
        finally { call.elapsed_ms = Date.now() - started - call.start_ms; }
      },
    });
    row.host_elapsed_ms = Date.now() - started;
    row.ok = result.ok; row.error = result.error; row.receipt = result.capability_receipt;
    row.events = result.events;
    row.transport_diagnostics = result.host_transport_diagnostics;
    row.provider_completion = result.events?.filter(e => e.method === "turn/completed").at(-1)?.params?.turn;
    row.response = result.response; row.tool_audit = broker.audit;
    row.usage = result.events?.filter(e => e.method === "thread/tokenUsage/updated").at(-1)?.params?.tokenUsage;
    const normalizationStarted = Date.now();
    if (result.ok) row.normalized = service.normalizeHostCoachResponse(result.response, request);
    row.normalization_ms = Date.now() - normalizationStarted;
    await save();
    console.log(JSON.stringify({ stage, ok: row.ok, elapsed_ms: row.host_elapsed_ms, first_token_ms: row.first_token_ms,
      tool_calls: row.tool_calls.length, text_chars: row.normalized?.final_text?.length }));
    assert.ok(result.ok, result.error);
    assert.equal(result.readonly_tool_mode, "native_dynamic_tools");
    assert.ok(row.normalized?.final_text);
    assert.equal(result.session_id, providerSessionId, "all turns must reuse the warmed Match session");
    assert.ok(row.tool_calls.every(call => !call.error && call.ok !== false), "native queries must succeed, not only be called");
    assert.notEqual(row.provider_completion?.status, "failed", "failed Provider turn must not count as delivery success");
    const finalItems = row.provider_completion?.items?.filter(item => item.type === "agentMessage") || [];
    assert.ok(finalItems.some(item => item.phase === "final_answer"), "interim commentary is not a finished strategy answer");
    if (stage === "2-2") {
      assert.ok(result.response.candidate_refs?.length >= 3, "this available Ranking fixture must produce at least three candidate handoffs");
    }
    if (stage === "2-1") confirmations.push({ stage_round: stage, kind: "augment", selected: candidates[0].name,
      selected_ref: candidates[0].ref, selected_candidate_metadata: candidates[0], tier: "gold",
      response_policy: "state_only_no_host_task", source: "simulated_user_confirmation" });
  }
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = error.stack; process.exitCode = 1;
  console.error(error.stack);
} finally {
  await close?.(route);
  report.completed_at = new Date().toISOString();
  await save();
  await rm(temp, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: report.ok, report_file: reportFile }));
