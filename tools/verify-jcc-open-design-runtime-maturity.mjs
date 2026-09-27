import { readFile } from "node:fs/promises";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function text(file) {
  return readFile(file, "utf8");
}

function has(source, needle, label) {
  assert(source.includes(needle), `${label} missing ${needle}`);
}

function lacks(source, needle, label) {
  assert(!source.includes(needle), `${label} must not include ${needle}`);
}

async function main() {
  const store = await text("ui/electron/runtime-state-store.js");
  const daemon = await text("ui/electron/runtime-daemon.js");
  const server = await text("ui/electron/runtime-daemon-server.js");
  const client = await text("ui/electron/runtime-daemon-client.js");
  const main = await text("ui/electron/main.js");
  const service = await text("ui/electron/runtime-service.js");
  const agents = await text("AGENTS.md");
  const skill = await text(".codex/skills/jcc-runtime-agent/SKILL.md");

  for (const [source, label] of [[agents, "AGENTS"], [skill, "jcc-runtime-agent skill"]]) {
    has(source, "HTTP/SSE/WebSocket", label);
    has(source, "jcc-runtime-state-store-v5", label);
    has(source, "writeLegacyJsonMirror", label);
    has(source, "app.sqlite", label);
    has(source, ".jcc-runtime-data", label);
  }

  has(store, "jcc-runtime-state-store-v5", "state store");
  has(store, ".jcc-runtime-data", "state store");
  has(store, "legacyUiStateFile", "state store");
  has(store, "runtime_migrations", "state store");
  has(store, "runtime_queue", "state store");
  has(store, "runtime_logs", "state store");
  has(store, "writeLegacyJsonMirror", "state store");
  has(store, "listQueue", "state store");
  has(store, "updateQueueItem", "state store");
  has(store, "claimQueueItem", "state store");
  has(store, "completeQueueItem", "state store");
  has(store, "failQueueItem", "state store");
  has(store, "recoverStaleQueueItems", "state store");
  has(store, "listLogs", "state store");
  has(store, "listMigrations", "state store");

  has(server, "/ws", "daemon server");
  has(server, "encodeWebSocketFrame", "daemon server");
  has(server, "/queue", "daemon server");
  has(server, "/queue/update", "daemon server");
  has(server, "/queue/claim", "daemon server");
  has(server, "/queue/complete", "daemon server");
  has(server, "/queue/fail", "daemon server");
  has(server, "/queue/recover-stale", "daemon server");
  has(server, "/logs", "daemon server");
  has(server, "websocket_url", "daemon server");
  has(server, "x-jcc-runtime-token", "daemon server");
  has(server, "runtime_daemon_health", "daemon server");

  has(client, "event_transport: \"websocket_with_sse_fallback\"", "daemon client");
  has(client, "readWebSocketEvents", "daemon client");
  has(client, "startSupervisor", "daemon client");
  has(client, "stopSupervisor", "daemon client");
  has(client, "ownsProcess", "daemon client");
  has(client, "updateQueueItem", "daemon client");
  has(client, "claimQueueItem", "daemon client");
  has(client, "completeQueueItem", "daemon client");
  has(client, "failQueueItem", "daemon client");
  has(client, "recoverStaleQueueItems", "daemon client");

  has(main, "startSupervisor", "Electron main");
  has(main, "daemon_reconnected", "Electron main");
  has(main, "jcc-runtime:event", "Electron main");

  has(daemon, "this.store.enqueue(\"host_request\"", "daemon core");
  has(daemon, "this.store.enqueue(\"host_response\"", "daemon core");
  lacks(daemon, "this.store.enqueue(\"advice_task_lifecycle\"", "daemon core");
  has(daemon, "compactAdviceTaskLifecycle", "daemon core");
  has(daemon, "maintainStorage(\"stop_match\", \"TRUNCATE\")", "daemon core");
  has(daemon, "this.store.enqueue(\"visual_request\"", "daemon core");
  has(daemon, "strategy_memory_task", "daemon core");
  lacks(daemon, "opponent_aggregation_task", "daemon core");
  has(daemon, "rankings_update_task", "daemon core");
  has(daemon, "independent_os_daemon_sqlite_backed", "daemon core");
  has(daemon, "event_transport: [\"websocket\", \"sse\"]", "daemon core");

  has(service, "writeLegacyJsonMirror", "runtime service");
  lacks(service, "path.join(repoRoot, \".omx\"", "runtime service");
  lacks(service, "output-last-message", "runtime service");
  lacks(service, "findNewCodexSessionId", "runtime service");
  has(service, "warmHostSession", "runtime service");
  has(service, "prepareHostSessionInvocation", "runtime service");
  has(service, "JCC_RUNTIME_CURRENT_TURN_DELTA", "runtime service");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-open-design-runtime-maturity-verification-v1",
    checked: [
      "independent-daemon-contract",
      "http-sse-websocket-transport",
      "sqlite-v5-migrations",
      "queue-inspect",
      "queue-lifecycle",
      "structured-logs",
      "legacy-json-mirror-gate",
      "daemon-supervisor",
      "provider-native-long-session-with-sqlite-truth",
      "one-time-static-bootstrap-and-current-turn-delta",
      "opponent-aggregation-task-not-a-product-requirement",
    ],
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
