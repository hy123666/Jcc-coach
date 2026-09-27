import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runFixture(tempDir, events) {
  const eventsFile = path.join(tempDir, "events.jsonl");
  const outFile = path.join(tempDir, "state.json");
  await writeFile(eventsFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "tools/build-jcc-choice-confirmation-state.mjs",
      "--compatibility-fixture",
      "--events",
      eventsFile,
      "--out",
      outFile,
    ], { cwd: path.resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code, output }));
  });
  assert(result.code === 0, `choice confirmation fixture failed\n${result.output}`);
  return JSON.parse(await readFile(outFile, "utf8"));
}

async function main() {
  const contract = JSON.parse(await readFile("data/runtime/jcc/choice-confirmation-hook-contract.json", "utf8"));
  assert(contract.schema === "jcc-choice-confirmation-hook-contract-v2", "contract schema mismatch");
  assert(contract.authority?.common_runtime_must_not_name_season_modes === true, "common choice lifecycle must remain season-neutral");
  assert(contract.source_boundary?.no_active_choice_ocr_or_host_visual_fallback === true, "active choices must reject visual candidate authority");
  assert(contract.active_season_choice_policy?.mode_and_stage_source === "compiled active major-season descriptor", "season choice mode/stage must come from the descriptor");
  assert(contract.augment_policy?.owned_text_panel_recovery?.stage_binding_rule?.includes("2-1, 3-2, and 4-2"), "owned augment row binding must stay explicit");

  const builder = await readFile("tools/build-jcc-choice-confirmation-state.mjs", "utf8");
  for (const retired of ["god_sequence", "god_choice_confirmed", "current_god", "star_god"]) {
    assert(!builder.includes(retired), `season-neutral fixture must not retain retired S17 token: ${retired}`);
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-choice-hooks-"));
  try {
    const state = await runFixture(tempDir, [
      { type: "new_game_start", match_session_id: "match-a", observed_at: "2026-08-24T01:00:00.000Z" },
      { type: "runtime_ui_mode_requested", match_session_id: "match-a", runtime_ui_mode: "augment_choice", choice_kind: "augment_choice", choices: [{ entity_id: 1 }, { entity_id: 2 }, { entity_id: 3 }] },
      { type: "augment_choice_confirmed", match_session_id: "match-a", choice_stage_round: "2-1", choice: { entity_id: 2, name: "augment B", slot_index: 1 } },
      { type: "owned_augment_text_panel_confirmed", match_session_id: "match-a", source: "user_triggered_owned_augment_text_panel_ocr", choice_stage_round: "3-2", choice: { entity_id: 4, name: "augment D", slot_index: 1 } },
      { type: "runtime_ui_mode_requested", match_session_id: "match-a", runtime_ui_mode: "future_relic_choice", choice_kind: "future_relic_choice", choices: [{ entity_id: "r1" }, { entity_id: "r2" }] },
      { type: "choice_confirmed", match_session_id: "match-a", choice_kind: "future_relic_choice", choice: { entity_id: "r2", name: "future relic" } },
      { type: "augment_choice_confirmed", match_session_id: "match-b", choice: { entity_id: 99, name: "wrong match" } },
    ]);
    assert(state.augments.selected_augments.length === 2, "augment and stage-bound owned-panel confirmations must persist");
    assert(state.season_choices.confirmed.length === 1, "descriptor-owned future season choice must use generic storage");
    assert(state.season_choices.confirmed[0].choice_kind === "future_relic_choice", "generic season choice kind must be preserved");
    assert(state.field_status["pollution_guard.rejected_cross_match_event"]?.status === "rejected", "cross-match event must fail closed");
    assert(!("variables" in state), "fixture must not expose retired season-specific variable storage");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({ ok: true, schema: "jcc-choice-confirmation-hooks-verification-v1" }));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
