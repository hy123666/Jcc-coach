import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runtimeService = await readFile("ui/electron/runtime-service.js", "utf8");
const pipeline = await readFile("tools/run-jcc-cruise-runtime-pipeline.mjs", "utf8");

function sliceFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert(start >= 0, `${name} must exist`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next >= 0 ? next : source.length);
}

for (const [label, source] of [["runtime-service", runtimeService], ["cruise-pipeline", pipeline]]) {
  const readRule = sliceFunction(source, "readRuntimeRuleFile");
  const bundle = sliceFunction(source, "buildActiveRulesBundle");
  assert(readRule.includes("Required JCC runtime rule file is missing"), `${label} must fail closed when required rules are missing`);
  assert(readRule.includes("Required JCC runtime rule file is invalid"), `${label} must fail closed when required rules are invalid`);
  assert(!bundle.includes("missing_rule_file_safe_fallback"), `${label} active rules bundle must not silently install missing-rule fallbacks`);
  assert(bundle.includes("fail_closed_on_missing_or_invalid"), `${label} active rules bundle must expose fail-closed rule status`);
}

const pipelineMain = pipeline.slice(pipeline.indexOf("async function main()"));
assert(pipelineMain.includes("const outputResult = options.retainFullState ? result : buildRedactedPipelineResult(result);"), "pipeline stdout must be redacted unless --retain-full-state is explicit");
assert(pipelineMain.includes("process.stdout.write(json);"), "pipeline should emit the selected redacted/full output JSON");
assert(!pipelineMain.includes("const json = `${JSON.stringify(result"), "pipeline stdout must not directly serialize the full result by default");
assert(pipeline.includes("redacted pipeline result for replay/status/stdout by default"), "redaction policy text must include stdout");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "active runtime rule files fail closed on missing or invalid JSON",
    "active rule bundle exposes loaded/fail-closed status",
    "cruise pipeline stdout is redacted by default",
  ],
}, null, 2));
