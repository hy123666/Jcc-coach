import { readFile, writeFile } from "node:fs/promises";

function usage() {
  return [
    "Usage:",
    "  node tools/analyze-jcc-mumu-view-scope.mjs --events <jsonl> [--out <json>]",
    "",
    "Analyzes whether MuMu 4352/4353 live payloads look like local board, current view, or combat/all-visible candidates.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--events") options.events = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJsonl(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function heroKey(entry) {
  return `${entry?.i}:${entry?.x}:${entry?.y}`;
}

function summarizeCommand(events, command, key) {
  const selected = events.filter((event) => Number(event.command) === command);
  const counts = selected.map((event) => (Array.isArray(event.payload?.[key]) ? event.payload[key].length : 0));
  const yCounts = new Map();
  const samples = [];
  for (const event of selected) {
    const list = Array.isArray(event.payload?.[key]) ? event.payload[key] : [];
    for (const unit of list) {
      yCounts.set(unit.y, (yCounts.get(unit.y) || 0) + 1);
    }
    if (samples.length < 5) samples.push({ at: event.observed_at, count: list.length, payload: event.payload });
  }
  return {
    event_count: selected.length,
    min_count: counts.length ? Math.min(...counts) : null,
    max_count: counts.length ? Math.max(...counts) : null,
    last_count: counts.length ? counts.at(-1) : null,
    y_distribution: [...yCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([y, count]) => ({ y: Number(y), count })),
    samples,
  };
}

function overlapStats(events) {
  let latestBench = [];
  const rows = [];
  for (const event of events) {
    if (Number(event.command) === 4352) latestBench = Array.isArray(event.payload?.wl) ? event.payload.wl : [];
    if (Number(event.command) !== 4353) continue;
    const board = Array.isArray(event.payload?.hl) ? event.payload.hl : [];
    const benchKeys = new Set(latestBench.map(heroKey));
    const overlap = board.filter((unit) => benchKeys.has(heroKey(unit)));
    rows.push({
      at: event.observed_at,
      board_count: board.length,
      latest_bench_count: latestBench.length,
      overlap_count: overlap.length,
      filtered_board_count: board.length - overlap.length,
      has_large_combat_like_count: board.length - overlap.length > 12,
    });
  }
  return rows;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  assert(options.events, "Missing --events");
  const events = parseJsonl(await readFile(options.events, "utf8"))
    .filter((event) => event.type === "mumu_gi_message" || event.source === "adb_logcat_nemuinit_gi_plugin_jkchess");
  const overlap = overlapStats(events);
  const combatLikeRows = overlap.filter((row) => row.has_large_combat_like_count);
  const maxFiltered = overlap.length ? Math.max(...overlap.map((row) => row.filtered_board_count)) : null;
  const result = {
    schema: "jcc-mumu-view-scope-analysis-v1",
    generated_at: new Date().toISOString(),
    source_events: options.events,
    command_summaries: {
      bench_4352: summarizeCommand(events, 4352, "wl"),
      board_4353: summarizeCommand(events, 4353, "hl"),
      shop_4354: summarizeCommand(events, 4354, "bl"),
    },
    board_bench_overlap: {
      sample_count: overlap.length,
      max_filtered_board_count: maxFiltered,
      combat_like_row_count: combatLikeRows.length,
      latest: overlap.at(-1) || null,
      samples: overlap.slice(-20),
    },
    conclusion: {
      scope_status:
        combatLikeRows.length > 0
          ? "not_verified_local_only_combat_or_current_view_likely"
          : "local_only_not_disproven_but_still_unverified",
      reasons: [
        "4353 carries only hero id and screen/scene coordinates, no chair/owner/playerId.",
        "4353 frequently overlaps with 4352 bench entries; bench entries must be filtered out.",
        maxFiltered != null && maxFiltered > 12
          ? "Filtered 4353 count exceeded a normal local board cap, which is strong evidence for combat/current-view or all-visible scope in at least some phases."
          : "Filtered 4353 count did not exceed local board cap in this event file, but field semantics remain unbound.",
      ],
      promotion_policy: "Do not promote 4353 to verified local board until view-switch or local-binding evidence is captured.",
    },
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) await writeFile(options.out, text, "utf8");
  else process.stdout.write(text);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
