#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

function usage() {
  return [
    "Usage:",
    "  node tools/calibrate-jcc-local-chair-from-action-label.mjs --signals <signals.json> --action <sell_chess|get_on_chess|move_battle_chess> [--hero-name <name>] [--champion-id <id>] [--raw-hero-id <id>] [--position <x|y>] [--out <binding.json>]",
    "",
    "Creates a match-scoped manual local chair binding from one labeled user action.",
    "The binding is valid only for the latest GameStart window in the input signals.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--signals") options.signals = argv[++index];
    else if (arg === "--action") options.action = argv[++index];
    else if (arg === "--hero-name") options.heroName = argv[++index];
    else if (arg === "--champion-id") options.championId = String(argv[++index]);
    else if (arg === "--raw-hero-id") options.rawHeroId = Number(argv[++index]);
    else if (arg === "--position") options.position = parsePosition(argv[++index]);
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function parsePosition(value) {
  const match = /^(-?\d+)\|(-?\d+)$/.exec(String(value || ""));
  if (!match) throw new Error(`Invalid --position "${value}", expected x|y`);
  return { x: Number(match[1]), y: Number(match[2]) };
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
  const start = startIndex >= 0 ? startIndex : 0;
  return {
    start_index: start,
    game_start_time: signals[startIndex]?.payload?.game_start_time || null,
    signals: signals.slice(start),
  };
}

function isPlayerChairId(value) {
  return Number.isInteger(value) && value >= 0 && value <= 7;
}

function actionSignalType(action) {
  if (action === "sell_chess") return "sell_chess_candidate";
  if (action === "get_on_chess") return "get_on_chess_candidate";
  if (action === "move_battle_chess") return "move_battle_chess_candidate";
  throw new Error(`Unsupported --action "${action}"`);
}

function samePosition(left, right) {
  if (!right) return true;
  const pos = left?.position || left?.to || null;
  return Number.isFinite(pos?.x) && Number.isFinite(pos?.y) && pos.x === right.x && pos.y === right.y;
}

function matchesHero(payload, options) {
  if (options.rawHeroId != null && payload.raw_hero_id !== options.rawHeroId) return false;
  if (options.championId && String(payload.hero?.champion_id ?? "") !== options.championId) return false;
  if (options.heroName) {
    const actual = String(payload.hero?.name ?? "");
    if (actual !== options.heroName) return false;
  }
  return options.rawHeroId != null || options.championId || options.heroName;
}

function compactCandidate(signal, signalIndex) {
  const payload = signal.payload || {};
  return {
    signal_index: signalIndex,
    source_signal_type: signal.type,
    action: payload.action || signal.type,
    chair_id: payload.action_chair_id_candidate ?? null,
    actor_ref: payload.actor_ref ?? null,
    entity_id: payload.entity_id ?? null,
    raw_hero_id: payload.raw_hero_id ?? null,
    champion_id: payload.hero?.champion_id ?? null,
    name: payload.hero?.name ?? null,
    position: payload.position || payload.to || null,
    from: payload.from || null,
    to: payload.to || null,
    evidence: signal.evidence || null,
  };
}

function calibrate(signalReport, options) {
  const signals = signalReport.signals || [];
  const window = latestMatchWindow(signals);
  const type = actionSignalType(options.action);
  const candidates = [];

  for (let index = 0; index < window.signals.length; index += 1) {
    const signal = window.signals[index];
    if (signal.type !== type) continue;
    const payload = signal.payload || {};
    if (!matchesHero(payload, options)) continue;
    if (!samePosition(payload, options.position)) continue;
    const chairId = payload.action_chair_id_candidate;
    if (!isPlayerChairId(chairId)) continue;
    candidates.push(compactCandidate(signal, window.start_index + index));
  }

  if (candidates.length !== 1) {
    return {
      ok: false,
      schema: "jcc-manual-local-chair-binding-v1",
      game_start_time: window.game_start_time,
      binding_status: candidates.length === 0 ? "not_found" : "ambiguous",
      reason: candidates.length === 0
        ? "no_current_match_action_matched_label"
        : "multiple_current_match_actions_matched_label",
      match: {
        game_start_time: window.game_start_time,
        start_index: window.start_index,
      },
      label: labelSummary(options),
      matched_candidates: candidates,
    };
  }

  const candidate = candidates[0];
  return {
    ok: true,
    schema: "jcc-manual-local-chair-binding-v1",
    game_start_time: window.game_start_time,
    binding: {
      local_chair_id: candidate.chair_id,
      binding_status: "strongly_bound",
      binding_source: "manual_action_label_current_match",
      binding_signal_index: candidate.signal_index,
      actor_ref: candidate.actor_ref,
      confidence: 0.93,
      evidence: candidate.evidence,
      binding_candidates: [{
        chair_id: candidate.chair_id,
        count: 1,
        actor_ref: candidate.actor_ref,
        matched_action: candidate.action,
        entity_id: candidate.entity_id,
        raw_hero_id: candidate.raw_hero_id,
        champion_id: candidate.champion_id,
        name: candidate.name,
        position: candidate.position,
      }],
      caveat: "valid only for this GameStart; do not reuse after a new match starts",
    },
    match: {
      game_start_time: window.game_start_time,
      start_index: window.start_index,
    },
    label: labelSummary(options),
    matched_candidates: candidates,
  };
}

function labelSummary(options) {
  return {
    action: options.action,
    hero_name: options.heroName || null,
    champion_id: options.championId || null,
    raw_hero_id: options.rawHeroId ?? null,
    position: options.position || null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.signals || !options.action) throw new Error(`Missing --signals/--action\n${usage()}`);
  if (!options.heroName && !options.championId && options.rawHeroId == null) {
    throw new Error(`Missing hero selector: use --hero-name, --champion-id, or --raw-hero-id\n${usage()}`);
  }
  const signalReport = await readJson(options.signals);
  const result = calibrate(signalReport, options);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) await writeFile(options.out, text, "utf8");
  else process.stdout.write(text);
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
