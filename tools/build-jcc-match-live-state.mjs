import { readFile, writeFile } from "node:fs/promises";

const SCHEMA_REF = "data/runtime/jcc/android-live-state-schema.json";
const MATRIX_REF = "data/runtime/jcc/android-live-state-field-evidence-matrix.json";

function usage() {
  return [
    "Usage:",
    "  node tools/build-jcc-match-live-state.mjs --signals <candidate-runtime-signals.json> [--source-health <source-health.json>] [--manual-binding <binding.json>] [--out <live-state.json>]",
    "",
    "Builds a match-scoped JCC live-state snapshot from Android runtime signals.",
    "The opening gate requires a strong local_chair_id binding before strategy use.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--signals") options.signals = argv[++index];
    else if (arg === "--source-health") options.sourceHealth = argv[++index];
    else if (arg === "--manual-binding") options.manualBinding = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function startNewWindow(signal, index) {
  return {
    start_index: index,
    game_start_time: signal.payload?.game_start_time || null,
    signals: [],
  };
}

function splitMatchWindows(signals) {
  const windows = [];
  let current = null;
  for (let index = 0; index < signals.length; index += 1) {
    const signal = signals[index];
    if (signal.type === "match_start") {
      if (current) windows.push(current);
      current = startNewWindow(signal, index);
    }
    if (!current) current = { start_index: 0, game_start_time: null, signals: [] };
    current.signals.push(signal);
  }
  if (current) windows.push(current);
  return windows;
}

function bindLocalChair(signals, manualBinding = null, gameStartTime = null) {
  const manual = manualLocalChairBinding(manualBinding, gameStartTime);
  if (manual) return manual;

  const localActorBinding = bindLocalChairFromActionActor(signals);
  if (localActorBinding) return localActorBinding;

  const localReports = signals
    .map((signal, index) => ({ signal, index }))
    .filter(({ signal }) => signal.type === "local_report_chair_candidate")
    .filter(({ signal }) => Number.isInteger(signal.payload?.chair_id));

  if (localReports.length > 0) {
    const latest = localReports.at(-1);
    const chairCounts = new Map();
    for (const report of localReports) {
      const chairId = report.signal.payload.chair_id;
      chairCounts.set(chairId, (chairCounts.get(chairId) || 0) + 1);
    }
    const distinctChairIds = [...chairCounts.keys()].sort((left, right) => left - right);
    if (distinctChairIds.length > 1) {
      return {
        local_chair_id: latest.signal.payload.chair_id,
        binding_status: "weakly_bound_conflicting_reports",
        binding_source: "local_report_chair_candidate",
        binding_signal_index: latest.index,
        binding_candidates: distinctChairIds.map((chair_id) => ({ chair_id, count: chairCounts.get(chair_id) })),
        confidence: Math.min(0.55, latest.signal.confidence || 0.55),
        evidence: latest.signal.evidence,
        blocker: "local_report_chair_candidates_conflict_within_match_window",
      };
    }
    return {
      local_chair_id: latest.signal.payload.chair_id,
      binding_status: "weakly_bound_report_cycle",
      binding_source: "local_report_chair_candidate",
      binding_signal_index: latest.index,
      binding_candidates: distinctChairIds.map((chair_id) => ({ chair_id, count: chairCounts.get(chair_id) })),
      confidence: Math.min(0.62, latest.signal.confidence || 0.62),
      evidence: latest.signal.evidence,
      blocker: "local_report_chair_candidate_is_not_a_proven_local_player_binding",
    };
  }

  return {
    local_chair_id: null,
    binding_status: "unbound",
    binding_source: null,
    binding_signal_index: null,
    binding_candidates: [],
    confidence: 0,
    evidence: null,
  };
}

function manualLocalChairBinding(manualBinding, gameStartTime) {
  if (!manualBinding) return null;
  const binding = manualBinding.binding || manualBinding;
  const chairId = binding.local_chair_id;
  if (!isPlayerChairId(chairId)) return null;
  const bindingGameStartTime = binding.game_start_time || manualBinding.game_start_time || null;
  if (bindingGameStartTime && gameStartTime && bindingGameStartTime !== gameStartTime) {
    return null;
  }
  if (binding.binding_status && binding.binding_status !== "strongly_bound") return null;
  return {
    local_chair_id: chairId,
    binding_status: "strongly_bound",
    binding_source: "manual_action_label_current_match",
    binding_signal_index: binding.binding_signal_index ?? null,
    binding_candidates: binding.binding_candidates || [{
      chair_id: chairId,
      count: 1,
      actor_ref: binding.actor_ref || null,
    }],
    confidence: binding.confidence ?? 0.93,
    evidence: binding.evidence || null,
    actor_ref: binding.actor_ref || null,
    caveat: "manual calibration is match-scoped; ignored when GameStart changes",
  };
}

function bindLocalChairFromActionActor(signals) {
  const actorToChair = actorChairMap(signals);
  const actionCountsByActor = new Map();
  for (const signal of signals) {
    if (!["get_on_chess_candidate", "move_battle_chess_candidate", "sell_chess_candidate"].includes(signal.type)) continue;
    const actorRef = signal.payload?.actor_ref;
    if (!actorRef || !actorToChair.has(actorRef)) continue;
    const chairId = actorToChair.get(actorRef);
    const existing = actionCountsByActor.get(actorRef) || {
      actor_ref: actorRef,
      chair_id: chairId,
      count: 0,
      evidence: signal.evidence || null,
    };
    existing.count += 1;
    existing.evidence = signal.evidence || existing.evidence;
    actionCountsByActor.set(actorRef, existing);
  }
  const candidates = [...actionCountsByActor.values()]
    .sort((left, right) => right.count - left.count || left.chair_id - right.chair_id);
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  return {
    local_chair_id: candidate.chair_id,
    binding_status: "strongly_bound",
    binding_source: "action_actor_switch_player_chair",
    binding_signal_index: null,
    binding_candidates: candidates.map(({ chair_id, count, actor_ref }) => ({ chair_id, count, actor_ref })),
    confidence: 0.88,
    evidence: candidate.evidence,
    actor_ref: candidate.actor_ref,
    caveat: "strong within current action actor stream; still match-scoped and reset on each GameStart",
  };
}

function latestByType(signals, type) {
  for (let index = signals.length - 1; index >= 0; index -= 1) {
    if (signals[index].type === type) return signals[index];
  }
  return null;
}

function latestPlayerLife(signals, chairId) {
  if (chairId == null) return null;
  for (let index = signals.length - 1; index >= 0; index -= 1) {
    const signal = signals[index];
    if (signal.type !== "player_life") continue;
    if (signal.payload?.chair_id === chairId) {
      const hp = Number(signal.payload.life);
      return Number.isFinite(hp) && hp > 0 && hp <= 150 ? hp : null;
    }
  }
  return null;
}

function latestShopCandidates(signals) {
  const signal = latestByType(signals, "shop_roll_candidate");
  if (!signal) return [];
  return (signal.payload?.heroes || []).map((hero, slot) => ({
    slot,
    id: hero.champion_id,
    ...hero,
    evidence: signal.evidence || null,
    confidence: signal.confidence || 0,
    source_signal_type: signal.type,
  }));
}

function shopRefreshCandidate(signals) {
  const shopSignals = signals.filter((signal) => signal.type === "shop_roll_candidate");
  if (shopSignals.length === 0) return { refresh_count: "unknown" };
  const latest = shopSignals.at(-1);
  return evidenceEnvelope(latest, {
    refresh_count: shopSignals.length,
    source_signal_type: "shop_roll_candidate",
  });
}

function latestTurnCount(signals) {
  for (let index = signals.length - 1; index >= 0; index -= 1) {
    const signal = signals[index];
    if (signal.type === "turn_data_marker" && Number.isFinite(signal.payload?.decoded?.turn_candidate)) {
      return evidenceEnvelope(signal, { turn_count: signal.payload.decoded.turn_candidate });
    }
    if (signal.type === "local_report_chair_candidate" && Number.isFinite(signal.payload?.turn_count)) {
      return evidenceEnvelope(signal, { turn_count: signal.payload.turn_count });
    }
    if (signal.type === "battle_end_chair" && Number.isFinite(signal.payload?.turn_count)) {
      return evidenceEnvelope(signal, { turn_count: signal.payload.turn_count });
    }
  }
  return null;
}

function latestRoundStageCandidate(signals) {
  for (let index = signals.length - 1; index >= 0; index -= 1) {
    const signal = signals[index];
    if (signal.type !== "round_flow") continue;
    const snapshot = signal.payload?.decoded?.snapshot_candidate;
    if (!Number.isFinite(snapshot?.round_major_candidate) && !Number.isFinite(snapshot?.round_minor_candidate)) continue;
    return evidenceEnvelope(signal, {
      stage: Number.isFinite(snapshot.round_major_candidate) ? snapshot.round_major_candidate : null,
      round: Number.isFinite(snapshot.round_minor_candidate) ? snapshot.round_minor_candidate : null,
    });
  }
  return { stage: null, round: null };
}

function latestMatchSetCandidate(signals) {
  for (let index = signals.length - 1; index >= 0; index -= 1) {
    const signal = signals[index];
    const setId = signal.payload?.decoded?.set_id_candidate;
    if (setId == null) continue;
    return evidenceEnvelope(signal, { set_id: String(setId) });
  }
  return { set_id: null };
}

function matchLifecycle(activeWindow) {
  const matchEnd = latestByType(activeWindow.signals, "match_end");
  if (matchEnd) {
    return {
      status: "ended",
      game_end_time: matchEnd.payload?.game_end_time || null,
      confidence: matchEnd.confidence || 0,
      evidence: matchEnd.evidence || null,
    };
  }
  if (activeWindow.game_start_time) {
    return {
      status: "in_game",
      game_end_time: null,
      confidence: 0.9,
      evidence: "match_start without match_end in active window",
    };
  }
  return {
    status: "unknown",
    game_end_time: null,
    confidence: 0,
    evidence: null,
  };
}

function matchStartEvidence(activeWindow) {
  const matchStart = activeWindow.signals.find((signal) => signal.type === "match_start");
  return {
    confidence: matchStart?.confidence || 0,
    evidence: matchStart?.evidence || null,
  };
}

function latestPlayerLifeByChair(signals) {
  const byChair = new Map();
  for (const signal of signals) {
    if (signal.type !== "player_life") continue;
    const chairId = signal.payload?.chair_id;
    if (!isPlayerChairId(chairId)) continue;
    byChair.set(chairId, evidenceEnvelope(signal, {
      chair_id: chairId,
      hp: signal.payload.life,
    }));
  }
  return byChair;
}

function aliveCount(signals, chairId) {
  if (chairId == null) return null;
  const byChair = latestPlayerLifeByChair(signals);
  if (byChair.size === 0) return null;
  if (!byChair.has(chairId)) return null;
  const alive = [...byChair.values()].filter((player) => player.hp > 0);
  const evidencePlayers = alive.length > 0 ? alive : [...byChair.values()];
  return {
    count: alive.length,
    confidence: Math.min(...evidencePlayers.map((player) => player.confidence), 0.72),
    evidence: firstEvidence(evidencePlayers),
    source_signal_type: "player_life",
  };
}

function latestCombatPairing(signals, chairId) {
  if (chairId == null) return { opponent_chair_id: null, is_home_board: null };
  for (let index = signals.length - 1; index >= 0; index -= 1) {
    const signal = signals[index];
    if (signal.type !== "battle_pairing") continue;
    if (signal.payload?.player_chair_id !== chairId) continue;
    if (!isPlayerChairId(signal.payload?.enemy_chair_id)) continue;
    return evidenceEnvelope(signal, {
      opponent_chair_id: signal.payload.enemy_chair_id,
      is_home_board: signal.payload.is_home_board,
    });
  }
  return { opponent_chair_id: null, is_home_board: null };
}

function latestCombatEarnedMoney(signals, chairId) {
  if (chairId == null) return { earned_money: "unknown" };
  for (let index = signals.length - 1; index >= 0; index -= 1) {
    const signal = signals[index];
    if (signal.type !== "battle_result_money") continue;
    if (signal.payload?.player_chair_id_candidate !== chairId) continue;
    if (!Number.isFinite(signal.payload?.earned_money)) continue;
    return evidenceEnvelope(signal, {
      earned_money: signal.payload.earned_money,
      earned_money_source_signal_type: signal.type,
      earned_money_evidence: signal.evidence || null,
      earned_money_confidence: signal.confidence || 0,
    });
  }
  return { earned_money: "unknown" };
}

function latestCombatDamageTaken(signals, chairId) {
  if (chairId == null) return { damage_taken: "unknown" };
  for (let index = signals.length - 1; index >= 0; index -= 1) {
    const signal = signals[index];
    if (signal.type !== "battle_result_life") continue;
    if (signal.payload?.player_chair_id_candidate !== chairId) continue;
    if (!Number.isFinite(signal.payload?.deducted_life)) continue;
    return evidenceEnvelope(signal, {
      damage_taken: signal.payload.deducted_life,
      damage_taken_source_signal_type: signal.type,
      damage_taken_evidence: signal.evidence || null,
      damage_taken_confidence: signal.confidence || 0,
    });
  }
  return { damage_taken: "unknown" };
}

function latestVariableCandidate(signals, type) {
  const signal = latestByType(signals, type);
  if (!signal) return "unknown";
  return evidenceEnvelope(signal, {
    ...signal.payload,
    semantic_status: "candidate_only",
  });
}

function phaseCandidateFromCarousel(carouselActive, carouselMeta = {}) {
  if (carouselActive === "unknown") return { phase: "unknown" };
  const confidence = typeof carouselActive === "object" ? carouselActive.confidence : carouselMeta.confidence;
  const evidence = typeof carouselActive === "object" ? carouselActive.evidence : carouselMeta.evidence;
  const sourceSignalType = typeof carouselActive === "object" ? carouselActive.source_signal_type : carouselMeta.source_signal_type;
  return {
    phase: "candidate_carousel",
    phase_confidence: Math.min(confidence || 0, 0.62),
    phase_evidence: evidence,
    phase_source_signal_type: sourceSignalType,
  };
}

function combatResultCandidate(combatDamage, chairId) {
  if (!Number.isFinite(combatDamage?.damage_taken) || chairId == null) {
    return { result: "unknown", win_loss: "unknown" };
  }
  return {
    result: {
      local_chair_id: chairId,
      damage_taken: combatDamage.damage_taken,
      source_signal_type: combatDamage.damage_taken_source_signal_type,
      confidence: combatDamage.damage_taken_confidence,
      evidence: combatDamage.damage_taken_evidence,
      semantic_status: "candidate_only",
    },
    win_loss: combatDamage.damage_taken === 0 ? "candidate_no_damage_taken" : "candidate_damage_taken",
    win_loss_confidence: Math.min(combatDamage.damage_taken_confidence || 0, 0.55),
    win_loss_evidence: combatDamage.damage_taken_evidence,
    win_loss_source_signal_type: combatDamage.damage_taken_source_signal_type,
  };
}

function combatActiveCandidate(combat, combatDamage, combatMoney, chairId) {
  if (chairId == null) return "unknown";
  const source = [combat, combatDamage, combatMoney].find((candidate) => candidate?.evidence);
  if (!source) return "unknown";
  return {
    state: "candidate_combat_observed",
    local_chair_id: chairId,
    opponent_chair_id: isPlayerChairId(combat?.opponent_chair_id) ? combat.opponent_chair_id : "unknown",
    is_home_board: combat?.is_home_board ?? "unknown",
    confidence: Math.min(source.confidence || 0, 0.68),
    evidence: source.evidence,
    source_signal_type: source.source_signal_type || "combat_event_candidate",
    semantic_status: "candidate_only",
  };
}

function currentOpponentFromCombat(combat, localChairId) {
  if (!isPlayerChairId(combat?.opponent_chair_id) || combat.opponent_chair_id === localChairId) {
    return "unknown";
  }
  return {
    chair: combat.opponent_chair_id,
    chair_id: combat.opponent_chair_id,
    hp: "unknown",
    level: "unknown",
    gold: "unknown",
    board: "unknown",
    bench: "unknown",
    traits: "unknown",
    last_scouted: "unknown",
    confidence: combat.confidence || 0,
    evidence: combat.evidence || null,
    source_signal_type: combat.source_signal_type || "battle_pairing",
  };
}

function roundFlowSourceInsights(signals) {
  const snapshots = signals
    .map((signal, signalIndex) => ({ signal, signalIndex }))
    .filter(({ signal }) => signal.type === "round_flow")
    .map(({ signal, signalIndex }) => {
      const snapshot = signal.payload?.decoded?.snapshot_candidate;
      if (!snapshot) return null;
      return {
        ...snapshot,
        signal_index: signalIndex,
        evidence: signal.evidence || null,
        source_signal_type: signal.type,
        confidence: signal.confidence || 0,
      };
    })
    .filter(Boolean)
    .slice(-12)
    .map((snapshot) => ({
      ...snapshot,
      binding_status: "anonymous_unbound_candidate",
    }));
  const latestWithBoard = snapshots.findLast((snapshot) => Array.isArray(snapshot.board_units) && snapshot.board_units.length > 0);
  const latestWithBench = snapshots.findLast((snapshot) => Array.isArray(snapshot.bench_units) && snapshot.bench_units.length > 0);
  const latestWithItemBench = snapshots.findLast((snapshot) => Array.isArray(snapshot.item_bench) && snapshot.item_bench.length > 0);
  const latestWithAugmentOrTrait = snapshots.findLast((snapshot) => Array.isArray(snapshot.augment_or_trait_candidates) && snapshot.augment_or_trait_candidates.length > 0);
  return {
    round_flow_snapshots: snapshots,
    board_bench_item_candidates: {
      promotion_decision: {
        board_units: {
          status: latestWithBoard ? "not_promoted" : "missing",
          reason: latestWithBoard ? "round_flow_board_units_not_bound_to_local_chair" : "no_round_flow_board_unit_candidate_observed",
        },
        bench_units: {
          status: latestWithBench ? "not_promoted" : "missing",
          reason: latestWithBench ? "round_flow_bench_units_not_bound_to_local_chair" : "no_round_flow_bench_unit_candidate_observed",
        },
        item_bench: {
          status: latestWithItemBench ? "not_promoted" : "missing",
          reason: latestWithItemBench ? "round_flow_item_bench_not_bound_to_local_chair" : "no_round_flow_item_bench_candidate_observed",
        },
        augment_or_trait_candidates: {
          status: latestWithAugmentOrTrait ? "not_promoted" : "missing",
          reason: latestWithAugmentOrTrait ? "round_flow_augment_or_trait_semantics_unverified" : "no_round_flow_augment_or_trait_candidate_observed",
        },
      },
      board_units: {
        count: snapshots.filter((snapshot) => Array.isArray(snapshot.board_units) && snapshot.board_units.length > 0).length,
        latest: latestWithBoard?.board_units || [],
        latest_source: latestWithBoard || null,
        promotion_decision: {
          status: latestWithBoard ? "not_promoted" : "missing",
          reason: latestWithBoard ? "round_flow_board_units_not_bound_to_local_chair" : "no_round_flow_board_unit_candidate_observed",
        },
      },
      bench_units: {
        count: snapshots.filter((snapshot) => Array.isArray(snapshot.bench_units) && snapshot.bench_units.length > 0).length,
        latest: latestWithBench?.bench_units || [],
        latest_source: latestWithBench || null,
        promotion_decision: {
          status: latestWithBench ? "not_promoted" : "missing",
          reason: latestWithBench ? "round_flow_bench_units_not_bound_to_local_chair" : "no_round_flow_bench_unit_candidate_observed",
        },
      },
      item_bench: {
        count: snapshots.filter((snapshot) => Array.isArray(snapshot.item_bench) && snapshot.item_bench.length > 0).length,
        latest: latestWithItemBench?.item_bench || [],
        latest_source: latestWithItemBench || null,
        promotion_decision: {
          status: latestWithItemBench ? "not_promoted" : "missing",
          reason: latestWithItemBench ? "round_flow_item_bench_not_bound_to_local_chair" : "no_round_flow_item_bench_candidate_observed",
        },
      },
      augment_or_trait_candidates: {
        count: snapshots.filter((snapshot) => Array.isArray(snapshot.augment_or_trait_candidates) && snapshot.augment_or_trait_candidates.length > 0).length,
        latest: latestWithAugmentOrTrait?.augment_or_trait_candidates || [],
      },
      binding_status: "anonymous_round_flow_not_local_state",
    },
  };
}

function actionLocalScope(resolvedChairId, binding) {
  if (binding?.binding_status !== "strongly_bound") return "global_untrusted_until_local_binding_is_strong";
  if (resolvedChairId === binding.local_chair_id) return "primary_local";
  if (resolvedChairId == null) return "secondary_global_unbound";
  return "secondary_global_nonlocal";
}

function scopedAction(signal, signalIndex, actorToChair, binding) {
  const resolvedActionChairId = actionChairId(signal, actorToChair);
  return {
    signal_index: signalIndex,
    action: signal.payload?.action || signal.type,
    actor_ref: signal.payload?.actor_ref ?? null,
    entity_id: signal.payload?.entity_id ?? null,
    raw_hero_id: signal.payload?.raw_hero_id ?? null,
    action_chair_id_candidate: signal.payload?.action_chair_id_candidate ?? null,
    resolved_action_chair_id: resolvedActionChairId,
    local_scope: actionLocalScope(resolvedActionChairId, binding),
    hero: signal.payload?.hero || null,
    from: signal.payload?.from || null,
    to: signal.payload?.to || null,
    position: signal.payload?.position || null,
    same_position: signal.payload?.same_position === true,
    ext: signal.payload?.ext || "",
    source_signal_type: signal.type,
    confidence: signal.confidence || 0,
    evidence: signal.evidence || null,
    interpretation: signal.payload?.interpretation || "board_bench_action_candidate_not_promoted",
  };
}

function boardBenchActionCandidateInsights(signals, binding) {
  const actorToChair = actorChairMap(signals);
  const actionSignals = signals
    .map((signal, signalIndex) => ({ signal, signalIndex }))
    .filter(({ signal }) => (
      signal.type === "get_on_chess_candidate"
      || signal.type === "move_battle_chess_candidate"
      || signal.type === "sell_chess_candidate"
    ))
    .map(({ signal, signalIndex }) => scopedAction(signal, signalIndex, actorToChair, binding));
  const getOnCount = actionSignals.filter((action) => action.source_signal_type === "get_on_chess_candidate").length;
  const moveCount = actionSignals.filter((action) => action.source_signal_type === "move_battle_chess_candidate").length;
  const sellCount = actionSignals.filter((action) => action.source_signal_type === "sell_chess_candidate").length;
  const primaryLocalActions = actionSignals.filter((action) => action.local_scope === "primary_local");
  const secondaryGlobalActions = actionSignals.filter((action) => action.local_scope !== "primary_local");
  return {
    count: actionSignals.length,
    get_on_chess_count: getOnCount,
    move_battle_chess_count: moveCount,
    sell_chess_count: sellCount,
    same_position_count: actionSignals.filter((action) => action.same_position).length,
    latest: actionSignals.at(-1) || null,
    latest_primary_local: primaryLocalActions.at(-1) || null,
    actions: actionSignals.slice(-20),
    primary_local_actions: primaryLocalActions.slice(-20),
    secondary_global_actions: secondaryGlobalActions.slice(-20),
    primary_local_count: primaryLocalActions.length,
    secondary_global_count: secondaryGlobalActions.length,
    binding_status: binding?.binding_status === "strongly_bound"
      ? "local_action_scope_available"
      : "action_log_not_local_bound",
    local_binding: {
      local_chair_id: binding?.local_chair_id ?? null,
      binding_status: binding?.binding_status ?? "unbound",
      binding_source: binding?.binding_source ?? null,
      confidence: binding?.confidence ?? 0,
      blocker: binding?.blocker ?? null,
    },
    scope_policy: "Only primary_local actions may feed board_units/bench_units. Secondary/global actions are debug-only and never strategy input.",
    promotion_decision: {
      board_units: {
        status: primaryLocalActions.length > 0 ? "foldable_by_local_action_reducer" : actionSignals.length > 0 ? "not_promoted" : "missing",
        reason: primaryLocalActions.length > 0
          ? "primary_local_action_stream_available_for_current_match"
          : actionSignals.length > 0
            ? "action_logs_exist_but_are_not_primary_local"
            : "no_board_bench_action_candidate_observed",
      },
      bench_units: {
        status: primaryLocalActions.length > 0 ? "foldable_by_local_action_reducer" : actionSignals.length > 0 ? "not_promoted" : "missing",
        reason: primaryLocalActions.length > 0
          ? "primary_local_action_stream_available_for_current_match"
          : actionSignals.length > 0
            ? "action_logs_exist_but_are_not_primary_local"
            : "no_board_bench_action_candidate_observed",
      },
      other_players: {
        status: secondaryGlobalActions.length > 0 ? "debug_only" : "empty",
        reason: secondaryGlobalActions.length > 0
          ? "secondary_global_actions_are_visible_but_excluded_from_local_state"
          : "no_board_bench_action_candidate_observed",
      },
      position: {
        status: actionSignals.length > 0 ? "partial" : "missing",
        reason: actionSignals.length > 0
          ? "action_logs_expose_move_coordinates_without_full_slot_semantics"
          : "no_position_action_candidate_observed",
      },
      sell: {
        status: sellCount > 0 ? "partial" : "missing",
        reason: sellCount > 0
          ? "sell_action_logs_observed_without_full_economy_or_roster_snapshot"
          : "no_sell_action_candidate_observed",
      },
    },
  };
}

function positionKey(position) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  return `${position.x}|${position.y}`;
}

