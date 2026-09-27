import { readFile, writeFile } from "node:fs/promises";

function usage() {
  return [
    "Usage:",
    "  node tools/analyze-jcc-round-flow-binding.mjs --signals <candidate-runtime-signals.json> [--out <report.json>]",
    "",
    "Analyzes whether anonymous round_flow snapshots can be safely promoted to local player state.",
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
  const report = signals
    .filter((signal) => signal.type === "local_report_chair_candidate")
    .filter((signal) => Number.isInteger(signal.payload?.chair_id))
    .at(-1);
  return report?.payload?.chair_id ?? null;
}

function latestLocalHp(signals, chairId) {
  if (chairId == null) return null;
  return signals
    .filter((signal) => signal.type === "player_life")
    .filter((signal) => signal.payload?.chair_id === chairId)
    .map((signal) => signal.payload.life)
    .at(-1) ?? null;
}

function roundFlowSnapshots(signals) {
  return signals
    .filter((signal) => signal.type === "round_flow")
    .map((signal) => signal.payload?.decoded?.snapshot_candidate)
    .filter(Boolean);
}

function scoreCandidate(snapshot, localChairId, localHp) {
  const matchedSignals = [];
  const conflicts = [];
  if (localHp != null && snapshot.hp != null) {
    if (snapshot.hp === localHp) matchedSignals.push("hp");
    else conflicts.push("hp_mismatch");
  }
  if (localChairId != null && Array.isArray(snapshot.chair_candidates)) {
    if (snapshot.chair_candidates.includes(localChairId)) matchedSignals.push("chair_candidate");
    else conflicts.push("chair_candidate_missing_local");
  }
  return {
    binding_status: "candidate_not_promoted",
    score: matchedSignals.length - conflicts.length,
    matched_signals: matchedSignals,
    conflicts,
    snapshot,
  };
}

function promotionDecision(candidates) {
  const blockers = new Set();
  for (const candidate of candidates) {
    if (candidate.matched_signals.includes("chair_candidate") && candidate.conflicts.includes("hp_mismatch")) {
      blockers.add("hp_conflicts_with_local_chair_candidate");
    }
    if (candidate.matched_signals.includes("hp") && candidate.conflicts.includes("chair_candidate_missing_local")) {
      blockers.add("hp_match_missing_local_chair_candidate");
    }
  }
  return {
    status: "not_promoted",
    reason: "round_flow_chair_semantics_unverified",
    blockers: [...blockers].sort(),
  };
}

function analyze(signalReport) {
  const signals = signalReport.signals || [];
  const localChairId = latestLocalChair(signals);
  const localHp = latestLocalHp(signals, localChairId);
  const snapshots = roundFlowSnapshots(signals);
  const candidates = snapshots
    .map((snapshot) => scoreCandidate(snapshot, localChairId, localHp))
    .sort((left, right) => right.score - left.score);
  return {
    ok: true,
    analyzer: "jcc_round_flow_binding",
    local_chair_id: localChairId,
    local_hp: localHp,
    round_flow: {
      snapshot_count: snapshots.length,
      field_hypotheses: {
        primary_chair_candidate_index: {
          field: "chair_candidates[0]",
          confidence: "hypothesis_only",
          status: "unverified",
        },
        secondary_chair_candidate_index: {
          field: "chair_candidates[1]",
          confidence: "hypothesis_only",
          status: "unverified",
        },
      },
      promotion_decision: promotionDecision(candidates),
      candidates,
    },
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
