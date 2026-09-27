import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REQUIRED_PROMOTION_POLICY = "do_not_promote_without_focused_verifier";

function usage() {
  return [
    "Usage:",
    "  node tools/extract-jcc-targeted-diff-signals.mjs --input <targeted-capture-diff.json> [--out <candidate-runtime-signals.json>]",
    "",
    "Converts targeted capture diff hints into candidate-only runtime signals.",
    "It does not promote or mutate live_state fields.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--input") options.input = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function signalFromHint(hint, index, diff) {
  const snippets = (hint.evidence_after || []).map((entry) => String(entry).slice(0, 220));
  return {
    type: "targeted_capture_delta_candidate",
    source_file: path.basename(diff.input_ref || "targeted-capture-diff.json"),
    confidence: 0.35,
    payload: {
      scope: diff.scope,
      term: hint.term,
      delta: hint.delta ?? null,
      target_fields: hint.target_fields || [],
      promotion_status: "candidate_only",
      blocker: hint.blocker || "targeted_capture_diff_does_not_prove_live_state_semantics",
      next_experiment: hint.next_experiment || "Write a focused extractor/verifier after repeated targeted captures prove semantics.",
      candidate_index: index,
    },
    evidence: snippets.join(" | ") || `targeted diff term=${hint.term}`,
  };
}

function buildReport(diff, inputPath) {
  if (diff.report_kind !== "jcc_android_targeted_capture_diff") {
    throw new Error("input must be jcc_android_targeted_capture_diff");
  }
  if (diff.promotion_policy !== REQUIRED_PROMOTION_POLICY) {
    throw new Error(`targeted diff promotion_policy must be ${REQUIRED_PROMOTION_POLICY}`);
  }
  const signals = (diff.candidate_signal_hints || []).map((hint, index) => signalFromHint(hint, index, {
    ...diff,
    input_ref: path.basename(inputPath),
  }));
  return {
    ok: true,
    input_ref: path.basename(inputPath),
    signal_kind: "targeted_capture_candidate_signals",
    live_state_status: "not_promoted_until_focused_verifier",
    source_report_kind: diff.report_kind,
    scope: diff.scope,
    signal_count: signals.length,
    signal_counts: {
      targeted_capture_delta_candidate: signals.length,
    },
    signals,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.input) throw new Error(`Missing --input\n${usage()}`);
  const diff = await readJson(options.input);
  const report = buildReport(diff, options.input);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) await writeFile(options.out, text, "utf8");
  else process.stdout.write(text);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
