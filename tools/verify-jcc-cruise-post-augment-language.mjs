import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-post-augment-language-"));
  try {
    const liveStateFile = path.join(tempDir, "live-state.json");
    const outFile = path.join(tempDir, "score.json");
    await writeFile(liveStateFile, `${JSON.stringify({
      schema: "jcc-test-live-state-v1",
      match_session_id: "verify-post-augment",
      phase: { stage_round: "2-5" },
      economy: { gold: null, hp: null, level: 4, xp: { value: 0, to_next: 10 } },
      own_board: { units: [{ name: "贝蕾亚" }] },
      own_bench: { units: [{ name: "贝蕾亚" }] },
      shop: { units: [{ name: "维迦" }] },
      items: { item_bench: ["暴风大剑", "反曲之弓"] },
      augments: { selected_augments: [] },
    }, null, 2)}\n`, "utf8");
    const result = await runNode([
      "tools/score-jcc-cruise-strategy.mjs",
      "--live-state", liveStateFile,
      "--out", outFile,
      "--include-suppressed",
    ]);
    assert(result.code === 0, `score failed\n${result.stderr || result.stdout}`);
    const score = JSON.parse(await readFile(outFile, "utf8"));
    const early = [...(score.advice_tasks || []), ...(score.suppressed_tasks || [])]
      .find((task) => task.trigger_id === "early_direction_conversation");
    assert(early, "expected early direction task for early stage board context");
    assert(!String(early.short_advice || "").includes("等2-1"), "post-augment early advice must not keep saying wait for 2-1");
    assert(!String(early.short_advice || "").includes("2-1强化"), "post-augment advice should avoid stale first-augment wording");
    assert(String(early.short_advice || "").includes("首个强化最终选择未记录"), "post-augment advice should ask for missing final augment choice instead");
    assert((early.semantic_labels || []).includes("post_augment_no_wait_2_1"), "post-augment semantic label missing");
    console.log("verify-jcc-cruise-post-augment-language: ok");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