function areaFromPosition(position) {
  if (!position || !Number.isFinite(position.y)) return "unknown";
  return position.y < 0 ? "bench" : "board";
}

function actorChairMap(signals) {
  const map = new Map();
  for (const signal of signals) {
    if (signal.type !== "switch_player_chair") continue;
    const actorRef = signal.payload?.actor_ref;
    const chairId = signal.payload?.chair_id;
    if (!actorRef || !isPlayerChairId(chairId)) continue;
    map.set(actorRef, chairId);
  }
  return map;
}

function actionChairId(signal, actorToChair) {
  const actorRef = signal.payload?.actor_ref;
  if (actorRef && actorToChair.has(actorRef)) return actorToChair.get(actorRef);
  const candidate = signal.payload?.action_chair_id_candidate;
  return isPlayerChairId(candidate) ? candidate : null;
}

function unitFromAction(signal, position, area) {
  const payload = signal.payload || {};
  return evidenceEnvelope(signal, {
    entity_id: payload.entity_id ?? null,
    raw_hero_id: payload.raw_hero_id ?? null,
    id: payload.hero?.champion_id ?? (payload.raw_hero_id != null ? String(payload.raw_hero_id) : null),
    champion_id: payload.hero?.champion_id ?? null,
    name: payload.hero?.name ?? null,
    champion: payload.hero ? {
      id: payload.hero.champion_id ?? null,
      name: payload.hero.name ?? null,
      cost: payload.hero.cost ?? null,
      traits: payload.hero.traits || [],
    } : null,
    hero: payload.hero || null,
    star: payload.hero?.star_tier ?? payload.star_or_state ?? "unknown",
    position: position || null,
    area,
    items: [],
    sellable: area === "bench" ? true : "unknown",
    summoned: false,
    clone: false,
    semantic_status: "observed_from_action_log",
  });
}

