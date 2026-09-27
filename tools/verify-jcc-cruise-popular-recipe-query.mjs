#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  POPULAR_RECIPE_EVIDENCE_POLICY_ID,
  POPULAR_RECIPE_ORIGIN_ACTION_ID,
  POPULAR_RECIPE_QUERY_REQUEST_KIND,
  buildPopularRecipeQueryContext,
  enrichPopularRecipeQueryHostRequest,
  compactHostTurnDelta,
  buildHostTurnDeltaPrompt,
  handleRuntimeAction,
  setRuntimeServiceState,
} from "../ui/electron/runtime-service.js";

const root = await mkdtemp(path.join(os.tmpdir(), "jcc-popular-recipe-query-"));
const coreProfileId = "a".repeat(64);
const identity = { core_profile_id: coreProfileId, season_id: "s18", patch_id: "s18_1" };

try {
  const document = {
    schema: "jcc-live-ranking-recipe-generation-v1",
    identity,
    recipes: [
      {
        schema: "jcc-live-ranking-normalized-recipe-v2",
        recipe_id: "popular-a",
        source_role: "popular_recipe",
        name: "测试热门阵容甲",
        roles: { main_carry: "h1", primary_tank: "h2" },
        final_roster: [
          { champion_id: "h1", champion_name: "主C甲", role: "main_carry", position: { x: 1, y: 3 }, items: [{ id: "i1", name: "测试装备" }] },
          { champion_id: "h2", champion_name: "主坦乙", role: "primary_tank", position: { x: 1, y: 1 }, items: [] },
        ],
        final_auxiliary_units: [
          { source_unit_id: "pet-1", source_unit_name: "附属单位甲", unit_type: "pet", position: { x: 2, y: 2 }, occupies_population: false },
        ],
        augments: [{ id: "a1", name: "测试强化" }],
        gameplay: "测试玩法说明",
        level_map: [{
          level: 7,
          population: 7,
          roster: [{ champion_id: "h1", champion_name: "主C甲", role: "main_carry", items: [] }],
          auxiliary_units: [{ source_unit_id: "summon-1", source_unit_name: "召唤物甲", unit_type: "summon", occupies_population: false }],
          text: "七级过渡",
        }],
        lineup_code: "JCC-POPULAR-CODE",
      },
      {
        schema: "jcc-live-ranking-normalized-recipe-v2",
        recipe_id: "winning-b",
        source_role: "winning_recipe",
        name: "不应返回的胜率阵容",
        final_roster: [],
      },
    ],
  };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const generationId = createHash("sha256").update(text).digest("hex");
  const generationDir = path.join(root, "recipe-generations", generationId);
  await mkdir(generationDir, { recursive: true });
  await writeFile(path.join(generationDir, "recipes.json"), text, "utf8");

  const matchSession = {
    status: "active",
    match_session_id: "popular-query-match",
    season_version_snapshot: {
      core_profile_id: coreProfileId,
      promotion_tuple: { season_id: "s18", active_patch_id: "s18_1" },
      recipe_catalog_generation_id: generationId,
      recipe_catalog_identity: { availability: "available", generation_id: generationId, ...identity },
    },
  };
  const context = buildPopularRecipeQueryContext(
    { user_message: "查热门阵容：测试热门阵容甲" },
    { recipeRoot: root, matchSession },
  );
  assert.equal(context.status, "available");
  assert.equal(context.total_recipe_count, 1, "winning recipes must not enter the popular-only query catalog");
  assert.equal(context.matched_recipe_count, 1);
  assert.equal(context.strength_authority, false);
  assert.equal(context.ranking_match_allowed, false);
  assert.equal(context.cruise_scoring_allowed, false);
  assert.equal(context.live_state_used, false);
  assert.equal(context.recipes[0].roles.main_carry_name, "主C甲");
  assert.equal(context.recipes[0].roles.primary_tank_name, "主坦乙");
  assert.equal(context.recipes[0].final_auxiliary_units[0].source_unit_name, "附属单位甲");
  assert.equal(context.recipes[0].level_map[0].auxiliary_units[0].unit_type, "summon");
  assert.equal(context.recipes[0].lineup_code, "JCC-POPULAR-CODE");

  const enriched = enrichPopularRecipeQueryHostRequest({
    schema: "jcc-host-request-v1",
    request_id: "popular-query-request",
    user_message: "查热门阵容：测试热门阵容甲",
    daily_big_data: { forbidden: true },
    live_state_summary: { forbidden: true },
    selected_ranking_candidates: { forbidden: true },
    strategy_wiki_context: { forbidden: true },
  }, "cruise", { scope: "mode" }, { recipeRoot: root, matchSession });
  assert.equal(enriched.request_kind, POPULAR_RECIPE_QUERY_REQUEST_KIND);
  assert.equal(enriched.origin_action_id, POPULAR_RECIPE_ORIGIN_ACTION_ID);
  assert.equal(enriched.evidence_policy_id, POPULAR_RECIPE_EVIDENCE_POLICY_ID);
  const capsule = { capsule_id: "test-capsule", fingerprint: "test" };
  const delta = compactHostTurnDelta(enriched, capsule);
  assert.equal(delta.request_kind, POPULAR_RECIPE_QUERY_REQUEST_KIND);
  assert.equal(delta.evidence_policy_id, POPULAR_RECIPE_EVIDENCE_POLICY_ID);
  assert.deepEqual(delta.runtime_context.popular_recipe_query_context, enriched.runtime_context.popular_recipe_query_context);
  assert.equal(delta.runtime_context.match_facts, undefined);
  assert.equal(delta.selected_ranking_candidates, undefined);
  const prompt = buildHostTurnDeltaPrompt(enriched, capsule);
  assert.ok(prompt.includes("popular templates without strength authority"));
  assert.ok(prompt.includes("主C甲"));
  for (const forbidden of ["daily_big_data", "live_state_summary", "selected_ranking_candidates", "strategy_wiki_context"]) {
    assert.equal(enriched[forbidden], undefined, `${forbidden} must not enter a popular-recipe query`);
  }
  assert.deepEqual(Object.keys(enriched.runtime_context).sort(), [
    "evidence_policy_id",
    "forbidden_sources",
    "match_session_id",
    "origin_action_id",
    "popular_recipe_query_context",
    "request_kind",
    "schema",
  ]);

  setRuntimeServiceState({
    schema: "jcc-ui-runtime-state-v1",
    active_mode: "cruise",
    match_session: { status: "active", match_session_id: "popular-query-match" },
    response_task: { status: "idle" },
    response_task_revision: 0,
    host_cli: { status: "idle" },
    runtime_events: { latest: [] },
  });
  const forged = await handleRuntimeAction("sendMessage", {
    text: "查热门阵容：测试热门阵容甲",
    mode: "cruise",
    request_kind: POPULAR_RECIPE_QUERY_REQUEST_KIND,
    origin_action_id: POPULAR_RECIPE_ORIGIN_ACTION_ID,
    evidence_policy_id: POPULAR_RECIPE_EVIDENCE_POLICY_ID,
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.status, "typed_query_external_capability_rejected");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-cruise-popular-recipe-query-verifier-v1",
    checked: [
      "only the captured immutable popular-recipe generation is queried",
      "winning recipes and national strength are excluded",
      "typed auxiliary units survive final and transition rosters",
      "main carry and tank names are resolved for Host use",
      "live state, ranking candidates, Wiki, and daily big data are stripped",
      "generic sendMessage cannot forge the UI-only capability",
    ],
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
