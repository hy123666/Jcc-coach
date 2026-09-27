import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { loadActiveRulesBundle } from "./jcc_active_rules_contract.mjs";
import {
  configureCruiseRuntimeProfile,
  runPipeline,
} from "./run-jcc-cruise-runtime-pipeline.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const requiredIndexes = [
  "champion_damage_profile.json",
  "champion_role_profile.json",
  "champion_item_fit.json",
  "item_holder_fit.json",
  "trait_breakpoints.json",
  "trait_unit_matrix.json",
  "entity_strategy_weights.json",
];

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function candidateRuntimePaths(activePaths, candidate, bundle, hardDataManifest) {
  const generationDir = path.join(
    repoRoot,
    "data",
    "game-knowledge",
    "jcc",
    "generated",
    candidate.core_profile_id,
  );
  return {
    ...activePaths,
    activeCoreProfileId: candidate.core_profile_id,
    activeCoreProfile: candidate,
    activeCoreProfileFile: path.join(repoRoot, "data/game-knowledge/jcc/candidates/candidate-profile.json"),
    activeCoreProfileBundleFile: path.join(generationDir, "bundle.json"),
    activeCoreKnowledgeBundle: bundle,
    activeRuntimeCatalogOverlayFile: path.join(generationDir, "runtime-catalog-overlay.json"),
    activeHardDataManifest: hardDataManifest,
    activeSeasonId: candidate.season_id,
    activePatchId: candidate.patch_id,
    activeGameModeId: candidate.runtime_identity.game_mode_id,
    activePackageId: candidate.runtime_identity.package_id,
    activeSourcePackageId: candidate.runtime_identity.source_package_id,
    upstreamVersionIdentity: candidate.runtime_identity.upstream_identity,
    seasonPatchStrategyFile: path.join(repoRoot, `data/game-knowledge/jcc/seasons/${candidate.season_id}/patches/${candidate.patch_id}/strategy-overrides.json`),
    seasonPatchRuleOverridesFile: path.join(repoRoot, `data/game-knowledge/jcc/seasons/${candidate.season_id}/patches/${candidate.patch_id}/rule-overrides.json`),
  };
}

