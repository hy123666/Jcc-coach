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

function probeReport(scope, counts, evidence = {}) {
  return {
    ok: true,
    package_id: "com.tencent.jkchess",
    device: "127.0.0.1:7555",
    capture_scope: scope,
    capture_scope_metadata: {
      scope_kind: "targeted",
      scenario_id: scope,
      target_fields: ["board.board_units", "bench.bench_units", "economy.gold"],
    },
    verdict: {
      adb_transport: "online",
      foreground_game: "yes",
      private_app_data_without_root: "not_readable",
      public_external_logs: "readable",
    },
    evidence: {
      log_summaries: [
        {
          file: "net/sample",
          bytes: 1000,
          counts,
          evidence,
        },
      ],
    },
  };
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-capture-diff-"));
  try {
    const before = path.join(tempDir, "before.json");
    const after = path.join(tempDir, "after.json");
    const out = path.join(tempDir, "diff.json");
    await writeFile(before, JSON.stringify(probeReport("planning_shop", {
      board: 1,
      bench: 1,
      gold: 0,
      hero: 2,
    }, {
      board: ["before board snippet"],
    }), null, 2), "utf8");
    await writeFile(after, JSON.stringify(probeReport("planning_shop", {
      board: 4,
      bench: 3,
      gold: 2,
      hero: 7,
    }, {
      board: ["after board snippet"],
      gold: ["after gold snippet"],
    }), null, 2), "utf8");

    const result = await runNode([
      "tools/diff-jcc-targeted-capture.mjs",
      "--before",
      before,
      "--after",
      after,
      "--out",
      out,
    ]);
    assert(result.code === 0, `diff tool exited ${result.code}\n${result.stderr}`);
    const diff = JSON.parse(await readFile(out, "utf8"));

    assert(diff.ok === true, "diff report must be ok");
    assert(diff.report_kind === "jcc_android_targeted_capture_diff", "diff report kind mismatch");
    assert(diff.scope === "planning_shop", "diff must preserve targeted scope");
    assert(diff.contract_ref === "data/runtime/jcc/android-runtime-capture-contract.json", "diff must cite capture contract");
    assert(diff.diff_policy?.changed_fields_emit_candidate_signal === true, "diff must carry candidate signal policy");
    assert(diff.promotion_policy === "do_not_promote_without_focused_verifier", "diff must not auto-promote live_state");
    assert(diff.target_fields.includes("board.board_units") && diff.target_fields.includes("economy.gold"), "diff must carry target fields");
    assert(diff.changed_terms.some((term) => term.term === "board" && term.delta === 3), "diff must include board delta");
    assert(diff.changed_terms.some((term) => term.term === "gold" && term.delta === 2), "diff must include gold delta");
    assert(diff.candidate_signal_hints.some((hint) => hint.term === "board" && hint.target_fields.includes("board.board_units")), "board hint must map to target field");
    assert(diff.candidate_signal_hints.some((hint) => hint.term === "gold" && hint.target_fields.includes("economy.gold")), "gold hint must map to target field");
    assert(diff.redaction_policy === "snippets_are_redacted_and_truncated; no private account data may be used", "diff must carry redaction policy");

    const mismatch = path.join(tempDir, "mismatch.json");
    await writeFile(mismatch, JSON.stringify(probeReport("combat", { board: 5 }), null, 2), "utf8");
    const mismatchResult = await runNode([
      "tools/diff-jcc-targeted-capture.mjs",
      "--before",
      before,
      "--after",
      mismatch,
    ]);
    assert(mismatchResult.code !== 0, "scope mismatch must fail");
    assert((mismatchResult.stderr + mismatchResult.stdout).includes("scope mismatch"), "scope mismatch error must be explicit");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "targeted capture diff reports changed terms",
        "diff maps changed terms to target field hints",
        "diff carries no-auto-promotion policy",
        "scope mismatch is rejected",
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