function foldedLocalBoardBenchFromActions(signals, chairId) {
  if (chairId == null) {
    return {
      board_units: [],
      bench_units: [],
      action_count: 0,
      ignored_nonlocal_count: 0,
      ignored_unbound_count: 0,
      fold_status: "blocked",
      blocker: "local_chair_id_unbound",
    };
  }

  const boardByPosition = new Map();
  const benchByPosition = new Map();
  const entityLocations = new Map();
  let actionCount = 0;
  let ignoredNonlocalCount = 0;
  let ignoredUnboundCount = 0;
  const localActions = [];
  const ignoredNonlocalActions = [];
  const ignoredUnboundActions = [];
  const actionTypeCounts = {
    get_on_chess_count: 0,
    move_battle_chess_count: 0,
    sell_chess_count: 0,
  };
  const actorToChair = actorChairMap(signals);

  function removeEntity(entityId) {
    const location = entityLocations.get(entityId);
    if (!location) return;
    if (location.area === "board") boardByPosition.delete(location.key);
    if (location.area === "bench") benchByPosition.delete(location.key);
    entityLocations.delete(entityId);
  }

  function putUnit(signal, position) {
    const key = positionKey(position);
    const area = areaFromPosition(position);
    if (!key || area === "unknown") return;
    const entityId = signal.payload?.entity_id;
    if (entityId == null) return;
    removeEntity(entityId);
    const unit = unitFromAction(signal, position, area);
    if (area === "board") boardByPosition.set(key, unit);
    else benchByPosition.set(key, unit);
    entityLocations.set(entityId, { area, key });
  }

  for (let signalIndex = 0; signalIndex < signals.length; signalIndex += 1) {
    const signal = signals[signalIndex];
    if (!["get_on_chess_candidate", "move_battle_chess_candidate", "sell_chess_candidate"].includes(signal.type)) continue;
    const resolvedActionChairId = actionChairId(signal, actorToChair);
    const scoped = scopedAction(signal, signalIndex, actorToChair, { binding_status: "strongly_bound", local_chair_id: chairId });
    if (resolvedActionChairId == null) {
      ignoredUnboundCount += 1;
      ignoredUnboundActions.push(scoped);
      continue;
    }
    if (resolvedActionChairId !== chairId) {
      ignoredNonlocalCount += 1;
      ignoredNonlocalActions.push(scoped);
      continue;
    }
    actionCount += 1;
    localActions.push(scoped);
    if (signal.type === "get_on_chess_candidate") {
      actionTypeCounts.get_on_chess_count += 1;
      putUnit(signal, signal.payload?.to || null);
    } else if (signal.type === "move_battle_chess_candidate") {
      actionTypeCounts.move_battle_chess_count += 1;
      if (signal.payload?.same_position) continue;
      putUnit(signal, signal.payload?.to || null);
    } else if (signal.type === "sell_chess_candidate") {
      actionTypeCounts.sell_chess_count += 1;
      removeEntity(signal.payload?.entity_id);
    }
  }

  const sortUnits = (units) => units.sort((left, right) => {
    const leftY = left.position?.y ?? 0;
    const rightY = right.position?.y ?? 0;
    if (leftY !== rightY) return leftY - rightY;
    return (left.position?.x ?? 0) - (right.position?.x ?? 0);
  });

  return {
    board_units: sortUnits([...boardByPosition.values()]),
    bench_units: sortUnits([...benchByPosition.values()]),
    action_count: actionCount,
    action_type_counts: actionTypeCounts,
    ignored_nonlocal_count: ignoredNonlocalCount,
    ignored_unbound_count: ignoredUnboundCount,
    local_actions: localActions.slice(-20),
    ignored_nonlocal_actions: ignoredNonlocalActions.slice(-20),
    ignored_unbound_actions: ignoredUnboundActions.slice(-20),
    fold_status: actionCount > 0 ? "debug_only_not_promoted" : "missing",
    blocker: actionCount > 0
      ? "action_log_positions_can_be_combat_or_observed_board_not_stable_home_board"
      : "no_local_action_candidates_observed",
    source_signal_type: "action_log_candidates",
    semantic_status: "folded_from_local_action_events_debug_only",
    reducer_policy: "match-scoped local_chair_id gate; action fold is retained as source insight only and must not promote to board_units/bench_units without a stable home-board snapshot source",
  };
}

function blockedFoldedBoardBench(blocker) {
  return {
    board_units: [],
    bench_units: [],
    action_count: 0,
    action_type_counts: {
      get_on_chess_count: 0,
      move_battle_chess_count: 0,
      sell_chess_count: 0,
    },
    ignored_nonlocal_count: 0,
    ignored_unbound_count: 0,
    local_actions: [],
    ignored_nonlocal_actions: [],
    ignored_unbound_actions: [],
    fold_status: "blocked",
    blocker,
    source_signal_type: "action_log_candidates",
    semantic_status: "blocked_until_match_and_local_binding_are_strong",
    reducer_policy: "match-scoped local_chair_id gate; only primary_local action candidates mutate board/bench state",
  };
}

function roundFlowBindingAssessment(roundFlowSnapshots, binding, hp) {
  const candidates = roundFlowSnapshots.map((snapshot) => {
    const matchedSignals = [];
    const conflicts = [];
    if (snapshot.hp != null && hp != null) {
      if (snapshot.hp === hp) matchedSignals.push("hp");
      else conflicts.push("hp_mismatch");
    }
    if (binding.local_chair_id != null && Array.isArray(snapshot.chair_candidates)) {
      if (snapshot.chair_candidates.includes(binding.local_chair_id)) matchedSignals.push("chair_candidate");
      else conflicts.push("chair_candidate_missing_local");
    }
    return {
      binding_status: "candidate_not_promoted",
      matched_signals: matchedSignals,
      conflicts,
      score: matchedSignals.length - conflicts.length,
      snapshot,
    };
  }).sort((left, right) => right.score - left.score);

  return {
    candidates,
    decision: {
      status: "not_promoted",
      reason: "round_flow_chair_semantics_unverified",
    },
  };
}

