import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRuntimeSqliteStore } from "../ui/electron/runtime-state-store.js";
import { WIKI_CATEGORIES } from "./build-jcc-wiki-curation-request.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const VALID_CATEGORIES = new Set(WIKI_CATEGORIES);
const VALID_NAMESPACES = new Set(["personal_strategy"]);
const NONTERMINAL_RUN_STATUSES = new Set(["pending_host_model"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "expired", "superseded"]);
const WIKI_RUN_TTL_MS = 24 * 60 * 60 * 1000;

function usage() {
  return [
    "Usage:",
    "  node tools/apply-jcc-wiki-curation-response.mjs --response <json-file>",
    "",
    "Validates a host-model wiki curation response and writes draft/stale wiki updates to app.sqlite.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--response") options.response = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function assertHostResponse(envelope) {
  if (envelope?.schema !== "jcc-wiki-curation-host-response-v1") {
    throw new Error("wiki curation response must use schema jcc-wiki-curation-host-response-v1");
  }
  if (envelope.generated_by !== "current_cli_agent_main_model") {
    throw new Error("wiki curation response must declare generated_by=current_cli_agent_main_model");
  }
  if (!String(envelope.run_id || "").trim()) {
    throw new Error("wiki curation response must include an existing canonical run_id");
  }
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeSourceIds(value, label) {
  const ids = asArray(value).map((id) => Number(id));
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error(`${label} must include valid source_event_ids`);
  }
  return [...new Set(ids)];
}

function normalizePage(page) {
  const namespace = String(page?.namespace || "personal_strategy");
  const category = String(page?.category || "");
  if (!VALID_NAMESPACES.has(namespace)) throw new Error(`Unsupported wiki namespace: ${namespace}`);
  if (!VALID_CATEGORIES.has(category)) throw new Error(`Unsupported wiki category: ${category}`);
  if (page.scope !== undefined && !["cross_season", "current_season", "unclassified"].includes(page.scope)) throw new Error("Invalid Wiki scope");
  if (page.scope === "cross_season" && (page.season_id || page.patch_id || category !== "universal_gameplay_strategy")) throw new Error("Cross-season Wiki must be version-independent");
  if (page.scope === "current_season" && !page.season_id) throw new Error("Current-season Wiki requires season_id");
  const sourceIds = normalizeSourceIds(
    page.source_event_ids,
    `Wiki page "${page?.title || "untitled"}"`,
  );
  return {
    page_id: page.page_id || null,
    revision: page.revision || null,
    namespace,
    category,
    ...(page.scope !== undefined ? { scope: page.scope } : {}),
    season_id: page.season_id || null,
    patch_id: page.patch_id || null,
    title: String(page.title || "").trim() || "Untitled JCC Wiki Page",
    status: "draft",
    summary: String(page.summary || "").trim(),
    body_md: String(page.body_md || "").trim(),
    tags: asArray(page.tags).map(String).filter(Boolean).slice(0, 20),
    source_event_ids: sourceIds,
    confidence: ["low", "medium", "high"].includes(page.confidence) ? page.confidence : "medium",
    valid_from_patch: page.valid_from_patch || page.patch_id || null,
    valid_until_patch: page.valid_until_patch || null,
    stale_reason: page.stale_reason || null,
  };
}

function nullableString(value) {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function normalizeScope(scope = {}) {
  return {
    namespace: String(scope.namespace || ""),
    category: String(scope.category || ""),
    season_id: nullableString(scope.season_id),
    patch_id: nullableString(scope.patch_id),
  };
}

function pageScope(page) {
  return normalizeScope(page);
}

function scopesEqual(left, right) {
  const a = normalizeScope(left);
  const b = normalizeScope(right);
  return a.namespace === b.namespace
    && a.category === b.category
    && a.season_id === b.season_id
    && a.patch_id === b.patch_id;
}

function assertPageMatchesRunScope(page, targetScope, label) {
  const scope = pageScope(page);
  if (scope.namespace !== targetScope.namespace || !targetScope.categories.includes(scope.category)) {
    throw new Error(`${label} is outside the run namespace/category permission`);
  }
  const legal = scope.category === "patch_meta_strategy"
    ? scope.season_id === targetScope.season_id && scope.patch_id === targetScope.patch_id
    : scope.category === "season_mechanic_strategy"
      ? scope.season_id === targetScope.season_id && scope.patch_id === null
      : scope.category === "universal_gameplay_strategy"
        && scope.season_id === null
        && scope.patch_id === null;
  if (!legal) throw new Error(`${label} is outside the run scope for category ${scope.category}`);
}

function normalizePermissionMap(value, label) {
  const permissions = new Map();
  for (const entry of asArray(value)) {
    const pageId = String(entry?.page_id || "").trim();
    const revision = String(entry?.revision || "").trim();
    if (!pageId || !revision || !entry?.scope) throw new Error(`${label} contains an invalid page permission`);
    permissions.set(pageId, { page_id: pageId, revision, scope: normalizeScope(entry.scope) });
  }
  return permissions;
}

function assertCasPermission({ pageId, revision, current, permissions, label }) {
  const permission = permissions.get(pageId);
  if (!permission) throw new Error(`${label} is not authorized by this wiki curation run: ${pageId}`);
  if (!revision || revision !== permission.revision) {
    throw new Error(`${label} has a stale or missing revision for page_id ${pageId}`);
  }
  if (!current || current.updated_at !== permission.revision || !scopesEqual(current, permission.scope)) {
    throw new Error(`${label} CAS conflict for page_id ${pageId}`);
  }
  return permission;
}

function nextRevision(expectedRevision) {
  const now = new Date().toISOString();
  if (now !== expectedRevision) return now;
  const expectedMs = Date.parse(expectedRevision);
  return Number.isFinite(expectedMs) ? new Date(expectedMs + 1).toISOString() : now;
}

function updateExistingPageCas(store, page, expectedRevision) {
  const timestamp = nextRevision(expectedRevision);
  const result = store.db.prepare(`
    UPDATE wiki_pages
    SET namespace = ?, category = ?, season_id = ?, patch_id = ?, title = ?, status = 'draft',
        summary = ?, body_md = ?, tags_json = ?, source_event_ids_json = ?, confidence = ?,
        valid_from_patch = ?, valid_until_patch = ?, stale_reason = ?, updated_at = ?
    WHERE page_id = ? AND updated_at = ?
  `).run(
    page.namespace,
    page.category,
    page.season_id,
    page.patch_id,
    page.title,
    page.summary,
    page.body_md,
    JSON.stringify(page.tags),
    JSON.stringify(page.source_event_ids),
    page.confidence,
    page.valid_from_patch,
    page.valid_until_patch,
    page.stale_reason,
    timestamp,
    page.page_id,
    expectedRevision,
  );
  if (result.changes !== 1) throw new Error(`Wiki page CAS conflict for page_id ${page.page_id}`);
  return store.getWikiPage(page.page_id);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.response) throw new Error("--response is required");
  const response = await readJson(options.response);
  assertHostResponse(response);
  const store = createRuntimeSqliteStore(repoRoot).open();
  try {
    const normalizedPages = asArray(response.pages).map(normalizePage);
    const runId = String(response.run_id).trim();
    let writtenPages;
    let staleUpdates;
    let run;
    let transactionCommitted = false;
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const runRow = store.db.prepare(`
        SELECT run_id, trigger_type, status, input_json, output_json, created_at, completed_at
        FROM wiki_curation_runs
        WHERE run_id = ?
      `).get(runId);
      if (!runRow) throw new Error(`Unknown wiki curation run_id: ${runId}`);
      if (TERMINAL_RUN_STATUSES.has(runRow.status)) {
        throw new Error(`Wiki curation run_id ${runId} is already terminal: ${runRow.status}`);
      }
      if (!NONTERMINAL_RUN_STATUSES.has(runRow.status)) {
        throw new Error(`Wiki curation run_id ${runId} has an unsupported status: ${runRow.status}`);
      }
      const expiresAt = Date.parse(runRow.created_at) + WIKI_RUN_TTL_MS;
      if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
        const completedAt = new Date().toISOString();
        const expiration = store.db.prepare(`
          UPDATE wiki_curation_runs
          SET status = 'expired', output_json = ?, completed_at = ?
          WHERE run_id = ? AND status = 'pending_host_model'
        `).run(JSON.stringify({ code: "STALE_WIKI_CURATION_RUN_EXPIRED", stale_ms: WIKI_RUN_TTL_MS }), completedAt, runId);
        if (expiration.changes !== 1) {
          throw new Error(`Wiki curation run_id ${runId} could not be expired from its current status`);
        }
        store.db.exec("COMMIT");
        transactionCommitted = true;
        throw new Error(`Wiki curation run_id ${runId} expired after 24 hours`);
      }
      const runInput = parseJson(runRow.input_json, {});
      const targetScope = {
        namespace: String(runInput.target_scope?.namespace || ""),
        season_id: nullableString(runInput.target_scope?.season_id),
        patch_id: nullableString(runInput.target_scope?.patch_id),
        categories: asArray(runInput.target_scope?.categories).map(String),
      };
      if (targetScope.namespace !== "personal_strategy"
        || !targetScope.season_id
        || !targetScope.patch_id
        || targetScope.categories.length !== WIKI_CATEGORIES.length
        || WIKI_CATEGORIES.some((category) => !targetScope.categories.includes(category))) {
        throw new Error(`Wiki curation run_id ${runId} has invalid fixed target_scope permissions`);
      }
      const pageUpdatePermissions = normalizePermissionMap(runInput.page_update_permissions, "page_update_permissions");
      const stalePagePermissions = normalizePermissionMap(runInput.stale_page_permissions, "stale_page_permissions");
      const allowedSourceIds = new Set(normalizeSourceIds(
        runInput.source_event_ids,
        `Wiki curation run_id ${runId}`,
      ));
      const requestedSourceIds = [...new Set(normalizedPages.flatMap((page) => page.source_event_ids))];
      const foreignSourceIds = requestedSourceIds.filter((id) => !allowedSourceIds.has(id));
      if (foreignSourceIds.length) {
        throw new Error(`Wiki curation response references source_event_ids outside run_id ${runId}: ${foreignSourceIds.join(", ")}`);
      }
      if (requestedSourceIds.length) {
        const existingSourceIds = new Set(store.db.prepare(`
          SELECT id
          FROM wiki_source_events
          WHERE id IN (${requestedSourceIds.map(() => "?").join(", ")})
        `).all(...requestedSourceIds).map((row) => Number(row.id)));
        const missingSourceIds = requestedSourceIds.filter((id) => !existingSourceIds.has(id));
        if (missingSourceIds.length) {
          throw new Error(`Wiki curation response references nonexistent source_event_ids: ${missingSourceIds.join(", ")}`);
        }
      }

      writtenPages = normalizedPages.map((page) => {
        assertPageMatchesRunScope(page, targetScope, `Wiki page "${page.title}"`);
        if (!page.page_id) return store.upsertWikiPage(page);
        const current = store.getWikiPage(page.page_id);
        if (!current) return store.upsertWikiPage(page);
        const permission = assertCasPermission({
          pageId: page.page_id,
          revision: page.revision,
          current,
          permissions: pageUpdatePermissions,
          label: "Wiki page update",
        });
        if (!scopesEqual(page, permission.scope)) {
          throw new Error(`Wiki page update cannot change scope for page_id ${page.page_id}`);
        }
        return updateExistingPageCas(store, page, permission.revision);
      });
      staleUpdates = [];
      for (const stale of asArray(response.stale_page_updates)) {
        if (!stale?.page_id) continue;
        const pageId = String(stale.page_id);
        const existing = store.getWikiPage(pageId);
        const permission = assertCasPermission({
          pageId,
          revision: String(stale.revision || ""),
          current: existing,
          permissions: stalePagePermissions,
          label: "Wiki stale update",
        });
        if (permission.scope.category !== "patch_meta_strategy") {
          throw new Error(`Patch curation run cannot stale ${permission.scope.category} page_id ${pageId}`);
        }
        if (permission.scope.namespace !== targetScope.namespace
          || permission.scope.season_id !== targetScope.season_id
          || !permission.scope.patch_id
          || permission.scope.patch_id === targetScope.patch_id) {
          throw new Error(`Wiki stale update is outside the run's old-patch scope for page_id ${pageId}`);
        }
        const timestamp = nextRevision(permission.revision);
        const staleResult = store.db.prepare(`
          UPDATE wiki_pages
          SET status = 'stale', stale_reason = ?, valid_until_patch = COALESCE(valid_until_patch, ?), updated_at = ?
          WHERE page_id = ? AND updated_at = ? AND namespace = ? AND category = ?
            AND season_id IS ? AND patch_id IS ? AND status = 'published'
        `).run(
          stale.stale_reason || "superseded_by_curation",
          targetScope.patch_id,
          timestamp,
          pageId,
          permission.revision,
          permission.scope.namespace,
          permission.scope.category,
          permission.scope.season_id,
          permission.scope.patch_id,
        );
        if (staleResult.changes !== 1) throw new Error(`Wiki stale update CAS conflict for page_id ${pageId}`);
        staleUpdates.push(store.getWikiPage(pageId));
      }
      const output = {
        page_ids: writtenPages.map((page) => page.page_id),
        stale_page_ids: staleUpdates.map((page) => page.page_id),
        user_questions: asArray(response.user_questions),
      };
      const completedAt = new Date().toISOString();
      const completion = store.db.prepare(`
        UPDATE wiki_curation_runs
        SET status = 'completed', output_json = ?, completed_at = ?
        WHERE run_id = ?
          AND status = 'pending_host_model'
      `).run(JSON.stringify(output), completedAt, runId);
      if (completion.changes !== 1) {
        throw new Error(`Wiki curation run_id ${runId} could not be completed from its current status`);
      }
      run = {
        run_id: runRow.run_id,
        trigger_type: runRow.trigger_type,
        status: "completed",
        input: runInput,
        output,
        created_at: runRow.created_at,
        completed_at: completedAt,
      };
      store.db.exec("COMMIT");
      transactionCommitted = true;
    } catch (error) {
      if (!transactionCommitted) store.db.exec("ROLLBACK");
      throw error;
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: "jcc-wiki-curation-apply-result-v1",
      run,
      written_pages: writtenPages,
      stale_updates: staleUpdates,
      user_questions: asArray(response.user_questions),
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

export { normalizePage };
