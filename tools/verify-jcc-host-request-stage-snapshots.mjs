import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPipeline } from "./run-jcc-cruise-runtime-pipeline.mjs";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const runtimePaths = createRuntimePaths(repoRoot);
const patchDir = path.dirname(runtimePaths.activeHardDataManifest);
const liveRankings = "data/live-rankings/jcc/current/rank-signal.json";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function confirmation(kind, stageRound, selected) {
  return { kind, choice_stage_round: stageRound, selected, choice: selected, observed_at: "2026-07-20T08:00:00.000Z" };
}

const scenarios = [
  { stage: "2-1", currentKind: "augment", past: [], confirmations: [] },
  { stage: "2-2", currentKind: null, past: [["augment", "2-1"]], confirmations: [] },
  { stage: "2-4", currentKind: null, past: [["augment", "2-1"]], confirmations: [confirmation("augment", "2-1", "验证强化一")] },
  { stage: "3-2", currentKind: "augment", past: [["augment", "2-1"]], confirmations: [confirmation("augment", "2-1", "验证强化一")] },
  { stage: "4-2", currentKind: "augment", past: [["augment", "2-1"], ["augment", "3-2"]], confirmations: [confirmation("augment", "2-1", "验证强化一"), confirmation("augment", "3-2", "验证强化二")] },
];

const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-host-stage-snapshots-"));
try {
  const snapshots = [];
  for (const [index, scenario] of scenarios.entries()) {
    const sessionId = `verify-stage-${scenario.stage}`;
    const liveStateFile = path.join(tempDir, `${scenario.stage}-live.json`);
    const contextFile = path.join(tempDir, `${scenario.stage}-context.json`);
    const adviceStateFile = path.join(tempDir, `${scenario.stage}-advice.json`);
    await writeFile(liveStateFile, `${JSON.stringify({
      schema: "jcc-stage-snapshot-live-state-v1",
      match_session_id: sessionId,
      phase: { status: "planning", stage_round: scenario.stage },
      economy: { hp: 80 - index * 5, gold: 10 + index * 10, level: 4 + index, xp: `${index * 2}/20` },
      own_board: { units: [{ name: "验证棋子", star: 2 }] },
      own_bench: { units: [] },
      shop: { units: [] },
      items: { item_bench: [] },
    }, null, 2)}\n`, "utf8");
    await writeFile(contextFile, `${JSON.stringify({
      schema: "jcc-runtime-match-context-v1",
      match_session_id: sessionId,
      match_context: {
        match_variables: { encounter: "验证变量" },
        recent_user_messages: [{ text: `${scenario.stage} 当前怎么处理？`, mode: "cruise", observed_at: "2026-07-20T08:00:00.000Z" }],
        choice_confirmations: scenario.confirmations,
      },
    }, null, 2)}\n`, "utf8");
    const result = await runPipeline({
      liveState: liveStateFile,
      context: contextFile,
      adviceState: adviceStateFile,
      mode: "cruise",
      userMessage: `${scenario.stage} 当前怎么处理？`,
      forceResponseReason: "manual_stage_snapshot_contract",
      now: `2026-07-20T08:0${index}:00.000Z`,
      patchDir,
      liveRankings,
      retainFullState: true,
    });
    const event = result.response_events.find((entry) => entry.type === "advice_response_requested");
    assert(event?.host_cli_agent_request, `${scenario.stage}: pipeline must emit a host request`);
    const request = event.host_cli_agent_request;
    const context = request.context;
    assert(context.game_state_brief?.stage_round === scenario.stage, `${scenario.stage}: game_state_brief must use current stage`);
    assert(context.game_rule_contract?.stage_round === scenario.stage, `${scenario.stage}: game_rule_contract must use current stage`);
    assert(context.live_state_summary?.stage_round === scenario.stage, `${scenario.stage}: live summary must use current stage`);
    assert(context.current_turn_contract?.stage_round === scenario.stage, `${scenario.stage}: current-turn contract must bind current stage`);
    assert(context.current_turn_contract?.rules_source_fingerprint?.length === 64, `${scenario.stage}: current-turn contract must bind rules fingerprint`);
    assert(context.current_turn_contract?.version_identity?.runtime_season_id === runtimePaths.activeSeasonId, `${scenario.stage}: current-turn contract must bind active major season`);
    assert(context.active_rules_bundle == null, `${scenario.stage}: per-turn pipeline request must not replay static rules already owned by the provider-session capsule`);
    assert(context.game_rule_brief_text?.includes(`current_stage: ${scenario.stage}`), `${scenario.stage}: plain-language brief must front-load current stage`);
    if (scenario.currentKind) {
      assert(context.game_rule_contract.current_choice_checkpoint?.kind === scenario.currentKind, `${scenario.stage}: current choice kind mismatch`);
      assert(context.game_state_brief.forbidden_waiting_for?.some((entry) => entry.kind === scenario.currentKind && entry.stage_round === scenario.stage), `${scenario.stage}: current checkpoint must be forbidden as a future wait`);
    } else {
      assert(context.game_rule_contract.current_choice_checkpoint == null, `${scenario.stage}: no current choice checkpoint expected; got ${JSON.stringify(context.game_rule_contract.current_choice_checkpoint)}`);
    }
    for (const [kind, stageRound] of scenario.past) {
      assert(context.game_rule_contract.past_choice_checkpoints?.some((entry) => entry.kind === kind && entry.stage_round === stageRound), `${scenario.stage}: past checkpoint ${kind} ${stageRound} missing`);
    }
    snapshots.push({
      stage_round: scenario.stage,
      current_choice_kind: context.game_rule_contract.current_choice_checkpoint?.kind || null,
      past_choice_checkpoints: context.game_rule_contract.past_choice_checkpoints.map((entry) => `${entry.kind}:${entry.stage_round}`),
      rules_source_fingerprint: context.current_turn_contract.rules_source_fingerprint,
    });
  }
  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-host-request-stage-snapshots-verifier-v1",
    snapshots,
  }, null, 2));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