function economyCandidateAudit(signals) {
  const moneyEvents = signals
    .filter((signal) => signal.type === "battle_result_money")
    .map((signal) => ({
      earned_money: signal.payload?.earned_money ?? null,
      binding_status: "anonymous_player_ref_not_local_chair",
      confidence: signal.confidence || 0,
      evidence: signal.evidence || null,
    }));
  const levelCandidates = signals
    .filter((signal) => signal.type === "round_flow")
    .map((signal) => signal.payload?.decoded?.snapshot_candidate)
    .filter((snapshot) => Number.isFinite(snapshot?.level_candidate))
    .map((snapshot) => ({
      level_candidate: snapshot.level_candidate,
      turn_count: snapshot.turn_count ?? null,
      chair_candidates: snapshot.chair_candidates || [],
      hp: snapshot.hp ?? null,
      binding_status: "anonymous_round_flow_not_local_economy",
    }));
  return {
    promotion_decision: {
      economy_gold: {
        status: moneyEvents.length > 0 ? "not_promoted" : "missing",
        reason: moneyEvents.length > 0 ? "money_event_player_ref_not_bound_to_local_chair" : "no_gold_candidate_signal_observed",
      },
      economy_level: {
        status: levelCandidates.length > 0 ? "not_promoted" : "missing",
        reason: levelCandidates.length > 0 ? "round_flow_level_chair_semantics_unverified" : "no_level_candidate_signal_observed",
      },
      economy_xp: {
        status: "missing",
        reason: "no_xp_candidate_signal_observed",
      },
      economy_xp_to_next: {
        status: "missing",
        reason: "no_xp_to_next_candidate_signal_observed",
      },
    },
    money_events: {
      count: moneyEvents.length,
      examples: moneyEvents.slice(-5),
    },
    level_candidates: {
      count: levelCandidates.length,
      examples: levelCandidates.slice(-5),
    },
    xp_candidates: { count: 0, examples: [] },
    xp_to_next_candidates: { count: 0, examples: [] },
    blockers: [
      ...(moneyEvents.length > 0 ? ["money_event_player_ref_not_bound_to_local_chair"] : []),
      ...(levelCandidates.length > 0 ? ["round_flow_level_chair_semantics_unverified"] : []),
      "no_xp_or_xp_to_next_candidate_signal_observed",
    ],
  };
}

function localChairBindingCandidateAudit(signals, binding) {
  const reports = signals
    .filter((signal) => signal.type === "local_report_chair_candidate")
    .map((signal) => ({
      chair_id: signal.payload?.chair_id ?? null,
      turn_count: signal.payload?.turn_count ?? null,
      frame: signal.payload?.frame ?? null,
      confidence: signal.confidence || 0,
      evidence: signal.evidence || null,
      semantic_status: "weak_report_cycle_not_local_player_proof",
    }));
  const observedBattlefields = signals
    .filter((signal) => signal.type === "observed_battlefield_chair_candidate" || signal.type === "observed_logic_player_chair_candidate")
    .map((signal) => ({
      chair_id: signal.payload?.chair_id ?? null,
      queue_id: signal.payload?.queue_id ?? null,
      source_signal_type: signal.type,
      confidence: signal.confidence || 0,
      evidence: signal.evidence || null,
      semantic_status: "current_view_or_observed_board_not_local_player_proof",
    }));
  const actorToChair = actorChairMap(signals);
  const actionByResolvedChair = new Map();
  for (const signal of signals) {
    if (!["get_on_chess_candidate", "move_battle_chess_candidate", "sell_chess_candidate"].includes(signal.type)) continue;
    const chairId = actionChairId(signal, actorToChair);
    if (!isPlayerChairId(chairId)) continue;
    const existing = actionByResolvedChair.get(chairId) || {
      chair_id: chairId,
      action_count: 0,
      actor_refs: new Map(),
      examples: [],
    };
    existing.action_count += 1;
    if (signal.payload?.actor_ref) {
      existing.actor_refs.set(signal.payload.actor_ref, (existing.actor_refs.get(signal.payload.actor_ref) || 0) + 1);
    }
    if (existing.examples.length < 5) {
      existing.examples.push({
        action: signal.payload?.action || signal.type,
        actor_ref: signal.payload?.actor_ref ?? null,
        entity_id: signal.payload?.entity_id ?? null,
        hero: signal.payload?.hero?.name ?? null,
        position: signal.payload?.position || signal.payload?.to || null,
        evidence: signal.evidence || null,
      });
    }
    actionByResolvedChair.set(chairId, existing);
  }
  const actionCandidates = [...actionByResolvedChair.values()]
    .map((entry) => ({
      chair_id: entry.chair_id,
      action_count: entry.action_count,
      actor_refs: [...entry.actor_refs.entries()]
        .map(([actor_ref, count]) => ({ actor_ref, count }))
        .sort((left, right) => right.count - left.count),
      examples: entry.examples,
      semantic_status: "chair_has_action_board_data_but_not_local_player_proof",
    }))
    .sort((left, right) => right.action_count - left.action_count || left.chair_id - right.chair_id);
  return {
    binding_status: binding.binding_status,
    promoted_local_chair_id: binding.binding_status === "strongly_bound" ? binding.local_chair_id : null,
    blocked_local_chair_id_candidate: binding.binding_status === "strongly_bound" ? null : binding.local_chair_id,
    blocker: binding.binding_status === "strongly_bound" ? null : (binding.blocker || "local_chair_id_not_strongly_bound"),
    reports: {
      count: reports.length,
      latest: reports.at(-1) || null,
      distinct_chairs: [...new Set(reports.map((row) => row.chair_id).filter((chairId) => isPlayerChairId(chairId)))].sort((left, right) => left - right),
    },
    observed_battlefield: {
      count: observedBattlefields.length,
      latest: observedBattlefields.at(-1) || null,
      distinct_chairs: [...new Set(observedBattlefields.map((row) => row.chair_id).filter((chairId) => isPlayerChairId(chairId)))].sort((left, right) => left - right),
    },
    action_chair_candidates: actionCandidates,
    promotion_decision: {
      status: binding.binding_status === "strongly_bound" ? "promoted" : "not_promoted",
      reason: binding.binding_status === "strongly_bound"
        ? "strong_local_actor_binding_available"
        : "observed_view_report_and_global_action_chairs_do_not_prove_local_player",
    },
  };
}

function roundSelectSourceInsights(signals) {
  const candidates = signals
    .filter((signal) => signal.type === "round_select_infos")
    .map((signal) => ({
      confidence: signal.confidence || 0,
      evidence: signal.evidence || null,
      set_id_candidate: signal.payload?.decoded?.set_id_candidate || null,
      entries: (signal.payload?.decoded?.select_entries || []).map((entry) => ({
        hero: entry.hero,
        chair_id: entry.chair_id,
        flag: entry.flag,
        unknown_state: entry.unknown_state,
        player_ref: entry.player_ref,
      })),
      binding_status: "round_select_not_promoted_to_carousel",
    }));
  return {
    count: candidates.length,
    latest: candidates.at(-1) || null,
    promotion_decision: {
      carousel_available_units: {
        status: candidates.length > 0 ? "not_promoted" : "missing",
        reason: candidates.length > 0 ? "round_select_item_and_pick_semantics_unverified" : "no_round_select_candidate_observed",
      },
      carousel_active: {
        status: "missing",
        reason: "round_select_does_not_prove_carousel_active_state",
      },
    },
  };
}

function targetedCaptureCandidateInsights(signals) {
  const candidates = signals
    .filter((signal) => signal.type === "targeted_capture_delta_candidate")
    .map((signal) => ({
      scope: signal.payload?.scope || "unknown",
      term: signal.payload?.term || "unknown",
      delta: signal.payload?.delta ?? null,
      target_fields: signal.payload?.target_fields || [],
      promotion_status: signal.payload?.promotion_status || "candidate_only",
      blocker: signal.payload?.blocker || "targeted_capture_candidate_semantics_unverified",
      confidence: signal.confidence || 0,
      evidence: signal.evidence || null,
    }));
  const byScope = {};
  const byTargetField = {};
  for (const candidate of candidates) {
    if (!byScope[candidate.scope]) byScope[candidate.scope] = { count: 0, terms: {} };
    byScope[candidate.scope].count += 1;
    byScope[candidate.scope].terms[candidate.term] = (byScope[candidate.scope].terms[candidate.term] || 0) + 1;
    for (const field of candidate.target_fields) {
      if (!byTargetField[field]) byTargetField[field] = { count: 0, scopes: {}, terms: {} };
      byTargetField[field].count += 1;
      byTargetField[field].scopes[candidate.scope] = (byTargetField[field].scopes[candidate.scope] || 0) + 1;
      byTargetField[field].terms[candidate.term] = (byTargetField[field].terms[candidate.term] || 0) + 1;
    }
  }
  return {
    count: candidates.length,
    latest: candidates.at(-1) || null,
    candidates: candidates.slice(-20),
    by_scope: byScope,
    by_target_field: byTargetField,
    promotion_decision: {
      status: candidates.length > 0 ? "not_promoted" : "missing",
      reason: candidates.length > 0
        ? "targeted_capture_delta_candidates_require_focused_field_verifier"
        : "no_targeted_capture_delta_candidate_observed",
    },
  };
}

function isPlayerChairId(value) {
  return Number.isInteger(value) && value >= 0 && value <= 7;
}

function evidenceEnvelope(signal, payload) {
  return {
    ...payload,
    confidence: signal.confidence || 0,
    evidence: signal.evidence || null,
    source_signal_type: signal.type,
  };
}

function compactChampionRef(payload) {
  if (!payload) return null;
  return {
    id: payload.champion_id ?? payload.id ?? null,
    name: payload.name ?? null,
  };
}

function compactItemRef(payload) {
  if (!payload) return null;
  return {
    id: payload.item_id ?? payload.id ?? null,
    name: payload.name ?? null,
    type: payload.item_type ?? payload.type ?? null,
  };
}

function normalizeItemRefs(items) {
  return (items || []).map((item) => ({
    ...item,
    item: compactItemRef(item),
    id: item.item_id ?? item.id ?? null,
    type: item.item_type ?? item.type ?? null,
  }));
}

function normalizeLocalSignalPayload(type, payload) {
  if (type === "board_unit_state") {
    return {
      ...payload,
      champion: compactChampionRef(payload),
      star: payload.star ?? payload.star_level ?? "unknown",
      items: normalizeItemRefs(payload.items),
      summoned: payload.summoned ?? false,
      clone: payload.clone ?? false,
    };
  }
  if (type === "bench_unit_state") {
    return {
      ...payload,
      champion: compactChampionRef(payload),
      star: payload.star ?? payload.star_level ?? "unknown",
      items: normalizeItemRefs(payload.items),
      sellable: payload.sellable ?? "unknown",
    };
  }
  if (type === "item_bench_state") {
    return {
      ...payload,
      item: compactItemRef(payload),
    };
  }
  if (type === "equipped_item_state") {
    return {
      ...payload,
      champion: compactChampionRef(payload),
      item: compactItemRef(payload),
    };
  }
  if (type === "trait_state") {
    return {
      ...payload,
      id: payload.trait_id ?? payload.id ?? null,
      name: payload.name ?? null,
      count: payload.count ?? "unknown",
      tier: payload.tier ?? "unknown",
      next_tier: payload.next_tier ?? "unknown",
      units: payload.units || [],
      choice_state: payload.choice_state ?? "unknown",
    };
  }
  if (type === "augment_selected_state") {
    return {
      ...payload,
      selected_augments: normalizeAugmentEntries(payload.selected_augments || payload.augments || []),
    };
  }
  if (type === "reward_selected_state") {
    return {
      ...payload,
      selected_reward: normalizeRewardEntry(payload.selected_reward),
    };
  }
  if (type === "carousel_selected_state") {
    return {
      ...payload,
      selected_pick: normalizeCarouselEntry(payload.selected_pick),
    };
  }
  return payload;
}