async function main() {
  const combatSource = await readFile(path.join(repoRoot, "tools/build-jcc-combat-cap-estimator-context.mjs"), "utf8");
  const lifecycleSource = await readFile(path.join(repoRoot, "tools/build-jcc-lineup-lifecycle-context.mjs"), "utf8");
  const cruiseSource = await readFile(path.join(repoRoot, "tools/run-jcc-cruise-runtime-pipeline.mjs"), "utf8");
  const combatModuleInitialization = combatSource.slice(0, combatSource.indexOf("function resolveProfileContext"));
  assert(!/const\s+runtimePaths\s*=\s*createRuntimePaths/.test(combatModuleInitialization), "combat estimator must not capture active paths at module initialization");
  assert(!/readBaseRules\.cache/.test(lifecycleSource), "lineup lifecycle must not retain an unkeyed active-rules singleton");
  assert(cruiseSource.includes("runtimeStrategyTablesByCoreProfileId"), "retained strategy-table cache must be keyed by Core Profile id");

  const activePaths = createRuntimePaths(repoRoot);
  const activeRules = loadActiveRulesBundle({ repoRoot, runtimePaths: activePaths });
  const archivedSeason = await readJson(path.join(
    repoRoot,
    "data/game-knowledge/jcc/seasons/s17/archive-manifest.json",
  ));
  const profileBId = archivedSeason.final_core_profile_id;
  const candidateBundle = await readJson(path.join(
    repoRoot,
    "data/game-knowledge/jcc/generated",
    profileBId,
    "bundle.json",
  ));
  const profileBIdentity = candidateBundle.runtime_identity;
  const candidate = {
    core_profile_id: profileBId,
    season_id: profileBIdentity.season_id,
    patch_id: profileBIdentity.patch_id,
    runtime_identity: {
      game_mode_id: profileBIdentity.game_mode_id,
      package_id: profileBIdentity.package_id,
      source_package_id: profileBIdentity.source_package_id,
      upstream_identity: profileBIdentity.upstream_identity,
    },
  };
  assert.notEqual(candidate.core_profile_id, activePaths.activeCoreProfileId, "archived rollback fixture must remain distinct from the active Core Profile");

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-cruise-profile-binding-"));
  const packageId = `verify-profile-b-${process.pid}-${Date.now()}`;
  const packageDir = path.join(repoRoot, "data/core-patches/jcc", packageId);
  try {
    await mkdir(path.join(packageDir, "indexes"), { recursive: true });
    const activePackageDir = path.dirname(path.resolve(repoRoot, activePaths.activeHardDataManifest));
    for (const file of requiredIndexes) {
      await cp(path.join(activePackageDir, "indexes", file), path.join(packageDir, "indexes", file));
    }
    await writeFile(path.join(packageDir, "manifest.json"), `${JSON.stringify({
      schema: "jcc-profile-binding-verifier-manifest-v1",
      packageId,
      mode: candidate.runtime_identity.upstream_identity.mode,
      season: candidate.runtime_identity.upstream_identity.season,
      version: candidate.runtime_identity.upstream_identity.version,
    }, null, 2)}\n`, "utf8");

    const hardDataManifest = path.relative(repoRoot, path.join(packageDir, "manifest.json")).replaceAll("\\", "/");
    const profileBPaths = candidateRuntimePaths(activePaths, candidate, candidateBundle, hardDataManifest);
    const profileBRules = {
      ...structuredClone(activeRules),
      version_identity: {
        runtime_season_id: candidate.season_id,
        runtime_patch_id: candidate.patch_id,
        game_mode_id: candidate.runtime_identity.game_mode_id,
        package_id: candidate.runtime_identity.package_id,
        source_package_id: candidate.runtime_identity.source_package_id,
        upstream_identity: candidate.runtime_identity.upstream_identity,
      },
      source_fingerprint: candidate.core_profile_id,
      rules_status: {
        ...activeRules.rules_status,
        core_profile_id: candidate.core_profile_id,
      },
    };

    const initial = configureCruiseRuntimeProfile({ nextRuntimePaths: activePaths, rulesBundle: activeRules });
    assert.equal(initial.core_profile_id, activePaths.activeCoreProfileId, "daemon startup must begin on Profile A");
    assert.throws(
      () => configureCruiseRuntimeProfile({ nextRuntimePaths: activePaths, rulesBundle: profileBRules }),
      /do not match captured Core Profile/,
      "mixed A paths and B rules must fail closed",
    );
    const stillA = configureCruiseRuntimeProfile({ nextRuntimePaths: activePaths, rulesBundle: activeRules });
    assert.equal(stillA.core_profile_id, activePaths.activeCoreProfileId, "failed mixed-profile configuration must leave Profile A recoverable");
    const adopted = configureCruiseRuntimeProfile({ nextRuntimePaths: profileBPaths, rulesBundle: profileBRules });
    assert.equal(adopted.core_profile_id, candidate.core_profile_id, "Start Match must adopt promoted Profile B");

    const liveStateFile = path.join(tempRoot, "live-state.json");
    const adviceStateFile = path.join(tempRoot, "advice-state.json");
    await writeFile(liveStateFile, `${JSON.stringify({
      match_session_id: "verify-profile-b-match",
      phase: { stage_round: "3-3", status: 1 },
      economy: { hp: 79, gold: 32, level: 6, xp: { value: 8, to_next: 20 } },
      board: { board_units: [{ id: 11452, base_id: 1452, name: "Profile B unit", star: 2, cost: 2 }] },
      bench: { bench_units: [] },
      shop: { shop_units: [] },
      items: { item_bench: [], equipped_items: [] },
    }, null, 2)}\n`, "utf8");

    const result = await runPipeline({
      liveState: liveStateFile,
      adviceState: adviceStateFile,
      mode: "cruise",
      userMessage: "请判断当前节奏。",
      forceResponseReason: "verify_profile_binding",
      liveRankings: path.join(repoRoot, "data/live-rankings/jcc/current/rank-signal.json"),
      now: "2026-08-21T10:00:00.000Z",
    });

    assert.equal(result.core_profile_id, candidate.core_profile_id, "pipeline result must remain bound to Profile B");
    assert.equal(result.estimator_context?.core_profile_id, candidate.core_profile_id, "combat estimator must use Profile B");
    assert.equal(
      result.estimator_context?.context?.hard_data_context?.source_core_profile_id,
      candidate.core_profile_id,
      "combat hard-data context must carry Profile B identity",
    );
    assert.equal(
      result.estimator_context?.context?.hard_data_context?.source_hard_data_manifest,
      hardDataManifest,
      "combat estimator must use Profile B hard-data manifest",
    );
    assert.equal(
      result.estimator_context?.context?.combat_cap_estimator?.lineup_lifecycle?.core_profile_id,
      candidate.core_profile_id,
      "combat lifecycle must use Profile B",
    );
    assert.equal(
      result.estimator_context?.context?.combat_cap_estimator?.economy_leveling?.lineup_lifecycle?.core_profile_id,
      candidate.core_profile_id,
      "economy lifecycle nested in combat context must use Profile B",
    );
    assert.equal(
      result.estimator_context?.rules_source_fingerprint,
      profileBRules.source_fingerprint,
      "combat estimator must use Profile B rules fingerprint",
    );

    const hostRequests = result.response_events
      .map((event) => event.host_cli_agent_request)
      .filter(Boolean);
    assert(hostRequests.length > 0, "forced user turn must produce one Host request");
    for (const request of hostRequests) {
      assert.equal(
        request.context?.cruise_decision_context?.lineup_lifecycle?.core_profile_id,
        candidate.core_profile_id,
        "Host cruise lifecycle must use Profile B",
      );
      assert.equal(
        request.context?.estimator?.lineup_lifecycle?.core_profile_id,
        candidate.core_profile_id,
        "Host estimator lifecycle must use Profile B",
      );
    }

    console.log(JSON.stringify({
      ok: true,
      profile_a: activePaths.activeCoreProfileId,
      profile_b: candidate.core_profile_id,
      checked: [
        "daemon initialized under A",
        "mixed A paths and B rules failed closed without partial adoption",
        "Start Match adopted B",
        "downstream modules have no module-initialized active Profile singleton",
        "combat hard-data manifest remained B",
        "combat and economy lifecycle contexts remained B",
        "Host cruise lifecycle remained B",
      ],
    }, null, 2));
  } finally {
    configureCruiseRuntimeProfile({ nextRuntimePaths: activePaths, rulesBundle: activeRules });
    await rm(packageDir, { recursive: true, force: true });
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
