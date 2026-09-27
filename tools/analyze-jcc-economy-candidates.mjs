import { readFile, writeFile } from "node:fs/promises";

function usage() {
  return [
    "Usage:",
    "  node tools/analyze-jcc-economy-candidates.mjs --signals <candidate-runtime-signals.json> [--out <report.json>]",
    "",
    "Audits economy-related runtime candidates without promoting unbound signals into live_state economy fields.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--signals") options.signals = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function latestLocalChair(signals) {
  return signals
    .filter((signal) => signal.type === "local_report_chair_candidate")
    .filter((signal) => Number.isInteger(signal.payload?.chair_id))
    .at(-1)?.payload?.chair_id ?? null;
}

function moneyEvents(signals) {
  return signals
    .filter((signal) => signal.type === "battle_result_money")
    .map((signal) => ({
      earned_money: signal.payload?.earned_money ?? null,
      binding_status: "anonymous_player_ref_not_local_chair",
      confidence: signal.confidence || 0,
      evidence: signal.evidence || null,
    }));
}

function levelCandidates(signals) {
  return signals
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
}

function summarizeNumber(values) {
  const numeric = values.filter((value) => Number.isFinite(value));
  if (numeric.length === 0) return { min: null, max: null, unique: [] };
  return {
    min: Math.min(...numeric),
    max: Math.max(...numeric),
    unique: [...new Set(numeric)].sort((left, right) => left - right),
  };
}

function analyze(signalReport) {
  const signals = signalReport.signals || [];
  const money = moneyEvents(signals);
  const levels = levelCandidates(signals);
  const blockers = [];
  if (money.length > 0) blockers.push("money_event_player_ref_not_bound_to_local_chair");
  if (levels.length > 0) blockers.push("round_flow_level_chair_semantics_unverified");
  blockers.push("no_xp_or_xp_to_next_candidate_signal_observed");

  return {
    ok: true,
    analyzer: "jcc_economy_candidate_audit",
    local_chair_id: latestLocalChair(signals),
    candidates: {
      money_events: {
        count: money.length,
        earned_money_summary: summarizeNumber(money.map((event) => event.earned_money)),
        examples: money.slice(-5),
      },
      level_candidates: {
        count: levels.length,
        level_summary: summarizeNumber(levels.map((candidate) => candidate.level_candidate)),
        examples: levels.slice(-5),
      },
      xp_candidates: {
        count: 0,
        examples: [],
      },
      xp_to_next_candidates: {
        count: 0,
        examples: [],
      },
    },
    promotion_decision: {
      economy_gold: {
        status: money.length > 0 ? "not_promoted" : "missing",
        reason: money.length > 0 ? "money_event_player_ref_not_bound_to_local_chair" : "no_gold_candidate_signal_observed",
      },
      economy_level: {
        status: levels.length > 0 ? "not_promoted" : "missing",
        reason: levels.length > 0 ? "round_flow_level_chair_semantics_unverified" : "no_level_candidate_signal_observed",
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
    blockers,
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
  const report = analyze(signalReport);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) await writeFile(options.out, text, "utf8");
  else process.stdout.write(text);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