function normalizeAugmentEntries(entries, source = {}) {
  return (entries || []).map((entry) => ({
    ...entry,
    id: entry.augment_id ?? entry.id ?? null,
    name: entry.name ?? null,
    tier: entry.tier ?? entry.level ?? "unknown",
    desc: entry.desc ?? null,
    icon: entry.icon ?? null,
    evidence: source.evidence ?? entry.evidence ?? null,
    source_signal_type: source.source_signal_type ?? entry.source_signal_type ?? null,
    confidence: source.confidence ?? entry.confidence ?? 0,
  }));
}

function normalizeRewardEntry(entry, source = {}) {
  if (!entry || typeof entry !== "object") return "unknown";
  return {
    ...entry,
    type: entry.type ?? "unknown",
    id: entry.reward_id ?? entry.id ?? null,
    name: entry.name ?? null,
    slot: entry.slot ?? null,
    evidence: source.evidence ?? entry.evidence ?? null,
    source_signal_type: source.source_signal_type ?? entry.source_signal_type ?? null,
    confidence: source.confidence ?? entry.confidence ?? 0,
  };
}

function normalizeRewardEntries(entries, source = {}) {
  return (entries || []).map((entry) => normalizeRewardEntry(entry, source));
}

function normalizeCarouselEntry(entry, source = {}) {
  if (!entry || typeof entry !== "object") return "unknown";
  const championPayload = {
    champion_id: entry.champion_id ?? entry.champion?.id ?? entry.id,
    name: entry.champion_name ?? entry.champion?.name ?? entry.name,
  };
  const itemPayload = {
    item_id: entry.item_id ?? entry.item?.id,
    name: entry.item_name ?? entry.item?.name,
    item_type: entry.item_type ?? entry.item?.type,
  };
  return {
    ...entry,
    champion: compactChampionRef(championPayload),
    item: compactItemRef(itemPayload),
    position: entry.position ?? "unknown",
    evidence: source.evidence ?? entry.evidence ?? null,
    source_signal_type: source.source_signal_type ?? entry.source_signal_type ?? null,
    confidence: source.confidence ?? entry.confidence ?? 0,
  };
}

function normalizeCarouselEntries(entries, source = {}) {
  return (entries || []).map((entry) => normalizeCarouselEntry(entry, source));
}

function localSignalsByType(signals, type, chairId) {
  if (chairId == null) return [];
  return signals
    .filter((signal) => signal.type === type)
    .filter((signal) => signal.payload?.chair_id === chairId)
    .map((signal) => {
      const { chair_id, ...payload } = signal.payload || {};
      return evidenceEnvelope(signal, normalizeLocalSignalPayload(type, payload));
    });
}

function latestLocalAugmentChoice(signals, chairId) {
  const signal = localSignalsByType(signals, "augment_choice_state", chairId).at(-1);
  if (!signal) return {
    selection_active: "unknown",
    choices: [],
    rerolls: "unknown",
  };
  return {
    selection_active: signal.selection_active ?? true,
    choices: normalizeAugmentEntries(signal.choices || [], signal),
    rerolls: signal.rerolls ?? "unknown",
    confidence: signal.confidence || 0,
    evidence: signal.evidence || null,
    source_signal_type: signal.source_signal_type,
  };
}

function latestLocalSelectedAugments(signals, chairId) {
  const signal = localSignalsByType(signals, "augment_selected_state", chairId).at(-1);
  if (!signal) return [];
  return normalizeAugmentEntries(signal.selected_augments || [], signal);
}

function latestLocalRewardChoice(signals, chairId) {
  const signal = localSignalsByType(signals, "reward_choice_state", chairId).at(-1);
  if (!signal) return {
    active: "unknown",
    choices: [],
    blocking_choice: "unknown",
  };
  return {
    active: signal.active ?? true,
    choices: normalizeRewardEntries(signal.choices || [], signal),
    blocking_choice: normalizeRewardEntry(signal.blocking_choice, signal),
    confidence: signal.confidence || 0,
    evidence: signal.evidence || null,
    source_signal_type: signal.source_signal_type,
  };
}

function latestLocalSelectedReward(signals, chairId) {
  const signal = localSignalsByType(signals, "reward_selected_state", chairId).at(-1);
  if (!signal) return "unknown";
  return normalizeRewardEntry(signal.selected_reward, signal);
}

function latestLocalCarouselState(signals, chairId) {
  const signal = localSignalsByType(signals, "carousel_state", chairId).at(-1);
  if (!signal) return null;
  return {
    active: signal.active ?? true,
    available_units: normalizeCarouselEntries(signal.available_units || [], signal),
    can_pick_now: signal.can_pick_now ?? "unknown",
    confidence: signal.confidence || 0,
    evidence: signal.evidence || null,
    source_signal_type: signal.source_signal_type,
  };
}

function latestLocalCarouselSelected(signals, chairId) {
  const signal = localSignalsByType(signals, "carousel_selected_state", chairId).at(-1);
  if (!signal) return "unknown";
  return normalizeCarouselEntry(signal.selected_pick, signal);
}

function firstEvidence(items) {
  return items[0]?.evidence || null;
}

function buildFreshnessMetadata({ signalReport, activeWindow, windows }) {
  const lastSignal = activeWindow.signals.at(-1) || null;
  return {
    source_health: signalReport.source_health ? "attached" : "missing",
    field_matrix: "attached",
    game_start_time: activeWindow.game_start_time,
    active_window_start_index: activeWindow.start_index ?? 0,
    active_window_signal_count: activeWindow.signals.length,
    window_count: windows.length,
    total_signal_count: (signalReport.signals || []).length,
    last_signal_type: lastSignal?.type || null,
    last_signal_evidence: lastSignal?.evidence || null,
  };
}

function statusFromMatrixEntry(entry) {
  const status = {
    status: entry.status,
    source: "field_matrix",
    source_type: entry.source_type,
    observed_pattern: entry.observed_pattern,
    extractor: entry.extractor,
    confidence: entry.confidence,
    freshness_budget: entry.freshness_budget,
    evidence_packet: entry.evidence_packet,
    evidence_status: entry.evidence_status,
  };
  if (entry.blocker != null) status.blocker = entry.blocker;
  if (entry.next_experiment != null) status.next_experiment = entry.next_experiment;
  return status;
}

function mergeFieldStatus(status, field, override) {
  status[field] = {
    ...(status[field] || {}),
    ...override,
  };
}

