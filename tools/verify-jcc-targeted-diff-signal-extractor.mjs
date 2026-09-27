import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: new URL("..", import.meta.url),
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-diff-signals-"));
  try {
    const diffFile = path.join(tempDir, "targeted-capture-diff.json");
    const outFile = path.join(tempDir, "candidate-runtime-signals.json");
    await writeFile(diffFile, JSON.stringify({
      ok: true,
      report_kind: "jcc_android_targeted_capture_diff",
      contract_ref: "data/runtime/jcc/android-runtime-capture-contract.json",
      scope: "planning_shop",
      target_fields: ["board.board_units", "bench.bench_units", "economy.gold"],
      promotion_policy: "do_not_promote_without_focused_verifier",
      changed_terms: [
        { term: "board", before_count: 1, after_count: 4, delta: 3, evidence_after: ["board changed snippet"] },
        { term: "gold", before_count: 0, after_count: 2, delta: 2, evidence_after: ["gold changed snippet"] },
      ],
      candidate_signal_hints: [
        {
          term: "board",
          delta: 3,
          target_fields: ["board.board_units"],
          evidence_after: ["board changed snippet"],
          promotion_status: "candidate_only",
          blocker: "term_count_delta_does_not_prove_live_state_semantics",
        },
        {
          term: "gold",
          delta: 2,
          target_fields: ["economy.gold"],
          evidence_after: ["gold changed snippet"],
          promotion_status: "candidate_only",
          blocker: "term_count_delta_does_not_prove_live_state_semantics",
        },
      ],
    }, null, 2), "utf8");

    const result = await runNode([
      "tools/extract-jcc-targeted-diff-signals.mjs",
      "--input",
      diffFile,
      "--out",
      outFile,
    ]);
    assert(result.code === 0, `extractor exited ${result.code}\n${result.stderr}`);
    const report = JSON.parse(await readFile(outFile, "utf8"));

    assert(report.ok === true, "signal report must be ok");
    assert(report.signal_kind === "targeted_capture_candidate_signals", "signal kind mismatch");
    assert(report.live_state_status === "not_promoted_until_focused_verifier", "targeted diff signals must not promote live_state");
    assert(report.input_ref === "targeted-capture-diff.json", "input_ref must be portable basename");
    assert(report.signal_counts?.targeted_capture_delta_candidate === 2, "must emit one signal per candidate hint");
    assert(report.signals.every((signal) => signal.type === "targeted_capture_delta_candidate"), "all signals must use targeted candidate type");
    assert(report.signals.every((signal) => signal.payload?.promotion_status === "candidate_only"), "all signals must be candidate_only");
    assert(report.signals.some((signal) => signal.payload.term === "board" && signal.payload.target_fields.includes("board.board_units")), "board signal must target board.board_units");
    assert(report.signals.some((signal) => signal.payload.term === "gold" && signal.payload.target_fields.includes("economy.gold")), "gold signal must target economy.gold");
    assert(!JSON.stringify(report).includes(tempDir), "report must not persist absolute temp paths");
    assert(report.signals.every((signal) => signal.evidence), "signals must include evidence snippets");

    const badDiff = path.join(tempDir, "bad.json");
    await writeFile(badDiff, JSON.stringify({
      ok: true,
      report_kind: "jcc_android_targeted_capture_diff",
      scope: "planning_shop",
      promotion_policy: "auto_promote",
      candidate_signal_hints: [{ term: "board", target_fields: ["board.board_units"] }],
    }), "utf8");
    const bad = await runNode([
      "tools/extract-jcc-targeted-diff-signals.mjs",
      "--input",
      badDiff,
    ]);
    assert(bad.code !== 0, "unsafe promotion policy must fail");
    assert((bad.stderr + bad.stdout).includes("do_not_promote_without_focused_verifier"), "unsafe policy error must name required policy");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "targeted diff candidate hints become candidate signals",
        "signals remain candidate_only and do not promote live_state",
        "field targets and evidence snippets are preserved",
        "unsafe promotion policy is rejected",
      ],
    }, null, 2));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
