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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-local-carousel-schema-"));
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
          payload: { game_start_time: "20260606050000" },
          evidence: "GameStart time:20260606050000",
        },
        {
          type: "local_report_chair_candidate",
          confidence: 0.84,
          payload: { chair_id: 2, turn_count: 1 },
          evidence: "#SoGame_Report# chairid: 2",
        },
        {
          type: "carousel_state",
          confidence: 0.77,
          payload: {
            chair_id: 2,
            active: true,
            can_pick_now: true,
            available_units: [
              {
                champion_id: "1457",
                champion_name: "Lissandra",
                item_id: "1001",
                item_name: "B.F. Sword",
                position: { x: 12, y: 4 },
              },
              {
                champion_id: "2454",
                champion_name: "Bel'Veth",
                item_id: "2001",
                item_name: "Infinity Edge",
                position: { x: 7, y: 8 },
              },
            ],
          },
          evidence: "synthetic carousel local chair 2",
        },
        {
          type: "carousel_state",
          confidence: 0.77,
          payload: {
            chair_id: 5,
            active: true,
            can_pick_now: true,
            available_units: [{ champion_id: "9999", champion_name: "EnemyOnlyCarousel" }],
          },
          evidence: "synthetic carousel enemy chair 5",
        },
        {
          type: "carousel_selected_state",
          confidence: 0.79,
          payload: {
            chair_id: 2,
            selected_pick: {
              champion_id: "1457",
              champion_name: "Lissandra",
              item_id: "1001",
              item_name: "B.F. Sword",
              position: { x: 12, y: 4 },
            },
          },
          evidence: "synthetic selected carousel local chair 2",
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
    const carousel = liveState.carousel || {};
    const unit = carousel.available_units?.[0];

    assert(carousel.active === true, "carousel.active must normalize true");
    assert(carousel.can_pick_now === true, "carousel.can_pick_now must normalize true");
    assert(carousel.available_units.length === 2, "carousel.available_units must include local available units");
    assert(unit.champion?.id === "1457", "carousel unit must normalize champion.id");
    assert(unit.champion?.name === "Lissandra", "carousel unit must normalize champion.name");
    assert(unit.item?.id === "1001", "carousel unit must normalize item.id");
    assert(unit.item?.name === "B.F. Sword", "carousel unit must normalize item.name");
    assert(unit.position?.x === 12 && unit.position?.y === 4, "carousel unit must preserve position");
    assert(unit.evidence === "synthetic carousel local chair 2", "carousel unit must preserve evidence");
    assert(!JSON.stringify(carousel.available_units).includes("EnemyOnlyCarousel"), "carousel units must filter non-local chairs");
    assert(carousel.selected_pick.champion?.id === "1457", "selected pick must normalize champion");
    assert(carousel.selected_pick.item?.id === "1001", "selected pick must normalize item");
    assert(carousel.selected_pick.evidence === "synthetic selected carousel local chair 2", "selected pick must preserve evidence");
    assert(liveState.field_status?.["carousel.active"]?.status === "observed", "carousel.active status must be observed");
    assert(liveState.field_status?.["carousel.available_units"]?.status === "observed", "carousel.available_units status must be observed");
    assert(liveState.field_status?.["carousel.can_pick_now"]?.status === "observed", "carousel.can_pick_now status must be observed");
    assert(liveState.field_status?.["carousel.selected_pick"]?.status === "observed", "carousel.selected_pick status must be observed");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "local carousel state normalizes available units",
        "carousel state filters non-local chairs",
        "selected carousel pick normalizes selected schema",
        "carousel field_status carries observed evidence",
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