function buildFieldStatus(fieldMatrix, liveValues, binding, lifecycle, strategyInputAllowed, gateReason, activeWindow, signalReport, windows) {
  const status = {};
  for (const entry of fieldMatrix.fields || []) {
    status[entry.field_key] = statusFromMatrixEntry(entry);
  }

  if (liveValues.source_insights?.round_flow_snapshots?.length > 0) {
    status["source_insights.round_flow_snapshots"] = {
      status: "observed",
      evidence: "round_flow anonymous snapshot candidates",
    };
  }
  if (liveValues.source_insights?.round_flow_binding_candidates?.length > 0) {
    status["source_insights.round_flow_binding_candidates"] = {
      status: "partial",
      evidence: "round_flow candidates scored but not promoted",
    };
  }
  if (liveValues.source_insights?.economy_candidates) {
    status["source_insights.economy_candidates"] = {
      status: "partial",
      evidence: "economy candidates audited but not promoted",
    };
  }
  if (liveValues.source_insights?.local_chair_binding_candidates) {
    status["source_insights.local_chair_binding_candidates"] = {
      status: liveValues.source_insights.local_chair_binding_candidates.promotion_decision?.status === "promoted" ? "observed" : "partial",
      evidence: "local chair binding candidate sources audited with promotion decision",
    };
  }
  if (liveValues.source_insights?.board_bench_item_candidates) {
    status["source_insights.board_bench_item_candidates"] = {
      status: "partial",
      evidence: "round_flow board/bench/item candidates audited but not promoted",
    };
  }
  if (liveValues.source_insights?.board_bench_action_candidates?.count > 0) {
    status["source_insights.board_bench_action_candidates"] = {
      status: "partial",
      evidence: "action log board/bench move candidates audited but not promoted",
    };
  }
  if (liveValues.source_insights?.folded_board_bench_state?.action_count > 0) {
    status["source_insights.folded_board_bench_state"] = {
      status: "partial",
      evidence: "local action log candidates folded for debug only; combat/observed board positions are not stable home-board state",
    };
  }
  if (liveValues.source_insights?.round_select_candidates?.count > 0) {
    status["source_insights.round_select_candidates"] = {
      status: "partial",
      evidence: "round_select candidates audited but not promoted to carousel",
    };
  }
  if (liveValues.source_insights?.targeted_capture_candidates?.count > 0) {
    status["source_insights.targeted_capture_candidates"] = {
      status: "partial",
      evidence: "targeted capture delta candidates audited but not promoted to live_state",
    };
  }

  if (lifecycle.status !== "unknown") {
    mergeFieldStatus(status, "match.status", {
      status: "verified",
      confidence: lifecycle.confidence,
      evidence: lifecycle.evidence,
      blocker: null,
      next_experiment: null,
    });
  }
  if (activeWindow.game_start_time) {
    const start = matchStartEvidence(activeWindow);
    mergeFieldStatus(status, "match.match_id", {
      status: "verified",
      confidence: start.confidence || lifecycle.confidence,
      evidence: start.evidence || "derived from match_start game_start_time",
      blocker: null,
      next_experiment: null,
    });
  }
  if (liveValues.match_set?.set_id) {
    mergeFieldStatus(status, "match.set", {
      status: "partial",
      confidence: liveValues.match_set.confidence,
      evidence: liveValues.match_set.evidence,
      blocker: "set_id_candidate_observed_but_mode_patch_mapping_unverified",
      next_experiment: "Cross-check set_id_candidate against app version/patch metadata and official set tables.",
    });
  }
  if (lifecycle.game_end_time != null) {
    mergeFieldStatus(status, "match.game_end_time", {
      status: "observed",
      confidence: lifecycle.confidence,
      evidence: lifecycle.evidence,
      blocker: null,
      next_experiment: null,
    });
  }
  if (signalReport.source_health) {
    mergeFieldStatus(status, "metadata.source_health", {
      status: "verified",
      source_type: "adb_probe_metadata",
      confidence: 0.9,
      evidence: "source-health.json attached to live_state metadata",
      blocker: null,
      next_experiment: null,
    });
  }
  if (signalReport.source_health?.adb_device_id) {
    mergeFieldStatus(status, "metadata.adb_device_id", {
      status: "verified",
      source_type: "adb_probe_metadata",
      confidence: 0.9,
      evidence: `source_health.adb_device_id:${signalReport.source_health.adb_device_id}`,
      blocker: null,
      next_experiment: null,
    });
  }
  if (signalReport.source_health?.emulator_profile) {
    mergeFieldStatus(status, "metadata.emulator_profile", {
      status: "verified",
      source_type: "adb_probe_metadata",
      confidence: signalReport.source_health.profile_is_product_boundary === false ? 0.9 : 0.7,
      evidence: `source_health.emulator_profile:${signalReport.source_health.emulator_profile}`,
      blocker: null,
      next_experiment: null,
    });
  }
  if (signalReport.source_health?.package_id) {
    mergeFieldStatus(status, "metadata.foreground_package", {
      status: "verified",
      source_type: "adb_probe_metadata",
      confidence: 0.9,
      evidence: `source_health.package_id:${signalReport.source_health.package_id}`,
      blocker: null,
      next_experiment: null,
    });
  }
  const freshness = buildFreshnessMetadata({ signalReport, activeWindow, windows });
  if (freshness.active_window_signal_count > 0) {
    mergeFieldStatus(status, "metadata.freshness", {
      status: "verified",
      source_type: "adb_probe_metadata",
      confidence: 0.9,
      evidence: `active_window_signal_count:${freshness.active_window_signal_count}; last_signal_type:${freshness.last_signal_type}`,
      blocker: null,
      next_experiment: null,
    });
  }
  for (const field of ["metadata.missing_fields", "metadata.stale_fields", "metadata.partial_fields", "metadata.fallback_fields"]) {
    mergeFieldStatus(status, field, {
      status: "verified",
      source_type: "derived_field_status",
      confidence: 0.95,
      evidence: "derived from runtime field_status after live_state normalization",
      blocker: null,
      next_experiment: null,
    });
  }
  mergeFieldStatus(status, "actions.unavailable_reason", {
    status: "partial",
    source_type: "derived_gate_reason",
    confidence: 0.5,
    evidence: "default action state is unmapped_runtime_action_state while action booleans are unknown",
    blocker: "action_availability_signals_not_mapped",
    next_experiment: "Capture planning/shop, augment, reward, equip, and carousel screens to map action availability booleans.",
  });

  if (!strategyInputAllowed) {
    for (const field of ["phase.turn_count", "economy.hp", "shop.shop_units", "board.board_units", "bench.bench_units", "items.item_bench", "items.equipped_items", "opponents.alive_count", "combat.opponent_chair_id", "combat.is_home_board"]) {
      mergeFieldStatus(status, field, { status: "blocked", blocker: gateReason });
    }
    if (binding.binding_status === "strongly_bound") {
      mergeFieldStatus(status, "local.local_chair_id", {
        status: "verified",
        confidence: binding.confidence,
        evidence: binding.evidence,
        blocker: null,
        next_experiment: null,
      });
    } else if (binding.binding_status === "weakly_bound_conflicting_reports") {
      mergeFieldStatus(status, "local.local_chair_id", {
        status: "partial",
        confidence: binding.confidence,
        evidence: binding.evidence,
        blocker: binding.blocker,
        next_experiment: "Capture or derive stable local actor/account binding before promoting player-specific state.",
      });
    } else {
      mergeFieldStatus(status, "local.local_chair_id", { status: "missing", blocker: "local_chair_id_unbound" });
    }
    return status;
  }

  if (binding.binding_status === "strongly_bound") {
    mergeFieldStatus(status, "local.local_chair_id", {
      status: "verified",
      confidence: binding.confidence,
      evidence: binding.evidence,
      blocker: null,
      next_experiment: null,
    });
  } else if (binding.binding_status === "weakly_bound_conflicting_reports") {
    mergeFieldStatus(status, "local.local_chair_id", {
      status: "partial",
      confidence: binding.confidence,
      evidence: binding.evidence,
      blocker: binding.blocker,
      next_experiment: "Capture or derive stable local actor/account binding before promoting player-specific state.",
    });
  }
  if (liveValues.hp != null) {
    mergeFieldStatus(status, "economy.hp", {
      status: "verified",
      evidence: "latest player_life for bound local_chair_id",
      blocker: null,
      next_experiment: null,
    });
  }
  if (liveValues.shop_candidates.length > 0) {
    mergeFieldStatus(status, "shop.shop_units", {
      status: "verified",
      evidence: "latest shop_roll_candidate",
      blocker: null,
      next_experiment: null,
    });
  }
  if (Number.isFinite(liveValues.shop_refresh?.refresh_count)) {
    mergeFieldStatus(status, "shop.refresh_count", {
      status: "partial",
      confidence: liveValues.shop_refresh.confidence,
      evidence: liveValues.shop_refresh.evidence,
      source_signal_type: liveValues.shop_refresh.source_signal_type,
      blocker: "observed_shop_generation_count_not_paid_reroll_count",
      next_experiment: "Capture manual reroll and shop-lock transitions to separate paid reroll count from automatic shop list generation.",
    });
  }
  if (liveValues.phase.turn_count != null) {
    mergeFieldStatus(status, "phase.turn_count", {
      status: "partial",
      confidence: liveValues.phase.confidence,
      evidence: liveValues.phase.evidence,
    });
  }
  if (liveValues.phase.phase !== "unknown") {
    mergeFieldStatus(status, "phase.phase", {
      status: "partial",
      source_signal_type: liveValues.phase.phase_source_signal_type,
      confidence: liveValues.phase.phase_confidence,
      evidence: liveValues.phase.phase_evidence,
      blocker: "phase_semantics_candidate_from_draft_signal_only",
      next_experiment: "Capture planning/combat/carousel transitions with visible phase labels and timers.",
    });
  }
  if (liveValues.phase.stage != null) {
    mergeFieldStatus(status, "phase.stage", {
      status: "partial",
      confidence: liveValues.phase.stage_confidence,
      evidence: liveValues.phase.stage_evidence,
      blocker: "round_flow_stage_candidate_semantics_unverified",
      next_experiment: "Cross-check round_flow major candidate against visible stage labels across planning/combat/carousel.",
    });
  }
  if (liveValues.phase.round != null) {
    mergeFieldStatus(status, "phase.round", {
      status: "partial",
      confidence: liveValues.phase.round_confidence,
      evidence: liveValues.phase.round_evidence,
      blocker: "round_flow_round_candidate_semantics_unverified",
      next_experiment: "Cross-check round_flow minor candidate against visible round labels across planning/combat/carousel.",
    });
  }
  if (liveValues.opponents.alive_count != null) {
    mergeFieldStatus(status, "opponents.alive_count", {
      status: "partial",
      confidence: liveValues.opponents.alive_count_confidence,
      evidence: liveValues.opponents.alive_count_evidence,
    });
  }
  if (liveValues.combat.opponent_chair_id != null) {
    mergeFieldStatus(status, "combat.opponent_chair_id", {
      status: "partial",
      confidence: liveValues.combat.confidence,
      evidence: liveValues.combat.evidence,
    });
  }
  if (liveValues.combat.is_home_board != null) {
    mergeFieldStatus(status, "combat.is_home_board", {
      status: "partial",
      confidence: liveValues.combat.confidence,
      evidence: liveValues.combat.evidence,
    });
  }
  if (Number.isFinite(liveValues.combat.earned_money)) {
    mergeFieldStatus(status, "combat.earned_money", {
      status: "partial",
      confidence: liveValues.combat.earned_money_confidence,
      evidence: liveValues.combat.earned_money_evidence,
      blocker: "battle_income_known_but_total_gold_unverified",
      next_experiment: "Correlate battle_result_money with visible total gold before promoting economy.gold.",
    });
  }
  if (Number.isFinite(liveValues.combat.damage_taken)) {
    mergeFieldStatus(status, "combat.damage_taken", {
      status: "partial",
      confidence: liveValues.combat.damage_taken_confidence,
      evidence: liveValues.combat.damage_taken_evidence,
      blocker: "battle_damage_known_but_combat_result_semantics_unverified",
      next_experiment: "Correlate battle_result_life with combat result/win_loss and post-combat hp.",
    });
  }
  if (liveValues.combat.active !== "unknown") {
    mergeFieldStatus(status, "combat.active", {
      status: "partial",
      source_signal_type: liveValues.combat.active.source_signal_type,
      confidence: liveValues.combat.active.confidence,
      evidence: liveValues.combat.active.evidence,
      blocker: "combat_phase_active_semantics_require_timer_or_visible_phase_calibration",
      next_experiment: "Capture combat start/end with visible timer or phase label to calibrate active duration.",
    });
  }
  if (liveValues.combat.result !== "unknown") {
    mergeFieldStatus(status, "combat.result", {
      status: "partial",
      source_signal_type: liveValues.combat.result.source_signal_type,
      confidence: liveValues.combat.result.confidence,
      evidence: liveValues.combat.result.evidence,
      blocker: "combat_result_semantics_require_round_result_calibration",
      next_experiment: "Capture combat end with visible result banner and remaining units to calibrate battle_result_life semantics.",
    });
  }
  if (liveValues.combat.win_loss !== "unknown") {
    mergeFieldStatus(status, "combat.win_loss", {
      status: "partial",
      source_signal_type: liveValues.combat.win_loss_source_signal_type,
      confidence: liveValues.combat.win_loss_confidence,
      evidence: liveValues.combat.win_loss_evidence,
      blocker: "win_loss_semantics_require_round_result_calibration",
      next_experiment: "Correlate no-damage/damage battle_result_life events with visible win/loss banners across multiple combats.",
    });
  }
  if (liveValues.carousel.active !== "unknown") {
    const carouselActiveEvidence = typeof liveValues.carousel.active === "object"
      ? liveValues.carousel.active
      : liveValues.carousel;
    mergeFieldStatus(status, "carousel.active", {
      status: liveValues.carousel.semantic_status === "observed_local_carousel_state" ? "observed" : "partial",
      source_signal_type: carouselActiveEvidence.source_signal_type,
      confidence: carouselActiveEvidence.confidence,
      evidence: carouselActiveEvidence.evidence,
      blocker: liveValues.carousel.semantic_status === "observed_local_carousel_state" ? null : "draft_turn_start_observed_but_pick_window_and_units_unmapped",
      next_experiment: liveValues.carousel.semantic_status === "observed_local_carousel_state" ? null : "Capture carousel stage with available unit+item list visible and local pick timing.",
    });
  }
  if (liveValues.carousel.available_units.length > 0) {
    mergeFieldStatus(status, "carousel.available_units", {
      status: "observed",
      confidence: liveValues.carousel.available_units[0].confidence,
      evidence: firstEvidence(liveValues.carousel.available_units),
      blocker: null,
      next_experiment: null,
    });
  }
  if (liveValues.carousel.can_pick_now !== "unknown") {
    mergeFieldStatus(status, "carousel.can_pick_now", {
      status: "observed",
      confidence: liveValues.carousel.confidence,
      evidence: liveValues.carousel.evidence,
      blocker: null,
      next_experiment: null,
    });
  }
  if (liveValues.carousel.selected_pick !== "unknown") {
    mergeFieldStatus(status, "carousel.selected_pick", {
      status: "observed",
      confidence: liveValues.carousel.selected_pick.confidence,
      evidence: liveValues.carousel.selected_pick.evidence,
      blocker: null,
      next_experiment: null,
    });
  }
  if (liveValues.opponents.current_opponent !== "unknown") {
    mergeFieldStatus(status, "opponents.current_opponent", {
      status: "partial",
      confidence: liveValues.opponents.current_opponent.confidence,
      evidence: liveValues.opponents.current_opponent.evidence,
      blocker: "opponent_chair_known_but_opponent_board_is_not_a_product_source",
      next_experiment: "Keep pairing and lobby facts only; do not derive opponent board or counter-positioning from current-view data.",
    });
  }
  if (liveValues.board_units.length > 0) {
    mergeFieldStatus(status, "board.board_units", {
      status: "observed",
      confidence: liveValues.board_units[0].confidence,
      evidence: firstEvidence(liveValues.board_units),
    });
  }
  if (liveValues.bench_units.length > 0) {
    mergeFieldStatus(status, "bench.bench_units", {
      status: "observed",
      confidence: liveValues.bench_units[0].confidence,
      evidence: firstEvidence(liveValues.bench_units),
    });
  }
  if (liveValues.item_bench.length > 0) {
    mergeFieldStatus(status, "items.item_bench", {
      status: "observed",
      confidence: liveValues.item_bench[0].confidence,
      evidence: firstEvidence(liveValues.item_bench),
    });
  }
  if (liveValues.equipped_items.length > 0) {
    mergeFieldStatus(status, "items.equipped_items", {
      status: "observed",
      confidence: liveValues.equipped_items[0].confidence,
      evidence: firstEvidence(liveValues.equipped_items),
    });
  }
  if (liveValues.active_traits.length > 0) {
    mergeFieldStatus(status, "traits.active_traits", {
      status: "observed",
      confidence: liveValues.active_traits[0].confidence,
      evidence: firstEvidence(liveValues.active_traits),
      blocker: null,
      next_experiment: null,
    });
  }
  if (liveValues.augments.selection_active !== "unknown") {
    mergeFieldStatus(status, "augments.selection_active", {
      status: "observed",
      confidence: liveValues.augments.confidence,
      evidence: liveValues.augments.evidence,
      blocker: null,
      next_experiment: null,
    });
  }
  if (liveValues.augments.choices.length > 0) {
    mergeFieldStatus(status, "augments.choices", {
      status: "observed",
      confidence: liveValues.augments.choices[0].confidence,
      evidence: firstEvidence(liveValues.augments.choices),
      blocker: null,
      next_experiment: null,
    });
  }
  if (liveValues.augments.selected_augments.length > 0) {
    mergeFieldStatus(status, "augments.selected_augments", {
      status: "observed",
      confidence: liveValues.augments.selected_augments[0].confidence,
      evidence: firstEvidence(liveValues.augments.selected_augments),
      blocker: null,
      next_experiment: null,
    });
  }
  if (liveValues.augments.rerolls !== "unknown") {
    mergeFieldStatus(status, "augments.rerolls", {
      status: "observed",
      confidence: liveValues.augments.confidence,
      evidence: liveValues.augments.evidence,
      blocker: null,
      next_experiment: null,
    });
  }
  if (liveValues.rewards.active !== "unknown") {
    mergeFieldStatus(status, "rewards.active", {
      status: "observed",
      confidence: liveValues.rewards.confidence,
      evidence: liveValues.rewards.evidence,
      blocker: null,
      next_experiment: null,
    });
  }
  if (liveValues.rewards.choices.length > 0) {
    mergeFieldStatus(status, "rewards.choices", {
      status: "observed",
      confidence: liveValues.rewards.choices[0].confidence,
      evidence: firstEvidence(liveValues.rewards.choices),
      blocker: null,
      next_experiment: null,
    });
  }
  if (liveValues.rewards.selected_reward !== "unknown") {
    mergeFieldStatus(status, "rewards.selected_reward", {
      status: "observed",
      confidence: liveValues.rewards.selected_reward.confidence,
      evidence: liveValues.rewards.selected_reward.evidence,
      blocker: null,
      next_experiment: null,
    });
  }
  if (liveValues.rewards.blocking_choice !== "unknown") {
    mergeFieldStatus(status, "rewards.blocking_choice", {
      status: "observed",
      confidence: liveValues.rewards.blocking_choice.confidence,
      evidence: liveValues.rewards.blocking_choice.evidence,
      blocker: null,
      next_experiment: null,
    });
  }
  return status;
}

