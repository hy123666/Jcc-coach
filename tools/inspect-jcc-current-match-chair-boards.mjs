#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error("Usage: node tools/inspect-jcc-current-match-chair-boards.mjs --signals <candidate-runtime-signals.json> [--out <json>]");
  process.exit(2);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--signals") options.signals = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else usage();
  }
  if (!options.signals) usage();
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function latestGameStartIndex(signals) {
  for (let index = signals.length - 1; index >= 0; index -= 1) {
    if (signals[index].type === "match_start") return index;
  }
  return -1;
}

function isAction(signal) {
  return ["get_on_chess_candidate", "move_battle_chess_candidate", "sell_chess_candidate"].includes(signal.type);
}

function isChairId(value) {
  return Number.isInteger(value) && value >= 0 && value <= 7;
}

function actorChairMap(signals) {
  const map = new Map();
  for (const signal of signals) {
    if (signal.type !== "switch_player_chair") continue;
    const actor = signal.payload?.actor_ref;
    const chair = signal.payload?.chair_id;
    if (actor && isChairId(chair)) map.set(actor, chair);
  }
  return map;
}

function inferredChairFromEntity(entityId) {
  if (!Number.isInteger(entityId)) return null;
  if (entityId >= 0 && entityId < 100000) return null;
  const chair = Math.floor(entityId / 100000);
  return isChairId(chair) ? chair : null;
}

function posKey(position) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  return `${position.x}|${position.y}`;
}

function area(position) {
  if (!position || !Number.isFinite(position.y)) return "unknown";
  return position.y < 0 ? "bench" : "board";
}

function unit(signal, position) {
  const payload = signal.payload || {};
  return {
    entity_id: payload.entity_id ?? null,
    raw_hero_id: payload.raw_hero_id ?? null,
    champion_id: payload.hero?.champion_id ?? null,
    name: payload.hero?.name ?? null,
    star: payload.hero?.star_tier ?? payload.star_or_state ?? null,
    position,
    area: area(position),
  };
}

function emptyChairState(chair) {
  return {
    chair_id: chair,
    actor_refs: {},
    board: new Map(),
    bench: new Map(),
    action_count: 0,
    unresolved_small_entity_action_count: 0,
    latest_actions: [],
  };
}

function applyAction(state, signal) {
  const payload = signal.payload || {};
  const action = payload.action;
  const from = payload.from || null;
  const to = payload.to || null;
  const position = payload.position || to || null;
  const fromKey = posKey(from);
  const toKey = posKey(position);
  const targetMap = area(position) === "bench" ? state.bench : state.board;
  const fromMap = area(from) === "bench" ? state.bench : state.board;
  state.action_count += 1;
  if (payload.actor_ref) state.actor_refs[payload.actor_ref] = (state.actor_refs[payload.actor_ref] || 0) + 1;
  state.latest_actions.push({
    action,
    actor_ref: payload.actor_ref ?? null,
    entity_id: payload.entity_id ?? null,
    name: payload.hero?.name ?? null,
    from,
    to,
    position: payload.position || null,
  });
  state.latest_actions = state.latest_actions.slice(-8);

  if (action === "sell_chess") {
    if (toKey) {
      state.board.delete(toKey);
      state.bench.delete(toKey);
    }
    return;
  }
  if (action === "move_battle_chess" && fromKey) {
    state.board.delete(fromKey);
    state.bench.delete(fromKey);
  }
  if (toKey) targetMap.set(toKey, unit(signal, position));
}

function serializeState(state) {
  const board = [...state.board.values()].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
  const bench = [...state.bench.values()].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
  return {
    chair_id: state.chair_id,
    action_count: state.action_count,
    board_count: board.length,
    bench_count: bench.length,
    actor_refs: Object.entries(state.actor_refs)
      .map(([actor_ref, count]) => ({ actor_ref, count }))
      .sort((left, right) => right.count - left.count),
    board_units: board,
    bench_units: bench,
    latest_actions: state.latest_actions,
  };
}

function main() {
  const options = parseArgs(process.argv);
  const input = readJson(options.signals);
  const allSignals = input.signals || [];
  const startIndex = latestGameStartIndex(allSignals);
  const signals = startIndex >= 0 ? allSignals.slice(startIndex) : allSignals;
  const actorToChair = actorChairMap(signals);
  const byChair = new Map();
  const smallEntityActors = new Map();

  for (const signal of signals) {
    if (!isAction(signal)) continue;
    const payload = signal.payload || {};
    const actorChair = payload.actor_ref ? actorToChair.get(payload.actor_ref) : null;
    const entityChair = inferredChairFromEntity(payload.entity_id);
    const candidateChair = isChairId(payload.action_chair_id_candidate)
      ? payload.action_chair_id_candidate
      : (isChairId(entityChair) ? entityChair : (isChairId(actorChair) ? actorChair : null));
    if (candidateChair == null) {
      if (payload.actor_ref) smallEntityActors.set(payload.actor_ref, (smallEntityActors.get(payload.actor_ref) || 0) + 1);
      continue;
    }
    const state = byChair.get(candidateChair) || emptyChairState(candidateChair);
    if (entityChair == null && payload.entity_id != null && payload.entity_id < 100000) state.unresolved_small_entity_action_count += 1;
    applyAction(state, signal);
    byChair.set(candidateChair, state);
  }

  const chairs = [...byChair.values()].map(serializeState).sort((left, right) => left.chair_id - right.chair_id);
  const result = {
    schema: "jcc-current-match-chair-board-inspection-v1",
    source: path.resolve(options.signals),
    game_start_index: startIndex,
    chair_count: chairs.length,
    chairs,
    small_entity_actor_candidates: [...smallEntityActors.entries()]
      .map(([actor_ref, count]) => ({ actor_ref, count, mapped_chair_id: actorToChair.get(actor_ref) ?? null }))
      .sort((left, right) => right.count - left.count),
    interpretation: "Diagnostic only. Compare the chair snapshots against the user's visible board before promoting a local player binding.",
  };

  const text = JSON.stringify(result, null, 2);
  if (options.out) fs.writeFileSync(options.out, `${text}\n`);
  else console.log(text);
}

main();
