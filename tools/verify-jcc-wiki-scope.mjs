import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeSqliteStore } from "../ui/electron/runtime-state-store.js";
import { normalizePage } from "./apply-jcc-wiki-curation-response.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "jcc-wiki-scope-"));
try {
  const store = createRuntimeSqliteStore(path.resolve(import.meta.dirname, ".."), { dataRoot: root });
  store.open();
  const universal = store.upsertWikiPage({
    page_id: "wiki:universal",
    namespace: "personal_strategy",
    category: "universal_gameplay_strategy",
    scope: "cross_season",
    title: "经济纪律",
    status: "published",
    source_event_ids: [1],
  });
  const seasonal = store.upsertWikiPage({
    page_id: "wiki:s18",
    namespace: "personal_strategy",
    category: "season_mechanic_strategy",
    season_id: "s18",
    scope: "current_season",
    title: "当前赛季机制",
    status: "published",
    source_event_ids: [2],
  });
  assert.equal(universal.scope, "cross_season");
  assert.equal(normalizePage(universal).scope, "cross_season");
  const snapshot = store.captureWikiSnapshot([universal, seasonal]);
  store.upsertWikiPage({ ...universal, body_md: "changed after Match start" });
  store.markWikiPagesStale({ seasonId: "s18", olderThanPatch: "future" });
  assert.deepEqual(store.readWikiSnapshot(snapshot.snapshot_id).find(page => page.page_id === universal.page_id), universal);
  assert.equal(store.upsertWikiPage({ ...universal, scope: undefined }).scope, "cross_season", "omitted scope preserves prior explicit classification");
  assert.equal(seasonal.scope, "current_season");
  assert.equal(store.getWikiPage("wiki:s18").scope, "current_season");
  assert.deepEqual(store.listWikiPages({ status: "published" }).map((page) => page.scope).sort(), ["cross_season", "current_season"]);
  store.close();
  const recovered = createRuntimeSqliteStore(path.resolve(import.meta.dirname, ".."), { dataRoot: root });
  try { assert.deepEqual(recovered.readWikiSnapshot(snapshot.snapshot_id).find(page => page.page_id === universal.page_id), universal); }
  finally { recovered.close(); }
  console.log(JSON.stringify({ ok: true, schema: "jcc-wiki-scope-verification-v1" }));
} finally {
  await rm(root, { recursive: true, force: true });
}
