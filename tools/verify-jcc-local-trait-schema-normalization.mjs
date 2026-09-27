import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-local-trait-schema-"));
  try {
    const signalsFile = path.join(tempDir, "signals.json");
    const outFile = path.join(tempDir, "live-state.json");
    await writeFile(signalsFile, JSON.stringify({
      ok: true,
      signal_kind: "candidate_runtime_signals",
      signals: [
        {
          type: "match_start",
          confidence: 0.9,
          payload: { game_start_time: "20260606020000" },
          evidence: "GameStart time:20260606020000",
        },
        {
          type: "local_report_chair_candidate",
          confidence: 0.84,
          payload: { chair_id: 2, turn_count: 3 },
          evidence: "#SoGame_Report# chairid: 2",
        },
        {
          type: "trait_state",
          confidence: 0.79,
          payload: {
            chair_id: 2,
            trait_id: "1002",
            name: "Duelist",
            count: 4,
            tier: "silver",
            next_tier: 6,
            units: ["Lissandra", "Nasus", "Talon", "Zoe"],
            choice_state: "fixed",
          },
          evidence: "synthetic trait local chair 2",
        },
        {
          type: "trait_state",
          confidence: 0.79,
          payload: {
            chair_id: 5,
            trait_id: "9999",
            name: "EnemyOnlyTrait",
            count: 9,
            tier: "gold",
            next_tier: null,
            units: ["Enemy"],
            choice_state: "unknown",
          },
          evidence: "synthetic trait enemy chair 5",
        },
      ],
    }, null, 2), "utf8");

    const result = await runNode([
      "tools/build-jcc-match-live-state.mjs",
      "--signals",
      signalsFile,
      "--out",
      outFile,
    ]);
    assert(result.code === 0, `live-state builder exited ${result.code}\n${result.stderr}`);
    const snapshot = JSON.parse(await readFile(outFile, "utf8"));
    const liveState = snapshot.live_state || {};
    const traits = liveState.traits?.active_traits || [];
    const trait = traits[0];

    assert(traits.length === 1, "active_traits must include only local chair traits");
    assert(trait.id === "1002", "trait must normalize id");
    assert(trait.name === "Duelist", "trait must normalize name");
    assert(trait.count === 4, "trait must normalize count");
    assert(trait.tier === "silver", "trait must normalize tier");
    assert(trait.next_tier === 6, "trait must normalize next_tier");
    assert(Array.isArray(trait.units) && trait.units.length === 4, "trait must preserve units");
    assert(trait.choice_state === "fixed", "trait must preserve choice_state");
    assert(trait.evidence === "synthetic trait local chair 2", "trait must preserve evidence");
    assert(trait.source_signal_type === "trait_state", "trait must preserve source signal type");
    assert(!JSON.stringify(traits).includes("EnemyOnlyTrait"), "trait_state must filter non-local chairs");
    assert(liveState.field_status?.["traits.active_traits"]?.status === "observed", "traits.active_traits status must be observed when local trait evidence exists");
    assert(liveState.field_status?.["traits.active_traits"]?.evidence === "synthetic trait local chair 2", "traits.active_traits status must preserve evidence");
    assert(!liveState.missing_fields?.includes("traits.active_traits"), "traits.active_traits must leave missing_fields when local trait evidence exists");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "local trait_state normalizes active trait schema",
        "trait_state filters non-local chairs",
        "traits.active_traits field_status carries observed evidence",
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
