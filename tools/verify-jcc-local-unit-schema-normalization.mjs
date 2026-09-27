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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-local-unit-schema-"));
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
          payload: { game_start_time: "20260606010000" },
          evidence: "GameStart time:20260606010000",
        },
        {
          type: "local_report_chair_candidate",
          confidence: 0.84,
          payload: { chair_id: 2, turn_count: 3 },
          evidence: "#SoGame_Report# chairid: 2",
        },
        {
          type: "board_unit_state",
          confidence: 0.8,
          payload: {
            chair_id: 2,
            entity_id: "local-board-1",
            champion_id: "1457",
            name: "Lissandra",
            star_level: 2,
            position: { row: 1, col: 3 },
            items: [{ item_id: "2091", name: "Guinsoo's Rageblade", item_type: "completed" }],
            summoned: false,
            clone: false,
          },
          evidence: "synthetic board local chair 2",
        },
        {
          type: "bench_unit_state",
          confidence: 0.8,
          payload: {
            chair_id: 2,
            slot: 0,
            champion_id: "1501",
            name: "Nasus",
            star_level: 1,
            items: [],
            sellable: true,
          },
          evidence: "synthetic bench local chair 2",
        },
        {
          type: "item_bench_state",
          confidence: 0.78,
          payload: {
            chair_id: 2,
            slot: 1,
            item_id: "1001",
            name: "B.F. Sword",
            item_type: "component",
          },
          evidence: "synthetic item bench local chair 2",
        },
        {
          type: "equipped_item_state",
          confidence: 0.78,
          payload: {
            chair_id: 2,
            entity_id: "local-board-1",
            champion_id: "1457",
            item_id: "2091",
            name: "Guinsoo's Rageblade",
            item_type: "completed",
          },
          evidence: "synthetic equipped item local chair 2",
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
    const board = liveState.board.board_units[0];
    const bench = liveState.bench.bench_units[0];
    const itemBench = liveState.items.item_bench[0];
    const equipped = liveState.items.equipped_items[0];

    assert(board.entity_id === "local-board-1", "board unit must include entity_id");
    assert(board.champion?.id === "1457", "board unit must expose champion.id");
    assert(board.champion?.name === "Lissandra", "board unit must expose champion.name");
    assert(board.star === 2, "board unit must normalize star");
    assert(board.position?.row === 1 && board.position?.col === 3, "board unit must preserve position");
    assert(Array.isArray(board.items) && board.items[0]?.id === "2091", "board unit items must be normalized");
    assert(board.summoned === false && board.clone === false, "board unit must preserve summoned/clone flags");
    assert(board.evidence === "synthetic board local chair 2", "board unit must preserve evidence");
    assert(board.source_signal_type === "board_unit_state", "board unit must preserve source signal type");

    assert(bench.slot === 0, "bench unit must include slot");
    assert(bench.champion?.id === "1501" && bench.champion?.name === "Nasus", "bench unit must expose champion object");
    assert(bench.star === 1, "bench unit must normalize star");
    assert(bench.sellable === true, "bench unit must preserve sellable");
    assert(bench.evidence === "synthetic bench local chair 2", "bench unit must preserve evidence");

    assert(itemBench.slot === 1, "item bench entry must include slot");
    assert(itemBench.item?.id === "1001" && itemBench.item?.name === "B.F. Sword", "item bench entry must expose item object");
    assert(itemBench.item?.type === "component", "item bench entry must preserve item type");
    assert(itemBench.evidence === "synthetic item bench local chair 2", "item bench entry must preserve evidence");

    assert(equipped.entity_id === "local-board-1", "equipped item must include entity_id");
    assert(equipped.champion?.id === "1457", "equipped item must include champion object");
    assert(equipped.item?.id === "2091" && equipped.item?.type === "completed", "equipped item must expose normalized item");
    assert(equipped.evidence === "synthetic equipped item local chair 2", "equipped item must preserve evidence");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "board unit normalized to runtime schema",
        "bench unit normalized to runtime schema",
        "item bench normalized to runtime schema",
        "equipped item normalized to runtime schema",
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
