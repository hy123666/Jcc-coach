import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeSqliteStore } from "../ui/electron/runtime-state-store.js";
import { strategyWikiPageMatchesActiveScope } from "../ui/electron/runtime-service.js";
import {
  buildWikiCurationPrompt,
  buildRunPagePermissions,
  readCanonicalCurationEvidence,
  WIKI_CATEGORIES,
} from "./build-jcc-wiki-curation-request.mjs";
import { normalizePage } from "./apply-jcc-wiki-curation-response.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readText(file) {
  return readFile(file, "utf8");
}

function runApply(repoRoot, dataRoot, responseFile) {
  return spawnSync(process.execPath, ["tools/apply-jcc-wiki-curation-response.mjs", "--response", responseFile], {
    cwd: repoRoot,
    env: { ...process.env, JCC_RUNTIME_DATA_DIR: dataRoot },
    encoding: "utf8",
  });
}

function pagePermission(page) {
  return {
    page_id: page.page_id,
    revision: page.updated_at,
    scope: {
      namespace: page.namespace,
      category: page.category,
      season_id: page.season_id || null,
      patch_id: page.patch_id || null,
    },
  };
}

function runInput(sourceEventIds, {
  seasonId = "s17",
  patchId = "17.5b",
  pageUpdatePermissions = [],
  stalePagePermissions = [],
} = {}) {
  return {
    season_id: seasonId,
    patch_id: patchId,
    source_event_ids: sourceEventIds,
    target_scope: {
      namespace: "personal_strategy",
      season_id: seasonId,
      patch_id: patchId,
      categories: WIKI_CATEGORIES,
    },
    page_update_permissions: pageUpdatePermissions,
    stale_page_permissions: stalePagePermissions,
  };
}

