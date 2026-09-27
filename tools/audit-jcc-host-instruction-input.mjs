import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

// Production prompt assembly only; isolated state, no Provider inference or live Match.
const temp = await mkdtemp(path.join(os.tmpdir(), "jcc-instruction-audit-"));
const previous = process.env.JCC_RUNTIME_DATA_DIR;
process.env.JCC_RUNTIME_DATA_DIR = temp;
try {
  const service = await import("../ui/electron/runtime-service.js");
  const { JCC_CODEX_DYNAMIC_TOOL_SPECS } = await import("../ui/electron/host-readonly-tool-broker.js");
  const { createStrategicObligationQueueState, enqueueStrategicObligation, strategicObligationDeliveryEnvelope } = await import("../ui/electron/cruise-strategic-obligation-queue.js");
  const tools = JSON.stringify(JCC_CODEX_DYNAMIC_TOOL_SPECS);
  const snapshot = service.captureMatchSeasonVersionSnapshot();
  const report = { scope: "production assembled model-facing prompts; no Provider latency measurement", cases: [] };
  const artifacts = [];
  for (const [mode, stage, checkpoint] of [
    ["daily_chat", null], ["cruise", "2-2", "direction_exploration"],
    ["cruise", "3-3", "post_3_2_narrowing"], ["lineup_card", "3-3"],
    ["augment_choice", "3-2"], ["item_choice", "3-5"],
  ]) {
    const route = stage ? "match:instruction-audit" : "daily:instruction-audit";
    service.setRuntimeServiceState({ active_mode: mode, host_cli: { provider: "codex" },
      match_session: { status: stage ? "active" : "idle", match_session_id: stage ? route : null, season_version_snapshot: snapshot },
      daily_session: { status: "active", generation: 991 }, response_task: { status: "idle" }, match_context: {}, user_preferences: { rank_tier: "master" } });
    let request = { request_id: `${mode}:${stage}`, request_hash: `${mode}:${stage}`, mode,
      request_kind: "host_question", provider_readonly_tool_mode: "native_dynamic_tools",
      user_message: "请结合当前证据给出建议。", task: { type: "runtime_event_followup", stage_round: stage },
      context: { live_state_summary: stage ? { phase: { stage_round: stage }, economy: { hp: 80, gold: 40, level: 6 }, own_board: { units: [] }, own_bench: { units: [] } } : {} } };
    request.runtime_context = await service.buildRuntimeHostContext(mode, null, request);
    if (checkpoint) {
      const queue = enqueueStrategicObligation(createStrategicObligationQueueState(), {
        match_session_id: route, stage_round: stage, fixed_checkpoint_stage_round: stage,
        fixed_checkpoint_id: checkpoint, decision_trigger_id: "lineup_convergence_checkpoint", event_key: request.request_id });
      request = service.hostRequestWithStrategicObligationEnvelope(request, strategicObligationDeliveryEnvelope(queue));
    }
    const capsule = service.hostContextCapsuleForRequest(request, { routeKey: route, provider: "codex", model: "gpt-6-astra" });
    const bootstrap = service.buildHostSessionWarmupPrompt(request, capsule);
    const turn = service.buildHostTurnDeltaPrompt(request, capsule);
    const prefix = turn.split("\nINPUT_JSON:\n")[0];
    const strings = [];
    const walk = (value, at) => {
      if (typeof value === "string" && value.length >= 100) strings.push({ at, value });
      else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${at}[${i}]`));
      else if (value && typeof value === "object") Object.entries(value).forEach(([k,v]) => walk(v, `${at}.${k}`));
    };
    walk(JSON.parse(turn.split("\nINPUT_JSON:\n")[1]), "INPUT_JSON");
    const duplicates = strings.filter((entry, i) => strings.findIndex(other => other.value === entry.value) !== i);
    const baseLines = bootstrap.split("\n").filter(line => line.length >= 100 && !line.startsWith("{"));
    const toolRepeats = baseLines.map(line => line.replace(/^[^:]+: /, "")).filter(line => tools.includes(line));
    report.cases.push({ mode, stage, bootstrap_bytes: Buffer.byteLength(bootstrap), turn_bytes: Buffer.byteLength(turn),
      instruction_prefix_bytes: Buffer.byteLength(prefix), tool_repeated_base_bytes: toolRepeats.reduce((n,s)=>n+Buffer.byteLength(s),0),
      tool_repeated_base: toolRepeats, exact_json_repetitions: duplicates,
      common_hash: createHash("sha256").update(JSON.stringify(capsule.static_context.common_host_knowledge)).digest("hex") });
    artifacts.push({ mode, stage, bootstrap, turn, tools: JCC_CODEX_DYNAMIC_TOOL_SPECS });
  }
  const dir = path.resolve(process.env.JCC_INSTRUCTION_AUDIT_DIR || ".omx/runtime-evidence/instruction-audit");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "prompts.json"), JSON.stringify(artifacts, null, 2));
  await writeFile(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (previous === undefined) delete process.env.JCC_RUNTIME_DATA_DIR;
  else process.env.JCC_RUNTIME_DATA_DIR = previous;
  await rm(temp, { recursive: true, force: true });
}
