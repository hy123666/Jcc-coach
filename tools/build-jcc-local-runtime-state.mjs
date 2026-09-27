import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

function usage() {
  return [
    "Usage:",
    "  node tools/build-jcc-local-runtime-state.mjs --companion-log <jsonl> --signals <candidate-runtime-signals.json> [--last <n>] [--out <state.json>]",
    "",
    "Builds a single match/session-scoped local runtime state.",
    "Companion visual/OCR observations remain UI evidence. Board/bench identities come only from local action reducer.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { last: 2500 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--companion-log") options.companionLog = argv[++index];
    else if (arg === "--signals") options.signals = argv[++index];
    else if (arg === "--last") options.last = Number(argv[++index]);
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function buildCompanionSummary(companionLog, last) {
  const result = await runNode([
    "tools/summarize-jcc-companion-live-state.mjs",
    "--input",
    companionLog,
    "--last",
    String(last),
  ]);
  if (result.code !== 0) {
    throw new Error(`companion summary failed ${result.code}\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

async function buildMatchLiveState(signalsFile) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-local-runtime-state-"));
  const out = path.join(tempDir, "match-live-state.json");
  try {
    const result = await runNode([
      "tools/build-jcc-match-live-state.mjs",
      "--signals",
      signalsFile,
      "--out",
      out,
    ]);
    if (result.code !== 0) {
      throw new Error(`match live-state failed ${result.code}\n${result.stderr || result.stdout}`);
    }
    return JSON.parse(await readFile(out, "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function compactUnit(unit) {
  return {
    entity_id: unit.entity_id ?? null,
    champion_id: unit.champion_id ?? unit.champion?.id ?? unit.id ?? null,
    name: unit.name ?? unit.champion?.name ?? unit.hero?.name ?? null,
    star: unit.star ?? unit.hero?.star_tier ?? "unknown",
    position: unit.position ?? null,
    area: unit.area ?? null,
    items: unit.items || [],
    confidence: unit.confidence ?? 0,
    evidence: unit.evidence ?? null,
    source_signal_type: unit.source_signal_type ?? null,
    semantic_status: unit.semantic_status ?? "observed_from_local_action_reducer",
  };
}

function stableSlots(summary, group) {
  const slots = summary?.verification_temporal_roi?.groups?.[group]?.stable_slots
    || summary?.temporal_roi?.groups?.[group]?.stable_slots
    || [];
  return slots;
}

function actionState(matchLiveState) {
  const live = matchLiveState.live_state || {};
  const folded = live.source_insights?.folded_board_bench_state || null;
  const actions = live.source_insights?.board_bench_action_candidates || null;
  return {
    local_binding: {
      local_chair_id: matchLiveState.match?.local_chair_id ?? null,
      binding_status: matchLiveState.match?.binding_status ?? "unbound",
      binding_source: matchLiveState.match?.binding_source ?? null,
      binding_confidence: matchLiveState.match?.binding_confidence ?? 0,
      binding_evidence: matchLiveState.match?.binding_evidence ?? null,
    },
    gate: live.gate || null,
    board_units: (live.board?.board_units || []).map(compactUnit),
    bench_units: (live.bench?.bench_units || []).map(compactUnit),
    folded_board_bench_state: folded ? {
      action_count: folded.action_count || 0,
      action_type_counts: folded.action_type_counts || {},
      ignored_nonlocal_count: folded.ignored_nonlocal_count || 0,
      ignored_unbound_count: folded.ignored_unbound_count || 0,
      fold_status: folded.fold_status,
      blocker: folded.blocker || null,
      local_actions: folded.local_actions || [],
      ignored_nonlocal_actions: folded.ignored_nonlocal_actions || [],
      ignored_unbound_actions: folded.ignored_unbound_actions || [],
      reducer_policy: folded.reducer_policy,
    } : null,
    action_scope: actions ? {
      count: actions.count,
      primary_local_count: actions.primary_local_count || 0,
      secondary_global_count: actions.secondary_global_count || 0,
      latest_primary_local: actions.latest_primary_local || null,
      latest: actions.latest || null,
      scope_policy: actions.scope_policy,
      promotion_decision: actions.promotion_decision,
    } : null,
  };
}

function buildState({ companionSummary, matchLiveState, companionLog, signalsFile }) {
  const action = actionState(matchLiveState);
  const visual = {
    match_session_id: companionSummary.latest_session_id || null,
    phase: companionSummary.agent_state?.promoted?.phase || companionSummary.phase_context || null,
    round: companionSummary.agent_state?.promoted?.round || null,
    gold: companionSummary.agent_state?.candidates?.gold || null,
    level: companionSummary.agent_state?.promoted?.level || null,
    xp: companionSummary.agent_state?.promoted?.xp || null,
    hp_scoreboard_numbers: companionSummary.agent_state?.candidates?.hp_scoreboard_numbers || null,
    slots: {
      shop_stable_slots: stableSlots(companionSummary, "shop_slots"),
      board_stable_slots: stableSlots(companionSummary, "board_slots"),
      bench_stable_slots: stableSlots(companionSummary, "bench_slots"),
      board_candidates: companionSummary.agent_state?.candidates?.board_slots || null,
      bench_candidates: companionSummary.agent_state?.candidates?.bench_slots || null,
    },
    freshness: companionSummary.agent_state?.freshness || companionSummary.data_freshness || null,
  };
  const boardBenchVerified = action.local_binding.binding_status === "strongly_bound"
    && action.gate?.strategy_input_allowed === true
    && (action.board_units.length > 0 || action.bench_units.length > 0);
  return {
    schema: "jcc-local-runtime-state-v1",
    status: boardBenchVerified ? "local_action_state_observed" : "candidate_only",
    source_refs: {
      companion_log: companionLog,
      signals: signalsFile,
      companion_match_session_id: visual.match_session_id,
      game_start_time: matchLiveState.match?.game_start_time || null,
    },
    pollution_guard: {
      companion_session_scoped: true,
      android_latest_match_window_scoped: true,
      cross_match_fusion_allowed: false,
      secondary_global_actions_strategy_allowed: false,
      board_bench_identity_source: "local_action_reducer_only",
      visual_3d_identity_promotion_allowed: false,
    },
    local: action.local_binding,
    gate: action.gate,
    visual,
    action,
    board_units: action.board_units,
    bench_units: action.bench_units,
    confidence_notes: [
      "Visual/OCR evidence can promote UI fields and slot occupancy candidates.",
      "Board/bench unit identity is promoted only from current-match primary_local action events.",
      "If local_chair_id is unbound or conflicting, board_units and bench_units remain empty.",
    ],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.companionLog || !options.signals) throw new Error(`Missing --companion-log/--signals\n${usage()}`);
  const companionSummary = await buildCompanionSummary(options.companionLog, options.last);
  const matchLiveState = await buildMatchLiveState(options.signals);
  const state = buildState({
    companionSummary,
    matchLiveState,
    companionLog: options.companionLog,
    signalsFile: options.signals,
  });
  const text = `${JSON.stringify(state, null, 2)}\n`;
  if (options.out) await writeFile(options.out, text, "utf8");
  else process.stdout.write(text);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