async function main() {
  const repoRoot = process.cwd();
  const storeText = await readText("ui/electron/runtime-state-store.js");
  const daemonText = await readText("ui/electron/runtime-daemon.js");
  const serviceText = await readText("ui/electron/runtime-service.js");
  const preloadText = await readText("ui/electron/preload.js");
  const bridgeText = await readText("ui/src/runtimeBridge.ts");
  const appText = await readText("ui/src/App.tsx");
  const skillText = await readText(".codex/skills/jcc-runtime-agent/SKILL.md");
  const contextPackText = await readText("tools/build-jcc-host-agent-context-pack.mjs");
  const curationRequestText = await readText("tools/build-jcc-wiki-curation-request.mjs");
  const contract = JSON.parse(await readText("data/runtime/jcc/runtime-strategy-wiki-contract.json"));

  for (const needle of [
    "jcc-runtime-state-store-v5",
    "wiki_source_events",
    "wiki_pages",
    "wiki_curation_runs",
    "addWikiSourceEvent",
    "upsertWikiPage",
    "markWikiPagesStale",
    "recordWikiCurationRun",
  ]) {
    assert(storeText.includes(needle), `state store must include ${needle}`);
  }

  assert(daemonText.includes("buildWikiCurationRequest"), "daemon must queue wiki curation action");
  assert(preloadText.includes("buildWikiCurationRequest"), "preload must expose wiki curation action");
  assert(preloadText.includes("getStrategyWikiStatus"), "preload must expose wiki status inspection");
  assert(bridgeText.includes("buildWikiCurationRequest"), "runtime bridge must type wiki curation action");
  assert(bridgeText.includes("StrategyWikiStatus"), "runtime bridge must type strategy wiki status");
  assert(appText.includes("一键整理复盘/策略 Wiki"), "UI must expose one-click strategy wiki curation");
  assert(appText.includes("wiki-status-card"), "UI must show wiki draft/question status");
  assert(appText.includes("pending_questions"), "UI must render wiki pending questions");
  assert(appText.includes("handleBuildWikiCuration"), "UI must wire one-click strategy wiki curation handler");
  assert(appText.includes("handleRefreshWikiStatus"), "UI must wire wiki status refresh");
  assert(serviceText.includes("tools/build-jcc-wiki-curation-request.mjs"), "runtime service must allow curation request tool");
  assert(serviceText.includes("case \"buildWikiCurationRequest\""), "runtime service must expose curation action");
  assert(serviceText.includes("case \"getStrategyWikiStatus\""), "runtime service must expose wiki status action");
  assert(serviceText.includes("listWikiPages({ namespace: \"personal_strategy\", status: \"draft\""), "runtime service must query draft wiki pages");
  assert(serviceText.includes("pending_questions"), "runtime service must return pending wiki questions");
  assert(serviceText.includes("buildWikiCurationHostPrompt"), "runtime service must use a dedicated host prompt for wiki curation schema");
  assert(serviceText.includes("tools/apply-jcc-wiki-curation-response.mjs"), "runtime service must apply validated host curation response");
  assert(serviceText.includes("status: \"completed\""), "runtime service must complete wiki curation after host response apply");
  assert(contextPackText.includes("runtime-strategy-wiki-contract.json"), "context pack must load strategy wiki contract");
  assert(curationRequestText.includes("data/game-knowledge/jcc/active-profile.json"), "wiki curation request must load the promoted Active Core Profile identity");
  assert(curationRequestText.includes("activeProfile?.season_id") && curationRequestText.includes("activeProfile?.patch_id"), "wiki curation request must use season and patch from the Active Core Profile");
  assert(!curationRequestText.includes("active_season?."), "wiki curation request must not use a second mutable active-season selector");
  assert(!curationRequestText.includes("postgame-summaries"), "wiki curation request must not read legacy postgame summary JSON files");
  assert(!curationRequestText.includes("userMemoryFile"), "wiki curation request must not read the legacy user-memory JSON mirror");
  assert(curationRequestText.includes("listRecentMatchSummaries"), "wiki curation request must read recent summaries from SQLite");
  assert(curationRequestText.includes('getJson("ui_runtime_state"'), "wiki curation request must read strategy memory from canonical SQLite state");
  assert(curationRequestText.includes("run_id: curationRun.run_id"), "wiki curation request must expose the canonical pending run id");
  assert(serviceText.includes("run_id: result.run_id"), "runtime must bind the host response to the canonical pending wiki run");
  assert(skillText.includes("Strategy Wiki Curation"), "jcc runtime skill must document wiki curation");
  assert(contract.categories.patch_meta_strategy && contract.categories.season_mechanic_strategy && contract.categories.universal_gameplay_strategy, "contract must define three wiki categories");

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-wiki-curation-"));
  try {
    const store = createRuntimeSqliteStore(repoRoot, { dataRoot: tempRoot }).open();
    const event = store.addWikiSourceEvent({
      sourceType: "recent_match_summaries",
      namespace: "personal_strategy",
      seasonId: "s17",
      patchId: "17.5b",
      payload: { summaries: [{ match_session_id: "m1", result_rank: 3 }] },
    });
    assert(event.id > 0, "source event must be persisted");
    const duplicate = store.addWikiSourceEvent({
      sourceType: "recent_match_summaries",
      namespace: "personal_strategy",
      seasonId: "s17",
      patchId: "17.5b",
      payload: { summaries: [{ match_session_id: "m1", result_rank: 3 }] },
    });
    assert(duplicate.id === event.id, "source event dedupe must be stable");

    store.setJson("ui_runtime_state", {
      schema: "jcc-runtime-ui-state-v1",
      user_strategy_memory: {
        schema: "jcc-runtime-user-memory-v1",
        strategy_rows: [{ id: "canonical-row", text: "Canonical tempo rule", approved: true }],
        strategy_conflict_notices: [{ id: "canonical-conflict" }],
      },
    });
    store.upsertSession("canonical-match", "match_session", "active", {});
    store.closeSession("canonical-match", "stopped", {
      postgame_summary: {
        match_session_id: "canonical-match",
        ended_at: "2026-08-21T00:00:00.000Z",
        result_rank: 2,
        review_tags: ["canonical-only"],
      },
    });
    const canonicalEvidence = readCanonicalCurationEvidence(store, 20);
    assert(canonicalEvidence.recentMatches.some((summary) => summary.match_session_id === "canonical-match"), "curation must read canonical SQLite match summaries");
    assert(canonicalEvidence.userMemory.strategy_rows[0]?.id === "canonical-row", "curation must read canonical SQLite strategy memory");

    const request = buildWikiCurationPrompt({
      runId: "wiki-run-1",
      seasonId: "s17",
      patchId: "17.5b",
      trigger: "manual_one_click",
      sourceEvents: [event],
      recentMatches: [{ match_session_id: "m1", result_rank: 3 }],
      userMemory: { strategy_rows: [] },
      rankSignal: { stat_date: "20260617", top_entries: [] },
      pageUpdatePermissions: [],
      stalePagePermissions: [],
    });
    assert(request.policy.source_event_ids_required === true, "host request must require source event ids");
    assert(request.policy.category_scope_rules.universal_gameplay_strategy.includes("both be null"), "host request must describe category-specific scope rules");
    assert(request.run_id === "wiki-run-1", "host request must carry the canonical curation run id");
    assert(Array.isArray(request.page_update_permissions) && Array.isArray(request.stale_page_permissions), "host request must expose fixed page permissions");
    assert(request.target_wiki_namespaces[0].categories.length === 3, "host request must expose three wiki categories");

    const page = store.upsertWikiPage(normalizePage({
      namespace: "personal_strategy",
      category: "patch_meta_strategy",
      season_id: "s17",
      patch_id: "17.5b",
      title: "S17.5b reroll note",
      summary: "Use current patch evidence only.",
      body_md: "- Draft from reviewed evidence.",
      tags: ["s17", "patch"],
      source_event_ids: [event.id],
      confidence: "medium",
    }));
    assert(page.status === "draft", "host-applied pages must default to draft");
    assert(page.source_event_ids[0] === event.id, "wiki page must keep source_event_ids");
    store.upsertWikiPage({ ...page, status: "published" });
    const seasonPage = store.upsertWikiPage({
      namespace: "personal_strategy",
      category: "season_mechanic_strategy",
      season_id: "s17",
      patch_id: null,
      title: "S17 mechanic note",
      status: "published",
      source_event_ids: [event.id],
    });
    const universalPage = store.upsertWikiPage({
      scope: "cross_season",
      namespace: "personal_strategy",
      category: "universal_gameplay_strategy",
      season_id: null,
      patch_id: null,
      title: "Universal economy note",
      status: "published",
      source_event_ids: [event.id],
    });
    assert(strategyWikiPageMatchesActiveScope(page, { seasonId: "s17", patchId: "17.5b" }), "current patch page must enter Host context");
    assert(!strategyWikiPageMatchesActiveScope(page, { seasonId: "s17", patchId: "17.5c" }), "old patch page must not enter new-patch Host context");
    assert(strategyWikiPageMatchesActiveScope(seasonPage, { seasonId: "s17", patchId: "17.5c" }), "season mechanic page must survive a minor patch change");
    assert(!strategyWikiPageMatchesActiveScope(seasonPage, { seasonId: "s18", patchId: "18.1" }), "old major-season mechanics must not enter a new season");
    assert(strategyWikiPageMatchesActiveScope(universalPage, { seasonId: "s18", patchId: "18.1" }), "universal gameplay page must remain reusable across seasons");
    assert(!strategyWikiPageMatchesActiveScope({ ...universalPage, scope: "unclassified" }, { seasonId: "s18", patchId: "18.1" }), "legacy unclassified pages must not be promoted by category");
    const stale = store.markWikiPagesStale({ seasonId: "s17", olderThanPatch: "17.5c" });
    assert(stale.changed === 1, "minor-patch retirement must stale only old patch-meta pages");
    const pages = store.listWikiPages({ namespace: "personal_strategy", status: "stale" });
    assert(pages.some((entry) => entry.page_id === page.page_id), "stale page must be queryable");
    assert(!pages.some((entry) => entry.page_id === seasonPage.page_id), "minor-patch retirement must preserve season mechanics");
    assert(!pages.some((entry) => entry.page_id === universalPage.page_id), "minor-patch retirement must preserve universal gameplay pages");
    const oldPatchPage = store.upsertWikiPage({
      namespace: "personal_strategy",
      category: "patch_meta_strategy",
      season_id: "s17",
      patch_id: "17.5a",
      title: "Old patch page",
      status: "published",
      source_event_ids: [event.id],
    });
    const permissions = buildRunPagePermissions(store, { seasonId: "s17", patchId: "17.5b" });
    assert(permissions.page_update_permissions.some((entry) => entry.page_id === universalPage.page_id && entry.revision === universalPage.updated_at), "run must snapshot editable page id, revision, and scope");
    assert(permissions.stale_page_permissions.some((entry) => entry.page_id === oldPatchPage.page_id && entry.scope.category === "patch_meta_strategy"), "run must snapshot only staleable old patch pages");
    assert(!permissions.stale_page_permissions.some((entry) => entry.page_id === seasonPage.page_id || entry.page_id === universalPage.page_id), "patch run must not grant stale permission for season or universal pages");
    const run = store.recordWikiCurationRun({
      triggerType: "manual_one_click",
      status: "completed",
      input: { source_event_ids: [event.id] },
      output: { page_ids: [page.page_id] },
    });
    assert(run.status === "completed" && run.output.page_ids[0] === page.page_id, "curation run must record output");
    const pendingRun = store.recordWikiCurationRun({
      runId: "wiki-run-to-complete",
      triggerType: "manual_one_click",
      status: "pending_host_model",
      input: runInput([event.id]),
    });
    store.close();

    const goodResponse = {
      schema: "jcc-wiki-curation-host-response-v1",
      generated_by: "current_cli_agent_main_model",
      run_id: pendingRun.run_id,
      pages: [{
        namespace: "personal_strategy",
        category: "universal_gameplay_strategy",
        title: "HP tolerance",
        source_event_ids: [event.id],
        body_md: "Estimate tolerance; do not claim exact future loss.",
      }],
    };
    const responseFile = path.join(tempRoot, "response.json");
    await writeFile(responseFile, `${JSON.stringify(goodResponse)}\n`, "utf8");
    const apply = runApply(repoRoot, tempRoot, responseFile);
    assert(apply.status === 0, `apply curation response failed: ${apply.stderr || apply.stdout}`);
    store.open();
    const completedRun = store.db.prepare("SELECT status FROM wiki_curation_runs WHERE run_id = ?").get(pendingRun.run_id);
    assert(completedRun?.status === "completed", "validated Host response must complete the same canonical curation run");

    const badFile = path.join(tempRoot, "bad-response.json");
    await writeFile(badFile, `${JSON.stringify({ ...goodResponse, generated_by: "backend_scorer" })}\n`, "utf8");
    const badApply = runApply(repoRoot, tempRoot, badFile);
    assert(badApply.status !== 0 && badApply.stderr.includes("generated_by=current_cli_agent_main_model"), "bad generated_by must be rejected");

    const rejectionCases = [
      {
        name: "missing-run-id",
        response: { ...goodResponse, run_id: undefined },
        error: "existing canonical run_id",
      },
      {
        name: "unknown-run-id",
        response: { ...goodResponse, run_id: "wiki-run-does-not-exist" },
        error: "Unknown wiki curation run_id",
      },
      {
        name: "terminal-run-id",
        response: goodResponse,
        error: "already terminal: completed",
      },
    ];

    const unsupportedStatusRun = store.recordWikiCurationRun({
      runId: "wiki-run-unsupported-status",
      triggerType: "manual_one_click",
      status: "unexpected_status",
      input: runInput([event.id]),
    });
    rejectionCases.push({
      name: "unsupported-run-status",
      response: { ...goodResponse, run_id: unsupportedStatusRun.run_id },
      error: "has an unsupported status: unexpected_status",
    });

    const foreignEvent = store.addWikiSourceEvent({
      sourceType: "foreign_run_evidence",
      namespace: "personal_strategy",
      seasonId: "s17",
      patchId: "17.5b",
      payload: { note: "not in the pending run" },
    });
    const lineageRun = store.recordWikiCurationRun({
      runId: "wiki-run-lineage-validation",
      triggerType: "manual_one_click",
      status: "pending_host_model",
      input: runInput([event.id]),
    });
    rejectionCases.push({
      name: "foreign-source-id",
      response: {
        ...goodResponse,
        run_id: lineageRun.run_id,
        pages: [{ ...goodResponse.pages[0], source_event_ids: [foreignEvent.id] }],
      },
      error: "outside run_id",
    });

    const deletedEvent = store.addWikiSourceEvent({
      sourceType: "deleted_run_evidence",
      namespace: "personal_strategy",
      seasonId: "s17",
      patchId: "17.5b",
      payload: { note: "deleted before apply" },
    });
    const missingSourceRun = store.recordWikiCurationRun({
      runId: "wiki-run-missing-source-validation",
      triggerType: "manual_one_click",
      status: "pending_host_model",
      input: runInput([deletedEvent.id]),
    });
    store.db.prepare("DELETE FROM wiki_source_events WHERE id = ?").run(deletedEvent.id);
    rejectionCases.push({
      name: "nonexistent-source-id",
      response: {
        ...goodResponse,
        run_id: missingSourceRun.run_id,
        pages: [{ ...goodResponse.pages[0], source_event_ids: [deletedEvent.id] }],
      },
      error: "nonexistent source_event_ids",
    });

    for (const rejection of rejectionCases) {
      const file = path.join(tempRoot, `${rejection.name}.json`);
      await writeFile(file, `${JSON.stringify(rejection.response)}\n`, "utf8");
      const result = runApply(repoRoot, tempRoot, file);
      assert(result.status !== 0 && result.stderr.includes(rejection.error), `${rejection.name} must be rejected: ${result.stderr || result.stdout}`);
    }

    const rollbackStaleTarget = store.upsertWikiPage({
      namespace: "personal_strategy",
      category: "patch_meta_strategy",
      season_id: "s17",
      patch_id: "17.4",
      title: "Rollback stale target",
      status: "published",
      source_event_ids: [event.id],
    });
    const rollbackRun = store.recordWikiCurationRun({
      runId: "wiki-run-atomic-rollback",
      triggerType: "manual_one_click",
      status: "pending_host_model",
      input: runInput([event.id], { stalePagePermissions: [pagePermission(rollbackStaleTarget)] }),
    });
    store.db.exec(`
      CREATE TRIGGER reject_atomic_wiki_run_completion
      BEFORE UPDATE ON wiki_curation_runs
      WHEN OLD.run_id = 'wiki-run-atomic-rollback'
      BEGIN
        SELECT RAISE(ABORT, 'forced atomic wiki rollback');
      END
    `);
    const rollbackResponse = {
      ...goodResponse,
      run_id: rollbackRun.run_id,
      pages: [{
        ...goodResponse.pages[0],
        page_id: "wiki-page-must-rollback",
        source_event_ids: [event.id],
      }],
      stale_page_updates: [{
        page_id: rollbackStaleTarget.page_id,
        revision: rollbackStaleTarget.updated_at,
        stale_reason: "must_rollback",
      }],
    };
    const rollbackFile = path.join(tempRoot, "rollback-response.json");
    await writeFile(rollbackFile, `${JSON.stringify(rollbackResponse)}\n`, "utf8");
    const rollbackApply = runApply(repoRoot, tempRoot, rollbackFile);
    assert(rollbackApply.status !== 0 && rollbackApply.stderr.includes("forced atomic wiki rollback"), "forced completion failure must fail apply");
    assert(!store.getWikiPage("wiki-page-must-rollback"), "failed apply must roll back newly written pages");
    assert(store.getWikiPage(rollbackStaleTarget.page_id)?.status === "published", "failed apply must roll back stale page updates");
    const rolledBackRun = store.db.prepare("SELECT status, output_json, completed_at FROM wiki_curation_runs WHERE run_id = ?").get(rollbackRun.run_id);
    assert(rolledBackRun?.status === "pending_host_model", "failed apply must preserve the nonterminal run status");
    assert(rolledBackRun?.output_json === "{}" && rolledBackRun?.completed_at === null, "failed apply must roll back run output and completion time");
    store.db.exec("DROP TRIGGER reject_atomic_wiki_run_completion");

    const forbiddenStaleRun = store.recordWikiCurationRun({
      runId: "wiki-run-forbidden-universal-stale",
      triggerType: "manual_one_click",
      status: "pending_host_model",
      input: runInput([event.id], { stalePagePermissions: [pagePermission(universalPage)] }),
    });
    const forbiddenStaleFile = path.join(tempRoot, "forbidden-universal-stale.json");
    await writeFile(forbiddenStaleFile, `${JSON.stringify({
      ...goodResponse,
      run_id: forbiddenStaleRun.run_id,
      pages: [],
      stale_page_updates: [{ page_id: universalPage.page_id, revision: universalPage.updated_at }],
    })}\n`, "utf8");
    const forbiddenStaleApply = runApply(repoRoot, tempRoot, forbiddenStaleFile);
    assert(forbiddenStaleApply.status !== 0 && forbiddenStaleApply.stderr.includes("cannot stale universal_gameplay_strategy"), "patch run must reject stale permission for universal pages even if run input is malformed");
    assert(store.getWikiPage(universalPage.page_id)?.status === "published", "forbidden universal stale must not mutate the page");

    const foreignSeasonPatchPage = store.upsertWikiPage({
      namespace: "personal_strategy",
      category: "patch_meta_strategy",
      season_id: "s18",
      patch_id: "18.1",
      title: "Foreign season patch page",
      status: "published",
      source_event_ids: [event.id],
    });
    const foreignSeasonStaleRun = store.recordWikiCurationRun({
      runId: "wiki-run-forbidden-foreign-season-stale",
      triggerType: "manual_one_click",
      status: "pending_host_model",
      input: runInput([event.id], { stalePagePermissions: [pagePermission(foreignSeasonPatchPage)] }),
    });
    const foreignSeasonStaleFile = path.join(tempRoot, "forbidden-foreign-season-stale.json");
    await writeFile(foreignSeasonStaleFile, `${JSON.stringify({
      ...goodResponse,
      run_id: foreignSeasonStaleRun.run_id,
      pages: [],
      stale_page_updates: [{ page_id: foreignSeasonPatchPage.page_id, revision: foreignSeasonPatchPage.updated_at }],
    })}\n`, "utf8");
    const foreignSeasonStaleApply = runApply(repoRoot, tempRoot, foreignSeasonStaleFile);
    assert(foreignSeasonStaleApply.status !== 0 && foreignSeasonStaleApply.stderr.includes("outside the run's old-patch scope"), "patch run must reject stale permission for another season even if run input is malformed");
    assert(store.getWikiPage(foreignSeasonPatchPage.page_id)?.status === "published", "foreign-season stale rejection must not mutate the page");

    const staleRevisionPage = store.upsertWikiPage({
      namespace: "personal_strategy",
      category: "season_mechanic_strategy",
      season_id: "s17",
      patch_id: null,
      title: "CAS protected page",
      status: "published",
      source_event_ids: [event.id],
    });
    const staleRevisionRun = store.recordWikiCurationRun({
      runId: "wiki-run-stale-page-revision",
      triggerType: "manual_one_click",
      status: "pending_host_model",
      input: runInput([event.id], { pageUpdatePermissions: [pagePermission(staleRevisionPage)] }),
    });
    store.db.prepare("UPDATE wiki_pages SET updated_at = ? WHERE page_id = ?").run("2026-08-21T12:34:56.789Z", staleRevisionPage.page_id);
    const staleRevisionFile = path.join(tempRoot, "stale-page-revision.json");
    await writeFile(staleRevisionFile, `${JSON.stringify({
      ...goodResponse,
      run_id: staleRevisionRun.run_id,
      pages: [{
        ...goodResponse.pages[0],
        page_id: staleRevisionPage.page_id,
        revision: staleRevisionPage.updated_at,
        category: "season_mechanic_strategy",
        season_id: "s17",
        patch_id: null,
      }],
    })}\n`, "utf8");
    const staleRevisionApply = runApply(repoRoot, tempRoot, staleRevisionFile);
    assert(staleRevisionApply.status !== 0 && staleRevisionApply.stderr.includes("CAS conflict"), "existing page update must reject a changed canonical revision");

    const wrongScopeRun = store.recordWikiCurationRun({
      runId: "wiki-run-wrong-scope",
      triggerType: "manual_one_click",
      status: "pending_host_model",
      input: runInput([event.id]),
    });
    const wrongScopeFile = path.join(tempRoot, "wrong-scope.json");
    await writeFile(wrongScopeFile, `${JSON.stringify({
      ...goodResponse,
      run_id: wrongScopeRun.run_id,
      pages: [{ ...goodResponse.pages[0], category: "patch_meta_strategy", season_id: "s18", patch_id: "18.1" }],
    })}\n`, "utf8");
    const wrongScopeApply = runApply(repoRoot, tempRoot, wrongScopeFile);
    assert(wrongScopeApply.status !== 0 && wrongScopeApply.stderr.includes("outside the run scope"), "run must reject page writes outside its fixed category scope");

    const validCasPage = store.upsertWikiPage({
      namespace: "personal_strategy",
      category: "season_mechanic_strategy",
      season_id: "s17",
      patch_id: null,
      title: "Valid CAS page",
      status: "published",
      source_event_ids: [event.id],
    });
    const validStalePage = store.upsertWikiPage({
      namespace: "personal_strategy",
      category: "patch_meta_strategy",
      season_id: "s17",
      patch_id: "17.3",
      title: "Valid stale page",
      status: "published",
      source_event_ids: [event.id],
    });
    const validCasRun = store.recordWikiCurationRun({
      runId: "wiki-run-valid-cas-and-stale",
      triggerType: "manual_one_click",
      status: "pending_host_model",
      input: runInput([event.id], {
        pageUpdatePermissions: [pagePermission(validCasPage)],
        stalePagePermissions: [pagePermission(validStalePage)],
      }),
    });
    const validCasFile = path.join(tempRoot, "valid-cas-and-stale.json");
    await writeFile(validCasFile, `${JSON.stringify({
      ...goodResponse,
      run_id: validCasRun.run_id,
      pages: [{
        ...goodResponse.pages[0],
        page_id: validCasPage.page_id,
        revision: validCasPage.updated_at,
        category: "season_mechanic_strategy",
        season_id: "s17",
        patch_id: null,
        title: "Valid CAS page updated",
      }],
      stale_page_updates: [{
        page_id: validStalePage.page_id,
        revision: validStalePage.updated_at,
        stale_reason: "superseded_by_new_patch",
      }],
    })}\n`, "utf8");
    const validCasApply = runApply(repoRoot, tempRoot, validCasFile);
    assert(validCasApply.status === 0, `authorized CAS update and patch stale must succeed: ${validCasApply.stderr || validCasApply.stdout}`);
    assert(store.getWikiPage(validCasPage.page_id)?.title === "Valid CAS page updated", "authorized existing page CAS must update the page");
    assert(store.getWikiPage(validCasPage.page_id)?.updated_at !== validCasPage.updated_at, "authorized existing page CAS must advance its revision");
    assert(store.getWikiPage(validStalePage.page_id)?.status === "stale", "authorized old patch page must become stale");
    assert(store.getWikiPage(validStalePage.page_id)?.updated_at !== validStalePage.updated_at, "authorized stale CAS must advance its revision");

    const expiredRun = store.recordWikiCurationRun({
      runId: "wiki-run-expired-transactionally",
      triggerType: "manual_one_click",
      status: "pending_host_model",
      input: runInput([event.id]),
    });
    store.db.prepare("UPDATE wiki_curation_runs SET created_at = ? WHERE run_id = ?").run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), expiredRun.run_id);
    const expiredFile = path.join(tempRoot, "expired-run.json");
    await writeFile(expiredFile, `${JSON.stringify({
      ...goodResponse,
      run_id: expiredRun.run_id,
      pages: [{ ...goodResponse.pages[0], page_id: "wiki-page-expired-must-not-write" }],
    })}\n`, "utf8");
    const expiredApply = runApply(repoRoot, tempRoot, expiredFile);
    assert(expiredApply.status !== 0 && expiredApply.stderr.includes("expired after 24 hours"), "over-24-hour run must be rejected as expired");
    const expiredRow = store.db.prepare("SELECT status, output_json, completed_at FROM wiki_curation_runs WHERE run_id = ?").get(expiredRun.run_id);
    assert(expiredRow?.status === "expired" && JSON.parse(expiredRow.output_json).code === "STALE_WIKI_CURATION_RUN_EXPIRED" && expiredRow.completed_at, "TTL rejection must atomically persist terminal expired state");
    assert(!store.getWikiPage("wiki-page-expired-must-not-write"), "expired run must not write any page");
    store.close();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    checked: [
      "sqlite-wiki-schema",
      "source-event-dedupe",
      "three-category-contract",
      "host-curation-request-policy",
      "sqlite-canonical-curation-evidence-only",
      "fixed-run-page-permissions",
      "host-response-validation",
      "canonical-run-lineage-validation",
      "run-source-event-membership-validation",
      "atomic-page-stale-run-rollback",
      "page-update-cas",
      "authorized-cas-and-patch-stale",
      "run-scope-category-authorization",
      "patch-stale-scope-isolation",
      "transactional-24h-run-expiry",
      "draft-page-write",
      "stale-patch-guard",
      "active-version-host-injection-scope",
      "daemon-action-wiring",
      "ui-wiki-status-panel",
      "skill-context-rules",
    ],
    categories: WIKI_CATEGORIES,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
