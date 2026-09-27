import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { loadActiveRulesBundle } from "./jcc_active_rules_contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function exists(relativePath) {
  try {
    await access(path.join(repoRoot, relativePath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

const activeRulesSource = await readFile(path.join(repoRoot, "tools/jcc_active_rules_contract.mjs"), "utf8");
const runtimeStoreSource = await readFile(path.join(repoRoot, "ui/electron/runtime-state-store.js"), "utf8");
const runtimePaths = createRuntimePaths(repoRoot);
const bundle = loadActiveRulesBundle({ repoRoot, runtimePaths });

assert.equal(bundle.rules_status?.source_authority, "game_knowledge_active_profile");
assert.equal(bundle.rules_status?.legacy_rules, "retired_no_fallback");
assert.equal(bundle.rules_status?.core_profile_id, runtimePaths.activeCoreProfileId);
assert.match(activeRulesSource, /production rules have no legacy fallback/);
assert.doesNotMatch(activeRulesSource, /allowLegacyRuleFixtures|legacy_rule_fixture/);
assert.doesNotMatch(runtimeStoreSource, /legacyBaseGameRuleFixtureFile|legacySeasonNormalRuleFixtureFile|legacySeasonSpecialRuleFixtureFile/);

for (const retiredFile of [
  "data/runtime/jcc/fixtures/legacy-rules/common/base-game-rules.json",
  "data/runtime/jcc/fixtures/legacy-rules/s17/normal-rules.json",
  "data/runtime/jcc/fixtures/legacy-rules/s17/special-rules.json",
]) {
  assert.equal(await exists(retiredFile), false, `${retiredFile} must not return as a Runtime fallback`);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-profile-only-rule-authority-verifier-v1",
  core_profile_id: runtimePaths.activeCoreProfileId,
})}\n`);
