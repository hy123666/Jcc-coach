import { readFile, writeFile } from "node:fs/promises";

function usage() {
  return [
    "Usage:",
    "  node tools/summarize-jcc-live-action-monitor-probe.mjs --signals <signals.json> --live-state <match-live-state.json> [--delta <current-match-action-delta.json>] --out-summary <summary.json> --out-event <event.json> [metadata]",
    "",
    "Metadata:",
    "  --iteration <n> --probe-dir <path> --remote-file <path> --remote-size <n> --remote-mtime <n>",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--signals") options.signals = argv[++index];
    else if (arg === "--live-state") options.liveState = argv[++index];
    else if (arg === "--delta") options.delta = argv[++index];
    else if (arg === "--out-summary") options.outSummary = argv[++index];
    else if (arg === "--out-event") options.outEvent = argv[++index];
    else if (arg === "--iteration") options.iteration = Number(argv[++index]);
    else if (arg === "--probe-dir") options.probeDir = argv[++index];
    else if (arg === "--remote-file") options.remoteFile = argv[++index];
    else if (arg === "--remote-size") options.remoteSize = Number(argv[++index]);
    else if (arg === "--remote-mtime") options.remoteMtime = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function slimAction(action) {
  return {
    action: action.action,
    chair: action.action_chair_id_candidate ?? null,
    resolved_chair: action.resolved_action_chair_id ?? null,
    local_scope: action.local_scope ?? null,
    entity: action.entity_id ?? null,
    raw: action.raw_hero_id ?? null,
    champion_id: action.hero?.champion_id ?? null,
    name: action.hero?.name ?? null,
    from: action.from ?? null,
    to: action.to ?? null,
    position: action.position ?? null,
    evidence: action.evidence ?? null,
  };
}

function summarizeDelta(delta) {
  if (!delta) return null;
  const addedActions = Array.isArray(delta.added_actions) ? delta.added_actions.map(slimAction) : [];
  const primaryLocalActions = Array.isArray(delta.primary_local_added_actions)
    ? delta.primary_local_added_actions.map(slimAction)
    : addedActions.filter((action) => action.local_scope === "primary_local");
  const secondaryGlobalActions = Array.isArray(delta.secondary_global_added_actions)
    ? delta.secondary_global_added_actions.map(slimAction)
    : addedActions.filter((action) => action.local_scope !== "primary_local");
  return {
    ok: delta.ok,
    current_match_only: delta.current_match_only,
    match: delta.match,
    local_binding: delta.local_binding ?? null,
    action_scope_decision: delta.action_scope_decision ?? null,
    before_action_count: delta.before_action_count,
    after_action_count: delta.after_action_count,
    added_total: delta.added_total,
    action_delta: delta.action_delta,
    sell_delta: delta.sell_delta,
    get_on_delta: delta.get_on_delta,
    move_delta: delta.move_delta,
    primary_local_added_total: delta.primary_local_added_total ?? primaryLocalActions.length,
    primary_local_action_delta: delta.primary_local_action_delta ?? primaryLocalActions.length,
    primary_local_sell_delta: delta.primary_local_sell_delta ?? primaryLocalActions.filter((action) => action.action === "sell_chess").length,
    primary_local_get_on_delta: delta.primary_local_get_on_delta ?? primaryLocalActions.filter((action) => action.action === "get_on_chess").length,
    primary_local_move_delta: delta.primary_local_move_delta ?? primaryLocalActions.filter((action) => action.action === "move_battle_chess").length,
    secondary_global_added_total: delta.secondary_global_added_total ?? secondaryGlobalActions.length,
    champion_id: delta.champion_id ?? null,
    champion_sell_delta: delta.champion_sell_delta ?? null,
    primary_local_champion_sell_delta: delta.primary_local_champion_sell_delta ?? null,
    champion_sells: Array.isArray(delta.champion_sells) ? delta.champion_sells.map(slimAction) : [],
    primary_local_champion_sells: Array.isArray(delta.primary_local_champion_sells) ? delta.primary_local_champion_sells.map(slimAction) : [],
    added_sells: addedActions.filter((action) => action.action === "sell_chess"),
    added_get_on: addedActions.filter((action) => action.action === "get_on_chess"),
    added_moves: addedActions.filter((action) => action.action === "move_battle_chess"),
    primary_local_added_sells: primaryLocalActions.filter((action) => action.action === "sell_chess"),
    primary_local_added_get_on: primaryLocalActions.filter((action) => action.action === "get_on_chess"),
    primary_local_added_moves: primaryLocalActions.filter((action) => action.action === "move_battle_chess"),
    secondary_global_added_sells: secondaryGlobalActions.filter((action) => action.action === "sell_chess"),
    secondary_global_added_get_on: secondaryGlobalActions.filter((action) => action.action === "get_on_chess"),
    secondary_global_added_moves: secondaryGlobalActions.filter((action) => action.action === "move_battle_chess"),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  for (const key of ["signals", "liveState", "outSummary", "outEvent"]) {
    if (!options[key]) throw new Error(`Missing --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}\n${usage()}`);
  }

  const signals = await readJson(options.signals);
  const liveState = await readJson(options.liveState);
  const delta = options.delta ? await readJson(options.delta) : null;
  const deltaSummary = summarizeDelta(delta);
  const capturedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const summary = {
    iteration: options.iteration ?? null,
    captured_at: capturedAt,
    probe_dir: options.probeDir ?? null,
    remote_file: options.remoteFile ?? null,
    remote_size: Number.isFinite(options.remoteSize) ? options.remoteSize : null,
    remote_mtime: Number.isFinite(options.remoteMtime) ? options.remoteMtime : null,
    signal_count: signals.signal_count,
    signal_counts: signals.signal_counts,
    match: liveState.match,
    gate: liveState.live_state?.gate ?? null,
    current_match_action_delta: deltaSummary,
  };

  const event = {
    event: "probe_completed",
    iteration: summary.iteration,
    captured_at: summary.captured_at,
    probe_dir: summary.probe_dir,
    remote_file: summary.remote_file,
    remote_size: summary.remote_size,
    signal_count: summary.signal_count,
    match: summary.match,
    gate: summary.gate,
    current_match_action_delta_summary: deltaSummary
      ? {
          action_delta: deltaSummary.action_delta,
          sell_delta: deltaSummary.sell_delta,
          get_on_delta: deltaSummary.get_on_delta,
          move_delta: deltaSummary.move_delta,
          local_binding: deltaSummary.local_binding,
          action_scope_decision: deltaSummary.action_scope_decision,
          primary_local_action_delta: deltaSummary.primary_local_action_delta,
          primary_local_sell_delta: deltaSummary.primary_local_sell_delta,
          primary_local_get_on_delta: deltaSummary.primary_local_get_on_delta,
          primary_local_move_delta: deltaSummary.primary_local_move_delta,
          secondary_global_added_total: deltaSummary.secondary_global_added_total,
          champion_id: deltaSummary.champion_id,
          champion_sell_delta: deltaSummary.champion_sell_delta,
          primary_local_champion_sell_delta: deltaSummary.primary_local_champion_sell_delta,
          before_same_match: deltaSummary.match?.before_same_match,
          primary_local_added_sells: deltaSummary.primary_local_added_sells,
          secondary_global_added_sells: deltaSummary.secondary_global_added_sells,
        }
      : null,
  };

  await writeFile(options.outSummary, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(options.outEvent, `${JSON.stringify(event)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, out_summary: options.outSummary, out_event: options.outEvent }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
