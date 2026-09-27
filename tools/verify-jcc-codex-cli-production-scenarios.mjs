import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import {
  buildHostSessionWarmupPrompt,
  buildHostTurnDeltaPrompt,
  hostCoachNativeOutputSchemaForRequest,
  hostRequestRequiresAugmentRefreshDecision,
  hostContextCapsuleForRequest,
  hostRequestWithStrategicObligationEnvelope,
  normalizeHostCoachResponse,
} from "../ui/electron/runtime-service.js";
import {
  HOST_SESSION_WARMUP_NATIVE_OUTPUT_SCHEMA,
} from "../ui/electron/host-coach-response-contract.js";
import {
  createStrategicObligationQueueState,
  enqueueStrategicObligation,
  strategicObligationDeliveryEnvelope,
  strategicObligationResponseDiagnostics,
} from "../ui/electron/cruise-strategic-obligation-queue.js";
import {
  closeHostAgentSession,
  detectHostAgent,
  runHostAgentRequest,
} from "../ui/electron/host-adapters.js";

const COACH_SCHEMA = "jcc-host-cli-coach-response-v1";
const TARGET_MS = Number(process.env.JCC_CODEX_COACH_SIM_TARGET_MS || 60000);
const TIMEOUT_MS = Number(process.env.JCC_CODEX_COACH_SIM_TIMEOUT_MS || 180000);
const DEFAULT_REPORT_PATH = path.resolve(
  import.meta.dirname,
  "..",
  ".omx",
  "runtime-evidence",
  "jcc-codex-cli-production-scenarios.json",
);

function hasFlag(name) {
  return process.argv.includes(name);
}

function selectedScenarioIds() {
  const argument = process.argv.find((value) => value.startsWith("--only="));
  return argument
    ? new Set(argument.slice("--only=".length).split(",").map((value) => value.trim()).filter(Boolean))
    : null;
}

function reportPath() {
  const argument = process.argv.find((value) => value.startsWith("--report="));
  return path.resolve(argument ? argument.slice("--report=".length) : DEFAULT_REPORT_PATH);
}