function emptyPlayerSpecificValues() {
  return {
    phase: { phase: "unknown", turn_count: null, stage: null, round: null, planning_timer: "unknown", combat_timer: "unknown" },
    match_set: { set_id: null },
    hp: null,
    shop_candidates: [],
    shop_refresh: { refresh_count: "unknown" },
    board_units: [],
    bench_units: [],
    item_bench: [],
    equipped_items: [],
    active_traits: [],
    augments: {
      selection_active: "unknown",
      choices: [],
      selected_augments: [],
      rerolls: "unknown",
    },
    rewards: {
      active: "unknown",
      choices: [],
      selected_reward: "unknown",
      blocking_choice: "unknown",
    },
    opponents: { alive_count: null, current_opponent: "unknown" },
    combat: { active: "unknown", opponent_chair_id: null, is_home_board: null, result: "unknown", win_loss: "unknown" },
    variables: {
      other_set_variables: {},
    },
    carousel: {
      active: "unknown",
      available_units: [],
      can_pick_now: "unknown",
      selected_pick: "unknown",
      semantic_status: "unknown",
    },
    source_insights: { round_flow_snapshots: [] },
  };
}

function blockedPlayerSpecificValues(sourceInsights = {}) {
  return {
    ...emptyPlayerSpecificValues(),
    source_insights: {
      ...sourceInsights,
      blocked_player_specific_state: {
        status: "blocked",
        reason: "local_chair_id_not_strongly_bound_or_match_closed",
      },
    },
  };
}

function buildSchemaSections({
  activeWindow,
  windows,
  lifecycle,
  binding,
  liveValues,
  signalReport,
  missingFields,
  partialFields,
  fallbackFields,
  staleFields,
}) {
  return {
    match: {
      match_id: activeWindow.game_start_time ? `jcc:${activeWindow.game_start_time}` : null,
      game_start_time: activeWindow.game_start_time,
      game_end_time: lifecycle.game_end_time,
      status: lifecycle.status,
      mode: null,
      set: liveValues.match_set?.set_id || null,
      patch: null,
      set_confidence: liveValues.match_set?.confidence,
      set_evidence: liveValues.match_set?.evidence,
    },
    local: {
      local_chair_id: binding.local_chair_id,
      binding_status: binding.binding_status,
      binding_source: binding.binding_source,
      binding_confidence: binding.confidence,
      binding_evidence: binding.evidence,
      binding_candidates: binding.binding_candidates || [],
      binding_blocker: binding.blocker || null,
    },
    phase: {
      phase: liveValues.phase.phase,
      round: liveValues.phase.round ?? "unknown",
      stage: liveValues.phase.stage ?? "unknown",
      turn_count: liveValues.phase.turn_count,
      planning_timer: "unknown",
      combat_timer: "unknown",
      confidence: liveValues.phase.confidence,
      evidence: liveValues.phase.evidence,
      phase_confidence: liveValues.phase.phase_confidence,
      phase_evidence: liveValues.phase.phase_evidence,
      phase_source_signal_type: liveValues.phase.phase_source_signal_type,
      stage_confidence: liveValues.phase.stage_confidence,
      stage_evidence: liveValues.phase.stage_evidence,
      round_confidence: liveValues.phase.round_confidence,
      round_evidence: liveValues.phase.round_evidence,
    },
    economy: {
      hp: liveValues.hp,
      gold: "unknown",
      level: "unknown",
      xp: "unknown",
      xp_to_next: "unknown",
      interest: "unknown",
      streak: "unknown",
      income: "unknown",
      free_rerolls: "unknown",
      shop_locked: "unknown",
    },
    shop: {
      shop_units: liveValues.shop_candidates,
      refresh_count: liveValues.shop_refresh?.refresh_count ?? "unknown",
      lock_state: "unknown",
    },
    board: {
      board_units: liveValues.board_units,
      board_size: "unknown",
      max_units: "unknown",
    },
    bench: {
      bench_units: liveValues.bench_units,
      bench_full: "unknown",
      special_slots: "unknown",
    },
    items: {
      item_bench: liveValues.item_bench,
      equipped_items: liveValues.equipped_items,
      components: [],
      completed: [],
      radiant_items: [],
      artifact_items: [],
      support_items: [],
      emblems: [],
      anvils: [],
      reforgers: [],
      removers: [],
      duplicators: [],
      loot_orbs: [],
    },
    augments: {
      selection_active: liveValues.augments.selection_active,
      choices: liveValues.augments.choices,
      selected_augments: liveValues.augments.selected_augments,
      rerolls: liveValues.augments.rerolls,
    },
    variables: {
      other_set_variables: {},
    },
    traits: {
      active_traits: liveValues.active_traits,
    },
    carousel: {
      active: liveValues.carousel.active,
      available_units: liveValues.carousel.available_units,
      can_pick_now: liveValues.carousel.can_pick_now,
      selected_pick: liveValues.carousel.selected_pick,
    },
    rewards: {
      active: liveValues.rewards.active,
      choices: liveValues.rewards.choices,
      selected_reward: liveValues.rewards.selected_reward,
      blocking_choice: liveValues.rewards.blocking_choice,
    },
    opponents: {
      alive_count: liveValues.opponents.alive_count,
      current_rank: "unknown",
      next_opponent: "unknown",
      current_opponent: liveValues.opponents.current_opponent,
    },
    combat: {
      active: liveValues.combat.active,
      opponent_chair_id: liveValues.combat.opponent_chair_id,
      is_home_board: liveValues.combat.is_home_board,
      result: liveValues.combat.result,
      win_loss: liveValues.combat.win_loss,
      damage_taken: liveValues.combat.damage_taken,
      damage_taken_confidence: liveValues.combat.damage_taken_confidence,
      damage_taken_evidence: liveValues.combat.damage_taken_evidence,
      damage_taken_source_signal_type: liveValues.combat.damage_taken_source_signal_type,
      damage_dealt: "unknown",
      earned_money: liveValues.combat.earned_money,
      earned_money_confidence: liveValues.combat.earned_money_confidence,
      earned_money_evidence: liveValues.combat.earned_money_evidence,
      earned_money_source_signal_type: liveValues.combat.earned_money_source_signal_type,
      remaining_units: "unknown",
      confidence: liveValues.combat.confidence,
      evidence: liveValues.combat.evidence,
      source_signal_type: liveValues.combat.source_signal_type,
    },
    actions: {
      can_buy: "unknown",
      can_sell: "unknown",
      can_level: "unknown",
      can_roll: "unknown",
      can_move: "unknown",
      can_equip: "unknown",
      can_choose_augment: "unknown",
      can_choose_reward: "unknown",
      can_pick_carousel: "unknown",
      unavailable_reason: "unmapped_runtime_action_state",
    },
    metadata: {
      source_health: signalReport.source_health || null,
      adb_device_id: signalReport.source_health?.adb_device_id || null,
      emulator_profile: signalReport.source_health?.emulator_profile || "unknown",
      foreground_package: signalReport.source_health?.package_id || "unknown",
      freshness: {
        ...buildFreshnessMetadata({ signalReport, activeWindow, windows }),
      },
      missing_fields: missingFields,
      stale_fields: staleFields,
      partial_fields: partialFields,
      fallback_fields: fallbackFields,
    },
  };
}

async function loadMatrixSummary() {
  try {
    const matrix = JSON.parse(await readFile(MATRIX_REF, "utf8"));
    const counts = {};
    const fieldsByStatus = {};
    for (const field of matrix.fields || []) {
      counts[field.status] = (counts[field.status] || 0) + 1;
      if (!fieldsByStatus[field.status]) fieldsByStatus[field.status] = [];
      fieldsByStatus[field.status].push(field.field_key);
    }
    return {
      schema_ref: SCHEMA_REF,
      evidence_matrix_ref: MATRIX_REF,
      field_status_counts: counts,
      fields: matrix.fields || [],
      verified_fields: fieldsByStatus.verified || [],
      partial_fields: fieldsByStatus.partial || [],
      missing_fields: fieldsByStatus.missing || [],
      fallback_fields: fieldsByStatus.fallback_only || [],
      blocked_fields: fieldsByStatus.blocked || [],
    };
  } catch {
    return {
      schema_ref: SCHEMA_REF,
      evidence_matrix_ref: MATRIX_REF,
      field_status_counts: {},
      fields: [],
      verified_fields: [],
      partial_fields: [],
      missing_fields: [],
      fallback_fields: [],
      blocked_fields: [],
    };
  }
}

