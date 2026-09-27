import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function buildState(events) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-mumu-equipment-source-"));
  try {
    const eventsFile = path.join(tempDir, "events.jsonl");
    const outFile = path.join(tempDir, "state.json");
    await writeFile(eventsFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const result = await runNode([
      "tools/build-jcc-mumu-gi-live-state.mjs",
      "--events",
      eventsFile,
      "--out",
      outFile,
      "--match-session-id",
      "equipment-source-priority",
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return JSON.parse(await readFile(outFile, "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

const baseOwnAnchorEvents = [
  { type: "mumu_gi_message", cmd: 4358, payload: { s: 1 }, observed_at: "2026-07-01T10:00:00.000Z", match_session_id: "equipment-source-priority" },
  { type: "mumu_gi_message", cmd: 4354, payload: { bl: [{ i: 11453, l: 100, t: 900, r: 200, b: 980 }] }, observed_at: "2026-07-01T10:00:00.300Z", match_session_id: "equipment-source-priority" },
  { type: "mumu_gi_message", cmd: 4352, payload: { wl: [] }, observed_at: "2026-07-01T10:00:00.600Z", match_session_id: "equipment-source-priority" },
  { type: "mumu_gi_message", cmd: 4353, payload: { hl: [
    { i: 11451, x: 540, y: 420 },
    { i: 11452, x: 780, y: 610 },
  ] }, observed_at: "2026-07-01T10:00:01.000Z", match_session_id: "equipment-source-priority" },
];

async function main() {
  const anchoredState = await buildState([
    ...baseOwnAnchorEvents,
    { type: "mumu_gi_message", cmd: 4357, payload: { el: [
      { i: 1101, l: 36, t: 280, r: 86, b: 330 },
      { i: 1102, l: 36, t: 340, r: 86, b: 390 },
    ] }, observed_at: "2026-07-01T10:00:01.200Z", match_session_id: "equipment-source-priority" },
    { type: "mumu_gi_message", cmd: 4356, payload: { el: [
      { i: 2101, l: 518, t: 430, r: 558, b: 470 },
      { i: 2102, l: 760, t: 620, r: 800, b: 660 },
      { i: 9999, l: 1230, t: 800, r: 1270, b: 840 },
    ] }, observed_at: "2026-07-01T10:00:01.500Z", match_session_id: "equipment-source-priority" },
  ]);

  const itemBench = anchoredState.items?.item_bench || [];
  const equipped = anchoredState.items?.equipped_items || [];
  const unassigned = anchoredState.items?.visible_equipment_unassigned || [];
  assert.equal(itemBench.length, 2, "4357 inventory rail must populate item_bench");
  assert(itemBench.every((item) => item.source === "mumu_4357_item_bench"), "4357 item_bench source must be explicit");
  assert.equal(equipped.length, 2, "only 4356 items near trusted own 4353 units may populate equipped_items");
  assert(equipped.every((item) => item.owner_scope === "own_unit"), "equipped_items must be assigned to own units");
  assert(equipped.every((item) => item.assigned_unit_base_hero_id), "equipped_items must include assigned unit identity");
  assert(!equipped.some((item) => item.item_id === 9999), "far visible equipment must not become own equipped_items");
  assert(unassigned.some((item) => item.item_id === 9999 && item.assignment_status === "unassigned"), "far visible equipment should be preserved as unassigned diagnostics");
  assert.equal(anchoredState.field_status?.["items.item_bench"]?.source, "mumu_4357_item_bench", "item_bench field_status must prefer 4357");
  assert.equal(anchoredState.field_status?.["items.equipped_items"]?.source, "mumu_4356_equipment_to_4353_own_unit", "equipped_items field_status must identify 4356-to-4353 assignment");

  const s2State = await buildState([
    ...baseOwnAnchorEvents,
    { type: "mumu_gi_message", cmd: 4358, payload: { s: 2 }, observed_at: "2026-07-01T10:01:00.000Z", match_session_id: "equipment-source-priority" },
    { type: "mumu_gi_message", cmd: 4356, payload: { el: [
      { i: 3101, l: 518, t: 430, r: 558, b: 470 },
    ] }, observed_at: "2026-07-01T10:01:00.500Z", match_session_id: "equipment-source-priority" },
  ]);
  assert(!((s2State.items?.equipped_items || []).some((item) => item.item_id === 3101)), "S=2 4356 must not update own equipped_items");
  assert((s2State.items?.visible_equipment_unassigned || []).some((item) => item.item_id === 3101), "S=2 4356 should be kept only as unassigned visible equipment");

  const unanchoredState = await buildState([
    { type: "mumu_gi_message", cmd: 4358, payload: { s: 1 }, observed_at: "2026-07-01T10:02:00.000Z", match_session_id: "equipment-source-priority" },
    { type: "mumu_gi_message", cmd: 4353, payload: { hl: [{ i: 11451, x: 540, y: 420 }] }, observed_at: "2026-07-01T10:02:00.200Z", match_session_id: "equipment-source-priority" },
    { type: "mumu_gi_message", cmd: 4356, payload: { el: [{ i: 4101, l: 518, t: 430, r: 558, b: 470 }] }, observed_at: "2026-07-01T10:02:00.500Z", match_session_id: "equipment-source-priority" },
  ]);
  assert.equal((unanchoredState.items?.equipped_items || []).length, 0, "unanchored 4353 cannot receive equipped items");
  assert((unanchoredState.items?.visible_equipment_unassigned || []).some((item) => item.item_id === 4101), "unanchored 4356 should stay unassigned");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "4357 is the primary item_bench source",
      "4356 only populates equipped_items when assigned to trusted S=1 + 4354-anchored 4353 own units",
      "far or S=2 visible equipment is quarantined as unassigned diagnostics",
      "unanchored 4356 cannot populate own equipped_items",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
