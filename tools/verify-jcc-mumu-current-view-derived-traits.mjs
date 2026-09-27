import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function byName(rows, name) {
  return (rows || []).find((row) => row.name === name);
}

async function buildState(events, tag) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `jcc-derived-traits-${tag}-`));
  try {
    const eventsFile = path.join(tempDir, "events.jsonl");
    const outFile = path.join(tempDir, "live-state.json");
    await writeFile(eventsFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const result = await runNode(["tools/build-jcc-mumu-gi-live-state.mjs", "--events", eventsFile, "--out", outFile]);
    assert(result.code === 0, `builder failed:\n${result.stderr || result.stdout}`);
    return JSON.parse(await readFile(outFile, "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const s2Events = [
    { type: "mumu_gi_message", cmd: 4358, payload: { s: 2 }, observed_at: "2026-06-13T02:00:00.000Z", match_session_id: "trait-sample" },
    { type: "mumu_gi_message", cmd: 4353, payload: { hl: [
      { i: 11500, x: 1, y: 1 },
      { i: 11502, x: 2, y: 1 },
      { i: 12503, x: 3, y: 1 },
      { i: 13502, x: 4, y: 1 },
      { i: 13511, x: 5, y: 1 },
      { i: 11512, x: 6, y: 1 },
    ] }, observed_at: "2026-06-13T02:00:01.000Z", match_session_id: "trait-sample" },
    { type: "opponent_snapshot_requested", snapshot_id: "opponent-traits", observed_at: "2026-06-13T02:00:02.000Z", match_session_id: "trait-sample" },
  ];
  const s2State = await buildState(s2Events, "s2");
  assert(!s2State.opponents?.snapshots, "S=2/current-view data must not create opponent snapshots");
  assert(!s2State.field_status?.["opponents.snapshots"], "S=2/current-view data must not expose opponent snapshot field status");
  assert((s2State.current_view?.derived_traits || []).length === 0, "S=2 current_view must not derive product traits");
  assert((s2State.traits?.active_traits || []).length === 0, "S=2 current_view must not refresh active own traits");
  assert(s2State.current_view?.diagnostic_units?.length > 0, "S=2 4353 rows may remain as diagnostics");
  assert(s2State.current_view?.derived_trait_policy?.promotion_status === "diagnostic_only_until_s1_plus_fresh_4354_shop_anchor", "S=2 trait policy must be diagnostic-only");

  const s1Events = [
    { type: "mumu_gi_message", cmd: 4358, payload: { s: 1 }, observed_at: "2026-06-13T03:00:00.000Z", match_session_id: "trait-sample-self" },
    { type: "mumu_gi_message", cmd: 4354, payload: { bl: [{ i: 11500, l: 0, t: 0, r: 10, b: 10 }] }, observed_at: "2026-06-13T03:00:00.500Z", match_session_id: "trait-sample-self" },
    { type: "mumu_gi_message", cmd: 4353, payload: { hl: [
      { i: 11500, x: 1, y: 1 },
      { i: 11502, x: 2, y: 1 },
      { i: 12503, x: 3, y: 1 },
      { i: 13502, x: 4, y: 1 },
      { i: 13511, x: 5, y: 1 },
      { i: 11512, x: 6, y: 1 },
    ] }, observed_at: "2026-06-13T03:00:01.000Z", match_session_id: "trait-sample-self" },
  ];
  const s1State = await buildState(s1Events, "s1");
  const currentTraits = s1State.current_view?.derived_traits || [];
  assert(currentTraits.length > 0, "S=1 + fresh 4354 anchored current_view should derive own current traits");
  assert(byName(currentTraits, "护卫")?.count === 4, `current S18 sample should derive 4 护卫: ${JSON.stringify(currentTraits)}`);
  assert(byName(currentTraits, "法师")?.count === 3, "current S18 sample should derive 3 法师");
  assert(s1State.current_view?.derived_trait_policy?.ocr_trait_text_role === "fallback_or_consistency_check_only", "trait OCR must remain fallback/check evidence");

  const staleTraitState = await buildState([
    ...s1Events,
    { type: "mumu_gi_message", cmd: 4354, payload: { bl: [] }, observed_at: "2026-06-13T03:00:02.000Z", match_session_id: "trait-sample-self" },
  ], "stale");
  assert((staleTraitState.board?.local_board_units_candidate || []).length === 0, "invalidated board must not remain current");
  assert((staleTraitState.current_view?.derived_traits || []).length === 0, "invalidated board must clear current_view derived traits");
  assert((staleTraitState.traits?.active_traits || []).length === 0, "invalidated board must clear active current traits");
  assert(staleTraitState.traits?.stale_active_traits_reference?.traits?.length > 0, "last derived traits may remain only as an explicit stale reference");
  assert(staleTraitState.field_status?.["traits.active_traits"]?.status === "stale_reference", "stale traits must not remain candidate/current");
  assert(staleTraitState.field_status?.["traits.active_traits"]?.usable_for === "conditional_only", "stale traits must be conditional-only");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "S=2 current_view is diagnostic-only and creates no opponent traits/snapshots",
      "S=2 current_view does not refresh own active traits",
      "S=1 plus fresh non-empty 4354 shop anchor may derive own current traits",
      "board invalidation clears current traits and retains only a conditional stale trait reference",
      "trait OCR remains fallback/check evidence",
    ],
    s1_derived_traits: currentTraits.map((row) => ({ name: row.name, count: row.count, active_breakpoint: row.active_breakpoint, next_breakpoint: row.next_breakpoint })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
