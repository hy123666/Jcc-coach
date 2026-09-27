import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeSqliteStore } from "../ui/electron/runtime-state-store.js";
import { configureRuntimeServicePaths, captureMatchSeasonVersionSnapshot, captureMatchWikiSnapshot,
  setRuntimeServiceState, buildRuntimeHostContext, createReadonlyBrokerForHostTurn } from "../ui/electron/runtime-service.js";
import { restoreHostEvidence } from "../ui/electron/host-evidence-materialization.js";

const root = await mkdtemp(path.join(os.tmpdir(), "jcc-wiki-match-"));
const repo = path.resolve(import.meta.dirname, "..");
const store = createRuntimeSqliteStore(repo, { dataRoot: root });
try {
  configureRuntimeServicePaths({ dataRoot: root });
  const base = { active_mode: "cruise", host_cli: { provider: "codex" }, response_task: { status: "idle" }, match_context: {} };
  setRuntimeServiceState({ ...base, match_session: { status: "idle" } });
  store.upsertWikiPage({ page_id: "wiki:fixed", namespace: "personal_strategy", category: "universal_gameplay_strategy",
    scope: "cross_season", status: "published", title: "Fixed Wiki", body_md: "original-published-facts", tags: [] });
  const snapshot = { ...captureMatchSeasonVersionSnapshot(), wiki_snapshot: captureMatchWikiSnapshot() };
  const match = { status: "active", match_session_id: "wiki-match", season_version_snapshot: snapshot };
  setRuntimeServiceState({ ...base, match_session: match });
  async function read() {
    const request = { request_id: "wiki-query", request_hash: "wiki-query", mode: "cruise", request_kind: "host_question",
      user_message: "Wiki", provider_readonly_tool_mode: "native_dynamic_tools" };
    request.runtime_context = await buildRuntimeHostContext("cruise", null, request);
    const broker = createReadonlyBrokerForHostTurn(request, { capsule: { capsule_id: "wiki", fingerprint: "wiki" }, turn_prompt_bytes: 0 });
    return restoreHostEvidence(await broker.call("query_knowledge", { operation: "get_strategy_wiki", entity_names: ["wiki:fixed"] }));
  }
  assert.equal((await read()).result.entities[0].details.body_md, "original-published-facts");
  store.upsertWikiPage({ ...store.getWikiPage("wiki:fixed"), body_md: "new-published-facts" });
  assert.equal((await read()).result.entities[0].details.body_md, "original-published-facts");
  // Restoring the persisted Match identity must not re-pin to mutable Wiki pages.
  store.close();
  configureRuntimeServicePaths({ dataRoot: root });
  setRuntimeServiceState(JSON.parse(JSON.stringify({ ...base, match_session: match })));
  assert.equal((await read()).result.entities[0].details.body_md, "original-published-facts");
  setRuntimeServiceState({ ...base, match_session: { status: "idle" } });
  assert.equal((await read()).result.entities[0].details.body_md, "new-published-facts");
  console.log(JSON.stringify({ ok: true, checked: ["start_snapshot", "same_match_no_revision_drift", "recovery_fixed_revision", "lobby_fresh_revision"] }));
} finally {
  store.close();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
