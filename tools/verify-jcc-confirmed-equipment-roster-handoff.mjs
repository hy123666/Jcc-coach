import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHostReadonlyToolBroker } from "../ui/electron/host-readonly-tool-broker.js";
import { createDecisionMathService } from "../ui/electron/decision-math-service.js";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";

process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
const serviceUrl = new URL("../ui/electron/runtime-service.js", import.meta.url).href;
const hook = registerHooks({ load(url, context, next) {
  const result = next(url, context);
  return url === serviceUrl ? { ...result, source: `${result.source}\nexport { compactEquipmentDecisionContextForTurn };` } : result;
} });
const runtime = await import(serviceUrl);
hook.deregister();
runtime.setRuntimeServiceState({ active_mode: "cruise", match_session: { status: "active", session_id: "test-match" },
  match_context: {}, host_cli: { provider: "codex" }, response_task: { status: "idle" }, user_preferences: {} });
const names = ["永恒之森纹章", "绝命花妖纹章", "法师纹章"];
const equipment = { match_session_id: "test-match", revision: 6,
  emblems: names.map((name) => ({ name, owner_unit: null })),
  components: [{ name: "暴风之剑" }, { name: "暴风之剑" }],
  completed: [], equipped_items: [], confirmed_sections: { emblems: true, completed: true, artifacts: false } };
const facts = { user_confirmed_equipment: equipment, target_plan: { target_name: "test-target" },
  augments: { selected_augments: [{ name: "first-confirmed" }, { name: "second-confirmed" }] },
  latest_user_intent: { text: "use emblems" } };
for (const mode of ["cruise", "augment_choice", "item_choice", "lineup_card", "daily_chat"]) {
  let delta;
  const prompt = runtime.buildHostTurnDeltaPrompt({ request_id: `test:${mode}`, mode,
    user_message: "如何利用这些纹章搭配完整阵容", runtime_context: { match_facts: facts } },
  { capsule_id: "test", fingerprint: "test" }, { onDelta: (value) => { delta = value; } });
  assert.deepEqual(delta.runtime_context.match_facts.user_confirmed_equipment, equipment, mode);
  assert.deepEqual(delta.runtime_context.match_facts.augments, facts.augments);
  assert.deepEqual(delta.runtime_context.match_facts.target_plan, facts.target_plan);
  for (const name of names) assert.ok(prompt.includes(name), mode);
}
const items = Array.from({ length: 18 }, (_, i) => ({ name: `item-${i}` }));
assert.deepEqual(runtime.compactEquipmentDecisionContextForTurn({ effective_item_bench: items,
  effective_equipped_items: items }).effective_equipped_items, items);

const root = path.resolve(import.meta.dirname, "..");
const paths = createRuntimePaths(root);
const catalog = JSON.parse(await readFile(paths.activeDecisionInputCatalogFile, "utf8"));
const core = await createDecisionMathService({ hardDataPackageDir: path.dirname(path.join(root, paths.activeHardDataManifest)),
  coreProfileFile: paths.activeCoreProfileFile, decisionInputCatalogFile: paths.activeDecisionInputCatalogFile,
  expectedIdentity: catalog.source_identity });
const args = { question: "搭上去", operation: "solve_trait_roster_role_coverage", population: 9,
  main_carry: "乐芙兰", main_tank: "赫卡里姆",
  target_traits: [{ trait: "永恒之森", count: 7 }, { trait: "法师", count: 4 }, { trait: "绝命花妖", count: 2 }],
  emblems: ["永恒之森", "法师", "绝命花妖"].map((trait) => ({ trait, count: 1 })) };
for (const policy of ["current_core_and_ranking", "active_core_profile_only"]) {
  const broker = createHostReadonlyToolBroker({ evidencePacket: { evidence_snapshot: { evidence_snapshot_id: policy } },
    maxResultBytes: 512 * 1024, maxCumulativeResultBytes: 1024 * 1024,
    calculate: async (question, request) => {
      assert.equal(question, "搭上去");
      assert.deepEqual(request, args);
      const result = await core.calculate(request);
      assert.equal(result.executable, true, JSON.stringify(result));
      assert.ok(result.roster.length > 0);
      assert.equal(result.emblems.length, 3);
      assert.equal(result.evidence_policy, "active_core_profile_only_no_rankings");
      return result;
    } });
  await broker.call("jcc.calculate", args);
  await assert.rejects(broker.call("jcc.calculate", { ...args, population: 99 }), /invalid_calculation_population/);
  await assert.rejects(broker.call("jcc.calculate", { ...args, operation: undefined }), /calculation_operation_required/);
  await assert.rejects(broker.call("jcc.calculate", { ...args, emblems: [{ trait: "法师", count: 0 }] }), /invalid_calculation/);
}
console.log(JSON.stringify({ ok: true, checks: ["final_wire_confirmed_equipment_all_modes", "augment_and_target_preserved", "no_reliable_equipment_truncation", "explicit_core_roster_broker"] }));
