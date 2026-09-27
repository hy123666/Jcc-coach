import { readFile, writeFile } from "node:fs/promises";

const CAPTURE_CONTRACT = "data/runtime/jcc/android-runtime-capture-contract.json";

const TERM_FIELD_HINTS = {
  board: ["board.board_units", "board.board_size", "board.max_units"],
  bench: ["bench.bench_units", "bench.bench_full"],
  shop: ["shop.shop_units", "shop.refresh_count", "shop.lock_state"],
  store: ["shop.shop_units"],
  equip: ["items.equipped_items", "actions.can_equip"],
  item: ["items.item_bench", "items.components", "items.completed", "items.special_items"],
  hero: ["board.board_units", "bench.bench_units", "shop.shop_units"],
  piece: ["board.board_units", "bench.bench_units"],
  gold: ["economy.gold", "economy.interest"],
  money: ["economy.gold", "combat.earned_money"],
  round: ["phase.round", "phase.stage", "phase.turn_count"],
  level: ["economy.level"],
  exp: ["economy.xp", "economy.xp_to_next"],
  hp: ["economy.hp", "opponents.snapshots"],
  health: ["economy.hp", "opponents.snapshots"],
  lineup: ["traits.active_traits", "board.board_units"],
  formation: ["board.board_units", "traits.active_traits"],
  Battle: ["combat.active", "combat.result", "combat.opponent_chair_id"],
  ChessBattle: ["combat.active", "phase.phase"],
  InGame: ["match.status", "phase.phase"],
};

function usage() {
  return [
    "Usage:",
    "  node tools/diff-jcc-targeted-capture.mjs --before <probe-report.json> --after <probe-report.json> [--out <diff.json>]",
    "",
    "Diffs two targeted Android probe reports and emits candidate signal hints only; it never promotes live_state fields.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--before") options.before = argv[++index];
    else if (arg === "--after") options.after = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function scopeOf(report) {
  return report.capture_scope || report.capture_scope_metadata?.scenario_id || "unknown";
}

function targetFieldsOf(report) {
  return [
    ...(report.capture_scope_metadata?.target_fields || []),
    ...(report.target_fields || []),
  ].filter(Boolean);
}

function scenarioFromContract(contract, scope) {
  return contract.scenarios?.find((scenario) => scenario.id === scope) || null;
}

function logSummaries(report) {
  return report.evidence?.log_summaries || [];
}

function sumCounts(report) {
  const counts = new Map();
  for (const summary of logSummaries(report)) {
    for (const [term, value] of Object.entries(summary.counts || {})) {
      if (!Number.isFinite(value)) continue;
      counts.set(term, (counts.get(term) || 0) + value);
    }
  }
  return counts;
}

function evidenceSnippets(report, term) {
  const snippets = [];
  for (const summary of logSummaries(report)) {
    const entries = summary.evidence?.[term] || [];
    for (const entry of entries) {
      const text = String(entry).replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 220);
      if (text && !snippets.includes(text)) snippets.push(text);
    }
  }
  return snippets.slice(0, 5);
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return left.filter((entry) => rightSet.has(entry));
}

function buildDiff(before, after, contract) {
  const beforeScope = scopeOf(before);
  const afterScope = scopeOf(after);
  if (beforeScope !== afterScope) throw new Error(`scope mismatch: before=${beforeScope} after=${afterScope}`);

  const scenario = scenarioFromContract(contract, afterScope);
  const targetFields = [...new Set([
    ...targetFieldsOf(before),
    ...targetFieldsOf(after),
    ...(scenario?.target_fields || []),
  ])];
  const beforeCounts = sumCounts(before);
  const afterCounts = sumCounts(after);
  const terms = [...new Set([...beforeCounts.keys(), ...afterCounts.keys()])].sort();
  const changedTerms = terms
    .map((term) => {
      const beforeCount = beforeCounts.get(term) || 0;
      const afterCount = afterCounts.get(term) || 0;
      const delta = afterCount - beforeCount;
      if (delta === 0) return null;
      return {
        term,
        before_count: beforeCount,
        after_count: afterCount,
        delta,
        evidence_after: evidenceSnippets(after, term),
      };
    })
    .filter(Boolean);

  return {
    ok: true,
    report_kind: "jcc_android_targeted_capture_diff",
    contract_ref: CAPTURE_CONTRACT,
    scope: afterScope,
    scenario_goal: scenario?.goal || after.capture_scope_metadata?.scenario_goal || null,
    target_fields: targetFields,
    diff_policy: contract.diff_policy || null,
    promotion_policy: "do_not_promote_without_focused_verifier",
    redaction_policy: "snippets_are_redacted_and_truncated; no private account data may be used",
    changed_terms: changedTerms,
    candidate_signal_hints: changedTerms.map((change) => ({
      term: change.term,
      delta: change.delta,
      target_fields: intersection(TERM_FIELD_HINTS[change.term] || [], targetFields),
      evidence_after: change.evidence_after,
      promotion_status: "candidate_only",
      blocker: "term_count_delta_does_not_prove_live_state_semantics",
      next_experiment: "Add focused extractor and verifier only after repeated scoped captures prove field semantics.",
    })),
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
  const contract = await readJson(CAPTURE_CONTRACT);
  const diff = buildDiff(before, after, contract);
  const text = `${JSON.stringify(diff, null, 2)}\n`;
  if (options.out) await writeFile(options.out, text, "utf8");
  else process.stdout.write(text);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
