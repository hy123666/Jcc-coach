import { readFile, writeFile } from "node:fs/promises";

function usage() {
  return [
    "Usage:",
    "  node tools/diff-jcc-current-match-actions.mjs --before <signals.json> --after <signals.json> [--champion-id <id>] [--out <diff.json>]",
    "",
    "Diffs only board/bench/sell action candidates inside the latest GameStart window.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--before") options.before = argv[++index];
    else if (arg === "--after") options.after = argv[++index];
    else if (arg === "--champion-id") options.championId = String(argv[++index]);
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function latestMatchWindow(signals) {
  let startIndex = -1;
  for (let index = signals.length - 1; index >= 0; index -= 1) {
    if (signals[index].type === "match_start") {
      startIndex = index;
      break;
    }
  }
  const windowSignals = startIndex >= 0 ? signals.slice(startIndex) : signals;
  const matchStart = startIndex >= 0 ? signals[startIndex] : null;
  return {
    start_index: startIndex >= 0 ? startIndex : 0,
    game_start_time: matchStart?.payload?.game_start_time || null,
    signals: windowSignals,
  };
}

function actionSignals(signals) {
  return signals.filter((signal) => (
    signal.type === "get_on_chess_candidate"
    || signal.type === "move_battle_chess_candidate"
    || signal.type === "sell_chess_candidate"
  ));
}

function isPlayerChairId(value) {
  return Number.isInteger(value) && value >= 0 && value <= 7;
}

function bindLocalChair(signals) {
  const actorBinding = bindLocalChairFromActionActor(signals);
  if (actorBinding) return actorBinding;

  const localReports = signals
    .filter((signal) => signal.type === "local_report_chair_candidate")
    .filter((signal) => Number.isInteger(signal.payload?.chair_id));
  if (localReports.length === 0) {
    return {
      local_chair_id: null,
      binding_status: "unbound",
      blocker: "no_local_report_chair_candidate",
      binding_candidates: [],
    };
  }
  const counts = new Map();
  for (const signal of localReports) {
    const chairId = signal.payload.chair_id;
    counts.set(chairId, (counts.get(chairId) || 0) + 1);
  }
  const latest = localReports.at(-1);
  const candidates = [...counts.keys()].sort((left, right) => left - right)
    .map((chair_id) => ({ chair_id, count: counts.get(chair_id) }));
  if (counts.size > 1) {
    return {
      local_chair_id: latest.payload.chair_id,
      binding_status: "weakly_bound_conflicting_reports",
      blocker: "local_report_chair_candidates_conflict_within_match_window",
      binding_candidates: candidates,
    };
  }
  return {
    local_chair_id: latest.payload.chair_id,
    binding_status: "weakly_bound_report_cycle",
    blocker: "local_report_chair_candidate_is_not_a_proven_local_player_binding",
    binding_candidates: candidates,
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
    const existing = actionCountsByActor.get(actorRef) || { actor_ref: actorRef, chair_id: chairId, count: 0 };
    existing.count += 1;
    actionCountsByActor.set(actorRef, existing);
  }
  const candidates = [...actionCountsByActor.values()]
    .sort((left, right) => right.count - left.count || left.chair_id - right.chair_id);
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  return {
    local_chair_id: candidate.chair_id,
    binding_status: "strongly_bound",
    blocker: null,
    binding_source: "action_actor_switch_player_chair",
    binding_candidates: candidates.map(({ chair_id, count, actor_ref }) => ({ chair_id, count, actor_ref })),
  };
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

function resolvedActionChairId(signal, actorToChair) {
  const actorRef = signal.payload?.actor_ref;
  if (actorRef && actorToChair.has(actorRef)) return actorToChair.get(actorRef);
  const candidate = signal.payload?.action_chair_id_candidate;
  return isPlayerChairId(candidate) ? candidate : null;
}

function actionKey(signal) {
  const payload = signal.payload || {};
  const position = payload.position || payload.to || {};
  const from = payload.from || {};
  return [
    signal.type,
    payload.actor_ref ?? "",
    payload.action_chair_id_candidate ?? "",
    payload.entity_id ?? "",
    payload.raw_hero_id ?? "",
    from.x ?? "",
    from.y ?? "",
    position.x ?? "",
    position.y ?? "",
    signal.evidence ?? "",
  ].join("|");
}

function subtractMultiset(afterActions, beforeActions) {
  const beforeCounts = new Map();
  for (const action of beforeActions) {
    const key = actionKey(action);
    beforeCounts.set(key, (beforeCounts.get(key) || 0) + 1);
  }
  const added = [];
  for (const action of afterActions) {
    const key = actionKey(action);
    const count = beforeCounts.get(key) || 0;
    if (count > 0) {
      beforeCounts.set(key, count - 1);
      continue;
    }
    added.push(action);
  }
  return added;
}

function compactAction(signal, actorToChair, binding) {
  const payload = signal.payload || {};
  const resolvedChairId = resolvedActionChairId(signal, actorToChair);
  const isStrongLocal = binding.binding_status === "strongly_bound";
  const localScope = !isStrongLocal
    ? "global_untrusted_until_local_binding_is_strong"
    : resolvedChairId === binding.local_chair_id
      ? "primary_local"
      : resolvedChairId == null
        ? "secondary_global_unbound"
        : "secondary_global_nonlocal";
  return {
    source_signal_type: signal.type,
    action: payload.action || signal.type,
    actor_ref: payload.actor_ref ?? null,
    action_chair_id_candidate: payload.action_chair_id_candidate ?? null,
    resolved_action_chair_id: resolvedChairId,
    local_scope: localScope,
    entity_id: payload.entity_id ?? null,
    raw_hero_id: payload.raw_hero_id ?? null,
    hero: payload.hero || null,
    from: payload.from || null,
    to: payload.to || null,
    position: payload.position || null,
    confidence: signal.confidence || 0,
    evidence: signal.evidence || null,
  };
}

function isChampion(action, championId) {
  if (!championId) return false;
  return String(action.hero?.champion_id ?? "") === String(championId);
}

function buildDiff(beforeReport, afterReport, championId) {
  const beforeWindow = latestMatchWindow(beforeReport.signals || []);
  const afterWindow = latestMatchWindow(afterReport.signals || []);
  const sameMatch = beforeWindow.game_start_time === afterWindow.game_start_time;
  const beforeActions = sameMatch ? actionSignals(beforeWindow.signals) : [];
  const afterActions = actionSignals(afterWindow.signals);
  const addedSignals = subtractMultiset(afterActions, beforeActions);
  const localBinding = bindLocalChair(afterWindow.signals);
  const actorToChair = actorChairMap(afterWindow.signals);
  const addedActions = addedSignals.map((signal) => compactAction(signal, actorToChair, localBinding));
  const localAddedActions = localBinding.binding_status === "strongly_bound"
    ? addedActions.filter((action) => action.local_scope === "primary_local")
    : [];
  const secondaryGlobalActions = localBinding.binding_status === "strongly_bound"
    ? addedActions.filter((action) => action.local_scope !== "primary_local")
    : addedActions;
  const championSells = addedActions.filter((action) => (
    action.source_signal_type === "sell_chess_candidate" && isChampion(action, championId)
  ));
  const localChampionSells = localAddedActions.filter((action) => (
    action.source_signal_type === "sell_chess_candidate" && isChampion(action, championId)
  ));
  const typeCounts = {};
  for (const action of addedActions) {
    typeCounts[action.source_signal_type] = (typeCounts[action.source_signal_type] || 0) + 1;
  }
  const localTypeCounts = {};
  for (const action of localAddedActions) {
    localTypeCounts[action.source_signal_type] = (localTypeCounts[action.source_signal_type] || 0) + 1;
  }
  return {
    ok: true,
    current_match_only: true,
    match: {
      game_start_time: afterWindow.game_start_time,
      after_window_start_index: afterWindow.start_index,
      before_window_start_index: sameMatch ? beforeWindow.start_index : null,
      before_same_match: sameMatch,
    },
    before_action_count: beforeActions.length,
    after_action_count: afterActions.length,
    local_binding: localBinding,
    added_total: addedActions.length,
    action_delta: addedActions.length,
    sell_delta: typeCounts.sell_chess_candidate || 0,
    get_on_delta: typeCounts.get_on_chess_candidate || 0,
    move_delta: typeCounts.move_battle_chess_candidate || 0,
    primary_local_added_total: localAddedActions.length,
    primary_local_action_delta: localAddedActions.length,
    primary_local_sell_delta: localTypeCounts.sell_chess_candidate || 0,
    primary_local_get_on_delta: localTypeCounts.get_on_chess_candidate || 0,
    primary_local_move_delta: localTypeCounts.move_battle_chess_candidate || 0,
    secondary_global_added_total: secondaryGlobalActions.length,
    action_scope_decision: {
      primary_status: localBinding.binding_status === "strongly_bound" ? "available" : "blocked",
      primary_reason: localBinding.binding_status === "strongly_bound"
        ? "local_chair_id_strongly_bound"
        : localBinding.blocker,
      secondary_status: secondaryGlobalActions.length > 0 ? "available_for_debug_only" : "empty",
      secondary_reason: "global action stream includes other players and must not be treated as local state",
    },
    champion_id: championId || null,
    champion_sell_delta: championSells.length,
    primary_local_champion_sell_delta: localChampionSells.length,
    champion_sells: championSells,
    primary_local_champion_sells: localChampionSells,
    primary_local_added_actions: localAddedActions,
    secondary_global_added_actions: secondaryGlobalActions,
    added_actions: addedActions,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.before || !options.after) throw new Error(`Missing --before/--after\n${usage()}`);
  const before = await readJson(options.before);
  const after = await readJson(options.after);
  const diff = buildDiff(before, after, options.championId);
  const text = `${JSON.stringify(diff, null, 2)}\n`;
  if (options.out) await writeFile(options.out, text, "utf8");
  else process.stdout.write(text);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