async function writeReport(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function byteLength(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function productionCandidate({ id, name, roster, carry, tank, traits, population, archetype }) {
  return {
    candidate_id: id,
    name,
    display_name: name,
    candidate_evidence_id: `${id}:evidence:20260904`,
    selected_variant_id: `${id}:standard`,
    atomic_roster_id: `${id}:roster`,
    roster_is_atomic: true,
    unit_names: roster,
    atomic_roster_members: roster.map((championName, index) => ({
      source_unit_id: `${id}:unit:${index + 1}`,
      entity_kind: "champion",
      champion_id: `${id}:champion:${index + 1}`,
      champion_name: championName,
      occupies_population: true,
      catalog_resolution: "verified_fixture",
    })),
    target_population: population,
    main_carry: carry,
    primary_tank: tank,
    core_traits: traits,
    star_targets: { [carry]: archetype === "three_cost_reroll" ? 3 : 2, [tank]: 2 },
    equipment_plan: {
      [carry]: archetype === "three_cost_reroll" ? ["法力装", "法强装", "增伤装"] : ["核心输出装", "增伤装", "续航装"],
      [tank]: ["双抗装", "生命装", "减伤装"],
    },
    augment_conditions: { preferred: ["体系强化", "装备强化", "经济强化"], forbidden: [] },
    transition_path: {
      population_5: "两星前排加后排持装者",
      population_6: "补核心羁绊和第二前排",
      population_7: archetype === "three_cost_reroll" ? "3-5或3-7在7级启动三费核心" : "3-7整理7级过渡",
      final: `升至${population}人口补齐标准原子阵容`,
    },
    lifecycle_prior: { archetype, key_timing: archetype === "three_cost_reroll" ? "3-5_to_3-7" : "4-1_to_4-2" },
    formation_profile: { burden: archetype === "high_cost_operation" ? "high" : "medium", complete_population: population },
    canonical_lineup_identity: { signature: `${traits.join("|")}|${roster.join("|")}` },
    atomic_roster_observation: { baseline_complete: true, population_count: population },
    atomic_variant_difference: { variant_type: "baseline_complete", added_units: [], removed_units: [] },
    mature_recipe_variants: [],
    mature_recipe_variant_receipt: { status: "none_required" },
    source_role: "national_master_plus_atomic_roster",
    metrics_authority: "national_master_plus",
    provenance: { source: "verified_production_contract_fixture", stat_date: "20260904" },
    evidence_boundary: { ranking_strength: "fixture_only", roster_identity: "verified" },
    cap: `完成${population}人口标准阵容并补足两星质量`,
    floor: "核心一星或前排不足时先稳血",
  };
}

const CANDIDATES = [
  productionCandidate({
    id: "rank:three-summoner-inferno-judicator",
    name: "3召唤师+3地狱火+3裁决使拼多多",
    roster: ["慎", "约里克", "费德提克", "阿兹尔", "阿木木", "墨菲特", "婕拉", "索拉卡", "凯南"],
    carry: "阿兹尔",
    tank: "慎",
    traits: ["召唤师3", "地狱火3", "裁决使3"],
    population: 9,
    archetype: "high_cost_operation",
  }),
  productionCandidate({
    id: "rank:guardian-cassiopeia",
    name: "6护卫蛇女",
    roster: ["卡西奥佩娅", "慎", "奥恩", "蕾欧娜", "阿木木", "墨菲特", "约里克", "婕拉"],
    carry: "卡西奥佩娅",
    tank: "慎",
    traits: ["护卫6", "法师4"],
    population: 8,
    archetype: "three_cost_reroll",
  }),
  productionCandidate({
    id: "rank:forest-nine",
    name: "永恒之森9高费上限",
    roster: ["艾翁", "拉露恩", "奥恩", "墨菲特", "厄斐琉斯", "婕拉", "阿木木", "凯南", "费德提克"],
    carry: "厄斐琉斯",
    tank: "奥恩",
    traits: ["永恒之森9"],
    population: 9,
    archetype: "high_cost_operation",
  }),
];

function checkpointEvent(stageRound, checkpointId, targetPlan = null) {
  return {
    match_session_id: "production-live-scenario-match",
    stage_round: stageRound,
    fixed_checkpoint_stage_round: stageRound,
    fixed_checkpoint_id: checkpointId,
    decision_trigger_id: checkpointId.includes("ceiling") ? "cap_gap_check" : "lineup_convergence_checkpoint",
    event_key: `production-live-scenario-match:${checkpointId}`,
    ...(targetPlan ? { target_plan: targetPlan, target_context_authority: "durable_target_plan" } : {}),
  };
}

function baseRequest({ id, stageRound, mode = "cruise", userMessage, candidates = CANDIDATES, target = null }) {
  return {
    request_id: id,
    request_hash: `${id}:production-contract`,
    request_kind: "host_question",
    mode,
    user_message: userMessage,
    task: {
      task_id: id,
      stage_round: stageRound,
      response_owner: "verified_production_live_scenario",
    },
    live_state_summary: {
      match_session_id: "production-live-scenario-match",
      phase: { stage_round: stageRound },
      economy: { gold: stageRound.startsWith("2-") ? 20 : 44, hp: stageRound.startsWith("5-") ? 38 : 82, level: Number(stageRound[0]) + 2 },
      board: { board_units: [] },
      bench: { bench_units: [] },
    },
    runtime_context: {
      schema: "jcc-runtime-context-v1",
      active_mode: mode,
      host_session_kind: "match",
      game_state_brief: { stage_round: stageRound },
      game_rule_contract: { stage_round: stageRound },
      match_facts: {
        match_session_id: "production-live-scenario-match",
        target_plan: target,
      },
      strategy_fit_packet: {
        schema: "jcc-strategy-fit-packet-v1",
        candidate_working_set: candidates,
        candidate_working_set_count: candidates.length,
        display_candidate_limit: stageRound === "2-2" ? 3 : 2,
        target_plan: target,
      },
      provider_conversation_continuity: {
        policy: "same_match_native_session",
        do_not_replay_static_context: true,
      },
    },
  };
}

function strategicRequest({ id, stageRound, checkpointId, userMessage, target = null, candidates = CANDIDATES }) {
  let queue = createStrategicObligationQueueState();
  queue = enqueueStrategicObligation(queue, checkpointEvent(stageRound, checkpointId, target));
  const envelope = strategicObligationDeliveryEnvelope(queue);
  const request = hostRequestWithStrategicObligationEnvelope(baseRequest({
    id,
    stageRound,
    userMessage,
    candidates,
    target,
  }), envelope);
  return { request, envelope, candidates };
}

function targetPlan(candidate = CANDIDATES[0]) {
  return {
    status: "confirmed",
    authority: "durable_target_plan",
    candidate_id: candidate.candidate_id,
    selected_variant_id: candidate.selected_variant_id,
    candidate_evidence_id: candidate.candidate_evidence_id,
    name: candidate.name,
    unit_names: candidate.unit_names,
    main_carry: candidate.main_carry,
    primary_tank: candidate.primary_tank,
    core_traits: candidate.core_traits,
    target_population: candidate.target_population,
  };
}

function augmentCandidates(stageRound = "2-1") {
  return stageRound === "4-2"
    ? [
        { slot: 1, name: "四费增援", description: "提供四费弈子并支持当前运营阵容完成最终收束。" },
        { slot: 2, name: "剑之工匠", description: "提供装备方向和即时战力。" },
        { slot: 3, name: "欧米茄之怪", description: "提供特殊战力，但与当前目标的确定性较低。" },
      ]
    : [
        { slot: 1, name: "神力天铸", description: "提供一件神器并围绕神器构筑。" },
        { slot: 2, name: "后排蓝图", description: "提供三费非坦克弈子和匹配纹章。" },
        { slot: 3, name: "电火花I", description: "提供前期即时战力。" },
      ];
}

function attachAugmentAdviceContext(request, stageRound = "2-1") {
  const candidates = augmentCandidates(stageRound);
  request.structured_card_action = true;
  request.runtime_event_context = {
    ...(request.runtime_event_context || {}),
    user_message_kind: "structured_choice_advice",
    decision_domain: "augment",
  };
  request.runtime_context.current_match_user_report = {
    kind: "augment",
    stage_round: stageRound,
    candidates,
  };
  request.runtime_context.cruise_decision_context = {
    ...(request.runtime_context.cruise_decision_context || {}),
    augment_choice_evaluation: {
      candidate_ranking: candidates.map((candidate) => candidate.name),
      rows: candidates.map((candidate) => ({
        candidate_name: candidate.name,
        description: candidate.description,
      })),
    },
  };
  return candidates;
}

function makeScenarios() {
  const target = targetPlan();
  return [
    {
      id: "production-augment-advice-2-1",
      description: "2-1强化建议生产合同",
      build() {
        const request = baseRequest({
          id: this.id,
          stageRound: "2-1",
          mode: "augment_choice",
          userMessage: "获取建议：三个强化怎么选，是否需要刷新？",
          candidates: [],
        });
        attachAugmentAdviceContext(request, "2-1");
        assert.equal(hostRequestRequiresAugmentRefreshDecision(request), true);
        return { request, envelope: null, candidates: [] };
      },
      validate(normalized) {
        assert.equal(normalized.choice_recommendation?.candidate_ranking?.length, 3);
        assert(normalized.choice_recommendation?.refresh_action);
      },
    },
    {
      id: "production-augment-confirmation-direction-merge-2-2",
      description: "2-1强化确认完整并入2-2候选探索",
      build() {
        const built = strategicRequest({
          id: this.id,
          stageRound: "2-2",
          checkpointId: "direction_exploration",
          userMessage: "已确认2-1神力天铸；在同一条回答中完成确认，并完整交付2-2三套候选。",
        });
        built.request.runtime_context.match_facts.choice_confirmations = [{ stage_round: "2-1", choice: "神力天铸" }];
        return built;
      },
      validate(normalized) {
        assert.equal(normalized.strategy_selection?.selected_candidate_ids?.length, 3);
        assert.match(normalized.final_text, /神力天铸/);
      },
    },
    {
      id: "production-direction-exploration-2-2",
      description: "2-2三套完整候选生产合同",
      defaultChain: false,
      build() {
        return strategicRequest({
          id: this.id,
          stageRound: "2-2",
          checkpointId: "direction_exploration",
          userMessage: "完成2-2首次完整阵容探索，给出三套完整真实候选。",
        });
      },
      validate(normalized) {
        assert.equal(normalized.strategy_selection?.selected_candidate_ids?.length, 3);
      },
    },
    {
      id: "production-artifact-question-2-3",
      description: "同一局神器追问",
      build() {
        const request = baseRequest({
          id: this.id,
          stageRound: "2-3",
          userMessage: "我有恶火小斧这个神器，玩什么阵容比较好？请从刚才的完整候选中判断。",
        });
        request.runtime_context.match_facts.user_confirmed_equipment = {
          artifacts: [{ item_name: "恶火小斧", category: "artifact" }],
        };
        return { request, envelope: null, candidates: CANDIDATES };
      },
      validate(normalized) {
        assert.match(normalized.final_text, /恶火小斧/);
      },
    },
    {
      id: "production-preparation-2-7",
      description: "2-7强化前执行准备生产合同",
      build() {
        return strategicRequest({
          id: this.id,
          stageRound: "2-7",
          checkpointId: "pre_3_2_direction_preparation",
          userMessage: "完成2-7强化前方向与赌狗执行准备。",
        });
      },
    },
    {
      id: "production-augment-advice-3-2",
      description: "3-2强化建议生产合同",
      build() {
        const request = baseRequest({
          id: this.id,
          stageRound: "3-2",
          mode: "augment_choice",
          userMessage: "获取3-2强化建议，并说明它会怎样改变当前阵容收束。",
          candidates: [],
        });
        const candidates = [
          { slot: 1, name: "节外生枝+", description: "提供随机纹章和装备重铸器。" },
          { slot: 2, name: "珠光莲花II", description: "让技能可以暴击并提供暴击相关收益。" },
          { slot: 3, name: "弑君突刺", description: "提供战斗与经济条件收益。" },
        ];
        request.structured_card_action = true;
        request.runtime_event_context = { user_message_kind: "structured_choice_advice", decision_domain: "augment" };
        request.runtime_context.current_match_user_report = { kind: "augment", stage_round: "3-2", candidates };
        request.runtime_context.cruise_decision_context = {
          augment_choice_evaluation: {
            candidate_ranking: candidates.map((candidate) => candidate.name),
            rows: candidates.map((candidate) => ({ candidate_name: candidate.name, description: candidate.description })),
          },
        };
        return { request, envelope: null, candidates: [] };
      },
      validate(normalized) {
        assert.equal(normalized.choice_recommendation?.candidate_ranking?.length, 3);
      },
    },
    {
      id: "production-convergence-3-3",
      description: "3-2确认并入3-3收束生产合同",
      build() {
        const built = strategicRequest({
          id: this.id,
          stageRound: "3-3",
          checkpointId: "post_3_2_narrowing",
          userMessage: "已确认3-2节外生枝+，把确认结果并入3-3阵容收束。",
        });
        built.request.runtime_context.match_facts.choice_confirmations = [{ stage_round: "3-2", choice: "节外生枝+" }];
        return built;
      },
    },
    {
      id: "production-execution-3-5",
      description: "3-5已确认目标执行生产合同",
      build() {
        return strategicRequest({
          id: this.id,
          stageRound: "3-5",
          checkpointId: "three_cost_reroll_or_operation",
          userMessage: "围绕已确认阵容完成3-5成型与执行判断。",
          target,
          candidates: [CANDIDATES[0]],
        });
      },
    },
    {
      id: "production-final-confirmation-4-3",
      description: "4-2强化确认完整并入4-3最终阵容复核",
      build() {
        const built = strategicRequest({
          id: this.id,
          stageRound: "4-3",
          checkpointId: "final_lineup_confirmation",
          userMessage: "已确认4-2四费增援；在同一条回答中完成确认，并复核最终阵容、装备、站位、成型条件和转向条件。",
          target,
          candidates: [CANDIDATES[0]],
        });
        built.request.runtime_context.match_facts.choice_confirmations = [{ stage_round: "4-2", choice: "四费增援" }];
        return built;
      },
      validate(normalized) {
        assert.match(normalized.final_text, /四费增援/);
      },
    },
    {
      id: "production-formation-review-4-5",
      description: "4-5阵容成型复核生产合同",
      build() {
        return strategicRequest({
          id: this.id,
          stageRound: "4-5",
          checkpointId: "formation_readiness_review",
          userMessage: "围绕已确认阵容完成4-5成型度、8级质量和9级取舍复核。",
          target,
          candidates: [CANDIDATES[0]],
        });
      },
    },
    {
      id: "production-cap-review-5-3",
      description: "5-3上限与下限生产合同",
      build() {
        return strategicRequest({
          id: this.id,
          stageRound: "5-3",
          checkpointId: "second_ceiling_floor_review",
          userMessage: "围绕已确认阵容讨论5-3上限、下限、升人口、替换和装备归属。",
          target,
          candidates: [CANDIDATES[0]],
        });
      },
    },
  ];
}

async function requestWithProductionTurn(
  detected,
  prompt,
  request,
  capsule,
  hostCwd,
  hostSessionKey,
  hostSessionId,
  taskId,
) {
  const result = await runHostAgentRequest(detected, prompt, {
    parseJson: true,
    jsonResponseKind: "coach",
    repoRoot: path.resolve(import.meta.dirname, ".."),
    hostCwd,
    timeoutMs: TIMEOUT_MS,
    hostSessionKey,
    hostSessionId,
    outputSchema: hostCoachNativeOutputSchemaForRequest(request),
    taskId,
  });
  const normalized = normalizeHostCoachResponse(result.response, request);
  return { result, normalized, correctionAttempted: false, firstError: null, firstResponse: null };
}

async function runScenario(detected, scenario, sharedSession) {
  const { request, envelope, candidates } = scenario.build();
  const { hostCwd, hostSessionKey, capsule } = sharedSession;
  const prompt = buildHostTurnDeltaPrompt(request, capsule);
  const startedAt = Date.now();
  let lastResult = null;
  try {
    const outcome = await requestWithProductionTurn(
      detected,
      prompt,
      request,
      capsule,
      hostCwd,
      hostSessionKey,
      sharedSession.hostSessionId,
      scenario.id,
    );
    lastResult = outcome.result;
    sharedSession.hostSessionId = outcome.result.session_id || outcome.result.thread_id || sharedSession.hostSessionId;
    const { result, normalized, correctionAttempted, firstError, firstResponse } = outcome;
    const elapsedMs = Date.now() - startedAt;
    assert(elapsedMs <= TARGET_MS, `${scenario.id} exceeded 60-second target: ${elapsedMs}ms`);
    assert.equal(normalized.schema, COACH_SCHEMA);
    assert.equal(normalized.request_id, request.request_id);
    assert.equal(normalized.request_hash, request.request_hash);
    assert.equal(normalized.mode, request.mode);
    if (envelope) {
      assert.equal(normalized.strategic_obligation_coverage?.ok, true);
    }
    scenario.validate?.(normalized, result.response);
    return {
      id: scenario.id,
      description: scenario.description,
      ok: true,
      elapsed_ms: elapsedMs,
      target_ms: TARGET_MS,
      request_bytes: byteLength(prompt),
      response_bytes: byteLength(result.response),
      completed_from: result.completed_from,
      native_output_schema_applied: result.native_output_schema_applied === true,
      correction_attempted: correctionAttempted,
      first_error: firstError,
      first_response_preview: JSON.stringify(firstResponse || "").slice(0, 1200),
      selected_candidate_count: normalized.strategy_selection?.selected_candidate_ids?.length || 0,
      strategic_coverage_ok: normalized.strategic_obligation_coverage?.ok ?? null,
      final_text_preview: normalized.final_text.slice(0, 240),
    };
  } catch (error) {
    lastResult = lastResult || error?.hostResult || null;
    return {
      id: scenario.id,
      description: scenario.description,
      ok: false,
      elapsed_ms: Date.now() - startedAt,
      target_ms: TARGET_MS,
      request_bytes: byteLength(prompt),
      error: error?.message || String(error),
      response_keys: Object.keys(lastResult?.response || {}),
      response_preview: JSON.stringify(lastResult?.response || lastResult?.response_text || lastResult?.text || "").slice(0, 1800),
      raw_output_preview: String(lastResult?.stdout || "").slice(-1800),
    };
  }
}

async function warmProductionSession(detected, request, sharedSession) {
  const prompt = buildHostSessionWarmupPrompt(request, sharedSession.capsule);
  const startedAt = Date.now();
  const result = await runHostAgentRequest(detected, prompt, {
    parseJson: true,
    jsonResponseKind: "session_warmup",
    outputSchema: HOST_SESSION_WARMUP_NATIVE_OUTPUT_SCHEMA,
    repoRoot: path.resolve(import.meta.dirname, ".."),
    hostCwd: sharedSession.hostCwd,
    timeoutMs: TIMEOUT_MS,
    hostSessionKey: sharedSession.hostSessionKey,
    taskId: "production-live-session-warmup",
  });
  assert.equal(result.ok, true, result.error || "production Host warmup failed");
  assert.equal(result.response?.schema, "jcc-host-session-bootstrap-ack-v1");
  assert.equal(result.response?.capsule_id, sharedSession.capsule.capsule_id);
  assert.equal(result.response?.accepted, true);
  sharedSession.hostSessionId = result.session_id || result.thread_id || null;
  return {
    elapsed_ms: Date.now() - startedAt,
    request_bytes: byteLength(prompt),
    completed_from: result.completed_from,
    native_output_schema_applied: result.native_output_schema_applied === true,
  };
}

async function main() {
  const requireLive = hasFlag("--require-live");
  const detected = await detectHostAgent({
    provider: "codex",
    model: process.env.JCC_CODEX_MODEL || null,
    reasoning_effort: process.env.JCC_CODEX_REASONING_EFFORT || "low",
  });
  if (!detected.available) {
    const output = {
      ok: false,
      schema: "jcc-codex-cli-production-scenarios-v1",
      status: "external_dependency_pending",
      reason: detected.error || "Codex CLI not found",
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (requireLive) process.exit(1);
    return;
  }
  const requested = selectedScenarioIds();
  const scenarios = makeScenarios().filter((scenario) => (
    requested ? requested.has(scenario.id) : scenario.defaultChain !== false
  ));
  assert(scenarios.length > 0, "No production scenarios selected");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-production-live-chain-"));
  const hostSessionKey = `production-live:match-chain:${Date.now()}`;
  const firstRequest = scenarios[0].build().request;
  const sharedSession = {
    hostCwd: tempRoot,
    hostSessionKey,
    hostSessionId: null,
    capsule: hostContextCapsuleForRequest(firstRequest, {
      routeKey: hostSessionKey,
      provider: "codex",
    }),
  };
  const reports = [];
  let warmup = null;
  const evidencePath = reportPath();
  try {
    warmup = await warmProductionSession(detected, firstRequest, sharedSession);
    await writeReport(evidencePath, {
      schema: "jcc-codex-cli-production-scenarios-progress-v1",
      status: "running",
      session_policy: "one_start_match_one_persistent_host_session",
      warmup,
      completed_scenario_count: 0,
      scenario_count: scenarios.length,
      scenarios: reports,
    });
    for (const scenario of scenarios) {
      reports.push(await runScenario(detected, scenario, sharedSession));
      await writeReport(evidencePath, {
        schema: "jcc-codex-cli-production-scenarios-progress-v1",
        status: "running",
        session_policy: "one_start_match_one_persistent_host_session",
        warmup,
        completed_scenario_count: reports.length,
        scenario_count: scenarios.length,
        scenarios: reports,
      });
    }
  } finally {
    await closeHostAgentSession(hostSessionKey).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
  const failed = reports.filter((report) => !report.ok);
  const output = {
    ok: failed.length === 0,
    schema: "jcc-codex-cli-production-scenarios-v1",
    status: failed.length === 0 ? "pass" : "fail",
    provider: "codex",
    command: detected.command,
    version: detected.version || null,
    target_ms: TARGET_MS,
    timeout_ms: TIMEOUT_MS,
    session_policy: "one_start_match_one_persistent_host_session",
    warmup,
    scenario_count: reports.length,
    passed_count: reports.length - failed.length,
    failed_count: failed.length,
    scenarios: reports,
  };
  await writeReport(evidencePath, output);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
