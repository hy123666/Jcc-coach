import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRuntimePaths, createRuntimeSqliteStore } from "../ui/electron/runtime-state-store.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const paths = createRuntimePaths(repoRoot);

const WIKI_CATEGORIES = [
  "patch_meta_strategy",
  "season_mechanic_strategy",
  "universal_gameplay_strategy",
];

function usage() {
  return [
    "Usage:",
    "  node tools/build-jcc-wiki-curation-request.mjs [--season-id <id>] [--patch-id <id>] [--trigger manual_one_click] [--limit <n>]",
    "",
    "Builds a host-model request for one-click JCC strategy wiki curation.",
    "It records immutable source events in app.sqlite and emits a structured request; it does not publish wiki pages by itself.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { trigger: "manual_one_click", limit: 20 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--season-id") options.seasonId = argv[++index];
    else if (arg === "--patch-id") options.patchId = argv[++index];
    else if (arg === "--trigger") options.trigger = argv[++index];
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJsonIfExists(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function compactRecentMatchSummaries(summaries) {
  return summaries.map((summary) => ({
      match_session_id: summary.match_session_id || null,
      ended_at: summary.ended_at || null,
      result_rank: summary.result_rank ?? null,
      target_plan_history: summary.target_plan_history || [],
      augment_choices: summary.augment_choices || [],
      economy_milestones: summary.economy_milestones || {},
      review_tags: summary.review_tags || [],
      advice_task_count: Array.isArray(summary.advice_tasks) ? summary.advice_tasks.length : 0,
      missed_information: summary.missed_information || [],
    }));
}

function compactRankSignal(signal) {
  if (!signal) return null;
  return {
    stat_date: signal.stat_date || null,
    battle_type: signal.battle_type || null,
    selected_rank_tier: signal.selected_rank_tier || null,
    top_entries: Array.isArray(signal.top_entries)
      ? signal.top_entries.slice(0, 12).map((entry) => ({
          display_name: entry.display_name || entry.readable_name || entry.name || null,
          avg_rank: entry.avg_rank ?? null,
          top4_rate: entry.top4_rate ?? null,
          win_rate: entry.win_rate ?? null,
          games: entry.games ?? null,
        }))
      : [],
  };
}

function compactUserMemory(memory) {
  return {
    strategy_rows: Array.isArray(memory?.strategy_rows)
      ? memory.strategy_rows
          .filter((row) => row && row.enabled !== false && row.approved !== false)
          .slice(-50)
          .map((row) => ({
            id: row.id || null,
            text: row.text || row.strategy || row.note || "",
            tags: row.tags || [],
            updated_at: row.updated_at || row.approved_at || null,
          }))
      : [],
    strategy_conflict_notices: Array.isArray(memory?.strategy_conflict_notices)
      ? memory.strategy_conflict_notices.slice(-20)
      : [],
  };
}

function pageScopeSnapshot(page) {
  return {
    namespace: page.namespace,
    category: page.category,
    season_id: page.season_id || null,
    patch_id: page.patch_id || null,
  };
}

function pagePermissionSnapshot(page) {
  return {
    page_id: page.page_id,
    revision: page.updated_at,
    scope: pageScopeSnapshot(page),
  };
}

function pageMatchesTargetScope(page, { seasonId, patchId }) {
  if (page.namespace !== "personal_strategy") return false;
  if (page.category === "patch_meta_strategy") {
    return page.season_id === seasonId && page.patch_id === patchId;
  }
  if (page.category === "season_mechanic_strategy") {
    return page.season_id === seasonId && !page.patch_id;
  }
  return page.category === "universal_gameplay_strategy" && !page.season_id && !page.patch_id;
}

function buildRunPagePermissions(store, { seasonId, patchId }) {
  const pages = store.db.prepare(`
    SELECT page_id, namespace, category, season_id, patch_id, status, updated_at
    FROM wiki_pages
    WHERE namespace = 'personal_strategy' AND status != 'archived'
    ORDER BY updated_at DESC
  `).all();
  return {
    page_update_permissions: pages
      .filter((page) => pageMatchesTargetScope(page, { seasonId, patchId }))
      .map(pagePermissionSnapshot),
    stale_page_permissions: pages
      .filter((page) => page.category === "patch_meta_strategy"
        && page.season_id === seasonId
        && page.patch_id
        && page.patch_id !== patchId
        && page.status === "published")
      .map(pagePermissionSnapshot),
  };
}

function readCanonicalCurationEvidence(store, limit) {
  const runtimeState = store.getJson("ui_runtime_state", {});
  return {
    recentMatches: compactRecentMatchSummaries(store.listRecentMatchSummaries(limit)),
    userMemory: compactUserMemory(runtimeState?.user_strategy_memory),
  };
}

function buildWikiCurationPrompt({
  runId,
  seasonId,
  patchId,
  trigger,
  sourceEvents,
  recentMatches,
  userMemory,
  rankSignal,
  pageUpdatePermissions = [],
  stalePagePermissions = [],
}) {
  return {
    schema: "jcc-wiki-curation-host-request-v1",
    run_id: runId || null,
    generated_by: "jcc-runtime-daemon",
    trigger,
    target_wiki_namespaces: [
      {
        namespace: "personal_strategy",
        categories: WIKI_CATEGORIES,
      },
    ],
    policy: {
      raw_evidence_is_immutable: true,
      host_model_must_return_json_only: true,
      output_schema: "jcc-wiki-curation-host-response-v1",
      allowed_page_statuses: ["draft"],
      publish_requires_runtime_or_user_approval: true,
      do_not_import_stale_patch_strength_into_active_personal_strategy: true,
      do_not_copy_old_match_board_shop_or_economy_as_current_match_fact: true,
      source_event_ids_required: true,
      category_scope_rules: {
        patch_meta_strategy: "season_id and patch_id must exactly match season_context",
        season_mechanic_strategy: "season_id must match season_context and patch_id must be null",
        universal_gameplay_strategy: "season_id and patch_id must both be null",
      },
    },
    season_context: {
      season_id: seasonId,
      patch_id: patchId,
      current_patch_strategy_pages_should_supersede_old_patch_pages: true,
    },
    desired_output: {
      pages: [
        {
          page_id: "stable-id-or-null",
          revision: "required current revision when page_id already exists",
          namespace: "personal_strategy",
          category: "patch_meta_strategy | season_mechanic_strategy | universal_gameplay_strategy",
          season_id: "category-dependent; see policy.category_scope_rules",
          patch_id: "category-dependent; see policy.category_scope_rules",
          title: "short title",
          summary: "1-2 sentence summary",
          body_md: "concise markdown strategy note",
          tags: ["array"],
          source_event_ids: [1],
          confidence: "low | medium | high",
          status: "draft",
          stale_reason: null,
        },
      ],
      stale_page_updates: [
        {
          page_id: "existing page id",
          revision: "required revision from stale_page_permissions",
          stale_reason: "superseded_by_new_patch | contradicted_by_recent_reviews | user_rejected",
        },
      ],
      user_questions: ["only if evidence is insufficient"],
    },
    source_events: sourceEvents,
    page_update_permissions: pageUpdatePermissions,
    stale_page_permissions: stalePagePermissions,
    evidence_packet: {
      recent_match_summaries: recentMatches,
      user_memory: userMemory,
      daily_big_data: rankSignal,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const activeProfile = await readJsonIfExists(path.join(repoRoot, "data/game-knowledge/jcc/active-profile.json"), {});
  const rankManifest = await readJsonIfExists(paths.liveRankingsManifestFile, {});
  const rankSignalRaw = await readJsonIfExists(paths.liveRankingsRankSignalFile, {});
  const seasonId = options.seasonId || activeProfile?.season_id || "unknown";
  const patchId = options.patchId || activeProfile?.patch_id
    || rankManifest?.patch_id || rankManifest?.version || rankSignalRaw?.patch_id || rankSignalRaw?.stat_date || "current";
  const store = createRuntimeSqliteStore(repoRoot).open();
  try {
    const limit = Number.isFinite(options.limit) ? options.limit : 20;
    const { recentMatches, userMemory } = readCanonicalCurationEvidence(store, limit);
    const { page_update_permissions: pageUpdatePermissions, stale_page_permissions: stalePagePermissions } = buildRunPagePermissions(store, {
      seasonId,
      patchId,
    });
    const sourceEvents = [
      store.addWikiSourceEvent({
        sourceType: "recent_match_summaries",
        namespace: "personal_strategy",
        seasonId,
        patchId,
        payload: { summaries: recentMatches },
      }),
      store.addWikiSourceEvent({
        sourceType: "user_strategy_memory",
        namespace: "personal_strategy",
        seasonId,
        patchId,
        payload: userMemory,
      }),
      store.addWikiSourceEvent({
        sourceType: "daily_big_data_rank_signal",
        namespace: "personal_strategy",
        seasonId,
        patchId,
        payload: compactRankSignal(rankSignalRaw),
      }),
    ];
    const curationRun = store.recordWikiCurationRun({
      triggerType: options.trigger,
      status: "pending_host_model",
      input: {
        season_id: seasonId,
        patch_id: patchId,
        source_event_ids: sourceEvents.map((event) => event.id),
        target_scope: {
          namespace: "personal_strategy",
          season_id: seasonId,
          patch_id: patchId,
          categories: WIKI_CATEGORIES,
        },
        page_update_permissions: pageUpdatePermissions,
        stale_page_permissions: stalePagePermissions,
      },
      output: {},
    });
    const request = buildWikiCurationPrompt({
      runId: curationRun.run_id,
      seasonId,
      patchId,
      trigger: options.trigger,
      sourceEvents,
      recentMatches,
      userMemory,
      rankSignal: compactRankSignal(rankSignalRaw),
      pageUpdatePermissions,
      stalePagePermissions,
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: "jcc-wiki-curation-request-build-result-v1",
      season_id: seasonId,
      patch_id: patchId,
      run_id: curationRun.run_id,
      source_event_ids: sourceEvents.map((event) => event.id),
      host_request: request,
    }, null, 2)}\n`);
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

export {
  buildWikiCurationPrompt,
  buildRunPagePermissions,
  readCanonicalCurationEvidence,
  WIKI_CATEGORIES,
};