function fieldsWithStatus(fieldMatrix, fieldStatus, wantedStatus) {
  return (fieldMatrix.fields || [])
    .filter((field) => (fieldStatus[field.field_key]?.status || field.status) === wantedStatus)
    .map((field) => field.field_key);
}

async function buildLiveState(signalReport) {
  const signals = signalReport.signals || [];
  const windows = splitMatchWindows(signals);
  const activeWindow = windows.at(-1) || { game_start_time: null, signals: [] };
  const lifecycle = matchLifecycle(activeWindow);
  const binding = bindLocalChair(activeWindow.signals, signalReport.manual_local_chair_binding || null, activeWindow.game_start_time);
  const hp = latestPlayerLife(activeWindow.signals, binding.local_chair_id);
  const shop_candidates = latestShopCandidates(activeWindow.signals);
  const shop_refresh = shopRefreshCandidate(activeWindow.signals);
  const turn = latestTurnCount(activeWindow.signals);
  const stageRound = latestRoundStageCandidate(activeWindow.signals);
  const matchSet = latestMatchSetCandidate(activeWindow.signals);
  const alive = aliveCount(activeWindow.signals, binding.local_chair_id);
  const sourceInsights = roundFlowSourceInsights(activeWindow.signals);
  const bindingAssessment = roundFlowBindingAssessment(sourceInsights.round_flow_snapshots, binding, hp);
  const economyCandidates = economyCandidateAudit(activeWindow.signals);
  const roundSelectCandidates = roundSelectSourceInsights(activeWindow.signals);
  const targetedCaptureCandidates = targetedCaptureCandidateInsights(activeWindow.signals);
  const boardBenchActionCandidates = boardBenchActionCandidateInsights(activeWindow.signals, binding);
  const localChairBindingCandidates = localChairBindingCandidateAudit(activeWindow.signals, binding);
  const foldedBoardBench = binding.binding_status === "strongly_bound" && activeWindow.game_start_time
    ? foldedLocalBoardBenchFromActions(activeWindow.signals, binding.local_chair_id)
    : blockedFoldedBoardBench(!activeWindow.game_start_time
      ? "match_start_missing_current_window"
      : (binding.blocker || "local_chair_id_not_strongly_bound"));
  const combat = latestCombatPairing(activeWindow.signals, binding.local_chair_id);
  const combatMoney = latestCombatEarnedMoney(activeWindow.signals, binding.local_chair_id);
  const combatDamage = latestCombatDamageTaken(activeWindow.signals, binding.local_chair_id);
  const combatResult = combatResultCandidate(combatDamage, binding.local_chair_id);
  const combatActive = combatActiveCandidate(combat, combatDamage, combatMoney, binding.local_chair_id);
  const augmentChoice = latestLocalAugmentChoice(activeWindow.signals, binding.local_chair_id);
  const selectedAugments = latestLocalSelectedAugments(activeWindow.signals, binding.local_chair_id);
  const rewardChoice = latestLocalRewardChoice(activeWindow.signals, binding.local_chair_id);
  const selectedReward = latestLocalSelectedReward(activeWindow.signals, binding.local_chair_id);
  const localCarousel = latestLocalCarouselState(activeWindow.signals, binding.local_chair_id);
  const selectedCarouselPick = latestLocalCarouselSelected(activeWindow.signals, binding.local_chair_id);
  const variables = {
    other_set_variables: {},
  };
  const carouselActiveCandidate = latestVariableCandidate(activeWindow.signals, "carousel_active_candidate");
  const carousel = localCarousel
    ? {
      active: localCarousel.active,
      available_units: localCarousel.available_units,
      can_pick_now: localCarousel.can_pick_now,
      selected_pick: selectedCarouselPick,
      confidence: localCarousel.confidence,
      evidence: localCarousel.evidence,
      source_signal_type: localCarousel.source_signal_type,
      semantic_status: "observed_local_carousel_state",
    }
    : {
      active: carouselActiveCandidate,
      available_units: [],
      can_pick_now: "unknown",
      selected_pick: "unknown",
      semantic_status: "candidate_only",
    };
  const phaseCurrent = phaseCandidateFromCarousel(carousel.active, carousel);
  const localBoardUnits = localSignalsByType(activeWindow.signals, "board_unit_state", binding.local_chair_id);
  const localBenchUnits = localSignalsByType(activeWindow.signals, "bench_unit_state", binding.local_chair_id);
  const boundLiveValues = {
    phase: {
      phase: phaseCurrent.phase,
      phase_confidence: phaseCurrent.phase_confidence ?? 0,
      phase_evidence: phaseCurrent.phase_evidence ?? null,
      phase_source_signal_type: phaseCurrent.phase_source_signal_type ?? null,
      turn_count: turn?.turn_count ?? null,
      confidence: turn?.confidence ?? 0,
      evidence: turn?.evidence ?? null,
      stage: stageRound.stage,
      stage_confidence: stageRound.confidence ?? 0,
      stage_evidence: stageRound.evidence ?? null,
      round: stageRound.round,
      round_confidence: stageRound.confidence ?? 0,
      round_evidence: stageRound.evidence ?? null,
      planning_timer: "unknown",
      combat_timer: "unknown",
    },
    match_set: matchSet,
    hp,
    shop_candidates,
    shop_refresh,
    board_units: localBoardUnits,
    bench_units: localBenchUnits,
    item_bench: localSignalsByType(activeWindow.signals, "item_bench_state", binding.local_chair_id),
    equipped_items: localSignalsByType(activeWindow.signals, "equipped_item_state", binding.local_chair_id),
    active_traits: localSignalsByType(activeWindow.signals, "trait_state", binding.local_chair_id),
    augments: {
      selection_active: augmentChoice.selection_active,
      choices: augmentChoice.choices,
      selected_augments: selectedAugments,
      rerolls: augmentChoice.rerolls,
      confidence: augmentChoice.confidence || 0,
      evidence: augmentChoice.evidence || null,
      source_signal_type: augmentChoice.source_signal_type || null,
    },
    rewards: {
      active: rewardChoice.active,
      choices: rewardChoice.choices,
      selected_reward: selectedReward,
      blocking_choice: rewardChoice.blocking_choice,
      confidence: rewardChoice.confidence || 0,
      evidence: rewardChoice.evidence || null,
      source_signal_type: rewardChoice.source_signal_type || null,
    },
    opponents: {
      alive_count: alive?.count ?? null,
      alive_count_confidence: alive?.confidence ?? 0,
      alive_count_evidence: alive?.evidence ?? null,
      current_opponent: currentOpponentFromCombat(combat, binding.local_chair_id),
    },
    combat: {
      active: combatActive,
      ...combat,
      ...combatMoney,
      ...combatDamage,
      ...combatResult,
    },
    variables,
    carousel,
    source_insights: {
      ...sourceInsights,
      round_flow_binding_candidates: bindingAssessment.candidates,
      round_flow_binding_decision: bindingAssessment.decision,
      economy_candidates: economyCandidates,
      local_chair_binding_candidates: localChairBindingCandidates,
      round_select_candidates: roundSelectCandidates,
      targeted_capture_candidates: targetedCaptureCandidates,
      board_bench_action_candidates: boardBenchActionCandidates,
      folded_board_bench_state: foldedBoardBench,
    },
  };
  const gateReason = !activeWindow.game_start_time
    ? "match_start_missing_current_window"
    : binding.binding_status !== "strongly_bound"
    ? (binding.blocker || "local_chair_id_unbound")
    : lifecycle.status === "ended"
      ? "match_ended"
      : null;
  const strategyInputAllowed = !gateReason;
  const liveValues = strategyInputAllowed ? boundLiveValues : blockedPlayerSpecificValues(boundLiveValues.source_insights);
  const fieldMatrix = await loadMatrixSummary();
  const staleFields = strategyInputAllowed ? [] : ["player_specific_state"];
  const fieldStatus = buildFieldStatus(fieldMatrix, liveValues, binding, lifecycle, strategyInputAllowed, gateReason, activeWindow, signalReport, windows);
  const liveStateMissingFields = fieldsWithStatus(fieldMatrix, fieldStatus, "missing");
  const liveStatePartialFields = fieldsWithStatus(fieldMatrix, fieldStatus, "partial");
  const liveStateFallbackFields = fieldsWithStatus(fieldMatrix, fieldStatus, "fallback_only");
  const liveStateStaleFields = staleFields;
  const schemaSections = buildSchemaSections({
    activeWindow,
    lifecycle,
    binding,
    liveValues,
    signalReport,
    windows,
    missingFields: liveStateMissingFields,
    partialFields: liveStatePartialFields,
    fallbackFields: liveStateFallbackFields,
    staleFields: liveStateStaleFields,
  });

  return {
    ok: strategyInputAllowed,
    source: {
      signal_kind: signalReport.signal_kind || "candidate_runtime_signals",
      window_count: windows.length,
      active_signal_count: activeWindow.signals.length,
      source_health: signalReport.source_health || null,
    },
    runtime_contract: {
      source_model: "android_runtime_signals_to_match_scoped_live_state",
      opening_gate: "local_chair_id_required_before_strategy",
      chair_policy: "do_not_reuse_previous_match_chair; bind on each GameStart before strategy",
      reference_model: "TFT overlay-style split: source events -> local player binding -> match live state -> strategy input",
      recommendation_config_policy: "ignored_for_live_state_binding",
    },
    match: {
      game_start_time: activeWindow.game_start_time,
      game_end_time: lifecycle.game_end_time,
      status: lifecycle.status,
      local_chair_id: binding.local_chair_id,
      binding_status: binding.binding_status,
      binding_source: binding.binding_source,
      binding_confidence: binding.confidence,
      binding_evidence: binding.evidence,
    },
    live_state: {
      ...schemaSections,
      ...liveValues,
      gate: {
        strategy_input_allowed: strategyInputAllowed,
        reason: gateReason,
      },
      field_status: fieldStatus,
      missing_fields: liveStateMissingFields,
      partial_fields: liveStatePartialFields,
      fallback_fields: liveStateFallbackFields,
      stale_fields: liveStateStaleFields,
    },
    metadata: {
      source_health: signalReport.source_health || null,
      adb_device_id: signalReport.source_health?.adb_device_id || null,
      emulator_profile: signalReport.source_health?.emulator_profile || "unknown",
      foreground_package: signalReport.source_health?.package_id || "unknown",
      freshness: {
        ...buildFreshnessMetadata({ signalReport, activeWindow, windows }),
      },
      missing_fields: liveStateMissingFields,
      stale_fields: liveStateStaleFields,
      partial_fields: liveStatePartialFields,
      fallback_fields: liveStateFallbackFields,
    },
    field_matrix: fieldMatrix,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.signals) throw new Error(`Missing --signals\n${usage()}`);

  const signalReport = JSON.parse(await readFile(options.signals, "utf8"));
  if (options.sourceHealth) {
    signalReport.source_health = JSON.parse(await readFile(options.sourceHealth, "utf8"));
  }
  if (options.manualBinding) {
    signalReport.manual_local_chair_binding = JSON.parse(await readFile(options.manualBinding, "utf8"));
  }
  const liveState = await buildLiveState(signalReport);
  const text = `${JSON.stringify(liveState, null, 2)}\n`;
  if (options.out) await writeFile(options.out, text, "utf8");
  else process.stdout.write(text);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
