import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createDecisionMathService } from "../ui/electron/decision-math-service.js";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { planStrategyEvidenceRouteIds } from "../ui/electron/strategy-evidence-kernel.js";
import { buildRuntimeHostContext, buildHostTurnDeltaPrompt, setRuntimeServiceState } from "../ui/electron/runtime-service.js";

const root = path.resolve(import.meta.dirname, "..");
const paths = createRuntimePaths(root);
const catalog = JSON.parse(await readFile(paths.activeDecisionInputCatalogFile, "utf8"));
const service = await createDecisionMathService({
  hardDataPackageDir: path.dirname(path.join(root, paths.activeHardDataManifest)),
  coreProfileFile: paths.activeCoreProfileFile,
  decisionInputCatalogFile: paths.activeDecisionInputCatalogFile,
  expectedIdentity: catalog.source_identity,
});
const question = "获得21金币，蔓延之根，是我这把3-2的两个强化，我已经有地狱火转了。目前5级，有血量，有质量，你觉得这两个我选哪个";
for (const text of [question, "我拿到蔓延之根了", "蔓延之根", "蔓延之根你不知道吗"] ) {
  const facts = service.resolveMentionedFacts(text);
  const augment = facts?.entities.find((row) => row.name === "蔓延之根");
  assert.ok(augment, `missing exact entity for: ${text}`);
  assert.match(JSON.stringify(augment), /3回合/);
  assert.match(JSON.stringify(augment), /随机纹章/);
  for (const mode of ["daily_chat", "cruise"]) {
    assert.ok(planStrategyEvidenceRouteIds({ routes: [] }, {
      queryText: text, runtimeMode: mode, runtimeContext: { decision_math_context: facts },
    }).includes("entity_details"));
  }
}
assert.equal(service.resolveMentionedFacts("你好，谢谢"), null);
for (const name of ["阿木木", "无尽之刃", "地狱火"]) {
  assert.ok(service.resolveMentionedFacts(name)?.entities.some((row) => row.name === name), name);
}
const computed = await service.calculateQuestion(question, { force_theorycraft: true });
assert.equal(computed.executable, true);
assert.ok((computed.entities || computed.components?.entity_details?.entities)
  .some((row) => row.name === "蔓延之根"));
setRuntimeServiceState({ active_mode: "daily_chat", match_session: { status: "idle" },
  daily_session: { status: "active", generation: 992 }, host_cli: { provider: "codex" },
  response_task: { status: "idle" }, match_context: {}, user_preferences: {} });
for (const mode of ["daily_chat", "cruise"]) {
  for (const capability of ["native_dynamic_tools", "prefetch_complete"]) {
    const request = { request_id: `entity:${mode}:${capability}`, request_kind: "host_question",
      mode, provider_readonly_tool_mode: capability, user_message: "蔓延之根" };
    request.runtime_context = await buildRuntimeHostContext(mode, null, request);
    const prompt = buildHostTurnDeltaPrompt(request, { capsule_id: "entity-test", fingerprint: "entity-test" });
    assert.match(prompt, /3回合/, `${mode}/${capability}: reward timing must reach the actual wire`);
    assert.match(prompt, /随机纹章/);
  }
}
console.log(JSON.stringify({ ok: true, schema: "jcc-entity-first-evidence-verification-v1" }));
