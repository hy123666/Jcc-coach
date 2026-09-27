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

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-watch-derived-traits-"));
  try {
    const fixture = path.join(tempDir, "fixture.logcat.txt");
    await writeFile(fixture, [
      '06-13 11:00:00.000  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4358 {"s":2}, id: 1',
      '06-13 11:00:00.050  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4358 {"s":1}, id: 2',
      '06-13 11:00:00.075  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4354 {"bl":[{"i":11500,"l":0,"t":0,"r":10,"b":10}]}, id: 3',
      '06-13 11:00:00.100  1000  2000 D NemuInit: start name: gi_plugin_jkchess, operation: 4353 {"hl":[{"i":11500,"x":640,"y":370},{"i":11502,"x":720,"y":470},{"i":12503,"x":800,"y":470},{"i":13502,"x":900,"y":470}]}, id: 4',
    ].join("\n"), "utf8");

    const outDir = path.join(tempDir, "watch");
    const result = await runNode([
      "tools/watch-jcc-mumu-runtime-logcat.mjs",
      "--out-dir", outDir,
      "--match-session-id", "watch-derived-traits",
      "--logcat-fixture", fixture,
    ]);
    assert(result.code === 0, `watcher failed:\n${result.stderr || result.stdout}`);
    const state = JSON.parse(await readFile(path.join(outDir, "state.json"), "utf8"));
    const units = state.current_view?.filtered_units || [];
    assert(units.length > 0, "watcher fixture should produce current_view.filtered_units");
    assert(units.every((unit) => Array.isArray(unit.trait_codes) && unit.trait_codes.length > 0), `current_view units should carry catalog trait_codes: ${JSON.stringify(units)}`);
    const traits = state.current_view?.derived_traits || [];
    assert(traits.length > 0, "watcher should derive current_view.derived_traits from unit trait_codes");
    assert(state.current_view?.derived_trait_policy?.primary_source === "mumu_4353_current_view_units", "derived trait policy should mark MuMu 4353 as primary source");
    assert(state.current_view?.derived_trait_policy?.item_bonus_source === "scoped_current_view_trait_items_only", "current_view trait item policy should require explicit current_view scope");

    const firstTrait = units.find((unit) => Array.isArray(unit.traits) && unit.traits.length > 0)?.traits?.[0];
    assert(firstTrait, "fixture should expose at least one trait for pollution guard");
    const beforeCount = traits.find((trait) => trait.code === firstTrait.code)?.count || 0;
    const pollutionEvents = path.join(tempDir, "pollution-events.jsonl");
    const baseEvents = (await readFile(path.join(outDir, "events.jsonl"), "utf8")).trim();
    await writeFile(pollutionEvents, `${baseEvents}\n${JSON.stringify({
      schema: "jcc-mumu-gi-runtime-event-v1",
      type: "equipped_items_candidate",
      source: "unit_test_fixture",
      command: 4356,
      command_hex: "0x1104",
      match_session_id: "watch-derived-traits",
      received_at: "2026-06-13T11:00:00.200Z",
      items_patch: {
        equipped_items: [{
          slot_index: 0,
          item_id: 1001,
          equip_id: 1001,
          owner_scope: "self",
          area: "board_or_current_equipment",
          grants_trait_codes: [firstTrait.code],
          grants_traits: [firstTrait],
        }],
      },
      promotion_policy: "self_scoped_trait_item_fixture",
    })}\n`, "utf8");
    const rebuilt = await runNode([
      "tools/build-jcc-mumu-gi-live-state.mjs",
      "--events", pollutionEvents,
      "--out", path.join(tempDir, "rebuilt-state.json"),
    ]);
    assert(rebuilt.code === 0, `state builder failed:\n${rebuilt.stderr || rebuilt.stdout}`);
    const rebuiltState = JSON.parse(await readFile(path.join(tempDir, "rebuilt-state.json"), "utf8"));
    const afterCount = rebuiltState.current_view?.derived_traits?.find((trait) => trait.code === firstTrait.code)?.count || 0;
    assert(afterCount === beforeCount, `self-owned trait item must not increase current_view derived trait count: before=${beforeCount} after=${afterCount}`);

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "watcher decorates current_view units with catalog trait_codes",
        "watcher derives current_view.derived_traits without OCR trait text",
        "current_view derived traits ignore self-scoped trait items",
      ],
      units: units.map((unit) => ({ name: unit.name, trait_codes: unit.trait_codes })),
      derived_traits: traits.map((trait) => ({ name: trait.name, count: trait.count })),
    }, null, 2));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
