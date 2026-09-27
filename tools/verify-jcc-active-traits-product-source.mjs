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

async function buildState(events) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-active-traits-"));
  const eventsFile = path.join(tempDir, "events.jsonl");
  const outFile = path.join(tempDir, "live-state.json");
  await writeFile(eventsFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  const result = await runNode(["tools/build-jcc-mumu-gi-live-state.mjs", "--events", eventsFile, "--out", outFile]);
  assert(result.code === 0, `builder failed:\n${result.stderr || result.stdout}`);
  const state = JSON.parse(await readFile(outFile, "utf8"));
  await rm(tempDir, { recursive: true, force: true });
  return state;
}

async function main() {
  const units = [
    { i: 14376, x: 1, y: 1 },
    { i: 14370, x: 2, y: 1 },
    { i: 12452, x: 3, y: 1 },
    { i: 14379, x: 4, y: 1 },
  ];
  const s1State = await buildState([
    { type: "mumu_gi_message", cmd: 4358, payload: { s: 1 }, observed_at: "2026-06-15T01:00:00.000Z", match_session_id: "traits-s1" },
    { type: "mumu_gi_message", cmd: 4354, payload: { bl: [{ i: 11453, l: 0, t: 0, r: 10, b: 10 }] }, observed_at: "2026-06-15T01:00:00.500Z", match_session_id: "traits-s1" },
    { type: "mumu_gi_message", cmd: 4353, payload: { hl: units }, observed_at: "2026-06-15T01:00:01.000Z", match_session_id: "traits-s1" },
  ]);
  assert((s1State.current_view?.derived_traits || []).length > 0, "shop-anchored current_view should derive traits");
  assert((s1State.traits?.active_traits || []).length > 0, "visible shop self-view should publish traits.active_traits");
  assert(s1State.field_status?.["traits.active_traits"]?.source_type === "mumu_catalog_overlay_plus_self_view_units", "active traits must be sourced from MuMu units plus catalog");
  assert(s1State.traits?.active_trait_policy?.text_role === "trait_text_is_consistency_check_only", "trait text must be consistency evidence only");

  const s2State = await buildState([
    { type: "mumu_gi_message", cmd: 4358, payload: { s: 2 }, observed_at: "2026-06-15T01:00:00.000Z", match_session_id: "traits-s2" },
    { type: "mumu_gi_message", cmd: 4353, payload: { hl: units }, observed_at: "2026-06-15T01:00:01.000Z", match_session_id: "traits-s2" },
  ]);
  assert((s2State.current_view?.derived_traits || []).length > 0, "s2 current-view should still derive scoped traits");
  assert((s2State.traits?.active_traits || []).length === 0, "s2 current-view must not update own traits.active_traits");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "visible shop self-view promotes derived traits to traits.active_traits",
      "s2 current-view/opponent view does not pollute own active_traits",
      "trait text is documented as consistency/check evidence only",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
